'use strict';

// Session helpers: per-session phone-side mode, session files, fork detection. Port of bridge/sessions.py.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const py = require('./py');
const { AppendLog } = require('./appendlog');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODES = ['ask', 'auto', 'readonly'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,62}(\[1m\])?$/;
const BUILTIN_MODELS = ['default', 'sonnet', 'opus', 'haiku', 'opusplan', 'sonnet[1m]', 'opus[1m]'];
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/;
const DEFAULT_MODE = 'ask';

const expandUser = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);
const CONFIG_DIR = expandUser(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR ?? path.join(CONFIG_DIR, 'projects');
const REGISTRY_DIR = process.env.CLAUDE_SESSIONS_DIR ?? path.join(CONFIG_DIR, 'sessions');

const TAIL_BYTES = 65536;
const MAX_TAIL_BYTES = 64 * 1024 * 1024;
const WINDOW_BYTES = 65536;
const MAX_TITLE_CHARS = 200;

const isStr = (value) => typeof value === 'string';
const get = (obj, key) => (py.isDict(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null);
const message = (row) => { const m = get(row, 'message'); return py.truthy(m) ? m : {}; };

const validCommandName = (value) => isStr(value) && COMMAND_NAME.test(value);
const validModel = (value) => isStr(value) && MODEL_NAME.test(value);
const validSessionId = (value) => isStr(value) && SESSION_ID_RE.test(value);

// Where this bridge runs and which Claude directories it reads, for the diagnostics line
function hostInfo() {
  const names = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  return {
    hostname: os.hostname(),
    system: names[process.platform] || os.type() || 'unknown',
    projects_dir: PROJECTS_DIR,
    registry_dir: REGISTRY_DIR,
    projects_exists: isDir(PROJECTS_DIR),
    registry_exists: isDir(REGISTRY_DIR),
  };
}

const isDirPath = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const WORKSPACE_TTL_MS = 45000;           // a window that stops sending its heartbeat drops out after this long
const MAX_WORKSPACES = 32;
const registered = new Map();             // real path -> expiry (ms); other VS Code windows register here

// Another window announces (or renews) its folder. Returns false for anything that is not a usable folder
function registerWorkspace(raw) {
  if (typeof raw !== 'string' || !py.strip(raw) || raw.includes('\0') || !path.isAbsolute(raw)) return false;
  const real = py.realpath(raw);
  if (real === '/' || !isDirPath(real)) return false;
  const now = Date.now();
  for (const [key, expiry] of registered) if (expiry <= now) registered.delete(key);
  if (!registered.has(real) && registered.size >= MAX_WORKSPACES) return false;
  registered.set(real, now + WORKSPACE_TTL_MS);
  return true;
}

function unregisterWorkspace(raw) {
  if (typeof raw === 'string' && raw) registered.delete(py.realpath(raw));
}

// Every folder this bridge serves: its own (BRIDGE_WORKSPACE) first, then those other windows registered, each in a
// stable order. Guests renew their registration every 15 s, so ordering by the renewal/expiry time made the folders
// shuffle on the phone every few seconds; order by the folder path instead, which does not change. Empty means no
// restriction.
function workspaces() {
  const roots = [];
  const raw = py.strip(process.env.BRIDGE_WORKSPACE || '');
  if (raw) roots.push(py.realpath(raw));
  const now = Date.now();
  const live = [...registered].filter(([, expiry]) => expiry > now).map(([key]) => key).sort(py.compareCodePoints);
  for (const key of live) if (!roots.includes(key)) roots.push(key);
  return roots;
}

// The primary folder (this bridge's own, else the first registered one by path), or null for no restriction
function workspace() {
  const roots = workspaces();
  return roots.length ? roots[0] : null;
}

// The served folder a directory belongs to (the deepest match), or null
function rootOf(cwd) {
  if (!py.truthy(cwd)) return null;
  const real = py.realpath(cwd);
  const found = workspaces().filter((r) => real === r || real.startsWith(r.replace(/\/+$/, '') + '/'));
  return found.length ? found.reduce((a, b) => (b.length > a.length ? b : a)) : null;
}

function inWorkspace(cwd) {
  if (!workspaces().length) return true;
  return rootOf(cwd) !== null;
}

// Field 22 of /proc/<pid>/stat; Claude records the same value as `procStart`
function procStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const field = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/).filter(Boolean)[19];
    return field === undefined ? null : field;
  } catch {
    return null;
  }
}

const hasProc = () => { try { return fs.statSync('/proc/self').isDirectory(); } catch { return false; } };

