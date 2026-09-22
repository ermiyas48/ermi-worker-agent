'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { config, isSetupComplete, getRunCounter, resolvePrompt, PROMPTS } = require('./config');
const logger = require('./logger');
const { getRunExecutor } = require('./run-executor');
const { getSetupController } = require('./setup-controller');
const { getBrowserManager } = require('./browser-manager');
const { HUMAN_LABELS } = require('./states');

const app = express();
const executor = getRunExecutor(logger);
const setup = getSetupController(logger);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: false }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const controlLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

function requireOwner(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : (req.query.token || (req.body && req.body.token) || '');
  if (!config.ownerToken || config.ownerToken.length < 16) {
    logger.error('OWNER_TOKEN not configured');
    return res.status(503).json({ error: 'Server misconfigured: OWNER_TOKEN required' });
  }
  if (token !== config.ownerToken) {
    logger.warn('Unauthorized', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    setupComplete: isSetupComplete(),
    runCounter: getRunCounter(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  const st = executor.getStatus();
  res.json({
    state: st.state,
    label: st.label || HUMAN_LABELS[st.state],
    runId: st.id || null,
    locked: st.locked,
    setupComplete: st.setupComplete,
    error: st.error || null,
    message: st.message || null,
    promptId: st.promptId || null,
    runCounter: getRunCounter(),
    startedAt: st.startedAt || null,
    finishedAt: st.finishedAt || null,
  });
});

/** Primary trigger: GET /run?token=...&prompt=worker|discovery */
async function handleRun(req, res) {
  const explicit = (req.query.prompt || (req.body && req.body.prompt) || '').toString().toLowerCase().trim();
  const promptChoice = explicit && PROMPTS[explicit] ? explicit : null;
  logger.info('RUN trigger', { method: req.method, prompt: promptChoice || 'auto' });
  const result = await executor.startRun({ promptId: promptChoice });
  if (!result.ok) {
    const code = result.error && /progress|locked|concurrent/i.test(result.error) ? 409 : 400;
    return res.status(code).json(result);
  }
  res.status(202).json(result);
}

app.get('/run', controlLimiter, requireOwner, handleRun);
app.post('/run', controlLimiter, requireOwner, handleRun);

app.get('/run/status', controlLimiter, requireOwner, (req, res) => {
  res.json(executor.getStatus());
});

/** One-shot: start Chromium + navigate to ChatGPT for sign-in */
app.post('/setup/start', controlLimiter, requireOwner, async (req, res) => {
  if (isSetupComplete()) {
    return res.status(403).json({ error: 'Setup already complete. Profile is saved.' });
  }
  const result = await setup.startSetupBrowser();
  res.status(result.ok ? 200 : 500).json(result);
});

/** Backward-compatible alias */
app.post('/setup/browser', controlLimiter, requireOwner, async (req, res) => {
  if (isSetupComplete()) {
    return res.status(403).json({ error: 'Setup already complete. Setup route is disabled.' });
  }
  const result = await setup.startSetupBrowser();
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/setup/status', controlLimiter, requireOwner, async (req, res) => {
  if ((req.query.detect === '1' || req.query.auto === '1') && !isSetupComplete()) {
    const det = await setup.detectAuthentication();
    return res.json(Object.assign({}, setup.getStatus(), det));
  }
  res.json(setup.getStatus());
});

app.get('/setup/screenshot', controlLimiter, requireOwner, async (req, res) => {
  if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete' });
  try {
    const buf = await setup.getScreenshot();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/setup/action', controlLimiter, requireOwner, async (req, res) => {
  if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete' });
  const result = await setup.performAction(req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/setup', (req, res) => {
  if (isSetupComplete()) {
    return res.status(403).send(
      '<!DOCTYPE html><html><body style="font-family:system-ui;background:#0f1115;color:#e8eaed;padding:2rem">' +
        '<h1>Setup complete</h1><p>ChatGPT profile is saved on the persistent volume. Use GET /run to trigger ERMI runs.</p></body></html>'
    );
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(setup.getSetupPageHtml());
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  logger.error('Express error: ' + err.message);
  res.status(500).json({ error: 'Internal server error' });
});

async function shutdown(signal) {
  logger.info('Received ' + signal);
  await getBrowserManager(logger).shutdown();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (!config.ownerToken || config.ownerToken.length < 16) {
  logger.warn('WARNING: OWNER_TOKEN missing or weak');
}

app.listen(config.port, '0.0.0.0', () => {
  logger.info('ERMI Worker listening on :' + config.port);
  logger.info('Setup complete: ' + isSetupComplete());
  logger.info('Run counter: ' + getRunCounter());
  logger.info('Profile: ' + config.profilePath);
});
