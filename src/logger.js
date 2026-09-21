'use strict';
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const logFile = path.join(config.logsPath, 'ermi.log');
function ts() { return new Date().toISOString(); }
function write(level, msg, meta) {
  var line = ts() + ' [' + level + '] ' + msg + (meta ? ' ' + JSON.stringify(meta) : '') + '\n';
  process.stdout.write(line);
  try { fs.appendFileSync(logFile, line); } catch (e) {}
}
module.exports = { info: function(m,x){write('INFO',m,x);}, warn: function(m,x){write('WARN',m,x);}, error: function(m,x){write('ERROR',m,x);}, debug: function(m,x){write('DEBUG',m,x);} };
