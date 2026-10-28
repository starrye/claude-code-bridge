'use strict';

// Takes over the `codex` bundled in the OpenAI Codex extension so the editor panel and the phone share one
// app-server (and so one writer per thread). The bundled binary is renamed codex.orig and replaced by a small
// script that runs codex-forward.js; that script falls back to codex.orig whenever the shared server is not there,
// so Codex keeps working when the Bridge is stopped or the extension is gone. On Windows a .exe cannot be replaced
// by a script, so the stand-in is a tiny launcher .exe compiled on the spot with the csc.exe that ships with Windows.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const forward = require('./codex-forward');

const MARK = '# agent-bridge codex forwarder';
const FORWARD = () => path.join(forward.DIR, 'codex-forward.js');
const TOKEN = () => path.join(forward.DIR, 'codex-shared.token');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const WIN = process.platform === 'win32';
const origName = (platform = process.platform) => (platform === 'win32' ? 'codex.orig.exe' : 'codex.orig');
const sidecar = (dir) => path.join(dir, 'codex.agent-bridge.txt');   // Windows: node and forwarder paths, and the launcher version
const LAUNCHER_VERSION = '1';
const isWrapper = (file) => {
  if (path.extname(file).toLowerCase() === '.exe') return isFile(sidecar(path.dirname(file))) && isFile(path.join(path.dirname(file), origName('win32'))); try { return fs.readFileSync(file).subarray(0, 300).includes(MARK); } catch { return false; } };
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The bundled codex inside an OpenAI Codex extension folder: .../openai.chatgpt-<ver>-<target>/bin/<os>-<arch>/codex
function extensionOf(bin) {
  const dir = path.dirname(bin);
  const ext = path.dirname(path.dirname(dir));
  return /^openai\.chatgpt-\d/.test(path.basename(ext)) && path.basename(path.dirname(dir)) === 'bin' ? ext : null;
}

// Only the layout this was tested against: codex-package.json naming bin/codex, variant codex
function knownLayout(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'codex-package.json'), 'utf8'));
    return pkg.entrypoint === (WIN ? 'bin/codex.exe' : 'bin/codex') && pkg.variant === 'codex';
  } catch {
    return false;
  }
}

function wrapperText(node) {
  return `#!/bin/sh\n${MARK}\n`
    + `O="$(dirname "$0")/codex.orig"\nN=${quote(node)}\nF=${quote(FORWARD())}\n`
    + 'if [ -x "$N" ] && [ -f "$F" ]; then ELECTRON_RUN_AS_NODE=1 exec "$N" "$F" "$O" "$@"; fi\n'
    + 'exec "$O" "$@"\n';
}

// Same job as the sh wrapper: run the forwarder with Node, or the original if Node or the forwarder is missing.
const LAUNCHER_SOURCE = () => path.join(__dirname, 'codex-launcher.cs');

