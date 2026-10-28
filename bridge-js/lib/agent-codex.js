'use strict';

// OpenAI Codex as an agent, through one shared `codex app-server`. Thread lists are cached and refreshed in the
// background because server.js lists sessions synchronously; transcripts are read on demand.

const py = require('./py');
const sessions = require('./sessions');
const { codexBin } = require('./codex-bin');
const { CodexServer } = require('./codex-server');
const items = require('./codex-items');

const ID = 'codex';
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const LIST_TTL_MS = 5000;
const LIST_LIMIT = 100;
const MAX_LIMIT = 200;

let server = null;
let threads = [];                                       // last thread/list result, already filtered to the workspace
let listedAt = 0;
let listing = null;
let modelInfo = [];

const bin = () => codexBin();
const available = () => bin() !== null;
let takeover = null;                                    // { shared: SharedServer, original } while the editor is taken over

// The editor's Codex and this Bridge share one app-server when the bundled codex can be taken over
// (BRIDGE_CODEX_TAKEOVER=0 turns it off). Returns what happened, for the log.
async function startTakeover(log = () => {}) {
  const { install, uninstall, SharedServer } = require('./codex-takeover');
  const file = bin();
  if (!file) return 'no_codex';
  if (process.env.BRIDGE_CODEX_TAKEOVER === '0') {
    const restored = uninstall(require('node:path').resolve(file, '..', '..', '..', '..'));
    return restored.length ? 'restored' : 'off';
  }
  let installed;
  try {
    installed = install(file);
  } catch (error) {
    return `skipped: ${error.code || error.message}`;
  }
  if (installed.state === 'skipped') return `skipped: ${installed.reason}`;
  const shared = new SharedServer(installed.original, log);
  await shared.start();
  takeover = { shared, original: installed.original, state: installed.state };
  return installed.state;
}

