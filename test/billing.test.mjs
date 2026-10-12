import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySignature, subscriptionActive, checkoutUrlFor, applyWebhook } from '../hosted/billing.mjs';
import { AccountStore } from '../hosted/accounts.mjs';
import { startHostedServer } from '../hosted/server.mjs';

const SECRET = 'whsec_test';
const sign = (raw) => createHmac('sha256', SECRET).update(raw).digest('hex');
const sub = (event, attrs = {}, custom = {}) => ({
  meta: { event_name: event, custom_data: custom },
  data: { type: 'subscriptions', id: '77', attributes: { store_id: 11, product_id: 22, status: 'active', user_email: 'a@example.com', updated_at: '2026-10-12T10:00:00Z', renews_at: '2026-11-12T10:00:00Z', urls: { customer_portal: 'https://shop.lemonsqueezy.com/billing' }, ...attrs } },
});

test('signature, statuses, checkout link', () => {
  const raw = '{"a":1}';
  assert.ok(verifySignature(raw, sign(raw), SECRET));
  assert.ok(!verifySignature(raw, sign('{"a":2}'), SECRET));
  assert.ok(!verifySignature(raw, 'zz', SECRET));
  assert.ok(!verifySignature(raw, sign(raw), ''));
  const now = Date.parse('2026-10-12T00:00:00Z');
  assert.ok(subscriptionActive({ status: 'active' }, now));
  assert.ok(subscriptionActive({ status: 'past_due' }, now));
  assert.ok(subscriptionActive({ status: 'cancelled', endsAt: '2026-10-20T00:00:00Z' }, now));
  assert.ok(!subscriptionActive({ status: 'cancelled', endsAt: '2026-10-01T00:00:00Z' }, now));
  assert.ok(!subscriptionActive({ status: 'expired' }, now));
  assert.ok(!subscriptionActive({ status: 'paused' }, now));
  const url = new URL(checkoutUrlFor('https://shop.lemonsqueezy.com/buy/abc', { email: 'a@example.com', userId: 'u_1' }));
  assert.equal(url.searchParams.get('checkout[email]'), 'a@example.com');
  assert.equal(url.searchParams.get('checkout[custom][user_id]'), 'u_1');
});

test('webhook mapping: custom user id, e-mail fallback, foreign product, out-of-order', () => {
  const acc = new AccountStore(null);
  const a = acc.signup('a@example.com', 'password1');
  const b = acc.signup('b@example.com', 'password2');
  const cfg = { storeId: 11, productId: 22 };
  // Paid with another e-mail, but the checkout link carried B's account id.
  assert.equal(applyWebhook(acc, sub('subscription_created', { user_email: 'other@x.com' }, { user_id: b }), cfg).userId, b);
  assert.equal(acc.user(b).subscription.status, 'active');
  // No custom data: matched by e-mail.
  assert.equal(applyWebhook(acc, sub('subscription_created'), cfg).userId, a);
  assert.equal(applyWebhook(acc, sub('subscription_created', { product_id: 99 }), cfg).reason, 'other store/product');
  assert.equal(applyWebhook(acc, sub('order_created'), cfg).handled, false);
  // Cancel arrives, then an older "active" snapshot: the cancel must win.
  applyWebhook(acc, sub('subscription_cancelled', { status: 'cancelled', ends_at: '2026-11-12T10:00:00Z', updated_at: '2026-10-12T12:00:00Z' }), cfg);
  assert.equal(applyWebhook(acc, sub('subscription_updated', { updated_at: '2026-10-12T11:00:00Z' }), cfg).reason, 'stale');
  assert.equal(acc.user(a).subscription.status, 'cancelled');
  assert.equal(applyWebhook(acc, sub('subscription_created', { user_email: 'nobody@x.com' }), cfg).handled, false);
});

async function boot(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-bill-'));
  const mails = [];
  const app = startHostedServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    serverSecret: 's'.repeat(40),
    licenseConfig: { storeId: 11, productId: 22, checkoutUrl: 'https://shop.lemonsqueezy.com/buy/abc' },
    webhookSecret: SECRET,
    publicUrl: 'https://app.example.com/',
    mailer: { enabled: true, send: async (m) => mails.push(m) },
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    log: () => {},
    authLimit: 50,
    ...extra,
  });
  const port = await app.ready;
  const base = `http://127.0.0.1:${port}`;
  const client = () => {
    let cookie = '';
    return async (path, body, headers = {}) => {
      const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, json: await res.json().catch(() => null) };
    };
  };
  return { app, client, mails, cleanup: async () => (await app.close(), rmSync(dir, { recursive: true, force: true })) };
}

