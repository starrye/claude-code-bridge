'use strict';

// Local HTTP + SSE bridge between the phone page and Claude Code. Port of server.py; same endpoints, same replies.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const py = require('./lib/py');
const sessions = require('./lib/sessions');
const agents = require('./lib/agents');
const { Approvals, summarizeInput } = require('./lib/approvals');
const { TaskError } = require('./lib/runner');

const MAX_BODY_BYTES = 1000000;
const MAX_TASK_BODY_BYTES = 9000000;
const STATIC_DIR = process.env.BRIDGE_STATIC_DIR || path.join(__dirname, '..', 'web');
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = py.int(process.env.BRIDGE_PORT || '8787');
const UID = process.getuid ? process.getuid() : 0;
const TMP = process.platform === 'win32' ? require('node:os').tmpdir() : '/tmp';
const EVENTS_FILE = process.env.CLAUDE_EVENTS_FILE || path.join(TMP, `claude-feishu-probe-${UID}`, 'events.jsonl');
const STATE_DIR = process.env.BRIDGE_STATE_DIR || path.join(TMP, `claude-bridge-${UID}`);
const MIN_TOKEN_LENGTH = 24;
const FAIL_LIMIT = py.int(process.env.BRIDGE_FAIL_LIMIT || '20');
const FAIL_WINDOW = Number(process.env.BRIDGE_FAIL_WINDOW || '60');
const SSE_MAX_BUFFER = 4 * 1024 * 1024;                 // a slow page drops events instead of growing memory

const subscribers = new Set();
let TOKEN = '';
const runners = new Map();                              // agent id -> its Runner
let approvals = null;
let store = null;
const failures = [];
const relayCache = { stamp: null, access: '' };

const monotonic = () => Number(process.hrtime.bigint() / 1000000n) / 1000;

// Shared secret for every endpoint except /healthz and the static page
function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const file = path.join(STATE_DIR, 'token');
  try {
    return py.strip(fs.readFileSync(file, 'utf8'));
  } catch {
    const token = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(file, token, { mode: 0o600 });
    return token;
  }
}

function recentFailures(now) {
  const kept = failures.filter((t) => now - t < FAIL_WINDOW);
  failures.splice(0, failures.length, ...kept);
  return failures.length;
}

function recordFailure(now) {
  failures.push(now);
  if (failures.length > 1000) failures.splice(0, failures.length - 1000);
}

// Access value derived from the relay secret, from RELAY_SECRET or the file the connector writes after a QR
// binding. The file is re-read when it changes, so the Bridge needs no restart.
function currentRelayAccess() {
  const derive = (secret) => (py.len(secret) >= 24 ? crypto.createHmac('sha256', secret).update('bridge-access').digest('hex') : '');
  if (process.env.RELAY_SECRET) return derive(process.env.RELAY_SECRET);
  const file = path.join(STATE_DIR, 'relay.env');
  let stamp;
  try {
    stamp = String(fs.statSync(file, { bigint: true }).mtimeNs);
  } catch {
    relayCache.stamp = null;
    relayCache.access = '';
    return '';
  }
  if (relayCache.stamp !== stamp) {
    const values = {};
    try {
      for (const line of py.splitlines(fs.readFileSync(file, 'utf8'))) {
        const at = line.indexOf('=');
        if (at >= 0) values[line.slice(0, at)] = line.slice(at + 1);
      }
    } catch {
      // unreadable: no relay access
    }
    relayCache.stamp = stamp;
    relayCache.access = derive(py.strip(values.RELAY_SECRET || ''));
  }
  return relayCache.access;
}

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    + "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const TASK_PATH = /^\/tasks\/([0-9a-f]{32})(\/cancel|\/steer)?$/;
const APPROVAL_PATH = /^\/approvals\/([0-9a-f]{32})$/;
const SESSION_PATH = /^\/sessions\/([0-9a-f-]{36})\/(mode|forks|messages|prefs|status|goal|compact|feedback)$/;