function getServer() {
  if (!server) {
    // through the forwarder: while the shared server runs this client joins it, else it runs its own codex
    const forwarder = takeover ? [process.execPath, require.resolve('./codex-forward'), takeover.original] : null;
    server = forwarder
      ? new CodexServer(forwarder[0], { version: process.env.BRIDGE_VERSION || '0', args: [forwarder[1], forwarder[2], 'app-server'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      : new CodexServer(bin(), { version: process.env.BRIDGE_VERSION || '0' });
  }
  return server;
}

function refresh() {
  if (listing || !available()) return listing;
  const roots = sessions.workspaces();
  listing = getServer().request('thread/list', { limit: LIST_LIMIT, sortKey: 'updated_at', archived: false, ...(roots.length ? { cwd: roots } : {}) })
    .then((result) => {
      threads = (result.data || []).filter((t) => !t.ephemeral && !t.parentThreadId && sessions.inWorkspace(t.cwd));
      listedAt = Date.now();
    })
    .catch(() => {})
    .finally(() => { listing = null; });
  return listing;
}

const invalidate = () => { listedAt = 0; refresh(); };

// notLoaded means no client of the app-server has the thread open; only meaningful while the editor shares that server
function statusOf(t, shared) {
  const type = t.status && t.status.type;
  if (type === 'active') return 'busy';
  return shared && type === 'notLoaded' ? 'closed' : 'idle';
}

const SOURCES = { vscode: 'codex-vscode', cli: 'codex-cli', exec: 'codex-exec', appServer: 'feishu-bridge' };

function listSessions(store) {
  if (Date.now() - listedAt > LIST_TTL_MS) refresh();
  return threads.map((t) => {
    const prefs = store.getPrefs(t.id);
    return {
      session_id: t.id, agent: ID, name: t.name || null, title: py.head(py.str(t.name || t.preview || ''), 80) || null,
      source: SOURCES[t.source] || 'codex', cwd: t.cwd, root: sessions.rootOf(t.cwd),
      status: statusOf(t, takeover !== null), updated_at: t.updatedAt * 1000, version: t.cliVersion || null,
      editor_mode: null, phone_mode: store.getMode(t.id), busy_task: store.busyTask(t.id),
      model_pref: prefs.model ?? null, effort_pref: prefs.effort ?? null, served_model: t.model || null, usage: null,
      editor_open: t.source === 'vscode' || t.source === 'cli',
    };
  });
}

const find = (sid) => threads.find((t) => t.id === sid) || null;
const hasSession = (sid) => find(sid) !== null;
const cwdOf = (sid) => (find(sid) || {}).cwd || null;

async function messages(sid, after, limit, branch, afterId) {
  if (branch !== null) return null;
  limit = Math.max(1, Math.min(limit, MAX_LIMIT));
  const { thread } = await getServer().request('thread/read', { threadId: sid, includeTurns: true });
  const all = items.render(thread.turns);
  const total = all.length;
  let reset = false;
  let start;
  if (afterId !== null) {
    const at = all.findIndex((i) => i.id === afterId);
    if (at >= 0) start = at + 1;
    else {
      start = Math.max(0, total - limit);
      reset = true;
    }
  } else if (after !== null) start = Math.max(0, Math.min(after, total));
  else start = Math.max(0, total - limit);
  return { total, start, items: all.slice(start, start + limit), reset, last_id: total ? all[total - 1].id : null, branches: [], branch: null };
}

// The skills Codex finds for a folder (kept a minute: the editor's own list is the same scan)
const skillCache = new Map();
async function skillsFor(cwd) {
  const hit = skillCache.get(cwd);
  if (hit && Date.now() - hit.at < 60000) return hit.skills;
  let skills = [];
  try {
    const { data } = await getServer().request('skills/list', { cwds: [cwd] });
    skills = ((data || [])[0] || {}).skills || [];
    skills = skills.filter((k) => k.enabled).map((k) => ({ name: k.name, path: k.path, desc: py.head(py.str((k.interface && k.interface.shortDescription) || k.shortDescription || k.description), 80) }));
  } catch {
    // Codex not reachable: no skills in the menu
  }
  skillCache.set(cwd, { at: Date.now(), skills });
  return skills;
}

const skillOf = async (cwd, name) => (await skillsFor(cwd)).find((k) => k.name === name) || null;

// Session id, model, effort and the account's usage limits, for /status
async function status(sid) {
  const t = find(sid);
  const out = { session_id: sid, model: t ? t.model || null : null, effort: null, limits: [] };
  try {
    const result = await getServer().request('account/rateLimits/read', undefined);
    const snap = result.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [result.rateLimits];
    for (const b of snap.filter(Boolean)) {
      for (const [key, w] of [['primary', b.primary], ['secondary', b.secondary]]) {
        if (w) out.limits.push({ name: [b.limitName || b.limitId, key].filter(Boolean).join(' · '), used_percent: w.usedPercent, window_mins: w.windowDurationMins, resets_at: w.resetsAt });
      }
    }
  } catch {
    // not signed in with ChatGPT, or no usage data: only the session facts
  }
  return out;
}

const FEEDBACK_KINDS = ['bad_result', 'good_result', 'bug', 'other'];
const GOAL_ACTIONS = ['get', 'set', 'clear', 'pause', 'resume'];

// Compact, goal and feedback for one thread. The thread is loaded into our app-server first; one the editor alone holds is refused.
async function session(sid, action, body) {
  const { TaskError } = require('./runner');
  const server = getServer();
  if (!find(sid)) throw new TaskError(404, 'session_not_found');
  if (action === 'feedback') {
    if (!FEEDBACK_KINDS.includes(body.classification)) throw new TaskError(400, 'bad_classification', { allowed: FEEDBACK_KINDS });
    const reason = typeof body.reason === 'string' ? py.head(body.reason, 2000) : null;
    try {
      await server.request('feedback/upload', { classification: body.classification, reason: reason || null, threadId: sid, includeLogs: false });
    } catch (error) {
      throw new TaskError(502, 'feedback_failed', { reason: error.message });
    }
    return { ok: true };
  }
  try {
    await server.request('thread/resume', { threadId: sid, excludeTurns: true });
  } catch (error) {
    throw new TaskError(/already has an active writer/.test(error.message) ? 409 : 502, /already has an active writer/.test(error.message) ? 'editor_locked' : 'codex_failed', { reason: error.message });
  }
  try {
    if (action === 'compact') {
      await server.request('thread/compact/start', { threadId: sid });
      return { ok: true };
    }
    if (!GOAL_ACTIONS.includes(body.action)) throw new TaskError(400, 'bad_goal_action', { allowed: GOAL_ACTIONS });
    if (body.action === 'get') return await server.request('thread/goal/get', { threadId: sid });
    if (body.action === 'clear') { await server.request('thread/goal/clear', { threadId: sid }); return { goal: null }; }
    if (body.action === 'set') {
      if (typeof body.objective !== 'string' || !py.strip(body.objective) || body.objective.length > 4000) throw new TaskError(400, 'bad_objective');
      const budget = body.token_budget === undefined || body.token_budget === null ? null : Number(body.token_budget);
      if (budget !== null && !(Number.isInteger(budget) && budget > 0)) throw new TaskError(400, 'bad_token_budget');
      return await server.request('thread/goal/set', { threadId: sid, objective: body.objective, tokenBudget: budget });
    }
    return await server.request('thread/goal/set', { threadId: sid, status: body.action === 'pause' ? 'paused' : 'active' });
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError(502, 'codex_failed', { reason: error.message });
  } finally {
    // the editor may take the thread again; a running goal keeps its thread loaded while the editor shares this server
    if (!takeover) server.request('thread/unsubscribe', { threadId: sid }).catch(() => {});
  }
}

async function catalog(cwd) {
  if (!modelInfo.length && available()) {
    try {
      const { data } = await getServer().request('model/list', { includeHidden: false });
      modelInfo = (data || []).filter((m) => !m.hidden).map((m) => ({ value: m.model, label: m.displayName, desc: py.head(py.str(m.description), 80), default: m.isDefault }));
    } catch {
      // Codex not signed in or not reachable: the page shows no model choices
    }
  }
  const skills = cwd && available() ? await skillsFor(cwd) : [];
  return {
    commands: [
      { name: 'review', kind: 'codex', desc: '审查未提交的更改,或与某个分支、提交比较' },
      { name: 'init', kind: 'codex', desc: '创建包含 Codex 指令的 AGENTS.md 文件' },
      { name: 'feedback', kind: 'codex', desc: '发送有关此聊天的反馈' },
      { name: 'compact', kind: 'codex', desc: '压缩上下文' },
      { name: 'status', kind: 'codex', desc: '会话 ID、模型和用量限制' },
      { name: 'goal', kind: 'codex', desc: '设置要持续追求的目标' },
      { name: 'sketch', kind: 'codex', desc: '绘制草图,作为图片发送' },
      ...skills.map((k) => ({ name: k.name, kind: 'skill', desc: k.desc }))],
    models: modelInfo.map((m) => m.value), model_info: modelInfo, efforts: EFFORTS, pending: false,
  };
}

function createRunner(store, approvals, publish, stateDir) {
  const { CodexRunner } = require('./codex-runner');
  return new CodexRunner(module.exports, store, approvals, publish, stateDir);
}

module.exports = {
  id: ID, EFFORTS, available, listSessions, hasSession, cwdOf, messages, catalog, invalidate, refresh,
  server: getServer, forks: () => ({ found: true, forked: false, fork_points: [] }), createRunner,
  diagnostics: () => ({}),
  startTakeover, statusOf, status, skillOf, session,
  takenOver: () => Boolean(takeover),
  close: () => {
    if (server) server.close();
    if (takeover) takeover.shared.stop();
  },
};
