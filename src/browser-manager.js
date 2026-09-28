'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { config, getProxyServer } = require('./config');
const COOKIES_PATH = path.join(config.dataPath, 'chatgpt-cookies.json');

const STEALTH_INIT = `
(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
  try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch (e) {}
  try {
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  } catch (e) {}
})();
`;

const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class BrowserManager {
  constructor(logger) {
    this.log = logger || console;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.lock = false;
    this.lockOwner = null;
    this.launchPromise = null;
    this.activeProxy = null;
    this.lifecycleTail = Promise.resolve();
  }

  async _withLifecycle(task) {
    const previous = this.lifecycleTail;
    let release;
    this.lifecycleTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
  isLocked() { return this.lock; }
  acquireLock(runId) {
    if (this.lock) return false;
    this.lock = true; this.lockOwner = runId;
    this.log.info('Lock acquired by ' + runId);
    return true;
  }
  releaseLock(runId) {
    if (!this.lock || this.lockOwner !== runId) return false;
    this.lock = false; this.lockOwner = null;
    return true;
  }

  async ensureBrowser(opts) {
    return this._withLifecycle(() => this._ensureBrowserUnlocked(opts));
  }

  async _ensureBrowserUnlocked(opts) {
    opts = opts || {};
    const desired = getProxyServer();
    if (opts.forceRestart && this.context) await this._closeUnlocked();
    if (this.context) {
      try {
        const pages = this.context.pages().filter((p) => !p.isClosed());
        if (pages.length) this.page = pages[0];
      } catch (e) {
        this.log.warn('browser context unavailable; relaunching: ' + e.message);
        await this._closeUnlocked();
      }
    }
    if (this.context && this.page && !this.page.isClosed()) {
      if ((desired || null) !== (this.activeProxy || null)) {
        this.log.info('Proxy changed — restarting browser');
        await this._closeUnlocked();
      } else {
        return { browser: this.browser, context: this.context, page: this.page };
      }
    }
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this._launch(opts);
    try { return await this.launchPromise; }
    finally { this.launchPromise = null; }
  }

  async _launch(opts) {
    opts = opts || {};
    const headless = opts.headless !== undefined ? opts.headless : config.headless;
    const profileDir = config.profilePath;
    fs.mkdirSync(profileDir, { recursive: true });
    const proxyServer = getProxyServer();
    this.log.info('Launch Chromium headless=' + headless + ' proxy=' + (proxyServer || 'none'));

    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--single-process',
      '--mute-audio',
    ];

    const launchOpts = {
      headless: !!headless,
      args,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
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

    // Re-apply persisted ChatGPT cookies after every launch (survives proxy restart)
    try {
      if (fs.existsSync(COOKIES_PATH)) {
        const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        if (Array.isArray(raw) && raw.length) {
          const mapped = raw.map((c) => {
            if (!c || !c.name) return null;
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

  async getPage() {
    const { page } = await this.ensureBrowser();
    return page;
  }

  async close() {
    return this._withLifecycle(() => this._closeUnlocked());
  }

  async _closeUnlocked() {
    try { if (this.context) await this.context.close().catch(() => {}); } catch (e) {}
    this.context = null; this.page = null; this.browser = null; this.activeProxy = null;
  }

  async restartPreservingSession(reason) {
    return this._withLifecycle(async () => {
      const oldProxy = this.activeProxy || null;
      this.log.warn('Restarting Chromium while preserving persistent profile' + (reason ? ' reason=' + reason : '') + ' proxy=' + (oldProxy || 'none'));
      await this._closeUnlocked();
      return this._ensureBrowserUnlocked({ headless: config.headless });
    });
  }

  async launchForSetup() {
    return this.ensureBrowser({});
  }
}

let instance = null;
function getBrowserManager(logger) {
  if (!instance) instance = new BrowserManager(logger);
  return instance;
}
module.exports = { BrowserManager, getBrowserManager };
