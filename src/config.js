\'use strict\';
const path = require(\'path\');
const fs = require(\'fs\');
require(\'dotenv\').config();
const ROOT = path.resolve(__dirname, \'..\');
const config = {
  port: parseInt(process.env.PORT || \'3000\', 10),
  nodeEnv: process.env.NODE_ENV || \'development\',
  ownerToken: process.env.OWNER_TOKEN || \'\',
  profilePath: path.resolve(process.env.PROFILE_PATH || path.join(ROOT, \'profiles\', \'chatgpt\')),
  dataPath: path.resolve(process.env.DATA_PATH || path.join(ROOT, \'data\')),
  logsPath: path.join(ROOT, \'logs\'),
  headless: process.env.HEADLESS !== \'false\',
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  maxConcurrentRuns: 1,
  chatgptUrl: \'https://chatgpt.com/\',
  chatgptNewChatUrl: \'https://chatgpt.com/\',
  ermiPrompt: `You are an ERMI Worker Agent.\n\nStart at the ERMI Intelligence Briefing \u2014 Control Center:\nhttps://app.notion.com/p/3e2d004d2b9e81b5b81dd2cda88a2e21\n\nFollow the active rules and links there; do not restate, replace, or invent the architecture in this prompt.\n\nRead the minimum context: Control Center \u2192 01 rules \u2192 10 Current State \u2192 11 Task Queue. Open one deeper page or Skill only when the selected work needs it. Never load archives by default; search Skills before old failures.\n\nExecute and finish the highest-value feasible unfinished work. Prefer build/repair/verify over planning or repeated research. Claim tasks before acting. Do not manufacture tasks or activity.\n\nVerify every material completion. Write each result once to its canonical home. After work, promote only new durable knowledge: user fact \u2192 Profile; reusable method \u2192 Skill; current state \u2192 Current State; unfinished work \u2192 Task Queue; evidence \u2192 receipt/archive.\n\nUse the Telegram/API pages only when needed. On stop, leave a concise receipt and exact blocker/reopen path when work remains.\n\nSuccess = real finished work + verification + less uncertainty + stronger future execution.`,
};
for (const dir of [config.profilePath, config.dataPath, config.logsPath]) {
  fs.mkdirSync(dir, { recursive: true });
}
config.setupFlagPath = path.join(config.dataPath, \'setup-complete.json\');
function isSetupComplete() {
  try {
    if (!fs.existsSync(config.setupFlagPath)) return false;
    const data = JSON.parse(fs.readFileSync(config.setupFlagPath, \'utf8\'));
    return data.setupComplete === true;
  } catch { return false; }
}
function markSetupComplete() {
  fs.writeFileSync(config.setupFlagPath, JSON.stringify({ setupComplete: true, completedAt: new Date().toISOString() }, null, 2));
}
function loadRunState() {
  const p = path.join(config.dataPath, \'current-run.json\');
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, \'utf8\')); } catch {}
  return null;
}
function saveRunState(state) {
  fs.writeFileSync(path.join(config.dataPath, \'current-run.json\'), JSON.stringify(state, null, 2));
}
function clearRunState() {
  const p = path.join(config.dataPath, \'current-run.json\');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
module.exports = { config, isSetupComplete, markSetupComplete, loadRunState, saveRunState, clearRunState };
