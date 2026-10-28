'use strict';

// Stands in for the `codex` the OpenAI Codex extension runs. `codex app-server` (stdio) is forwarded to the shared
// app-server the Bridge runs, so the editor panel and the phone write the same threads. Anything else, or no
// reachable shared server, runs the original binary unchanged: Codex keeps working without the Bridge.
//
//   node codex-forward.js <original codex> <codex arguments...>
//
// Self-contained (only Node built-ins): it is copied to ~/.agent-bridge/ and must keep working after the
// extension is gone.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DIR = process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.agent-bridge');
const DESCRIPTOR = path.join(DIR, 'codex-shared.json');
const WAIT_MS = Number(process.env.AGENT_BRIDGE_CODEX_WAIT_MS) || 30000;          // how long a Bridge that is not up yet is waited for (the editor starts Codex at the same moment)
// An open editor panel cannot start over, so after losing the server it waits longer for the Bridge to come back
// (a plugin update restarts it, and that can take a minute) instead of making the panel show "could not start".
const RECONNECT_WAIT_MS = 120000;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readDescriptor() {
  try {
    const d = JSON.parse(fs.readFileSync(DESCRIPTOR, 'utf8'));
    return d && Number.isInteger(d.port) && typeof d.token === 'string' ? d : null;
  } catch {
    return null;
  }
}

