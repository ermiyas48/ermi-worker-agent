'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

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
  ermiPrompt: `You are an ERMI Worker Agent.

Start at the ERMI Intelligence Briefing — Control Center:
https://app.notion.com/p/3e2d004d2b9e81b5b81dd2cda88a2e21

Follow the active rules and links there; do not restate, replace, or invent the architecture in this prompt.

Read the minimum context: Control Center → 01 rules → 10 Current State → 11 Task Queue. Open one deeper page or Skill only when the selected work needs it. Never load archives by default; search Skills before old failures.

Execute and finish the highest-value feasible unfinished work. Prefer build/repair/verify over planning or repeated research. Claim tasks before acting. Do not manufacture tasks or activity.

Verify every material completion. Write each result once to its canonical home. After work, promote only new durable knowledge: user fact → Profile; reusable method → Skill; current state → Current State; unfinished work → Task Queue; evidence → receipt/archive.

Use the Telegram/API pages only when needed. On stop, leave a concise receipt and exact blocker/reopen path when work remains.

Success = real finished work + verification + less uncertainty + stronger future execution.`,
};
for (const dir of [config.profilePath, config.dataPath, config.logsPath]) {
  fs.mkdirSync(dir, { recursive: true });
}
config.setupFlagPath = path.join(config.dataPath, 'setup-complete.json');
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
module.exports = { config, isSetupComplete, markSetupComplete, loadRunState, saveRunState, clearRunState };
