'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

const WORKER_PROMPT = `You are an ERMI Worker Agent.

Start at the ERMI Intelligence Briefing — Control Center:
https://app.notion.com/p/3e2d004d2b9e81b5b81dd2cda88a2e21

Follow 01 — AI Playground Rules as the only active execution contract. Read Control Center → 01 → 10 Current State → 11 Task Queue. Open one deeper page/Skill only when the selected work needs it.

HARD WORKER OUTPUT RULE: the 10-outcome target is a continuation floor, not a suggestion. Never stop merely because one selected task finished. After every material result: verify it, run the Continuation Pass, reassess 11, select the strongest remaining feasible work, execute, verify, and repeat. Task creation, database edits, research notes, or candidate generation do not count unless they directly and verifiably improve the system/user result.

RUN TARGET: reach 10 distinct material outcome units. This is real work, not ten task cards. Never fake-split work and never sacrifice verification, safety, or scope control for the count.

CONTINUATION: after each completed objective, recheck the same project for remaining pieces, same-scope follow-through, verification gaps, missed notifications, and strong second-order improvements. Reassess 11.

DEMAND FALLBACK: when executable queue work is exhausted, inspect up to 7 relevant active D2 demands. Generate up to 3 candidate delivery paths internally, choose the strongest, and execute it. Deliver directly when safe; otherwise create a complete finite main-queue task and execute it when feasible; use Telegram when the correct output is a verified user-facing briefing/action request. Do not manufacture demands or tasks. Repeat with the next strongest demand set while valuable work remains.

DEMAND EXHAUSTION: when relevant demands are all delivered, blocked, dormant, or stale, inspect a completed build/project for a strong second-order improvement and execute it. Then continue the target.

STRICT STOP RULE: 10 outcomes is the normal stop threshold. A sub-10 stop is allowed only after checking the remaining queue/project path and fallback sources and proving the remainder is genuinely blocked, approval-gated, oversized, or no longer valuable. “Nothing in the queue,” “nothing obvious,” or “next run” alone is not a valid stop reason.

STOP RECEIPT: every run must state OUTCOMES COMPLETED = N | REMAINING FEASIBLE = yes/no | STOP REASON = … with concrete evidence.

When finished, report clearly what was completed, verified, and what remains.`;

const DISCOVERY_PROMPT = `You are an ERMI Discovery Agent.

Start at the ERMI Intelligence Briefing — Control Center:
https://app.notion.com/p/3e2d004d2b9e81b5b81dd2cda88a2e21

Primary objective this cycle: keep the D2 Demand Reservoir strong and convert the strongest demand work into verified material outcomes.

HARD RULES: do not invent demands. Prefer real signals from Telegram, existing pages, and prior work. Every newly discovered material signal, actionable Telegram reply, and required reservoir replenishment must be delivered, routed, persisted as a real demand, or explicitly dispositioned before the cycle closes.

Success = 50 alive qualified D2 demands when evidence supports them + 10 material demand outcomes when feasible + verified user value + all mandatory end gates completed.`;

const PROMPTS = {
  worker: { id: 'worker', label: 'Worker', body: WORKER_PROMPT },
  discovery: { id: 'discovery', label: 'Discovery', body: DISCOVERY_PROMPT },
};

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  ownerToken: process.env.OWNER_TOKEN || '',
  profilePath: path.resolve(process.env.PROFILE_PATH || path.join(ROOT, 'profiles', 'chatgpt')),
  dataPath: path.resolve(process.env.DATA_PATH || path.join(ROOT, 'data')),
  logsPath: path.join(ROOT, 'logs'),
  headless: process.env.HEADLESS !== 'false',
  appBaseUrl: process.env.APP_BASE_URL || ('http://localhost:' + (process.env.PORT || 3000)),
  maxConcurrentRuns: 1,
  chatgptUrl: 'https://chatgpt.com/',
  chatgptNewChatUrl: 'https://chatgpt.com/',
  // Optional residential proxy for Cloudflare (e.g. http://user:pass@host:port or socks5://...)
  proxyServer: process.env.PROXY_SERVER || process.env.HTTPS_PROXY || '',
};

for (const dir of [config.profilePath, config.dataPath, config.logsPath]) {
  fs.mkdirSync(dir, { recursive: true });
}

