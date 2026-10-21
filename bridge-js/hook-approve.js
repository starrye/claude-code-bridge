'use strict';

// PreToolUse hook: ask the bridge for a decision and block until it answers. Port of bridge/hook_approve.py.
// Attached only to runs the bridge starts (via --settings), so the VS Code plugin's own tool calls are never gated.
// Fails closed: any error means deny.

const http = require('node:http');

function answer(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason,
  } }) + '\n');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))).on('error', reject);
  });
}

const failure = (name, text) => Object.assign(new Error(text), { name });

function post(url, body, token, timeout) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c)).on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) reject(failure('HTTPError', `HTTP ${response.statusCode}`));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      }).on('error', reject);
    });
    request.setTimeout(timeout, () => request.destroy(failure('TimeoutError', 'timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

async function main() {
  try {
    const payload = JSON.parse(await readStdin());
    const field = (k) => (payload && Object.prototype.hasOwnProperty.call(payload, k) ? payload[k] : null);
    const { BRIDGE_TASK_ID: taskId, BRIDGE_URL: url, BRIDGE_TOKEN: token } = process.env;
    if (taskId === undefined || url === undefined || token === undefined) throw failure('KeyError', 'missing environment');
    const input = field('tool_input');
    const empty = !input || (typeof input === 'object' && !Object.keys(input).length);
    const body = JSON.stringify({
      task_id: taskId, session_id: field('session_id'), tool_use_id: field('tool_use_id'), tool_name: field('tool_name'),
      tool_input: empty ? {} : input,
    });
    const timeout = Number(process.env.BRIDGE_APPROVAL_HTTP_TIMEOUT || '660') * 1000;
    const result = JSON.parse(await post(url.replace(/\/+$/, '') + '/internal/approval', body, token, timeout));
    if (!result || typeof result.decision !== 'string') throw failure('KeyError', 'no decision');
    answer(result.decision, typeof result.reason === 'string' ? result.reason : '');
  } catch (error) {
    answer('deny', `bridge unavailable: ${error && error.name ? error.name : 'Error'}`);
  }
}

main();
