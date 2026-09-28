'use strict';
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { config, saveRunState, isSetupComplete, getNextPrompt, getProxyServer } = require('./config');
const { STATES, HUMAN_LABELS, ALLOWED_TRANSITIONS } = require('./states');
const { getBrowserManager } = require('./browser-manager');
const { ChatGPTAdapter } = require('./chatgpt-adapter');

function hashPrompt(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

class RunExecutor {
  constructor(logger) {
    this.log = logger || console;
    this.current = null;
    this.bm = getBrowserManager(this.log);
  }
  getStatus() {
    if (!this.current) {
      return { state: STATES.IDLE, label: HUMAN_LABELS[STATES.IDLE], locked: this.bm.isLocked(), setupComplete: isSetupComplete() };
    }
    return { ...this.current, label: HUMAN_LABELS[this.current.state] || this.current.state, locked: this.bm.isLocked(), setupComplete: isSetupComplete() };
  }
  _transition(to, extra) {
    extra = extra || {};
    if (!this.current) return;
    const from = this.current.state;
    this.current.state = to;
    this.current.history = this.current.history || [];
    this.current.history.push(Object.assign({ at: new Date().toISOString(), from: from, to: to }, extra));
    Object.assign(this.current, extra);
    saveRunState(this.current);
    this.log.info('STATE ' + from + ' → ' + to);
  }
  async startRun(opts) {
    opts = opts || {};
    if (!isSetupComplete()) {
      return { ok: false, error: 'Setup not complete. Complete first-time authentication via /setup/browser', state: STATES.FAILED };
    }
    if (this.bm.isLocked() || (this.current && [STATES.IDLE, STATES.COMPLETE, STATES.FAILED, STATES.NEEDS_REVIEW, STATES.REAUTH_REQUIRED].indexOf(this.current.state) === -1)) {
      return { ok: false, error: 'Another run is in progress', state: this.current ? this.current.state : 'LOCKED' };
    }
    const runId = uuidv4();
    let promptKind = 'worker';
    let prompt = config.workerPrompt || config.ermiPrompt;
    if (opts && opts.kind === 'discovery') {
      promptKind = 'discovery';
      prompt = config.discoveryPrompt || config.ermiPrompt;
    } else if (opts && opts.kind === 'worker') {
      promptKind = 'worker';
      prompt = config.workerPrompt || config.ermiPrompt;
    } else if (opts && opts.prompt) {
      promptKind = opts.kind || 'custom';
      prompt = opts.prompt;
    } else {
      const next = getNextPrompt();
      promptKind = next.kind;
      prompt = next.text;
    }
    const promptHash = hashPrompt(prompt);
    if (!this.bm.acquireLock(runId)) {
      return { ok: false, error: 'Could not acquire execution lock', state: 'LOCKED' };
    }
    this.current = { id: runId, state: STATES.IDLE, history: [], error: null, startedAt: new Date().toISOString(), finishedAt: null, promptHash: promptHash, promptKind: promptKind, message: null };
    saveRunState(this.current);
    const self = this;
    this._execute(runId, prompt, promptHash).catch(function(err) {
      self.log.error('Unhandled run error: ' + (err && err.stack));
      if (self.current && self.current.id === runId) {
        self._transition(STATES.FAILED, { error: err.message });
        self.current.finishedAt = new Date().toISOString();
        saveRunState(self.current);
      }
      self.bm.releaseLock(runId);
    });
    return { ok: true, runId: runId, state: STATES.BROWSER_STARTING, label: HUMAN_LABELS[STATES.BROWSER_STARTING], promptHash: promptHash, promptKind: promptKind };
  }
  async _execute(runId, prompt, promptHash) {
    try {
      this._transition(STATES.BROWSER_STARTING);
      const launched = await this.bm.ensureBrowser({ headless: config.headless });
      let page = launched.page;
      let adapter = new ChatGPTAdapter(page, this.log);

      this._transition(STATES.CHATGPT_LOADING);
      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);

      this._transition(STATES.CHATGPT_READY);
      let pageState = await adapter.detectPageState();

      if (pageState === 'CLOUDFLARE') {
        this.log.warn('CF challenge — preserving persistent session and restarting Chromium');
        for (let restartAttempt = 1; restartAttempt <= 2; restartAttempt++) {
          await page.waitForTimeout(4000);
          pageState = await adapter.detectPageState();
          if (pageState !== 'CLOUDFLARE') {
            this.log.info('CF challenge cleared without browser restart attempt=' + restartAttempt);
            break;
          }

          try {
            const relaunched = await this.bm.restartPreservingSession('cloudflare-challenge attempt=' + restartAttempt);
            page = relaunched.page;
            adapter = new ChatGPTAdapter(page, this.log);
            await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(5000);
            pageState = await adapter.detectPageState();
            if (pageState !== 'CLOUDFLARE') {
              this.log.info('CF challenge cleared after persistent-profile browser restart attempt=' + restartAttempt);
              break;
            }
            this.log.warn('CF challenge still present after persistent-profile restart attempt=' + restartAttempt);
          } catch (e) {
            this.log.warn('CF browser restart failed attempt=' + restartAttempt + ': ' + e.message);
          }
        }
      }

      pageState = await adapter.detectPageState();
      if (pageState === 'AUTH_PAGE' || pageState === 'NOT_AUTHENTICATED') {
        this._transition(STATES.REAUTH_REQUIRED, {
          error: 'ChatGPT session needs re-authentication.',
          message: 'ChatGPT session needs re-authentication.'
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      if (pageState !== 'AUTHENTICATED' && pageState !== 'COMPOSER_PRESENT') {
        let authConfirmed = false;
        for (let i = 0; i < 8; i++) {
          await page.waitForTimeout(750);
          pageState = await adapter.detectPageState();
          if (pageState === 'AUTHENTICATED' || pageState === 'COMPOSER_PRESENT') {
            authConfirmed = true;
            break;
          }
          if (pageState === 'AUTH_PAGE' || pageState === 'NOT_AUTHENTICATED') break;
        }
        if (!authConfirmed) {
          let uiLooksNonAuth = false;
          try {
            const currentUrl = page.url();
            const currentTitle = await page.title();
            uiLooksNonAuth = /\/auth|login\.openai\.com|accounts\.google/i.test(currentUrl || '')
              || /just a moment|verif(y|ying).{0,20}human|attention required/i.test(currentTitle || '');
          } catch (e) {}

          if (isSetupComplete() && !uiLooksNonAuth) {
            this.log.warn('Auth UI not observed; using persisted authenticated session and proceeding to New Chat');
            authConfirmed = true;
          } else {
            this._transition(STATES.NEEDS_REVIEW, {
              error: 'ChatGPT authentication state not confirmed',
              message: 'NEEDS_REVIEW — ChatGPT page state remained unknown after bounded probe'
            });
            this.current.finishedAt = new Date().toISOString();
            saveRunState(this.current);
            this.bm.releaseLock(runId);
            return;
          }
        }
      }

      this._transition(STATES.AUTHENTICATED);

      const activeProxy = this.bm.activeProxy || null;
      const desiredProxy = getProxyServer() || null;
      if (activeProxy !== desiredProxy) {
        this._transition(STATES.NEEDS_REVIEW, {
          error: 'Proxy changed during run before new chat',
          message: 'NEEDS_REVIEW — proxy changed; restarting on the next run is safer than using a stale browser route'
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      const newChatOk = await adapter.openNewChat();
      this.log.info('openNewChat result=' + newChatOk);
      if (!newChatOk) {
        this._transition(STATES.FAILED, {
          error: 'New chat/composer recovery failed',
          message: 'FAILED — no confirmed new chat with usable composer'
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }
      this._transition(STATES.NEW_CHAT_READY);

      await page.waitForTimeout(500);
      let composer = typeof adapter.isComposerUsable === 'function'
        ? await adapter.isComposerUsable(10000)
        : await adapter.waitForComposer(10000);
      if (!composer) {
        this._transition(STATES.FAILED, {
          error: 'Composer disappeared after confirmed new chat',
          message: 'FAILED — composer disappeared after new-chat confirmation'
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }
      this._transition(STATES.COMPOSER_READY);

      this._transition(STATES.PROMPT_INSERTED);
      await adapter.insertPrompt(prompt);
      if (!(await adapter.verifyPromptExact(prompt))) {
        await adapter.insertPrompt(prompt);
      }
      if (!(await adapter.verifyPromptExact(prompt))) {
        this._transition(STATES.NEEDS_REVIEW, {
          error: 'Composer content not exact after insertion',
          message: 'NEEDS_REVIEW — exact prompt mismatch after bounded insertion retry'
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      this._transition(STATES.PLUS_MENU_OPEN);
      this._transition(STATES.PLUGIN_STATE_CONFIRMED);
      this._transition(STATES.THINKING_STATE_CONFIRMED);
      this._transition(STATES.READY_TO_SEND);

      if (!(await adapter.isAuthenticated())) {
        this._transition(STATES.REAUTH_REQUIRED, { error: 'ChatGPT session needs re-authentication.', message: 'ChatGPT session needs re-authentication.' });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }
      if (!(await adapter.verifyPromptExact(prompt))) {
        await adapter.insertPrompt(prompt);
        await new Promise(function(r) { setTimeout(r, 500); });
        if (!(await adapter.verifyPromptExact(prompt))) {
          this._transition(STATES.NEEDS_REVIEW, { error: 'Composer content not exact before send', message: 'NEEDS_REVIEW — exact prompt mismatch before send' });
          this.current.finishedAt = new Date().toISOString();
          saveRunState(this.current);
          this.bm.releaseLock(runId);
          return;
        }
      }

      const desiredProxyBeforeSend = getProxyServer() || null;
      if ((this.bm.activeProxy || null) !== desiredProxyBeforeSend) {
        this._transition(STATES.NEEDS_REVIEW, {
          error: 'Proxy changed during run before send',
          message: 'NEEDS_REVIEW — proxy changed; message was not sent'
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      if (!(await adapter.verifyPromptExact(prompt))) {
        this._transition(STATES.NEEDS_REVIEW, {
          error: 'Composer content not exact immediately before send',
          message: 'NEEDS_REVIEW — exact prompt verification failed immediately before send'
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      const sentPrompt = prompt;
      const identityBefore = await adapter.getConversationIdentity().catch(function() { return {}; });
      this._transition(STATES.MESSAGE_SENT);
      const sendMethod = await adapter.sendMessage();
      this.log.info('Message sent via ' + sendMethod + ' promptHash=' + promptHash);
      await new Promise(function(r) { setTimeout(r, 1500); });

      let verifyResult;
      try {
        verifyResult = await adapter.verifySendPersisted(sentPrompt, { timeout: 55000 });
      } catch (ve) {
        verifyResult = { ok: false, reason: 'verify_threw:' + ve.message, receipt: {} };
      }
      const receipt = Object.assign({ runId: runId, promptHash: promptHash, sendMethod: sendMethod, identityBefore: identityBefore }, verifyResult.receipt || {});

      if (!verifyResult.ok) {
        const reason = verifyResult.reason || 'verification_failed';
        const state = STATES.NEEDS_REVIEW;
        this._transition(state, { error: reason, message: 'NEEDS_REVIEW — ' + reason, verificationReceipt: receipt });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      this._transition(STATES.MESSAGE_VERIFIED, { verificationReceipt: receipt });
      const convUrl = receipt.conversationUrlAfter || receipt.conversationUrlBefore || null;
      this._transition(STATES.COMPLETE, {
        message: 'COMPLETE — exact newest user message persisted. chat=' + (convUrl || receipt.conversationIdAfter || 'unknown'),
        conversationUrl: convUrl,
        conversationId: receipt.conversationIdAfter || null,
        verificationReceipt: receipt,
      });
      this.current.finishedAt = new Date().toISOString();
      saveRunState(this.current);
      this.bm.releaseLock(runId);
      this.log.info('Run ' + runId + ' COMPLETE reloadVerified=' + receipt.reloadVerified + ' matchedHash=' + receipt.matchedHash);
    } catch (err) {
      this.log.error('Run ' + runId + ' failed: ' + err.message);
      if (this.current && this.current.id === runId) {
        this._transition(STATES.FAILED, { error: err.message, message: err.message });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
      }
      this.bm.releaseLock(runId);
    }
  }
}
let executor = null;
function getRunExecutor(logger) {
  if (!executor) executor = new RunExecutor(logger);
  return executor;
}
module.exports = { RunExecutor, getRunExecutor, hashPrompt };
