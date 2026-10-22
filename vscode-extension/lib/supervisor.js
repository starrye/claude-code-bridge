'use strict';

const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ANSI = /\x1b\[[0-9;]*m/g;
const QR_ROW = /^[▀▄█ ]+$/;
const RELAY_ADDRESS = /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?|[^\s:/]+:\d{1,5})$/;
const LABEL = { bridge: 'Bridge', relay: '中继客户端' };
const KILL_GRACE_MS = 3000;
const HEALTH_TIMEOUT_MS = 15000;
const MIN_NODE_MAJOR = 18;
const GUEST_BEAT_MS = 15000;       // how often a guest window renews its folder with the host's Bridge (the Bridge forgets it after 45 s)
const GUEST_TAKEOVER_AFTER = 2;     // missed beats before a guest assumes the host window is gone and takes over

// What each engine runs. node: the bundled JavaScript port on the Node that runs this extension (inside VS Code that
// is its own Electron binary in Node mode, so users need nothing installed).
const ENGINES = {
  node: { marker: path.join('bridge-js', 'server.js'), bridge: [path.join('bridge-js', 'server.js')], relay: [path.join('bridge-js', 'relay-client.js')] },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isValidRelay = (text) => RELAY_ADDRESS.test(text);

class Busy extends Error {}

// The Bridge's access value is derived from the connector secret the host window saved in the shared state directory,
// so any window of the same user can talk to the Bridge without being handed a token.
function bridgeAccess(stateDir) {
  try {
    const text = fs.readFileSync(path.join(stateDir, 'relay.env'), 'utf8');
    const secret = (/^RELAY_SECRET=(.*)$/m.exec(text) || [])[1];
    return secret && secret.trim().length >= 24 ? crypto.createHmac('sha256', secret.trim()).update('bridge-access').digest('hex') : '';
  } catch {
    return '';
  }
}

function postWorkspace(port, token, action, root) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ action, root }));
    const request = http.request({ host: '127.0.0.1', port, path: '/internal/workspace', method: 'POST', timeout: 3000,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': body.length } }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
    request.end(body);
  });
}

// The relay client (relay-client.js or relay.py) prints human-readable Chinese text; these patterns are the contract with it.
class ClientOutput {
  constructor() {
    this.link = null;
  }

  feed(raw) {
    const line = raw.replace(ANSI, '').trim();
    let match;
    if (!line) return [];
    if (line.includes('请用飞书扫描二维码')) {
      this.link = null;
      return [];
    }
    if ((match = /无法扫码时.*?[:：]\s*(\S+)$/.exec(line))) {
      this.link = match[1];
      return [];
    }
    if ((match = /校验码应为[:：]\s*(\S+)\s+电脑名称[:：]\s*(.*)$/.exec(line)) && this.link) {
      return [{ type: 'pairing', link: this.link, verify: match[1], name: match[2].trim() }];
    }
    if (line.includes('绑定成功')) return [{ type: 'bound' }];
    if (line.includes('二维码已过期')) return [{ type: 'expired' }];
    if ((match = /\bclient (c_\w+):/.exec(line))) return [{ type: 'running', id: match[1] }];
    if (line.includes('authentication refused')) return [{ type: 'auth-refused' }];
    return [];
  }
}

