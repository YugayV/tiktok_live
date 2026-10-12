import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pkceChallenge, sealFlow, openFlow, validateIdToken } from '../hosted/google.mjs';
import { startHostedServer } from '../hosted/server.mjs';

const CLIENT = 'client-123.apps.googleusercontent.com';
const jwt = (claims) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('flow cookie is signed and expires; id token claims are checked', () => {
  const v = sealFlow({ state: 's', nonce: 'n', verifier: 'v' }, 'secret', 1000);
  assert.equal(openFlow(v, 'secret', 2000).state, 's');
  assert.equal(openFlow(v, 'other', 2000), null);
  assert.equal(openFlow(v.replace(/^./, 'x'), 'secret', 2000), null);
  assert.equal(openFlow(v, 'secret', 1000 + 11 * 60 * 1000), null);
  const ok = { iss: 'https://accounts.google.com', aud: CLIENT, exp: 2e9, nonce: 'n', sub: '42', email: 'A@Gmail.com', email_verified: true };
  assert.deepEqual(validateIdToken(ok, { clientId: CLIENT, nonce: 'n', now: 1e12 }), { sub: '42', email: 'a@gmail.com', name: '' });
  for (const bad of [{ iss: 'https://evil.com' }, { aud: 'other' }, { exp: 1 }, { nonce: 'x' }, { email_verified: false }])
    assert.throws(() => validateIdToken({ ...ok, ...bad }, { clientId: CLIENT, nonce: 'n', now: 1e12 }));
});

async function boot({ claims = {}, google = { clientId: CLIENT, clientSecret: 'shh' }, publicUrl = 'https://app.example.com', allowSignup = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-g-'));
  const tokenRequests = [];
  const app = startHostedServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    serverSecret: 'g'.repeat(40),
    publicUrl,
    google,
    allowSignup,
    authLimit: 50,
    fetchImpl: async (url, opts) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = Object.fromEntries(new URLSearchParams(opts.body));
        tokenRequests.push(body);
        if (body.code !== 'good-code') return { ok: false, json: async () => ({ error: 'invalid_grant' }) };
        return { ok: true, json: async () => ({ id_token: jwt({ iss: 'https://accounts.google.com', aud: CLIENT, exp: 2e9, sub: 'g-1', email: 'gamer@gmail.com', email_verified: true, nonce: claims.nonce ?? tokenRequests.nonce, ...claims }) }) };
      }
      return { ok: false, json: async () => ({}) };
    },
    log: () => {},
  });
  const port = await app.ready;
  const base = `http://127.0.0.1:${port}`;
  const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  // Runs the browser side of the flow: /auth/google → (Google) → /auth/google/callback.
  async function signIn({ code = 'good-code', tamperState = false } = {}) {
    const start = await get('/auth/google');
    const loc = new URL(start.headers.get('location'));
    const flowCookie = start.headers.get('set-cookie').split(';')[0];
    const p = loc.searchParams;
    tokenRequests.nonce = p.get('nonce'); // what Google would echo back in the ID token
    const state = tamperState ? 'forged' : p.get('state');
    const cb = await get(`/auth/google/callback?code=${code}&state=${state}`, flowCookie);
    const cookies = cb.headers.getSetCookie();
    const session = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('tl_session='));
    return { start, loc, cb, session, challenge: p.get('code_challenge') };
  }
  const api = (path, session, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { cookie: session, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  return { app, base, get, signIn, api, tokenRequests, cleanup: async () => (await app.close(), rmSync(dir, { recursive: true, force: true })) };
}

test('web: sign in with Google creates a confirmed, password-less account; second sign-in reuses it', async (t) => {
  const h = await boot();
  t.after(() => h.cleanup());
  assert.deepEqual(await (await h.get('/auth/providers')).json(), { google: true, signup: true });

  const r = await h.signIn();
  assert.equal(r.loc.origin + r.loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(r.loc.searchParams.get('redirect_uri'), 'https://app.example.com/auth/google/callback');
  assert.equal(r.loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(r.cb.headers.get('location'), '/app');
  // PKCE: the verifier sent to Google matches the challenge from the first redirect.
  assert.equal(pkceChallenge(h.tokenRequests[0].code_verifier), r.challenge);

  const st = (await h.api('/api/state', r.session)).json;
  assert.equal(st.hosted.email, 'gamer@gmail.com');
  assert.equal(st.hosted.emailVerified, true);
  assert.equal(st.hosted.hasPassword, false);
  assert.equal(st.license.plan, 'trial');

  const again = await h.signIn();
  assert.equal((await h.api('/api/state', again.session)).json.hosted.overlayPath, st.hosted.overlayPath); // same account

  // No password yet → e-mail login fails generically; the user can set one without "current".
  const login = await fetch(h.base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gamer@gmail.com', password: 'whatever1' }) });
  assert.equal(login.status, 401);
  assert.equal((await h.api('/auth/change', r.session, { password: 'mynewpass1' })).status, 200);
  const login2 = await fetch(h.base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gamer@gmail.com', password: 'mynewpass1' }) });
  assert.equal(login2.status, 200);
});

test('web: Google links to an existing e-mail account; forged state, bad code and foreign tokens are refused', async (t) => {
  const h = await boot();
  t.after(() => h.cleanup());
  const su = await fetch(h.base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gamer@gmail.com', password: 'password1' }) });
  const pwSession = su.headers.get('set-cookie').split(';')[0];
  const before = (await h.api('/api/state', pwSession)).json.hosted.overlayPath;

  const forged = await h.signIn({ tamperState: true });
  assert.match(decodeURIComponent(forged.cb.headers.get('location')), /Сессия входа устарела/);
  assert.equal(forged.session, undefined);

  const badCode = await h.signIn({ code: 'stolen' });
  assert.match(decodeURIComponent(badCode.cb.headers.get('location')), /Google отклонил/);

  const linked = await h.signIn();
  const st = (await h.api('/api/state', linked.session)).json;
  assert.equal(st.hosted.overlayPath, before); // same account as the password one
  assert.equal(st.hosted.googleLinked, true);
  assert.equal(st.hosted.hasPassword, true);

  const h2 = await boot({ claims: { aud: 'someone-else' } });
  t.after(() => h2.cleanup());
  assert.match(decodeURIComponent((await h2.signIn()).cb.headers.get('location')), /другому приложению/);
  const h3 = await boot({ claims: { email_verified: false } });
  t.after(() => h3.cleanup());
  assert.match(decodeURIComponent((await h3.signIn()).cb.headers.get('location')), /не подтверждён/);
});

test('web: Google disabled without credentials; closed sign-up blocks new Google accounts', async (t) => {
  const h = await boot({ google: {} });
  t.after(() => h.cleanup());
  assert.equal((await (await h.get('/auth/providers')).json()).google, false);
  assert.match(decodeURIComponent((await h.get('/auth/google')).headers.get('location')), /не настроен/);
  const h2 = await boot({ allowSignup: false });
  t.after(() => h2.cleanup());
  assert.match(decodeURIComponent((await h2.signIn()).cb.headers.get('location')), /Регистрация закрыта/);
});
