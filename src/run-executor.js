'use strict';
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { config, saveRunState, isSetupComplete } = require('./config');
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
  async startRun() {
    if (!isSetupComplete()) {
      return { ok: false, error: 'Setup not complete. Complete first-time authentication via /setup/browser', state: STATES.FAILED };
    }
    if (this.bm.isLocked() || (this.current && [STATES.IDLE, STATES.COMPLETE, STATES.FAILED, STATES.NEEDS_REVIEW, STATES.REAUTH_REQUIRED].indexOf(this.current.state) === -1)) {
      return { ok: false, error: 'Another run is in progress', state: this.current ? this.current.state : 'LOCKED' };
    }
    const runId = uuidv4();
    const prompt = config.ermiPrompt;
    const promptHash = hashPrompt(prompt);
    if (!this.bm.acquireLock(runId)) {
      return { ok: false, error: 'Could not acquire execution lock', state: 'LOCKED' };
    }
    this.current = { id: runId, state: STATES.IDLE, history: [], error: null, startedAt: new Date().toISOString(), finishedAt: null, promptHash: promptHash, message: null };
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
    return { ok: true, runId: runId, state: STATES.BROWSER_STARTING, label: HUMAN_LABELS[STATES.BROWSER_STARTING], promptHash: promptHash };
  }
  async _execute(runId, prompt, promptHash) {
    try {
      this._transition(STATES.BROWSER_STARTING);
      const launched = await this.bm.ensureBrowser({ headless: config.headless });
      const page = launched.page;
      const adapter = new ChatGPTAdapter(page, this.log);

      this._transition(STATES.CHATGPT_LOADING);
      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(function() {});

      this._transition(STATES.CHATGPT_READY);
      const pageState = await adapter.detectPageState();
      if (pageState === 'AUTH_PAGE' || pageState === 'NOT_AUTHENTICATED') {
        this._transition(STATES.REAUTH_REQUIRED, { error: 'ChatGPT session needs re-authentication.', message: 'ChatGPT session needs re-authentication.' });
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
        this._transition(STATES.REAUTH_REQUIRED, { error: 'ChatGPT session needs re-authentication.', message: 'ChatGPT session needs re-authentication.' });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }
      if (!(await adapter.verifyPromptExact(prompt))) {
        this._transition(STATES.NEEDS_REVIEW, { error: 'Composer content changed before send; refusing to send', message: 'NEEDS_REVIEW — prompt mismatch before send' });
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
        this._transition(STATES.NEEDS_REVIEW, { error: 'Could not verify user message after send', message: 'NEEDS_REVIEW — submission ambiguous, not resending' });
        this.current.finishedAt = new Date().toISOString();
        saveRunState(this.current);
        this.bm.releaseLock(runId);
        return;
      }

      this._transition(STATES.COMPLETE, { message: 'ERMI Worker Agent prompt submitted and verified successfully' });
      this.current.finishedAt = new Date().toISOString();
      saveRunState(this.current);
      this.bm.releaseLock(runId);
      this.log.info('Run ' + runId + ' COMPLETE');
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
