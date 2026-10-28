'use strict';

// Run by VS Code (`vscode:uninstall`) after this extension is removed: give the OpenAI Codex extension its own codex
// back. Even if this never runs, the forwarder left in its place falls back to the original binary.

const os = require('node:os');
const path = require('node:path');

try {
  const { uninstall } = require(path.join(__dirname, 'runtime', 'bridge-js', 'lib', 'codex-takeover.js'));
  const roots = [path.dirname(__dirname), path.join(os.homedir(), '.vscode-server', 'extensions'), path.join(os.homedir(), '.vscode', 'extensions')];
  for (const root of new Set(roots)) uninstall(root);
} catch {
  // nothing to restore
}
