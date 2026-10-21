'use strict';

// AppendLog hands out only what was added to a growing file, and starts over (reset) when the old content cannot be
// trusted. Run: node --test tests/bridge-js/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppendLog } = require('../../bridge-js/lib/appendlog');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = (content = '') => { const file = path.join(dir, `f${n++}.log`); fs.writeFileSync(file, content); return file; };
const text = (polled) => polled.lines.map((l) => l.toString());

test('the first poll returns every complete line, later polls only the new ones', () => {
  const file = fresh('one\ntwo\n');
  const log = new AppendLog(file);
  let polled = log.poll();
  assert.deepEqual(text(polled), ['one\n', 'two\n']);
  assert.equal(polled.reset, false);                      // nothing was read before, so there is nothing to throw away
  assert.deepEqual(text(log.poll()), []);
  fs.appendFileSync(file, 'three\n');
  polled = log.poll();
  assert.deepEqual(text(polled), ['three\n']);
  assert.equal(polled.reset, false);
});

test('a line still being written is held back until its newline arrives', () => {
  const file = fresh('done\npart');
  const log = new AppendLog(file);
  let polled = log.poll();
  assert.deepEqual(text(polled), ['done\n']);
  assert.equal(polled.fragment.toString(), 'part');
  fs.appendFileSync(file, 'ial\nnext');
  polled = log.poll();
  assert.deepEqual(text(polled), ['partial\n']);
  assert.equal(polled.fragment.toString(), 'next');
  assert.equal(polled.reset, false);
});

test('multi-byte characters split across two writes are not damaged', () => {
  const file = fresh('');
  const log = new AppendLog(file);
  const bytes = Buffer.from('你好,世界 😀\n');
  fs.writeFileSync(file, bytes.subarray(0, 4));            // ends inside a character
  assert.deepEqual(text(log.poll()), []);
  fs.appendFileSync(file, bytes.subarray(4));
  assert.deepEqual(text(log.poll()), ['你好,世界 😀\n']);
});

test('a file that got shorter starts over', () => {
  const file = fresh('aaa\nbbb\nccc\n');
  const log = new AppendLog(file);
  log.poll();
  fs.writeFileSync(file, 'x\n');
  const polled = log.poll();
  assert.equal(polled.reset, true);
  assert.deepEqual(text(polled), ['x\n']);
});

test('a rewrite of the same length is noticed, by the start of the file, the bytes before the offset, or the time', () => {
  const file = fresh('aaaa\nbbbb\n');
  const log = new AppendLog(file);
  log.poll();
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(file, 'AAAA\nBBBB\n');
  fs.utimesSync(file, later, later);
  let polled = log.poll();
  assert.equal(polled.reset, true);
  assert.deepEqual(text(polled), ['AAAA\n', 'BBBB\n']);
  // longer, with the beginning changed
  fs.writeFileSync(file, 'ZZZZ\nBBBB\nmore\n');
  polled = log.poll();
  assert.equal(polled.reset, true);
  assert.deepEqual(text(polled), ['ZZZZ\n', 'BBBB\n', 'more\n']);
});

test('a missing file throws, and works once it exists', () => {
  const file = path.join(dir, 'later.log');
  const log = new AppendLog(file);
  assert.throws(() => log.poll(), { code: 'ENOENT' });
  fs.writeFileSync(file, 'hi\n');
  assert.deepEqual(text(log.poll()), ['hi\n']);
});

test('a long file read in many steps gives every line exactly once, in order', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(i % 50)}\n`);
  const all = Buffer.from(lines.join(''));
  const file = fresh('');
  const log = new AppendLog(file);
  const got = [];
  for (let at = 0; at < all.length;) {
    const next = Math.min(all.length, at + 1 + Math.floor(Math.random() * 3000));
    fs.appendFileSync(file, all.subarray(at, next));
    at = next;
    const polled = log.poll();
    assert.equal(polled.reset, false);
    got.push(...text(polled));
  }
  assert.deepEqual(got, lines);
});
