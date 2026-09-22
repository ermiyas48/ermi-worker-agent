'use strict';
const { config, isSetupComplete, markSetupComplete } = require('./config');
const { getBrowserManager } = require('./browser-manager');
const { ChatGPTAdapter } = require('./chatgpt-adapter');

class SetupController {
  constructor(logger) {
    this.log = logger || console;
    this.bm = getBrowserManager(this.log);
    this.setupInProgress = false;
    this.lastAuthCheck = null;
    this.lastUrl = null;
    this.autoDetectTimer = null;
  }

  getStatus() {
    return {
      setupComplete: isSetupComplete(),
      setupInProgress: this.setupInProgress,
      lastAuthCheck: this.lastAuthCheck,
      lastUrl: this.lastUrl,
      profilePath: config.profilePath,
    };
  }

  async startSetupBrowser() {
    if (isSetupComplete()) {
      return {
        ok: false,
        error: 'Setup already complete. Re-authentication requires clearing the setup flag / profile.',
      };
    }
    this.setupInProgress = true;
    try {
      const result = await this.bm.launchForSetup();
      const page = result.page;
      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      this.lastUrl = page.url();
      this.log.info('Setup browser launched at ' + this.lastUrl);
      this._startAutoDetect();
      return {
        ok: true,
        message:
          'Sign in with ChatGPT in the live view below (email, Google, or phone + MFA). Authentication is detected automatically.',
        url: this.lastUrl,
      };
    } catch (e) {
      this.setupInProgress = false;
      return { ok: false, error: e.message };
    }
  }

  _startAutoDetect() {
    if (this.autoDetectTimer) clearInterval(this.autoDetectTimer);
    const self = this;
    this.autoDetectTimer = setInterval(function () {
      if (isSetupComplete()) {
        clearInterval(self.autoDetectTimer);
        self.autoDetectTimer = null;
        return;
      }
      self.detectAuthentication().catch(function () {});
    }, 4000);
  }

  async detectAuthentication() {
    if (isSetupComplete()) return { authenticated: true, setupComplete: true };
    try {
      const page = await this.bm.getPage();
      const adapter = new ChatGPTAdapter(page, this.log);
      this.lastUrl = page.url();
      if (
        !this.lastUrl.includes('chatgpt.com') &&
        !this.lastUrl.includes('openai.com') &&
        !this.lastUrl.includes('google.com') &&
        !this.lastUrl.includes('microsoft.com') &&
        !this.lastUrl.includes('apple.com')
      ) {
        await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        this.lastUrl = page.url();
      }
      const authed = await adapter.isAuthenticated();
      this.lastAuthCheck = {
        at: new Date().toISOString(),
        authenticated: authed,
        url: this.lastUrl,
      };
      if (authed) {
        markSetupComplete();
        this.setupInProgress = false;
        if (this.autoDetectTimer) {
          clearInterval(this.autoDetectTimer);
          this.autoDetectTimer = null;
        }
        this.log.info('Authentication detected – setup complete');
        return {
          authenticated: true,
          setupComplete: true,
          message: 'Authentication successful. Profile saved. Setup is complete.',
          url: this.lastUrl,
        };
      }
      return {
        authenticated: false,
        setupComplete: false,
        message: 'Not yet authenticated. Complete ChatGPT sign-in in the live view (including MFA if prompted).',
        url: this.lastUrl,
      };
    } catch (e) {
      return { authenticated: false, error: e.message };
    }
  }

  async getScreenshot() {
    if (isSetupComplete()) throw new Error('Setup already complete');
    try {
      await this.bm.getPage();
      const buf = await this.bm.screenshot({ quality: 65 });
      try {
        const page = await this.bm.getPage();
        this.lastUrl = page.url();
      } catch (_) {}
      return buf;
    } catch (e) {
      this.log.warn('Screenshot failed: ' + e.message);
      throw e;
    }
  }

  async performAction(action) {
    if (isSetupComplete()) return { ok: false, error: 'Setup already complete' };
    const page = await this.bm.getPage();
    const type = (action && action.type) || '';
    try {
      if (type === 'click') {
        const x = Number(action.x);
        const y = Number(action.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'x and y required' };
        await page.mouse.click(x, y);
        await page.waitForTimeout(400);
      } else if (type === 'type') {
        const text = String(action.text || '');
        if (action.clear) {
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.type(text, { delay: 25 });
      } else if (type === 'press') {
        const key = String(action.key || 'Enter');
        await page.keyboard.press(key);
      } else if (type === 'goto') {
        const url = String(action.url || config.chatgptUrl);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } else if (type === 'scroll') {
        const dy = Number(action.dy) || 300;
        await page.mouse.wheel(0, dy);
      } else {
        return { ok: false, error: 'Unknown action type. Use click|type|press|goto|scroll' };
      }
      this.lastUrl = page.url();
      await page.waitForTimeout(300);
      return { ok: true, url: this.lastUrl };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getSetupPageHtml() {
    return require('fs').readFileSync(
      require('path').join(__dirname, '..', 'public', 'setup.html'),
      'utf8'
    );
  }
}

let setupCtrl = null;
function getSetupController(logger) {
  if (!setupCtrl) setupCtrl = new SetupController(logger);
  return setupCtrl;
}
module.exports = { SetupController, getSetupController };
