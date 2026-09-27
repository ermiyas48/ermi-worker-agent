'use strict';
const { config, isSetupComplete, markSetupComplete } = require('./config');
const { getBrowserManager } = require('./browser-manager');
const { ChatGPTAdapter } = require('./chatgpt-adapter');

function mapSameSite(v) {
  if (!v) return 'Lax';
  const s = String(v).toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'None';
  if (s === 'strict') return 'Strict';
  return 'Lax';
}

function toPlaywrightCookies(raw) {
  const out = [];
  for (const c of raw || []) {
    if (!c || !c.name || c.value === undefined || c.value === null) continue;
    const cookie = {
      name: c.name,
      value: String(c.value),
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: typeof c.secure === 'boolean' ? c.secure : true,
      sameSite: mapSameSite(c.sameSite),
    };
    if (c.domain) cookie.domain = c.domain;
    else cookie.url = 'https://chatgpt.com/';
    if (c.expirationDate && !c.session) {
      cookie.expires = Math.floor(Number(c.expirationDate));
    }
    out.push(cookie);
  }
  return out;
}

class SetupController {
  constructor(logger) {
    this.log = logger || console;
    this.bm = getBrowserManager(this.log);
    this.setupInProgress = false;
    this.lastAuthCheck = null;
    this.lastPageInfo = null;
  }

  getStatus() {
    return {
      setupComplete: isSetupComplete(),
      setupInProgress: this.setupInProgress,
      lastAuthCheck: this.lastAuthCheck,
      lastPageInfo: this.lastPageInfo,
      profilePath: config.profilePath,
    };
  }

