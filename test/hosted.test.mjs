import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { AccountStore, hashPassword, verifyPassword } from '../hosted/accounts.mjs';
import { startHostedServer } from '../hosted/server.mjs';

test('accounts: password hashing, duplicates, sessions with expiry', () => {
  const { salt, hash } = hashPassword('secret123');
  assert.ok(verifyPassword('secret123', salt, hash));
  assert.ok(!verifyPassword('secret124', salt, hash));
  let t = 1000;
  const acc = new AccountStore(null, { now: () => t });
  const id = acc.signup('A@Mail.com', 'password1');
  assert.throws(() => acc.signup('a@mail.com', 'password2'), /уже зарегистрирован/);
  assert.throws(() => acc.signup('bad', 'password2'), /e-mail/);
  assert.throws(() => acc.signup('b@mail.com', 'short'), /8 символов/);
  assert.throws(() => acc.login('a@mail.com', 'wrong-pass'), /Неверный/);
  assert.equal(acc.login(' a@mail.com ', 'password1'), id);
  const s = acc.createSession(id);
  assert.equal(acc.getSession(s), id);
  t += 31 * 86400000;
  assert.equal(acc.getSession(s), null);
  const old = acc.user(id).overlayToken;
  acc.rotateOverlayToken(id);
  assert.equal(acc.userByOverlayToken(old), null);
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-web-'));
  const claude = [];
  const app = startHostedServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    serverSecret: 'x'.repeat(40),
    anthropic: { beta: { messages: { create: async (req) => (claude.push(req), { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Играем в Minecraft!' }] }) } } },
    ai: { model: 'claude-opus-5-5', trialLimit: 1 },
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }), // no outbound network in tests
    log: () => {},
  });
  const port = await app.ready;
  const base = `http://127.0.0.1:${port}`;
  const client = () => {
    let cookie = '';
    const req = async (path, { method = 'GET', body, type = 'application/json' } = {}) => {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': type } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, text, location: res.headers.get('location') };
    };
    return { req, cookie: () => cookie };
  };
  const ws = (query, cookie) =>
    new Promise((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers: cookie ? { cookie } : {} });
      const msgs = [];
      s.on('message', (m) => msgs.push(JSON.parse(m)));
      s.on('open', () => resolve({ s, msgs }));
      s.on('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      s.on('error', reject);
    });
  return { app, base, client, ws, claude, cleanup: async () => (await app.close(), rmSync(dir, { recursive: true, force: true })) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('web version: sign-up, isolated tenants, personal overlays, CSRF, desktop-only features, AI quota', async () => {
  const h = await boot();
  const a = h.client();
  const b = h.client();

  assert.equal((await a.req('/app')).location, '/login');
  assert.equal((await a.req('/api/state')).status, 401);
  assert.equal((await a.req('/auth/signup', { method: 'POST', body: { email: 'alice@example.com', password: 'password1' } })).status, 200);
  assert.equal((await b.req('/auth/signup', { method: 'POST', body: { email: 'bob@example.com', password: 'password2' } })).status, 200);
  assert.equal((await a.req('/app')).status, 200);

  const sa = (await a.req('/api/state')).json;
  const sb = (await b.req('/api/state')).json;
  assert.equal(sa.hosted.email, 'alice@example.com');
  assert.equal(sa.license.plan, 'trial');
  assert.notEqual(sa.hosted.overlayPath, sb.hosted.overlayPath);
  const tokA = sa.hosted.overlayPath.split('/')[2];
  const tokB = sb.hosted.overlayPath.split('/')[2];

  // Overlay pages and sockets work by token only (no login in OBS).
  assert.match((await h.client().req(sa.hosted.overlayPath)).text, /overlay\.js/);
  assert.equal((await h.client().req('/o/not-a-real-token-123/')).status, 404);
  const ovA = await h.ws(`?t=${tokA}`);
  const ovB = await h.ws(`?t=${tokB}`);
  await assert.rejects(h.ws('?t=bogus-token-xyz'), /401/);
  await assert.rejects(h.ws(''), /401/);

  // Alice's gift reaches only Alice's overlay.
  assert.equal((await a.req('/api/simulate', { method: 'POST', body: { type: 'gift', giftName: 'Galaxy', nickname: 'Fan' } })).status, 200);
  await wait(50);
  assert.ok(ovA.msgs.some((m) => m.type === 'alert' && /Fan/.test(m.payload.text)));
  assert.ok(!ovB.msgs.some((m) => m.type === 'alert'));

  // CSRF: non-JSON mutations are refused.
  assert.equal((await a.req('/api/simulate', { method: 'POST', body: 'type=gift', type: 'application/x-www-form-urlencoded' })).status, 415);

  // Things a server can't do on the streamer's PC.
  assert.match((await a.req('/api/keys/test', { method: 'POST', body: { keys: 'space' } })).json.error, /приложении для ПК/);
  assert.match((await a.req('/api/obs/connect', { method: 'POST', body: {} })).json.error, /приложении для ПК/);

  // Browser can't switch AI to another mode/model or enable keyboard.
  const cfg = sa.config;
  cfg.settings.ai = { ...cfg.settings.ai, enabled: true, mode: 'cloud', model: 'claude-fable-5-1' };
  cfg.settings.keyboard.enabled = true;
  await a.req('/api/config', { method: 'PUT', body: { settings: cfg.settings } });
  const after = (await a.req('/api/state')).json.config.settings;
  assert.equal(after.ai.mode, 'own');
  assert.equal(after.keyboard.enabled, false);

  // AI answers via the server's Claude client, with the server's model and the trial quota.
  const r1 = await a.req('/api/ai/ask', { method: 'POST', body: { question: 'Во что играем?' } });
  assert.equal(r1.json.answer, 'Играем в Minecraft!');
  assert.equal(h.claude[0].model, 'claude-opus-5-5');
  const r2 = await a.req('/api/ai/ask', { method: 'POST', body: { question: 'Ещё?' } });
  assert.match(r2.json.error, /Лимит/);

  // Rotating overlay links kills old ones.
  const rot = (await a.req('/api/overlay/rotate', { method: 'POST', body: {} })).json;
  assert.notEqual(rot.overlayPath, sa.hosted.overlayPath);
  assert.equal((await h.client().req(sa.hosted.overlayPath)).status, 404);

  // Logout ends the session.
  await a.req('/auth/logout', { method: 'POST', body: {} });
  assert.equal((await a.req('/api/state')).status, 401);
  const bad = await h.client().req('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'nope-nope' } });
  assert.equal(bad.status, 401);

  ovA.s.close();
  ovB.s.close();
  await h.cleanup();
});