// Every agent's sessions, newest first
function listSessions() {
  const out = agents.AGENTS.flatMap((agent) => agent.listSessions(store));
  // stable sort, newest first, same as Python's sort(reverse=True)
  const key = (s) => (py.truthy(s.updated_at) ? s.updated_at : 0);
  return out.map((s, i) => [s, i]).sort((a, b) => (key(b[0]) > key(a[0]) ? 1 : key(b[0]) < key(a[0]) ? -1 : a[1] - b[1])).map(([s]) => s);
}

// A task of any agent
const findTask = (taskId) => {
  for (const runner of runners.values()) if (runner.tasks.has(taskId)) return runner.tasks.get(taskId);
  return undefined;
};
const allTasks = () => [...runners.values()].flatMap((runner) => [...runner.tasks.values()]);

// uuid.uuid5(uuid.NAMESPACE_URL, name)
function uuid5Url(name) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const hash = crypto.createHash('sha1').update(namespace).update(Buffer.from(name, 'utf8')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const HOOK_EVENTS = {
  PreToolUse: ['tool_started', 'running'], PostToolUse: ['tool_succeeded', 'succeeded'], PostToolUseFailure: ['tool_failed', 'failed'],
  MessageDisplay: ['assistant_message', 'completed'], Stop: ['turn_stopped', 'completed'], SessionEnd: ['session_ended', 'completed'],
};

// Convert a Hook event to a frontend-safe event without tool payloads
function normalize(raw) {
  const get = (k) => (Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : null);
  const eventName = Object.prototype.hasOwnProperty.call(raw, 'hook_event_name') ? raw.hook_event_name : 'Unknown';
  const [eventType, status] = HOOK_EVENTS[eventName] || [eventName, 'unknown'];
  const key = ['hook_event_name', 'session_id', 'turn_id', 'message_id', 'tool_use_id', 'index', 'received_at']
    .map((k) => (Object.prototype.hasOwnProperty.call(raw, k) ? py.str(raw[k]) : '')).join('|');
  return {
    event_id: uuid5Url(key), event_type: eventType, status, hook_event_name: eventName, session_id: get('session_id'),
    turn_id: get('turn_id'), message_id: get('message_id'), tool_use_id: get('tool_use_id'), tool_name: get('tool_name'),
    index: get('index'), final: get('final'), delta: get('delta'), received_at: get('received_at'),
  };
}

function sseFrame(event) {
  return `event: ${event.sse_event ?? 'hook'}\ndata: ${JSON.stringify(event)}\n\n`;
}

function publish(event) {
  const frame = sseFrame(event);
  for (const response of subscribers) {
    if (response.writableLength < SSE_MAX_BUFFER) response.write(frame);   // slow page: drop rather than block
  }
}

// Complete JSONL records from position on, preserving byte offsets
function readJsonl(file, position) {
  const data = fs.readFileSync(file).subarray(position);
  const last = data.lastIndexOf(10);
  if (last < 0) return [[], position];
  const events = [];
  for (const line of data.subarray(0, last + 1).toString('utf8').split(/\r\n|\r|\n/)) {
    try {
      const item = JSON.parse(line);
      if (py.isDict(item)) events.push(item);
    } catch {
      // partial or foreign line
    }
  }
  return [events, position + last + 1];
}

function watchEvents() {
  let position = 0;
  let identity = null;
  setInterval(() => {
    try {
      const info = fs.statSync(EVENTS_FILE);
      const current = `${info.dev}:${info.ino}`;
      if (identity !== current || info.size < position) {
        identity = current;
        position = 0;
      }
      let events;
      [events, position] = readJsonl(EVENTS_FILE, position);
      for (const raw of events) publish(normalize(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') console.log(`event watcher error: ${error.code || error.name}`);
    }
  }, 250).unref();
}

// Recent complete records for initial browser hydration
function readRecentEvents(limit = 200) {
  let data;
  try {
    data = fs.readFileSync(EVENTS_FILE);
  } catch {
    return [];
  }
  const lines = [];
  let start = 0;
  while (start < data.length) {
    let end = data.indexOf(10, start);
    end = end < 0 ? data.length : end + 1;
    lines.push(data.subarray(start, end));
    start = end;
  }
  const result = [];
  for (const line of lines.slice(-limit)) {
    try {
      const raw = JSON.parse(line.toString('utf8'));
      if (py.isDict(raw)) result.push(normalize(raw));
    } catch {
      // skipped
    }
  }
  return result;
}

// urllib.parse.urlparse(path): path without query, fragment and ;params; parse_qs(query) without blank values
function parseTarget(target) {
  let rest = target;
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf('?');
  const query = q >= 0 ? rest.slice(q + 1) : '';
  let pathname = q >= 0 ? rest.slice(0, q) : rest;
  const slash = pathname.lastIndexOf('/');
  const semi = pathname.indexOf(';', slash < 0 ? 0 : slash);
  if (semi >= 0) pathname = pathname.slice(0, semi);
  const params = new Map();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return unescape(s.replace(/\+/g, ' ')); } };
    const name = decode(pair.slice(0, at));
    const value = decode(pair.slice(at + 1));
    if (!value) continue;
    if (!params.has(name)) params.set(name, []);
    params.get(name).push(value);
  }
  return { pathname, params, query };
}

