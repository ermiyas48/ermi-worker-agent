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
    this.lastChallenge = null;
    this.autoDetectTimer = null;
  }

  getStatus() {
    return {
      setupComplete: isSetupComplete(),
      setupInProgress: this.setupInProgress,
      lastAuthCheck: this.lastAuthCheck,
      lastUrl: this.lastUrl,
      lastChallenge: this.lastChallenge,
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

      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000 + Math.floor(Math.random() * 1500));

      const cf = await this.bm.detectCloudflareChallenge(page);
      this.lastChallenge = cf;
      if (cf.challenge) {
        this.log.info('Cloudflare challenge detected at setup start — waiting / clicking');
        await this.bm.waitOutCloudflare(page, { timeout: 50000, autoClick: true });
        await page.waitForTimeout(1500);
      }

      this.lastUrl = page.url();
      this.log.info('Setup browser launched at ' + this.lastUrl);
      this._startAutoDetect();
      return {
        ok: true,
        message: cf.challenge
          ? 'Browser started. If you see “Verify you are human”, tap the checkbox once and wait a few seconds — do not spam clicks. Auth is detected automatically after ChatGPT loads.'
          : 'Sign in with ChatGPT in the live view below (email, Google, or phone + MFA). Authentication is detected automatically.',
        url: this.lastUrl,
        cloudflare: !!cf.challenge,
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
    }, 3500);
  }

  async detectAuthentication() {
    if (isSetupComplete()) return { authenticated: true, setupComplete: true };
    try {
      const page = await this.bm.getPage();
      const adapter = new ChatGPTAdapter(page, this.log);
      this.lastUrl = page.url();

      const cf = await this.bm.detectCloudflareChallenge(page);
      this.lastChallenge = cf;
      if (cf.challenge) {
        await this.bm.tryClickTurnstile(page);
        return {
          authenticated: false,
          setupComplete: false,
          cloudflare: true,
          message:
            'Cloudflare is checking this browser. Tap the “Verify you are human” box once in the live view, then wait 5–10 seconds. Avoid rapid re-clicks — that can reset the challenge.',
          url: this.lastUrl,
        };
      }

      if (
        !this.lastUrl.includes('chatgpt.com') &&
        !this.lastUrl.includes('openai.com') &&
        !this.lastUrl.includes('google.com') &&
        !this.lastUrl.includes('microsoft.com') &&
        !this.lastUrl.includes('apple.com')
      ) {
        await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
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
        cloudflare: false,
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
        await page.mouse.move(x + (Math.random() * 8 - 4), y + (Math.random() * 8 - 4), {
          steps: 6 + Math.floor(Math.random() * 8),
        });
        await page.waitForTimeout(40 + Math.floor(Math.random() * 80));
        await page.mouse.click(x, y, { delay: 30 + Math.floor(Math.random() * 50) });
        await page.waitForTimeout(500);
        const cf = await this.bm.detectCloudflareChallenge(page);
        this.lastChallenge = cf;
        if (cf.challenge) {
          await page.waitForTimeout(2000);
        }
      } else if (type === 'type') {
        const text = String(action.text || '');
        if (action.clear) {
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.type(text, { delay: 35 + Math.floor(Math.random() * 40) });
      } else if (type === 'press') {
        const key = String(action.key || 'Enter');
        await page.keyboard.press(key);
      } else if (type === 'goto') {
        const url = String(action.url || config.chatgptUrl);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1500);
        const cf = await this.bm.detectCloudflareChallenge(page);
        this.lastChallenge = cf;
        if (cf.challenge) {
          await this.bm.waitOutCloudflare(page, { timeout: 40000, autoClick: true });
        }
      } else if (type === 'scroll') {
        const dy = Number(action.dy) || 300;
        await page.mouse.wheel(0, dy);
      } else if (type === 'cf-click') {
        const clicked = await this.bm.tryClickTurnstile(page);
        await page.waitForTimeout(2000);
        const wait = await this.bm.waitOutCloudflare(page, { timeout: 25000, autoClick: true });
        this.lastChallenge = await this.bm.detectCloudflareChallenge(page);
        return {
          ok: true,
          clicked,
          cleared: wait.cleared,
          cloudflare: !wait.cleared,
          url: page.url(),
        };
      } else {
        return { ok: false, error: 'Unknown action type. Use click|type|press|goto|scroll|cf-click' };
      }
      this.lastUrl = page.url();
      await page.waitForTimeout(300);
      return { ok: true, url: this.lastUrl, cloudflare: !!(this.lastChallenge && this.lastChallenge.challenge) };
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
