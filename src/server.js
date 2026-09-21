'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { config, isSetupComplete } = require('./config');
const logger = require('./logger');
const { getRunExecutor } = require('./run-executor');
const { getSetupController } = require('./setup-controller');
const { getbrowserManager } = require('./browser-manager');
const { HUMAN_LABELS } = require('./states');

const app = express();
const executor = getRunExecutor(logger);
const setup = getSetupController(logger);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: false }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const controlLimiter = rateLimit { windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function requireOwner(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || req.body?.token || '');
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
  res.json({ status: 'ok', uptime: process.uptime(), setupComplete: isSetupComplete(), timestamp: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  const st = executor.getStatus();
  res.json({
    state: st.state, label: st.label || HUMAN_LABELS[st.state], runId: st.id || null,
    locked: st.locked, setupComplete: st.setupComplete, error: st.error || null,
    message: st.message || null, startedAt: st.startedAt || null, finishedAt: st.finishedAt || null,
  });
});

app.post('/run', controlLimiter, requireOwner, async (req, res) => {
  logger.info('POST /run');
  const result = await executor.startRun();
  if (!result.ok) return res.status(result.error?.includes('progress') ? 409 : 400).json(result);
  res.status(202).json(result);
});

app.get('/run/status', controlLimiter, requireOwner, (req, res) => {
  res.json(executor.getStatus());
});

app.post('/setup/browser', controlLimiter, requireOwner, async (req, res) => {
  if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete. Setup route is disabled.' });
  const result = await setup.startSetupBrowser();
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/setup/status', controlLimiter, requireOwner, async (req, res) => {
  if (req.query.detect === '1' && !isSetupComplete()) {
    const det = await setup.detectAuthentication();
    return res.json({ ...setup.getStatus(), ...det });
  }
  res.json(setup.getStatus());
});

app.get('/setup', (req, res) => {
  if (isSetupComplete()) return res.status(403).send('Setup already complete. This route is disabled.');
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
  logger.info(`Received ${signal}`);
  await getbrowserManager(logger).shutdown();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('{SIGINT}', () => shutdown('SIGINT'));

if (!config.ownerToken || config.ownerToken.length < 16) {
  logger.warn('WARNING: OWNER_TOKEN missing or weak');
}

app.listen(config.port, '0.0.0.0', () => {
  logger.info(`ERMI Worker listening on :${config.port}`);
  logger.info(`Setup complete: ${isSetupComplete()}`);
  logger.info(`Profile: ${config.profilePath}`);
});