function safeEqual(a, b) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  response.end(body);
}

function sendError(response, status) {
  const reason = http.STATUS_CODES[status] || '';
  const body = Buffer.from(`<!DOCTYPE HTML>\n<html lang="en">\n    <head>\n        <meta charset="utf-8">\n        <title>Error response</title>\n    </head>\n    <body>\n        <h1>Error response</h1>\n        <p>Error code: ${status}</p>\n        <p>Message: ${reason}.</p>\n    </body>\n</html>\n`);
  response.writeHead(status, { 'Content-Type': 'text/html;charset=utf-8', 'Content-Length': body.length, Connection: 'close' });
  response.end(body);
}

function serveFile(response, file, contentType) {
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    sendError(response, 404);
    return;
  }
  response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, ...SECURITY_HEADERS });
  response.end(body);
}

function authorized(request, params) {
  const header = request.headers.authorization || '';
  let supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!supplied) supplied = (params.get('token') || [''])[0];
  if (supplied && safeEqual(supplied, TOKEN)) return true;
  const access = supplied ? currentRelayAccess() : '';
  if (access && safeEqual(supplied, access)) return true;
  recordFailure(monotonic());
  return false;
}

// Too many wrong tokens recently: wrong tokens get 429 until the window passes
function deny(response) {
  if (recentFailures(monotonic()) > FAIL_LIMIT) sendJson(response, 429, { error: 'too_many_failures' });
  else sendJson(response, 401, { error: 'unauthorized' });
}

// Resolves to the parsed object, or null after replying with the error
function readJson(request, response, limit) {
  return new Promise((resolve) => {
    const header = request.headers['content-length'];
    let length;
    try {
      length = header === undefined ? 0 : py.int(header);
    } catch {
      length = -1;
    }
    if (length < 0 || length > limit) {
      sendJson(response, 413, { error: 'body_too_large' });
      request.resume();
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      if (size < length) chunks.push(chunk.subarray(0, length - size));
      size += chunk.length;
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body;
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        sendJson(response, 400, { error: 'bad_json' });
        resolve(null);
        return;
      }
      if (!py.isDict(body)) {
        sendJson(response, 400, { error: 'bad_json' });
        resolve(null);
        return;
      }
      resolve(body);
    });
    request.on('error', () => resolve(null));
  });
}

function streamEvents(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive',
  });
  response.write(': connected\n\n');
  subscribers.add(response);
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
  const close = () => {
    clearInterval(heartbeat);
    subscribers.delete(response);
  };
  request.socket.setTimeout(0);
  response.on('close', close);
  response.on('error', close);
}

