#!/usr/bin/env node
'use strict';

// A stand-in for `codex app-server`: JSON-RPC over stdio, enough of the protocol for the Bridge tests.
// Prompts steer its behaviour: "run <cmd>" asks for a command approval, "slow" waits to be steered or interrupted.
// FAKE_CODEX_STATE (a JSON file) holds threads across restarts; FAKE_CODEX_LOCKED lists thread ids "open elsewhere".

const fs = require('node:fs');
const readline = require('node:readline');

const stateFile = process.env.FAKE_CODEX_STATE;
const locked = new Set((process.env.FAKE_CODEX_LOCKED || '').split(',').filter(Boolean));
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { threads: {} }; } };
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
let seq = 0;
const id = (p) => `${p}${Date.now().toString(16)}${(seq++).toString(16)}`;
const uuid = () => { const h = require('node:crypto').randomUUID(); return h; };
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const note = (method, params) => out({ method, params });
const pending = new Map();
let nextReq = 1000;
const ask = (method, params) => new Promise((resolve) => { const rid = nextReq++; pending.set(rid, resolve); out({ id: rid, method, params }); });
const running = new Map();                                // thread id -> { turn, resolveSteer }

function thread(t, turns) {
  return { id: t.id, sessionId: t.id, forkedFromId: t.forkedFrom || null, parentThreadId: null, preview: t.preview, ephemeral: false,
    modelProvider: 'openai', model: t.model || 'gpt-fake', createdAt: t.createdAt, updatedAt: t.updatedAt, status: { type: running.has(t.id) ? 'active' : 'idle', activeFlags: [] },
    path: null, cwd: t.cwd, cliVersion: '0.0.0-fake', source: t.source || 'appServer', name: null, turns: turns ? t.turns : [] };
}

async function turn(threadId, turnId, text) {
  const s = load();
  const t = s.threads[threadId];
  const items = [{ type: 'userMessage', id: id('u'), content: [{ type: 'text', text }] }];
  note('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } });
  let status = 'completed';
  const m = /^run (.+)$/.exec(text);
  if (m) {
    const itemId = id('c');
    note('item/started', { threadId, turnId, item: { type: 'commandExecution', id: itemId, command: m[1], status: 'inProgress' } });
    const answer = await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId, command: m[1], cwd: t.cwd });
    const ok = answer.decision === 'accept';
    const item = { type: 'commandExecution', id: itemId, command: m[1], status: ok ? 'completed' : 'declined', exitCode: ok ? 0 : null, aggregatedOutput: ok ? 'ran' : '' };
    note('item/completed', { threadId, turnId, item });
    items.push(item);
  }
  if (text === 'slow') {
    const result = await new Promise((resolve) => running.set(threadId, { turnId, resolve }));
    if (result.interrupted) status = 'interrupted';
    else items.push({ type: 'userMessage', id: id('u'), content: [{ type: 'text', text: result.steer }] });
  }
  running.delete(threadId);
  const reply = status === 'completed' ? `echo: ${items.filter((i) => i.type === 'userMessage').map((i) => i.content[0].text).join(' + ')}` : null;
  if (reply) {
    const item = { type: 'agentMessage', id: id('a'), text: reply };
    note('item/started', { threadId, turnId, item: { ...item, text: '' } });
    note('item/agentMessage/delta', { threadId, turnId, itemId: item.id, delta: reply });
    note('item/completed', { threadId, turnId, item });
    items.push(item);
  }
  const fresh = load();
  fresh.threads[threadId].turns.push({ id: turnId, items, status, startedAt: Math.floor(Date.now() / 1000) });
  fresh.threads[threadId].updatedAt = Math.floor(Date.now() / 1000);
  save(fresh);
  note('turn/completed', { threadId, turn: { id: turnId, items: [], status, error: null } });
}

