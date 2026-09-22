'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const { config } = require('./config');

const STEALTH_INIT = `
(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { window.chrome = window.chrome || { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} }; } catch (e) {}
  try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ],
    });
  } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
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
    const headless = opts.headless !== undefined ? opts.headless : config.headless;
    const profileDir = config.profilePath;
    fs.mkdirSync(profileDir, { recursive: true });
    this.log.info('Launching Chromium profile=' + profileDir + ' headless=' + headless);

    const launchOpts = {
      headless: headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--window-size=1280,900',
        '--lang=en-US',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--force-color-profile=srgb',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      javaScriptEnabled: true,
      acceptDownloads: false,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };
    if (config.proxyServer) {
      const proxy = { server: config.proxyServer };
      try {
        const u = new URL(config.proxyServer);
        if (u.username) {
          proxy.server = u.protocol + '//' + u.host;
          proxy.username = decodeURIComponent(u.username);
          proxy.password = decodeURIComponent(u.password || '');
        }
      } catch (_) {}
      launchOpts.proxy = proxy;
      this.log.info('Using proxy ' + (launchOpts.proxy.server || config.proxyServer));
    }
    this.context = await chromium.launchPersistentContext(profileDir, launchOpts);
    await this.context.addInitScript(STEALTH_INIT);

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

    await this.page.route('**/*', (route) => {
      const url = route.request().url();
      if (/doubleclick|google-analytics|googletagmanager|facebook\.net|adservice|hotjar|segment\.io/i.test(url)) {
        return route.abort();
      }
      return route.continue();
    });

    this.browser = this.context.browser();
    this.log.info('Chromium ready (stealth init applied)');
    return { browser: this.browser, context: this.context, page: this.page };
  }
  async getPage() {
    const result = await this.ensureBrowser();
    return result.page;
  }
  async screenshot(opts) {
    opts = opts || {};
    const page = await this.getPage();
    return page.screenshot({ type: 'jpeg', quality: opts.quality || 70, fullPage: !!opts.fullPage });
  }
  async _safeClose() {
    try {
      if (this.context) {
        const pages = this.context.pages();
        for (let i = 1; i < pages.length; i++) await pages[i].close().catch(function () {});
      }
    } catch (e) {
      this.log.warn('safeClose: ' + e.message);
    }
  }
  async shutdown() {
    this.log.info('Shutting down browser (profile preserved)');
    try { if (this.context) await this.context.close().catch(function () {}); } catch (e) {}
    this.context = null;
    this.page = null;
    this.browser = null;
    this.lock = false;
    this.lockOwner = null;
  }
  async launchForSetup() {
    return this.ensureBrowser({ headless: config.headless });
  }

  async detectCloudflareChallenge(page) {
    page = page || this.page;
    if (!page) return { challenge: false };
    try {
      return await page.evaluate(() => {
        const title = (document.title || '').toLowerCase();
        const body = (document.body && document.body.innerText) || '';
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const challengeTitle = /just a moment|attention required|verif(y|ying).{0,20}human|checking your browser|security check/i.test(title);
        const challengeBody = /verif(y|ying).{0,30}(you.?re|that you are).{0,10}human|checking your browser before you proceed|enable javascript and cookies|cf-turnstile|challenge-platform|challenges\.cloudflare/i.test(body + ' ' + html.slice(0, 8000));
        const hasTurnstile = !!document.querySelector('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], .cf-turnstile, [name="cf-turnstile-response"]');
        return { challenge: challengeTitle || challengeBody || hasTurnstile, hasTurnstile, title: document.title, url: location.href };
      });
    } catch (e) {
      return { challenge: false, error: e.message };
    }
  }

  async tryClickTurnstile(page) {
    page = page || this.page;
    if (!page) return false;
    try {
      const frames = page.frames();
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const fu = f.url() || '';
        if (!/challenges\.cloudflare|turnstile/i.test(fu)) continue;
        try {
          const box = await f.locator('input[type="checkbox"], #challenge-stage, .cb-lb, body').first().boundingBox({ timeout: 2000 }).catch(() => null);
          if (box) {
            const x = box.x + box.width * 0.35;
            const y = box.y + box.height * 0.5;
            await page.mouse.move(x - 40, y - 20, { steps: 8 });
            await page.waitForTimeout(120 + Math.floor(Math.random() * 180));
            await page.mouse.move(x, y, { steps: 12 });
            await page.waitForTimeout(80 + Math.floor(Math.random() * 120));
            await page.mouse.click(x, y, { delay: 40 + Math.floor(Math.random() * 60) });
            this.log.info('Turnstile click attempted in frame');
            return true;
          }
        } catch (_) {}
      }
      const handle = await page.$('.cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare"]');
      if (handle) {
        const box = await handle.boundingBox();
        if (box) {
          const x = box.x + Math.min(30, box.width * 0.25);
          const y = box.y + box.height / 2;
          await page.mouse.move(x, y, { steps: 10 });
          await page.waitForTimeout(100);
          await page.mouse.click(x, y, { delay: 50 });
          this.log.info('Turnstile click attempted on container');
          return true;
        }
      }
    } catch (e) {
      this.log.warn('tryClickTurnstile: ' + e.message);
    }
    return false;
  }

  async waitOutCloudflare(page, opts) {
    opts = opts || {};
    const timeout = opts.timeout || 45000;
    const autoClick = opts.autoClick !== false;
    page = page || this.page;
    const start = Date.now();
    let clicked = false;
    while (Date.now() - start < timeout) {
      const info = await this.detectCloudflareChallenge(page);
      if (!info.challenge) {
        this.log.info('Cloudflare challenge cleared');
        return { ok: true, cleared: true };
      }
      if (autoClick && !clicked) clicked = await this.tryClickTurnstile(page);
      await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
    }
    return { ok: false, cleared: false, message: 'Cloudflare challenge still present after timeout' };
  }

  async importCookies(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error('cookies must be a non-empty array');
    }
    await this.ensureBrowser();
    const normalized = cookies.map(function (raw) {
      const c = Object.assign({}, raw);
      if (!c.path) c.path = '/';
      if (c.expirationDate && !c.expires) c.expires = Math.floor(c.expirationDate);
      if (c.sameSite === 'no_restriction' || c.sameSite === 'None') c.sameSite = 'None';
      if (c.sameSite === 'lax' || c.sameSite === 'Lax') c.sameSite = 'Lax';
      if (c.sameSite === 'strict' || c.sameSite === 'Strict') c.sameSite = 'Strict';
      delete c.expirationDate;
      delete c.storeId;
      delete c.hostOnly;
      delete c.session;
      delete c.id;
      return c;
    }).filter(function (c) {
      return c.name && c.value != null && c.domain;
    });
    if (normalized.length === 0) throw new Error('No valid cookies after normalization');
    await this.context.addCookies(normalized);
    this.log.info('Imported ' + normalized.length + ' cookies');
    return { count: normalized.length };
  }
}

let instance = null;
function getBrowserManager(logger) {
  if (!instance) instance = new BrowserManager(logger);
  return instance;
}
module.exports = { BrowserManager, getBrowserManager };
