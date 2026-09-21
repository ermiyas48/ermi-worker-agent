'use strict';
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const logFile = path.join(config.logsPath, 'ermi.log');
function ts() { return new Date().toISOString(); }
function write(level, msg, meta) {
  const line = `${ts()} [${level}] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(logFile, line); } catch {}
}
module.exports = {
  info: (msg, meta) => write('INFO', msg, meta),
  warn: (msg, meta) => write('WARN', msg, meta),
  error: (msg, meta) => write('ERROR', msg, meta),
  debug: (msg, meta) => { if (config.nodeEnv !== 'production') write('DEBUG', msg, meta); },
};
