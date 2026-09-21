'use strict';
const assert = require('assert');
const { config } = require('./config');
const { STATES, HUMAN_LABELS, ALLOWED_TRANSITIONS } = require('./states');
const { hashPrompt } = require('./run-executor');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + ': ' + e.message); failed++; }
}
console.log('\n=== ERMI Worker offline tests ===\n');
test('ERMI prompt exact', () => {
  assert.ok(config.ermiPrompt.includes('You are an ERMI Worker Agent.'));
  assert.ok(config.ermiPrompt.includes('https://app.notion.com/p/3e2d004d2b9e81b5b81dd2cda88a2e21'));
  assert.ok(config.ermiPrompt.includes('Success = real finished work'));
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
  assert.strictEqual(bm.releaseLock('r1'), true);
  assert.strictEqual(bm.acquireLock('r3'), true);
  bm.releaseLock('r3');
});
console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed > 0 ? 1 : 0);
