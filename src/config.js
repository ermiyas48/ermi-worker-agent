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

STOP RECEIPT: every run must state OUTCOMES COMPLETED = N | REMAINING FEASIBLE = yes/no | STOP BOUNDARY = exact evidence | FOLLOW-ON = genuinely separate work only. Never claim successful/complete/nothing-left without this evidence.

Claim tasks before acting. Do not duplicate work or create permanent tasks. Verify every material result directly. Write each result once to its canonical home. Put detailed receipts in 90 — ERMI Archive; update 10 only when current truth changes; never append run reports to the Control Center.

Use D2 only in Demand Fallback or when the selected task explicitly points there. Use archives only when the active task/current state/Skill cannot answer a specific missing fact or prior route.

Ask the user only for genuinely user-owned input or safety-critical approval. Otherwise use judgment and act.`;

const DISCOVERY_PROMPT = `Run one ERMI Discovery & Direction cycle.

Start at the ERMI Discovery & Direction Center:
https://app.notion.com/p/3e2d004d2b9e81dfa8f9f86d6f33e699

Read D0, D1, and relevant D3 work. Recall D2/D6 before fresh research. Pathfinder maintains the broad map; workers execute with minimum necessary context.

MANDATORY D2 RESERVOIR FILL: D2 must contain 50 alive, distinct, qualified demands whenever real evidence supports them. At cycle start, count alive D2 demands. If below 50, this is unfinished work. Mine ChatGPT history/requests, user feedback, current goals, worker outcomes, connected sources, and current projects; validate distinct demands and persist them in D2. Continue until 50 alive demands exist OR a genuine evidence-exhaustion audit proves fewer than 50 can currently be justified. Do not stop after only the first few findings. Do not fabricate source-free demands, duplicate existing demands, or split one demand into cosmetic micro-demands.

IMPORTANT: the 22/50/100 internal candidate-path rule and the “keep only 3–10 strongest outputs” rule applies to candidate solution paths for an objective. It does NOT cap D2 demands. If D2 has 7 records and only 3 are alive, the Finder must work toward 50 alive qualified D2 demands; it does not get to declare success because it generated candidates internally.

Run a 10-demand delivery campaign after/while replenishing the reservoir when justified. Continue processing the strongest alive demands, fresh material discoveries, and relevant worker outcomes until 10 material demand outcomes are processed OR a real reservoir exhaustion/boundary check proves fewer than 10 worthwhile outcomes remain. Do not stop after one strong discovery or one promoted task. A counted outcome must be a verified direct delivery, verified Telegram/user action, complete finite 11 task actually created/updated, durable D2 demand with a real blocker/trigger after validation, or verified no-action disposition. Research notes, database edits, candidate ideas, and “next cycle” recommendations do not count.

When executable work exists, promote complete finite tasks to main 11 and execute when feasible. Route by task shape + actual tools + recent proven evidence. Never use archived D4 capability map.

MANDATORY SAME-CYCLE TELEGRAM END GATE: before finishing, check the Telegram Reply Writer queue and newest inbound Telegram messages through the canonical account/API path. For every new/material reply, act now: answer/prepare verified reply, create/execute task, promote to D2, update canonical state, ask for genuine user-owned/safety-critical input, or explicitly classify no-action. Never defer an actionable reply to the next cycle. Expand to full personal Telegram history/media only when context requires it. Verify sends; never fake receipts.

After worker completions, check for missed verification, same-scope omissions, missed notifications, and second-order opportunities. Use progressive disclosure; archives only for specific missing historical evidence/dead paths.

Do not manufacture work, duplicate tasks, or become a second execution controller. Do not execute production changes merely because you discovered them unless the discovery objective explicitly requires a safe research action; production execution belongs in 11.

HARD COMPLETION RULE: never finish with “next cycle should…” when a required same-cycle action is possible. Every newly discovered material signal, actionable Telegram reply, and required reservoir replenishment must be delivered, routed, persisted as a real demand, or explicitly dispositioned before the cycle closes.

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
};

for (const dir of [config.profilePath, config.dataPath, config.logsPath]) {
  fs.mkdirSync(dir, { recursive: true });
}

config.setupFlagPath = path.join(config.dataPath, 'setup-complete.json');
config.runCounterPath = path.join(config.dataPath, 'run-counter.json');

function isSetupComplete() {
  try {
    if (!fs.existsSync(config.setupFlagPath)) return false;
    const data = JSON.parse(fs.readFileSync(config.setupFlagPath, 'utf8'));
    return data.setupComplete === true;
  } catch {
    return false;
  }
}

function markSetupComplete() {
  fs.writeFileSync(
    config.setupFlagPath,
    JSON.stringify({ setupComplete: true, completedAt: new Date().toISOString() }, null, 2)
  );
}

function clearSetupComplete() {
  if (fs.existsSync(config.setupFlagPath)) fs.unlinkSync(config.setupFlagPath);
}

function loadRunState() {
  const p = path.join(config.dataPath, 'current-run.json');
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return null;
}

function saveRunState(state) {
  fs.writeFileSync(path.join(config.dataPath, 'current-run.json'), JSON.stringify(state, null, 2));
}

function clearRunState() {
  const p = path.join(config.dataPath, 'current-run.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Persistent accepted-run counter (survives Railway restarts). Only /run jobs increment it. */
function getRunCounter() {
  try {
    if (fs.existsSync(config.runCounterPath)) {
      const data = JSON.parse(fs.readFileSync(config.runCounterPath, 'utf8'));
      return typeof data.count === 'number' ? data.count : 0;
    }
  } catch {}
  return 0;
}

function incrementRunCounter() {
  const count = getRunCounter() + 1;
  fs.writeFileSync(
    config.runCounterPath,
    JSON.stringify({ count, updatedAt: new Date().toISOString() }, null, 2)
  );
  return count;
}

/**
 * Sequence: 1–3 worker, 4 discovery, 5–7 worker, 8 discovery, …
 * i.e. every 4th accepted run is discovery.
 */
function selectPromptForCounter(count) {
  if (count > 0 && count % 4 === 0) return PROMPTS.discovery;
  return PROMPTS.worker;
}

function resolvePrompt(explicitId) {
  if (explicitId && PROMPTS[explicitId]) return PROMPTS[explicitId];
  const nextCount = getRunCounter() + 1;
  return selectPromptForCounter(nextCount);
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
};
