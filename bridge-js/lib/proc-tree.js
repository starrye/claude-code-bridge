'use strict';

// Process-tree helpers used to cancel a Claude Code run without leaving orphans. Port of bridge/proc_tree.py.
//
// Killing only `claude` leaves its tool subprocesses (and hook scripts) running, and they are NOT in claude's
// process group. The descendant tree must therefore be collected *before* claude is signalled, because orphans
// are re-parented to PID 1 afterwards.

const fs = require('node:fs');
const { execFile } = require('node:child_process');

const HAS_PROC = (() => { try { return fs.statSync('/proc/self').isDirectory(); } catch { return false; } })();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ps(args) {
  return new Promise((resolve) => {
    execFile('ps', args, { timeout: 10000, encoding: 'utf8' }, (error, stdout) => resolve(stdout || ''));
  });
}

const statFields = (stat) => stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/).filter(Boolean);

async function ppidTable() {
  const table = new Map();
  if (!HAS_PROC) {                                      // macOS and other systems without /proc
    for (const line of (await ps(['-A', '-o', 'pid=,ppid='])).split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) table.set(Number(parts[0]), Number(parts[1]));
    }
    return table;
  }
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const ppid = Number(statFields(fs.readFileSync(`/proc/${entry}/stat`, 'utf8'))[1]);
      if (Number.isInteger(ppid)) table.set(Number(entry), ppid);
    } catch {
      // process gone
    }
  }
  return table;
}

async function descendants(rootPid) {
  const table = await ppidTable();
  const found = [];
  const pending = [rootPid];
  while (pending.length) {
    const parent = pending.pop();
    for (const [pid, ppid] of table) {
      if (ppid === parent && !found.includes(pid)) {
        found.push(pid);
        pending.push(pid);
      }
    }
  }
  return found;
}

// True if the process exists and is not a zombie
async function alive(pid) {
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  }
  if (!HAS_PROC) {
    const state = (await ps(['-o', 'stat=', '-p', String(pid)])).trim();
    return Boolean(state) && !state.startsWith('Z');
  }
  try {
    return statFields(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))[0] !== 'Z';
  } catch {
    return false;
  }
}

function signal(pids, sig) {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone or not ours
    }
  }
}

async function liveOf(pids) {
  const states = await Promise.all(pids.map(alive));
  return pids.filter((_, i) => states[i]);
}

async function waitGone(pids, timeout) {
  const deadline = Date.now() + timeout * 1000;
  let live = await liveOf(pids);
  while (live.length && Date.now() < deadline) {
    await sleep(100);
    live = await liveOf(live);
  }
  return live;
}

// SIGTERM the root, then its descendants, then SIGKILL stragglers. Resolves to the pids that had to be force-killed.
async function terminateTree(rootPid, grace = 2.0) {
  if (process.platform === 'win32') {                   // no signals or /proc: taskkill walks the tree itself
    await new Promise((resolve) => execFile('taskkill', ['/PID', String(rootPid), '/T', '/F'], { timeout: 10000, windowsHide: true }, () => resolve()));
    return [];
  }
  const tree = await descendants(rootPid);              // must be collected before signalling the root
  signal([rootPid], 'SIGTERM');
  await waitGone([rootPid], grace);
  let live = await waitGone(tree, 0);
  signal(live, 'SIGTERM');
  live = await waitGone(live, grace);
  signal(live, 'SIGKILL');
  await waitGone(live, 1.0);
  return live;
}

module.exports = { HAS_PROC, descendants, alive, terminateTree };
