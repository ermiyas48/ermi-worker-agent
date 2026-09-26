'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  ownerToken: process.env.OWNER_TOKEN || '',
  profilePath: process.env.PROFILE_PATH || '/data/profiles/chatgpt',
  dataPath: process.env.DATA_PATH || '/data/state',
  logsPath: process.env.LOGS_PATH || '/data/logs',
  headless: process.env.HEADLESS !== 'false',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,
  maxConcurrentRuns: 1,
  chatgptUrl: 'https://chatgpt.com/',
  chatgptNewChatUrl: 'https://chatgpt.com/',
  ermiPrompt: `You are an ERMI Worker Agent.\n\nStart at the ERMI Intelligence Briefing — Control Center:\nhttps://app.notion.com/p/3e2d004d2b9e81b5b81dd2cda88a2e21\n\nFollow the active rules and links there; do not restate, replace, or invent the architecture in this prompt.\n\nRead the minimum context: Control Center → 01 rules → 10 Current State → 11 Task Queue. Open one deeper page or Skill only when the selected work needs it. Never load archives by default; search Skills before old failures.\n\nExecute and finish the highest-value feasible unfinished work. Prefer build/repair/verify over planning or repeated research. Claim tasks before acting. Do not manufacture tasks or activity.\n\nVerify every material completion. Write each result once to its canonical home. After work, promote only new durable knowledge: user fact → Profile; reusable method → Skill; current state → Current State; unfinished work → Task Queue; evidence → receipt/archive.\n\nUse the Telegram/API pages only when needed. On stop, leave a concise receipt and exact blocker/reopen path when work remains.\n\nSuccess = real finished work + verification + less uncertainty + stronger future execution.`,
};
for (const dir of [config.profilePath, config.dataPath, config.logsPath]) {
  fs.mkdirSync(dir, { recursive: true });
}
config.setupFlagPath = path.join(config.dataPath, 'setup-complete.json');
config.proxyStatePath = path.join(config.dataPath, 'proxy-state.json');

function isSetupComplete() {
  try {
    if (!fs.existsSync(config.setupFlagPath)) return false;
    const data = JSON.parse(fs.readFileSync(config.setupFlagPath, 'utf8'));
    return data.setupComplete === true;
  } catch { return false; }
}
function markSetupComplete() {
  fs.writeFileSync(config.setupFlagPath, JSON.stringify({ setupComplete: true, completedAt: new Date().toISOString() }, null, 2));
}
function loadRunState() {
  const p = path.join(config.dataPath, 'current-run.json');
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  return null;
}
function saveRunState(state) {
  fs.writeFileSync(path.join(config.dataPath, 'current-run.json'), JSON.stringify(state, null, 2));
}
function clearRunState() {
  const p = path.join(config.dataPath, 'current-run.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function isValidProxyServer(server) {
  if (!server || typeof server !== 'string') return false;
  const s = server.trim();
  const m = s.match(/^(socks5h?):\/\/([A-Za-z0-9._-]+):(\d{2,5})$/i);
  if (!m) return false;
  const host = m[2].toLowerCase();
  const port = parseInt(m[3], 10);
  if (port < 1 || port > 65535) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
  if (host === 'free.pinggy.io' || host.startsWith('example.') || host.includes('YOUR-')) return false;
  return true;
}

function loadProxyState() {
  try {
    if (fs.existsSync(config.proxyStatePath)) return JSON.parse(fs.readFileSync(config.proxyStatePath, 'utf8'));
  } catch {}
  return { server: null, valid: false, updatedAt: null, source: null };
}

function saveProxyState(state) {
  fs.writeFileSync(config.proxyStatePath, JSON.stringify(state, null, 2));
}

function getProxyServer() {
  const st = loadProxyState();
  if (st && st.valid && isValidProxyServer(st.server)) return st.server;
  return null;
}

function setProxyServer(server, source) {
  if (!isValidProxyServer(server)) {
    return { ok: false, valid: false, error: 'Invalid proxy server format. Expected socks5://HOST:PORT' };
  }
  const state = {
    server: server.trim(),
    valid: true,
    updatedAt: new Date().toISOString(),
    source: source || 'runtime',
  };
  saveProxyState(state);
  return { ok: true, valid: true, server: state.server, updatedAt: state.updatedAt };
}

function clearProxyServer() {
  saveProxyState({ server: null, valid: false, updatedAt: new Date().toISOString(), source: 'cleared' });
  return { ok: true, valid: false, server: null };
}

module.exports = {
  config, isSetupComplete, markSetupComplete, loadRunState, saveRunState, clearRunState,
  isValidProxyServer, loadProxyState, saveProxyState, getProxyServer, setProxyServer, clearProxyServer,
};
