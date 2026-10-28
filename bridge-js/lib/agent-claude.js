'use strict';

// Claude Code as an agent: where its sessions are, how they read, and what runs a task. server.js talks to agents
// through this shape only (see agents.js), so another agent can sit beside it.

const py = require('./py');
const sessions = require('./sessions');
const transcript = require('./transcript');
const commands = require('./commands');
const { Runner } = require('./runner');

const ID = 'claude';

function sessionModels(store, sid) {
  const prefs = store.getPrefs(sid);
  return { model_pref: prefs.model ?? null, effort_pref: prefs.effort ?? null, served_model: sessions.servedModel(sid), usage: sessions.sessionUsage(sid) };
}

// Sessions open in Claude Code processes now (VS Code panels and terminals), then sessions this bridge ran
function listSessions(store) {
  const out = [];
  for (const entry of sessions.liveRegistry()) {
    if (!sessions.inWorkspace(entry.cwd)) continue;
    const sid = entry.sessionId;
    out.push({
      session_id: sid, agent: ID, name: entry.name, title: sessions.sessionTitle(sid), source: entry.entrypoint, cwd: entry.cwd, root: sessions.rootOf(entry.cwd),
      status: py.truthy(entry.status) ? entry.status : 'unknown', updated_at: entry.updatedAt, version: entry.version,
      editor_mode: sessions.lastPermissionMode(sid), phone_mode: store.getMode(sid), busy_task: store.busyTask(sid),
      ...sessionModels(store, sid), editor_open: true,
    });
  }
  const live = new Set(out.map((s) => s.session_id));
  for (const [sid, info] of Object.entries(store.known())) {
    if (live.has(sid) || sessions.findSessionFile(sid) === null || !sessions.inWorkspace(info.cwd ?? null)) continue;
    out.push({
      session_id: sid, agent: ID, name: null, title: sessions.sessionTitle(sid), source: 'feishu-bridge', cwd: info.cwd ?? null, root: sessions.rootOf(info.cwd ?? null),
      status: 'closed', updated_at: info.updated_at ?? null, version: null, editor_mode: null, phone_mode: store.getMode(sid),
      busy_task: store.busyTask(sid), ...sessionModels(store, sid), editor_open: false,
    });
  }
  return out;
}

// Why the list may be empty: the facts the page turns into a hint
function diagnostics(listed) {
  const host = sessions.hostInfo();
  const hidden = sessions.liveRegistry().filter((e) => !sessions.inWorkspace(e.cwd)).length;
  let notice = null;
  if (!host.projects_exists && !host.registry_exists) notice = 'no_claude_data';
  else if (!listed.length && hidden) notice = 'hidden_by_workspace';
  else if (!listed.length) notice = 'no_sessions';
  return { host, hidden, notice };
}

const hasSession = (sid) => sessions.findSessionFile(sid) !== null;

// One page of the transcript, or null when the branch does not exist. The caller checks hasSession first.
const messages = (sid, after, limit, branch, afterId) => transcript.messages(sessions.findSessionFile(sid), after, limit, branch, afterId);

module.exports = {
  id: ID,
  listSessions,
  diagnostics,
  hasSession,
  messages,
  forks: (sid) => sessions.analyzeForks(sid),
  catalog: (cwd, wait) => commands.catalog(cwd, wait),
  createRunner: (store, approvals, publish, stateDir, bridgeUrl, token) => new Runner(store, approvals, publish, stateDir, bridgeUrl, token),
};
