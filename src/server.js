'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { config, isSetupComplete, loadProxyState, setProxyServer, getProxyServer, clearProxyServer } = require('./config');
const { HUMAN_LABELS } = require('./states');
const logger = require('./logger');
const { getBrowserManager } = require('./browser-manager');
const { getRunExecutor } = require('./run-executor');
const { getSetupController } = require('./setup-controller');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function requireOwner(req, res, next) {
  if (!config.ownerToken) {
    logger.error('OWNER_TOKEN not configured');
    return res.status(503).json({ error: 'Server misconfigured: OWNER_TOKEN required' });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
  if (token !== config.ownerToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const controlLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

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

app.get('/status', requireOwner, (req, res) => {
  const executor = getRunExecutor(logger);
  const st = executor.getStatus();
  const px = loadProxyState();
  const bm = getBrowserManager(logger);
  res.json({
    state: st.state, label: st.label || HUMAN_LABELS[st.state], runId: st.id || null,
    locked: st.locked, setupComplete: isSetupComplete(),
    error: st.error || null, message: st.message || null,
    startedAt: st.startedAt || null, finishedAt: st.finishedAt || null,
    promptKind: st.promptKind || null,
    conversationUrl: st.conversationUrl || null,
    network: {
      desiredProxyValid: !!(px && px.valid),
      desiredProxySet: !!(px && px.server),
      activeBrowserProxySet: !!(bm.activeProxy),
      proxyChangedSinceLaunch: (px && px.server || null) !== (bm.activeProxy || null),
      lastProxyUpdate: px && px.updatedAt || null,
      proxySource: px && px.source || null,
      server: px && px.server || null,
    },
  });
});

app.post('/run', controlLimiter, requireOwner, async (req, res) => {
  const body = req.body || {};
  logger.info('POST /run kind=' + (body.kind || 'auto'));
  const executor = getRunExecutor(logger);
  const result = await executor.startRun({ kind: body.kind, prompt: body.prompt });
  res.status(result.ok ? 202 : 409).json(result);
});

app.get('/run/status', controlLimiter, requireOwner, (req, res) => {
  res.json(getRunExecutor(logger).getStatus());
});

app.get('/proxy', requireOwner, (req, res) => {
  const px = loadProxyState();
  res.json({ ok: true, valid: !!(px && px.valid), server: px && px.server || null, updatedAt: px && px.updatedAt || null, source: px && px.source || null });
});

app.post('/proxy', controlLimiter, requireOwner, (req, res) => {
  const body = req.body || {};
  let server = body.server || body.proxy || body.endpoint || null;
  if (!server) return res.status(400).json({ ok: false, error: 'server required' });
  const result = setProxyServer(server, body.source || 'api');
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/setup/browser', controlLimiter, requireOwner, async (req, res) => {
  const sc = getSetupController(logger);
  const result = await sc.startSetupBrowser();
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/setup/cookies', controlLimiter, requireOwner, async (req, res) => {
  const sc = getSetupController(logger);
  const result = await sc.importCookies(req.body);
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/setup/status', controlLimiter, requireOwner, async (req, res) => {
  const sc = getSetupController(logger);
  if (req.query.detect) {
    const det = await sc.detectAuthentication();
    return res.json(Object.assign({}, sc.getStatus(), det));
  }
  res.json(sc.getStatus());
});

app.get('/setup/screenshot', controlLimiter, requireOwner, async (req, res) => {
  try {
    const sc = getSetupController(logger);
    const { buffer } = await sc.takeScreenshot();
    res.type('png').send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/setup', (req, res) => {
  const sc = getSetupController(logger);
  res.type('html').send(sc.getSetupPageHtml());
});

app.get('/', (req, res) => {
  res.type('html').send('<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>ERMI</title></head><body style="font-family:system-ui;max-width:640px;margin:2rem auto"><h1>ERMI Worker</h1><p><a href="/setup">Setup</a></p></body></html>');
});

if (!config.ownerToken || config.ownerToken.length < 16) {
  logger.warn('WARNING: OWNER_TOKEN missing or weak');
}

// Auto-run sequence: worker x3 → discovery, every AUTO_RUN_INTERVAL_MS (default 4 min)
(function startAutoRun() {
  const { config, isSetupComplete, getProxyServer, peekPromptKind } = require('./config');
  if (!config.autoRunEnabled) {
    logger.info('Auto-run disabled');
    return;
  }
  const interval = Math.max(60000, config.autoRunIntervalMs || 240000);
  logger.info('Auto-run enabled intervalMs=' + interval + ' sequence=' + JSON.stringify(config.promptSequence || []));
  setInterval(async () => {
    try {
      if (!isSetupComplete()) { logger.info('Auto-run skip: setup incomplete'); return; }
      if (!getProxyServer()) { logger.info('Auto-run skip: no valid proxy'); return; }
      const executor = getRunExecutor(logger);
      const st = executor.getStatus();
      if (st.locked || (st.state && !['IDLE', 'COMPLETE', 'FAILED', 'NEEDS_REVIEW', 'REAUTH_REQUIRED'].includes(st.state))) {
        logger.info('Auto-run skip: busy state=' + st.state);
        return;
      }
      const kind = peekPromptKind();
      logger.info('Auto-run starting next kind=' + kind);
      const result = await executor.startRun({});
      logger.info('Auto-run result ok=' + result.ok + ' kind=' + (result.promptKind || '') + ' runId=' + (result.runId || ''));
    } catch (e) {
      logger.error('Auto-run error: ' + e.message);
    }
  }, interval);
})();

app.listen(config.port, '0.0.0.0', () => {
  logger.info('ERMI Worker listening on ' + config.port);
});
