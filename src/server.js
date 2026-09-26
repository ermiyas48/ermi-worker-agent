'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const {
  config, isSetupComplete, getProxyServer, setProxyServer, clearProxyServer, loadProxyState, isValidProxyServer,
} = require('./config');
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
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const controlLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function requireOwner(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || (req.body && req.body.token) || '');
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
  const px = loadProxyState();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    setupComplete: isSetupComplete(),
    proxyValid: !!(px && px.valid && px.server),
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  const st = executor.getStatus();
  const px = loadProxyState();
  const bm = getBrowserManager(logger);
  res.json({
    state: st.state, label: st.label || HUMAN_LABELS[st.state], runId: st.id || null,
    locked: st.locked, setupComplete: st.setupComplete, error: st.error || null,
    message: st.message || null, startedAt: st.startedAt || null, finishedAt: st.finishedAt || null,
    network: {
      desiredProxyValid: !!(px && px.valid),
      desiredProxySet: !!(px && px.server),
      activeBrowserProxySet: !!bm.activeProxy,
      proxyChangedSinceLaunch: (px && px.server || null) !== (bm.activeProxy || null),
      lastProxyUpdate: px && px.updatedAt || null,
      proxySource: px && px.source || null,
      server: px && px.valid ? px.server : null,
    },
  });
});

app.post('/run', controlLimiter, requireOwner, async (req, res) => {
  logger.info('POST /run');
  const result = await executor.startRun();
  if (!result.ok) return res.status(result.error && result.error.includes('progress') ? 409 : 400).json(result);
  res.status(202).json(result);
});

app.get('/run/status', controlLimiter, requireOwner, (req, res) => {
  res.json(executor.getStatus());
});

app.get('/proxy', requireOwner, (req, res) => {
  const px = loadProxyState();
  res.json({
    ok: true,
    valid: !!(px && px.valid && isValidProxyServer(px.server)),
    server: px && px.valid ? px.server : null,
    updatedAt: px && px.updatedAt || null,
    source: px && px.source || null,
  });
});

app.post('/proxy', controlLimiter, requireOwner, (req, res) => {
  const body = req.body || {};
  let server = body.server || body.proxy || body.endpoint || null;
  if (server && typeof server === 'string' && !/^socks5/i.test(server) && server.includes(':')) {
    server = 'socks5://' + server.replace(/^\/\//, '');
  }
  if (body.clear === true || server === null || server === '') {
    clearProxyServer();
    logger.info('Proxy cleared');
    return res.json({ ok: true, valid: false, server: null, message: 'Proxy cleared' });
  }
  const result = setProxyServer(server, body.source || 'termugpt');
  if (!result.ok) return res.status(400).json(result);
  logger.info('Proxy updated');
  res.json({
    ok: true,
    valid: true,
    server: result.server,
    updatedAt: result.updatedAt,
    message: 'Proxy accepted. Browser will use it on next launch.',
  });
});

app.post('/setup/browser', controlLimiter, requireOwner, async (req, res) => {
  if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete. Setup route is disabled.' });
  const result = await setup.startSetupBrowser();
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/setup/cookies', controlLimiter, requireOwner, async (req, res) => {
  if (isSetupComplete()) return res.status(403).json({ error: 'Setup already complete.' });
  const body = req.body;
  const cookies = Array.isArray(body) ? body : (body && body.cookies);
  const result = await setup.importCookies(cookies);
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/setup/status', controlLimiter, requireOwner, async (req, res) => {
  if (req.query.detect === '1' && !isSetupComplete()) {
    const det = await setup.detectAuthentication();
    return res.json(Object.assign({}, setup.getStatus(), det));
  }
  res.json(setup.getStatus());
});

app.get('/setup/screenshot', controlLimiter, requireOwner, async (req, res) => {
  try {
    const { buffer, info } = await setup.takeScreenshot();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Page-Url', (info && info.url) || '');
    res.setHeader('X-Page-Title', encodeURIComponent((info && info.title) || ''));
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  logger.info('Profile: ' + config.profilePath);
  const px = getProxyServer();
  logger.info('Proxy: ' + (px || 'none'));
});
