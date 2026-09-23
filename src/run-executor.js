'use strict';
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const {
  config,
  saveRunState,
  isSetupComplete,
  resolvePrompt,
  incrementRunCounter,
  getRunCounter,
  PROMPTS,
} = require('./config');
const { STATES, HUMAN_LABELS } = require('./states');
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
    this.queue = [];
    this.processing = false;
  }

  getStatus() {
    if (!this.current) {
      return {
        state: STATES.IDLE,
        label: HUMAN_LABELS[STATES.IDLE],
        locked: this.bm.isLocked(),
        setupComplete: isSetupComplete(),
        runCounter: getRunCounter(),
      };
    }
    return {
      ...this.current,
      label: HUMAN_LABELS[this.current.state] || this.current.state,
      locked: this.bm.isLocked(),
      setupComplete: isSetupComplete(),
      runCounter: getRunCounter(),
    };
  }

  _transition(to, extra) {
    extra = extra || {};
    if (!this.current) return;
    const from = this.current.state;
    this.current.state = to;
    this.current.history = this.current.history || [];
    this.current.history.push(Object.assign({ at: new Date().toISOString(), from, to }, extra));
    Object.assign(this.current, extra);
    saveRunState(this.current);
    this.log.info('STATE ' + from + ' → ' + to);
  }

  async startRun(opts) {
    opts = opts || {};
    if (!isSetupComplete()) {
      return {
        ok: false,
        error: 'Setup not complete. Open /setup and tap Sign in with ChatGPT.',
        state: STATES.FAILED,
      };
    }
    if (this.bm.isLocked() || (this.current && [STATES.IDLE, STATES.COMPLETE, STATES.FAILED, STATES.NEEDS_REVIEW, STATES.REAUTH_REQUIRED].indexOf(this.current.state) === -1)) {
      return {
        ok: false,
        error: 'Another run is in progress',
        state: this.current ? this.current.state : 'LOCKED',
        status: 'running',
      };
    }

    const promptMeta = resolvePrompt(opts.promptId);
    const prompt = promptMeta.body;
    const promptHash = hashPrompt(prompt);
    const runId = uuidv4();

    if (!this.bm.acquireLock(runId)) {
      return { ok: false, error: 'Could not acquire execution lock', state: 'LOCKED', status: 'error' };
    }

    const runNumber = incrementRunCounter();

    this.current = {
      id: runId,
      state: STATES.IDLE,
      history: [],
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      promptHash,
      promptId: promptMeta.id,
      promptLabel: promptMeta.label,
      runNumber,
      message: null,
    };
    saveRunState(this.current);

    const self = this;
    this._execute(runId, prompt, promptHash, promptMeta).catch(function (err) {
      self.log.error('Unhandled run error: ' + (err && err.stack));
      if (self.current && self.current.id === runId) {
        self._transition(STATES.FAILED, { error: err.message });
        self.current.finishedAt = new Date().toISOString();
        saveRunState(self.current);
      }
      self.bm.releaseLock(runId);
    });

    return {
      ok: true,
      status: 'queued',
      runId,
      state: STATES.BROWSER_STARTING,
      label: HUMAN_LABELS[STATES.BROWSER_STARTING],
      promptId: promptMeta.id,
      promptLabel: promptMeta.label,
      runNumber,
      promptHash,
      message: 'Run accepted and executing',
    };
  }

  async _execute(runId, prompt, promptHash, promptMeta) {
    try {
      this._transition(STATES.BROWSER_STARTING);
      // Network strategy: prefer last success; try proxy then direct (or reverse) before submission
      const desiredProxy = (typeof require('./config').getProxyServer === 'function' ? require('./config').getProxyServer() : '') || '';
      const order = desiredProxy ? ['proxy', 'direct'] : ['direct', 'proxy'];
      let page = null;
      let adapter = null;
      let navError = null;

      for (let mi = 0; mi < order.length; mi++) {
        const mode = order[mi];
        if (mode === 'proxy' && !desiredProxy) continue;
        try {
          this.log.info('Network attempt mode=' + mode);
          await this.bm.ensureBrowser({
            headless: config.headless,
            forceDirect: mode === 'direct',
            desiredProxy: mode === 'proxy' ? desiredProxy : '',
            desiredMode: mode,
          });
          // Force recreate if mode mismatch
          if (this.bm.networkMode && this.bm.networkMode !== mode) {
            await this.bm._safeClose();
            await this.bm.ensureBrowser({
              headless: config.headless,
              forceDirect: mode === 'direct',
              desiredProxy: mode === 'proxy' ? desiredProxy : '',
              desiredMode: mode,
            });
          }
          page = this.bm.page;
          if (!page) throw new Error('no_page_after_launch');

          this._transition(STATES.CHATGPT_LOADING, { networkMode: mode });
          await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(1500);
          try {
            const cfWait = await this.bm.waitOutCloudflare(page, { timeout: 40000, autoClick: true });
            if (!cfWait.cleared) this.log.warn('Cloudflare may still be present after wait');
          } catch (e) {
            this.log.warn('CF wait: ' + e.message);
          }
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(function () {});
          navError = null;
          this.log.info('ChatGPT reachable via ' + mode);
          break;
        } catch (e) {
          navError = e;
          this.log.warn('Network mode ' + mode + ' failed: ' + e.message);
          try { await this.bm._safeClose(); } catch (_) {}
          page = null;
        }
      }

      if (!page) {
        this._transition(STATES.FAILED, {
          error: 'PROXY_UNAVAILABLE: ' + (navError && navError.message ? navError.message : 'all network modes failed'),
          message: 'Could not reach ChatGPT via proxy or direct. Ensure Termux/Pinggy is up and POST /proxy has a valid endpoint.',
          status: 'error',
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      adapter = new ChatGPTAdapter(page, this.log);
      this._transition(STATES.CHATGPT_READY);
      const pageState = await adapter.detectPageState();
      if (pageState === 'CLOUDFLARE' || pageState === 'AUTH_PAGE' || pageState === 'NOT_AUTHENTICATED') {
        this._transition(STATES.REAUTH_REQUIRED, {
          error: pageState === 'CLOUDFLARE' ? 'Cloudflare challenge blocked ChatGPT' : 'ChatGPT session needs re-authentication.',
          message: pageState === 'CLOUDFLARE' ? 'Cloudflare challenge blocked the browser. Open /setup, complete verification, then retry.' : 'ChatGPT session expired. Open /setup and sign in again.',
          status: 'error',
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }
      this._transition(STATES.AUTHENTICATED);

      this._transition(STATES.NEW_CHAT_READY);
      await adapter.openNewChat();
      await page.waitForTimeout(800);

      this._transition(STATES.COMPOSER_READY);
      const composer = await adapter.waitForComposer(20000);
      if (!composer) throw new Error('Composer not ready after new chat');

      this._transition(STATES.PROMPT_INSERTED);
      await adapter.insertPrompt(prompt);
      const verified = await adapter.verifyPromptExact(prompt);
      if (!verified) this.log.warn('Prompt verification soft-fail');

      this._transition(STATES.PLUS_MENU_OPEN);
      const plusOpened = await adapter.openPlusMenu();
      if (plusOpened) await adapter.selectPluginsIfAvailable();
      this._transition(STATES.PLUGIN_STATE_CONFIRMED);

      await adapter.selectThinkingIfAvailable();
      this._transition(STATES.THINKING_STATE_CONFIRMED);

      this._transition(STATES.READY_TO_SEND);
      if (!(await adapter.isAuthenticated())) {
        this._transition(STATES.REAUTH_REQUIRED, {
          error: 'ChatGPT session needs re-authentication.',
          message: 'ChatGPT session expired before send.',
          status: 'error',
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }
      if (!(await adapter.verifyPromptExact(prompt))) {
        this._transition(STATES.NEEDS_REVIEW, {
          error: 'Composer content changed before send; refusing to send',
          message: 'NEEDS_REVIEW – prompt mismatch before send',
          status: 'error',
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      this._transition(STATES.MESSAGE_SENT);
      const sendMethod = await adapter.sendMessage();
      this.log.info('Message sent via ' + sendMethod);

      this._transition(STATES.MESSAGE_VERIFIED);
      const appeared = await adapter.verifyUserMessageAppeared(prompt, 25000);
      if (!appeared) {
        this._transition(STATES.NEEDS_REVIEW, {
          error: 'Could not verify user message after send',
          message: 'NEEDS_REVIEW – submission ambiguous, not resent',
          status: 'error',
        });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      const receipt =
        'ERMI ' +
        promptMeta.label +
        ' prompt submitted and verified (run #' +
        (this.current.runNumber || '?') +
        ')';
      this._transition(STATES.COMPLETE, {
        message: receipt,
        status: 'completed',
      });
      this.current.finishedAt = new Date().toISOString();
      saveRunState(this.current);
      this.bm.releaseLock(runId);
      this.log.info('Run ' + runId + ' COMPLETE – ' + promptMeta.id);
    } catch (err) {
      this.log.error('Run ' + runId + ' failed: ' + err.message);
      if (this.current && this.current.id === runId) {
        this._transition(STATES.FAILED, {
          error: err.message,
          message: err.message,
          status: 'error',
        });
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
