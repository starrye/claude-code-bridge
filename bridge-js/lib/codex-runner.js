'use strict';

// Runs phone tasks on Codex threads through the shared app-server. Same task/event shape as runner.js (Claude).

const fs = require('node:fs');
const path = require('node:path');
const py = require('./py');
const sessions = require('./sessions');
const { TaskError, Task, normalizeImages } = require('./runner');
const items = require('./codex-items');

const TEXT_FLUSH_MS = 500;
const MAX_TASK_EVENTS = 500;
const LOCKED = /already has an active writer/;
const now = () => Date.now() / 1000;
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const SANDBOX = {
  readonly: { type: 'readOnly', networkAccess: false },
  write: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
};
const policy = (mode) => (mode === 'readonly' ? [SANDBOX.readonly, 'never'] : [SANDBOX.write, mode === 'auto' ? 'never' : 'on-request']);
const textInput = (text) => ({ type: 'text', text, text_elements: [] });

// The review target a phone may ask for: uncommitted changes, a base branch, a commit, or free-form instructions
function reviewTarget(target) {
  const bad = () => new TaskError(400, 'bad_review_target');
  if (!target || typeof target !== 'object') throw bad();
  if (target.type === 'uncommittedChanges') return { type: 'uncommittedChanges' };
  if (target.type === 'baseBranch' && typeof target.branch === 'string' && /^[\w][\w./-]{0,99}$/.test(target.branch)) return { type: 'baseBranch', branch: target.branch };
  if (target.type === 'commit' && typeof target.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(target.sha)) return { type: 'commit', sha: target.sha, title: null };
  if (target.type === 'custom' && typeof target.instructions === 'string' && py.strip(target.instructions) && target.instructions.length <= 4000) return { type: 'custom', instructions: target.instructions };
  throw bad();
}

class CodexRunner {
  constructor(agent, store, approvals, emit, stateDir) {
    this.agent = agent;
    this.store = store;
    this.approvals = approvals;
    this.emitRaw = emit;
    this.imageDir = path.join(stateDir, 'codex-images');
    this.tasks = new Map();
    this.byThread = new Map();                          // thread id -> running task
    const server = agent.server();
    server.on('notification', (method, params) => this.onNotification(method, params));
    server.on('request', (method, params, reply) => this.onRequest(method, params, reply));
    server.on('exit', () => {
      for (const task of this.byThread.values()) this.finish(task, 'failed', 'codex_exited');
    });
  }

  emit(task, event) {
    event = { sse_event: 'task', task_id: task.task_id, session_id: task.session_id, agent: 'codex', ts: now(), ...event };
    task.events.push(event);
    if (task.events.length > MAX_TASK_EVENTS) task.events.splice(0, task.events.length - MAX_TASK_EVENTS);
    this.emitRaw(event);
  }

  submit(prompt, sessionId, cwd, mode, force, images = null, model = null, effort = null, review = null) {
    images = normalizeImages(images);
    if (review !== null) review = reviewTarget(review);
    if (prompt === null && (images.length || review)) prompt = '';
    if (typeof prompt !== 'string' || (!py.strip(prompt) && !images.length && !review)) throw new TaskError(400, 'prompt_required');
    if (sessionId !== null) {
      if (!sessions.validSessionId(sessionId)) throw new TaskError(400, 'bad_session_id');
      if (!this.agent.hasSession(sessionId)) throw new TaskError(404, 'session_not_found');
      cwd = this.agent.cwdOf(sessionId) || cwd;
      if (cwd && !sessions.inWorkspace(cwd)) throw new TaskError(403, 'session_outside_workspace');
    } else if (cwd === null) {
      cwd = sessions.workspace();
    } else if (!sessions.inWorkspace(cwd)) {
      throw new TaskError(403, 'cwd_not_allowed');
    }
    if (cwd !== null && !isDir(cwd)) throw new TaskError(400, 'cwd_not_a_directory');
    if (mode !== null && !sessions.MODES.includes(mode)) throw new TaskError(400, 'bad_mode', { allowed: [...sessions.MODES] });
    if (model !== null && !sessions.validModel(model)) throw new TaskError(400, 'bad_model');
    if (effort !== null && !this.agent.EFFORTS.includes(effort)) throw new TaskError(400, 'bad_effort', { allowed: [...this.agent.EFFORTS] });
    const stored = sessionId ? this.store.getPrefs(sessionId) : {};
    const task = new Task(sessionId, prompt, mode || (sessionId ? this.store.getMode(sessionId) : sessions.DEFAULT_MODE), cwd, images,
      model || stored.model || null, effort || stored.effort || null);
    task.turn_id = null;
    task.review = review;
    task.fork = Boolean(force);
    if (sessionId) {
      const busy = this.store.claim(sessionId, task.task_id);
      if (busy) throw new TaskError(409, 'session_busy', { task_id: busy });
      if (mode) this.store.setMode(sessionId, mode);
      const prefs = {};
      if (model) prefs.model = model;
      if (effort) prefs.effort = effort;
      if (Object.keys(prefs).length) this.store.setPrefs(sessionId, prefs);
    }
    this.tasks.set(task.task_id, task);
    setImmediate(() => this.run(task).catch((error) => this.finish(task, 'failed', error.message === 'codex_unavailable' ? 'codex_unavailable' : `codex error: ${error.message}`)));
    return task;
  }

