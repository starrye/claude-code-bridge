'use strict';

// A file the extension needs at run time but the package builder does not list makes the installed
// extension fail to activate, and nothing else would notice before a user installs it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const builder = fs.readFileSync(path.join(ROOT, 'scripts', 'build_vsix.py'), 'utf8');
const packaged = new Set(JSON.parse(/EXTENSION_FILES = (\[[^\]]*\])/.exec(builder)[1]));

// relative requires of one packaged source file, as paths relative to the extension root
function requiredFiles(file) {
  const dir = path.dirname(path.join(ROOT, file));
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...source.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)].map((m) => {
    const target = path.resolve(dir, m[1]);
    return path.relative(ROOT, fs.existsSync(`${target}.js`) ? `${target}.js` : target).split(path.sep).join('/');
  });
}

test('every file the packaged extension requires is in the package', () => {
  const missing = [];
  const seen = new Set();
  const queue = ['extension.js'];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(packaged.has(file), `${file} is required but not packaged`);
    for (const dep of requiredFiles(file)) {
      if (!packaged.has(dep)) missing.push(`${dep} (required by ${file})`);
      else queue.push(dep);
    }
  }
  assert.deepEqual(missing, []);
});

test('every packaged extension file exists', () => {
  for (const file of packaged) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
});
