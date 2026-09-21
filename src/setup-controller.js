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
  }
  getStatus() {
    return {
      setupComplete: isSetupComplete(),
      setupInProgress: this.setupInProgress,
      lastAuthCheck: this.lastAuthCheck,
      profilePath: config.profilePath,
    };
  }
  async startSetupBrowser() {
    if (isSetupComplete()) {
      return { ok: false, error: 'Setup already complete. Re-authentication requires manual profile reset.' };
    }
    this.setupInProgress = true;
    try {
      const result = await this.bm.launchForSetup();
      const page = result.page;
      await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      this.log.info('Setup browser launched');
      return { ok: true, message: 'Browser started. Sign in to ChatGPT in the remote view, then poll /setup/status or call detect.' };
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
      if (!page.url().includes('chatgpt.com')) {
        await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      const authed = await adapter.isAuthenticated();
      this.lastAuthCheck = { at: new Date().toISOString(), authenticated: authed };
      if (authed) {
        markSetupComplete();
        this.setupInProgress = false;
        this.log.info('Authentication detected – setup complete');
        return { authenticated: true, setupComplete: true, message: 'Authentication successful. Profile saved. Setup route will be disabled.' };
      }
      return { authenticated: false, setupComplete: false, message: 'Not yet authenticated. Please complete ChatGPT sign-in (including MFA if prompted).' };
    } catch (e) {
      return { authenticated: false, error: e.message };
    }
  }
  getSetupPageHtml() {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>ERMI Setup</title><style>*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f8f9fa;color:#111;margin:0;padding:2rem;max-width:720px;margin-inline:auto}h1{font-size:1.4rem}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1.5rem;margin-top:1rem}.status{font-weight:600;padding:.5rem .75rem;border-radius:8px;display:inline-block}.status.ok{background:#d1fae5;color:#065f46}.status.wait{background:#fef3c7;color:#92400e}.status.err{background:#fee2e2;color:#991b1b}button{background:#111;color:#fff;border:none;padding:.7rem 1.2rem;border-radius:8px;font-size:1rem;cursor:pointer;margin-right:.5rem;margin-top:.75rem}button.secondary{background:#fff;color:#111;border:1px solid #d1d5db}.note{font-size:.9rem;color:#6b7280;margin-top:1rem}</style></head><body><h1>ERMI Worker – First-time ChatGPT Setup</h1><p>Server-side Chromium with persistent profile. Sign in manually. Credentials are never requested by this app.</p><div class="card"><div id="status" class="status wait">Checking…</div><div id="detail" style="margin-top:.75rem;font-size:.95rem"></div><div style="margin-top:1rem"><button id="btnStart">Start Browser</button><button id="btnCheck" class="secondary">Check Authentication</button></div></div><div class="card"><strong>Steps</strong><ol><li>Click Start Browser.</li><li>Complete ChatGPT login (incl. MFA) in the server Chromium.</li><li>Click Check Authentication.</li><li>Profile is saved; setup route disabled.</li></ol><p class="note">Never share the owner token.</p></div><script>const token=new URLSearchParams(location.search).get("token")||localStorage.getItem("ownerToken")||"";if(token)localStorage.setItem("ownerToken",token);const headers=token?{"Authorization":"Bearer "+token,"Content-Type":"application/json"}:{"Content-Type":"application/json"};async function refresh(){try{const r=await fetch("/setup/status",{headers});const j=await r.json();const el=document.getElementById("status");const d=document.getElementById("detail");if(j.setupComplete){el.className="status ok";el.textContent="Setup complete";d.textContent="Profile preserved.";}else if(j.authenticated){el.className="status ok";el.textContent="Authenticated";d.textContent=j.message||"";}else{el.className="status wait";el.textContent="Waiting for sign-in";d.textContent=j.message||"";}}catch(e){document.getElementById("status").className="status err";document.getElementById("status").textContent="Error";document.getElementById("detail").textContent=e.message;}}document.getElementById("btnStart").onclick=async()=>{const r=await fetch("/setup/browser",{method:"POST",headers});const j=await r.json();document.getElementById("detail").textContent=j.message||j.error||JSON.stringify(j);refresh();};document.getElementById("btnCheck").onclick=async()=>{const r=await fetch("/setup/status?detect=1",{headers});const j=await r.json();document.getElementById("detail").textContent=j.message||JSON.stringify(j);refresh();};refresh();setInterval(refresh,5000);</script></body></html>';
  }
}
let setupCtrl = null;
function getSetupController(logger) {
  if (!setupCtrl) setupCtrl = new SetupController(logger);
  return setupCtrl;
}
module.exports = { SetupController, getSetupController };
