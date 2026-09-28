'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { config, getProxyServer } = require('./config');

const COOKIES_PATH = path.join(config.dataPath, 'chatgpt-cookies.json');
const PROFILE_DIR = path.join(config.dataPath, 'profiles', 'chatgpt');

const STEALTH_INIT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`;

const REAL_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

class BrowserManager {
  constructor(logger) {
    this.log = logger || console;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.activeProxy = null;
    this.lockOwner = null;
    this._lifecycle = Promise.resolve();
  }

  isLocked() { return !!this.lockOwner; }

  acquireLock(runId) {
    if (this.lockOwner) return false;
    this.lockOwner = runId;
    return true;
  }

  releaseLock(runId) {
    if (this.lockOwner === runId) this.lockOwner = null;
  }

  _withLifecycle(fn) {
    const run = this._lifecycle.then(fn, fn);
    this._lifecycle = run.catch(function () {});
    return run;
  }

  async ensureBrowser(opts) {
    return this._withLifecycle(() => this._ensureBrowserUnlocked(opts));
  }

  async _ensureBrowserUnlocked(opts) {
    opts = opts || {};
    const proxyServer = getProxyServer();
    if (this.context && this.page && !this.page.isClosed()) {
      if ((proxyServer || null) === (this.activeProxy || null)) {
        return { browser: this.browser, context: this.context, page: this.page };
      }
      this.log.info('Proxy changed — restarting browser');
      try { await this.context.close(); } catch (e) {}
      this.context = null;
      this.browser = null;
      this.page = null;
    }

    const headless = opts.headless !== undefined ? opts.headless : config.headless;
    const profileDir = PROFILE_DIR;
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) {}
    this.log.info('Launch Chromium headless=' + headless + ' proxy=' + (proxyServer || 'none'));

    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ];
    const launchOpts = {
      headless: !!headless,
      args,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US',
      timezoneId: 'Africa/Addis_Ababa',
      userAgent: REAL_UA,
      javaScriptEnabled: true,
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };
    if (proxyServer) launchOpts.proxy = { server: proxyServer };

    try {
      this.context = await chromium.launchPersistentContext(profileDir, launchOpts);
    } catch (err) {
      this.log.warn('launch with single-process failed: ' + err.message);
      const args2 = args.filter((a) => a !== '--single-process');
      this.context = await chromium.launchPersistentContext(profileDir, { ...launchOpts, args: args2 });
    }

    await this.context.addInitScript(STEALTH_INIT);
    this.browser = this.context;
    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();
    try { await this.page.addInitScript(STEALTH_INIT); } catch (e) {}

    try {
      if (fs.existsSync(COOKIES_PATH)) {
        const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        if (Array.isArray(raw) && raw.length) {
          const mapped = raw.map((c) => {
            if (!c || !c.name) return null;
            const drop = new Set(['__cflb']);
            const n = String(c.name).toLowerCase();
            if (drop.has(n)) return null;
            const ss = String(c.sameSite || 'lax').toLowerCase();
            const out = {
              name: c.name,
              value: String(c.value),
              path: c.path || '/',
              httpOnly: !!c.httpOnly,
              secure: typeof c.secure === 'boolean' ? c.secure : true,
              sameSite: (ss === 'no_restriction' || ss === 'none') ? 'None' : (ss === 'strict' ? 'Strict' : 'Lax'),
            };
            if (c.domain) out.domain = c.domain; else out.url = 'https://chatgpt.com/';
            if (c.expirationDate && !c.session) out.expires = Math.floor(Number(c.expirationDate));
            return out;
          }).filter(Boolean);
          if (mapped.length) {
            await this.context.addCookies(mapped);
            this.log.info('Re-applied ' + mapped.length + ' persisted cookies');
          }
        }
      }
    } catch (e) {
      this.log.warn('cookie reapply: ' + e.message);
    }

    this.activeProxy = proxyServer || null;
    this.log.info('Chromium ready proxy=' + (this.activeProxy || 'none'));
    return { browser: this.browser, context: this.context, page: this.page };
  }

  async exportSessionCookies() {
    try {
      if (!this.context) return 0;
      const cookies = await this.context.cookies();
      if (!cookies || !cookies.length) return 0;
      let prior = [];
      try {
        if (fs.existsSync(COOKIES_PATH)) prior = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8')) || [];
      } catch (e) {}
      const byName = new Map();
      for (const c of prior) {
        if (c && c.name) byName.set(c.name + '|' + (c.domain || ''), c);
      }
      for (const c of cookies) {
        if (!c || !c.name) continue;
        byName.set(c.name + '|' + (c.domain || ''), {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite || 'Lax',
          expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
        });
      }
      const merged = Array.from(byName.values());
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(merged, null, 0));
      this.log.info('Exported ' + merged.length + ' session cookies (incl. cf_clearance if present)');
      return merged.length;
    } catch (e) {
      this.log.warn('exportSessionCookies: ' + e.message);
      return 0;
    }
  }

  async getPage() {
    const { page } = await this.ensureBrowser();
    return page;
  }

  async takeScreenshot() {
    const page = await this.getPage();
    const buffer = await page.screenshot({ fullPage: false, type: 'png' });
    return { buffer };
  }

  async restartPreservingSession(reason) {
    return this._withLifecycle(async () => {
      const oldProxy = this.activeProxy;
      this.log.warn('Restarting Chromium while preserving persistent profile' + (reason ? ' reason=' + reason : '') + ' proxy=' + (oldProxy || 'none'));
      try { if (this.context) await this.context.close(); } catch (e) {}
      this.context = null; this.browser = null; this.page = null;
      return this._ensureBrowserUnlocked({ headless: config.headless });
    });
  }

  async close() {
    return this._withLifecycle(async () => {
      try { if (this.context) await this.context.close(); } catch (e) {}
      this.context = null; this.browser = null; this.page = null; this.activeProxy = null;
    });
  }
}

let instance = null;
function getBrowserManager(logger) {
  if (!instance) instance = new BrowserManager(logger);
  return instance;
}
module.exports = { BrowserManager, getBrowserManager, COOKIES_PATH, PROFILE_DIR };
