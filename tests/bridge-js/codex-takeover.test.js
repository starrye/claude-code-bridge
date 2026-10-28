'use strict';

// Taking over the codex bundled in the OpenAI Codex extension: the swap, the fallback to the original, the
// restore. Uses a fake extension folder and AGENT_BRIDGE_HOME in a temp dir. Run: node --test tests/bridge-js/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
process.env.AGENT_BRIDGE_HOME = path.join(tmp, 'home');
const takeover = require('../../bridge-js/lib/codex-takeover');
const forward = require('../../bridge-js/lib/codex-forward');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeExtension(name = 'openai.chatgpt-26.1.0-linux-x64', pkg = { entrypoint: 'bin/codex', variant: 'codex' }, file = 'codex') {
  const dir = path.join(tmp, 'exts', name, 'bin', 'linux-x86_64');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), '#!/bin/sh\necho "original $*"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'codex-package.json'), JSON.stringify(pkg));
  return path.join(dir, file);
}

test('the bundled codex is swapped for the forwarder and the original kept beside it', { skip: process.platform === 'win32' }, () => {
  const bin = fakeExtension();
  const first = takeover.install(bin);
  assert.equal(first.state, 'installed');
  assert.equal(first.original, path.join(path.dirname(bin), 'codex.orig'));
  assert.ok(takeover.isWrapper(bin));
  assert.match(fs.readFileSync(first.original, 'utf8'), /original/);
  assert.ok(fs.existsSync(path.join(process.env.AGENT_BRIDGE_HOME, 'codex-forward.js')), 'the forwarder lives outside the extension');
  assert.equal(takeover.install(bin).state, 'present', 'a second start leaves it alone');
});

test('with no shared server the forwarder runs the original, arguments and all', { skip: process.platform === 'win32' }, () => {
  const bin = fakeExtension('openai.chatgpt-26.2.0-linux-x64');
  takeover.install(bin);
  fs.rmSync(forward.DESCRIPTOR, { force: true });
  assert.equal(execFileSync(bin, ['--version']).toString().trim(), 'original --version');
  assert.equal(execFileSync(bin, ['app-server', '--analytics-default-enabled']).toString().trim(), 'original app-server --analytics-default-enabled');
});

test('a shared server whose Bridge is gone is waited for, then the original runs', { skip: process.platform === 'win32' }, () => {
  const bin = fakeExtension('openai.chatgpt-26.3.0-linux-x64');
  takeover.install(bin);
  fs.mkdirSync(path.dirname(forward.DESCRIPTOR), { recursive: true });
  fs.writeFileSync(forward.DESCRIPTOR, JSON.stringify({ port: 1, token: 'x', bridgePid: 2 ** 22 + 12345, serverPid: 1 }));
  const started = Date.now();
  const out = spawnSync(bin, ['app-server'], { input: '', env: { ...process.env, AGENT_BRIDGE_CODEX_WAIT_MS: '1500' } }).stdout.toString().trim();
  assert.equal(out, 'original app-server');
  assert.ok(Date.now() - started >= 1400, 'a new Bridge is given time to start');
  assert.ok(Date.now() - started < 9000, 'then falls back');
});

test('the forwarder only takes `app-server` over stdio', () => {
  assert.equal(forward.servesStdio(['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled']), true);
  assert.equal(forward.servesStdio(['app-server', 'proxy']), false);
  assert.equal(forward.servesStdio(['app-server', '--listen', 'ws://127.0.0.1:1']), false);
  assert.equal(forward.servesStdio(['exec', 'hi']), false);
  assert.equal(forward.servesStdio(['--version']), false);
});

