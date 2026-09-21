'use strict';
const express = require('express');
const path = require('path');
const { config, isSetupComplete } = require('./config');
const logger = require('./logger');
const { HUMAN_LABELS, STATES } = require('./states');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireOwner(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  if (!config.ownerToken || config.ownerToken.length < 16) {
    return res.status(503).json({ error: 'OWNER_TOKEN not configured' });
  }
  if (token !== config.ownerToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), setupComplete: isSetupComplete(), timestamp: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  res.json({ state: STATES.IDLE, label: HUMAN_LABELS[STATES.IDLE], locked: false, setupComplete: isSetupComplete() });
});

app.post('/run', requireOwner, (req, res) => {
  res.status(503).json({ ok: false, error: 'Push full source modules (run-executor, browser-manager, chatgpt-adapter, setup-controller) from the local tarball to enable runs.' });
});

app.get('/run/status', requireOwner, (req, res) => {
  res.json({ state: STATES.IDLE, label: HUMAN_LABELS[STATES.IDLE] });
});

app.post('/setup/browser', requireOwner, (req, res) => {
  res.status(503).json({ error: 'Push full setup-controller source to enable first-time ChatGPT login.' });
});

app.get('/setup/status', requireOwner, (req, res) => {
  res.json({ setupComplete: isSetupComplete() });
});

app.get('/setup', (req, res) => {
  res.type('html').send('<h1>Setup</h1><p>Push remaining source modules, then reload.</p>');
});

app.get('/', (req, res) => {
  const idx = path.join(__dirname, '..', 'public', 'index.html');
  try { return res.sendFile(idx); } catch (e) {
    res.type('html').send('<h1>ERMI Worker</h1><p>Deployed. <a href="/health">health</a></p>');
  }
});

app.listen(config.port, '0.0.0.0', () => {
  logger.info('ERMI Worker listening on :' + config.port);
  logger.info('Setup complete: ' + isSetupComplete());
});
