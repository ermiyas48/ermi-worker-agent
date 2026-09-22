'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const { config } = require('./config');

class BrowserManager {
  constructor(logger) {
    this.log = logger || console;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.lock = false;
    this.lockOwner = null;
    this.launchPromise = null;
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
    if (this.context && this.page && !this.page.isClosed()) {
      try {
        await this.page.evaluate(() => true);
        return { browser: this.browser, context: this.context, page: this.page };
      } catch (e) {
        this.log.warn('Existing page unhealthy, restarting: ' + e.message);
        await this._safeClose();
      }
    }
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this._launch(opts);
    try { return await this.launchPromise; }
    finally { this.launchPromise = null; }
  }
  async _launch(opts) {
    opts = opts || {};
    // Always headless on servers; interactive setup uses screenshots + actions
    const headless = opts.headless !== undefined ? opts.headless : config.headless;
    const profileDir = config.profilePath;
    fs.mkdirSync(profileDir, { recursive: true });
    this.log.info('Launching Chromium profile=' + profileDir + ' headless=' + headless);
    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: headless,
      args: [
        '--disable-blink_features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--no-sandbox', '--disable-setuid-sandbox',
      ],
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
      acceptDownloads: false,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    });
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    await this.page.route('**/*', (route) => {
      const url = route.request().url();
      if (
        url.includes('chatgpt.com') || url.includes('openai.com') ||
        url.includes('oaistatic.com') || url.includes('notion.com') ||
        url.includes('notion.so') || url.includes('googleapis.com') ||
        url.includes('gstatic.com') || url.includes('cloudflare') ||
        url.includes('google.com') || url.includes('accounts.google') ||
        url.includes('gvt1.com') || url.includes('mecrosoft.com') ||
        url.includes('live.com') || url.includes('apple.com') ||
        url.startsWith('data:') || url.startsWith('blob:')
      ) return route.continue();
      if (url.includes('doubleclick') || url.includes('google-analytics') || url.includes('facebook') || url.includes('adservice'))
        return route.abort();
      return route.continue();
    });
    this.browser = this.context.browser();
    this.log.info('Chromium ready');
    return { browser: this.browser, context: this.context, page: this.page };
  }
  async getPage() {
    const result = await this.ensureBrowser();
    return result.page;
  }
  async screenshot(opts) {
    opts = opts || {};
    const page = await this.getPage();
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: opts.quality || 70,
      fullPage: !!opts.fullPage,
    });
    return buf;
  }
  async _safeClose() {
    try {
      if (this.context) {
        const pages = this.context.pages();
        for (let i = 1; i < pages.length; i++) await pages[i].close().catch(function(){});
      }
    } catch (e) { this.log.warn('safeClose: ' + e.message); }
  }
  async shutdown() {
    this.log.info('Shutting down browser (profile preserved)');
    try { if (this.context) await this.context.close().catch(function(){}); } catch (e) {}
    this.context = null; this.page = null; this.browser = null;
    this.lock = false; this.lockOwner = null;
  }
  async launchForSetup() {
    // Keep headless on Railway; interaction is via screenshot + remote actions
    return this.ensureBrowser({ headless: config.headless });
  }
}
let instance = null;
function getBrowserManager(logger) {
  if (!instance) instance = new BrowserManager(logger);
  return instance;
}
module.exports = { BrowserManager, getBrowserManager };