async function sessionMessages(response, sessionId, params) {
  const agent = agents.forSession(sessionId);
  if (agent === null) {
    sendJson(response, 404, { error: 'session_not_found' });
    return;
  }
  let after;
  let limit;
  try {
    after = params.has('after') ? py.int(params.get('after')[0]) : null;
    limit = py.int((params.get('limit') || ['200'])[0]);
  } catch {
    sendJson(response, 400, { error: 'bad_paging' });
    return;
  }
  const branch = (params.get('branch') || [null])[0];
  const afterId = (params.get('after_id') || [null])[0];
  let page;
  try {
    page = await agent.messages(sessionId, after, limit, branch, afterId);
  } catch (error) {
    sendJson(response, 502, { error: 'agent_unavailable', agent: agent.id, reason: error.message });
    return;
  }
  if (page === null) {
    sendJson(response, 404, { error: 'branch_not_found' });
    return;
  }
  page.busy_task = store.busyTask(sessionId);
  sendJson(response, 200, page);
}

async function handleGet(request, response, { pathname, params }) {
  if (pathname === '/healthz') return sendJson(response, 200, { ok: true });
  if (STATIC_FILES[pathname]) {
    const [file, type] = STATIC_FILES[pathname];
    return serveFile(response, path.join(STATIC_DIR, file), type);
  }
  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    return response.end();
  }
  if (!authorized(request, params)) return deny(response);
  const task = TASK_PATH.exec(pathname);
  const session = SESSION_PATH.exec(pathname);
  if (pathname === '/events') return streamEvents(request, response);
  if (pathname === '/history') return sendJson(response, 200, { events: readRecentEvents() });
  if (pathname === '/tasks') return sendJson(response, 200, { tasks: allTasks().map((t) => t.public()) });
  if (pathname === '/approvals') return sendJson(response, 200, { approvals: approvals.pending() });
  if (task && !task[2]) {
    const found = findTask(task[1]);
    return found ? sendJson(response, 200, { ...found.public(), events: found.events.slice(-100) }) : sendJson(response, 404, { error: 'task_not_found' });
  }
  if (session && session[2] === 'status') {
    const agent = agents.forSession(session[1]);
    return agent && agent.status ? sendJson(response, 200, await agent.status(session[1])) : sendJson(response, 404, { error: 'session_not_found' });
  }
  if (session && session[2] === 'goal') return codexSession(response, session[1], 'goal', { action: 'get' });
  if (session && session[2] === 'forks') return sendJson(response, 200, (agents.forSession(session[1]) || agents.DEFAULT).forks(session[1]));
  if (pathname === '/commands') {
    const cwd = (params.get('cwd') || [null])[0];
    const agent = agents.get((params.get('agent') || [agents.DEFAULT.id])[0]);
    if (agent === null) return sendJson(response, 400, { error: 'bad_agent', allowed: agents.ids() });
    return sendJson(response, 200, await agent.catalog(cwd && sessions.inWorkspace(cwd) ? cwd : sessions.workspace()));
  }
  if (pathname === '/sessions') {
    const listed = listSessions();
    return sendJson(response, 200, { sessions: listed, agents: agents.ids(), workspace: sessions.workspace(), workspaces: sessions.workspaces(), ...agents.DEFAULT.diagnostics(listed) });
  }
  if (session && session[2] === 'messages') return sessionMessages(response, session[1], params);
  return sendError(response, 404);
}

// /compact, /goal and /feedback act on a Codex thread
async function codexSession(response, sessionId, action, body) {
  const agent = agents.forSession(sessionId);
  if (!agent || !agent.session) return sendJson(response, 404, { error: 'session_not_found' });
  try {
    return sendJson(response, 200, await agent.session(sessionId, action, body));
  } catch (error) {
    if (error instanceof TaskError) return sendJson(response, error.status, { error: error.code, ...error.detail });
    throw error;
  }
}

const field = (body, key) => (Object.prototype.hasOwnProperty.call(body, key) ? body[key] : null);

