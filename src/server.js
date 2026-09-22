'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { config, isSetupComplete, getRunCounter } = require('./config');
const log = require('./logger');
const { getBrowserManager } = require('./browser-manager');
const { getSetupController } = require('./setup-controller');
const { getRunExecutor } = require('./run-executor');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

function requireOwner(req, res, next) {
  if (!config.ownerToken) {
    return res.status(503).json({ error: 'OWNER_TOKEN not configured' });
  }
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerTok = req.headers['x-owner-token'] || '';
  const queryTok = (req.query && req.query.token) || '';
  const token = bearer || headerTok || queryTok;
  if (token !== config.ownerToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

const controlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

const setup = getSetupController(log);
const executor = getRunExecutor(log);
const bm = getBrowserManager(log);

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
  const run = executor.getStatus();
  res.json({
    setupComplete: isSetupComplete(),
    run,
    browserLocked: bm.isLocked(),
  });
});

async function handleRun(req, res) {
  try {
    const body = req.method === 'POST' ? req.body || {} : {};
    const promptId = body.promptId || req.query.promptId || 'worker';
    const result = await executor.startRun({ promptId });
    const code = result.ok ? 202 : result.state === 'LOCKED' || result.status === 'running' ? 409 : 400;
    return res.status(code).json(result);
  } catch (e) {
    log.error('run error: ' + e.message);
    return res.status(500).json({ ok: false, error: e.message, status: 'error' });
  }
}

app.get('/run', controlLimiter, requireOwner, handleRun);
app.post('/run', controlLimiter, requireOwner, handleRun);

app.get('/run/status', controlLimiter, requireOwner, (req, res) => {
  res.json(executor.getStatus());
});

app.post('/setup/start', controlLimiter, requireOwner, async (req, res) => {
  try {
    const result = await setup.startSetupBrowser();
    return res.json(result);
  } catch (e) {
    log.error('setup/start: ' + e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/setup/browser', controlLimiter, requireOwner, async (req, res) => {
  try {
    const result = await setup.startSetupBrowser();
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/setup/status', controlLimiter, requireOwner, async (req, res) => {
  try {
    if (req.query.detect === '1') {
      const detected = await setup.detectAuthentication();
      return res.json(Object.assign({}, setup.getStatus(), detected));
    }
    return res.json(setup.getStatus());
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/setup/screenshot', controlLimiter, requireOwner, async (req, res) => {
  try {
    const buf = await setup.getScreenshot();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    return res.send(buf);
  } catch (e) {
    if (String(e.message).includes('already complete')) {
      return res.status(403).json({ error: e.message });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.post('/setup/import-cookies', controlLimiter, requireOwner, async (req, res) => {
  try {
    const body = req.body || {};
    let cookies = body.cookies;
    if (typeof cookies === 'string') {
      try { cookies = JSON.parse(cookies); } catch (e) {
        return res.status(400).json({ ok: false, error: 'cookies must be JSON array' });
      }
    }
    if (!Array.isArray(cookies)) {
      return res.status(400).json({ ok: false, error: 'Body must include cookies: [...]' });
    }
    const result = await setup.importSessionCookies(cookies);
    return res.json(result);
  } catch (e) {
    log.error('import-cookies: ' + e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/setup/action', controlLimiter, requireOwner, async (req, res) => {
  try {
    const result = await setup.performAction(req.body || {});
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/setup', (req, res) => {
  try {
    const html = setup.getSetupPageHtml();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    return res.send(html);
  } catch (e) {
    return res.status(500).send('Setup page unavailable');
  }
});

app.get('/', (req, res) => {
  res.json({
    service: 'ermi-worker-agent',
    setupComplete: isSetupComplete(),
    health: '/health',
    setup: '/setup',
    run: '/run',
  });
});

app.use((err, req, res, next) => {
  log.error('Unhandled: ' + (err && err.stack));
  res.status(500).json({ error: 'Internal error' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  log.info('Listening on ' + config.port + ' setupComplete=' + isSetupComplete());
});

async function shutdown() {
  log.info('Shutting down…');
  try { await bm.shutdown(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app };
