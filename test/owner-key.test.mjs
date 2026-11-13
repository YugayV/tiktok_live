import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signOwnerKey, verifyOwnerKey } from '../src/owner-key.mjs';
import { License } from '../src/license.mjs';
import { CloudService } from '../cloud/service.mjs';
import { AccountStore } from '../hosted/accounts.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('owner keys: valid signature only; expiry and revocation', () => {
  const { token, payload } = signOwnerKey({ sub: 'vitality_ai' }, PEM);
  assert.equal(verifyOwnerKey(token, PUB).sub, 'vitality_ai');
  assert.equal(verifyOwnerKey(token, PUB).role, 'admin');
  // Changing the name in the payload breaks the signature.
  const [h, body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...payload, sub: 'someone_else' })).toString('base64url');
  assert.equal(verifyOwnerKey(`${h}.${forged}.${sig}`, PUB), null);
  // A key from another private key is rejected.
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(verifyOwnerKey(signOwnerKey({ sub: 'x' }, other).token, PUB), null);
  assert.equal(verifyOwnerKey(token, PUB, { revoked: [payload.id] }), null);
  const short = signOwnerKey({ sub: 'guest', days: 1, role: 'pro' }, PEM, 0).token;
  assert.equal(verifyOwnerKey(short, PUB, { now: 2 * 86400000 }), null);
  assert.equal(verifyOwnerKey('TLO1.garbage', PUB), null);
  assert.equal(verifyOwnerKey(token, ''), null);
  assert.ok(body);
});

test('desktop: an owner key turns on Pro + admin offline, even with no store configured', async () => {
  let t = Date.UTC(2026, 10, 1);
  const lic = new License({ file: null, config: { ownerPublicKey: PUB }, now: () => t, fetchImpl: async () => { throw new Error('no network'); } });
  t += 30 * 86400000; // trial long over
  assert.equal(lic.status().plan, 'expired');
  await assert.rejects(lic.activate('TLO1.bad.sig'), /недействителен/);
  const st = await lic.activate(signOwnerKey({ sub: 'vitality_ai' }, PEM).token);
  assert.equal(st.plan, 'pro');
  assert.equal(st.admin, true);
  assert.equal(st.owner.name, 'vitality_ai');
  t += 365 * 86400000; // a year offline: still Pro (no revalidation needed)
  await lic.validate();
  assert.equal(lic.status().plan, 'pro');
  assert.ok(lic.can('ai'));
});

test('cloud: owner key answers AI questions without Lemon Squeezy, with its own cap', async () => {
  let lsCalls = 0;
  const service = new CloudService({
    anthropic: { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Привет!' }] }) } } },
    fetchImpl: async () => (lsCalls++, { ok: true, json: async () => ({ valid: false }) }),
    config: { ownerPublicKey: PUB, ownerMonthlyLimit: 1 },
    log: () => {},
  });
  const { token, payload } = signOwnerKey({ sub: 'vitality_ai' }, PEM);
  const ask = (auth) => service.answer({ question: 'Во что играем?', nickname: 'A', persona: 'бот' }, { authorization: `Bearer ${auth}`, ip: '1.1.1.1' });
  const r = await ask(token);
  assert.equal(r.status, 200);
  assert.equal(r.body.answer, 'Привет!');
  assert.equal(lsCalls, 0);
  assert.equal((await ask(token)).status, 429);
  assert.equal((await ask(signOwnerKey({ sub: 'x' }, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })).token)).status, 402);
  assert.ok(payload.id);
});

test('web accounts: admin list matches only confirmed identities and sticks to the account', () => {
  const acc = new AccountStore(null, { admins: ['tiktok:vitality_ai', 'email:boss@mail.com'] });
  const { userId } = acc.loginWithTikTok({ openId: 'o1', username: 'vitality_ai', displayName: 'V' });
  assert.ok(acc.isAdmin(userId));
  assert.equal(acc.grant(userId).status, 'admin');
  // The handle changes later: the account stays admin.
  acc.loginWithTikTok({ openId: 'o1', username: 'renamed' });
  assert.ok(acc.isAdmin(userId));
  // Someone else who later takes the same handle (another TikTok account) does NOT become admin.
  const impostor = acc.loginWithTikTok({ openId: 'o2', username: 'vitality_ai' }).userId;
  assert.equal(acc.isAdmin(impostor), false);
  const unverified = acc.signup('boss@mail.com', 'password1', { verified: false });
  assert.equal(acc.isAdmin(unverified), false);
  acc.verifyEmail(acc.createVerifyToken(unverified));
  assert.ok(acc.isAdmin(unverified));
});
