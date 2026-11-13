// Owner keys: offline Pro + admin for the app's owner (and anyone they hand one to).
// Format: TLO1.<base64url JSON payload>.<base64url Ed25519 signature>.
// The app and the cloud only hold the PUBLIC key (package.json → tiklive.ownerPublicKey), so a
// key cannot be forged from the code; new keys are minted with scripts/mint-owner-key.mjs and the
// private key file, which never goes into the repository.

import { createPublicKey, createPrivateKey, sign, verify, randomBytes } from 'node:crypto';

const PREFIX = 'TLO1.';
// DER header of an Ed25519 SubjectPublicKeyInfo; followed by the 32 raw key bytes.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export const isOwnerKeyFormat = (key) => String(key || '').startsWith(PREFIX);

const keyCache = new Map();
function publicKey(raw) {
  if (!keyCache.has(raw)) {
    const bytes = Buffer.from(String(raw), 'base64');
    if (bytes.length !== 32) throw new Error('bad owner public key');
    keyCache.set(raw, createPublicKey({ key: Buffer.concat([SPKI_ED25519, bytes]), format: 'der', type: 'spki' }));
  }
  return keyCache.get(raw);
}

// Returns the payload ({ id, sub, role, iat, exp? }) or null for anything forged, revoked or expired.
export function verifyOwnerKey(token, publicKeyB64, { revoked = [], now = Date.now() } = {}) {
  try {
    if (!publicKeyB64 || !isOwnerKeyFormat(token)) return null;
    const [, body, sig] = String(token).trim().split('.');
    if (!body || !sig) return null;
    if (!verify(null, Buffer.from(`${PREFIX}${body}`), publicKey(publicKeyB64), Buffer.from(sig, 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p.sub !== 'string' || (p.exp && p.exp < now) || revoked.includes(p.id)) return null;
    return p;
  } catch {
    return null;
  }
}

export function signOwnerKey({ sub, role = 'admin', days = 0, note = '' }, privateKeyPem, now = Date.now()) {
  const payload = { id: randomBytes(6).toString('hex'), sub, role, iat: now, ...(days ? { exp: now + days * 86400000 } : {}), ...(note ? { note } : {}) };
  const body = b64u(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${PREFIX}${body}`), createPrivateKey(privateKeyPem));
  return { token: `${PREFIX}${body}.${b64u(sig)}`, payload };
}
