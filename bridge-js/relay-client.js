'use strict';

// Relay client: binds this computer with a QR code once, then keeps idle tunnels open to the relay and splices each
// woken tunnel to the local Bridge. Port of the client half of relay.py; the server half stays in Python.
//
//   node relay-client.js --relay https://HOST:9010 --target 127.0.0.1:8787     (encrypted; tunnel address is learned)
//   node relay-client.js --relay HOST:PORT --target 127.0.0.1:8787              (plain TCP: development only)
//
// The lines printed during binding are read by the VS Code extension; keep their wording.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const qr = require('./lib/qr');

const MAGIC = Buffer.from('\x00RELAY2', 'latin1');
const WAKE = 0x47;                                      // "G"
const NONCE = 16;
const HANDSHAKE_TIMEOUT = 5000;
const ENROLL_TTL = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const two = (n) => String(n).padStart(2, '0');

function log(message) {
  const now = new Date();
  process.stdout.write(`${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())} ${message}\n`);
}

const out = (text) => process.stdout.write(`${text}\n`);

function splitAddr(text) {
  const at = text.lastIndexOf(':');
  const port = Number(text.slice(at + 1));
  if (at < 0 || !/^\d+$/.test(text.slice(at + 1))) throw new Error(`bad address ${text}`);
  return [text.slice(0, at) || '0.0.0.0', port];
}

function isLoopbackHost(host) {
  if (host === 'localhost' || host === 'ip6-localhost') return true;
  const bare = host.replace(/^\[+|\]+$/g, '');
  if (net.isIPv4(bare)) return bare.startsWith('127.');
  if (net.isIPv6(bare)) {
    const blocks = new net.BlockList();
    blocks.addAddress('::1', 'ipv6');
    return blocks.check(bare, 'ipv6');
  }
  return false;
}

const proof = (secret, nonce) => crypto.createHmac('sha256', secret).update(nonce).digest();

function caOption() {
  const file = process.env.RELAY_CA_FILE;
  return file ? { ca: fs.readFileSync(file) } : {};
}

const CERT_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED',
  'CERT_REJECTED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_SIGNATURE_FAILURE', 'INVALID_CA']);

let lastHttpError = '';                                 // why the most recent request failed before getting any HTTP status

function describeError(error) {
  if (error && CERT_CODES.has(error.code)) {
    return `the server certificate is not trusted (${error.message}); set RELAY_CA_FILE for a private CA`;
  }
  return (error && (error.message || error.code)) || String(error);
}

// [status, body]; status 0 when no HTTP answer came back (reason in lastHttpError)
function postJson(url, payload) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      lastHttpError = describeError(error);
      resolve([0, {}]);
      return;
    }
    const body = payload === null ? null : Buffer.from(JSON.stringify(payload));
    const lib = target.protocol === 'https:' ? https : http;
    let options;
    try {
      options = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': body.length } : {}) },
        timeout: 10000, ...(target.protocol === 'https:' ? caOption() : {}) };
    } catch (error) {
      lastHttpError = describeError(error);
      resolve([0, {}]);
      return;
    }
    const request = lib.request(target, options, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            lastHttpError = 'bad JSON in the reply';
            resolve([0, {}]);
            return;
          }
        }
        resolve([response.statusCode, parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}]);
      });
      response.on('error', (error) => {
        lastHttpError = describeError(error);
        resolve([0, {}]);
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => {
      lastHttpError = describeError(error);
      resolve([0, {}]);
    });
    request.end(body || undefined);
  });
}

const getJson = (url) => postJson(url, null);

// "tls://host:port" or "host:port" -> [[host, port], host to verify or null for plain TCP]
function parseTunnel(text) {
  const secure = text.startsWith('tls://');
  const match = /^([^\s:/]+):(\d{1,5})$/.exec(secure ? text.slice(6) : text);
  if (!match || !(Number(match[2]) > 0 && Number(match[2]) < 65536)) return null;
  return [[match[1], Number(match[2])], secure ? match[1] : null];
}

// Ask the relay, over verified HTTPS, where its tunnel listens. Retries until it answers.
async function resolveTunnel(webBase, stop) {
  let delay = 1;
  while (!stop.stopped) {
    const [status, config] = await getJson(`${webBase}/auth/config`);
    const parsed = status === 200 && typeof config.tunnel === 'string' ? parseTunnel(config.tunnel) : null;
    if (parsed) return parsed;
    const why = status === 0 && lastHttpError ? `: ${lastHttpError}` : '';
    log(`cannot learn the tunnel address from ${webBase} (status ${status}${why}); retry in ${delay}s`);
    await stop.wait(delay * 1000);
    delay = Math.min(delay * 2, 30);
  }
  return null;
}

