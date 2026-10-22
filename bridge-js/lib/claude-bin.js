'use strict';

// Which executable to spawn for `claude`. Elsewhere the name is enough. On Windows Node cannot spawn a .cmd shim
// without a shell (and a shell would re-parse the prompt), so find the real claude.exe the npm shim points at.

const fs = require('node:fs');
const path = require('node:path');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function fromShim(shim) {
  try {
    const match = /"%dp0%\\([^"]+?\.exe)"/i.exec(fs.readFileSync(shim, 'utf8'));
    const exe = match && path.join(path.dirname(shim), match[1]);
    if (exe && isFile(exe)) return exe;
  } catch {
    // unreadable shim
  }
  return null;
}

function resolveWindows(name) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const candidates = path.isAbsolute(name) || /[\\/]/.test(name) ? [name] : dirs.map((d) => path.join(d, name));
  for (const base of candidates) {
    const stem = base.replace(/\.(exe|cmd)$/i, '');
    if (isFile(`${stem}.exe`)) return `${stem}.exe`;
    if (isFile(`${stem}.cmd`)) {
      const exe = fromShim(`${stem}.cmd`);
      if (exe) return exe;
    }
  }
  return name;
}

function claudeBin() {
  const name = process.env.CLAUDE_BIN || 'claude';
  return process.platform === 'win32' ? resolveWindows(name) : name;
}

module.exports = { claudeBin };
