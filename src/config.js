'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config();

function loadPrompt(name, fallback) {
  try {
    const p = path.join(__dirname, '..', 'prompts', name + '.txt');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {}
  return fallback || '';
}

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
  workerPrompt: loadPrompt('worker', 'You are an ERMI Worker Agent.'),
  discoveryPrompt: loadPrompt('discovery', 'Run one ERMI Discovery & Direction cycle.'),
  promptSequence: ['worker', 'worker', 'worker', 'discovery'],
  autoRunIntervalMs: parseInt(process.env.AUTO_RUN_INTERVAL_MS || '240000', 10),
  autoRunEnabled: process.env.AUTO_RUN_ENABLED !== 'false',
};
config.ermiPrompt = config.workerPrompt;

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
  try {
    const p = path.join(config.dataPath, 'run-state.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return null;
}
function saveRunState(state) {
  fs.writeFileSync(path.join(config.dataPath, 'run-state.json'), JSON.stringify(state, null, 2));
}
function clearRunState() {
  try { fs.unlinkSync(path.join(config.dataPath, 'run-state.json')); } catch {}
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
  const state = { server: server.trim(), valid: true, updatedAt: new Date().toISOString(), source: source || 'runtime' };
  saveProxyState(state);
  return { ok: true, valid: true, server: state.server, updatedAt: state.updatedAt };
}
function clearProxyServer() {
  saveProxyState({ server: null, valid: false, updatedAt: new Date().toISOString(), source: 'cleared' });
  return { ok: true, valid: false, server: null };
}

let sequenceIndex = 0;
function getNextPrompt() {
  const seq = config.promptSequence || ['worker'];
  const kind = seq[sequenceIndex % seq.length] || 'worker';
  sequenceIndex = (sequenceIndex + 1) % Math.max(seq.length, 1);
  const text = kind === 'discovery' ? (config.discoveryPrompt || config.ermiPrompt) : (config.workerPrompt || config.ermiPrompt);
  return { kind, text, index: sequenceIndex };
}
function peekPromptKind() {
  const seq = config.promptSequence || ['worker'];
  return seq[sequenceIndex % seq.length] || 'worker';
}

module.exports = {
  config, isSetupComplete, markSetupComplete, loadRunState, saveRunState, clearRunState, getNextPrompt, peekPromptKind,
  isValidProxyServer, loadProxyState, saveProxyState, getProxyServer, setProxyServer, clearProxyServer,
};
