'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const { config, getProxyServer } = require('./config');

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
    this.log.info(`Lock acquired by ${runId}`);
    return true;
  }
  releaseLock(runId) {
    if (this.lockOwner && this.lockOwner !== runId) {
      this.log.warn(`Lock release ignored: owner=${this.lockOwner} requester=${runId}`);
      return false;
    }
    this.lock = false;
    this.lockOwner = null;
    this.log.info(`Lock released by ${runId}`);
    return true;
  }
  async ensureBrowser(opts = {}) {
    const desired = getProxyServer();
    if (opts.forceRestart && this.context) {
      this.log.info('forceRestart requested — closing browser');
      await this._safeClose();
      try { if (this.context) await this.context.close().catch(() => {}); } catch {}
      this.context = null; this.page = null; this.browser = null; this.activeProxy = null;
    }
    if (this.context && this.page && !this.page.isClosed()) {
      if ((desired || null) !== (this.activeProxy || null)) {
        this.log.info('Proxy changed since launch — restarting browser');
        await this._safeClose();
        try { if (this.context) await this.context.close().catch(() => {}); } catch {}
        this.context = null; this.page = null; this.browser = null;
      } else {
        try {
          await this.page.evaluate(() => true);
          return { browser: this.browser, context: this.context, page: this.page };
        } catch (e) {
          this.log.warn('Existing page unhealthy, restarting: ' + e.message);
          await this._safeClose();
        }
      }
    }
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this._launch(opts);
    try { return await this.launchPromise; }
    finally { this.launchPromise = null; }
  }
  async _launch(opts = {}) {
    const headless = opts.headless !== undefined ? opts.headless : config.headless;
    const profileDir = config.profilePath;
    fs.mkdirSync(profileDir, { recursive: true });
    const proxyServer = getProxyServer();
    this.log.info(`Launching Chromium profile=${profileDir} headless=${headless} proxy=${proxyServer || 'none'}`);

    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run', '--no-default-browser-check',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-sandbox', '--disable-setuid-sandbox',
      '--single-process',
    ];

    const launchOpts = {
      headless,
      args,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      locale: 'en-US',
    };
    if (proxyServer) {
      launchOpts.proxy = { server: proxyServer };
    }
    try {
      this.context = await chromium.launchPersistentContext(profileDir, launchOpts);
    } catch (err) {
      this.log.error('Primary launch failed: ' + err.message);
      const args2 = args.filter(a => a !== '--single-process');
      this.context = await chromium.launchPersistentContext(profileDir, { ...launchOpts, args: args2 });
    }
    this.browser = this.context;
    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();
    this.activeProxy = proxyServer || null;
    this.log.info('Chromium ready proxy=' + (this.activeProxy || 'none'));
    return { browser: this.browser, context: this.context, page: this.page };
  }
  async getPage() {
    const { page } = await this.ensureBrowser();
    return page;
  }
  async _safeClose() {
    try {
      const pages = this.context ? this.context.pages() : [];
      for (let i = 1; i < pages.length; i++) await pages[i].close().catch(() => {});
    } catch {}
  }
  async close() {
    await this._safeClose();
    try { if (this.context) await this.context.close().catch(() => {}); } catch {}
    this.context = null; this.page = null; this.browser = null;
    this.lock = false; this.lockOwner = null; this.activeProxy = null;
  }
  async launchForSetup() {
    return this.ensureBrowser({ forceRestart: false });
  }
}

let instance = null;
function getBrowserManager(logger) {
  if (!instance) instance = new BrowserManager(logger);
  return instance;
}
module.exports = { BrowserManager, getBrowserManager };
