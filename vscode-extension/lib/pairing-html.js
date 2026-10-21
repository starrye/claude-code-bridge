'use strict';

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function qrSvg(matrix) {
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  let path = '';
  matrix.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="288" height="288" `
    + `shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

function renderPairingHtml(info) {
  const code = info.matrix ? qrSvg(info.matrix) : '<p>二维码生成失败，请使用下方链接。</p>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; max-width: 520px; }
  svg { display: block; margin: 16px 0; border-radius: 8px; }
  .verify { font-size: 1.6em; letter-spacing: .15em; font-weight: 600; }
  .link { word-break: break-all; opacity: .85; user-select: all; }
  .hint { margin-top: 20px; padding: 10px 12px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); }
</style></head><body>
<h2>用飞书扫码，绑定这台电脑</h2>
${code}
<p>电脑名称：<b>${escapeHtml(info.name)}</b></p>
<p>手机上显示的校验码应为：<span class="verify">${escapeHtml(info.verify)}</span></p>
<p>无法扫码时，把下面的链接发到飞书里点开：</p>
<p class="link">${escapeHtml(info.link)}</p>
<p>二维码 10 分钟内有效，绑定成功后此面板会自动关闭。</p>
<p class="hint">如果您有多窗口需求，强烈建议设置 Computer Name 作为窗口的名称（设置里的 <code>agentBridge.computerName</code>），手机上就能分清是哪个窗口。</p>
</body></html>`;
}

module.exports = { renderPairingHtml, qrSvg, escapeHtml };
