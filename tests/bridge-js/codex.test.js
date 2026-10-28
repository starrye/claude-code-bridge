'use strict';

// The Bridge driving Codex through tests/bridge-js/fake-codex.js (no API calls). Run: node --test tests/bridge-js/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const TOKEN = 't'.repeat(32);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-it-'));
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
fs.mkdirSync(path.join(tmp, 'projects'));
const fake = path.join(tmp, 'codex');
fs.writeFileSync(fake, `#!/bin/sh\nexec ${process.execPath} ${path.join(__dirname, 'fake-codex.js')} "$@"\n`, { mode: 0o755 });
const stateFile = path.join(tmp, 'codex-state.json');
const LOCKED_ID = '0199aaaa-0000-7000-8000-000000000001';
fs.writeFileSync(stateFile, JSON.stringify({ threads: { [LOCKED_ID]: {
  id: LOCKED_ID, cwd: work, preview: 'editor thread', createdAt: 1, updatedAt: 2, source: 'vscode',
  turns: [{ id: 't0', startedAt: 1, items: [{ type: 'userMessage', id: 'u0', content: [{ type: 'text', text: 'hello' }] }, { type: 'agentMessage', id: 'a0', text: 'hi there' }] }],
} } }));

let proc;
let base;
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body) {
  const response = await fetch(base + url, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return [response.status, await response.json()];
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error('timed out');
}

const task = async (id) => (await call('GET', `/tasks/${id}`))[1];
const finished = (id) => until(async () => { const t = await task(id); return t.finished_at ? t : null; });
const codexSessions = async () => { const list = (await call('GET', '/sessions'))[1].sessions.filter((s) => s.agent === 'codex'); return list.length ? list : null; };

test.before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bridge-js', 'server.js')], { stdio: 'ignore', env: {
    ...process.env, BRIDGE_PORT: String(port), BRIDGE_TOKEN: TOKEN, BRIDGE_STATE_DIR: path.join(tmp, 'state'), BRIDGE_WORKSPACE: work,
    CLAUDE_PROJECTS_DIR: path.join(tmp, 'projects'), CLAUDE_SESSIONS_DIR: path.join(tmp, 'projects'), CLAUDE_BIN: '/bin/false',
    CODEX_BIN: fake, FAKE_CODEX_STATE: stateFile, FAKE_CODEX_LOCKED: LOCKED_ID, BRIDGE_APPROVAL_TIMEOUT: '30',
  } });
  await until(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } });
});
test.after(() => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('codex threads in the workspace are listed beside claude sessions', async () => {
  const [, body] = await call('GET', '/sessions');
  assert.ok(body.agents.includes('codex'));
  const listed = await until(codexSessions);
  const editor = listed.find((s) => s.session_id === LOCKED_ID);
  assert.ok(editor);
  assert.equal(editor.title, 'editor thread');
  assert.equal(editor.source, 'codex-vscode');
});

test('a codex transcript reads as page messages', async () => {
  await until(codexSessions);
  const [status, page] = await call('GET', `/sessions/${LOCKED_ID}/messages`);
  assert.equal(status, 200);
  assert.deepEqual(page.items.map((i) => [i.role, i.text]), [['user', 'hello'], ['assistant', 'hi there']]);
});

test('a new codex task runs and streams its answer', async () => {
  const [status, created] = await call('POST', '/tasks', { agent: 'codex', prompt: 'ping', cwd: work });
  assert.equal(status, 202);
  const done = await finished(created.task_id);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.events.some((e) => e.event_type === 'text' && e.text === 'echo: ping'));
  const listed = await until(async () => (await codexSessions()).find((s) => s.session_id === done.session_id));
  assert.equal(listed.title, 'ping');
  const [again, next] = await call('POST', '/tasks', { prompt: 'pong', session_id: done.session_id });
  assert.equal(again, 202, 'a reply to a codex session without "agent" goes to codex, as the page sends it');
  assert.equal((await finished(next.task_id)).status, 'succeeded');
});

test('a thread open in the editor is refused, and forked when asked', async () => {
  await until(codexSessions);
  const [, refused] = await call('POST', '/tasks', { agent: 'codex', prompt: 'more', session_id: LOCKED_ID });
  const failed = await finished(refused.task_id);
  assert.equal(failed.error, 'editor_locked');
  const [, forked] = await call('POST', '/tasks', { agent: 'codex', prompt: 'more', session_id: LOCKED_ID, force: true });
  const done = await finished(forked.task_id);
  assert.equal(done.status, 'succeeded');
  assert.notEqual(done.session_id, LOCKED_ID);
  assert.ok(done.events.some((e) => e.event_type === 'session' && e.forked_from === LOCKED_ID));
});

test('a command needs approval from the phone', async () => {
  const [, created] = await call('POST', '/tasks', { agent: 'codex', prompt: 'run ls -la', cwd: work });
  const pending = await until(async () => (await call('GET', '/approvals'))[1].approvals.find((a) => a.task_id === created.task_id));
  assert.equal(pending.tool_name, 'Bash');
  assert.equal(pending.summary.command, 'ls -la');
  await call('POST', `/approvals/${pending.approval_id}`, { decision: 'allow' });
  const done = await finished(created.task_id);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.events.some((e) => e.event_type === 'tool_finished' && e.is_error === false));
});