// Is `pid` still the process that wrote this registry entry? With /proc the start time must match, which rules
// out a recycled pid. Without it (macOS) the recorded value cannot be reproduced, so a live pid is accepted.
function sameProcess(pid, recorded) {
  if (hasProc()) return procStart(pid) === py.str(recorded);
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code !== 'ESRCH';
  }
  return true;
}

// Claude processes running now, from ~/.claude/sessions/<pid>.json. Stale files are dropped. *.key files beside
// them are never read.
function liveRegistry() {
  const entries = [];
  let names;
  try {
    names = fs.readdirSync(REGISTRY_DIR).sort(py.compareCodePoints);
  } catch {
    return entries;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, name), 'utf8'));
    } catch {
      continue;
    }
    if (!py.isDict(data) || !validSessionId(get(data, 'sessionId'))) continue;
    const pid = get(data, 'pid');
    if (!Number.isInteger(pid) || !sameProcess(pid, get(data, 'procStart'))) continue;
    const entry = {};
    for (const k of ['pid', 'sessionId', 'name', 'entrypoint', 'kind', 'status', 'cwd', 'version', 'startedAt', 'updatedAt']) entry[k] = get(data, k);
    entries.push(entry);
  }
  return entries;
}

// A live process we did not start that reports this session as busy
function otherWriterBusy(sessionId, ownPids) {
  return liveRegistry().find((e) => e.sessionId === sessionId && e.status === 'busy' && !ownPids.has(e.pid)) || null;
}

// A live Claude process we did not start that has this session open (any status)
function liveOwner(sessionId, ownPids) {
  return liveRegistry().find((e) => e.sessionId === sessionId && !ownPids.has(e.pid)) || null;
}

function findSessionFile(sessionId) {
  if (!validSessionId(sessionId)) return null;
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR).filter((d) => !d.startsWith('.')).sort(py.compareCodePoints);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    try {
      fs.lstatSync(candidate);
      return candidate;
    } catch {
      // not in this project
    }
  }
  return null;
}

// bytes.splitlines(): \r\n, \r and \n only
function splitByteLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const c = buffer[i];
    if (c === 10 || c === 13) {
      lines.push(buffer.subarray(start, i));
      if (c === 13 && buffer[i + 1] === 10) i += 1;
      start = i + 1;
    }
  }
  if (start < buffer.length) lines.push(buffer.subarray(start));
  return lines;
}

// Iterating a binary file: lines ending at \n
function* fileLines(file) {
  const data = fs.readFileSync(file);
  let start = 0;
  while (start < data.length) {
    let end = data.indexOf(10, start);
    end = end < 0 ? data.length : end + 1;
    yield data.subarray(start, end);
    start = end;
  }
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
}