function readLines(stream, onLine) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    rest += chunk;
    let index;
    while ((index = rest.indexOf('\n')) >= 0) {
      onLine(rest.slice(0, index).replace(/\r$/, ''));
      rest = rest.slice(index + 1);
    }
  });
  stream.on('end', () => {
    if (rest) onLine(rest);
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function healthy(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

// Events: 'state'(state, detail), 'log'(source, line), 'pairing'(info), 'bound', 'warn'(text).
// States: stopped | starting | pairing | running | error | other-window | guest.
// other-window: another window hosts the Bridge and this one has not reached it yet; guest: this window's folder is
// registered with that Bridge, and this window takes the Bridge over if the host window goes away.
class Supervisor extends EventEmitter {
  constructor() {
    super();
    this.state = 'stopped';
    this.children = new Map();
    this.output = new ClientOutput();
    this.lastLine = {};
    this.closing = null;
    this.lockHeld = false;
    this.guestTimer = null;
    this.guestMissed = 0;
    this.run = 0;
    this.opts = null;
  }

  setState(state, detail = '') {
    this.state = state;
    this.emit('state', state, detail);
  }

  async start(opts, { enroll = false } = {}) {
    if (!['stopped', 'error', 'other-window'].includes(this.state)) return;
    const run = ++this.run;
    this.opts = { pid: process.pid, ...opts };
    this.output = new ClientOutput();
    this.lastLine = {};
    this.setState('starting', '正在检查环境');
    try {
      await this.launch(run, enroll);
    } catch (error) {
      if (run !== this.run) return;
      if (error instanceof Busy) {
        await this.finish('other-window', error.message);
        this.beginGuest();
      } else await this.fail(error.message || String(error));
    }
  }

  async launch(run, enroll) {
    const o = this.opts;
    if (!isValidRelay(o.relay)) throw new Error('中继地址格式应为 https://域名[:端口]（加密，推荐）或 主机:端口（明文）');
    const engine = ENGINES[this.engine()];
    if (!fs.existsSync(path.join(o.bridgeDir, engine.marker))) throw new Error(`插件内缺少运行文件（${engine.marker}），请重新安装`);
    fs.mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    if (!this.acquireLock()) throw new Busy('另一个窗口已在托管 Bridge，本窗口不再重复启动');
    this.checkNode();
    if (run !== this.run) return;
    this.checkClaude();
    if (await portBusy(o.port)) {
      throw new Error(`端口 ${o.port} 已被占用（可能是手动启动的 bridge）。请先停止它，或修改 agentBridge.bridgePort`);
    }
    if (run !== this.run) return;

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      ELECTRON_RUN_AS_NODE: '1',
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_PORT: String(o.port),
      BRIDGE_STATE_DIR: o.stateDir,
    };
    if (o.claude) env.CLAUDE_BIN = o.claude;
    if (o.workspace) env.BRIDGE_WORKSPACE = o.workspace;
    else delete env.BRIDGE_WORKSPACE;

    this.setState('starting', '正在启动 Bridge');
    const bridge = this.spawnChild('bridge', engine.bridge, env);
    const ready = await this.waitHealthy(bridge, run);
    if (run !== this.run) return;
    if (!ready) throw new Error('Bridge 启动超时');

    const args = [...engine.relay, '--relay', o.relay, '--target', `127.0.0.1:${o.port}`, '--name', o.name];
    if (enroll) args.push('--enroll');
    this.spawnChild('relay', args, env);
    this.setState('starting', enroll ? '正在申请绑定' : '正在连接中继');
  }

  engine() {
    return 'node';
  }

  spawnChild(name, args, env) {
    const child = spawn(process.execPath, args, {
      cwd: this.opts.bridgeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.dead = false;
    child.done = new Promise((resolve) => {
      let fired = false;
      const finish = (code, signal, err) => {
        if (fired) return;
        fired = true;
        child.dead = true;
        resolve({ code, signal, err });
      };
      child.once('error', (err) => finish(null, null, err));
      child.once('close', (code, signal) => finish(code, signal, null));
    });
    child.done.then((result) => this.onChildExit(name, child, result));
    for (const stream of [child.stdout, child.stderr]) readLines(stream, (line) => this.handleLine(name, line));
    this.children.set(name, child);
    return child;
  }

  async waitHealthy(child, run) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.dead || run !== this.run) return false;
      if (await healthy(this.opts.port)) return true;
      await sleep(200);
    }
    return false;
  }

  handleLine(source, raw) {
    const text = raw.replace(ANSI, '').trim();
    if (!text || QR_ROW.test(text)) return;
    this.lastLine[source] = text;
    this.emit('log', source, text);
    if (source !== 'relay') return;
    for (const event of this.output.feed(text)) this.onClientEvent(event);
  }

  onClientEvent(event) {
    if (this.closing) return;
    switch (event.type) {
      case 'pairing':
        this.setState('pairing', '请用飞书扫码绑定');
        this.emit('log', 'ext', '二维码已显示在绑定面板；也可执行“显示绑定二维码”');
        this.qrMatrix(event.link).then((matrix) => {
          if (this.state === 'pairing') this.emit('pairing', { ...event, matrix });
        });
        break;
      case 'bound':
        this.emit('bound');
        this.setState('starting', '绑定成功，正在连接中继');
        break;
      case 'running':
        this.setState('running', `客户端已启动（连接器 ${event.id}），连接问题请查看日志`);
        break;
      case 'expired':
        this.fail('二维码已过期，请重新绑定');
        break;
      case 'auth-refused':
        this.fail('中继拒绝了本机凭据（可能已在服务器上被移除），请执行“重新绑定手机”');
        break;
      default:
    }
  }

  onChildExit(name, child, result) {
    if (this.children.get(name) === child) this.children.delete(name);
    if (this.closing) return;
    const detail = this.lastLine[name] || (result.err ? result.err.message : `退出码 ${result.code ?? result.signal}`);
    this.fail(`${LABEL[name]} 意外退出: ${detail}`);
  }

  finish(state, detail = '') {
    if (!this.closing) {
      this.run += 1;
      this.closing = (async () => {
        await this.leaveGuest();
        await this.killChildren();
        this.releaseLock();
        this.setState(state, detail);
      })().finally(() => {
        this.closing = null;
      });
    }
    return this.closing;
  }

  stop() {
    return this.state === 'stopped' ? Promise.resolve() : this.finish('stopped');
  }

  fail(message) {
    return this.finish('error', message);
  }

  async killChildren() {
    const children = [...this.children.values()];
    for (const child of children) if (!child.dead) child.kill('SIGTERM');
    const timer = setTimeout(() => {
      for (const child of children) if (!child.dead) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    await Promise.all(children.map((child) => child.done));
    clearTimeout(timer);
    this.children.clear();
  }

  // -- guest: another window hosts the Bridge; register this window's folder with it
  beginGuest() {
    if (!this.opts.workspace || this.closing) return;
    const gen = this.run;
    this.guestMissed = 0;
    const beat = async () => {
      if (gen !== this.run || this.closing) return;
      const token = bridgeAccess(this.opts.stateDir);
      const ok = token !== '' && await postWorkspace(this.opts.port, token, 'add', this.opts.workspace);
      if (gen !== this.run || this.closing) return;
      if (ok) {
        this.guestMissed = 0;
        if (this.state !== 'guest') this.setState('guest', '本窗口的文件夹已接入另一个窗口托管的 Bridge');
      } else if (this.state === 'guest' && (this.guestMissed += 1) >= GUEST_TAKEOVER_AFTER) {
        this.emit('log', 'ext', '托管 Bridge 的窗口已不在，本窗口接手');
        this.guestTimer = null;
        this.setState('stopped', '');
        this.start({ ...this.opts });
        return;
      }
      this.guestTimer = setTimeout(beat, this.opts.guestBeatMs || GUEST_BEAT_MS);
      this.guestTimer.unref();
    };
    this.guestTimer = setTimeout(beat, 0);
    this.guestTimer.unref();
  }

  async leaveGuest() {
    if (this.guestTimer) clearTimeout(this.guestTimer);
    this.guestTimer = null;
    if (this.state !== 'guest' || !this.opts) return;
    const token = bridgeAccess(this.opts.stateDir);
    if (token) await postWorkspace(this.opts.port, token, 'remove', this.opts.workspace);
  }

  lockFile() {
    return path.join(this.opts.stateDir, 'extension.lock');
  }

  acquireLock() {
    const file = this.lockFile();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(file, String(this.opts.pid), { flag: 'wx', mode: 0o600 });
        this.lockHeld = true;
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
        if (owner === this.opts.pid) {
          this.lockHeld = true;
          return true;
        }
        if (processAlive(owner)) return false;
        fs.rmSync(file, { force: true });
      }
    }
    return false;
  }

  releaseLock() {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    fs.rmSync(this.lockFile(), { force: true });
  }

  checkNode() {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < MIN_NODE_MAJOR) throw new Error(`VS Code 自带的 Node 版本过旧（${process.versions.node}），请升级 VS Code`);
  }

  checkClaude() {
    const bin = this.opts.claude || 'claude';
    let target = bin;
    try {
      process.env.CLAUDE_BIN = bin;
      target = require(path.join(this.opts.bridgeDir, 'bridge-js', 'lib', 'claude-bin.js')).claudeBin();
    } catch {
      // fall back to the bare name
    }
    execFile(target, ['--version'], { timeout: 10000 }, (error) => {
      if (error && error.code === 'ENOENT') {
        this.emit('warn', `找不到 ${bin} 命令，手机发起的任务会失败。请安装 Claude Code 或设置 agentBridge.claudePath`);
      }
    });
  }

  // The bundled encoder, run in-process (it is plain JavaScript); null if the link cannot be drawn
  qrMatrix(link) {
    try {
      return Promise.resolve(require(path.join(this.opts.bridgeDir, 'bridge-js', 'lib', 'qr.js')).matrix(link));
    } catch {
      return Promise.resolve(null);
    }
  }
}

module.exports = { Supervisor, ClientOutput, isValidRelay, ENGINES };
