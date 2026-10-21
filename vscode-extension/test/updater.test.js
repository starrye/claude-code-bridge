'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const updater = require('../lib/updater');

const NAME = 'agent-bridge';
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const hasPython = spawnSync('python3', ['--version']).status === 0;
const tmpdir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const pair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) };
};
const KEY = pair();
const OTHER = pair();

function vsixBytes(extra = '') {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`pretend archive ${extra}`)]);
}

// A signed latest.json for `data`, with fields overridable to build bad ones.
function signed(data, { version = '0.2.0', key = KEY, override = {}, tamper } = {}) {
  const manifest = JSON.stringify({
    name: NAME, version, file: `${NAME}-${version}.vsix`,
    sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length, ...override,
  });
  const signature = crypto.sign(null, Buffer.from(manifest), key.privateKey).toString('base64');
  return JSON.stringify({ manifest: tamper ? tamper(manifest) : manifest, signature });
}

test('versions compare numerically, not as text', () => {
  assert.equal(updater.compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(updater.compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(updater.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(updater.compareVersions('0.1.0', '0.1.1'), -1);
  for (const bad of ['1.0', '1.0.0-beta', 'v1.0.0', '', '1.0.0.0', '1.a.0', '99999.0.0']) {
    assert.equal(updater.parseVersion(bad), null, bad);
    assert.throws(() => updater.compareVersions(bad, '1.0.0'), updater.UpdateError);
  }
});

test('the update address comes only from an https relay address', () => {
  assert.equal(updater.updateBaseFromRelay('https://relay.example.com:9010'), 'https://relay.example.com:9010/updates');
  assert.equal(updater.updateBaseFromRelay('https://relay.example.com/'), 'https://relay.example.com/updates');
  for (const bad of ['relay.example.com:9010', 'http://relay.example.com:9010', '', 'https://', 'https://a.example/x', 'https://a.example@evil.example', 'https://rel ay.example']) {
    assert.equal(updater.updateBaseFromRelay(bad), null, bad);
  }
});

test('a correctly signed newer release is accepted', () => {
  const data = vsixBytes();
  const release = updater.verifyDocument(signed(data), KEY.publicPem, { name: NAME, current: '0.1.0' });
  assert.equal(release.available, true);
  assert.equal(release.version, '0.2.0');
  assert.equal(release.file, 'agent-bridge-0.2.0.vsix');
  assert.equal(release.size, data.length);
});

test('the same or an older release is not an update (no downgrade by replaying an old signed file)', () => {
  const data = vsixBytes();
  assert.equal(updater.verifyDocument(signed(data), KEY.publicPem, { name: NAME, current: '0.2.0' }).available, false);
  assert.equal(updater.verifyDocument(signed(data, { version: '0.1.0' }), KEY.publicPem, { name: NAME, current: '0.2.0' }).available, false);
});

test('anything the signature does not cover or vouch for is refused', () => {
  const data = vsixBytes();
  const refuse = (raw, pattern, publicPem = KEY.publicPem) =>
    assert.throws(() => updater.verifyDocument(raw, publicPem, { name: NAME, current: '0.1.0' }), (error) => error instanceof updater.UpdateError && pattern.test(error.message));

  refuse(signed(data, { key: OTHER }), /signature/);                                        // signed by someone else
  refuse(signed(data), /signature/, OTHER.publicPem);                                       // we trust a different key
  refuse(signed(data, { tamper: (m) => m.replace('0.2.0', '9.9.9') }), /signature/);        // manifest edited after signing
  refuse(signed(data, { tamper: (m) => m.replace(/"size":\d+/, '"size":1') }), /signature/);
  const good = JSON.parse(signed(data));
  refuse(JSON.stringify({ ...good, signature: Buffer.alloc(64).toString('base64') }), /signature/);
  refuse(JSON.stringify({ ...good, signature: 'short' }), /signature/);
  refuse(JSON.stringify({ manifest: good.manifest }), /missing/);
  refuse(JSON.stringify({ signature: good.signature }), /missing/);
  refuse('not json', /valid JSON/);
  refuse('null', /missing/);
  refuse(JSON.stringify({ manifest: 5, signature: good.signature }), /missing/);
});

test('a validly signed manifest with bad contents is still refused', () => {
  const data = vsixBytes();
  const refuse = (override, pattern) =>
    assert.throws(() => updater.verifyDocument(signed(data, { override }), KEY.publicPem, { name: NAME, current: '0.1.0' }), (error) => pattern.test(error.message));
  refuse({ name: 'some-other-extension' }, /different extension/);
  refuse({ file: '../../etc/cron.d/evil' }, /unexpected file/);
  refuse({ file: 'agent-bridge-0.2.0.vsix/../x' }, /unexpected file/);
  refuse({ file: 'https://evil.example/agent-bridge-0.2.0.vsix' }, /unexpected file/);
  refuse({ file: 'agent-bridge-0.3.0.vsix' }, /unexpected file/);
  refuse({ version: '0.2.0-evil' , file: 'agent-bridge-0.2.0-evil.vsix' }, /valid version/);
  refuse({ sha256: 'zz' }, /checksum/);
  refuse({ sha256: 'A'.repeat(64) }, /checksum/);
  refuse({ size: 0 }, /size/);
  refuse({ size: updater.MAX_VSIX_BYTES + 1 }, /size/);
  refuse({ size: 1.5 }, /size/);
});

// ---------------------------------------------------------------- over a real HTTPS server
function certificate(dir) {
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

async function serve(t, tls, handler) {
  const server = https.createServer(tls, handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `https://localhost:${server.address().port}/updates`;
}

const files = (map) => (request, response) => {
  const hit = map[new URL(request.url, 'https://x').pathname.replace('/updates/', '')];
  if (!hit) { response.writeHead(404); response.end(); return; }
  if (typeof hit === 'function') { hit(response); return; }
  response.writeHead(200, { 'Content-Length': hit.length });
  response.end(hit);
};

test('over https: check, download and verify a real release', { skip: !hasOpenssl }, async (t) => {
  const tls = certificate(tmpdir('upd-'));
  const data = vsixBytes('real');
  const base = await serve(t, tls, files({ 'latest.json': signed(data), 'agent-bridge-0.2.0.vsix': data }));
  const release = await updater.checkForUpdate({ base, current: '0.1.0', publicKey: KEY.publicPem, name: NAME, ca: tls.cert });
  assert.equal(release.available, true);
  assert.equal(release.url, `${base}/agent-bridge-0.2.0.vsix`);
  const dest = tmpdir('upd-dl-');
  const file = await updater.downloadUpdate(release, dest, { ca: tls.cert });
  assert.deepEqual(fs.readFileSync(file), data);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dest), ['agent-bridge-0.2.0.vsix'], 'no partial file left behind');
  const none = await updater.checkForUpdate({ base, current: '0.2.0', publicKey: KEY.publicPem, name: NAME, ca: tls.cert });
  assert.equal(none.available, false);
});

test('over https: a package that differs from the signed description is refused and nothing is kept', { skip: !hasOpenssl }, async (t) => {
  const tls = certificate(tmpdir('upd-'));
  const data = vsixBytes('genuine');
  const evil = vsixBytes('malware'.padEnd('genuine'.length, '!'));
  assert.equal(evil.length, data.length);
  const cases = {
    'swapped content of the same size': evil,
    'truncated': data.subarray(0, data.length - 3),
    'padded': Buffer.concat([data, Buffer.from('extra')]),
    'not an archive': Buffer.from('x'.repeat(data.length)),
  };
  for (const [label, served] of Object.entries(cases)) {
    const base = await serve(t, tls, files({ 'latest.json': signed(data), 'agent-bridge-0.2.0.vsix': served }));
    const release = await updater.checkForUpdate({ base, current: '0.1.0', publicKey: KEY.publicPem, name: NAME, ca: tls.cert });
    const dest = tmpdir('upd-dl-');
    await assert.rejects(updater.downloadUpdate(release, dest, { ca: tls.cert }), updater.UpdateError, label);
    assert.deepEqual(fs.readdirSync(dest), [], `${label}: nothing written`);
  }
});

test('over https: the checksum is enforced even when the size matches an archive header', { skip: !hasOpenssl }, async (t) => {
  const tls = certificate(tmpdir('upd-'));
  const data = vsixBytes('A');
  const forged = vsixBytes('B');
  const base = await serve(t, tls, files({ 'latest.json': signed(data), 'agent-bridge-0.2.0.vsix': forged }));
  const release = await updater.checkForUpdate({ base, current: '0.1.0', publicKey: KEY.publicPem, name: NAME, ca: tls.cert });
  await assert.rejects(updater.downloadUpdate(release, tmpdir('upd-dl-'), { ca: tls.cert }), /checksum/);
});

test('over https: servers that misbehave cannot make the updater accept or hang', { skip: !hasOpenssl }, async (t) => {
  const tls = certificate(tmpdir('upd-'));
  const data = vsixBytes();
  const check = (base, extra = {}) => updater.checkForUpdate({ base, current: '0.1.0', publicKey: KEY.publicPem, name: NAME, ca: tls.cert, ...extra });

  const redirecting = await serve(t, tls, (request, response) => { response.writeHead(302, { Location: 'https://evil.example/latest.json' }); response.end(); });
  await assert.rejects(check(redirecting), /answered 302/, 'redirects are not followed');

  const missing = await serve(t, tls, files({}));
  await assert.rejects(check(missing), /answered 404/);

  const huge = await serve(t, tls, files({ 'latest.json': Buffer.alloc(40 * 1024, 'x') }));
  await assert.rejects(check(huge), /larger than allowed/, 'an oversized latest.json is cut off');

  const silent = await serve(t, tls, (request, response) => { /* never answers */ });
  await assert.rejects(check(silent, { timeoutMs: 300 }), /in time/);

  const forgedBySomeoneElse = await serve(t, tls, files({ 'latest.json': signed(data, { key: OTHER }) }));
  await assert.rejects(check(forgedBySomeoneElse), /signature/);

  const lyingLength = await serve(t, tls, files({ 'latest.json': signed(data), 'agent-bridge-0.2.0.vsix': Buffer.alloc(1024 * 1024) }));
  const release = await check(lyingLength);
  await assert.rejects(updater.downloadUpdate(release, tmpdir('upd-dl-'), { ca: tls.cert }), /larger than allowed/, 'a download bigger than the signed size is cut off');
});

test('over https: a signed package that is not an archive is refused by the archive check itself', { skip: !hasOpenssl }, async (t) => {
  const tls = certificate(tmpdir('upd-'));
  const notArchive = Buffer.from('this is a script, not a zip file'.repeat(4));       // right checksum, right size, wrong kind
  const base = await serve(t, tls, files({ 'latest.json': signed(notArchive), 'agent-bridge-0.2.0.vsix': notArchive }));
  const release = await updater.checkForUpdate({ base, current: '0.1.0', publicKey: KEY.publicPem, name: NAME, ca: tls.cert });
  await assert.rejects(updater.downloadUpdate(release, tmpdir('upd-dl-'), { ca: tls.cert }), /not a VSIX archive/);
});

test('over https: size limits hold without trusting Content-Length, and a declared huge body is refused at once', { skip: !hasOpenssl, timeout: 20000 }, async (t) => {
  const tls = certificate(tmpdir('upd-'));
  const data = vsixBytes();
  const chunked = (response) => {                       // no Content-Length: only counting bytes can stop this
    response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
    const block = Buffer.alloc(8 * 1024, 'x');
    const timer = setInterval(() => { if (!response.write(block)) clearInterval(timer); }, 1);
    response.on('close', () => clearInterval(timer));
  };
  const baseChunked = await serve(t, tls, files({ 'latest.json': chunked, 'agent-bridge-0.2.0.vsix': chunked }));
  await assert.rejects(updater.checkForUpdate({ base: baseChunked, current: '0.1.0', publicKey: KEY.publicPem, name: NAME, ca: tls.cert, timeoutMs: 5000 }), /larger than allowed/, 'latest.json, streamed');
  const release = { ...updater.verifyDocument(signed(data), KEY.publicPem, { name: NAME, current: '0.1.0' }), url: `${baseChunked}/agent-bridge-0.2.0.vsix` };
  await assert.rejects(updater.downloadUpdate(release, tmpdir('upd-dl-'), { ca: tls.cert, timeoutMs: 5000 }), /larger than allowed/, 'package, streamed');

  const stalled = (response) => { response.writeHead(200, { 'Content-Length': String(99 * 1024 * 1024) }); response.write('ten bytes!'); };   // never finishes
  const baseStalled = await serve(t, tls, files({ 'latest.json': stalled, 'agent-bridge-0.2.0.vsix': stalled }));
  const started = Date.now();
  await assert.rejects(updater.checkForUpdate({ base: baseStalled, current: '0.1.0', publicKey: KEY.publicPem, name: NAME, ca: tls.cert, timeoutMs: 8000 }), /larger than allowed/);
  assert.ok(Date.now() - started < 3000, 'refused from the header, without waiting for the body');
});

test('over https: a certificate that is not trusted is refused, and so is plain http', { skip: !hasOpenssl }, async (t) => {
  const tls = certificate(tmpdir('upd-'));
  const data = vsixBytes();
  const base = await serve(t, tls, files({ 'latest.json': signed(data) }));
  await assert.rejects(updater.checkForUpdate({ base, current: '0.1.0', publicKey: KEY.publicPem, name: NAME }), updater.UpdateError, 'self-signed without the CA');
  const other = certificate(tmpdir('upd-'));
  await assert.rejects(updater.checkForUpdate({ base, current: '0.1.0', publicKey: KEY.publicPem, name: NAME, ca: other.cert }), updater.UpdateError, 'a different CA');
  await assert.rejects(updater.checkForUpdate({ base: base.replace('https:', 'http:'), current: '0.1.0', publicKey: KEY.publicPem, name: NAME }), /only fetched over https/);
});

// ---------------------------------------------------------------- the publishing script
const RELEASE = path.resolve(__dirname, '../scripts/release.js');
const run = (args, env = {}) => spawnSync(process.execPath, [RELEASE, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('release.js: makes a key, signs a build, and what it writes verifies the way users verify it', { skip: !hasPython }, () => {
  const dir = tmpdir('rel-');
  const key = path.join(dir, 'private.pem');
  const pub = path.join(dir, 'public.pem');
  const out = path.join(dir, 'out');

  const init = run(['--init-key', '--key', key, '--pub', pub]);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.equal(run(['--init-key', '--key', key, '--pub', pub]).status, 1, 'an existing key is never replaced');

  const made = run(['--key', key, '--pub', pub, '--out', out, '--relay', 'https://relay.example.com:9010']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  const latest = fs.readFileSync(path.join(out, 'latest.json'), 'utf8');
  const release = updater.verifyDocument(latest, fs.readFileSync(pub, 'utf8'), { name: pkg.name, current: '0.0.0' });
  assert.equal(release.version, pkg.version);
  const data = fs.readFileSync(path.join(out, release.file));
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), release.sha256);
  assert.equal(data.length, release.size);
  assert.throws(() => updater.verifyDocument(latest, KEY.publicPem, { name: pkg.name, current: '0.0.0' }), /signature/, 'another key does not verify it');

  const wrong = run(['--key', key, '--pub', path.join(dir, 'other-public.pem'), '--out', out].concat([]), {});
  assert.equal(wrong.status, 1, 'no public key file');
  fs.writeFileSync(path.join(dir, 'other-public.pem'), OTHER.publicPem);
  const mismatch = run(['--key', key, '--pub', path.join(dir, 'other-public.pem'), '--out', out]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match/);
});

test('release.js: refuses a private key kept inside the repository', () => {
  const inRepo = path.resolve(__dirname, '../scratch-private.pem');
  const result = run(['--key', inRepo]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the repository/);
  assert.equal(fs.existsSync(inRepo), false);
});

test('the public key in the repository, if any, is a valid Ed25519 key', { skip: !fs.existsSync(path.resolve(__dirname, '../update-public-key.pem')) }, () => {
  const pem = fs.readFileSync(path.resolve(__dirname, '../update-public-key.pem'), 'utf8');
  assert.equal(crypto.createPublicKey(pem).asymmetricKeyType, 'ed25519');
});