test('unknown layouts and binaries outside an extension are left alone', { skip: process.platform === 'win32' }, () => {
  const odd = fakeExtension('openai.chatgpt-27.0.0-linux-x64', { entrypoint: 'bin/codex2', variant: 'codex' });
  assert.deepEqual([takeover.install(odd).state, takeover.install(odd).reason], ['skipped', 'unknown_layout']);
  assert.ok(!takeover.isWrapper(odd));
  const loose = path.join(tmp, 'codex');
  fs.writeFileSync(loose, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(takeover.install(loose).reason, 'not_extension');
});

test('on Windows the codex.exe is swapped for a compiled launcher that falls back to the original', { skip: process.platform !== 'win32' }, () => {
  const bin = fakeExtension('openai.chatgpt-26.4.0-win32-x64', { entrypoint: 'bin/codex.exe', variant: 'codex' }, 'codex.exe');
  fs.copyFileSync(process.execPath, bin);                 // any exe that answers --version stands in for codex
  const first = takeover.install(bin);
  assert.equal(first.state, 'installed');
  assert.ok(first.original.endsWith('codex.orig.exe') && fs.existsSync(first.original));
  assert.ok(takeover.isWrapper(bin));
  assert.equal(takeover.install(bin).state, 'present');
  // no shared server running: the launcher runs the original with the arguments unchanged
  const out = require('node:child_process').spawnSync(bin, ['--version'], { encoding: 'utf8', env: { ...process.env, AGENT_BRIDGE_HOME: path.join(tmp, 'nohome') } });
  assert.equal(out.stdout.trim(), process.version);
  assert.equal(takeover.restoreAll(path.dirname(path.dirname(path.dirname(path.dirname(bin))))).length, 1);
  assert.ok(!takeover.isWrapper(bin) && fs.existsSync(bin));
});

test('uninstall puts every original back and removes the forwarder', { skip: process.platform === 'win32' }, () => {
  const bin = fakeExtension('openai.chatgpt-26.5.0-linux-x64');
  takeover.install(bin);
  const restored = takeover.uninstall(path.join(tmp, 'exts'));
  assert.ok(restored.length >= 1);
  for (const name of fs.readdirSync(path.join(tmp, 'exts'))) {
    const file = path.join(tmp, 'exts', name, 'bin', 'linux-x86_64', 'codex');
    assert.ok(!takeover.isWrapper(file), `${name} restored`);
    assert.ok(!fs.existsSync(`${file}.orig`));
  }
  assert.ok(!fs.existsSync(path.join(process.env.AGENT_BRIDGE_HOME, 'codex-forward.js')));
});

// A tiny WebSocket app-server: records what it receives, answers requests, can be shut down
function fakeShared(token, onMessage) {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    if (req.headers.authorization !== `Bearer ${token}`) { socket.end('HTTP/1.1 401 x\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    const send = (obj) => { const b = Buffer.from(JSON.stringify(obj)); socket.write(Buffer.concat([Buffer.from([0x81, b.length < 126 ? b.length : 126]), b.length < 126 ? Buffer.alloc(0) : Buffer.from([b.length >> 8, b.length & 255]), b])); };
    let buf = Buffer.alloc(0);
    socket.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 6) {
        let len = buf[1] & 127; let at = 2;
        if (len === 126) { len = buf.readUInt16BE(2); at = 4; }
        if (buf.length < at + 4 + len) return;
        const mask = buf.subarray(at, at + 4); const body = Buffer.from(buf.subarray(at + 4, at + 4 + len));
        for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];
        const op = buf[0] & 15; buf = buf.subarray(at + 4 + len);
        if (op === 1) onMessage(JSON.parse(body.toString()), send);
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}

test('when the shared server restarts the forwarder reconnects and replays the handshake', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const token = 'tok';
  const seen = [];
  const answer = (tag) => (msg, send) => {
    seen.push(`${tag}:${msg.method}`);
    if (msg.id == null) return;
    if (msg.method === 'thread/start') send({ id: msg.id, result: { thread: { id: 'T1' } } });
    else if (msg.method === 'slow') return;            // never answered: in flight when the server dies
    else send({ id: msg.id, result: { ok: tag } });
  };
  const first = await fakeShared(token, answer('A'));
  fs.mkdirSync(path.dirname(forward.DESCRIPTOR), { recursive: true });
  fs.writeFileSync(forward.DESCRIPTOR, JSON.stringify({ port: first.port, token, bridgePid: process.pid, serverPid: 1 }));
  const child = spawn(process.execPath, [path.join(__dirname, '../../bridge-js/lib/codex-forward.js'), '/bin/false', 'app-server'],
    { env: { ...process.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let rest = '';
  child.stdout.on('data', (c) => { rest += c; let i; while ((i = rest.indexOf('\n')) >= 0) { lines.push(JSON.parse(rest.slice(0, i))); rest = rest.slice(i + 1); } });
  const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(fn()); };
  const write = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'vscode' } } });
  write({ method: 'initialized' });
  write({ id: 2, method: 'thread/start', params: {} });
  write({ id: 3, method: 'slow', params: {} });
  await until(() => lines.some((l) => l.id === 2));

  const second = await fakeShared(token, answer('B'));
  fs.writeFileSync(forward.DESCRIPTOR, JSON.stringify({ port: second.port, token, bridgePid: process.pid, serverPid: 1 }));
  first.close();
  await until(() => lines.some((l) => l.id === 3 && l.error));
  write({ id: 4, method: 'thread/read', params: { threadId: 'T1' } });
  await until(() => lines.some((l) => l.id === 4));

  assert.deepEqual(lines.find((l) => l.id === 4).result, { ok: 'B' }, 'later requests go to the new server');
  assert.deepEqual(seen.filter((s) => s.startsWith('B:')), ['B:initialize', 'B:initialized', 'B:thread/resume', 'B:thread/read']);
  assert.equal(lines.filter((l) => l.id === 1).length, 1, 'the replayed initialize is not answered to the editor twice');
  assert.equal(child.exitCode, null, 'the forwarder is still running');
  child.kill(); second.close();
});
