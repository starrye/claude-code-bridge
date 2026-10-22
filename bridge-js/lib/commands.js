'use strict';

// The slash-command menu: the commands the bridge handles itself, plus the skills Claude Code reports.
// Port of bridge/commands.py.

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const py = require('./py');
const sessions = require('./sessions');
const procTree = require('./proc-tree');

const CACHE_SECONDS = 600;
const PROBE_SECONDS = 30;

// kind "bridge": handled here, no model call. kind "claude": sent to claude as the prompt.
const BUILTINS = [
  { name: 'model', kind: 'bridge', desc: '查看或切换模型', arg: '模型名' },
  { name: 'effort', kind: 'bridge', desc: '设置思考强度', arg: 'low | medium | high | xhigh | max' },
  { name: 'context', kind: 'claude', desc: '查看上下文占用' },
  { name: 'compact', kind: 'claude', desc: '压缩上下文（需要已有会话）', needs_session: true },
  { name: 'clear', kind: 'bridge', desc: '开始新对话' },
];
const cache = new Map();
const pending = new Map();                              // key -> promise of the running probe

const { claudeBin } = require('./claude-bin');
const HIDDEN_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK', 'RELAY_', 'FEISHU_', 'BRIDGE_'];

function probeEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => k === 'CLAUDE_CODE_GIT_BASH_PATH' || !HIDDEN_PREFIXES.some((p) => k.startsWith(p))
    && k !== 'CLAUDECODE' && k !== 'CLAUDE_PID' && k !== 'ELECTRON_RUN_AS_NODE'));
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Skill names from the init event of a throwaway `claude -p /context` run. That command is answered locally (no
// model call, nothing saved), and the run is stopped as soon as the init event arrives.
function probeSkills(cwd) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(claudeBin(), ['-p', '/context', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], {
        cwd: cwd && isDir(cwd) ? cwd : undefined, env: probeEnv(), stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve([]);
      return;
    }
    let done = false;
    let timer;
    let lines;
    const finish = (found) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (lines) lines.close();
      if (proc.pid) procTree.terminateTree(proc.pid, 0.5).catch(() => {});
      resolve(found);
    };
    timer = setTimeout(() => finish([]), PROBE_SECONDS * 1000);
    proc.on('error', () => finish([]));
    lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', (raw) => {
      let item;
      try {
        item = JSON.parse(raw);
      } catch {
        return;
      }
      if (py.isDict(item) && item.type === 'system' && item.subtype === 'init') {
        const skills = item.skills;
        finish(Array.isArray(skills) ? skills.filter(sessions.validCommandName) : []);
      }
    });
    lines.on('close', () => finish([]));
  });
}

function probe(key, cwd) {
  if (!pending.has(key)) {
    pending.set(key, probeSkills(cwd).then((found) => {
      if (found.length) cache.set(key, [Date.now() / 1000, found]);   // a failed probe is not cached; a later open retries
      pending.delete(key);
      return found;
    }));
  }
  return pending.get(key);
}

// [skills, pending]. A cached list is returned at once. Otherwise the probe runs: in the background when wait is
// false (the caller gets the stale list and pending=true, and asks again later), or awaited when wait is true.
async function skillsFor(cwd, wait = false) {
  const key = cwd ? py.realpath(cwd) : '';
  const hit = cache.get(key);
  if (hit && Date.now() / 1000 - hit[0] < CACHE_SECONDS) return [hit[1], false];
  if (wait) return [await probe(key, cwd), false];
  probe(key, cwd);
  return [hit ? hit[1] : [], true];
}

// Claude Code's own model list: the `models` of the reply to an `initialize` control request, the same data its
// /model menu uses. The run is stopped as soon as the reply arrives.
let modelInfo = [];
let modelProbe = null;

function probeModels(cwd) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(claudeBin(), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], {
        cwd: cwd && isDir(cwd) ? cwd : undefined, env: probeEnv(), stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      resolve([]);
      return;
    }
    let done = false;
    let timer;
    let lines;
    const finish = (found) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (lines) lines.close();
      if (proc.pid) procTree.terminateTree(proc.pid, 0.5).catch(() => {});
      resolve(found);
    };
    timer = setTimeout(() => finish([]), PROBE_SECONDS * 1000);
    proc.on('error', () => finish([]));
    proc.stdin.on('error', () => {});
    lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', (raw) => {
      let item;
      try {
        item = JSON.parse(raw);
      } catch {
        return;
      }
      if (!py.isDict(item) || item.type !== 'control_response' || !py.isDict(item.response)) return;
      const list = py.isDict(item.response.response) ? item.response.response.models : null;
      finish(Array.isArray(list) ? list.filter((m) => py.isDict(m) && sessions.validModel(m.value)).map((m) => ({
        value: m.value,
        label: typeof m.displayName === 'string' ? m.displayName : m.value,
        desc: typeof m.description === 'string' ? m.description : '',
        efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => sessions.EFFORTS.includes(e)) : [],
      })) : []);
    });
    lines.on('close', () => finish([]));
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n');
  });
}

// Refresh the list from Claude Code; called when a new session starts. A failed probe keeps the previous list.
function refreshModels(cwd) {
  if (!modelProbe) {
    modelProbe = probeModels(cwd).then((found) => {
      if (found.length) modelInfo = found;
      modelProbe = null;
    });
  }
  return modelProbe;
}

function models() {
  const extra = (process.env.BRIDGE_MODELS || '').split(',').map(py.strip).filter(sessions.validModel);
  return [...new Set([...(modelInfo.length ? modelInfo.map((m) => m.value) : sessions.BUILTIN_MODELS), ...extra])];
}

// The menu. `pending` is true while the skill list is still being fetched in the background.
async function catalog(cwd, wait = false) {
  const taken = new Set(BUILTINS.map((c) => c.name));
  const [found, isPending] = await skillsFor(cwd, wait);
  if (!modelInfo.length) refreshModels(cwd);
  const skills = found.filter((s) => !taken.has(s)).map((s) => ({ name: s, kind: 'claude', desc: '技能' }));
  return { commands: [...BUILTINS, ...skills], models: models(), model_info: modelInfo, efforts: [...sessions.EFFORTS], pending: isPending };
}

function clearCache() {
  cache.clear();
  pending.clear();
}

module.exports = { BUILTINS, probeSkills, skillsFor, models, refreshModels, catalog, clearCache };