  async _pageInfo(page) {
    let title = '', url = '', bodyText = '';
    try { url = page.url(); } catch {}
    try { title = await page.title(); } catch {}
    try {
      bodyText = await page.evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 800));
    } catch {}
    const info = {
      at: new Date().toISOString(),
      url,
      title,
      bodyPreview: bodyText.replace(/\s+/g, ' ').trim().slice(0, 400),
    };
    this.lastPageInfo = info;
    return info;
  }

  async startSetupBrowser() {
    if (isSetupComplete()) {
      return { ok: false, error: 'Setup already complete.' };
    }
    this.setupInProgress = true;
    try {
      const { page } = await this.bm.launchForSetup();
      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);
      const info = await this._pageInfo(page);
      return {
        ok: true,
        message: 'Browser started. Prefer POST /setup/cookies with exported ChatGPT cookies.',
        page: info,
      };
    } catch (e) {
      this.setupInProgress = false;
      return { ok: false, error: e.message };
    }
  }

  async importCookies(rawCookies) {
    if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
      return { ok: false, error: 'Body must be a non-empty JSON array of cookies' };
    }
    const pwCookies = toPlaywrightCookies(rawCookies);
    if (pwCookies.length === 0) {
      return { ok: false, error: 'No valid cookies after mapping' };
    }
    this.setupInProgress = true;
    try {
      const { context, page } = await this.bm.ensureBrowser({ headless: true });
      try { await context.clearCookies(); } catch (e) { this.log.warn('clearCookies: ' + e.message); }
      const normalized = pwCookies.map((c) => {
        const out = { ...c };
        if (out.sameSite === 'None' && !out.secure) out.secure = true;
        return out;
      });
      let applied = 0;
      const errors = [];
      try {
        await context.addCookies(normalized);
        applied = normalized.length;
      } catch (e) {
        this.log.warn('bulk addCookies failed, trying one-by-one: ' + e.message);
        for (const c of normalized) {
          try { await context.addCookies([c]); applied++; }
          catch (e2) { errors.push(c.name + ': ' + e2.message); }
        }
      }
      this.log.info('Imported ' + applied + '/' + normalized.length + ' cookies');

      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(2000);
        const t = await page.title().catch(() => '');
        if (!/just a moment|attention required|cloudflare/i.test(t)) break;
      }
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2000);

      const info = await this._pageInfo(page);
      const adapter = new ChatGPTAdapter(page, this.log);
      const pageState = await adapter.detectPageState();
      const authed = await adapter.isAuthenticated();
      this.lastAuthCheck = { at: new Date().toISOString(), authenticated: authed, pageState };

      if (authed) {
        markSetupComplete();
        this.setupInProgress = false;
        return { ok: true, authenticated: true, setupComplete: true, message: 'Cookies imported and session authenticated. Setup complete.', cookiesApplied: applied, page: info, pageState };
      }

      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const info2 = await this._pageInfo(page);
      const pageState2 = await adapter.detectPageState();
      const authed2 = await adapter.isAuthenticated();
      this.lastAuthCheck = { at: new Date().toISOString(), authenticated: authed2, pageState: pageState2 };
      if (authed2) {
        markSetupComplete();
        this.setupInProgress = false;
        return { ok: true, authenticated: true, setupComplete: true, message: 'Cookies imported (second check). Setup complete.', cookiesApplied: applied, page: info2, pageState: pageState2 };
      }

      let hint = 'Cookies applied but session not recognized as logged-in.';
      if (/just a moment|cloudflare|attention required/i.test((info2.title || '') + (info2.bodyPreview || ''))) {
        hint = 'Cookies applied but Cloudflare challenge still present. Keep Termux ACTIVE; headless Chrome is often challenged even on residential IP.';
      }
      this.setupInProgress = false;
      return { ok: false, authenticated: false, setupComplete: false, message: hint, cookiesApplied: applied, cookieErrors: errors.slice(0, 10), page: info2, lastAuthCheck: this.lastAuthCheck };
    } catch (e) {
      this.setupInProgress = false;
      return { ok: false, error: e.message };
    }
  }

  async detectAuthentication() {
    if (isSetupComplete()) return { authenticated: true, setupComplete: true };
    try {
      const page = await this.bm.getPage();
      const adapter = new ChatGPTAdapter(page, this.log);
      if (!page.url().includes('chatgpt.com') && !page.url().includes('openai.com')) {
        await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);
      }
      const info = await this._pageInfo(page);
      const pageState = await adapter.detectPageState();
      const authed = await adapter.isAuthenticated();
      this.lastAuthCheck = { at: new Date().toISOString(), authenticated: authed, pageState };
      if (authed) {
        markSetupComplete();
        this.setupInProgress = false;
        return { authenticated: true, setupComplete: true, message: 'Authenticated.', page: info, pageState };
      }
      let hint = 'Not authenticated yet.';
      const { getProxyServer } = require('./config');
      const px = getProxyServer();
      if (/cloudflare|just a moment|attention required/i.test(info.title + ' ' + (info.bodyPreview || ''))) {
        hint = px
          ? 'Cloudflare challenge (headless). Residential proxy active. Import fresh cookies via /setup.'
          : 'Cloudflare challenge and no valid proxy. Ensure Termux is ACTIVE, then import cookies.';
      }
      return { authenticated: false, setupComplete: false, message: hint, page: info, pageState };
    } catch (e) {
      return { authenticated: false, error: e.message };
    }
  }

  async takeScreenshot() {
    const page = await this.bm.getPage();
    if (!page.url().includes('chatgpt') && !page.url().includes('openai')) {
      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
    }
    const info = await this._pageInfo(page);
    const buffer = await page.screenshot({ fullPage: false, type: 'png' });
    return { buffer, info };
  }

  getSetupPageHtml() {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ERMI Setup</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;background:#fafafa}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:1.25rem;margin:1rem 0}
.status{padding:.75rem 1rem;border-radius:8px;font-weight:600}
.ok{background:#ecfdf5;color:#065f46}.wait{background:#fffbeb;color:#92400e}.err{background:#fef2f2;color:#991b1b}
button{background:#111;color:#fff;border:0;border-radius:8px;padding:.65rem 1.1rem;cursor:pointer;margin:.25rem}
button.secondary{background:#fff;color:#111;border:1px solid #ccc}
textarea{width:100%;min-height:120px;font-family:monospace;font-size:.75rem}
pre{white-space:pre-wrap;font-size:.8rem;background:#f4f4f5;padding:.75rem;border-radius:8px}
img{max-width:100%;border:1px solid #ddd;border-radius:8px;margin-top:.5rem}
</style></head><body>
<h1>ERMI Setup</h1>
<p>Export cookies from a logged-in ChatGPT browser and paste below. Keep Termux ACTIVE.</p>
<div class="card">
<div id="status" class="status wait">Checking…</div>
<div id="detail"></div>
<textarea id="cookies" placeholder='Paste cookie JSON array here'></textarea>
<div>
<button id="btnImport">Import Cookies</button>
<button id="btnCheck" class="secondary">Check Auth</button>
<button id="btnShot" class="secondary">Screenshot</button>
</div>
<img id="shot" style="display:none"/>
<pre id="pageinfo"></pre>
</div>
<script>
const token=new URLSearchParams(location.search).get('token')||localStorage.getItem('ownerToken')||'';
if(token)localStorage.setItem('ownerToken',token);
const headers=()=>({Authorization:'Bearer '+token,'Content-Type':'application/json'});
async function refresh(){
  const r=await fetch('/setup/status?detect=1',{headers:headers()});
  const j=await r.json();
  const el=document.getElementById('status');
  if(j.setupComplete||j.authenticated){el.className='status ok';el.textContent='Setup complete';}
  else if(j.error){el.className='status err';el.textContent='Error';}
  else{el.className='status wait';el.textContent='Not authenticated';}
  document.getElementById('detail').textContent=j.message||j.error||'';
  document.getElementById('pageinfo').textContent=JSON.stringify({page:j.page,pageState:j.pageState},null,2);
}
document.getElementById('btnImport').onclick=async()=>{
  let body;
  try{body=JSON.parse(document.getElementById('cookies').value);}catch(e){alert('Invalid JSON');return;}
  document.getElementById('detail').textContent='Importing…';
  const r=await fetch('/setup/cookies',{method:'POST',headers:headers(),body:JSON.stringify(body)});
  const j=await r.json();
  document.getElementById('detail').textContent=j.message||j.error||JSON.stringify(j);
  refresh();
};
document.getElementById('btnCheck').onclick=()=>refresh();
document.getElementById('btnShot').onclick=()=>{
  const img=document.getElementById('shot');img.style.display='block';
  img.src='/setup/screenshot?token='+encodeURIComponent(token)+'&t='+Date.now();
};
refresh();
</script></body></html>`;
  }
}

let setupCtrl = null;
function getSetupController(logger) {
  if (!setupCtrl) setupCtrl = new SetupController(logger);
  return setupCtrl;
}
module.exports = { SetupController, getSetupController };