// Scan the file backwards in growing windows (rows can be large) until pick() returns a value
function scanTail(sessionId, pick) {
  const file = findSessionFile(sessionId);
  if (file === null) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let window = TAIL_BYTES;
    for (;;) {
      const from = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      let tail = splitByteLines(buffer);
      if (size > window) tail = tail.slice(1);           // first line is probably cut in half
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        const found = pick(tail[i]);
        if (found !== null) return found;
      }
      if (window >= size || window >= MAX_TAIL_BYTES) return null;
      window *= 4;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Most recent `permissionMode` recorded in the session file
function lastPermissionMode(sessionId) {
  return scanTail(sessionId, (raw) => {
    const item = parseJson(raw);
    return py.isDict(item) && isStr(item.permissionMode) ? item.permissionMode : null;
  });
}

// The model that answered most recently, from the last real assistant message (also reflects editor runs)
function servedModel(sessionId) {
  return scanTail(sessionId, (raw) => {
    if (!raw.includes('"model"') || !raw.includes('"assistant"')) return null;
    const item = parseJson(raw);
    const model = py.isDict(item) ? get(message(item), 'model') : null;
    return isStr(model) && !model.startsWith('<') ? model : null;
  });
}

const titleCache = new Map();
const COMMAND_TAG = /<command-name>([^\n]*?)<\/command-name>/;
const BASH_INPUT = /<bash-input>([\s\S]*?)<\/bash-input>/;
const NOT_A_PROMPT = new RegExp(`^(?:${py.WS_CLASS}*<[a-z][\\p{L}\\p{N}_-]*[${py.WS_CLASS.slice(1, -1)}>]|\\[Request interrupted by user[^\\]]*\\])`, 'u');

// The last `"key":"value"` string in a text window (the same scan Claude Code's own list uses)
function lastValue(chunk, key) {
  let best = -1;
  let value = null;
  for (const pattern of [`"${key}":"`, `"${key}": "`]) {
    let pos = 0;
    for (;;) {
      const found = chunk.indexOf(pattern, pos);
      if (found < 0) break;
      const start = found + pattern.length;
      let i = start;
      while (i < chunk.length) {
        if (chunk[i] === '\\') {
          i += 2;
          continue;
        }
        if (chunk[i] === '"') {
          if (found > best) {
            const raw = chunk.slice(start, i);
            try {
              value = raw.includes('\\') ? JSON.parse(`"${raw}"`) : raw;
            } catch {
              value = raw;
            }
            best = found;
          }
          break;
        }
        i += 1;
      }
      pos = i + 1;
    }
  }
  return value;
}

function tidy(text) {
  text = py.strip(text.replace(/\n/g, ' '));
  return py.len(text) <= MAX_TITLE_CHARS ? text : py.strip(py.head(text, MAX_TITLE_CHARS)) + '…';
}

const isUserLine = (line) => line.includes('"type":"user"') || line.includes('"type": "user"');
const isMetaLine = (line) => line.includes('"tool_result"') || line.includes('"isMeta":true') || line.includes('"isMeta": true');

// First real thing the user typed, as Claude Code derives it; else "Image"/"Document"
function firstPrompt(head) {
  let commandFallback = '';
  for (const line of head.split('\n')) {
    if (!isUserLine(line) || isMetaLine(line)) continue;
    if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!py.isDict(row) || get(row, 'type') !== 'user' || py.truthy(get(row, 'isMeta')) || py.truthy(get(row, 'isCompactSummary'))) continue;
    const content = get(message(row), 'content');
    const texts = [];
    let skip = false;
    if (isStr(content)) texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!py.isDict(block)) continue;
        if (get(block, 'type') === 'tool_result') {
          skip = true;
          break;
        }
        if (get(block, 'type') === 'text' && isStr(get(block, 'text'))) texts.push(block.text);
      }
    }
    if (skip) continue;
    for (const raw of texts) {
      const text = py.strip(raw.replace(/\n/g, ' '));
      if (!text) continue;
      const command = COMMAND_TAG.exec(text);
      if (command) {
        commandFallback = commandFallback || command[1];
        continue;
      }
      const bash = BASH_INPUT.exec(text);
      if (bash) return '! ' + py.strip(bash[1]);
      if (NOT_A_PROMPT.test(text)) continue;
      return tidy(text);
    }
  }
  if (commandFallback) return commandFallback;
  for (const line of head.split('\n')) {
    if (!isUserLine(line) || isMetaLine(line)) continue;
    if (line.includes('"type":"image"') || line.includes('"type": "image"')) return 'Image';
    if (line.includes('"type":"document"') || line.includes('"type": "document"')) return 'Document';
  }
  return '';
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const n = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, n).toString('utf8');
}

