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
      '--disable-infobars', '--window-size=1280,900', '--lang=en-US',
      '--disable-features=IsolateOrigins,site-per-process',
      '--single-process',
    ];

    const launchOpts = {
      headless: headless === false ? false : true,
      args,
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
      acceptDownloads: false,
    };
    if (proxyServer) {
      launchOpts.proxy = { server: proxyServer };
    }

    try {
      this.context = await chromium.launchPersistentContext(profileDir, launchOpts);
    } catch (err) {
      this.log.error('Primary launch failed: ' + err.message);
      const args2 = args.filter((a) => a !== '--single-process');
      this.context = await chromium.launchPersistentContext(profileDir, { ...launchOpts, args: args2 });
    }

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    await this.page.route('**/*', (route) => {
      const url = route.request().url();
      if (
        url.includes('chatgpt.com') || url.includes('openai.com') ||
        url.includes('oaistatic.com') || url.includes('notion.com') ||
        url.includes('notion.so') || url.includes('googleapis.com') ||
        url.includes('gstatic.com') || url.includes('cloudflare') ||
        url.startsWith('data:') || url.startsWith('blob:')
      ) return route.continue();
      if (url.includes('doubleclick') || url.includes('google-analytics') || url.includes('facebook'))
        return route.abort();
      return route.continue();
    });
    this.browser = this.context.browser();
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
      if (this.context) {
        const pages = this.context.pages();
        for (let i = 1; i < pages.length; i++) await pages[i].close().catch(() => {});
      }
    } catch (e) { this.log.warn('safeClose: ' + e.message); }
  }
  async shutdown() {
    this.log.info('Shutting down browser (profile preserved)');
    try { if (this.context) await this.context.close().catch(() => {}); } catch {}
    this.context = null; this.page = null; this.browser = null;
    this.lock = false; this.lockOwner = null; this.activeProxy = null;
  }
  async launchForSetup() {
    return this.ensureBrowser({ headless: true });
  }
}
let instance = null;
function getBrowserManager(logger) {
  if (!instance) instance = new BrowserManager(logger);
  return instance;
}
module.exports = { BrowserManager, getBrowserManager };
