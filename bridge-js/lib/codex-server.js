'use strict';

// One `codex app-server` child spoken to over stdio JSON-RPC (one JSON object per line). Started on first use,
// restarted after it exits; after repeated failures in a short window it is reported unavailable.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

const REQUEST_TIMEOUT_MS = 60000;
const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 60000;

class CodexError extends Error {
  constructor(message, code = null, data = null) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// Events: 'notification'(method, params), 'request'(method, params, reply), 'exit'
class CodexServer extends EventEmitter {
  constructor(bin, { env = process.env, args = ['app-server'], version = '0' } = {}) {
    super();
    this.bin = bin;
    this.args = args;
    this.env = env;
    this.version = version;
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.failures = [];
    this.closed = false;
  }

  available() {
    const recent = this.failures.filter((t) => Date.now() - t < FAILURE_WINDOW_MS);
    return !this.closed && recent.length < MAX_FAILURES;
  }

  start() {
    if (this.ready) return this.ready;
    if (!this.available()) return Promise.reject(new CodexError('codex_unavailable'));
    const proc = spawn(this.bin, this.args, { env: this.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc = proc;
    proc.stdin.on('error', () => {});
    const lines = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.onLine(line));
    const gone = (error) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = null;
      if (!this.closed) this.failures.push(Date.now());
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new CodexError(error ? 'codex_start_failed' : 'codex_exited'));
      }
      this.pending.clear();
      this.emit('exit');
    };
    proc.once('error', gone);
    proc.once('close', () => gone(null));
    this.ready = this.send('initialize', {
      clientInfo: { name: 'agent_bridge', title: 'Agent Bridge', version: this.version },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.write({ method: 'initialized' });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  write(message) {
    if (this.proc) this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError('codex_timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async request(method, params) {
    await this.start();
    return this.send(method, params);
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.method === undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new CodexError(message.error.message || 'codex_error', message.error.code ?? null, message.error.data ?? null));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      let answered = false;
      const reply = (result, error = null) => {
        if (answered) return;
        answered = true;
        this.write(error ? { id: message.id, error } : { id: message.id, result });
      };
      if (this.listenerCount('request')) this.emit('request', message.method, message.params || {}, reply);
      else reply(null, { code: -32601, message: 'not handled' });
      return;
    }
    if (message.method) this.emit('notification', message.method, message.params || {});
  }

  close() {
    this.closed = true;
    if (this.proc) this.proc.kill('SIGTERM');
  }
}

module.exports = { CodexServer, CodexError };
