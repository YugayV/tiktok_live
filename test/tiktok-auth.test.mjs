import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHostedServer } from '../hosted/server.mjs';

async function boot({ tiktok = { clientKey: 'awkey', clientSecret: 'shh' }, profile = {}, scope = 'user.info.basic,user.info.profile', allowSignup = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-tt-'));
  const calls = [];
  const app = startHostedServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    serverSecret: 't'.repeat(40),
    publicUrl: 'https://app.example.com',
    tiktok,
    allowSignup,
    authLimit: 50,
    fetchImpl: async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url === 'https://open.tiktokapis.com/v2/oauth/token/') {
        const b = Object.fromEntries(new URLSearchParams(opts.body));
        if (b.code !== 'good') return { ok: false, json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }) };
        return { ok: true, json: async () => ({ access_token: 'act.1', open_id: profile.open_id || 'oid-1', scope, expires_in: 86400 }) };
      }
      if (String(url).startsWith('https://open.tiktokapis.com/v2/user/info/')) {
        return { ok: true, json: async () => ({ data: { user: { open_id: 'oid-1', union_id: 'un-1', display_name: 'Стример', avatar_url: 'https://p16.tiktokcdn.com/a.jpg', username: 'cool_streamer', ...profile } }, error: { code: 'ok' } }) };
      }
      return { ok: false, json: async () => ({}) };
    },
    log: () => {},
  });
  const port = await app.ready;
  const base = `http://127.0.0.1:${port}`;
  const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  async function go({ code = 'good', forge = false, session, link = false } = {}) {
    const start = await get(link ? '/auth/tiktok?link=1' : '/auth/tiktok', session);
    const loc = new URL(start.headers.get('location'));
    const flowCookie = start.headers.get('set-cookie').split(';')[0];
    const cookie = [flowCookie, session].filter(Boolean).join('; ');
    const cb = await get(`/auth/tiktok/callback?code=${code}&state=${forge ? 'x' : loc.searchParams.get('state')}`, cookie);
    const sess = cb.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('tl_session='));
    return { loc, cb, session: sess, where: decodeURIComponent(cb.headers.get('location') || '') };
  }
  const api = (path, session, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { cookie: session, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  return { base, get, go, api, calls, cleanup: async () => (await app.close(), rmSync(dir, { recursive: true, force: true })) };
}

test('web: Continue with TikTok creates an account keyed by open_id and pre-fills the LIVE @username', async (t) => {
  const h = await boot();
  t.after(() => h.cleanup());
  assert.equal((await (await h.get('/auth/providers')).json()).tiktok, true);
  const r = await h.go();
  assert.equal(r.loc.origin + r.loc.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(r.loc.searchParams.get('client_key'), 'awkey');
  assert.equal(r.loc.searchParams.get('redirect_uri'), 'https://app.example.com/auth/tiktok/callback');
  assert.equal(r.where, '/app');
  const tokenCall = h.calls.find((c) => c.url.includes('/oauth/token/'));
  assert.equal(Object.fromEntries(new URLSearchParams(tokenCall.opts.body)).client_secret, 'shh');
  assert.match(h.calls.find((c) => c.url.includes('/user/info/')).url, /fields=.*username/);

  const st = (await h.api('/api/state', r.session)).json;
  assert.equal(st.hosted.label, '@cool_streamer');
  assert.equal(st.hosted.email, null);
  assert.equal(st.hosted.emailVerified, true);
  assert.equal(st.config.settings.username, 'cool_streamer'); // ready to connect, nothing to type
  assert.equal(st.license.plan, 'trial');

  // Second sign-in → same account; no password for e-mail-less accounts.
  const again = await h.go();
  assert.equal((await h.api('/api/state', again.session)).json.hosted.overlayPath, st.hosted.overlayPath);
  assert.match((await h.api('/auth/change', r.session, { password: 'whatever12' })).json.error, /TikTok/);
});

test('web: link TikTok to an e-mail account; one TikTok cannot belong to two accounts; bad flows are refused', async (t) => {
  const h = await boot();
  t.after(() => h.cleanup());
  const su = await fetch(h.base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'me@example.com', password: 'password1' }) });
  const mine = su.headers.get('set-cookie').split(';')[0];
  const linked = await h.go({ session: mine, link: true });
  assert.equal(linked.where, '/app?linked=tiktok');
  const st = (await h.api('/api/state', mine)).json;
  assert.equal(st.hosted.tiktok.username, 'cool_streamer');
  assert.equal(st.hosted.email, 'me@example.com');
  assert.equal(st.config.settings.username, 'cool_streamer');
  // Signing in with TikTok now opens the same e-mail account.
  const viaTikTok = await h.go();
  assert.equal((await h.api('/api/state', viaTikTok.session)).json.hosted.overlayPath, st.hosted.overlayPath);

  const su2 = await fetch(h.base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'other@example.com', password: 'password2' }) });
  const other = su2.headers.get('set-cookie').split(';')[0];
  assert.match((await h.go({ session: other, link: true })).where, /уже привязан/);

  assert.match((await h.go({ forge: true })).where, /Сессия входа устарела/);
  assert.match((await h.go({ code: 'stolen' })).where, /TikTok отклонил/);
});

test('web: TikTok disabled without credentials; closed sign-up; basic scope works without username', async (t) => {
  const h = await boot({ tiktok: {} });
  t.after(() => h.cleanup());
  assert.equal((await (await h.get('/auth/providers')).json()).tiktok, false);
  assert.match(decodeURIComponent((await h.get('/auth/tiktok')).headers.get('location')), /не настроен/);
  const h2 = await boot({ allowSignup: false });
  t.after(() => h2.cleanup());
  assert.match((await h2.go()).where, /Регистрация закрыта/);
  const h3 = await boot({ scope: 'user.info.basic', profile: { username: undefined } });
  t.after(() => h3.cleanup());
  const r = await h3.go();
  assert.doesNotMatch(h3.calls.find((c) => c.url.includes('/user/info/')).url, /username/);
  const st = (await h3.api('/api/state', r.session)).json;
  assert.equal(st.hosted.label, 'Стример'); // display name when there is no @username
  assert.equal(st.config.settings.username, '');
});
