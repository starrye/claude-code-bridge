'use strict';

// Render a Claude Code session jsonl as a flat, redacted message list for the H5. Port of bridge/transcript.py.
//
// Follows the active branch only (leaf -> parentUuid chain), so a forked session shows the most recently
// written branch; callers surface the fork separately. Everything that leaves this module is redacted and truncated.

const fs = require('node:fs');
const py = require('./py');
const { redact, summarizeInput } = require('./approvals');
const { AppendLog } = require('./appendlog');

const MAX_TEXT = 20000;
const MAX_THINKING = 4000;
const MAX_RESULT = 2000;
const MAX_LIMIT = 500;
const MAX_IMAGE_B64 = 1500000;
const MAX_PAGE_IMAGE_B64 = 6000000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
// Claude Code records a typed slash command as tags, and its local output as a separate system row.
const COMMAND = new RegExp(`^${py.WS_CLASS}*<command-name>(/?[^<]*)</command-name>(?:.*?<command-args>(.*?)</command-args>)?`, 'su');
const STDOUT = /<local-command-(?:stdout|stderr)>(.*?)<\/local-command-(?:stdout|stderr)>/gs;
const CAVEAT = new RegExp(`^${py.WS_CLASS}*<local-command-caveat>`, 'u');

// dict.get for values that may not be objects; missing -> null (Python's None)
const get = (obj, key) => (py.isDict(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null);
const message = (row) => { const m = get(row, 'message'); return py.truthy(m) ? m : {}; };
const isStr = (value) => typeof value === 'string';
const or = (a, b) => (py.truthy(a) ? a : b);

// "/context" for a recorded slash command, else null
function commandText(text) {
  const match = COMMAND.exec(text);
  if (!match) return null;
  let name = py.strip(match[1]);
  name = name.startsWith('/') ? name : '/' + name;
  const args = py.strip(match[2] || '');
  return args ? `${name} ${args}` : name;
}

function commandOutput(text) {
  return py.strip([...text.matchAll(STDOUT)].map((m) => py.strip(m[1])).join('\n'));
}

function clip(text, limit) {
  text = redact(py.str(text));
  return py.len(text) <= limit ? text : py.head(text, limit) + '…';
}

// One line of a session file as a row, or null when it is not a JSON object (skipped, like the Python reader did)
function parseRow(buffer, first) {
  let line = buffer.toString('utf8');
  if (first && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  try {
    const item = JSON.parse(line);
    return py.isDict(item) ? item : null;
  } catch {
    return null;
  }
}

// Parsed rows of recently used session files, kept between requests and extended with only the lines added since.
// Row objects stay the same between calls, which is what lets rendered rows be remembered too (see renderRow).
const rowStore = new Map();                              // file -> { log: AppendLog, rows: [] }, least recently used first
const ROW_STORE_MAX_BYTES = 200 * 1024 * 1024;           // parsed rows are several times the file size in memory

function readRowsIncremental(file) {
  let entry = rowStore.get(file);
  if (!entry) entry = { log: new AppendLog(file), rows: [] };
  rowStore.delete(file);
  let polled;
  try {
    polled = entry.log.poll();
  } catch {
    return [];                                           // a missing file is an empty session, and nothing is kept for it
  }
  if (polled.reset) entry.rows = [];
  let first = entry.log.offset - polled.lines.reduce((sum, l) => sum + l.length, 0) === 0;
  for (const line of polled.lines) {
    const row = parseRow(line, first);
    first = false;
    if (row) entry.rows.push(row);
  }
  rowStore.set(file, entry);
  let total = 0;
  for (const [key, value] of [...rowStore].reverse()) {  // keep the most recent files within the memory budget
    total += value.log.size;
    if (total > ROW_STORE_MAX_BYTES && key !== file) rowStore.delete(key);
  }
  // a last line still being written counts if it already is a whole JSON object, as before; it is not kept
  if (polled.fragment.length) {
    const row = parseRow(polled.fragment, entry.log.offset === 0);
    if (row) return entry.rows.concat([row]);
  }
  return entry.rows;
}

function readRows(file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return [];
  }
  const rows = [];
  let start = 0;
  while (start < data.length) {
    let end = data.indexOf(10, start);
    end = end < 0 ? data.length : end + 1;
    let line = data.toString('utf8', start, end);
    if (start === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    start = end;
    try {
      const item = JSON.parse(line);
      if (py.isDict(item)) rows.push(item);
    } catch {
      // not a JSON line; skipped like the Python reader
    }
  }
  return rows;
}

const conversational = (row) => ['user', 'assistant'].includes(get(row, 'type')) && isStr(get(row, 'uuid'))
  && !py.truthy(get(row, 'isSidechain')) && !py.truthy(get(row, 'isMeta'));

function byUuid(rows) {
  const out = new Map();
  for (const row of rows) if (isStr(row.uuid)) out.set(row.uuid, row);
  return out;
}

function trace(index, leaf, stop = null) {
  const chain = [];
  const seen = new Set();
  let current = leaf;
  while (current && !seen.has(current.uuid)) {
    if (stop && stop.size && stop.has(current.uuid)) break;
    seen.add(current.uuid);
    chain.push(current);
    current = index.get(get(current, 'parentUuid'));
  }
  return chain.reverse();
}

// A slash command's output is a system/local_command row hanging off the command row, outside the
// user/assistant chain. Put it right after its command so it is shown in place.
function withCommandOutput(chain, rows) {
  const outputs = new Map();
  for (const row of rows) {
    if (get(row, 'type') === 'system' && get(row, 'subtype') === 'local_command' && isStr(get(row, 'uuid'))) {
      const parent = get(row, 'parentUuid');
      if (!outputs.has(parent)) outputs.set(parent, []);
      outputs.get(parent).push(row);
    }
  }
  if (!outputs.size) return chain;
  const out = [];
  for (const row of chain) out.push(row, ...(outputs.get(get(row, 'uuid')) || []));
  return out;
}

function activeChain(rows) {
  let leaf = null;
  for (const row of rows) if (conversational(row)) leaf = row;
  return withCommandOutput(trace(byUuid(rows), leaf), rows);
}

// A typed prompt or assistant prose, as opposed to a bare tool result
function hasDialogue(row) {
  const content = get(message(row), 'content');
  if (get(row, 'type') === 'user') {
    if (isStr(content)) return true;
    return Array.isArray(content) && content.some((b) => py.isDict(b) && get(b, 'type') === 'text');
  }
  if (get(row, 'type') === 'assistant' && Array.isArray(content)) {
    return content.some((b) => py.isDict(b) && get(b, 'type') === 'text' && py.truthy(get(b, 'text')));
  }
  return false;
}

const timestampOf = (m) => or(get(m, 'timestamp'), '');
const minStr = (values) => values.reduce((a, b) => (py.compareCodePoints(b, a) < 0 ? b : a), values[0] ?? '');
const maxStr = (values) => values.reduce((a, b) => (py.compareCodePoints(b, a) > 0 ? b : a), values[0] ?? '');

// Conversation that exists in the file but is not on the active chain: a stale editor panel writing after the
// CLI did, or a compaction started from another process. Groups holding only tool results are ignored.
function sideBranches(rows, chain = null) {
  chain = chain !== null ? chain : activeChain(rows);
  const onChain = new Set(chain.map((r) => r.uuid));
  const index = byUuid(rows);

  // The root of a row is the first ancestor whose parent is missing or on the chain. Every row on one walk has the
  // same root, so the answer is remembered for all of them: without it each row walks to the root on its own, which
  // is quadratic on a long session whose old (compacted or forked) history is mostly off the chain.
  const rootCache = new Map();
  const rootOf = (row) => {
    const path = [];
    const seen = new Set();
    let current = row;
    let root;
    for (;;) {
      if (rootCache.has(current.uuid)) { root = rootCache.get(current.uuid); break; }
      if (seen.has(current.uuid)) { root = current; break; }
      seen.add(current.uuid);
      path.push(current.uuid);
      const parent = index.get(get(current, 'parentUuid'));
      if (!parent || onChain.has(parent.uuid)) { root = current; break; }
      current = parent;
    }
    for (const uuid of path) rootCache.set(uuid, root);
    return root;
  };

  const groups = new Map();
  for (const row of rows) {
    if (conversational(row) && !onChain.has(row.uuid)) {
      const id = rootOf(row).uuid;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row);
    }
  }

  const branches = [];
  for (const [rootId, members] of groups) {
    if (!members.some(hasDialogue)) continue;
    const root = index.get(rootId);
    const firstText = members.find((m) => get(m, 'type') === 'user' && hasDialogue(m)) || members[0];
    const content = get(message(firstText), 'content');
    let preview = '';
    if (isStr(content)) preview = content;
    else if (Array.isArray(content)) {
      const block = content.find((b) => py.isDict(b) && get(b, 'type') === 'text');
      if (block) preview = Object.prototype.hasOwnProperty.call(block, 'text') ? block.text : '';
    }
    const entrypoints = [...new Set(members.map((m) => get(m, 'entrypoint')).filter(py.truthy))].sort(py.compareCodePoints);
    const stamps = members.map(timestampOf);
    branches.push({
      id: rootId,
      attach_to: or(get(root, 'parentUuid'), get(root, 'logicalParentUuid')),
      rows: members.length,
      entrypoints,
      first_ts: minStr(stamps),
      last_ts: maxStr(stamps),
      preview: clip(preview, 80),
    });
  }
  return branches.sort((a, b) => py.compareCodePoints(a.first_ts, b.first_ts));
}

// The linear path through one side branch (root to its newest message)
function branchChain(rows, branchId) {
  const chain = activeChain(rows);
  if (!sideBranches(rows, chain).some((b) => b.id === branchId)) return null;
  const onChain = new Set(chain.map((r) => r.uuid));
  const index = byUuid(rows);
  let leaf = null;
  for (const row of rows) {
    if (!conversational(row) || onChain.has(row.uuid)) continue;
    const seen = new Set();
    let current = row;
    while (current && !seen.has(current.uuid)) {
      if (current.uuid === branchId) {
        leaf = row;
        break;
      }
      seen.add(current.uuid);
      current = index.get(get(current, 'parentUuid'));
    }
  }
  return trace(index, leaf, onChain);
}

function resultText(content) {
  if (isStr(content)) return content;
  if (Array.isArray(content)) {
    return content.filter((b) => py.isDict(b) && get(b, 'type') === 'text')
      .map((b) => (Object.prototype.hasOwnProperty.call(b, 'text') ? b.text : '')).join('\n');
  }
  return '';
}

// Fields for an image item: the data when displayable, else the reason it is not
function imageFields(block) {
  const source = get(block, 'source');
  if (!py.isDict(source) || get(source, 'type') !== 'base64') return { unavailable: 'remote' };
  const media = get(source, 'media_type');
  const data = get(source, 'data');
  if (!IMAGE_TYPES.has(media) || !isStr(data) || !B64.test(data)) return { unavailable: 'format' };
  if (data.length > MAX_IMAGE_B64) return { unavailable: 'too_large', bytes: Math.floor((data.length * 3) / 4) };
  return { media_type: media, data };
}

// What one row turns into depends only on the row, so it is worked out once per row object and remembered: when a
// session grows, only the new rows are rendered again.
const renderedRows = new WeakMap();

function render(chain) {
  const out = [];
  for (const row of chain) {
    let items = renderedRows.get(row);
    if (!items) {
      items = renderRow(row);
      renderedRows.set(row, items);
    }
    for (const item of items) out.push(item);
  }
  return out;
}

function renderRow(row) {
  const items = [];
  const add = (row, index, role, kind, fields = {}) => {
    items.push({ id: `${row.uuid}:${index}`, role, kind, timestamp: get(row, 'timestamp'), entrypoint: get(row, 'entrypoint'), ...fields });
  };

  {
    if (py.truthy(get(row, 'isMeta')) || py.truthy(get(row, 'isCompactSummary'))) return items;
    const type = get(row, 'type');
    if (type === 'system') {
      if (get(row, 'subtype') === 'local_command' && isStr(get(row, 'content'))) {
        const output = commandOutput(row.content);
        if (output) add(row, 0, 'assistant', 'command_output', { text: clip(output, MAX_TEXT) });
      }
      return items;
    }
    const content = get(message(row), 'content');
    if (type === 'user') {
      const blocks = isStr(content) ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : []);
      blocks.forEach((block, index) => {
        if (!py.isDict(block)) return;
        const kind = get(block, 'type');
        if (kind === 'text') {
          const text = Object.prototype.hasOwnProperty.call(block, 'text') ? block.text : '';
          const t = py.str(text);
          if (CAVEAT.test(t) || (/<local-command-(?:stdout|stderr)>(.*?)<\/local-command-(?:stdout|stderr)>/s.test(t) && !COMMAND.test(t))) return;
          const command = commandText(t);
          if (command) add(row, index, 'user', 'text', { text: command, command: true });
          else add(row, index, 'user', 'text', { text: clip(text, MAX_TEXT) });
        } else if (kind === 'image') {
          add(row, index, 'user', 'image', imageFields(block));
        } else if (kind === 'tool_result') {
          const toolUseId = get(block, 'tool_use_id');
          add(row, index, 'tool', 'tool_result', {
            tool_use_id: toolUseId, is_error: py.truthy(get(block, 'is_error')), text: clip(resultText(get(block, 'content')), MAX_RESULT),
          });
          const inner = get(block, 'content');
          (Array.isArray(inner) ? inner : []).forEach((part, sub) => {
            if (py.isDict(part) && get(part, 'type') === 'image') add(row, `${index}.${sub}`, 'tool', 'image', { tool_use_id: toolUseId, ...imageFields(part) });
          });
        }
      });
    } else if (type === 'assistant' && Array.isArray(content)) {
      content.forEach((block, index) => {
        if (!py.isDict(block)) return;
        const kind = get(block, 'type');
        if (kind === 'text' && py.truthy(get(block, 'text'))) {
          add(row, index, 'assistant', 'text', { text: clip(block.text, MAX_TEXT) });
        } else if (kind === 'thinking') {
          add(row, index, 'assistant', 'thinking', { text: clip(Object.prototype.hasOwnProperty.call(block, 'thinking') ? block.thinking : '', MAX_THINKING) });
        } else if (kind === 'tool_use') {
          const input = py.isDict(get(block, 'input')) ? block.input : {};
          const name = get(block, 'name');
          add(row, index, 'assistant', 'tool_use', {
            tool_use_id: get(block, 'id'), tool_name: name,
            summary: summarizeInput(Object.prototype.hasOwnProperty.call(block, 'name') ? py.str(name) : '', input),
          });
        }
      });
    }
  }
  return items;
}

