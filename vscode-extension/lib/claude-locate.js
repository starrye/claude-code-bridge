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

const CODEX_ARCH = { x64: 'x86_64', arm64: 'aarch64' };
const CODEX_OS = { linux: 'linux', darwin: 'macos', win32: 'windows' };

// The `codex` the OpenAI Codex extension ships (openai.chatgpt-<version>-<platform>/bin/<os>-<arch>/codex), or ''.
function findBundledCodex(extensionsDir, platform = process.platform, arch = process.arch) {
  let names;
  try {
    names = fs.readdirSync(extensionsDir);
  } catch {
    return '';
  }
  const sub = `${CODEX_OS[platform] || platform}-${CODEX_ARCH[arch] || arch}`;
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  let best = null;
  for (const name of names) {
    const match = /^openai\.chatgpt-(\d+(?:\.\d+)*)/.exec(name);
    if (!match) continue;
    const target = /-((?:linux|darwin|win32|alpine)-[a-z0-9]+)$/.exec(name);
    if (target && target[1] !== `${platform}-${arch}`) continue;
    // the folder name under bin/ is not documented; prefer the expected one, else any that holds the binary
    let file = path.join(extensionsDir, name, 'bin', sub, exe);
    if (!isFile(file)) {
      let dirs = [];
      try { dirs = fs.readdirSync(path.join(extensionsDir, name, 'bin')); } catch { /* none */ }
      file = dirs.map((d) => path.join(extensionsDir, name, 'bin', d, exe)).find(isFile);
      if (!file) continue;
    }
    const version = match[1].split('.').map(Number);
    if (!best || newer(version, best.version)) best = { version, file };
  }
  return best ? best.file : '';
}

module.exports = { findBundledClaude, findBundledCodex };