// Body: {"model": name|null, "effort": level|null}; a missing key is left unchanged, null clears it
function setPrefs(response, sessionId, body) {
  const changes = {};
  if ('model' in body) {
    if (body.model !== null && !sessions.validModel(body.model)) return sendJson(response, 400, { error: 'bad_model' });
    changes.model = body.model;
  }
  if ('effort' in body) {
    changes.effort = body.effort;
  }
  const agent = agents.forSession(sessionId);
  if (agent === null) return sendJson(response, 404, { error: 'session_not_found' });
  const efforts = agent.EFFORTS || sessions.EFFORTS;
  if (changes.effort !== undefined && changes.effort !== null && !efforts.includes(changes.effort)) return sendJson(response, 400, { error: 'bad_effort', allowed: [...efforts] });
  return sendJson(response, 200, { session_id: sessionId, ...store.setPrefs(sessionId, changes) });
}

// Called by hook-approve.js; answers when the phone decides
async function internalApproval(response, body) {
  // the approval hook belongs to Claude Code
  const task = runners.get('claude').tasks.get(py.str(Object.prototype.hasOwnProperty.call(body, 'task_id') ? body.task_id : ''));
  if (!task || task.status !== 'running') return sendJson(response, 200, { decision: 'deny', reason: 'unknown or finished task' });
  const toolName = py.str(Object.prototype.hasOwnProperty.call(body, 'tool_name') ? body.tool_name : '');
  const toolInput = py.isDict(body.tool_input) ? body.tool_input : {};
  const sessionId = py.truthy(field(body, 'session_id')) ? body.session_id : task.session_id;
  // The hook is attached for the whole run, so a switch to "auto" on the phone while the run is going would
  // otherwise only apply from the next message. Check the session's current mode here instead.
  if (sessionId && store.getMode(sessionId) === 'auto') {
    return sendJson(response, 200, { decision: 'allow', reason: 'Permission mode was switched to auto on the phone' });
  }
  const [decision, reason] = await approvals.request(task.task_id, sessionId, field(body, 'tool_use_id'), toolName, summarizeInput(toolName, toolInput));
  return sendJson(response, 200, { decision, reason });
}

async function routePost(response, pathname, body) {
  const task = TASK_PATH.exec(pathname);
  const approval = APPROVAL_PATH.exec(pathname);
  const session = SESSION_PATH.exec(pathname);
  if (pathname === '/tasks') {
    const sid = field(body, 'session_id');
    const named = field(body, 'agent');
    const agent = named !== null ? agents.get(named) : (sid !== null && agents.forSession(sid)) || agents.DEFAULT;
    if (agent === null) return sendJson(response, 400, { error: 'bad_agent', allowed: agents.ids() });
    const created = runners.get(agent.id).submit(field(body, 'prompt'), field(body, 'session_id'), field(body, 'cwd'), field(body, 'mode'),
      py.truthy(field(body, 'force')), field(body, 'images'), field(body, 'model'), field(body, 'effort'), field(body, 'review'));
    return sendJson(response, 202, created.public());
  }
  if (task && task[2] === '/steer') {
    const owner = [...runners.values()].find((r) => r.tasks.has(task[1]));
    if (!owner) return sendJson(response, 404, { error: 'task_not_found' });
    if (!owner.steer) return sendJson(response, 400, { error: 'steer_not_supported' });
    return sendJson(response, 200, (await owner.steer(task[1], field(body, 'prompt'))).public());
  }
  if (task && task[2]) {
    const owner = [...runners.values()].find((r) => r.tasks.has(task[1])) || runners.get(agents.DEFAULT.id);
    return sendJson(response, 202, owner.cancel(task[1]).public());
  }
  if (approval) {
    const decision = field(body, 'decision');
    if (decision !== 'allow' && decision !== 'deny') return sendJson(response, 400, { error: 'decision_must_be_allow_or_deny' });
    return approvals.decide(approval[1], decision) ? sendJson(response, 200, { ok: true }) : sendJson(response, 404, { error: 'approval_not_pending' });
  }
  if (session && session[2] === 'mode') {
    const mode = field(body, 'mode');
    if (!sessions.MODES.includes(mode)) return sendJson(response, 400, { error: 'bad_mode', allowed: [...sessions.MODES] });
    if (agents.forSession(session[1]) === null) return sendJson(response, 404, { error: 'session_not_found' });
    store.setMode(session[1], mode);
    return sendJson(response, 200, { session_id: session[1], mode });
  }
  if (session && session[2] === 'prefs') return setPrefs(response, session[1], body);
  if (session && ['goal', 'compact', 'feedback'].includes(session[2])) return codexSession(response, session[1], session[2], body);
  if (pathname === '/internal/approval') return internalApproval(response, body);
  if (pathname === '/internal/workspace') {
    // other VS Code windows on this computer announce their folder (heartbeat) or leave; nginx never lets this through
    if (body.action === 'remove') {
      sessions.unregisterWorkspace(body.root);
      return sendJson(response, 200, { ok: true });
    }
    if (body.action === 'add' && sessions.registerWorkspace(body.root)) return sendJson(response, 200, { ok: true, workspaces: sessions.workspaces() });
    return sendJson(response, 400, { error: 'bad_workspace' });
  }
  return sendError(response, 404);
}

