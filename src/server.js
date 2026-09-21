\'use strict\';
const express = require(\'express\');
const helmet = require(\'helmet\');
const cors = require(\'cors\');
const rateLimit = require(\'express-rate-limit\');
const path = require(\'path\');
const { config, isSetupComplete } = require(\'./config\');
const logger = require(\'./logger\');
const { HUMAN_LABELS, STATES } = require(\'./states\');

let getRunExecutor, getSetupController, getBrowserManager;
try { getRunExecutor = require(\'./run-executor\').getRunExecutor; } catch (e) { logger.warn(\'run-executor not loaded: \' + e.message); }
try { getSetupController = require(\'./setup-controller\').getSetupController; } catch (e) { logger.warn(\'setup-controller not loaded: \' + e.message); }
try { getBrowserManager = require(\'./browser-manager\').getBrowserManager; } catch (e) { logger.warn(\'browser-manager not loaded: \' + e.message); }

const app = express();
const executor = getRunExecutor ? getRunExecutor(logger) : null;
const setup = getSetupController ? getSetupController(logger) : null;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: false }));
app.use(express.json({ limit: \'32kb\' }));
app.use(express.static(path.join(__dirname, \'..\', \'public\')));

const controlLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function requireOwner(req, res, next) {
  const header = req.headers.authorization || \'\';
  const token = header.startsWith(\'Bearer \') ? header.slice(7) : (req.query.token || req.body?.token || \'\');
  if (!config.ownerToken || config.ownerToken.length < 16) {
    return res.status(503).json({ error: \'Server misconfigured: OWNER_TOKEN required\' });
  }
  if (token !== config.ownerToken) return res.status(401).json({ error: \'Unauthorized\' });
  next();
}

app.get(\'/health\', (req, res) => {
  res.json({ status: \'ok\', uptime: process.uptime(), setupComplete: isSetupComplete(), timestamp: new Date().toISOString() });
});

app.get(\'/status\', (req, res) => {
  if (!executor) return res.json({ state: \'IDLE\', label: \'Idle (modules incomplete)\', setupComplete: isSetupComplete() });
  const st = executor.getStatus();
  res.json({
    state: st.state, label: st.label || HUMAN_LABELS[st.state], runId: st.id || null,
    locked: st.locked, setupComplete: st.setupComplete, error: st.error || null,
    message: st.message || null, startedAt: st.startedAt || null, finishedAt: st.finishedAt || null,
  });
});

app.post(\'/run\', controlLimiter, requireOwner, async (req, res) => {
  if (!executor) return res.status(503).json({ error: \'Run executor not loaded - push remaining source\' });
  const result = await executor.startRun();
  if (!result.ok) return res.status(result.error?.includes(\'progress\') ? 409 : 400).json(result);
  res.status(202).json(result);
});

app.get(\'/run/status\', controlLimiter, requireOwner, (req, res) => {
  if (!executor) return res.status(503).json({ error: \'Run executor not loaded\' });
  res.json(executor.getStatus());
});

app.post(\'/setup/browser\', controlLimiter, requireOwner, async (req, res) => {
  if (!setup) return res.status(503).json({ error: \'Setup controller not loaded\' });
  if (isSetupComplete()) return res.status(403).json({ error: \'Setup already complete. Setup route is disabled.\' });
  const result = await setup.startSetupBrowser();
  res.status(result.ok ? 200 : 500).json(result);
});

app.get(\'/setup/status\', controlLimiter, requireOwner, async (req, res) => {
  if (!setup) return res.json({ setupComplete: isSetupComplete() });
  if (req.query.detect === \'1\' && !isSetupComplete()) {
    const det = await setup.detectAuthentication();
    return res.json({ ...setup.getStatus(), ...det });
  }
  res.json(setup.getStatus());
});

app.get(\'/setup\', (req, res) => {
  if (isSetupComplete()) return res.status(403).send(\'Setup already complete.\');
  if (!setup) return res.status(503).send(\'Setup controller not loaded yet.\');
  res.setHeader(\'Content-Type\', \'text/html; charset=utf-8\');
  res.send(setup.getSetupPageHtml());
});

app.get(\'/\', (req, res) => {
  const idx = path.join(__dirname, \'..\', \'public\', \'index.html\');
  if (require(\'fs\').existsSync(idx)) return res.sendFile(idx);
  res.type(\'html\').send(\'<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh"><div><h1>ERMI Worker</h1><p>Deployed. Push remaining source for full UI.</p><p><a href="/health">/health</a></p></div></body></html>\');
});

app.use((err, req, res, next) => {
  logger.error(\'Express error: \' + err.message);
  res.status(500).json({ error: \'Internal server error\' });
});

async function shutdown(signal) {
  logger.info(`Received ${signal}`);
  try { if (getBrowserManager) await getBrowserManager(logger).shutdown(); } catch {}
  process.exit(0);
}
process.on(\'SIGTERM\', () => shutdown(\'SIGTERM\'));
process.on(\'SIGINT\', () => shutdown(\'SIGINT\'));

if (!config.ownerToken || config.ownerToken.length < 16) logger.warn(\'WARNING: OWNER_TOKEN missing or weak\');

app.listen(config.port, \'0.0.0.0\', () => {
  logger.info(`ERMI Worker listening on :${config.port}`);
  logger.info(`Setup complete: ${isSetupComplete()}`);
  logger.info(`Profile: ${config.profilePath}`);
});
