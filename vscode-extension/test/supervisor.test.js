'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { Supervisor, ClientOutput, isValidRelay, ENGINES } = require('../lib/supervisor');
const { renderPairingHtml } = require('../lib/pairing-html');

const BRIDGE_DIR = path.resolve(__dirname, '../..');
const hasPython = spawnSync('python3', ['--version']).status === 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function get(port, urlPath) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', () => resolve(0));
  });
}

async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function startRelay(relayPort, stateDir) {
  const child = spawn('python3', ['-u', 'relay.py', '--state', stateDir, 'serve', '--listen', `127.0.0.1:${relayPort}`], {
    cwd: BRIDGE_DIR,
    env: { ...process.env, RELAY_PUBLIC_URL: `http://127.0.0.1:${relayPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { child.log += chunk; });
  return child;
}

function collect(supervisor) {
  const seen = { states: [], pairing: null };
  supervisor.on('state', (state, detail) => seen.states.push([state, detail]));
  supervisor.on('pairing', (info) => { seen.pairing = info; });
  return seen;
}

test('isValidRelay accepts host:port only', () => {
  assert.ok(isValidRelay('relay.example.com:9010'));
  assert.ok(isValidRelay('127.0.0.1:9010'));
  assert.ok(isValidRelay('https://relay.example.com:9010'));
  assert.ok(isValidRelay('https://relay.example.com'));
  for (const bad of ['', 'relay', 'relay:', ':9010', 'http://relay:9010', 'a b:1', 'relay:99999x',
    'https://', 'https://relay.example.com:9010/path', 'https://relay.example.com:abc', 'https://rel ay.example.com', 'https://relay.example.com@evil.example']) {
    assert.ok(!isValidRelay(bad), bad);
  }
});

test('ClientOutput recognises the pairing sequence', () => {
  const parser = new ClientOutput();
  const events = [
    '请用飞书扫描二维码,在手机上确认绑定:',
    '\x1b[30;47m▀\x1b[0m',
    '无法扫码时,把这个链接发到飞书里点开: https://applink.feishu.cn/client/web_app/open?appId=x&enroll=abc',
    '手机上显示的校验码应为: 1A2B    电脑名称: my-pc',
  ].flatMap((line) => parser.feed(line));
  assert.deepEqual(events, [{
    type: 'pairing', link: 'https://applink.feishu.cn/client/web_app/open?appId=x&enroll=abc', verify: '1A2B', name: 'my-pc',
  }]);
});

test('ClientOutput recognises lifecycle lines', () => {
  const parser = new ClientOutput();
  assert.deepEqual(parser.feed('绑定成功,凭证已保存到 /x/relay.env'), [{ type: 'bound' }]);
  assert.deepEqual(parser.feed('二维码已过期,请重新运行。'), [{ type: 'expired' }]);
  assert.deepEqual(parser.feed('10:31:02 client c_ab12cd34: relay:9010 -> 127.0.0.1:8787, 4 idle connections'),
    [{ type: 'running', id: 'c_ab12cd34' }]);
  assert.deepEqual(parser.feed('10:31:03 tunnel retry in 1s (authentication refused; if this computer was removed on the server, run with --enroll)'),
    [{ type: 'auth-refused' }]);
  assert.deepEqual(parser.feed('10:31:03 tunnel retry in 1s (timed out)'), []);
});

test('renderPairingHtml escapes values and embeds the QR', () => {
  const html = renderPairingHtml({ name: '<b>x</b>', verify: 'AB12', link: 'http://h/?a=1&b=2', matrix: [[true, false], [false, true]] });
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('a=1&amp;b=2'));
  assert.ok(html.includes('<svg'));
  assert.ok(!html.includes('<script'));
});

test('the pairing panel tells people with several windows to set a Computer Name', () => {
  const html = renderPairingHtml({ name: 'box@app', verify: 'AB12', link: 'http://h/', matrix: [[true]] });
  assert.ok(html.includes('如果您有多窗口需求，强烈建议设置 Computer Name 作为窗口的名称'));
  assert.ok(html.includes('agentBridge.computerName'));
  assert.ok(!html.includes('<script'));
  assert.ok(html.indexOf('<svg') < html.indexOf('强烈建议'), 'the hint is below the QR code');
});

test('start fails cleanly on a bad relay address', async () => {
  const supervisor = new Supervisor();
  const seen = collect(supervisor);
  await supervisor.start({ relay: 'nope', port: 1, claude: '', name: 'x', bridgeDir: BRIDGE_DIR, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')) });
  assert.equal(supervisor.state, 'error');
  assert.match(seen.states.at(-1)[1], /主机:端口/);
});

test('a second supervisor sharing the state dir backs off', { skip: !hasPython }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'));
  fs.writeFileSync(path.join(stateDir, 'extension.lock'), String(process.ppid));
  const supervisor = new Supervisor();
  await supervisor.start({ relay: '127.0.0.1:1', port: await freePort(), claude: '', name: 'x', bridgeDir: BRIDGE_DIR, stateDir, pid: process.pid });
  assert.equal(supervisor.state, 'other-window');
  assert.ok(fs.existsSync(path.join(stateDir, 'extension.lock')), 'must not delete the other owner lock');
});

function fakeBridge(port) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}

function guestSetup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'));
  const secret = 'g'.repeat(32);
  fs.writeFileSync(path.join(stateDir, 'relay.env'), `RELAY_ID=c_1\nRELAY_SECRET=${secret}\n`);
  fs.writeFileSync(path.join(stateDir, 'extension.lock'), String(process.ppid));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ws-'));
  const token = require('node:crypto').createHmac('sha256', secret).update('bridge-access').digest('hex');
  return { stateDir, workspace, token };
}

test('a window that cannot host joins the host Bridge as a guest and leaves cleanly', async () => {
  const port = await freePort();
  const { server, calls } = await fakeBridge(port);
  const { stateDir, workspace, token } = guestSetup();
  const supervisor = new Supervisor();
  try {
    await supervisor.start({ relay: '127.0.0.1:1', port, claude: '', name: 'x', bridgeDir: BRIDGE_DIR, stateDir, workspace, pid: process.pid, guestBeatMs: 50 });
    await until(() => supervisor.state === 'guest', 5000, 'guest state');
    await until(() => calls.filter((c) => c.body.action === 'add').length >= 2, 5000, 'heartbeats');
    for (const call of calls) {
      assert.equal(call.path, '/internal/workspace');
      assert.equal(call.auth, `Bearer ${token}`);
      assert.equal(call.body.root, workspace);
    }
    await supervisor.stop();
    assert.equal(supervisor.state, 'stopped');
    assert.equal(calls.at(-1).body.action, 'remove');
    assert.ok(fs.existsSync(path.join(stateDir, 'extension.lock')), 'a guest must not delete the host lock');
    const count = calls.length;
    await sleep(200);
    assert.equal(calls.length, count, 'no heartbeat after leaving');
  } finally {
    server.close();
  }
});

test('a guest whose host window disappears tries to take over', async () => {
  const port = await freePort();
  const { server } = await fakeBridge(port);
  const { stateDir, workspace } = guestSetup();
  const supervisor = new Supervisor();
  let takeover = null;
  try {
    await supervisor.start({ relay: '127.0.0.1:1', port, claude: '', name: 'x', bridgeDir: BRIDGE_DIR, stateDir, workspace, pid: process.pid, guestBeatMs: 50 });
    await until(() => supervisor.state === 'guest', 5000, 'guest state');
    supervisor.start = async (opts) => { takeover = opts; };
    await new Promise((resolve) => server.close(resolve));
    await until(() => takeover, 5000, 'takeover');
    assert.equal(takeover.workspace, workspace);
  } finally {
    await supervisor.stop();
  }
});

test('a window without a folder or without credentials stays out of the way', async () => {
  const port = await freePort();
  const { server, calls } = await fakeBridge(port);
  const { stateDir, workspace } = guestSetup();
  fs.rmSync(path.join(stateDir, 'relay.env'));
  const supervisor = new Supervisor();
  try {
    await supervisor.start({ relay: '127.0.0.1:1', port, claude: '', name: 'x', bridgeDir: BRIDGE_DIR, stateDir, workspace, pid: process.pid, guestBeatMs: 50 });
    await sleep(300);
    assert.equal(supervisor.state, 'other-window');
    assert.equal(calls.length, 0);
  } finally {
    await supervisor.stop();
    server.close();
  }
});

test('end to end: first run shows a pairing QR, then stops cleanly', { skip: !hasPython, timeout: 60000 }, async (t) => {
  const relayPort = await freePort();
  const bridgePort = await freePort();
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-relay-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-state-'));
  const relay = startRelay(relayPort, relayDir);
  const supervisor = new Supervisor();
  t.after(async () => { await supervisor.stop(); relay.kill(); });
  await until(async () => (await get(relayPort, '/healthz')) === 200, 10000, 'relay');

  const seen = collect(supervisor);
  supervisor.start({ relay: `127.0.0.1:${relayPort}`, port: bridgePort, claude: '', name: 'test-pc', bridgeDir: BRIDGE_DIR, stateDir });
  const info = await until(() => seen.pairing, 20000, 'pairing event');

  assert.equal(supervisor.state, 'pairing');
  assert.match(info.link, /^http:\/\/127\.0\.0\.1:\d+\/\?enroll=/);
  assert.equal(info.name, 'test-pc');
  assert.match(info.verify, /^[0-9A-F]{4}$/);
  assert.ok(Array.isArray(info.matrix) && info.matrix.length > 20, 'QR matrix');
  assert.equal(await get(bridgePort, '/healthz'), 200, 'bridge is up');

  await supervisor.stop();
  assert.equal(supervisor.state, 'stopped');
  assert.equal(await get(bridgePort, '/healthz'), 0, 'bridge is gone');
  assert.ok(!fs.existsSync(path.join(stateDir, 'extension.lock')), 'lock released');
});

test('end to end: saved credentials go straight to running and open a tunnel', { skip: !hasPython, timeout: 60000 }, async (t) => {
  const relayPort = await freePort();
  const bridgePort = await freePort();
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-relay-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-state-'));
  const added = spawnSync('python3', ['relay.py', '--state', relayDir, 'add-connector', '--name', 'test'], { cwd: BRIDGE_DIR, encoding: 'utf8' });
  const id = /connector id:\s+(\S+)/.exec(added.stdout)[1];
  const secret = /secret:\s+(\S+)/.exec(added.stdout)[1];
  fs.writeFileSync(path.join(stateDir, 'relay.env'), `RELAY_ID=${id}\nRELAY_SECRET=${secret}\n`, { mode: 0o600 });

  const relay = startRelay(relayPort, relayDir);
  const supervisor = new Supervisor();
  t.after(async () => { await supervisor.stop(); relay.kill(); });
  await until(async () => (await get(relayPort, '/healthz')) === 200, 10000, 'relay');

  supervisor.start({ relay: `127.0.0.1:${relayPort}`, port: bridgePort, claude: '', name: 'test-pc', bridgeDir: BRIDGE_DIR, stateDir });
  await until(() => supervisor.state === 'running', 20000, 'running state');
  await until(() => relay.log.includes(`tunnel ready for ${id}`), 10000, 'tunnel registered on relay');
  assert.equal(await get(bridgePort, '/healthz'), 200);
});

test('the node engine runs the bundled JavaScript on the extension host\'s own Node', () => {
  const supervisor = new Supervisor();
  supervisor.opts = { bridgeDir: BRIDGE_DIR };
  assert.equal(supervisor.engine(), 'node');
  for (const file of [ENGINES.node.marker, ...ENGINES.node.relay]) assert.ok(fs.existsSync(path.join(BRIDGE_DIR, file)), file);
  return supervisor.qrMatrix('https://example.com/?enroll=abc').then((matrix) => {
    assert.ok(Array.isArray(matrix) && matrix.length === 25 && matrix[0][0] === true, 'QR matrix from the bundled encoder');
  });
});

test('a bridge that cannot bind its port is reported, not hidden', { skip: !hasPython, timeout: 30000 }, async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const supervisor = new Supervisor();
  const seen = collect(supervisor);
  await supervisor.start({ relay: '127.0.0.1:1', port: blocker.address().port, claude: '', name: 'x', bridgeDir: BRIDGE_DIR, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')) });
  blocker.close();
  assert.equal(supervisor.state, 'error');
  assert.match(seen.states.at(-1)[1], /已被占用/);
});
