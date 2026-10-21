'use strict';

// Phone approvals for gated tool calls, plus redaction of what is shown. Port of bridge/approvals.py.

const crypto = require('node:crypto');
const py = require('./py');
const { unifiedDiff } = require('./difflib');

// Tools that need a decision. Read-only tools are left to Claude Code's own rules.
const GATED_TOOLS = 'Write|Edit|MultiEdit|NotebookEdit|Bash';

const B = py.BOUNDARY;
const S = py.WS_CLASS;
const NS = py.NOT_WS_CLASS;
const SECRET_PATTERNS = [
  [new RegExp(`${B}(bearer)${S}+[A-Za-z0-9._\\-]{12,}`, 'giu'), '$1 [redacted]'],
  [new RegExp(`${B}sk-[A-Za-z0-9_\\-]{12,}`, 'gu'), '[redacted]'],
  // "token: x" style assignments. Plural "tokens" is a count ("**Tokens:** 30.2k", "max_tokens: 4000"), not a
  // secret, so it is skipped; markdown bold around the label is allowed for.
  [new RegExp(`${B}([A-Za-z0-9_]*(?:token(?!s${B})|secret|password|passwd|api[_-]?key)[A-Za-z0-9_]*)${S}*\\**${S}*[=:]${S}*\\**${S}*${NS}+`, 'giu'),
    '$1=[redacted]'],
];
const MAX_COMMAND_CHARS = 500;
const MAX_DIFF_LINES = 200;
const MAX_DIFF_LINE_CHARS = 300;
// Files whose contents are never shown, only their size. (?=\n?$) is Python's $.
const SENSITIVE_PATH = new RegExp(
  '(^|/)(\\.env(\\.[^/]*)?|\\.netrc|\\.npmrc|\\.pypirc|id_(rsa|dsa|ecdsa|ed25519)[^/]*|'
  + '[^/]*\\.(pem|key|p12|pfx|keystore|jks)|[^/]*(secret|credential|password)[^/]*)(?=\\n?$)', 'iu');

function redact(text) {
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

const lines = (text) => py.splitlines(redact(py.str(text)));
const clipLine = (line) => (py.len(line) <= MAX_DIFF_LINE_CHARS ? line : py.head(line, MAX_DIFF_LINE_CHARS) + '…');

// Unified diff of two snippets as [op, text] rows; op is ' ', '-', '+' or '@' (a gap)
function editDiff(oldText, newText) {
  const rows = [];
  for (const line of unifiedDiff(lines(oldText), lines(newText), 2)) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    rows.push(line.startsWith('@@') ? ['@', ''] : [line[0], line.slice(1)]);
  }
  return rows;
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// The change a file-editing tool call will make, for display. null when there is nothing to show.
function buildDiff(toolName, toolInput) {
  let rows = [];
  if (toolName === 'Edit' && has(toolInput, 'old_string') && has(toolInput, 'new_string')) {
    rows = editDiff(toolInput.old_string, toolInput.new_string);
  } else if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (py.isDict(edit)) rows = rows.concat(editDiff(has(edit, 'old_string') ? edit.old_string : '', has(edit, 'new_string') ? edit.new_string : ''));
    }
  } else if (toolName === 'Write' && has(toolInput, 'content')) {
    rows = lines(toolInput.content).map((line) => ['+', line]);
  } else if (toolName === 'NotebookEdit' && toolInput.edit_mode !== 'delete' && has(toolInput, 'new_source')) {
    rows = lines(toolInput.new_source).map((line) => ['+', line]);
  }
  if (!rows.length) return null;
  return { lines: rows.slice(0, MAX_DIFF_LINES).map(([op, text]) => [op, clipLine(text)]), truncated: rows.length > MAX_DIFF_LINES };
}

// What the phone sees: the command, or the path plus the change being made.
// File changes are shown as a diff, except for files that look like secrets (.env, keys, ...), which show only
// sizes. Redaction is pattern-based and best effort, not a guarantee.
function summarizeInput(toolName, toolInput) {
  if (toolName === 'Bash') {
    let command = redact(py.str(has(toolInput, 'command') ? toolInput.command : ''));
    if (py.len(command) > MAX_COMMAND_CHARS) command = py.head(command, MAX_COMMAND_CHARS) + '…';
    const out = { command };
    if (py.truthy(toolInput.description)) out.description = py.head(redact(py.str(toolInput.description)), 200);
    return out;
  }
  const out = {};
  for (const key of ['file_path', 'notebook_path']) if (has(toolInput, key)) out[key] = py.str(toolInput[key]);
  for (const key of ['content', 'new_string', 'old_string', 'new_source']) {
    if (has(toolInput, key)) out[`${key}_chars`] = py.len(py.str(toolInput[key]));
  }
  const file = out.file_path || out.notebook_path || '';
  if (!SENSITIVE_PATH.test(file)) {
    const diff = buildDiff(toolName, toolInput);
    if (diff) out.diff = diff;
  }
  return Object.keys(out).length ? out : { keys: Object.keys(toolInput).sort(py.compareCodePoints) };
}

class Approvals {
  constructor(emit, timeout = 600) {
    this.emit = emit;
    this.timeout = timeout;
    this.items = new Map();
    this.waiters = new Map();
  }

  // Resolves when the phone decides. Fails closed on timeout or cancel.
  request(taskId, sessionId, toolUseId, toolName, summary) {
    const approvalId = crypto.randomUUID().replace(/-/g, '');
    const item = {
      approval_id: approvalId, task_id: taskId, session_id: sessionId, tool_use_id: toolUseId,
      tool_name: toolName, summary, created_at: Date.now() / 1000, decision: null, reason: null,
    };
    this.items.set(approvalId, item);
    this.emit({ sse_event: 'task', event_type: 'approval_requested', approval_id: approvalId, task_id: taskId,
      session_id: sessionId, tool_use_id: toolUseId, tool_name: toolName, summary });
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(approvalId);
        if (item.decision === null) {
          item.decision = 'deny';
          item.reason = 'No response from the user on their phone in time; the action was not run.';
        }
        const reason = item.reason || '';
        this.emit({ sse_event: 'task', event_type: 'approval_resolved', approval_id: approvalId, task_id: taskId,
          decision: item.decision, reason });
        resolve([item.decision, reason]);
      };
      const timer = setTimeout(done, this.timeout * 1000);
      this.waiters.set(approvalId, done);
    });
  }

  decide(approvalId, decision, reason = '') {
    const item = this.items.get(approvalId);
    const waiter = this.waiters.get(approvalId);
    if (!item || !waiter || item.decision !== null) return false;
    item.decision = decision;
    item.reason = reason || (decision === 'allow' ? 'Approved by the user on their phone'
      : 'Denied by the user on their phone. Do not retry the same action; ask the user how to proceed.');
    waiter();
    return true;
  }

  cancelTask(taskId) {
    const ids = [...this.items.values()].filter((it) => it.task_id === taskId && it.decision === null).map((it) => it.approval_id);
    return ids.filter((id) => this.decide(id, 'deny', 'The task was cancelled by the user.')).length;
  }

  pending() {
    return [...this.items.values()].filter((it) => it.decision === null).map((it) => ({ ...it }));
  }
}

module.exports = { GATED_TOOLS, MAX_COMMAND_CHARS, MAX_DIFF_LINES, MAX_DIFF_LINE_CHARS, redact, buildDiff, summarizeInput, Approvals };
