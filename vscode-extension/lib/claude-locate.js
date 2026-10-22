'use strict';

// The `claude` that the Claude Code extension ships. Phone tasks should run on the same version as the editor panel,
// not on whatever older `claude` happens to be first on PATH (the alias "sonnet" resolves differently per version).

const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'anthropic.claude-code-';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function versionOf(dirName) {
  const match = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/.exec(dirName);
  return match ? match[1].split('.').map(Number) : null;
}

function newer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

// Full path of the highest-version bundled binary under `extensionsDir`, or '' when there is none.
function findBundledClaude(extensionsDir, platform = process.platform) {
  let names;
  try {
    names = fs.readdirSync(extensionsDir);
  } catch {
    return '';
  }
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';
  let best = null;
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const version = versionOf(name);
    const file = path.join(extensionsDir, name, 'resources', 'native-binary', exe);
    if (!version || !isFile(file)) continue;
    if (!best || newer(version, best.version)) best = { version, file };
  }
  return best ? best.file : '';
}

module.exports = { findBundledClaude };