  // Sent images stay on disk so the thread history can show them later; only old ones are removed
  pruneImages() {
    const cutoff = Date.now() - 30 * 86400 * 1000;
    try {
      for (const name of fs.readdirSync(this.imageDir)) {
        const file = path.join(this.imageDir, name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      }
    } catch {}
  }

  // `skill`: the Codex skill named by a leading /name in the prompt, found by the caller
  input(task, skill = null) {
    const out = [];
    if (task.images.length) {
      fs.mkdirSync(this.imageDir, { recursive: true, mode: 0o700 });
      this.pruneImages();
    }
    task.images.forEach((image, i) => {
      const file = path.join(this.imageDir, `${task.task_id}-${i}.${image.media_type.split('/')[1]}`);
      fs.writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 });
      out.push({ type: 'localImage', path: file });
    });
    task.images = [];
    out.push(...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : []));
    if (py.strip(task.prompt)) out.push(textInput(task.prompt));
    return out;
  }

  // "/name rest" with a known skill name: the skill is attached and the prompt becomes "$name rest" (Codex's own syntax)
  async skillOf(task) {
    const m = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(task.prompt || '');
    const skill = m && await this.agent.skillOf(task.cwd, m[1]);
    if (!skill) return null;
    task.prompt = `$${skill.name}${m[2] ? ` ${m[2]}` : ''}`;
    return skill;
  }

  // Load the thread into our app-server; a thread another Codex process is writing is refused, or forked if asked
  async open(task) {
    const server = this.agent.server();
    if (!task.session_id) {
      const started = await server.request('thread/start', { cwd: task.cwd, model: task.model, threadSource: 'user' });
      return started.thread.id;
    }
    try {
      await server.request('thread/resume', { threadId: task.session_id, excludeTurns: true });
      return task.session_id;
    } catch (error) {
      if (!LOCKED.test(error.message)) throw error;
      if (!task.fork) throw new TaskError(409, 'editor_locked');
      const forked = await server.request('thread/fork', { threadId: task.session_id, excludeTurns: true });
      return forked.thread.id;
    }
  }

  async run(task) {
    let threadId;
    try {
      threadId = await this.open(task);
    } catch (error) {
      this.finish(task, 'failed', error instanceof TaskError ? error.code : error.message === 'codex_unavailable' ? 'codex_unavailable' : `codex error: ${error.message}`);
      return;
    }
    if (task.cancel_requested) return this.finish(task, 'cancelled');
    if (threadId !== task.session_id) {
      if (task.session_id) this.store.release(task.session_id, task.task_id);
      task.forked_from = task.session_id;
      task.session_id = threadId;
      this.store.claim(threadId, task.task_id);
      this.emit(task, { event_type: 'session', session_id: threadId, forked_from: task.forked_from || null });
    }
    this.byThread.set(threadId, task);
    task.status = 'running';
    this.emit(task, { event_type: 'task_started', mode: task.mode });
    const [sandboxPolicy, approvalPolicy] = policy(task.mode);
    try {
      const skill = task.review ? null : await this.skillOf(task);
      const started = task.review
        ? await this.agent.server().request('review/start', { threadId, target: task.review, delivery: 'inline' })
        : await this.agent.server().request('turn/start', {
          threadId, input: this.input(task, skill), cwd: task.cwd, approvalPolicy, sandboxPolicy, model: task.model, effort: task.effort,
        });
      task.turn_id = started.turn.id;
      if (task.cancel_requested) this.interrupt(task);
    } catch (error) {
      this.finish(task, 'failed', `codex error: ${error.message}`);
    }
  }

  flush(task) {
    if (task.flushTimer) clearTimeout(task.flushTimer);
    task.flushTimer = null;
    if (task.pendingText) this.emit(task, { event_type: 'text', text: task.pendingText });
    task.pendingText = '';
  }

  onNotification(method, params) {
    const task = this.byThread.get(params.threadId);
    if (!task || task.status !== 'running') return;
    if (method === 'turn/started' && !task.turn_id) task.turn_id = params.turn.id;
    else if (method === 'item/agentMessage/delta') {
      task.pendingText = (task.pendingText || '') + py.str(params.delta);
      if (!task.flushTimer) task.flushTimer = setTimeout(() => this.flush(task), TEXT_FLUSH_MS);
    } else if (method === 'item/started') {
      const [name] = items.toolOf(params.item);
      if (name) {
        this.flush(task);
        this.emit(task, { event_type: 'tool_started', tool_name: name, tool_use_id: params.item.id });
      }
    } else if (method === 'item/completed') {
      const item = params.item;
      if (item.type === 'agentMessage') {
        this.flush(task);
        task.result = item.text;
      } else if (item.type === 'exitedReviewMode') {
        // the review text, unless it already arrived as the agent's message
        if (py.strip(py.str(item.review)) && item.review !== task.result) { this.emit(task, { event_type: 'text', text: item.review }); task.result = item.review; }
      } else if (items.toolOf(item)[0]) {
        const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0);
        this.emit(task, { event_type: 'tool_finished', tool_use_id: item.id, is_error: failed });
      }
    } else if (method === 'turn/completed' && (!task.turn_id || params.turn.id === task.turn_id)) {
      this.flush(task);
      const status = params.turn.status;
      if (status === 'interrupted' || task.cancel_requested) this.finish(task, 'cancelled');
      else if (status === 'failed') this.finish(task, 'failed', py.str((params.turn.error && params.turn.error.message) || 'turn failed'));
      else this.finish(task, 'succeeded');
    }
  }

  // Approval requests from Codex become phone approval cards; "auto" decided now is honoured mid-run too
  async onRequest(method, params, reply) {
    const task = this.byThread.get(params.threadId);
    const command = method === 'item/commandExecution/requestApproval';
    if (!command && method !== 'item/fileChange/requestApproval') return reply(null, { code: -32601, message: 'not supported by Agent Bridge' });
    if (!task || task.status !== 'running') return reply({ decision: 'decline' });
    if (this.store.getMode(task.session_id) === 'auto') return reply({ decision: 'accept' });
    let summary;
    let tool;
    if (command) {
      tool = 'Bash';
      summary = items.commandSummary(params.command || '', params.reason || null);
    } else {
      tool = 'Edit';
      const change = (task.changes || {})[params.itemId];
      summary = change ? items.toolOf(change)[1] : { file_path: params.grantRoot || '' };
      if (params.reason) summary.description = py.head(py.str(params.reason), 200);
    }
    this.flush(task);
    const [decision] = await this.approvals.request(task.task_id, task.session_id, params.itemId, tool, summary);
    reply({ decision: decision === 'allow' ? 'accept' : 'decline' });
  }

  interrupt(task) {
    if (task.turn_id) this.agent.server().request('turn/interrupt', { threadId: task.session_id, turnId: task.turn_id }).catch(() => {});
  }

  steer(taskId, prompt) {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskError(404, 'task_not_found');
    if (task.status !== 'running' || !task.turn_id) throw new TaskError(409, 'task_not_running', { status: task.status });
    if (typeof prompt !== 'string' || !py.strip(prompt)) throw new TaskError(400, 'prompt_required');
    this.flush(task);
    this.emit(task, { event_type: 'steered', text: prompt });
    return this.agent.server().request('turn/steer', { threadId: task.session_id, input: [textInput(prompt)], expectedTurnId: task.turn_id })
      .then(() => task, (error) => { throw new TaskError(409, 'steer_failed', { reason: error.message }); });
  }

  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskError(404, 'task_not_found');
    if (!['queued', 'running'].includes(task.status)) throw new TaskError(409, 'task_not_running', { status: task.status });
    task.cancel_requested = true;
    this.approvals.cancelTask(taskId);
    this.interrupt(task);
    return task;
  }

  finish(task, status, error = null) {
    if (task.finished_at) return;
    this.flush(task);
    task.status = status;
    task.error = error;
    task.finished_at = now();
    if (this.byThread.get(task.session_id) === task) this.byThread.delete(task.session_id);
    if (task.session_id) {
      this.store.release(task.session_id, task.task_id);
      this.store.remember(task.session_id, task.cwd);
      // let the editor's Codex take the thread again
      this.agent.server().request('thread/unsubscribe', { threadId: task.session_id }).catch(() => {});
    }
    this.agent.invalidate();
    this.emit(task, { event_type: 'task_finished', status, error, warnings: task.warnings, local_output: null });
  }
}

module.exports = { CodexRunner };
