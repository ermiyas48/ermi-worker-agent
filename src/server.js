'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { randomUUID } = require('crypto');
const { config, isSetupComplete, loadProxyState, setProxyServer, getProxyServer, clearProxyServer } = require('./config');
const { HUMAN_LABELS } = require('./states');
const logger = require('./logger');
const { getBrowserManager } = require('./browser-manager');
const { getRunExecutor } = require('./run-executor');
const { ChatGPTAdapter } = require('./chatgpt-adapter');
const { getSetupController } = require('./setup-controller');

const app = express();
// Railway reverse proxy — required to avoid ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withBrowserLock(label, fn) {
  const bm = getBrowserManager(logger);
  const owner = label + ':' + randomUUID();
  if (!bm.acquireLock(owner)) {
    const error = new Error('Browser is busy with another operation');
    error.code = 'BROWSER_BUSY';
    throw error;
  }
  try {
    return await fn(bm);
  } finally {
    bm.releaseLock(owner);
  }
}

function safePageUrl(page) {
  try { return page && !page.isClosed() ? (page.url() || '') : ''; }
  catch (_) { return ''; }
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
    conversationId: st.conversationId || null,
    verificationReceipt: st.verificationReceipt || null,
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


/* Manual owner-only reconnect surface. Preserves the existing /data profile and current proxy. */
function reconnectPageOrRedirect(req, res) {
  res.sendFile(path.join(__dirname, '..', 'public', 'reconnect.html'));
}

async function reconnectEnsurePage(bm) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const launched = await bm.ensureBrowser({ headless: config.headless });
    const page = launched.page;
    if (!page || page.isClosed()) continue;
    const url = safePageUrl(page);
    if (!/chatgpt.com|openai.com/i.test(url)) {
      try {
        await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {
        if (page.isClosed()) continue;
      }
      await sleep(2500);
    }
    if (!page.isClosed()) return { bm, page };
  }
  throw new Error('Browser page unavailable after bounded recovery attempts');
}

app.get('/reconnect', reconnectPageOrRedirect);

app.post('/reconnect/start', controlLimiter, requireOwner, async (req, res) => {
  try {
    const result = await withBrowserLock('reconnect-start', async (bm) => {
      const { page } = await reconnectEnsurePage(bm);
      return { ok: true, url: safePageUrl(page), proxy: bm.activeProxy || null };
    });
    res.json(result);
  } catch (e) {
    res.status(e.code === 'BROWSER_BUSY' ? 409 : 500).json({ ok: false, error: e.message });
  }
});

app.get('/reconnect/status', controlLimiter, requireOwner, async (req, res) => {
  try {
    const result = await withBrowserLock('reconnect-status', async (bm) => {
      const { page } = await reconnectEnsurePage(bm);
      const adapter = new ChatGPTAdapter(page, logger);
      const pageState = await adapter.detectPageState();
      const title = await page.title().catch(() => '');
      const body = await page.evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 1200)).catch(() => '');
      const challenge = /just a moment|attention required|checking your browser|verif(y|ying).{0,30}human|security check/i.test(title + ' ' + body);
      const authed = await adapter.isAuthenticated().catch(() => false);
      return {
        ok: true,
        state: pageState,
        authenticated: authed,
        cloudflare: challenge,
        title,
        url: safePageUrl(page),
        proxy: bm.activeProxy || null
      };
    });
    res.json(result);
  } catch (e) {
    res.status(e.code === 'BROWSER_BUSY' ? 409 : 500).json({ ok: false, error: e.message });
  }
});

app.get('/reconnect/screenshot', controlLimiter, requireOwner, async (req, res) => {
  try {
    const buffer = await withBrowserLock('reconnect-screenshot', async (bm) => {
      const { page } = await reconnectEnsurePage(bm);
      return page.screenshot({ type: 'png', fullPage: false });
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (e) {
    res.status(e.code === 'BROWSER_BUSY' ? 409 : 500).json({ ok: false, error: e.message });
  }
});

app.post('/reconnect/action', controlLimiter, requireOwner, async (req, res) => {
  try {
    const result = await withBrowserLock('reconnect-action', async (bm) => {
      let { page } = await reconnectEnsurePage(bm);
      const body = req.body || {};
      const type = String(body.type || '');
      if (type === 'click') {
        const x = Number(body.x), y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const error = new Error('x and y required');
          error.code = 'BAD_REQUEST';
          throw error;
        }
        await page.mouse.click(x, y, { delay: 40 });
      } else if (type === 'type') {
        const value = String(body.text || '');
        if (body.clear) await page.keyboard.press('Control+A').catch(() => {});
        if (body.clear) await page.keyboard.press('Backspace').catch(() => {});
        if (value) await page.keyboard.type(value, { delay: 20 });
      } else if (type === 'press') {
        await page.keyboard.press(String(body.key || 'Enter'));
      } else if (type === 'scroll') {
        await page.mouse.wheel(0, Number(body.dy) || 400);
      } else if (type === 'reload') {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(2500);
      } else if (type === 'restart') {
        const relaunched = await bm.restartPreservingSession('manual reconnect');
        page = relaunched.page;
        try {
          await page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
          if (!page.isClosed()) throw e;
        }
        await sleep(2500);
      } else {
        const error = new Error('Unknown action');
        error.code = 'BAD_REQUEST';
        throw error;
      }
      const live = await bm.ensureBrowser({ headless: config.headless });
      return { ok: true, url: safePageUrl(live.page) };
    });
    res.json(result);
  } catch (e) {
    res.status(e.code === 'BROWSER_BUSY' ? 409 : e.code === 'BAD_REQUEST' ? 400 : 500)
      .json({ ok: false, error: e.message });
  }
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