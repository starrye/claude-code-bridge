'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { Supervisor, isValidRelay } = require('./lib/supervisor');
const { updateBaseFromRelay, checkForUpdate, downloadUpdate } = require('./lib/updater');
const { renderPairingHtml } = require('./lib/pairing-html');
const { computerLabel } = require('./lib/naming');
const { findBundledClaude, findBundledCodex } = require('./lib/claude-locate');

const STATUS = {
  stopped: '$(circle-slash) Bridge 已停止',
  starting: '$(sync~spin) Bridge 启动中',
  pairing: '$(device-mobile) Bridge 等待扫码',
  running: '$(radio-tower) Bridge 运行中',
  error: '$(error) Bridge 异常',
  'other-window': '$(info) Bridge 在其他窗口运行',
  guest: '$(plug) Bridge 已接入主窗口',
};

let context;
let supervisor;
let statusItem;
let output;
let panel;
let lastPairing;
let updating = false;


function settings() {
  const config = vscode.workspace.getConfiguration('agentBridge');
  return {
    relay: String(config.get('relayAddress') || '').trim(),
    port: config.get('bridgePort') || 8787,
    // empty setting: use the newest claude shipped by the Claude Code extension, else the one on PATH
    claude: config.get('claudePath') || findBundledClaude(path.dirname(context.extensionPath)),
    codex: findBundledCodex(path.dirname(context.extensionPath)),
    codexTakeover: config.get('codexTakeover') !== false,
    computerName: config.get('computerName') || '',
    autoStart: config.get('autoStart') !== false,
  };
}

function options() {
  const chosen = settings();
  const workspace = (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || '';
  return {
    ...chosen,
    // what the phone lists this computer as; sent once, when it is bound
    name: computerLabel(chosen.computerName, os.hostname(), workspace),
    bridgeDir: path.join(context.extensionPath, 'runtime'),
    stateDir: context.globalStorageUri.fsPath,
    workspace,
  };
}

async function ensureRelay() {
  if (isValidRelay(settings().relay)) return true;
  const value = await vscode.window.showInputBox({
    title: 'Agent Bridge',
    prompt: '中继服务器地址（由管理员提供）',
    placeHolder: 'https://relay.example.com:9010',
    ignoreFocusOut: true,
    validateInput: (text) => (isValidRelay(text.trim()) ? null : '格式应为 https://域名[:端口]，或 主机:端口（明文，不推荐）'),
  });
  if (!value) return false;
  await vscode.workspace.getConfiguration('agentBridge').update('relayAddress', value.trim(), vscode.ConfigurationTarget.Global);
  return true;
}

async function start(enroll = false) {
  if (await ensureRelay()) await supervisor.start(options(), { enroll });
}

async function restart() {
  await supervisor.stop();
  await start();
}

async function rePair() {
  const choice = await vscode.window.showWarningMessage(
    '重新绑定会生成新的凭据，并需要用飞书重新扫码确认；本机原来的凭据随即失效。手机上同名的旧条目会被自动替换，如果改过电脑名，旧条目需要在手机上手动移除。继续吗？', { modal: true }, '继续');
  if (choice !== '继续') return;
  await supervisor.stop();
  await start(true);
}

function closePanel() {
  if (panel) panel.dispose();
  panel = undefined;
}

function showPanel(info) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('agentBridgePairing', 'Agent Bridge 绑定', vscode.ViewColumn.Active, {});
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  panel.webview.html = renderPairingHtml(info);
  panel.reveal();
}

function showQr() {
  if (supervisor.state === 'pairing' && lastPairing) showPanel(lastPairing);
  else vscode.window.showInformationMessage('Agent Bridge: 当前没有待扫码的绑定请求。');
}

function hostLine() {
  const system = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[process.platform] || process.platform;
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const where = vscode.env.remoteName ? `（远程：${vscode.env.remoteName}）` : '（本地）';
  return `运行在 ${os.hostname()} · ${system}${where}\n会话目录：${claudeDir}`;
}

function renderState(state, detail) {
  statusItem.text = STATUS[state];
  statusItem.tooltip = `${detail ? `Agent Bridge: ${detail}` : 'Agent Bridge: 点击打开菜单'}\n${hostLine()}`;
  statusItem.backgroundColor = state === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  if (state !== 'pairing') closePanel();
  if (state === 'error') {
    vscode.window.showErrorMessage(`Agent Bridge: ${detail}`, '查看日志', '重试').then((choice) => {
      if (choice === '查看日志') output.show();
      else if (choice === '重试') start();
    });
  }
}

function readPublicKey() {
  try {
    return fs.readFileSync(path.join(context.extensionPath, 'update-public-key.pem'), 'utf8');
  } catch {
    return '';
  }
}