// Buffered reads over a socket, for the handshake
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiting = null;
    this.ended = false;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.kick();
    };
    this.onEnd = () => {
      this.ended = true;
      this.kick();
    };
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
  }

  kick() {
    if (this.waiting) this.waiting();
  }

  // Exactly count bytes, or null on EOF; rejects after timeout (ms) when given
  read(count, timeout = 0) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const check = () => {
        if (this.buffer.length >= count) {
          const data = this.buffer.subarray(0, count);
          this.buffer = this.buffer.subarray(count);
          done();
          resolve(data);
        } else if (this.ended) {
          done();
          resolve(null);
        }
      };
      const done = () => {
        this.waiting = null;
        if (timer) clearTimeout(timer);
      };
      if (timeout) timer = setTimeout(() => { done(); reject(new Error('timed out')); }, timeout);
      this.waiting = check;
      check();
    });
  }

  // Stop reading here; returns what was buffered past the last read
  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

function connect([host, port], tlsHost) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.destroy();
      reject(error);
    };
    const socket = tlsHost
      ? tls.connect({ host, port, servername: tlsHost, ...caOption() }, () => { socket.setTimeout(0); socket.off('error', onError); resolve(socket); })
      : net.connect({ host, port }, () => { socket.setTimeout(0); socket.off('error', onError); resolve(socket); });
    socket.setTimeout(10000, () => onError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    socket.on('error', onError);
  });
}

function splice(a, b, head) {
  const close = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', close);
  b.on('error', close);
  a.on('close', close);
  b.on('close', close);
  if (head.length) b.write(head);
  a.pipe(b);
  b.pipe(a);
}

// One idle tunnel at a time: connect, authenticate, wait for the relay to wake it, splice it to the Bridge, repeat
async function tunnelWorker(relayAddr, targetAddr, connectorId, secret, stop, tlsHost) {
  let delay = 1;
  const ident = Buffer.from(connectorId, 'ascii');
  while (!stop.stopped) {
    let conn = null;
    try {
      conn = await connect(relayAddr, tlsHost);
      conn.on('error', () => {});
      stop.track(conn);
      const reader = new Reader(conn);
      conn.write(Buffer.concat([MAGIC, Buffer.from([ident.length]), ident]));
      const nonce = await reader.read(NONCE, HANDSHAKE_TIMEOUT);
      if (nonce === null) throw new Error('no challenge');
      conn.write(proof(secret, nonce));
      const ok = await reader.read(2, HANDSHAKE_TIMEOUT);
      if (ok === null || ok.toString('latin1') !== 'OK') {
        throw new Error('authentication refused; if this computer was removed on the server, run with --enroll');
      }
      conn.setKeepAlive(true, 30000);
      delay = 1;
      const wake = await reader.read(1);
      if (wake === null || wake[0] !== WAKE) {
        conn.destroy();
        continue;
      }
      const head = reader.detach();
      conn.pause();
      const local = await connect(targetAddr, null).catch((error) => {
        conn.destroy();
        throw error;
      });
      stop.untrack(conn);
      splice(conn, local, head);
      conn.resume();
    } catch (error) {
      if (conn) {
        stop.untrack(conn);
        conn.destroy();
      }
      if (stop.stopped) return;
      await stop.wait(delay * 1000);
      if (stop.stopped) return;
      log(`tunnel retry in ${delay}s (${error.message || error.code})`);
      delay = Math.min(delay * 2, 30);
    }
  }
}

const NOTIFY_MIN_SECONDS = Number(process.env.RELAY_NOTIFY_MIN_SECONDS || '20');   // a task shorter than this is not worth a message
const bridgeAccess = (secret) => crypto.createHmac('sha256', secret).update('bridge-access').digest('hex');

// Turns a Bridge task event into [kind, tool, sessionId] for the relay, or null when it is not worth a message
function notifyOf(event, started) {
  const kind = event.event_type;
  const task = String(event.task_id || '');
  const session = String(event.session_id || '');
  if (kind === 'task_started') {
    started.set(task, Number(event.ts) || Date.now() / 1000);
    while (started.size > 200) started.delete(started.keys().next().value);
  } else if (kind === 'task_finished') {
    const began = started.get(task);
    started.delete(task);
    if ((event.status === 'succeeded' || event.status === 'failed') && began !== undefined
        && (Number(event.ts) || Date.now() / 1000) - began >= NOTIFY_MIN_SECONDS) {
      return [event.status === 'succeeded' ? 'done' : 'failed', '', session];
    }
  } else if (kind === 'approval_requested') {
    return ['approval', String(event.tool_name || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40), session];
  }
  return null;
}

