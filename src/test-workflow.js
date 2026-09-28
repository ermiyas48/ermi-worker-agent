'use strict';
const assert = require('assert');
const { config } = require('./config');
const { STATES, HUMAN_LABELS, ALLOWED_TRANSITIONS } = require('./states');
const { hashPrompt } = require('./run-executor');
let passed = 0, failed = 0, pending = [];
function test(name, fn) {
  const p = Promise.resolve().then(fn).then(
    () => { console.log('  ✓ ' + name); passed++; },
    (e) => { console.error('  ✗ ' + name + ': ' + e.message); failed++; }
  );
  pending.push(p);
}
console.log('\n=== ERMI Worker offline tests ===\n');
test('ERMI prompt exact', () => {
  assert.ok(config.ermiPrompt.includes('You are an ERMI Worker Agent.'));
  assert.ok(config.ermiPrompt.includes('https://app.notion.com/p/3e2d004d2b9e81b5b81dd2cda88a2e21'));
  assert.ok(config.ermiPrompt.includes('RUN TARGET: reach 10 distinct material outcome units.'));
  assert.ok(config.ermiPrompt.includes('STOP RECEIPT: every run must state OUTCOMES COMPLETED = N'));
});
test('Prompt hash deterministic', () => {
  const h1 = hashPrompt(config.ermiPrompt);
  assert.strictEqual(h1, hashPrompt(config.ermiPrompt));
  assert.strictEqual(h1.length, 64);
});
test('All states labelled', () => {
  for (const s of Object.values(STATES)) assert.ok(HUMAN_LABELS[s]);
});
test('IDLE transitions', () => {
  assert.ok(ALLOWED_TRANSITIONS[STATES.IDLE] && ALLOWED_TRANSITIONS[STATES.IDLE].includes(STATES.BROWSER_STARTING));
});
test('REAUTH message exact', () => {
  assert.strictEqual(HUMAN_LABELS[STATES.REAUTH_REQUIRED], 'ChatGPT session needs re-authentication.');
});
test('No credentials in config', () => {
  assert.ok(!('password' in config));
  assert.ok(!('sessionToken' in config));
});
test('Lock exclusive', () => {
  const { BrowserManager } = require('./browser-manager');
  const bm = new BrowserManager(console);
  assert.strictEqual(bm.acquireLock('r1'), true);
  assert.strictEqual(bm.acquireLock('r2'), false);
  assert.strictEqual(bm.releaseLock('r2'), false);
  assert.strictEqual(bm.releaseLock('r1'), true);
  assert.strictEqual(bm.acquireLock('r3'), true);
  bm.releaseLock('r3');
});

test('Browser lifecycle operations are serialized', async () => {
  const { BrowserManager } = require('./browser-manager');
  const bm = new BrowserManager(console);
  const order = [];
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.all([
    bm._withLifecycle(async () => { order.push('a1'); await delay(20); order.push('a2'); }),
    bm._withLifecycle(async () => { order.push('b1'); order.push('b2'); }),
  ]);
  assert.deepStrictEqual(order, ['a1', 'a2', 'b1', 'b2']);
});

test('Adapter wait exits cleanly when page is already closed', async () => {
  const { ChatGPTAdapter } = require('./chatgpt-adapter');
  const adapter = new ChatGPTAdapter({ isClosed: () => true }, console);
  const result = await adapter.waitForAny(['#anything'], { timeout: 25 });
  assert.strictEqual(result, null);
});

test('BrowserManager avoids lifecycle re-entry and destructive navigation probe', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, 'browser-manager.js'), 'utf8');
  const start = source.indexOf('async _ensureBrowserUnlocked');
  const end = source.indexOf('async _launch', start);
  assert.ok(start >= 0 && end > start);
  const section = source.slice(start, end);
  assert.ok(!section.includes('await this.close()'));
  assert.ok(!section.includes('page.evaluate(() => true)'));
});

test('Production control-page invariants', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const setup = fs.readFileSync(path.join(__dirname, 'setup-controller.js'), 'utf8');
  const reconnect = fs.readFileSync(path.join(root, 'public', 'reconnect.html'), 'utf8');
  assert.ok(server.includes('MANUAL_RECONNECT_LEASE_MS'));
  assert.ok(server.includes('manual reconnect lease active'));
  assert.ok(!server.includes('page.waitForTimeout('));
  assert.ok(!setup.includes('/setup/screenshot?token='));
  assert.ok(!setup.includes('localStorage.getItem(\'ownerToken\')'));
  assert.ok(!reconnect.includes('setInterval('));
  assert.ok(reconnect.includes('Authorization:'));
});

Promise.all(pending).then(() => {
  console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed > 0 ? 1 : 0);
});
