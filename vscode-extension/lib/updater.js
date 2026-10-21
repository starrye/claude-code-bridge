'use strict';

// Self-update without a marketplace. The relay's HTTPS host serves two kinds of file under /updates/:
//   latest.json                  {"manifest": "<JSON text>", "signature": "<base64 Ed25519 over that text>"}
//   agent-bridge-X.Y.Z.vsix      the package the manifest describes
// Nothing in a manifest is trusted before its signature checks out against the public key shipped inside
// the extension, so whoever controls the web server alone cannot push code to users.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const MAX_DOCUMENT_BYTES = 16 * 1024;
const MAX_VSIX_BYTES = 30 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SHA256 = /^[0-9a-f]{64}$/;

class UpdateError extends Error {}

const parseVersion = (text) => (typeof text === 'string' && VERSION.test(text) ? text.split('.').map(Number) : null);

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new UpdateError(`not a plain x.y.z version: ${!left ? a : b}`);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

// Updates are only ever fetched over HTTPS, from the host the user already trusts as their relay.
function updateBaseFromRelay(relay) {
  const match = /^https:\/\/([A-Za-z0-9.-]+)(:\d{1,5})?\/?$/.exec(String(relay || '').trim());
  return match ? `https://${match[1]}${match[2] || ''}/updates` : null;
}

function get(url, { maxBytes, ca, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new UpdateError('bad update address'));
      return;
    }
    if (target.protocol !== 'https:') {
      reject(new UpdateError('updates are only fetched over https'));
      return;
    }
    const request = https.get(target, { ca, timeout: timeoutMs, headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'agent-bridge-updater' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new UpdateError(`update server answered ${response.statusCode}`));
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.resume();
        request.destroy();
        reject(new UpdateError('update file is larger than allowed'));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy();
          reject(new UpdateError('update file is larger than allowed'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', (error) => reject(new UpdateError(error.message)));
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new UpdateError('update server did not answer in time'));
    });
    request.on('error', (error) => reject(error instanceof UpdateError ? error : new UpdateError(error.message)));
  });
}

// Returns the verified description of the release, or throws. `current` only decides "newer or not".
function verifyDocument(raw, publicKeyPem, { name, current }) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new UpdateError('latest.json is not valid JSON');
  }
  if (!document || typeof document.manifest !== 'string' || typeof document.signature !== 'string') {
    throw new UpdateError('latest.json is missing the manifest or the signature');
  }
  const signature = Buffer.from(document.signature, 'base64');
  let valid = false;
  try {
    valid = signature.length === 64 && crypto.verify(null, Buffer.from(document.manifest, 'utf8'), crypto.createPublicKey(publicKeyPem), signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new UpdateError('the update signature is not valid');

  let manifest;
  try {
    manifest = JSON.parse(document.manifest);
  } catch {
    throw new UpdateError('the signed manifest is not valid JSON');
  }
  const { version, file, sha256, size } = manifest || {};
  if (manifest.name !== name) throw new UpdateError('the update is for a different extension');
  if (!parseVersion(version)) throw new UpdateError('the update has no valid version');
  if (file !== `${name}-${version}.vsix`) throw new UpdateError('the update names an unexpected file');
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new UpdateError('the update has no valid checksum');
  if (!Number.isInteger(size) || size < 1 || size > MAX_VSIX_BYTES) throw new UpdateError('the update has an invalid size');
  return { available: compareVersions(version, current) > 0, version, file, sha256, size, published: manifest.published };
}

async function checkForUpdate({ base, current, publicKey, name, ca, timeoutMs }) {
  const raw = await get(`${base}/latest.json`, { maxBytes: MAX_DOCUMENT_BYTES, ca, timeoutMs });
  const release = verifyDocument(raw.toString('utf8'), publicKey, { name, current });
  return { ...release, url: `${base}/${release.file}` };
}

// Downloads the package the signed manifest describes and refuses anything that does not match it byte for byte.
async function downloadUpdate(release, destinationDir, { ca, timeoutMs } = {}) {
  const data = await get(release.url, { maxBytes: release.size, ca, timeoutMs });
  if (data.length !== release.size) throw new UpdateError('the downloaded package has the wrong size');
  if (crypto.createHash('sha256').update(data).digest('hex') !== release.sha256) throw new UpdateError('the downloaded package does not match its checksum');
  if (data.readUInt32BE(0) !== 0x504b0304) throw new UpdateError('the downloaded package is not a VSIX archive');
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  const target = path.join(destinationDir, release.file);
  const partial = `${target}.partial`;
  fs.writeFileSync(partial, data, { mode: 0o600 });
  fs.renameSync(partial, target);
  return target;
}

module.exports = { UpdateError, parseVersion, compareVersions, updateBaseFromRelay, verifyDocument, checkForUpdate, downloadUpdate, MAX_VSIX_BYTES };
