'use strict';

// The rendered main line of a session file is cached until the file changes. These check that the cache never serves
// stale data, never hands out something a caller can corrupt, and that the branch-root shortcut keeps the same answer.
// Run: node --test tests/bridge-js/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const transcript = require('../../bridge-js/lib/transcript');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const row = (uuid, parent, role, text, extra = {}) => JSON.stringify({
  type: role, uuid, parentUuid: parent, timestamp: `2026-10-20T00:00:${String(counter++).padStart(2, '0')}Z`,
  message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }, ...extra }) + '\n';
const write = (name, ...lines) => { const file = path.join(dir, name); fs.writeFileSync(file, lines.join('')); return file; };
const texts = (page) => page.items.map((i) => i.text);

test('a page is served from the cache while the file is unchanged, and sees what is appended', () => {
  const file = write('a.jsonl', row('u1', null, 'user', 'one'), row('a1', 'u1', 'assistant', 'two'));
  assert.deepEqual(texts(transcript.messages(file, null, 200)), ['one', 'two']);
  assert.deepEqual(texts(transcript.messages(file, null, 200)), ['one', 'two']);
  fs.appendFileSync(file, row('u2', 'a1', 'user', 'three'));
  const page = transcript.messages(file, null, 200);
  assert.deepEqual(texts(page), ['one', 'two', 'three']);
  assert.equal(page.total, 3);
});

test('a rewrite of the same length is noticed (the modification time is part of the key)', () => {
  const file = write('b.jsonl', row('u1', null, 'user', 'aaaa'));
  assert.deepEqual(texts(transcript.messages(file, null, 200)), ['aaaa']);
  const before = fs.statSync(file).size;
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(file, row('u1', null, 'user', 'bbbb'));
  fs.utimesSync(file, later, later);
  assert.equal(fs.statSync(file).size, before);
  assert.deepEqual(texts(transcript.messages(file, null, 200)), ['bbbb']);
});

test('what a caller does to a page cannot reach the next one', () => {
  const file = write('c.jsonl', row('u1', null, 'user', 'one'), row('a1', 'u1', 'assistant', 'two'),
    row('x1', null, 'user', 'a side branch', { entrypoint: 'claude-vscode' }));
  const first = transcript.messages(file, null, 200);
  assert.ok(first.branches.length >= 1, 'the file has a side branch');
  first.branches[0].preview = 'changed';
  first.branches[0].entrypoints.push('tampered');
  first.branches.length = 0;
  const second = transcript.messages(file, null, 200);
  assert.ok(second.branches.length >= 1);
  assert.notEqual(second.branches[0].preview, 'changed');
  assert.ok(!second.branches[0].entrypoints.includes('tampered'));
});

test('paging, cursors and a re-rooted chain behave as without the cache', () => {
  // one straight conversation m0 <- m1 <- ... <- m29, alternating user and assistant
  const lines = [row('m0', null, 'user', 'm0')];
  for (let i = 1; i < 30; i++) lines.push(row(`m${i}`, `m${i - 1}`, i % 2 ? 'assistant' : 'user', `m${i}`));
  const file = write('d.jsonl', ...lines);
  const tail = transcript.messages(file, null, 5);
  assert.equal(tail.items.length, 5);
  assert.equal(tail.start, tail.total - 5);
  assert.deepEqual(texts(transcript.messages(file, 2, 3)), ['m2', 'm3', 'm4']);
  const mid = transcript.messages(file, null, 200).items[10].id;
  assert.equal(transcript.messages(file, null, 200, null, mid).start, 11);
  const unknown = transcript.messages(file, null, 5, null, 'nope');
  assert.equal(unknown.reset, true);
  assert.equal(unknown.start, unknown.total - 5);
  assert.equal(transcript.messages(file, null, 5, 'no-such-branch'), null);
});

test('a missing file is an empty page and is not cached as something else', () => {
  const file = path.join(dir, 'later.jsonl');
  assert.equal(transcript.messages(file, null, 200).total, 0);
  fs.writeFileSync(file, row('u1', null, 'user', 'now it exists'));
  assert.deepEqual(texts(transcript.messages(file, null, 200)), ['now it exists']);
});

test('side branches are found the same way with a long off-chain history', () => {
  // an active chain of three, plus a long off-chain run of 8000 rows whose parent is the first chain row.
  // The old search took ~6 s here (it doubles in length to ~4x the time); the linear one takes a few tens of ms.
  const lines = [row('u1', null, 'user', 'start'), row('a1', 'u1', 'assistant', 'answer'), row('u2', 'a1', 'user', 'follow-up')];
  let parent = 'u1';
  for (let i = 0; i < 8000; i++) { const id = `side-${i}`; lines.push(row(id, parent, i % 2 ? 'assistant' : 'user', `side ${i}`)); parent = id; }
  lines.push(row('u3', 'u2', 'user', 'latest'));              // the newest row decides the active chain
  const file = write('e.jsonl', ...lines);
  const started = process.hrtime.bigint();
  const page = transcript.messages(file, null, 200);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(texts(page), ['start', 'answer', 'follow-up', 'latest']);
  assert.equal(page.branches.length, 1);
  assert.equal(page.branches[0].id, 'side-0');
  assert.equal(page.branches[0].rows, 8000);
  assert.ok(ms < 1000, `took ${ms} ms; the branch search must not be quadratic`);
});

test('a session that grows while it is being read gives the same pages as reading it whole', () => {
  // the line cuts land inside lines too, as when a task is writing
  const lines = [row('m0', null, 'user', 'm0')];
  for (let i = 1; i < 60; i++) lines.push(row(`m${i}`, `m${i - 1}`, i % 2 ? 'assistant' : 'user', `m${i}`));
  const all = Buffer.from(lines.join(''));
  const growing = path.join(dir, 'growing.jsonl');
  fs.writeFileSync(growing, '');
  for (const cut of [37, 400, 401, 2500, 2503, 4000, all.length]) {
    fs.writeFileSync(growing, all.subarray(0, cut));
    const whole = path.join(dir, `whole-${cut}.jsonl`);          // the same bytes, never seen before
    fs.writeFileSync(whole, all.subarray(0, cut));
    assert.deepEqual(transcript.messages(growing, null, 200), transcript.messages(whole, null, 200), `cut at ${cut}`);
    fs.writeFileSync(growing, all.subarray(0, cut));
  }
});

test('growing step by step, the page keeps the old items and gains the new ones', () => {
  const file = path.join(dir, 'steps.jsonl');
  fs.writeFileSync(file, row('s0', null, 'user', 'step 0'));
  let ids = transcript.messages(file, null, 200).items.map((i) => i.id);
  for (let i = 1; i <= 5; i++) {
    fs.appendFileSync(file, row(`s${i}`, `s${i - 1}`, i % 2 ? 'assistant' : 'user', `step ${i}`));
    const page = transcript.messages(file, null, 200);
    const now = page.items.map((it) => it.id);
    assert.deepEqual(now.slice(0, ids.length), ids);
    assert.equal(now.length, ids.length + 1);
    const tail = transcript.messages(file, null, 200, null, ids[ids.length - 1]);   // what a poll asks for
    assert.deepEqual(tail.items.map((it) => it.text), [`step ${i}`]);
    ids = now;
  }
});
