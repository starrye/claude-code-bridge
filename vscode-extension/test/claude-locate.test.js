'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findBundledClaude } = require('../lib/claude-locate');

function extensionsWith(versions, exe = 'claude') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
  for (const name of versions) {
    const bin = path.join(dir, name, 'resources', 'native-binary');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, exe), '');
  }
  return dir;
}

test('the highest version wins, compared as numbers (2.1.301 beats 2.1.99)', () => {
  const dir = extensionsWith(['anthropic.claude-code-2.1.99-linux-x64', 'anthropic.claude-code-2.1.301-linux-x64', 'anthropic.claude-code-2.1.296-linux-x64']);
  assert.equal(findBundledClaude(dir, 'linux'), path.join(dir, 'anthropic.claude-code-2.1.301-linux-x64', 'resources', 'native-binary', 'claude'));
});

test('a folder without the binary is skipped, other extensions are ignored', () => {
  const dir = extensionsWith(['anthropic.claude-code-2.1.200-linux-x64', 'ms-python.python-2024.1.0']);
  fs.mkdirSync(path.join(dir, 'anthropic.claude-code-2.1.400-linux-x64'));
  assert.equal(path.basename(path.dirname(path.dirname(path.dirname(findBundledClaude(dir, 'linux'))))), 'anthropic.claude-code-2.1.200-linux-x64');
});

test('Windows looks for claude.exe', () => {
  const dir = extensionsWith(['anthropic.claude-code-2.1.301-win32-x64'], 'claude.exe');
  assert.equal(path.basename(findBundledClaude(dir, 'win32')), 'claude.exe');
  assert.equal(findBundledClaude(dir, 'linux'), '');
});

test('nothing found gives an empty string, so the caller falls back to PATH', () => {
  assert.equal(findBundledClaude(path.join(os.tmpdir(), 'no-such-extensions-dir'), 'linux'), '');
  assert.equal(findBundledClaude(extensionsWith([]), 'linux'), '');
});