// Keep the newest images inline up to a page budget; older ones become placeholders
function budgetImages(items) {
  let left = MAX_PAGE_IMAGE_B64;
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const item = out[i];
    if (item.kind !== 'image' || !('data' in item)) continue;
    const size = item.data.length;
    if (size <= left) left -= size;
    else {
      const { data, media_type: mediaType, ...rest } = item;
      out[i] = { ...rest, unavailable: 'too_large', bytes: Math.floor((size * 3) / 4) };
    }
  }
  return out;
}

// What a session file turns into (the rendered main line and its side branches) depends only on the file, so it is
// kept until the file changes. The phone polls every few seconds and reloads on every focus; without this each poll
// re-reads, re-parses and re-renders the whole file, which takes over half a second on a long session and blocks the
// single-threaded server meanwhile. Keyed by modification time and size, like the title and usage caches.
const renderCache = new Map();
const RENDER_CACHE_MAX = 8;                              // a few sessions are open at a time; each entry holds a whole transcript

function signatureOf(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

function mainLine(file) {
  const signature = signatureOf(file);
  const cached = signature && renderCache.get(file);
  if (cached && cached.signature === signature) {
    renderCache.delete(file);                            // re-insert: Map order is least recently used first
    renderCache.set(file, cached);
    return cached;
  }
  const rows = readRowsIncremental(file);
  const chain = activeChain(rows);
  const entry = { signature, items: render(chain), branches: sideBranches(rows, chain) };
  if (signature) {
    renderCache.set(file, entry);
    while (renderCache.size > RENDER_CACHE_MAX) renderCache.delete(renderCache.keys().next().value);
  }
  return entry;
}

// Page of rendered items. Cursors: afterId (robust when the chain is re-rooted; unknown id -> reset with the tail),
// after (a plain count), or neither (the tail). branch renders a side branch.
function messages(file, after, limit, branch = null, afterId = null) {
  limit = Math.max(1, Math.min(limit, MAX_LIMIT));
  let items;
  let branches = [];
  if (branch === null) {
    ({ items, branches } = mainLine(file));
  } else {
    const rows = readRowsIncremental(file);
    const chain = branchChain(rows, branch);
    if (chain === null) return null;
    items = render(chain);
  }
  const total = items.length;
  let reset = false;
  let start;
  if (afterId !== null) {
    const at = items.findIndex((i) => i.id === afterId);
    if (at >= 0) start = at + 1;
    else {
      start = Math.max(0, total - limit);
      reset = true;
    }
  } else if (after !== null) {
    start = Math.max(0, Math.min(after, total));
  } else {
    start = Math.max(0, total - limit);
  }
  return {
    total, start, items: budgetImages(items.slice(start, start + limit)), reset,
    last_id: items.length ? items[items.length - 1].id : null,
    branches: branches.map((b) => ({ ...b, entrypoints: [...b.entrypoints] })), branch,
  };
}

module.exports = {
  MAX_TEXT, MAX_THINKING, MAX_RESULT, MAX_LIMIT, commandText, commandOutput, readRows, activeChain, sideBranches,
  branchChain, render, messages,
};
