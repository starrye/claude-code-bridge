'use strict';

// Which `codex` to run: CODEX_BIN (the extension passes the binary shipped by the newest OpenAI Codex extension),
// else `codex` on PATH. available() is false when neither can be found, and then Codex is left out entirely.

const fs = require('node:fs');
const path = require('node:path');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

function onPath(name) {
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, exe(name));
    if (isFile(file)) return file;
  }
  return null;
}

function codexBin() {
  const chosen = process.env.CODEX_BIN;
  if (chosen) return path.isAbsolute(chosen) ? (isFile(chosen) ? chosen : null) : onPath(chosen);
  return onPath('codex');
}

module.exports = { codexBin };