// The name Claude Code's own session list shows (verified against its VS Code extension, v2.1.299). Looks only at
// the first and last 64 KB: a rename, the generated title, the latest prompt, a summary, the first prompt, "Image".
function sessionTitle(sessionId) {
  const file = findSessionFile(sessionId);
  if (file === null) return null;
  let fd;
  try {
    const stat = fs.statSync(file, { bigint: true });
    const signature = `${stat.mtimeNs}:${stat.size}`;
    const cached = titleCache.get(file);
    if (cached && cached[0] === signature) return cached[1];
    const size = Number(stat.size);
    fd = fs.openSync(file, 'r');
    const head = readAt(fd, 0, WINDOW_BYTES);
    const tail = size > WINDOW_BYTES ? readAt(fd, Math.max(0, size - WINDOW_BYTES), WINDOW_BYTES) : head;
    const named = [lastValue(tail, 'customTitle'), lastValue(head, 'customTitle'), lastValue(tail, 'aiTitle'), lastValue(head, 'aiTitle')]
      .find((v) => v !== null);
    let title = named || lastValue(tail, 'lastPrompt') || lastValue(tail, 'summary') || firstPrompt(head) || null;
    if (title) title = tidy(title);
    if (titleCache.size > 2000) titleCache.clear();
    titleCache.set(file, [signature, title]);
    return title;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The cwd a session was created in. `--resume` only finds it from that cwd.
function sessionCwd(sessionId) {
  const file = findSessionFile(sessionId);
  if (file === null) return null;
  try {
    for (const raw of fileLines(file)) {
      const item = parseJson(raw);
      if (py.isDict(item) && isStr(item.cwd)) return item.cwd;
    }
  } catch {
    return null;
  }
  return null;
}

// A real typed prompt, not a tool_result or injected meta message
function isUserPrompt(item) {
  if (get(item, 'type') !== 'user' || py.truthy(get(item, 'isMeta')) || py.truthy(get(item, 'isSidechain'))) return false;
  const content = get(message(item), 'content');
  if (isStr(content)) return true;
  if (Array.isArray(content)) return !content.some((b) => py.isDict(b) && get(b, 'type') === 'tool_result');
  return false;
}

// Prompt-level forks: one parent with more than one real user-prompt child (a stale VS Code panel writing after
// the CLI appended). Only user prompts count, so parallel tool calls are not false positives.
function analyzeForks(sessionId) {
  const file = findSessionFile(sessionId);
  const none = { found: false, forked: false, fork_points: [] };
  if (file === null) return none;
  const children = new Map();
  try {
    for (const raw of fileLines(file)) {
      const item = parseJson(raw);
      if (!py.isDict(item) || !isUserPrompt(item)) continue;
      const parent = get(item, 'parentUuid');
      if (!py.truthy(parent)) continue;
      const key = isStr(parent) ? parent : JSON.stringify(parent);
      if (!children.has(key)) children.set(key, [parent, []]);
      children.get(key)[1].push({ uuid: get(item, 'uuid'), timestamp: get(item, 'timestamp'), entrypoint: get(item, 'entrypoint') });
    }
  } catch {
    return none;
  }
  const points = [...children.values()].filter(([, kids]) => kids.length > 1).map(([parent, kids]) => ({ parent, branches: kids }));
  const transcript = require('./transcript');
  const side = transcript.sideBranches(transcript.readRows(file));
  return { found: true, forked: points.length > 0 || side.length > 0, fork_points: points, side_branches: side };
}

// Phone-side state per session. Persists modes, prefs and known sessions; busy state is in memory.
// Claude Code does not carry the permission mode with a session, so the bridge stores and re-sends it.
class SessionStore {
  constructor(stateFile) {
    this.file = stateFile;
    this.modes = {};
    this.prefs = {};
    this.knownSessions = {};
    this.busy = new Map();
    this.lastOwnWrite = new Map();
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    // Same order as the Python loader: a malformed section stops loading the ones after it
    const section = (name) => {
      if (!py.isDict(data)) throw new Error('bad state');
      const value = Object.prototype.hasOwnProperty.call(data, name) ? data[name] : {};
      if (!py.isDict(value)) throw new Error('bad state');
      return Object.entries(value).filter(([k]) => validSessionId(k));
    };
    try {
      this.modes = Object.fromEntries(section('modes').filter(([, v]) => MODES.includes(v)));
      this.prefs = Object.fromEntries(section('prefs').filter(([, v]) => py.isDict(v))
        .map(([k, v]) => [k, Object.fromEntries(['model', 'effort'].filter((f) => f in v).map((f) => [f, v[f]]))]));
      this.knownSessions = Object.fromEntries(section('known').filter(([, v]) => py.isDict(v)));
    } catch {
      // keep what loaded
    }
  }

  persist() {
    const tmp = this.file.replace(/\.[^./]*$/, '') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ modes: this.modes, prefs: this.prefs, known: this.knownSessions }));
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  getMode(sessionId) {
    return Object.prototype.hasOwnProperty.call(this.modes, sessionId) ? this.modes[sessionId] : DEFAULT_MODE;
  }

  setMode(sessionId, mode) {
    this.modes[sessionId] = mode;
    this.persist();
  }

  getPrefs(sessionId) {
    return { ...(this.prefs[sessionId] || {}) };
  }

  // Set (a string) or clear (null) the model and/or effort for a session's runs; undefined leaves it unchanged.
  // Values must already be validated.
  setPrefs(sessionId, { model, effort } = {}) {
    const entry = this.prefs[sessionId] || (this.prefs[sessionId] = {});
    for (const [field, value] of [['model', model], ['effort', effort]]) {
      if (value === undefined) continue;
      if (value === null) delete entry[field];
      else entry[field] = value;
    }
    if (!Object.keys(entry).length) delete this.prefs[sessionId];
    this.persist();
    return { ...entry };
  }

  // Record a session the bridge ran, so it stays listed after its process exits. Only id, directory, time.
  remember(sessionId, cwd) {
    const entry = this.knownSessions[sessionId] || (this.knownSessions[sessionId] = {});
    if (py.truthy(cwd)) entry.cwd = cwd;
    entry.updated_at = Date.now();
    this.persist();
  }

  known() {
    return Object.fromEntries(Object.entries(this.knownSessions).map(([k, v]) => [k, { ...v }]));
  }

  knownCwds() {
    return new Set(Object.values(this.knownSessions).map((v) => v.cwd).filter(isStr));
  }

  // Mark a session busy. Returns the current owner task id if already busy.
  claim(sessionId, taskId) {
    const owner = this.busy.get(sessionId);
    if (owner && owner !== taskId) return owner;
    this.busy.set(sessionId, taskId);
    return null;
  }

  release(sessionId, taskId) {
    if (this.busy.get(sessionId) === taskId) this.busy.delete(sessionId);
    this.lastOwnWrite.set(sessionId, Date.now() / 1000);
  }

  busyTask(sessionId) {
    return this.busy.get(sessionId) ?? null;
  }

  // True if the session file changed since the bridge last wrote it (someone else touched it recently, which is
  // when a stale panel could fork it)
  externalWrite(sessionId) {
    const file = findSessionFile(sessionId);
    if (file === null) return false;
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs / 1000;
    } catch {
      return false;
    }
    const own = this.lastOwnWrite.get(sessionId);
    if (own !== undefined) return mtime > own + SessionStore.EXTERNAL_WRITE_MARGIN;
    return Date.now() / 1000 - mtime < SessionStore.RECENT_WINDOW;
  }
}
SessionStore.EXTERNAL_WRITE_MARGIN = 2.0;
SessionStore.RECENT_WINDOW = 30.0;