config.setupFlagPath = path.join(config.dataPath, 'setup-complete.json');
config.runStatePath = path.join(config.dataPath, 'last-run.json');
config.runCounterPath = path.join(config.dataPath, 'run-counter.json');
config.runtimeProxyPath = path.join(config.dataPath, 'runtime-proxy.json');
config.runEverySeconds = parseInt(process.env.RUN_EVERY_SECONDS || '0', 10) || 0;

function isSetupComplete() {
  try {
    if (!fs.existsSync(config.setupFlagPath)) return false;
    const data = JSON.parse(fs.readFileSync(config.setupFlagPath, 'utf8'));
    return !!data.complete;
  } catch (e) {
    return false;
  }
}

function markSetupComplete() {
  fs.mkdirSync(config.dataPath, { recursive: true });
  fs.writeFileSync(
    config.setupFlagPath,
    JSON.stringify({ complete: true, at: new Date().toISOString() }, null, 2)
  );
}

function clearSetupComplete() {
  try {
    if (fs.existsSync(config.setupFlagPath)) fs.unlinkSync(config.setupFlagPath);
  } catch (e) {}
}

function loadRunState() {
  try {
    if (!fs.existsSync(config.runStatePath)) return null;
    return JSON.parse(fs.readFileSync(config.runStatePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveRunState(state) {
  fs.mkdirSync(config.dataPath, { recursive: true });
  fs.writeFileSync(config.runStatePath, JSON.stringify(state, null, 2));
}

function clearRunState() {
  try {
    if (fs.existsSync(config.runStatePath)) fs.unlinkSync(config.runStatePath);
  } catch (e) {}
}

function getRunCounter() {
  try {
    if (!fs.existsSync(config.runCounterPath)) return 0;
    const data = JSON.parse(fs.readFileSync(config.runCounterPath, 'utf8'));
    return parseInt(data.count || 0, 10) || 0;
  } catch (e) {
    return 0;
  }
}

function incrementRunCounter() {
  const next = getRunCounter() + 1;
  fs.mkdirSync(config.dataPath, { recursive: true });
  fs.writeFileSync(
    config.runCounterPath,
    JSON.stringify({ count: next, updatedAt: new Date().toISOString() }, null, 2)
  );
  return next;
}

function selectPromptForCounter(n) {
  // Odd runs: worker; even runs: discovery
  return n % 2 === 0 ? PROMPTS.discovery : PROMPTS.worker;
}

function resolvePrompt(explicitId) {
  if (explicitId && PROMPTS[explicitId]) return PROMPTS[explicitId];
  const nextCount = getRunCounter() + 1;
  return selectPromptForCounter(nextCount);
}

function getProxyServer() {
  try {
    if (fs.existsSync(config.runtimeProxyPath)) {
      const data = JSON.parse(fs.readFileSync(config.runtimeProxyPath, 'utf8'));
      if (data && data.server && String(data.server).trim()) {
        return String(data.server).trim();
      }
    }
  } catch (e) {}
  return config.proxyServer || '';
}

function setRuntimeProxy(server) {
  const value = String(server || '').trim();
  fs.mkdirSync(config.dataPath, { recursive: true });
  if (!value) {
    try {
      if (fs.existsSync(config.runtimeProxyPath)) fs.unlinkSync(config.runtimeProxyPath);
    } catch (e) {}
    return { server: '', cleared: true };
  }
  const payload = { server: value, updatedAt: new Date().toISOString() };
  fs.writeFileSync(config.runtimeProxyPath, JSON.stringify(payload, null, 2));
  return payload;
}

function getRuntimeProxyInfo() {
  try {
    if (fs.existsSync(config.runtimeProxyPath)) {
      return JSON.parse(fs.readFileSync(config.runtimeProxyPath, 'utf8'));
    }
  } catch (e) {}
  return { server: config.proxyServer || '', updatedAt: null, source: config.proxyServer ? 'env' : 'none' };
}

module.exports = {
  config,
  PROMPTS,
  isSetupComplete,
  markSetupComplete,
  clearSetupComplete,
  loadRunState,
  saveRunState,
  clearRunState,
  getRunCounter,
  incrementRunCounter,
  selectPromptForCounter,
  resolvePrompt,
  getProxyServer,
  setRuntimeProxy,
  getRuntimeProxyInfo,
};
