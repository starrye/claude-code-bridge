'use strict';

// Runs `claude -p` tasks, streams their events, and handles cancel. Port of bridge/runner.py.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const py = require('./py');
const sessions = require('./sessions');
const procTree = require('./proc-tree');
const commands = require('./commands');
const { GATED_TOOLS, redact } = require('./approvals');

const { claudeBin: CLAUDE_BIN } = require('./claude-bin');
const ENTRYPOINT = 'feishu-bridge';
const WRITE_TOOLS = 'Write Edit MultiEdit NotebookEdit Bash';
const TEXT_FLUSH_SECONDS = 0.5;
const MAX_TASK_EVENTS = 500;
const MAX_LOCAL_OUTPUT = 20000;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 2000000;
const HOOK_SCRIPT = path.join(__dirname, '..', 'hook-approve.js');

class TaskError extends Error {
  constructor(status, code, detail = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail || {};
  }
}

// The real type from the file header; the client's claim is never trusted
function sniffImage(raw) {
  const starts = (sig) => raw.length >= sig.length && raw.subarray(0, sig.length).equals(Buffer.from(sig, 'latin1'));
  if (starts('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (starts('\xff\xd8\xff')) return 'image/jpeg';
  if (starts('GIF87a') || starts('GIF89a')) return 'image/gif';
  if (raw.subarray(0, 4).toString('latin1') === 'RIFF' && raw.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// base64.b64decode(data, validate=True): only the alphabet, correct padding
const STRICT_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function normalizeImages(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) throw new TaskError(400, 'too_many_images', { max: MAX_IMAGES });
  return raw.map((item) => {
    const data = py.isDict(item) ? item.data : null;
    if (typeof data !== 'string' || !data) throw new TaskError(400, 'bad_image');
    if (data.length > MAX_IMAGE_B64) throw new TaskError(413, 'image_too_large', { max_bytes: Math.floor((MAX_IMAGE_B64 * 3) / 4) });
    if (!STRICT_B64.test(data)) throw new TaskError(400, 'bad_image');
    const media = sniffImage(Buffer.from(data, 'base64'));
    if (media === null) throw new TaskError(400, 'unsupported_image_type');
    return { media_type: media, data };
  });
}

function stdinMessage(prompt, images) {
  const content = images.map((image) => ({ type: 'image', source: { type: 'base64', ...image } }));
  if (py.strip(prompt)) content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

// The hook runs on the same Node that runs the bridge (inside VS Code that is its Electron binary in Node mode)
function hookCommand(hookScript = HOOK_SCRIPT) {
  if (process.platform === 'win32') {                   // Claude Code runs hooks through Git Bash there: forward slashes
    const slash = (p) => String(p).replace(/\\/g, '/');
    return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(slash(process.execPath))} ${shellQuote(slash(hookScript))}`;
  }
  return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(hookScript)}`;
}

function buildSettings(hookScript = HOOK_SCRIPT) {
  return { hooks: { PreToolUse: [{ matcher: GATED_TOOLS, hooks: [{ type: 'command', timeout: 3600, command: hookCommand(hookScript) }] }] } };
}

// Map the phone-side mode to Claude Code flags:
//   ask      -> default permission mode + approval hook (every gated call goes to phone)
//   auto     -> auto permission mode, no hook (nothing is gated)
//   readonly -> default permission mode, write-capable tools disallowed, no hook
// The permission mode is always passed: a resumed session does not remember it.
function buildCommand(mode, prompt, sessionId, settingsFile, promptOnStdin = false, model = null, effort = null) {
  const cmd = [CLAUDE_BIN(), '-p'];
  cmd.push(...(promptOnStdin ? ['--input-format', 'stream-json'] : [prompt]));
  cmd.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
  if (sessionId) cmd.push('--resume', sessionId);
  if (model) cmd.push('--model', model);
  if (effort) cmd.push('--effort', effort);
  if (mode === 'auto') cmd.push('--permission-mode', 'auto');
  else if (mode === 'readonly') cmd.push('--permission-mode', 'default', '--disallowedTools', WRITE_TOOLS);
  else cmd.push('--permission-mode', 'default', '--settings', settingsFile);
  return cmd;
}

const KEEP_ENV = 'CLAUDE_CODE_GIT_BASH_PATH';       // Windows: where Claude Code finds bash, which it needs to run hooks and shell tools
const CHILD_HIDDEN = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK', 'RELAY_', 'FEISHU_'];

// Environment for a `claude -p` child. Drops what Claude Code injected into the parent (CLAUDE_CODE_*, including the
// messaging token of whichever session started the bridge); ANTHROPIC_* is kept. ELECTRON_RUN_AS_NODE is dropped so
// it does not leak into tools claude runs. The entrypoint marks phone-originated turns in the session file.
function childEnv(taskId, bridgeUrl, token) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === KEEP_ENV || !CHILD_HIDDEN.some((p) => k.startsWith(p))
    && !['CLAUDECODE', 'CLAUDE_PID', 'ELECTRON_RUN_AS_NODE'].includes(k)));
  return { ...env, CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT, BRIDGE_TASK_ID: taskId, BRIDGE_URL: bridgeUrl, BRIDGE_TOKEN: token };
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const now = () => Date.now() / 1000;

class Task {
  constructor(sessionId, prompt, mode, cwd, images = null, model = null, effort = null) {
    this.task_id = crypto.randomUUID().replace(/-/g, '');
    this.session_id = sessionId;
    this.prompt = prompt;
    this.images = images || [];
    this.mode = mode;
    this.model = model;
    this.effort = effort;
    this.local_output = null;
    this.cwd = cwd;
    this.status = 'queued';
    this.result = null;
    this.error = null;
    this.warnings = [];
    this.waiting_reason = null;                         // set while a guidance message waits for the editor
    this.wake = null;
    this.proc = null;
    this.cancel_requested = false;
    this.created_at = now();
    this.finished_at = null;
    this.events = [];
  }

  public() {
    return {
      task_id: this.task_id, session_id: this.session_id, mode: this.mode, status: this.status, result: this.result,
      error: this.error, warnings: this.warnings, local_output: this.local_output, waiting_reason: this.waiting_reason,
      created_at: this.created_at, finished_at: this.finished_at,
    };
  }
}

class Runner {
  constructor(store, approvals, emit, stateDir, bridgeUrl, token) {
    this.store = store;
    this.approvals = approvals;
    this.emitRaw = emit;
    this.stateDir = stateDir;
    this.bridgeUrl = bridgeUrl;
    this.token = token;
    this.tasks = new Map();
    this.settle = Number(process.env.BRIDGE_GUIDANCE_SETTLE || '4');
    this.maxWait = Number(process.env.BRIDGE_GUIDANCE_MAX_WAIT || '21600');
    this.settingsFile = path.join(stateDir, 'hook-settings.json');
    fs.writeFileSync(this.settingsFile, JSON.stringify(buildSettings()));
    fs.chmodSync(this.settingsFile, 0o600);
  }

  emit(task, event) {
    event = { sse_event: 'task', task_id: task.task_id, session_id: task.session_id, ts: now(), ...event };
    task.events.push(event);
    if (task.events.length > MAX_TASK_EVENTS) task.events.splice(0, task.events.length - MAX_TASK_EVENTS);
    this.emitRaw(event);
  }

  ownPids() {
    return new Set([...this.tasks.values()].filter((t) => t.proc && t.status === 'running').map((t) => t.proc.pid));
  }

  submit(prompt, sessionId, cwd, mode, force, images = null, model = null, effort = null) {
    images = normalizeImages(images);
    if (prompt === null && images.length) prompt = '';
    if (typeof prompt !== 'string' || (!py.strip(prompt) && !images.length)) throw new TaskError(400, 'prompt_required');
    if (sessionId !== null) {
      if (!sessions.validSessionId(sessionId)) throw new TaskError(400, 'bad_session_id');
      if (sessions.findSessionFile(sessionId) === null) throw new TaskError(404, 'session_not_found');
      cwd = sessions.sessionCwd(sessionId) || cwd;
      if (!sessions.inWorkspace(cwd)) throw new TaskError(403, 'session_outside_workspace');
    } else if (cwd === null) {
      cwd = sessions.workspace();
    }
    if (cwd !== null && !isDir(cwd)) throw new TaskError(400, 'cwd_not_a_directory');
    if (sessionId === null && cwd !== null && !(sessions.inWorkspace(cwd) && this.cwdAllowed(cwd))) {
      throw new TaskError(403, 'cwd_not_allowed', { hint: 'Only directories already used by a session may be chosen.' });
    }
    if (mode !== null && !sessions.MODES.includes(mode)) throw new TaskError(400, 'bad_mode', { allowed: [...sessions.MODES] });
    const effective = mode || (sessionId ? this.store.getMode(sessionId) : sessions.DEFAULT_MODE);
    if (model !== null && !sessions.validModel(model)) throw new TaskError(400, 'bad_model');
    if (effort !== null && !sessions.EFFORTS.includes(effort)) throw new TaskError(400, 'bad_effort', { allowed: [...sessions.EFFORTS] });
    const bodyPrefs = {};
    if (model) bodyPrefs.model = model;
    if (effort) bodyPrefs.effort = effort;
    const stored = sessionId ? this.store.getPrefs(sessionId) : {};
    model = model || stored.model || null;
    effort = effort || stored.effort || null;

    const task = new Task(sessionId, prompt, effective, cwd, images, model, effort);
    if (sessionId) {
      const busy = this.store.claim(sessionId, task.task_id);
      if (busy) throw new TaskError(409, 'session_busy', { task_id: busy });
      const owner = sessions.liveOwner(sessionId, this.ownPids());
      if (owner !== null) {
        // The editor has this session open. Writing while it works would interleave two writers, so a message
        // waits until the editor is quiet, then runs.
        if (!force) task.waiting_reason = this.editorWaitReason(sessionId);
      } else if (!force && this.store.externalWrite(sessionId)) {
        this.store.release(sessionId, task.task_id);
        throw new TaskError(409, 'session_recently_modified', {
          hint: 'Something wrote to this session in the last moments. Retry shortly, or use force.' });
      }
      if (mode) this.store.setMode(sessionId, mode);
      if (Object.keys(bodyPrefs).length) this.store.setPrefs(sessionId, bodyPrefs);
    }
    this.tasks.set(task.task_id, task);
    setImmediate(() => this.run(task).catch((error) => this.finish(task, 'failed', `bridge error: ${error.name}`)));
    return task;
  }

  // Why a write to an editor-owned session must wait right now, or null if it can go
  editorWaitReason(sessionId) {
    const owner = sessions.liveOwner(sessionId, this.ownPids());
    if (owner !== null && owner.status === 'busy') return 'editor_busy';
    const file = sessions.findSessionFile(sessionId);
    try {
      if (file !== null && now() - fs.statSync(file).mtimeMs / 1000 < this.settle) return 'editor_just_wrote';
    } catch {
      // gone
    }
    return null;
  }

  // Hold a queued message until the editor is quiet. False if it was cancelled or timed out.
  async waitForEditor(task) {
    this.emit(task, { event_type: 'task_waiting', reason: task.waiting_reason });
    const deadline = Date.now() + this.maxWait * 1000;
    for (;;) {
      if (task.cancel_requested) {
        this.finish(task, 'cancelled');
        return false;
      }
      if (Date.now() > deadline) {
        this.finish(task, 'failed', 'timed_out_waiting_for_editor');
        return false;
      }
      const reason = this.editorWaitReason(task.session_id);
      if (reason === null) {
        task.waiting_reason = null;
        return true;
      }
      task.waiting_reason = reason;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        task.wake = () => { clearTimeout(timer); resolve(); };
      });
      task.wake = null;
    }
  }

  // New sessions may only start in a directory some session already uses, or under an explicitly allowed root
  // (BRIDGE_ALLOWED_ROOTS, ':' separated)
  cwdAllowed(cwd) {
    const real = py.realpath(cwd);
    if (sessions.workspaces().includes(real)) return true;
    const known = new Set([...this.store.knownCwds()].map(py.realpath));
    for (const e of sessions.liveRegistry()) if (py.truthy(e.cwd)) known.add(py.realpath(e.cwd));
    const roots = (process.env.BRIDGE_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean).map(py.realpath);
    return known.has(real) || roots.some((r) => real === r || real.startsWith(r + path.sep));
  }

  async run(task) {
    if (task.waiting_reason && !(await this.waitForEditor(task))) return;
    if (!task.session_id) commands.refreshModels(task.cwd).catch(() => {});   // a new session: re-read Claude Code's model list
    const withImages = task.images.length > 0;
    const [bin, ...args] = buildCommand(task.mode, task.prompt, task.session_id, this.settingsFile, withImages, task.model, task.effort);
    const proc = spawn(bin, args, {
      cwd: task.cwd || undefined, env: childEnv(task.task_id, this.bridgeUrl, this.token),
      stdio: [withImages ? 'pipe' : 'ignore', 'pipe', 'ignore'],
    });
    const started = await new Promise((resolve) => {
      proc.once('spawn', () => resolve(null));
      proc.once('error', (error) => resolve(error));
    });
    if (started) {
      this.finish(task, 'failed', `cannot start claude: ${started.code === 'ENOENT' ? 'FileNotFoundError' : started.code === 'EACCES' ? 'PermissionError' : 'OSError'}`);
      return;
    }
    task.proc = proc;
    const exited = new Promise((resolve) => proc.once('close', (code, sig) => resolve(code === null ? -(require('node:os').constants.signals[sig] || 1) : code)));
    if (withImages) {
      const payload = stdinMessage(task.prompt, task.images);
      task.images = [];
      proc.stdin.on('error', () => {});
      proc.stdin.end(payload);
    }
    task.status = 'running';
    this.emit(task, { event_type: 'task_started', mode: task.mode });
    let pendingText = '';
    let lastFlush = Date.now();
    let streamed = false;
    let finalError = null;
    const lines = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    for await (const raw of lines) {
      let item;
      try {
        item = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!py.isDict(item)) continue;
      const message = py.isDict(item.message) ? item.message : {};
      const blocks = Array.isArray(message.content) ? message.content : [];
      if (item.type === 'system' && item.subtype === 'init') {
        const newId = item.session_id;
        if (py.truthy(newId) && !task.session_id) {
          task.session_id = newId;
          this.store.claim(newId, task.task_id);
          this.store.setMode(newId, task.mode);
          if (task.model || task.effort) this.store.setPrefs(newId, { model: task.model, effort: task.effort });
        }
        this.emit(task, { event_type: 'session', session_id: task.session_id });
      } else if (item.type === 'stream_event') {
        const event = py.isDict(item.event) ? item.event : {};
        const delta = py.isDict(event.delta) ? event.delta : {};
        if (event.type === 'content_block_delta' && delta.type === 'text_delta') {
          pendingText += typeof delta.text === 'string' ? delta.text : '';
          streamed = true;
          if (Date.now() - lastFlush >= TEXT_FLUSH_SECONDS * 1000) {
            this.emit(task, { event_type: 'text', text: pendingText });
            pendingText = '';
            lastFlush = Date.now();
          }
        }
      } else if (item.type === 'assistant') {
        for (const block of blocks) {
          if (py.isDict(block) && block.type === 'tool_use') {
            this.emit(task, { event_type: 'tool_started', tool_name: block.name ?? null, tool_use_id: block.id ?? null });
          }
        }
      } else if (item.type === 'user') {
        for (const block of blocks) {
          if (py.isDict(block) && block.type === 'tool_result') {
            this.emit(task, { event_type: 'tool_finished', tool_use_id: block.tool_use_id ?? null, is_error: py.truthy(block.is_error) });
          }
        }
      } else if (item.type === 'result') {
        if (pendingText) {
          this.emit(task, { event_type: 'text', text: pendingText });
          pendingText = '';
        }
        task.result = item.result ?? null;
        if (py.truthy(item.is_error)) finalError = py.str(py.truthy(item.subtype) ? item.subtype : 'error');
      }
    }
    const code = await exited;
    if (task.cancel_requested) this.finish(task, 'cancelled');
    else if (finalError || code !== 0) this.finish(task, 'failed', finalError || `exit code ${code}`);
    else {
      if (task.prompt.replace(new RegExp(`^${py.WS_CLASS}+`, 'u'), '').startsWith('/') && !streamed && py.truthy(task.result)) {
        // a slash command answered locally: it is not in the transcript, so hand it to the page
        task.local_output = py.head(redact(py.str(task.result)), MAX_LOCAL_OUTPUT);
      }
      this.finish(task, 'succeeded');
    }
  }

  finish(task, status, error = null) {
    task.status = status;
    task.error = error;
    task.finished_at = now();
    if (task.session_id) {
      this.store.release(task.session_id, task.task_id);
      this.store.remember(task.session_id, task.cwd);
      if (status !== 'cancelled' && sessions.analyzeForks(task.session_id).forked) task.warnings.push('session_forked');
    }
    this.emit(task, { event_type: 'task_finished', status, error, warnings: task.warnings, local_output: task.local_output });
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskError(404, 'task_not_found');
    if (task.status === 'queued' && task.proc === null && task.waiting_reason) {
      task.cancel_requested = true;                     // a message still waiting for the editor: just withdraw it
      if (task.wake) task.wake();
      return task;
    }
    if (!['queued', 'running'].includes(task.status) || task.proc === null) {
      throw new TaskError(409, 'task_not_running', { status: task.status });
    }
    task.cancel_requested = true;
    this.approvals.cancelTask(taskId);
    procTree.terminateTree(task.proc.pid).catch(() => {});
    return task;
  }
}

module.exports = { TaskError, Task, Runner, sniffImage, normalizeImages, stdinMessage, buildSettings, buildCommand, childEnv, hookCommand, MAX_IMAGES, MAX_IMAGE_B64 };