const oneLine = (text, limit) => Array.from(String(text ?? '').split(/\s+/).filter(Boolean).join(' ')).slice(0, limit).join('');

function signNotify(connectorId, secret, kind, tool, stamp, windowName = '', title = '', session = '') {
  // the relay formats the timestamp the way Python does: a float always shows a decimal point
  const shown = Number.isInteger(stamp) ? `${stamp}.0` : String(stamp);
  const material = ['notify', connectorId, shown, kind, tool, windowName, title, session].join('\n');
  const sig = crypto.createHmac('sha256', secret).update(material).digest('hex');
  return { id: connectorId, ts: stamp, kind, tool, window: windowName, title, session, sig };
}

// [folder name, session title] for a session id, asked of the local Bridge; ['', ''] when unknown
function describeSession(targetAddr, secret, session) {
  if (!session) return Promise.resolve(['', '']);
  return new Promise((resolve) => {
    const request = http.get({ host: targetAddr[0], port: targetAddr[1], path: '/sessions', timeout: 5000,
      headers: { Authorization: `Bearer ${bridgeAccess(secret)}` } }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        try {
          const data = response.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          const item = (data.sessions || []).find((x) => x && x.session_id === session);
          if (item) {
            const folder = String(item.root || item.cwd || '').replace(/\/+$/, '');
            resolve([oneLine(folder.split('/').pop(), 60), oneLine(item.title || item.name, 80)]);
            return;
          }
        } catch { /* fall through */ }
        resolve(['', '']);
      });
      response.on('error', () => resolve(['', '']));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(['', '']));
  });
}

// Follows the local Bridge's event stream and tells the relay when a task ends or an approval is waiting. The relay
// decides whether anyone is messaged (the phone's switch, default off). What leaves this computer is the kind, a tool
// name, the folder name and the session title (so the message says which window and session it is about); never the
// conversation itself.
async function watchBridge(webBase, targetAddr, connectorId, secret, stop) {
  const started = new Map();
  let delay = 1000;
  while (!stop.stopped) {
    await new Promise((resolve) => {
      let chain = Promise.resolve();            // events are reported one after another, in order
      const request = http.get({ host: targetAddr[0], port: targetAddr[1], path: '/events',
        headers: { Authorization: `Bearer ${bridgeAccess(secret)}` } }, (response) => {
        if (response.statusCode !== 200) { response.resume(); resolve(); return; }
        delay = 1000;
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            let name = '';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (name !== 'task' || !data) continue;
            let event;
            try { event = JSON.parse(data); } catch { continue; }
            const found = event && typeof event === 'object' ? notifyOf(event, started) : null;
            if (!found) continue;
            const [kind, tool, session] = found;
            chain = chain.then(async () => {
              const [windowName, title] = await describeSession(targetAddr, secret, session);
              await postJson(`${webBase}/notify/event`, signNotify(connectorId, secret, kind, tool, Date.now() / 1000, windowName, title, session));
            });
          }
        });
        response.on('end', resolve);
        response.on('error', resolve);
      });
      request.on('error', resolve);
      stop.track(request);
      request.on('close', () => stop.untrack(request));
    });
    if (stop.stopped) return;
    await stop.wait(delay);
    delay = Math.min(delay * 2, 30000);
  }
}

const stateDir = () => process.env.BRIDGE_STATE_DIR || `/tmp/claude-bridge-${process.getuid ? process.getuid() : 0}`;

function readEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/)) {
    const at = line.indexOf('=');
    if (at >= 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

function loadCreds(file) {
  let values;
  try {
    values = readEnvFile(file);
  } catch {
    return null;
  }
  const id = (values.RELAY_ID || '').trim();
  const secret = (values.RELAY_SECRET || '').trim();
  return id && secret.length >= 24 ? [id, secret] : null;
}

function saveCreds(file, connectorId, secret) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file.replace(/\.[^./]*$/, '') + '.tmp';
  fs.writeFileSync(tmp, `RELAY_ID=${connectorId}\nRELAY_SECRET=${secret}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// Ask the relay to bind this computer, show a QR code, wait for a Feishu user to confirm
async function enroll(baseUrl, name, credsPath, { timeout = ENROLL_TTL, interval = 2 } = {}) {
  const secret = crypto.randomBytes(32).toString('base64url');
  if (baseUrl.startsWith('http://')) {
    let host = '';
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      // leave empty
    }
    if (!isLoopbackHost(host)) out('警告:正在通过未加密的 HTTP 绑定,新生成的连接器密钥会明文经过网络。请让管理员提供 https:// 形式的中继地址。');
  }
  const base = baseUrl.replace(/\/+$/, '');
  const [status, started] = await postJson(`${base}/enroll/start`, { name, secret });
  if (status !== 200) {
    const why = status === 0 && lastHttpError ? `,${lastHttpError}` : '';
    out(`无法向服务器申请绑定(状态 ${status}${why})。${status === 429 ? '申请过于频繁,请稍后再试。' : '请检查 --relay 地址。'}`);
    return null;
  }
  const link = started.url;
  out('请用飞书扫描二维码,在手机上确认绑定:\n');
  try {
    out(qr.render(link));
  } catch {
    out('(链接太长,无法显示二维码)');
  }
  out(`\n无法扫码时,把这个链接发到飞书里点开: ${link}`);
  out(`手机上显示的校验码应为: ${started.verify}    电脑名称: ${started.name}`);
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const [, reply] = await postJson(`${base}/enroll/poll`, { enroll_id: started.enroll_id, poll_key: started.poll_key });
    if (reply.status === 'claimed') {
      saveCreds(credsPath, reply.connector_id, secret);
      out(`绑定成功,凭证已保存到 ${credsPath}`);
      return [reply.connector_id, secret];
    }
    if (reply.status === 'expired') break;
  }
  out('二维码已过期,请重新运行。');
  return null;
}

// Cooperative stop: wait() resolves early when stopped; tracked idle sockets are closed
function makeStop() {
  const waiters = new Set();
  const sockets = new Set();
  return {
    stopped: false,
    wait(ms) {
      if (this.stopped) return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); waiters.delete(finish); resolve(); };
        const timer = setTimeout(finish, ms);
        waiters.add(finish);
      });
    },
    track: (socket) => sockets.add(socket),
    untrack: (socket) => sockets.delete(socket),
    stop() {
      this.stopped = true;
      for (const finish of [...waiters]) finish();
      for (const socket of sockets) socket.destroy();
    },
  };
}

function parseArgs(argv) {
  const args = { relay: '', target: '127.0.0.1:8787', id: '', name: '', creds: '', enroll: false, pool: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === 'client') continue;                     // accepted for symmetry with `relay.py client`
    if (flag === '--enroll') args.enroll = true;
    else if (['--relay', '--target', '--id', '--name', '--creds', '--pool'].includes(flag)) {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      args[flag.slice(2)] = argv[(i += 1)];
    } else throw new Error(`unknown option ${flag}`);
  }
  if (!args.relay) throw new Error('--relay is required');
  args.pool = Number(args.pool);
  if (!Number.isInteger(args.pool) || args.pool < 0) throw new Error('--pool must be a number');
  return args;
}

async function runClient(args, stop = makeStop()) {
  const credsPath = args.creds || path.join(stateDir(), 'relay.env');
  const env = process.env;
  let creds = null;
  if (!args.enroll) creds = env.RELAY_ID && env.RELAY_SECRET ? [env.RELAY_ID, env.RELAY_SECRET] : loadCreds(credsPath);
  if (args.id && env.RELAY_SECRET && !args.enroll) creds = [args.id, env.RELAY_SECRET];
  const secure = args.relay.startsWith('https://');
  const webBase = secure ? args.relay.replace(/\/+$/, '') : `http://${args.relay}`;
  if (creds === null || creds[1].length < 24) {
    creds = await enroll(webBase, args.name || os.hostname(), credsPath);
    if (creds === null) return 1;
  }
  const [connectorId, secret] = creds;
  let relayAddr;
  let tlsHost = null;
  if (secure) {
    const found = await resolveTunnel(webBase, stop);
    if (found === null) return 0;
    [relayAddr, tlsHost] = found;
  } else {
    relayAddr = splitAddr(args.relay);
    if (!isLoopbackHost(relayAddr[0])) log('warning: this tunnel is not encrypted; ask for an https:// relay address');
  }
  const targetAddr = splitAddr(args.target);
  log(`client ${connectorId}: ${args.relay} -> ${args.target}, ${args.pool} idle connections`
    + (tlsHost ? ` (tunnel ${relayAddr[0]}:${relayAddr[1]}, tls)` : ''));
  watchBridge(webBase, targetAddr, connectorId, secret, stop);
  await Promise.all(Array.from({ length: args.pool }, () => tunnelWorker(relayAddr, targetAddr, connectorId, secret, stop, tlsHost)));
  return 0;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`relay client: ${error.message}\n`);
    process.exit(2);
  }
  const stop = makeStop();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
  runClient(args, stop).then((code) => process.exit(code), (error) => {
    process.stderr.write(`relay client: ${error.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = { notifyOf, signNotify, parseTunnel, isLoopbackHost, loadCreds, saveCreds, describeError, enroll, runClient, makeStop, parseArgs };