const usageCache = new Map();
const usageState = new Map();                          // file -> { log, seen, last }: what has been read so far, least recently used first
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

// Token totals, summed once per API message (a reply split over several lines repeats the same usage), plus the
// context size of the latest reply
function sessionUsage(sessionId) {
  const file = findSessionFile(sessionId);
  if (file === null) return null;
  try {
    const stat = fs.statSync(file, { bigint: true });
    const signature = `${stat.mtimeNs}:${stat.size}`;
    const cached = usageCache.get(file);
    if (cached && cached[0] === signature) return cached[1];
    // Only the lines added since the last time are read (the file just grows); an unfinished last line counts once
    // it is complete. While a task runs the file changes all the time, and re-scanning all of it every few seconds
    // took a fifth of a second on a long session.
    let state = usageState.get(file);
    if (!state) state = { log: new AppendLog(file), seen: new Map(), last: null };
    usageState.delete(file);
    const polled = state.log.poll();
    if (polled.reset) { state.seen = new Map(); state.last = null; }
    for (const raw of polled.lines) {
      if (!raw.includes('"usage"') || !raw.includes('"assistant"')) continue;
      const item = parseJson(raw);
      if (item === undefined) continue;
      const msg = py.isDict(item) ? get(item, 'message') : null;
      const usage = py.isDict(msg) ? get(msg, 'usage') : null;
      if (!py.isDict(usage) || py.str(Object.prototype.hasOwnProperty.call(msg, 'model') ? msg.model : '').startsWith('<')) continue;
      const id = get(msg, 'id');
      state.seen.set(py.str(py.truthy(id) ? id : state.seen.size), usage);
      state.last = usage;
    }
    usageState.set(file, state);
    while (usageState.size > 50) usageState.delete(usageState.keys().next().value);
    const { seen, last } = state;
    const amount = (u, k) => { const v = get(u, k); return py.int(py.truthy(v) ? v : 0); };
    const result = {};
    for (const k of USAGE_KEYS) result[k] = [...seen.values()].reduce((sum, u) => sum + amount(u, k), 0);
    result.context_tokens = py.truthy(last) ? USAGE_KEYS.filter((k) => k !== 'output_tokens').reduce((sum, k) => sum + amount(last, k), 0) : 0;
    if (usageCache.size > 500) usageCache.clear();
    usageCache.set(file, [signature, result]);
    return result;
  } catch (error) {
    if (error.code) return null;                        // OSError; anything else is a bug, as in the Python
    throw error;
  }
}

module.exports = {
  SESSION_ID_RE, MODES, EFFORTS, BUILTIN_MODELS, DEFAULT_MODE, CONFIG_DIR, PROJECTS_DIR, REGISTRY_DIR,
  validCommandName, validModel, validSessionId, hostInfo, workspace, workspaces, rootOf, registerWorkspace, unregisterWorkspace, inWorkspace, liveRegistry, otherWriterBusy,
  liveOwner, lastPermissionMode, sessionTitle, servedModel, findSessionFile, sessionCwd, analyzeForks,
  SessionStore, sessionUsage, firstPrompt, lastValue,
};