const handlers = {
  initialize: () => ({ userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' }),
  'thread/list': (p) => {
    const roots = Array.isArray(p.cwd) ? p.cwd : p.cwd ? [p.cwd] : null;
    const all = Object.values(load().threads).filter((t) => !roots || roots.some((r) => t.cwd === r || t.cwd.startsWith(`${r}/`)));
    return { data: all.sort((a, b) => b.updatedAt - a.updatedAt).map((t) => thread(t, false)), nextCursor: null, backwardsCursor: null };
  },
  'thread/read': (p) => {
    const t = load().threads[p.threadId];
    if (!t) throw { code: -32600, message: `thread not found: ${p.threadId}` };
    return { thread: thread(t, p.includeTurns) };
  },
  'thread/start': (p) => {
    const s = load();
    const now = Math.floor(Date.now() / 1000);
    const t = { id: uuid(), cwd: p.cwd, preview: '', createdAt: now, updatedAt: now, turns: [], model: p.model };
    s.threads[t.id] = t;
    save(s);
    return { thread: thread(t, false) };
  },
  'thread/resume': (p) => {
    if (locked.has(p.threadId)) throw { code: -32600, message: `thread ${p.threadId} already has an active writer` };
    const t = load().threads[p.threadId];
    if (!t) throw { code: -32600, message: 'no rollout found' };
    return { thread: thread(t, false) };
  },
  'thread/fork': (p) => {
    const s = load();
    const src = s.threads[p.threadId];
    const t = { ...src, id: uuid(), forkedFrom: src.id, turns: [...src.turns] };
    s.threads[t.id] = t;
    save(s);
    return { thread: thread(t, false) };
  },
  'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
  'turn/start': (p) => {
    const s = load();
    const t = s.threads[p.threadId];
    const skill = p.input.find((i) => i.type === 'skill');
    const text = (skill ? `[skill ${skill.name} ${skill.path}] ` : '') + p.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    if (!t.preview) t.preview = text;
    save(s);
    const turnId = id('t');
    setImmediate(() => turn(p.threadId, turnId, text));
    return { turn: { id: turnId, items: [], status: 'inProgress' } };
  },
  'review/start': (p) => {
    const turnId = id('t');
    setImmediate(() => turn(p.threadId, turnId, `review:${p.target.type}:${p.target.branch || p.target.sha || p.target.instructions || ''}`));
    return { turn: { id: turnId, items: [], status: 'inProgress' }, reviewThreadId: p.threadId };
  },
  'thread/compact/start': () => ({}),
  'thread/goal/get': (p) => ({ goal: (load().goals || {})[p.threadId] || null }),
  'thread/goal/set': (p) => {
    const s = load();
    s.goals = s.goals || {};
    const old = s.goals[p.threadId] || { threadId: p.threadId, objective: '', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    s.goals[p.threadId] = { ...old, ...(p.objective ? { objective: p.objective } : {}), ...(p.status ? { status: p.status } : {}), tokenBudget: p.tokenBudget === undefined ? old.tokenBudget : p.tokenBudget };
    save(s);
    return { goal: s.goals[p.threadId] };
  },
  'thread/goal/clear': (p) => { const s = load(); if (s.goals) delete s.goals[p.threadId]; save(s); return {}; },
  'feedback/upload': (p) => { const s = load(); s.feedback = [...(s.feedback || []), p]; save(s); return { threadId: p.threadId, promptHash: null }; },
  'turn/steer': (p) => {
    const r = running.get(p.threadId);
    if (!r || r.turnId !== p.expectedTurnId) throw { code: -32600, message: 'no active turn' };
    r.resolve({ steer: p.input[0].text });
    return { turnId: r.turnId };
  },
  'turn/interrupt': (p) => {
    const r = running.get(p.threadId);
    if (r) r.resolve({ interrupted: true });
    return {};
  },
  'skills/list': (p) => ({ data: [{ cwd: p.cwds[0], errors: [], skills: [
    { name: 'fake-skill', description: 'long description', shortDescription: 'does fake things', path: '/skills/fake-skill/SKILL.md', scope: 'user', enabled: true, pluginId: null },
    { name: 'off-skill', description: 'disabled', path: '/skills/off/SKILL.md', scope: 'user', enabled: false, pluginId: null }] }] }),
  'account/rateLimits/read': () => ({ rateLimits: {}, rateLimitsByLimitId: { codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null } } } }),
  'model/list': () => ({ data: [{ id: 'gpt-fake', model: 'gpt-fake', displayName: 'GPT Fake', description: 'test model', hidden: false, isDefault: true }], nextCursor: null }),
};

if (process.argv[2] !== 'app-server') process.exit(2);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    if (resolve) resolve(msg.result || {});
    return;
  }
  if (msg.id === undefined) return;
  const handler = handlers[msg.method];
  if (!handler) return out({ id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
  try {
    out({ id: msg.id, result: handler(msg.params || {}) });
  } catch (error) {
    out({ id: msg.id, error: error.code ? error : { code: -32603, message: String(error) } });
  }
});