async function handlePost(request, response, target) {
  if (!authorized(request, target.params)) {
    request.resume();
    return deny(response);
  }
  const body = await readJson(request, response, target.pathname === '/tasks' ? MAX_TASK_BODY_BYTES : MAX_BODY_BYTES);
  if (body === null) return undefined;
  try {
    return await routePost(response, target.pathname, body);
  } catch (error) {
    if (error instanceof TaskError) return sendJson(response, error.status, { error: error.code, ...error.detail });
    throw error;
  }
}

function logRequest(request, status) {
  // Never log the query string: SSE clients may pass the token there.
  const stamp = new Date().toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) /, '$1/$2/$3:').replace(' GMT', '');
  console.log(`${request.socket.remoteAddress} - - [${stamp}] "${request.method} ${request.url.split('?')[0]} HTTP/${request.httpVersion}" ${status} -`);
}

async function handle(request, response) {
  response.on('finish', () => logRequest(request, response.statusCode));
  const target = parseTarget(request.url || '/');
  try {
    if (request.method === 'GET') await handleGet(request, response, target);
    else if (request.method === 'POST') await handlePost(request, response, target);
    else {
      request.resume();
      sendError(response, 501);
    }
  } catch (error) {
    console.log(`request failed: ${error && error.stack ? error.stack : error}`);
    if (!response.headersSent) sendError(response, 500);
    else response.destroy();
  }
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700);
  TOKEN = loadToken();
  if (py.len(TOKEN) < MIN_TOKEN_LENGTH) {
    console.error(`BRIDGE_TOKEN is too short (minimum ${MIN_TOKEN_LENGTH} characters)`);
    process.exit(1);
  }
  store = new sessions.SessionStore(path.join(STATE_DIR, 'state.json'));
  approvals = new Approvals(publish, Number(process.env.BRIDGE_APPROVAL_TIMEOUT || '600'));
  // before the runners attach to the Codex app-server: the editor's Codex and this Bridge share one
  for (const agent of agents.AGENTS) {
    if (!agent.startTakeover) continue;
    const result = await agent.startTakeover((line) => console.log(line)).catch((error) => `failed: ${error.message}`);
    console.log(`Codex takeover: ${result}`);
  }
  for (const agent of agents.AGENTS) runners.set(agent.id, agent.createRunner(store, approvals, publish, STATE_DIR, `http://127.0.0.1:${PORT}`, TOKEN));
  watchEvents();
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 60000 }, handle);
  server.keepAliveTimeout = 5000;
  server.on('error', (error) => {
    console.error(`Bridge cannot listen on ${HOST}:${PORT}: ${error.code || error.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Bridge: http://${HOST}:${PORT}`);
    console.log(`Events: ${EVENTS_FILE}`);
    console.log(`State:  ${STATE_DIR} (token in ${path.join(STATE_DIR, 'token')})`);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
  process.on('exit', () => { for (const agent of agents.AGENTS) if (agent.close) agent.close(); });
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exit(1); });

module.exports = { normalize, uuid5Url, parseTarget };