test('web: paying through the checkout link turns Pro on by itself, cancellation keeps it until period end', async (ctx) => {
  let t = Date.parse('2026-10-12T09:00:00Z');
  const h = await boot({ now: () => t });
  ctx.after(() => h.cleanup());
  const a = h.client();
  await a('/auth/signup', { email: 'a@example.com', password: 'password1' });
  const st = (await a('/api/state')).json;
  assert.equal(st.license.plan, 'trial');
  const checkout = new URL(st.license.checkoutUrl);
  const userId = checkout.searchParams.get('checkout[custom][user_id]');
  assert.match(userId, /^u_/);

  const hook = (payload, sig) => {
    const raw = JSON.stringify(payload);
    return h.client()('/webhooks/lemonsqueezy', raw, { 'x-signature': sig ?? sign(raw) });
  };
  assert.equal((await hook(sub('subscription_created', {}, { user_id: userId }), 'deadbeef')).status, 401);
  assert.equal((await hook(sub('subscription_created', {}, { user_id: userId }))).status, 200);
  let lic = (await a('/api/license')).json;
  assert.equal(lic.plan, 'pro');
  assert.equal(lic.subscription.manageUrl, 'https://shop.lemonsqueezy.com/billing');

  // Trial would have ended long ago; a cancelled subscription still runs until ends_at.
  t += 20 * 86400000;
  await hook(sub('subscription_cancelled', { status: 'cancelled', ends_at: new Date(t + 5 * 86400000).toISOString(), updated_at: new Date(t).toISOString() }, { user_id: userId }));
  assert.equal((await a('/api/license')).json.plan, 'pro');
  t += 6 * 86400000;
  assert.equal((await a('/api/license')).json.plan, 'expired');
});

test('web: password reset by e-mail', async (t) => {
  const h = await boot();
  t.after(() => h.cleanup());
  const a = h.client();
  await a('/auth/signup', { email: 'a@example.com', password: 'password1' });
  const other = h.client();
  await other('/auth/login', { email: 'a@example.com', password: 'password1' });

  // Same answer for existing and unknown e-mails; only the real one gets a letter.
  const r1 = await h.client()('/auth/forgot', { email: 'A@example.com' });
  const r2 = await h.client()('/auth/forgot', { email: 'ghost@example.com' });
  assert.deepEqual(r1.json, r2.json);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0].to, 'a@example.com');
  const link = /https:\/\/app\.example\.com\/reset\?token=(\S+)/.exec(h.mails[0].text);
  assert.ok(link, 'link uses PUBLIC_URL, not the request Host');
  const token = decodeURIComponent(link[1]);

  const b = h.client();
  assert.equal((await b('/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await b('/auth/reset', { token, password: 'newpassword1' })).status, 200);
  assert.equal((await b('/api/state')).status, 200); // logged in right away
  assert.equal((await b('/auth/reset', { token, password: 'again12345' })).status, 400); // single use
  assert.equal((await other('/api/state')).status, 401); // old sessions revoked
  assert.equal((await h.client()('/auth/login', { email: 'a@example.com', password: 'password1' })).status, 401);
  assert.equal((await h.client()('/auth/login', { email: 'a@example.com', password: 'newpassword1' })).status, 200);

  // Change password while logged in.
  assert.equal((await b('/auth/change', { current: 'wrong-one', password: 'another123' })).status, 400);
  assert.equal((await b('/auth/change', { current: 'newpassword1', password: 'another123' })).status, 200);

  // Without PUBLIC_URL or a mail provider the feature reports itself as not configured.
  const h2 = await boot({ publicUrl: '' });
  assert.equal((await h2.client()('/auth/forgot', { email: 'a@example.com' })).status, 503);
  await h2.cleanup();
});

test('web: failed logins lock the IP, successful ones do not', async (t) => {
  const h = await boot({ authLimit: 3 });
  t.after(() => h.cleanup());
  await h.client()('/auth/signup', { email: 'a@example.com', password: 'password1' });
  for (let i = 0; i < 5; i++) assert.equal((await h.client()('/auth/login', { email: 'a@example.com', password: 'password1' })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await h.client()('/auth/login', { email: 'a@example.com', password: 'wrong-pass' })).status, 401);
  assert.equal((await h.client()('/auth/login', { email: 'a@example.com', password: 'password1' })).status, 429);
});
