'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { config, getProxyServer } = require('./config');
const COOKIES_PATH = path.join(config.dataPath, 'chatgpt-cookies.json');

const STEALTH_INIT = '';

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
    this.lock = true; this.lockOwner = runId;
    this.log.info('Lock acquired by ' + runId);
    return true;
  }
  releaseLock(runId) {
    if (this.lockOwner && this.lockOwner !== runId) return false;
    this.lock = false; this.lockOwner = null;
    return true;
  }

  async ensureBrowser(opts) {
    opts = opts || {};
    const desired = getProxyServer();
    if (opts.forceRestart && this.context) await this.close();
    if (this.context && this.page && !this.page.isClosed()) {
      if ((desired || null) !== (this.activeProxy || null)) {
        this.log.info('Proxy changed — restarting browser');
        await this.close();
      } else {
        try {
          await this.page.evaluate(() => true);
          return { browser: this.browser, context: this.context, page: this.page };
        } catch (e) {
          this.log.warn('page unhealthy: ' + e.message);
          await this.close();
        }
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
    this.log.info('Launch Chromium headless=' + headless + ' channel=chromium proxy=' + (proxyServer || 'none'));

    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--mute-audio',
    ];

    const launchOpts = {
      headless: !!headless,
      channel: 'chromium',
      args,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      timezoneId: 'Africa/Addis_Ababa',
      javaScriptEnabled: true,
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    };
    if (proxyServer) launchOpts.proxy = { server: proxyServer };

    try {
      this.context = await chromium.launchPersistentContext(profileDir, launchOpts);
    } catch (err) {
      this.log.warn('launch with native Chromium channel failed: ' + err.message);
      const fallback = { ...launchOpts };
      delete fallback.channel;
      this.context = await chromium.launchPersistentContext(profileDir, fallback);
    }

    await this.context.addInitScript(STEALTH_INIT);
    this.browser = this.context;
    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();
    try { await this.page.addInitScript(STEALTH_INIT); } catch (e) {}

    try {
      // launchPersistentContext() keeps cookies/localStorage on disk across
      // browser restarts. Only use the exported setup cookies as a bootstrap
      // fallback when the persistent profile has no ChatGPT cookies yet.
      const existingProfileCookies = await this.context.cookies(['https://chatgpt.com/']).catch(() => []);
      if (existingProfileCookies.length > 0) {
        this.log.info('Keeping ' + existingProfileCookies.length + ' cookies from persistent Chromium profile; skipping bootstrap cookie re-apply');
      } else if (fs.existsSync(COOKIES_PATH)) {
        const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        if (Array.isArray(raw) && raw.length) {
          const transientCf = new Set(['__cf_bm', '_cfuvid', '__cflb']);
          const skippedCf = raw.filter((c) => c && transientCf.has(String(c.name))).length;
          const mapped = raw.filter((c) => c && !transientCf.has(String(c.name))).map((c) => {
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
            this.log.info('Bootstrapped ' + mapped.length + ' exported auth/app cookies; skipped ' + skippedCf + ' transient Cloudflare cookies');
          }
        }
      }
    } catch (e) {
      this.log.warn('cookie reapply: ' + e.message);
    }

    this.activeProxy = proxyServer || null;
    this.log.info('Chromium ready headless=' + headless + ' native=true proxy=' + (this.activeProxy || 'none'));
    return { browser: this.browser, context: this.context, page: this.page };
  }

  async getPage() {
    const { page } = await this.ensureBrowser();
    return page;
  }

  async close() {
    try { if (this.context) await this.context.close().catch(() => {}); } catch (e) {}
    this.context = null; this.page = null; this.browser = null; this.activeProxy = null;
  }

  async restartPreservingSession(reason) {
    const oldProxy = this.activeProxy || null;
    this.log.warn('Restarting Chromium while preserving persistent profile' + (reason ? ' reason=' + reason : '') + ' proxy=' + (oldProxy || 'none'));
    await this.close();
    return this.ensureBrowser({ headless: config.headless });
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
