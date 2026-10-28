'use strict';

// The coding agents this Bridge can drive. Each one owns its sessions and its runner; the first is the default
// for requests that do not name one (pages and clients from before agents existed).

const claude = require('./agent-claude');
const codex = require('./agent-codex');

// Codex joins only when a codex binary is found on this computer
const AGENTS = codex.available() && process.env.BRIDGE_CODEX !== '0' ? [claude, codex] : [claude];
const DEFAULT = claude;

const ids = () => AGENTS.map((a) => a.id);
const get = (id) => AGENTS.find((a) => a.id === id) || null;

// The agent whose session this is, or null if none has it
const forSession = (sid) => AGENTS.find((a) => a.hasSession(sid)) || null;

module.exports = { AGENTS, DEFAULT, ids, get, forSession };