test('a running turn can be steered, and interrupted', async () => {
  const [, created] = await call('POST', '/tasks', { agent: 'codex', prompt: 'slow', cwd: work });
  await until(async () => (await task(created.task_id)).status === 'running');
  await sleep(200);
  const [status] = await call('POST', `/tasks/${created.task_id}/steer`, { prompt: 'also this' });
  assert.equal(status, 200);
  const done = await finished(created.task_id);
  assert.ok(done.events.some((e) => e.event_type === 'text' && e.text === 'echo: slow + also this'));

  const [, second] = await call('POST', '/tasks', { agent: 'codex', prompt: 'slow', cwd: work });
  await until(async () => (await task(second.task_id)).status === 'running');
  await sleep(200);
  await call('POST', `/tasks/${second.task_id}/cancel`);
  assert.equal((await finished(second.task_id)).status, 'cancelled');
});

test('codex efforts and models come from codex', async () => {
  const [, catalog] = await call('GET', '/commands?agent=codex');
  assert.deepEqual(catalog.models, ['gpt-fake']);
  assert.ok(catalog.efforts.includes('minimal'));
  const [bad] = await call('POST', `/sessions/${LOCKED_ID}/prefs`, { effort: 'max' });
  assert.equal(bad, 400);
});

test('codex skills are listed, can be invoked with /name, and /status reports limits', async () => {
  const [, catalog] = await call('GET', `/commands?agent=codex&cwd=${encodeURIComponent(work)}`);
  const skill = catalog.commands.find((c) => c.name === 'fake-skill');
  assert.deepEqual(skill, { name: 'fake-skill', kind: 'skill', desc: 'does fake things' });
  assert.ok(!catalog.commands.some((c) => c.name === 'off-skill'));
  assert.ok(catalog.commands.some((c) => c.name === 'status' && c.kind === 'codex'));

  const [, created] = await call('POST', '/tasks', { agent: 'codex', prompt: '/fake-skill do it', cwd: work });
  const done = await finished(created.task_id);
  assert.ok(done.events.some((e) => e.event_type === 'text' && e.text === 'echo: [skill fake-skill /skills/fake-skill/SKILL.md] $fake-skill do it'));
  const [, plain] = await call('POST', '/tasks', { agent: 'codex', prompt: '/not-a-skill x', cwd: work });
  assert.ok((await finished(plain.task_id)).events.some((e) => e.event_type === 'text' && e.text === 'echo: /not-a-skill x'));

  const [code, status] = await call('GET', `/sessions/${done.session_id}/status`);
  assert.equal(code, 200);
  assert.equal(status.session_id, done.session_id);
  assert.deepEqual(status.limits.map((l) => [l.used_percent, l.window_mins]), [[12.4, 300], [40, 10080]]);
});

test('review, compact, goal and feedback work on a Codex session', async () => {
  const [, first] = await call('POST', '/tasks', { agent: 'codex', prompt: 'hi', cwd: work });
  const sid = (await finished(first.task_id)).session_id;

  const [bad] = await call('POST', '/tasks', { agent: 'codex', session_id: sid, review: { type: 'baseBranch', branch: '--evil rm' } });
  assert.equal(bad, 400);
  const [, review] = await call('POST', '/tasks', { agent: 'codex', session_id: sid, review: { type: 'baseBranch', branch: 'main' } });
  const done = await finished(review.task_id);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.events.some((e) => e.event_type === 'text' && e.text === 'echo: review:baseBranch:main'));
  const [, whole] = await call('POST', '/tasks', { agent: 'codex', session_id: sid, review: { type: 'uncommittedChanges' } });
  assert.equal((await finished(whole.task_id)).status, 'succeeded');

  assert.equal((await call('POST', `/sessions/${sid}/compact`, {}))[0], 200);

  assert.deepEqual((await call('GET', `/sessions/${sid}/goal`))[1], { goal: null });
  const [, set] = await call('POST', `/sessions/${sid}/goal`, { action: 'set', objective: 'ship it', token_budget: 5000 });
  assert.equal(set.goal.objective, 'ship it');
  assert.equal(set.goal.tokenBudget, 5000);
  const [, paused] = await call('POST', `/sessions/${sid}/goal`, { action: 'pause' });
  assert.equal(paused.goal.status, 'paused');
  assert.equal((await call('POST', `/sessions/${sid}/goal`, { action: 'set', objective: '' }))[0], 400);
  await call('POST', `/sessions/${sid}/goal`, { action: 'clear' });
  assert.deepEqual((await call('GET', `/sessions/${sid}/goal`))[1], { goal: null });

  assert.equal((await call('POST', `/sessions/${sid}/feedback`, { classification: 'nope' }))[0], 400);
  assert.equal((await call('POST', `/sessions/${sid}/feedback`, { classification: 'bug', reason: 'broken' }))[0], 200);
});

test('a thread no client has loaded shows as closed only while the editor shares the server', () => {
  const { statusOf } = require('../../bridge-js/lib/agent-codex');
  const t = (type) => ({ status: { type } });
  assert.equal(statusOf(t('active'), true), 'busy');
  assert.equal(statusOf(t('idle'), true), 'idle');
  assert.equal(statusOf(t('notLoaded'), true), 'closed');
  assert.equal(statusOf(t('notLoaded'), false), 'idle');
  assert.equal(statusOf({}, true), 'idle');
});
