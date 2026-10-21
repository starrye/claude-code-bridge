'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const HARNESS = path.resolve(__dirname, '../test-support/extension-update-harness.js');
const NAME = 'agent-bridge';

const pair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) };
};
const KEY = pair();
const OTHER = pair();

let tlsCache;
function tls() {
  if (tlsCache) return tlsCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-tls-'));
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  tlsCache = { dir, key: fs.readFileSync(`${dir}/k.pem`, 'utf8'), cert: fs.readFileSync(`${dir}/c.pem`, 'utf8'), certPath: `${dir}/c.pem` };
  return tlsCache;
}

const archive = (label) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`archive ${label}`)]);
function release(data, { version = '0.2.0', key = KEY } = {}) {
  const manifest = JSON.stringify({ name: NAME, version, file: `${NAME}-${version}.vsix`, sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length });
  return { 'latest.json': JSON.stringify({ manifest, signature: crypto.sign(null, Buffer.from(manifest), key.privateKey).toString('base64') }), [`${NAME}-${version}.vsix`]: data.toString('latin1') };
}

// Drives the real extension.js. `answers` are the button labels the user clicks, in the order the prompts appear.
function drive(options) {
  const certs = tls();
  const scenario = { relay: 'SERVER', current: '0.1.0', publicKey: KEY.publicPem, steps: ['manual'], answers: [], files: {}, tls: { key: certs.key, cert: certs.cert }, ...options };
  const child = spawnSync(process.execPath, [HARNESS, JSON.stringify(scenario)], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_EXTRA_CA_CERTS: certs.certPath },
  });
  const match = /@@RESULT@@(.*)\n/.exec(child.stdout);
  assert.ok(match, `harness failed:\n${child.stdout}\n${child.stderr}`);
  const events = JSON.parse(match[1]);
  const of = (kind) => events.filter((e) => e.kind === kind);
  return { events, of, requests: of('request').map((e) => e.name), installs: of('install'), end: of('end')[0] };
}

test('the user accepts: the signed package is downloaded, handed to VS Code to install, and the temporary copy is removed', { skip: !hasOpenssl }, () => {
  const data = archive('v2');
  const run = drive({ files: release(data), answers: ['立即更新', '重新加载'] });
  assert.deepEqual(run.requests, ['latest.json', 'agent-bridge-0.2.0.vsix']);
  assert.equal(run.installs.length, 1);
  assert.equal(run.installs[0].file, 'agent-bridge-0.2.0.vsix');
  assert.equal(run.installs[0].existed, true, 'the file is on disk when VS Code is asked to install it');
  assert.equal(run.installs[0].bytes, data.toString('latin1'));
  assert.match(run.of('info')[0].message, /新版本 0\.2\.0（当前 0\.1\.0）/);
  assert.match(run.of('info')[1].message, /重新加载窗口后生效.*不需要重新扫码/);
  assert.ok(run.of('command').some((e) => e.id === 'workbench.action.reloadWindow'), 'reload is offered and, when accepted, performed');
  assert.equal(run.end.updatesDirLeft, null, 'the downloaded file is deleted after installing');
});

test('the user declines the reload: nothing is reloaded', { skip: !hasOpenssl }, () => {
  const run = drive({ files: release(archive('v2')), answers: ['立即更新', undefined] });
  assert.equal(run.installs.length, 1);
  assert.ok(!run.of('command').some((e) => e.id === 'workbench.action.reloadWindow'));
});

test('an install that VS Code refuses leaves the verified file for a manual install and says so', { skip: !hasOpenssl }, () => {
  const run = drive({ files: release(archive('v2')), answers: ['立即更新'], installFails: true });
  assert.equal(run.installs.length, 1);
  const warning = run.of('warn')[0].message;
  assert.match(warning, /自动安装失败/);
  assert.match(warning, /agent-bridge-0\.2\.0\.vsix/);
  assert.deepEqual(run.end.updatesDirLeft, ['agent-bridge-0.2.0.vsix'], 'the file is kept so the user can install it by hand');
});

test('a release signed with the wrong key is never installed, and a manual check explains', { skip: !hasOpenssl }, () => {
  const run = drive({ files: release(archive('evil'), { key: OTHER }), answers: ['立即更新'] });
  assert.equal(run.installs.length, 0);
  assert.deepEqual(run.requests, ['latest.json'], 'the package is not even downloaded');
  assert.match(run.of('warn')[0].message, /检查更新失败.*signature/);
});

test('a package that does not match the signed description is rejected before install', { skip: !hasOpenssl }, () => {
  const genuine = archive('genuine');
  const files = release(genuine);
  files['agent-bridge-0.2.0.vsix'] = Buffer.concat([genuine.subarray(0, 4), Buffer.alloc(genuine.length - 4, 0x58)]).toString('latin1');   // same length, still a zip header, different bytes
  assert.equal(files['agent-bridge-0.2.0.vsix'].length, genuine.length);
  const run = drive({ files, answers: ['立即更新'] });
  assert.equal(run.installs.length, 0);
  assert.match(run.of('warn')[0].message, /更新失败/);
  assert.ok(!run.end.updatesDirLeft || run.end.updatesDirLeft.length === 0, 'no unverified file is left behind');
});

test('"later" downloads nothing, and a newer check is offered again next time', { skip: !hasOpenssl }, () => {
  const run = drive({ files: release(archive('v2')), answers: ['稍后', '稍后'], steps: ['manual', 'manual'] });
  assert.equal(run.installs.length, 0);
  assert.equal(run.requests.filter((n) => n === 'agent-bridge-0.2.0.vsix').length, 0, 'never downloaded without consent');
  assert.equal(run.of('info').length, 2, 'each manual check offers the update again');
});

test('nothing newer: the check says so, and an older signed release is not an update', { skip: !hasOpenssl }, () => {
  const same = drive({ files: release(archive('v2')), current: '0.2.0' });
  assert.match(same.of('info')[0].message, /已是最新版本（0\.2\.0）/);
  const older = drive({ files: release(archive('v1'), { version: '0.1.0' }), current: '0.2.0' });
  assert.match(older.of('info')[0].message, /已是最新版本/);
  assert.equal(older.installs.length, 0);
});

test('updates are only attempted for an https relay with a public key', { skip: !hasOpenssl }, () => {
  const plain = drive({ relay: 'relay.example.com:9010', files: release(archive('v2')) });
  assert.deepEqual(plain.requests, [], 'a plain host:port relay is never contacted for updates');
  assert.match(plain.of('info')[0].message, /https:\/\//);
  const noKey = drive({ publicKey: '', files: release(archive('v2')) });
  assert.deepEqual(noKey.requests, []);
  assert.match(noKey.of('info')[0].message, /公钥/);
});

test('nothing runs by itself: starting the extension makes no request and schedules no timer', { skip: !hasOpenssl }, () => {
  const run = drive({ files: release(archive('v2')), steps: [] });
  assert.deepEqual(run.requests, [], 'no network traffic until the user asks');
  assert.deepEqual(run.end.timers, [], 'no long-lived timer');
  assert.equal(run.of('info').length + run.of('warn').length, 0, 'no prompt either');
});

// ---------------------------------------------------------------- relay address
test('no relay address is built in: an empty setting stays empty', { skip: !hasOpenssl }, () => {
  const fs = require('fs'), p = require('path');
  const pkg = JSON.parse(fs.readFileSync(p.resolve(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.contributes.configuration.properties['agentBridge.relayAddress'].default, '');
});
