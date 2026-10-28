'use strict';

// Codex thread items -> the message items the page already renders for Claude (text, thinking, tool_use, tool_result).

const fs = require('fs');
const py = require('./py');
const { redact, SENSITIVE_PATH, MAX_DIFF_LINES, MAX_DIFF_LINE_CHARS, MAX_COMMAND_CHARS } = require('./approvals');

const MAX_TEXT = 20000;
const MAX_RESULT = 4000;

// The VS Code extension wraps what the user typed in its editor context; the phone shows only the request
const IDE_CONTEXT = /^\s*# Context from my IDE setup:[\s\S]*?\n## My request[^\n]*:[ \t]*\n/;
const requestOf = (text) => text.replace(IDE_CONTEXT, '');
const clip = (text, max) => (py.len(py.str(text)) > max ? `${py.head(py.str(text), max)}…` : py.str(text));
const clipLine = (line) => (line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)}…` : line);

// A unified diff (or new-file body) as the [op, text] rows used by approval cards
function diffRows(change) {
  const rows = [];
  for (const line of py.str(change.diff).split('\n')) {
    if (/^(---|\+\+\+|@@|diff |index )/.test(line)) continue;
    if (line.startsWith('+')) rows.push(['+', line.slice(1)]);
    else if (line.startsWith('-')) rows.push(['-', line.slice(1)]);
  }
  if (!rows.length && change.kind && change.kind.type === 'add') for (const line of py.str(change.diff).split('\n')) rows.push(['+', line]);
  return rows;
}

function changeSummary(change) {
  const out = { file_path: py.str(change.path), change: change.kind ? change.kind.type : 'update' };
  if (SENSITIVE_PATH.test(out.file_path)) return out;
  const rows = diffRows(change);
  if (rows.length) out.diff = { lines: rows.slice(0, MAX_DIFF_LINES).map(([op, text]) => [op, clipLine(text)]), truncated: rows.length > MAX_DIFF_LINES };
  return out;
}

function commandSummary(command, reason = null) {
  let text = redact(py.str(command));
  if (py.len(text) > MAX_COMMAND_CHARS) text = `${py.head(text, MAX_COMMAND_CHARS)}…`;
  const out = { command: text };
  if (reason) out.description = py.head(redact(py.str(reason)), 200);
  return out;
}

// The tool name and summary for a command or file change, shared by history and approval cards
function toolOf(item) {
  if (item.type === 'commandExecution') return ['Bash', commandSummary(item.command)];
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (changes.length === 1) return ['Edit', changeSummary(changes[0])];
    return ['Edit', { files: changes.map((c) => py.str(c.path)), file_path: changes.length ? py.str(changes[0].path) : '' }];
  }
  if (item.type === 'mcpToolCall') return [`${item.server}.${item.tool}`, { keys: Object.keys(py.isDict(item.arguments) ? item.arguments : {}).sort() }];
  if (item.type === 'webSearch') return ['WebSearch', { query: py.str(item.query) }];
  return [null, null];
}

// An image file on this computer as the fields the page renders: the data when displayable, else the reason it is not
const MAX_IMAGE_BYTES = 1100000;
const MAGIC = [['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/gif', [0x47, 0x49, 0x46]], ['image/webp', [0x52, 0x49, 0x46, 0x46]]];
const imageCache = new Map();
function sniff(buf) {
  const hit = MAGIC.find(([, sig]) => sig.every((b, i) => buf[i] === b));
  return hit ? { media_type: hit[0], data: buf.toString('base64') } : { unavailable: 'format' };
}
// The image of a generated-image item: the saved file, else the base64 the item itself carries
function generatedImage(item) {
  const file = item.savedPath ? imageFile(item.savedPath) : null;
  if (file && !file.unavailable) return file;
  const b64 = typeof item.result === 'string' ? item.result.replace(/^data:[^,]*,/, '') : '';
  if (!b64) return file;
  if (b64.length > MAX_IMAGE_BYTES * 1.4) return { unavailable: 'too_large', bytes: Math.floor(b64.length * 0.75) };
  const buf = Buffer.from(b64, 'base64');
  return buf.length > MAX_IMAGE_BYTES ? { unavailable: 'too_large', bytes: buf.length } : sniff(buf);
}
function imageFile(file) {
  try {
    const stat = fs.statSync(file);
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (imageCache.has(key)) return imageCache.get(key);
    let out;
    if (stat.size > MAX_IMAGE_BYTES) out = { unavailable: 'too_large', bytes: stat.size };
    else {
      const buf = fs.readFileSync(file);
      out = sniff(buf);
    }
    if (imageCache.size >= 16) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(key, out);
    return out;
  } catch {
    return { unavailable: 'format' };
  }
}

function render(turns) {
  const items = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    const at = turn.startedAt ? new Date(turn.startedAt * 1000).toISOString() : null;
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      const add = (suffix, role, kind, fields) => items.push({ id: `${turn.id}:${item.id}${suffix}`, role, kind, timestamp: at, entrypoint: 'codex', ...fields });
      if (item.type === 'userMessage') {
        (item.content || []).forEach((part, i) => {
          const text = part.type === 'text' ? requestOf(py.str(part.text)) : '';
          if (part.type === 'text' && py.strip(text)) add(`:${i}`, 'user', 'text', { text: clip(text, MAX_TEXT) });
          else if (part.type === 'localImage' && part.path) add(`:${i}`, 'user', 'image', imageFile(part.path));
          else if (part.type === 'image' || part.type === 'localImage') add(`:${i}`, 'user', 'image', { omitted: true });
        });
      } else if (item.type === 'agentMessage' && py.strip(py.str(item.text))) {
        add('', 'assistant', 'text', { text: clip(item.text, MAX_TEXT) });
      } else if (item.type === 'imageGeneration') {
        const image = generatedImage(item);
        if (image) add('', 'assistant', 'image', image);
      } else if (item.type === 'exitedReviewMode' && py.strip(py.str(item.review))) {
        const last = items[items.length - 1];
        if (!(last && last.role === 'assistant' && last.kind === 'text' && last.text === clip(item.review, MAX_TEXT))) add('', 'assistant', 'text', { text: clip(item.review, MAX_TEXT) });
      } else if (item.type === 'reasoning') {
        const text = [...(item.summary || []), ...(item.content || [])].join('\n\n');
        if (py.strip(text)) add('', 'assistant', 'thinking', { text: clip(text, MAX_TEXT) });
      } else {
        const [name, summary] = toolOf(item);
        if (!name) continue;
        add('', 'assistant', 'tool_use', { tool_use_id: item.id, tool_name: name, summary });
        const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0);
        const output = item.type === 'commandExecution' ? py.str(item.aggregatedOutput ?? '') : item.status === 'declined' ? '已拒绝' : '';
        add(':result', 'tool', 'tool_result', { tool_use_id: item.id, is_error: failed, text: clip(redact(output), MAX_RESULT) });
      }
    }
  }
  return items;
}

module.exports = { render, toolOf, changeSummary, commandSummary };
