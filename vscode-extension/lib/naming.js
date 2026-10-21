'use strict';

// The name a computer is listed under on the phone: "<computerName setting or host name>@<folder>".
// A VS Code window in a dev container has a random host name, and the same account can hold several computers,
// so the folder (and the computerName setting) is what tells them apart.

const MAX_NAME = 60;        // what the relay keeps in total
const MAX_BASE = 40;        // the name part is capped here so the folder always keeps at least 19 characters

const chars = (text) => Array.from(text);
const clean = (text) => String(text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
const clip = (text, limit) => (chars(text).length <= limit ? text : `${chars(text).slice(0, Math.max(0, limit - 1)).join('')}…`);

// The last path segment of the workspace folder, or '' (no folder open, or a root like "/" or "C:\")
function folderName(workspacePath) {
  const last = clean(workspacePath).split(/[\\/]+/).filter(Boolean).pop() || '';
  return /^[A-Za-z]:$/.test(last) ? '' : last;
}

function computerLabel(setting, hostname, workspacePath) {
  const base = clean(setting) || clean(hostname) || '未命名电脑';
  const folder = folderName(workspacePath);
  if (!folder) return clip(base, MAX_NAME);
  const name = clip(base, MAX_BASE);
  return `${name}@${clip(folder, MAX_NAME - chars(name).length - 1)}`;
}

module.exports = { computerLabel, folderName, MAX_NAME };