function csc() {
  const root = process.env.WINDIR || 'C:\\Windows';
  for (const f of ['Framework64', 'Framework']) {
    const file = path.join(root, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe');
    if (isFile(file)) return file;
  }
  return null;
}

// Compile the launcher to `out`; null on success, else the reason
function buildLauncher(out) {
  const compiler = csc();
  if (!compiler) return 'no_csc';
  const r = spawnSync(compiler, ['/nologo', '/optimize', '/target:exe', `/out:${out}`, LAUNCHER_SOURCE()], { encoding: 'utf8' });
  return r.status === 0 && isFile(out) ? null : `compile_failed: ${(r.stdout || r.stderr || '').trim().split('\n')[0]}`;
}

// Windows install: codex.exe -> codex.orig.exe, launcher in its place, paths in the sidecar file
function installWindows(bin, node) {
  const dir = path.dirname(bin);
  const original = path.join(dir, origName('win32'));
  const meta = `${LAUNCHER_VERSION}
${node}
${FORWARD()}
`;
  if (isWrapper(bin)) {
    if (!isFile(original)) return { state: 'skipped', reason: 'original_missing', original: bin };
    const current = fs.readFileSync(sidecar(dir), 'utf8');
    if (current.split('\n')[0] !== LAUNCHER_VERSION) {
      const tmp = `${bin}.agent-bridge-tmp.exe`;
      const failed = buildLauncher(tmp);
      if (failed) return { state: 'skipped', reason: failed, original };
      // the old launcher may be running (an editor panel): a running exe can be renamed, not overwritten
      const old = path.join(dir, `codex.launcher-old-${Date.now()}.exe`);
      fs.renameSync(bin, old);
      fs.renameSync(tmp, bin);
      try { fs.rmSync(old, { force: true }); } catch { /* still running; harmless leftover */ }
    }
    if (current !== meta) fs.writeFileSync(sidecar(dir), meta);
    return { state: 'present', original };
  }
  const tmp = path.join(dir, 'codex.agent-bridge-tmp.exe');
  const failed = buildLauncher(tmp);
  if (failed) return { state: 'skipped', reason: failed, original: bin };
  fs.renameSync(bin, original);            // a running exe can be renamed, not overwritten
  fs.renameSync(tmp, bin);
  fs.writeFileSync(sidecar(dir), meta);
  return { state: 'installed', original };
}

// Put the forwarder in place for the extension that owns `bin`. Returns
// { state: 'installed' | 'present' | 'skipped', reason?, original } where original is the real binary to run.
function install(bin, node = process.execPath, platform = process.platform) {
  const dir = path.dirname(bin);
  const original = path.join(dir, origName(platform));
  if (!extensionOf(bin)) return { state: 'skipped', reason: 'not_extension', original: bin };
  if (!knownLayout(dir)) return { state: 'skipped', reason: 'unknown_layout', original: isFile(original) && isWrapper(bin) ? original : bin };
  fs.mkdirSync(forward.DIR, { recursive: true, mode: 0o700 });
  const source = fs.readFileSync(require.resolve('./codex-forward'));
  if (!isFile(FORWARD()) || !fs.readFileSync(FORWARD()).equals(source)) fs.writeFileSync(FORWARD(), source, { mode: 0o600 });
  if (platform === 'win32') return installWindows(bin, node);
  const text = wrapperText(node);
  if (isWrapper(bin)) {
    if (!isFile(original)) return { state: 'skipped', reason: 'original_missing', original: bin };
    if (fs.readFileSync(bin, 'utf8') !== text) writeWrapper(bin, text);   // the Bridge's node moved (VS Code update)
    return { state: 'present', original };
  }
  fs.renameSync(bin, original);
  writeWrapper(bin, text);
  return { state: 'installed', original };
}

function writeWrapper(bin, text) {
  const tmp = `${bin}.agent-bridge-tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o755 });
  fs.renameSync(tmp, bin);
}

// Put every bundled codex back under `extensionsRoot`; returns the folders restored
function restoreAll(extensionsRoot) {
  const done = [];
  let names = [];
  try { names = fs.readdirSync(extensionsRoot); } catch { return done; }
  for (const name of names.filter((n) => n.startsWith('openai.chatgpt-'))) {
    let subs = [];
    try { subs = fs.readdirSync(path.join(extensionsRoot, name, 'bin')); } catch { continue; }
    for (const sub of subs) {
      const dir = path.join(extensionsRoot, name, 'bin', sub);
      const bin = path.join(dir, WIN ? 'codex.exe' : 'codex');
      if (isWrapper(bin) && isFile(path.join(dir, origName()))) {
        if (WIN) {
          // the launcher may be running (an editor panel): move it aside, it cannot be overwritten
          const old = path.join(dir, `codex.launcher-old-${Date.now()}.exe`);
          fs.renameSync(bin, old);
          fs.rmSync(sidecar(dir), { force: true });
          try { fs.rmSync(old, { force: true }); } catch { /* still running; harmless leftover */ }
        }
        fs.renameSync(path.join(dir, origName()), bin);
        done.push(dir);
      }
    }
  }
  return done;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function writeDescriptor(d) {
  fs.mkdirSync(forward.DIR, { recursive: true, mode: 0o700 });
  const tmp = `${forward.DESCRIPTOR}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
  fs.renameSync(tmp, forward.DESCRIPTOR);
}

// A shared server left behind by a Bridge that was killed: stop it before starting ours
function stopLeftover() {
  const d = forward.readDescriptor();
  if (!d || !Number.isInteger(d.serverPid) || d.bridgePid === process.pid) return;
  let ours = true;
  try { ours = fs.readFileSync(`/proc/${d.serverPid}/cmdline`, 'utf8').includes(TOKEN()); } catch { /* no /proc: trust the file */ }
  if (ours) { try { process.kill(d.serverPid, 'SIGTERM'); } catch { /* already gone */ } }
}

// The shared `codex app-server` on 127.0.0.1 with a capability token. Restarted if it exits, a few times.
class SharedServer {
  constructor(original, log = () => {}) {
    this.original = original;
    this.log = log;
    this.child = null;
    this.failures = [];
    this.stopped = false;
  }

  async start() {
    stopLeftover();
    const token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(forward.DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN(), token, { mode: 0o600 });
    const port = await freePort();
    // like the extension starts its own: code mode on, and its bundled tools (rg) on PATH
    const tools = path.join(path.dirname(this.original), 'codex-path');
    const env = { ...process.env, PATH: `${process.env.PATH || ''}${path.delimiter}${tools}` };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(this.original, ['-c', 'features.code_mode_host=true', 'app-server', '--listen', `ws://127.0.0.1:${port}`,
      '--ws-auth', 'capability-token', '--ws-token-file', TOKEN()], { stdio: 'ignore', env, windowsHide: true });   // no console window on Windows
    this.child = child;
    writeDescriptor({ port, token, bridgePid: process.pid, serverPid: child.pid, startedAt: Date.now() });
    child.once('error', (e) => this.log(`codex takeover: shared app-server failed to start: ${e.message}`));
    child.once('exit', (code, signal) => {
      if (this.child !== child || this.stopped) return;
      this.child = null;
      this.failures = [...this.failures.filter((t) => Date.now() - t < 60000), Date.now()];
      if (this.failures.length >= 3) {
        this.log(`codex takeover: shared app-server keeps exiting (${code ?? signal}); the editor uses its own codex`);
        this.stop();
        return;
      }
      this.log(`codex takeover: shared app-server exited (${code ?? signal}), restarting`);
      this.start().catch(() => {});
    });
    return port;
  }

  // keepRestartHint: true on a normal exit (window reload), so a forwarder starting meanwhile waits for the next one
  stop(keepRestartHint = true) {
    this.stopped = true;
    if (this.child) { try { this.child.kill('SIGTERM'); } catch { /* gone */ } }
    this.child = null;
    const d = forward.readDescriptor();
    if (d && d.bridgePid === process.pid) {
      if (keepRestartHint) writeDescriptor({ ...d, stoppedAt: Date.now() });
      else fs.rmSync(forward.DESCRIPTOR, { force: true });
    }
  }
}

// Everything off: originals back, no shared server, no descriptor (setting turned off, extension uninstalled)
function uninstall(extensionsRoot) {
  const restored = restoreAll(extensionsRoot);
  const d = forward.readDescriptor();
  if (d && Number.isInteger(d.serverPid)) { try { process.kill(d.serverPid, 'SIGTERM'); } catch { /* gone */ } }
  for (const f of [forward.DESCRIPTOR, TOKEN(), FORWARD()]) fs.rmSync(f, { force: true });
  return restored;
}

module.exports = { MARK, install, restoreAll, uninstall, extensionOf, isWrapper, SharedServer, wrapperText };
