'use strict';

// The phone page in real mobile browsers (Playwright: iPhone/Safari engine and Pixel/Chromium) against a real Bridge
// that talks to tests/bridge-js/fake-codex.js. Needs `npm install` and `npx playwright install chromium webkit`.
//   node tests/e2e/phone.js [--shots DIR]
// Screenshots go to DIR (default /tmp/phone-shots).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, webkit, devices } = require('playwright');

const TOKEN = 't'.repeat(32);
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : '/tmp/phone-shots';
const ID = '0199aaaa-0000-7000-8000-000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function startBridge() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-e2e-'));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(tmp, 'projects'));
  const fake = path.join(tmp, 'codex');
  fs.writeFileSync(fake, `#!/bin/sh\nexec ${process.execPath} ${path.join(__dirname, '..', 'bridge-js', 'fake-codex.js')} "$@"\n`, { mode: 0o755 });
  const stateFile = path.join(tmp, 'codex-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ threads: { [ID]: {
    id: ID, cwd: work, preview: 'phone test thread', createdAt: 1, updatedAt: 2, source: 'appServer',
    turns: [{ id: 't0', startedAt: 1, items: [{ type: 'userMessage', id: 'u0', content: [{ type: 'text', text: 'hello' }] }, { type: 'agentMessage', id: 'a0', text: 'hi there' }] }],
  } } }));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bridge-js', 'server.js')], { stdio: 'ignore', env: {
    ...process.env, BRIDGE_PORT: String(port), BRIDGE_TOKEN: TOKEN, BRIDGE_STATE_DIR: path.join(tmp, 'state'), BRIDGE_WORKSPACE: work,
    CLAUDE_PROJECTS_DIR: path.join(tmp, 'projects'), CLAUDE_SESSIONS_DIR: path.join(tmp, 'projects'), CLAUDE_BIN: '/bin/false',
    CODEX_BIN: fake, FAKE_CODEX_STATE: stateFile, BRIDGE_APPROVAL_TIMEOUT: '30',
  } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up */ } await sleep(100); }
  return { base, stop: () => { proc.kill(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

let checks = 0;
const ok = (name) => { checks++; console.log('  ok  ' + name); };

async function run(label, browserType, device, base) {
  console.log(`\n${label}`);
  const browser = await browserType.launch();
  const context = await browser.newContext({ ...devices[device] });
  await context.addInitScript((token) => localStorage.setItem('bridge_token', token), TOKEN);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${label.replace(/\W+/g, '_')}-${name}.png`) });
  await page.goto(base);

  // open the Codex session
  await page.waitForSelector('.session', { timeout: 8000 });
  await page.tap('#menuBtn');                                   // the session list is a drawer on a phone
  await page.locator('.session', { hasText: 'phone test thread' }).first().tap();
  await page.waitForSelector('#slashBtn:not([disabled])');
  await sleep(500);                                             // the drawer slides shut
  ok('the Codex session opens');

  // the command button lists the commands, no typing needed
  await page.tap('#slashBtn');
  await page.waitForSelector('#floatingPicker:not([hidden]) .fpRow');
  const panel = await page.locator('#floatingPicker').innerText();
  for (const name of ['/review', '/init', '/feedback', '/compact', '/status', '/goal', '/sketch']) assert.ok(panel.includes(name), `${name} in the command panel`);
  await shot('commands');
  ok('tapping the button lists the Codex commands');

  // /status
  await page.locator('#floatingPicker .fpRow', { hasText: '/status' }).tap();
  await page.waitForSelector('#floatingPicker:not([hidden]) .fpItem');
  const status = await page.locator('#floatingPicker').innerText();
  assert.ok(status.includes(ID) && status.includes('45%') === false && status.includes('12%'), 'status shows the session and limits');
  await shot('status');
  ok('/status shows the session and usage');
  await page.keyboard.press('Escape');

  // /goal
  page.once('dialog', (d) => d.accept('ship it'));
  await page.tap('#slashBtn');
  await page.locator('#floatingPicker .fpRow', { hasText: '/goal' }).tap();
  await page.waitForSelector('#floatingPicker:not([hidden]) .fpItem');
  await page.locator('#floatingPicker .fpItem', { hasText: '设置目标' }).tap();
  await sleep(400);
  await page.tap('#slashBtn');
  await page.locator('#floatingPicker .fpRow', { hasText: '/goal' }).tap();
  await page.waitForSelector('#floatingPicker:not([hidden]) .fpItem');
  assert.ok((await page.locator('#floatingPicker').innerText()).includes('ship it'));
  await shot('goal');
  ok('/goal sets and shows the goal');
  await page.keyboard.press('Escape');

  // /compact and /feedback
  await page.tap('#slashBtn');
  await page.locator('#floatingPicker .fpRow', { hasText: '/compact' }).tap();
  await page.locator('#toast', { hasText: '压缩' }).waitFor();
  ok('/compact reports it started');
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'it broke' : undefined));
  await page.tap('#slashBtn');
  await page.locator('#floatingPicker .fpRow', { hasText: '/feedback' }).tap();
  await page.locator('#floatingPicker .fpItem', { hasText: '程序有问题' }).tap();
  await page.locator('#toast', { hasText: '反馈已发送' }).waitFor();
  ok('/feedback is sent');

  // /review
  await page.tap('#slashBtn');
  await page.locator('#floatingPicker .fpRow', { hasText: '/review' }).tap();
  await page.locator('#floatingPicker .fpItem', { hasText: '未提交的更改' }).tap();
  await page.locator('#messages', { hasText: 'echo: review:uncommittedChanges' }).waitFor({ timeout: 8000 });
  await shot('review');
  ok('/review runs and its result shows');

  // /sketch: draw, then attach
  await page.tap('#slashBtn');
  await page.locator('#floatingPicker .fpRow', { hasText: '/sketch' }).tap();
  await page.waitForSelector('#sketch:not([hidden])');
  const box = await page.locator('#sketchCanvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * (0.4 + Math.sin(i) * 0.05));
  await page.mouse.up();
  await shot('sketch');
  const pixels = await page.evaluate(() => { const c = document.getElementById('sketchCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200) n++; return n; });
  assert.ok(pixels > 50, 'the stroke is drawn');
  await page.tap('#skDone');
  await page.waitForSelector('#attachments .thumb');
  ok('a drawn sketch becomes an image attachment');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    for (const [label, type, device] of [['iPhone 14 Safari', webkit, 'iPhone 14'], ['Pixel 7 Chrome', chromium, 'Pixel 7']]) {
      const bridge = await startBridge();          // a fresh Bridge per browser: goals and sessions persist
      try { await run(label, type, device, bridge.base); } finally { bridge.stop(); }
    }
    console.log(`\n${checks} phone checks passed; screenshots in ${SHOTS}`);
  } catch (error) {
    console.error('FAIL', error.message);
    process.exitCode = 1;
  }
})();
