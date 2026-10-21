'use strict';

// Runs the REAL extension.js against a fake `vscode` and a real HTTPS update server, then prints what happened as JSON.
// Started by extension-update.test.js in a child process so NODE_EXTRA_CA_CERTS can make the test certificate trusted
// without adding any test-only switch to the extension.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const scenario = JSON.parse(process.argv[2]);
const log = [];
const note = (kind, detail) => log.push({ kind, ...detail });

const timers = [];
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...rest) => {          // long timers are recorded, never run: the extension must not schedule any
  if (ms >= 30000) { timers.push(ms); return { unref() {} }; }
  return realSetTimeout(fn, ms, ...rest);
};

const answers = [...scenario.answers];                 // what the "user" clicks, in order of the prompts
const ask = (kind) => (message, ...buttons) => {
  note(kind, { message, buttons });
  const next = answers.length ? answers.shift() : undefined;
  return Promise.resolve(buttons.includes(next) ? next : undefined);
};

// settings by scope, like VS Code: workspace beats user beats the package default
const userSettings = { relayAddress: scenario.relay, autoStart: false, ...(scenario.userSettings || {}) };
const workspaceSettings = { ...(scenario.workspaceSettings || {}) };
const config = new Proxy({}, { get: (_, key) => (key in workspaceSettings ? workspaceSettings[key] : userSettings[key]),
  set: (_, key, value) => { userSettings[key] = value; return true; } });
const commands = new Map();
const fakeVscode = {
  window: {
    createOutputChannel: () => ({ appendLine: (line) => note('output', { line }), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    showInformationMessage: ask('info'), showWarningMessage: ask('warn'), showErrorMessage: ask('error'),
    withProgress: (options, task) => { note('progress', { title: options.title }); return task(); },
    showQuickPick: async () => undefined, showInputBox: async () => undefined,
    createWebviewPanel: () => ({ webview: {}, onDidDispose() {}, dispose() {}, reveal() {} }),
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    executeCommand: async (id, ...args) => {
      if (commands.has(id)) return commands.get(id)(...args);
      if (id === 'workbench.extensions.installExtension') {
        const file = args[0].fsPath;
        note('install', { file: path.basename(file), existed: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.readFileSync(file).toString('latin1') : null });
        if (scenario.installFails) throw new Error('simulated install failure');
        return undefined;
      }
      note('command', { id });
      return undefined;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key) => config[key],
      inspect: (key) => ({ globalValue: userSettings[key], workspaceValue: workspaceSettings[key] }),
      update: async (key, value, target) => {
        const scope = target === 2 ? workspaceSettings : userSettings;
        if (value === undefined) delete scope[key]; else scope[key] = value;
        note('settingUpdate', { key, value: value === undefined ? null : value, target });
      },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: undefined,
  },
  Uri: { file: (fsPath) => ({ fsPath }) },
  env: { remoteName: undefined },
  StatusBarAlignment: { Left: 1 }, ThemeColor: class {}, ProgressLocation: { Notification: 15 }, ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
};
const realLoad = Module._load;
Module._load = function load(request, ...rest) { return request === 'vscode' ? fakeVscode : realLoad.call(this, request, ...rest); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-upd-'));
  const extensionPath = path.join(dir, 'ext');
  fs.mkdirSync(extensionPath);
  if (scenario.publicKey) fs.writeFileSync(path.join(extensionPath, 'update-public-key.pem'), scenario.publicKey);
  const storage = path.join(dir, 'storage');

  const served = scenario.files || {};
  const server = https.createServer({ key: scenario.tls.key, cert: scenario.tls.cert }, (request, response) => {
    const name = new URL(request.url, 'https://x').pathname.replace('/updates/', '');
    note('request', { name });
    const body = served[name] === undefined ? null : Buffer.from(served[name], 'latin1');
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Length': body.length });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (scenario.relay === 'SERVER') config.relayAddress = `https://localhost:${server.address().port}`;

  const extension = require(path.resolve(__dirname, '../extension.js'));
  extension.activate({
    extensionPath, subscriptions: [], globalStorageUri: { fsPath: storage },
    extension: { packageJSON: { name: 'agent-bridge', version: scenario.current } },
  });

  for (const step of scenario.steps) {
    if (step === 'manual') await commands.get('agentBridge.checkUpdate')();
  }
  await new Promise((resolve) => realSetTimeout(resolve, 50));
  note('settings', { user: { ...userSettings }, workspace: { ...workspaceSettings }, effectiveRelay: config.relayAddress });
  note('end', { updatesDirLeft: fs.existsSync(path.join(storage, 'updates')) ? fs.readdirSync(path.join(storage, 'updates')) : null, timers });
  await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`\n@@RESULT@@${JSON.stringify(log)}\n`);
  process.exit(0);
})().catch((error) => { process.stdout.write(`\n@@ERROR@@${error.stack}\n`); process.exit(1); });
