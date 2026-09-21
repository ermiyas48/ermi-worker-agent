'use strict';
const path = require('path');
const fs = require('fs');
try { require('dotenv').config(); } catch (e) {}
const ROOT = path.resolve(__dirname, '..');
const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  ownerToken: process.env.OWNER_TOKEN || '',
  profilePath: path.resolve(process.env.PROFILE_PATH || path.join(ROOT, 'profiles', 'chatgpt')),
  dataPath: path.resolve(process.env.DATA_PATH || path.join(ROOT, 'data')),
  logsPath: path.join(ROOT, 'logs'),
  headless: process.env.HEADLESS !== 'false',
  appBaseUrl: process.env.APP_BASE_URL || ('http://localhost:' + (process.env.PORT || 3000)),
  chatgptUrl: 'https://chatgpt.com/',
  ermiPrompt: 'You are an ERMI Worker Agent.'
};
for (const dir of [config.profilePath, config.dataPath, config.logsPath]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}
config.setupFlagPath = path.join(config.dataPath, 'setup-complete.json');
function isSetupComplete() {
  try {
    if (!fs.existsSync(config.setupFlagPath)) return false;
    return JSON.parse(fs.readFileSync(config.setupFlagPath, 'utf8')).setupComplete === true;
  } catch (e) { return false; }
}
function markSetupComplete() {
  fs.writeFileSync(config.setupFlagPath, JSON.stringify({ setupComplete: true, completedAt: new Date().toISOString() }, null, 2));
}
module.exports = { config, isSetupComplete, markSetupComplete, loadRunState: function(){return null;}, saveRunState: function(){}, clearRunState: function(){} };