async function installUpdate(release) {
  updating = true;
  const directory = path.join(context.globalStorageUri.fsPath, 'updates');
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    const file = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Agent Bridge: 正在下载 ${release.version}` },
      () => downloadUpdate(release, directory));
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    } catch (error) {
      output.appendLine(`[update] install failed: ${error.message}`);
      vscode.window.showWarningMessage(`Agent Bridge: 新版本已下载并通过校验，但自动安装失败。请在扩展面板选择“从 VSIX 安装…”，文件：${file}`);
      return;
    }
    fs.rmSync(directory, { recursive: true, force: true });
    output.appendLine(`[update] installed ${release.version}`);
    const choice = await vscode.window.showInformationMessage(
      `Agent Bridge 已更新到 ${release.version}。重新加载窗口后生效，Bridge 会自动重启，不需要重新扫码。`, '重新加载');
    if (choice === '重新加载') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    output.appendLine(`[update] failed: ${error.message}`);
    vscode.window.showWarningMessage(`Agent Bridge: 更新失败：${error.message}`);
  } finally {
    updating = false;
  }
}

async function checkUpdate() {
  if (updating) {
    vscode.window.showInformationMessage('Agent Bridge: 正在更新，请稍候。');
    return;
  }
  const base = updateBaseFromRelay(settings().relay);
  const publicKey = readPublicKey();
  if (!base || !publicKey) {
    vscode.window.showInformationMessage(!base
      ? 'Agent Bridge: 检查更新需要 https:// 形式的中继地址（设置里的 agentBridge.relayAddress）。'
      : 'Agent Bridge: 这个安装包不带更新公钥，无法校验新版本。');
    return;
  }
  const { name, version: current } = context.extension.packageJSON;
  let release;
  try {
    release = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Agent Bridge: 正在检查更新' },
      () => checkForUpdate({ base, current, publicKey, name }));
  } catch (error) {
    output.appendLine(`[update] check failed: ${error.message}`);
    vscode.window.showWarningMessage(`Agent Bridge: 检查更新失败：${error.message}`);
    return;
  }
  if (!release.available) {
    vscode.window.showInformationMessage(`Agent Bridge: 已是最新版本（${current}）。`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(`Agent Bridge 有新版本 ${release.version}（当前 ${current}）。`, '立即更新', '稍后');
  if (choice === '立即更新') await installUpdate(release);
}

async function menu() {
  const state = supervisor.state;
  const items = [];
  if (['stopped', 'error', 'other-window'].includes(state)) items.push({ label: '$(play) 启动', run: () => start() });
  if (state === 'pairing') items.push({ label: '$(device-mobile) 显示绑定二维码', run: showQr });
  if (state === 'guest') items.push({ label: '$(debug-stop) 退出接入', run: () => supervisor.stop() });
  if (['running', 'pairing', 'starting'].includes(state)) {
    items.push({ label: '$(debug-restart) 重启', run: restart });
    items.push({ label: '$(debug-stop) 停止', run: () => supervisor.stop() });
  }
  items.push({ label: '$(key) 重新绑定手机', run: rePair });
  items.push({ label: '$(cloud-download) 检查更新', run: () => checkUpdate() });
  items.push({ label: '$(output) 查看日志', run: () => output.show() });
  items.push({ label: '$(gear) 设置', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'agentBridge') });
  const picked = await vscode.window.showQuickPick(items, { title: `Agent Bridge — ${STATUS[state].replace(/^\S+ /, '')}` });
  if (picked) await picked.run();
}

// The Bridge reports whether it took over the Codex extension's codex. The editor panel only joins after a reload.
function onCodexTakeover(line) {
  const match = /^Codex takeover: (\S+)/.exec(line);
  if (!match || !['installed', 'restored'].includes(match[1])) return;
  const text = match[1] === 'installed'
    ? 'Agent Bridge 已接管编辑器里的 Codex：重新加载窗口后，手机和电脑可以同时使用同一个 Codex 会话。不需要时可在设置里关闭 agentBridge.codexTakeover。'
    : 'Agent Bridge 已把 Codex 扩展恢复原样，重新加载窗口后生效。';
  vscode.window.showInformationMessage(text, '重新加载').then((choice) => {
    if (choice === '重新加载') vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
}

function activate(extensionContext) {
  context = extensionContext;
  output = vscode.window.createOutputChannel('Agent Bridge');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = 'agentBridge.menu';
  supervisor = new Supervisor();

  supervisor.on('log', (source, line) => {
    output.appendLine(`[${source}] ${line}`);
    if (source === 'bridge') onCodexTakeover(line);
  });
  supervisor.on('state', renderState);
  supervisor.on('pairing', (info) => {
    lastPairing = info;
    showPanel(info);
  });
  supervisor.on('bound', () => vscode.window.showInformationMessage('Agent Bridge: 绑定成功'));
  supervisor.on('warn', (text) => vscode.window.showWarningMessage(`Agent Bridge: ${text}`));

  const register = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    output,
    statusItem,
    register('agentBridge.menu', menu),
    register('agentBridge.start', () => start()),
    register('agentBridge.stop', () => supervisor.stop()),
    register('agentBridge.restart', restart),
    register('agentBridge.rePair', rePair),
    register('agentBridge.showQr', showQr),
    register('agentBridge.showLog', () => output.show()),
    register('agentBridge.checkUpdate', () => checkUpdate()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('agentBridge') || !['running', 'pairing'].includes(supervisor.state)) return;
      vscode.window.showInformationMessage('Agent Bridge: 设置已更改，重启后生效。', '重启').then((choice) => {
        if (choice === '重启') restart();
      });
    }),
  );

  renderState('stopped', '');
  statusItem.show();
  const initial = settings();
  if (initial.autoStart && isValidRelay(initial.relay)) start();
}

function deactivate() {
  return supervisor ? supervisor.stop() : undefined;
}

module.exports = { activate, deactivate };
