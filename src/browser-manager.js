'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const { config, getProxyServer } = require('./config');

const STEALTH_INIT = `
(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch (e) {}
  try {
    if (!window.chrome) window.chrome = { runtime: {} };
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
  } catch (e) {}
  try {
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  } catch (e) {}
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, param);
    };
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
  }

  isLocked() { return this.lock; }

  acquireLock(runId) {
    if (this.lock) return false;
    this.lock = true;
    this.lockOwner = runId;
    this.log.info('Lock acquired by ' + runId);
    return true;
  }

  releaseLock(runId) {
    if (this.lockOwner && this.lockOwner !== runId) {
      this.log.warn('Lock release ignored: owner=' + this.lockOwner + ' requester=' + runId);
      return false;
    }
    this.lock = false;
    this.lockOwner = null;
    this.log.info('Lock released by ' + runId);
    return true;
  }

  async ensureBrowser(opts) {
    opts = opts || {};
    const desired = getProxyServer();

    if (opts.forceRestart && this.context) {
      this.log.info('forceRestart — closing browser');
      await this.close();
    }

    if (this.context && this.page && !this.page.isClosed()) {
      if ((desired || null) !== (this.activeProxy || null)) {
        this.log.info('Proxy changed since launch — restarting browser');
        await this.close();
      } else {
        try {
          await this.page.evaluate(() => true);
          return { browser: this.browser, context: this.context, page: this.page };
        } catch (e) {
          this.log.warn('Existing page unhealthy, restarting: ' + e.message);
          await this.close();
        }
      }
    }

    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this._launch(opts);
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  async _applyStealth(context) {
    await context.addInitScript(STEALTH_INIT);
  }

  async _launch(opts) {
    opts = opts || {};
    const headless = opts.headless !== undefined ? opts.headless : config.headless;
    const profileDir = config.profilePath;
    fs.mkdirSync(profileDir, { recursive: true });
    let proxyServer = getProxyServer();
    this.log.info(
      'Launching Chromium profile=' + profileDir +
      ' headless=' + headless +
      ' proxy=' + (proxyServer || 'none')
    );

    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-zygote',
    ];

    const launchOpts = {
      headless: headless ? true : false,
      args,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      timezoneId: 'Africa/Addis_Ababa',
      userAgent: REAL_UA,
      colorScheme: 'light',
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      javaScriptEnabled: true,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      },
    };
    if (proxyServer) {
      launchOpts.proxy = { server: proxyServer };
    }

    try {
      this.context = await chromium.launchPersistentContext(profileDir, launchOpts);
    } catch (err) {
      this.log.warn('Launch attempt 1 failed: ' + err.message);
      try {
        const args2 = args.filter((a) => a !== '--no-zygote');
        this.context = await chromium.launchPersistentContext(profileDir, {
          ...launchOpts,
          args: args2,
        });
      } catch (err2) {
        this.log.warn('Launch attempt 2 failed: ' + err2.message);
        const args3 = [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--single-process',
        ];
        this.context = await chromium.launchPersistentContext(profileDir, {
          ...launchOpts,
          args: args3,
        });
      }
    }

    await this._applyStealth(this.context);

    this.browser = this.context;
    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();
    try {
      await this.page.addInitScript(STEALTH_INIT);
    } catch (e) {}

    this.activeProxy = proxyServer || null;
    this.log.info('Chromium ready proxy=' + (this.activeProxy || 'none'));
    return { browser: this.browser, context: this.context, page: this.page };
  }

  async getPage() {
    const { page } = await this.ensureBrowser();
    return page;
  }

  async close() {
    try {
      if (this.context) await this.context.close().catch(() => {});
    } catch (e) {}
    this.context = null;
    this.page = null;
    this.browser = null;
    this.activeProxy = null;
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
