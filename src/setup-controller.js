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
    let title = '';
    let url = '';
    let bodyText = '';
    try { url = page.url(); } catch {}
    try { title = await page.title(); } catch {}
    try {
      bodyText = await page.evaluate(() => {
        const t = (document.body && document.body.innerText) || '';
        return t.slice(0, 800);
      });
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
      return { ok: false, error: 'Setup already complete. Re-authentication requires manual profile reset.' };
    }
    this.setupInProgress = true;
    try {
      const { page } = await this.bm.launchForSetup();
      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      const info = await this._pageInfo(page);
      this.log.info('Setup browser launched url=' + info.url + ' title=' + info.title);
      return {
        ok: true,
        message: 'Browser started on ChatGPT. Open /setup/screenshot to see the page. Sign-in must happen in this server profile (phone login does not count).',
        page: info,
      };
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
        this.log.info('Authentication detected – setup complete');
        return {
          authenticated: true,
          setupComplete: true,
          message: 'Authentication successful. Profile saved.',
          page: info,
          pageState,
        };
      }

      let hint = 'Not authenticated yet.';
      if (/cloudflare|just a moment|attention required|challenge/i.test(info.title + ' ' + info.bodyPreview)) {
        hint = 'Cloudflare challenge detected. Datacenter IPs (Railway) are often blocked by ChatGPT. A residential proxy or cookie import may be required.';
      } else if (/log\s*in|sign\s*in|sign\s*up/i.test(info.bodyPreview) || pageState === 'AUTH_PAGE') {
        hint = 'Login page is showing, but this server is headless — there is no screen to type into. Use cookie import or a visible remote browser to complete sign-in.';
      }

      return {
        authenticated: false,
        setupComplete: false,
        message: hint,
        page: info,
        pageState,
      };
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
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ERMI Setup</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;background:#fafafa;color:#111}
.card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:1.25rem;margin:1rem 0}
.status{padding:.75rem 1rem;border-radius:8px;font-weight:600}
.ok{background:#ecfdf5;color:#065f46}.wait{background:#fffbeb;color:#92400e}.err{background:#fef2f2;color:#991b1b}
button{background:#111;color:#fff;border:0;border-radius:8px;padding:.65rem 1.1rem;cursor:pointer;font-size:1rem;margin:.25rem .25rem 0 0}
button.secondary{background:#fff;color:#111;border:1px solid #ccc}
.note{font-size:.85rem;color:#666;margin-top:1rem}
img{max-width:100%;border:1px solid #ddd;border-radius:8px;margin-top:.75rem}
pre{white-space:pre-wrap;font-size:.8rem;background:#f4f4f5;padding:.75rem;border-radius:8px;overflow:auto}
</style></head><body>
<h1>ERMI Worker – Setup</h1>
<p><strong>Important:</strong> Login must happen in the <em>server</em> Chromium profile. Phone login does not count. This Railway browser is headless (no keyboard screen).</p>
<div class="card"><div id="status" class="status wait">Checking…</div>
<div id="detail" style="margin-top:.75rem;font-size:.95rem"></div>
<div style="margin-top:1rem">
<button id="btnStart">Start Browser</button>
<button id="btnCheck" class="secondary">Check Auth</button>
<button id="btnShot" class="secondary">Refresh Screenshot</button>
</div>
<img id="shot" alt="screenshot will appear here" style="display:none"/>
<pre id="pageinfo"></pre>
</div>
<div class="card"><strong>Why sign-in fails</strong>
<ol>
<li>Server is headless — you cannot type email/password into a page you cannot see.</li>
<li>ChatGPT often shows Cloudflare challenges to datacenter IPs (Railway).</li>
<li>Phone login only authenticates your phone, not this server profile.</li>
</ol>
<p class="note">After a successful auth in this profile, setupComplete becomes true and /run works.</p>
</div>
<script>
const token=new URLSearchParams(location.search).get('token')||localStorage.getItem('ownerToken')||'';
if(token)localStorage.setItem('ownerToken',token);
const headers=token?{'Authorization':'Bearer '+token,'Content-Type':'application/json'}:{'Content-Type':'application/json'};
async function refresh(){
  try{
    const r=await fetch('/setup/status?detect=1',{headers});
    const j=await r.json();
    const el=document.getElementById('status');
    const d=document.getElementById('detail');
    if(j.setupComplete||j.authenticated){el.className='status ok';el.textContent='Authenticated / setup complete';}
    else if(j.error){el.className='status err';el.textContent='Error';}
    else{el.className='status wait';el.textContent='Not signed in on server profile';}
    d.textContent=j.message||j.error||'';
    document.getElementById('pageinfo').textContent=JSON.stringify({page:j.page,pageState:j.pageState,lastAuthCheck:j.lastAuthCheck},null,2);
  }catch(e){document.getElementById('status').className='status err';document.getElementById('status').textContent=e.message;}
}
async function shot(){
  const img=document.getElementById('shot');
  img.style.display='block';
  img.src='/setup/screenshot?token='+encodeURIComponent(token)+'&t='+Date.now();
}
document.getElementById('btnStart').onclick=async()=>{
  const r=await fetch('/setup/browser',{method:'POST',headers});
  const j=await r.json();
  document.getElementById('detail').textContent=j.message||j.error||JSON.stringify(j);
  refresh(); shot();
};
document.getElementById('btnCheck').onclick=()=>refresh();
document.getElementById('btnShot').onclick=()=>shot();
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
