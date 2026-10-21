#!/usr/bin/env node
'use strict';

// Publishing helper for the self-updating extension.
//
//   node scripts/release.js --init-key                       one time: make the signing key pair
//   node scripts/release.js --relay https://HOST:9010        build, checksum, sign, write <repo>/updates/ (committed)
//
// The private key stays outside the repository (default ~/.config/agent-bridge/update-private.pem, mode 600).
// The matching public key lives in update-public-key.pem and ships inside every package.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyDocument } = require('../lib/updater');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');

function options(argv) {
  const out = {
    key: process.env.AGENT_BRIDGE_UPDATE_KEY || path.join(os.homedir(), '.config', 'agent-bridge', 'update-private.pem'),
    pub: path.join(ROOT, 'update-public-key.pem'),
    out: path.join(REPO, 'updates'),
    relay: '',
    init: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--init-key') out.init = true;
    else if (['--key', '--pub', '--out', '--relay'].includes(flag)) out[flag.slice(2)] = argv[(i += 1)] || '';
    else throw new Error(`unknown option ${flag}`);
  }
  return out;
}

const inside = (child, parent) => {
  const relative = path.relative(parent, path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function fingerprint(publicPem) {
  return crypto.createHash('sha256').update(crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function initKey(o) {
  if (inside(o.key, REPO)) throw new Error('the private key must live outside the repository');
  if (fs.existsSync(o.key)) throw new Error(`${o.key} already exists; refusing to replace a signing key (every installed copy trusts the old public key)`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(o.key), { recursive: true, mode: 0o700 });
  fs.writeFileSync(o.key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(o.pub, pem);
  console.log(`private key: ${o.key}  (back it up somewhere safe; do not commit it)`);
  console.log(`public key:  ${o.pub}  (commit this one)  fingerprint ${fingerprint(pem)}`);
}

function release(o) {
  if (inside(o.key, REPO)) throw new Error('the private key must live outside the repository');
  if (!fs.existsSync(o.key)) throw new Error(`no signing key at ${o.key}; run with --init-key first`);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(o.key));
  const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const shipped = fs.readFileSync(o.pub, 'utf8');
  if (derived.trim() !== shipped.trim()) throw new Error('the private key does not match update-public-key.pem: installed copies would reject this release');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(o.out, { recursive: true });
  const build = spawnSync('python3', [path.join(ROOT, 'scripts', 'build_vsix.py'), ...(o.relay ? ['--relay', o.relay] : []), '--out', o.out], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`building the package failed:\n${build.stdout}${build.stderr}`);

  const file = `${pkg.name}-${pkg.version}.vsix`;
  const data = fs.readFileSync(path.join(o.out, file));
  const manifest = JSON.stringify({
    name: pkg.name, version: pkg.version, file,
    sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length, published: new Date().toISOString(),
  });
  const signature = crypto.sign(null, Buffer.from(manifest, 'utf8'), privateKey).toString('base64');
  const latest = JSON.stringify({ manifest, signature }, null, 2) + '\n';
  verifyDocument(latest, shipped, { name: pkg.name, current: '0.0.0' });      // what users will do, done once here
  fs.writeFileSync(path.join(o.out, 'latest.json'), latest);

  console.log(`version ${pkg.version}, ${data.length} bytes, key ${fingerprint(shipped)}`);
  console.log(`default relay in the package: ${o.relay || '(none: users enter it themselves)'}`);
  console.log(`release written to ${path.relative(REPO, o.out) || '.'}/: ${file} and latest.json`);
  console.log('commit and push both, then on the server `git pull` (nginx serves them from <repo>/updates/; no relay restart).');
}

if (require.main === module) {
  try {
    const o = options(process.argv.slice(2));
    if (o.init) initKey(o);
    else release(o);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { options, initKey, release };