// Minimal WebSocket client (text frames, ping, close). Resolves once the handshake succeeds.
function connect(port, token, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let head = Buffer.alloc(0);
    let open = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeoutMs);
    socket.once('error', (e) => { clearTimeout(timer); if (!open) reject(e); });
    socket.on('connect', () => socket.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`));
    const onHead = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onHead);
      clearTimeout(timer);
      const status = head.subarray(0, head.indexOf('\r\n')).toString();
      if (!/^HTTP\/1\.1 101 /.test(status)) { socket.destroy(); reject(new Error(status)); return; }
      open = true;
      resolve(wrap(socket, head.subarray(end + 4)));
    };
    socket.on('data', onHead);
  });
}

function wrap(socket, rest) {
  const ws = { onmessage: () => {}, onclose: () => {} };
  let buf = rest;
  let parts = [];
  const frame = (op, payload) => {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len])
      : len < 65536 ? Buffer.concat([Buffer.from([0x80 | op, 0x80 | 126]), Buffer.from([len >> 8, len & 255])])
        : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    socket.write(Buffer.concat([head, mask, body]));
  };
  ws.send = (text) => frame(1, Buffer.from(text));
  ws.close = () => { try { frame(8, Buffer.alloc(0)); } catch { /* gone */ } socket.end(); };
  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const op = buf[0] & 15;
      let len = buf[1] & 127;
      let at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf[1] & 0x80) at += 4;                          // servers do not mask, but tolerate it
      if (buf.length < at + len) return;
      const payload = buf.subarray(at, at + len);
      buf = buf.subarray(at + len);
      if (op === 8) { socket.end(); return; }
      if (op === 9) { frame(10, payload); continue; }
      if (op === 0 || op === 1) {
        parts.push(payload);
        if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; ws.onmessage(text); }
      }
    }
  };
  socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); parse(); });
  socket.on('close', () => ws.onclose());
  socket.on('error', () => {});
  if (buf.length) setImmediate(parse);
  return ws;
}

// `codex [global options] app-server [flags]` over stdio, the only call worth forwarding
function servesStdio(args) {
  const at = args.indexOf('app-server');
  if (at < 0) return false;
  const after = args.slice(at + 1);
  if (after.some((a) => !a.startsWith('-'))) return false;               // a subcommand: proxy, daemon, generate-ts, ...
  return !after.some((a) => a === '--listen' || a.startsWith('--listen=')) || after.includes('stdio://');
}

// The shared server to use, waiting while a Bridge is (re)starting. The editor starts its Codex while VS Code is still
// starting the Bridge, so a record left by an earlier Bridge (stopped or killed, however long ago) is waited for too;
// only when no Bridge ever took over is there nothing to wait for. patient: an open panel keeps waiting regardless.
async function sharedServer(waitMs = WAIT_MS, patient = false) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const d = readDescriptor();
    if (!d && !patient) return null;
    if (d && !d.stoppedAt && Number.isInteger(d.bridgePid) && alive(d.bridgePid)) {
      try { return await connect(d.port, d.token); } catch { /* not listening yet */ }
    }
    if (Date.now() > deadline) return null;
    await sleep(300);
  }
}

function runOriginal(original, args) {
  const child = spawn(original, args, { stdio: 'inherit', windowsHide: true });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (e) => { process.stderr.write(`codex: ${e.message}\n`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
}

// The shared server restarts when the Bridge does. The editor cannot redo its handshake, so the forwarder
// reconnects, replays initialize and the thread subscriptions itself, and fails requests that were in flight.
function pipe(first) {
  let ws = null;
  let queue = [];
  let init = null;
  let initialized = null;
  let replayId = 0;
  const pending = new Map();      // editor request id -> method
  const threads = new Set();      // threads this editor follows
  const replay = new Set();       // ids of requests the forwarder sent itself
  const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const send = (line) => (ws ? ws.send(line) : queue.push(line));

  const fromServer = (text) => {
    let msg = null;
    try { msg = JSON.parse(text); } catch { /* pass through */ }
    if (msg && msg.id != null && !msg.method) {
      if (replay.delete(msg.id)) return;
      const method = pending.get(msg.id);
      pending.delete(msg.id);
      const id = msg.result && msg.result.thread && msg.result.thread.id;
      if (id && /^thread\/(start|resume|fork)$/.test(method || '')) threads.add(id);
    }
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  };

  const attach = (socket) => {
    ws = socket;
    ws.onmessage = fromServer;
    ws.onclose = () => reconnect();
  };

  const reconnect = async () => {
    ws = null;
    for (const [id] of pending) out({ id, error: { code: -32000, message: 'Codex server restarted, please retry' } });
    pending.clear();
    const socket = await sharedServer(RECONNECT_WAIT_MS, true);
    if (!socket) process.exit(1);                        // no shared server any more: the editor shows its error
    const internal = (method, params) => {
      const id = `agent-bridge-replay-${++replayId}`;
      replay.add(id);
      socket.send(JSON.stringify({ id, method, params }));
    };
    if (init) internal('initialize', init.params);
    if (initialized) socket.send(initialized);
    for (const threadId of threads) internal('thread/resume', { threadId });
    attach(socket);
    const waiting = queue;
    queue = [];
    for (const line of waiting) fromEditor(line);
  };

  const fromEditor = (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch { /* pass through */ }
    if (msg && msg.method === 'initialize') init = msg;
    if (msg && msg.method === 'initialized') initialized = line;
    if (msg && msg.id != null && msg.method) pending.set(msg.id, msg.method);
    if (msg && msg.method === 'thread/unsubscribe' && msg.params) threads.delete(msg.params.threadId);
    send(line);
  };

  attach(first);
  process.stdout.on('error', () => process.exit(0));
  let rest = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    rest += chunk;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (line) fromEditor(line);
    }
  });
  process.stdin.on('end', () => { if (ws) ws.close(); setTimeout(() => process.exit(0), 200); });
}

async function main() {
  const [original, ...args] = process.argv.slice(2);
  if (!original) { process.stderr.write('usage: codex-forward.js <original codex> [args]\n'); process.exit(2); }
  // stdin is not touched before this decision, so the original binary still gets all of it
  const ws = servesStdio(args) ? await sharedServer() : null;
  if (ws) pipe(ws); else runOriginal(original, args);
}

if (require.main === module) main();

module.exports = { connect, servesStdio, readDescriptor, DESCRIPTOR, DIR };
