import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CloudService } from '../cloud/service.mjs';
import { AiResponder, DEFAULT_AI } from '../src/ai.mjs';

const DAY = 86400000;
const meta = { store_id: 11, product_id: 22 };

function setup(config = {}, { reply = 'Сегодня Minecraft!' } = {}) {
  let t = Date.UTC(2026, 9, 10);
  const lsCalls = [];
  const claudeCalls = [];
  let lsReply = { valid: true, license_key: { status: 'active' }, meta };
  let claudeFails = false;
  const service = new CloudService({
    anthropic: {
      beta: {
        messages: {
          create: async (req) => {
            claudeCalls.push(req);
            if (claudeFails) throw Object.assign(new Error('overloaded'), { status: 529 });
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] };
          },
        },
      },
    },
    fetchImpl: async (url, opts) => {
      lsCalls.push(Object.fromEntries(new URLSearchParams(opts.body)));
      if (lsReply instanceof Error) throw lsReply;
      return { ok: true, json: async () => lsReply };
    },
    now: () => t,
    config: { storeId: 11, productId: 22, ...config },
    log: () => {},
  });
  return {
    service,
    lsCalls,
    claudeCalls,
    advance: (ms) => (t += ms),
    setLs: (r) => (lsReply = r),
    failClaude: (v) => (claudeFails = v),
  };
}

const pro = { authorization: 'Bearer KEY-1234-5678', ip: '1.1.1.1' };
const q = (extra = {}) => ({ question: 'Во что играем?', nickname: 'Alice', persona: 'Ты бот стримера', streamInfo: 'Minecraft', ...extra });

test('pro: validates the key once (cached), answers with the server model, counts usage', async () => {
  const s = setup({ model: 'claude-opus-5-5' });
  const r = await s.service.answer(q(), pro);
  assert.equal(r.status, 200);
  assert.equal(r.body.answer, 'Сегодня Minecraft!');
  assert.deepEqual(r.body.quota, { plan: 'pro', used: 1, limit: 500 });
  assert.equal(s.claudeCalls[0].model, 'claude-opus-5-5');
  assert.match(s.claudeCalls[0].system, /Ты бот стримера[\s\S]*Minecraft/);
  await s.service.answer(q(), pro);
  assert.equal(s.lsCalls.length, 1); // cached
  assert.equal(s.lsCalls[0].license_key, 'KEY-1234-5678');
});

test('pro: rejects foreign, expired and invalid keys', async () => {
  const s = setup();
  s.setLs({ valid: true, license_key: { status: 'active' }, meta: { store_id: 11, product_id: 99 } });
  assert.equal((await s.service.answer(q(), pro)).status, 402);
  const s2 = setup();
  s2.setLs({ valid: true, license_key: { status: 'expired' }, meta });
  assert.match((await s2.service.answer(q(), pro)).body.error, /не активна/);
  const s3 = setup();
  s3.setLs({ valid: false, error: 'license_key not found.' });
  assert.equal((await s3.service.answer(q(), pro)).status, 402);
  assert.equal(s3.claudeCalls.length, 0);
});

test('pro: monthly quota with reset, per-minute limit', async () => {
  const s = setup({ proMonthlyLimit: 2, perMinute: 100 });
  await s.service.answer(q(), pro);
  await s.service.answer(q(), pro);
  const r = await s.service.answer(q(), pro);
  assert.equal(r.status, 429);
  assert.equal(r.body.quota.used, 2);
  s.advance(31 * DAY);
  assert.equal((await s.service.answer(q(), pro)).status, 200);

  const s2 = setup({ perMinute: 2 });
  await s2.service.answer(q(), pro);
  await s2.service.answer(q(), pro);
  assert.equal((await s2.service.answer(q(), pro)).status, 429);
  s2.advance(61000);
  assert.equal((await s2.service.answer(q(), pro)).status, 200);
});

test('trial: by device id, limited in days, answers and new trials per IP', async () => {
  const s = setup({ trialLimit: 2, trialsPerIp: 2, perMinute: 100 });
  const dev = (d) => q({ deviceId: d.padEnd(20, '0') });
  const ip = { ip: '2.2.2.2' };
  assert.equal((await s.service.answer(q(), ip)).status, 402); // no device id
  assert.equal((await s.service.answer(dev('a'), ip)).status, 200);
  assert.equal((await s.service.answer(dev('a'), ip)).body.quota.used, 2);
  assert.equal((await s.service.answer(dev('a'), ip)).status, 429);
  assert.equal((await s.service.answer(dev('b'), ip)).status, 200);
  assert.match((await s.service.answer(dev('c'), ip)).body.error, /уже использован/); // 3rd device, same IP
  s.advance(8 * DAY);
  assert.match((await s.service.answer(dev('b'), ip)).body.error, /закончился/);
});

test('failures: Claude error counts and returns 502; license server down fails closed unless cached', async () => {
  const s = setup();
  s.failClaude(true);
  const r = await s.service.answer(q(), pro);
  assert.equal(r.status, 502);
  assert.equal(r.body.quota.used, 1);

  const s2 = setup();
  s2.setLs(new Error('ECONNRESET'));
  assert.equal((await s2.service.answer(q(), pro)).status, 503);

  const s3 = setup({ licenseCacheMs: 1000 });
  await s3.service.answer(q(), pro);
  s3.advance(5000);
  s3.setLs(new Error('ECONNRESET'));
  assert.equal((await s3.service.answer(q(), pro)).status, 200); // recent positive answer is trusted
});

test('end to end: desktop app (cloud mode) → HTTP → cloud service', async () => {
  const s = setup();
  const http = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const out = await s.service.answer(JSON.parse(raw), { authorization: req.headers.authorization, ip: '3.3.3.3' });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${http.address().port}`;
  const cfg = { ...DEFAULT_AI, enabled: true };
  let creds = { url, licenseKey: 'KEY-1234-5678', instanceId: 'inst', deviceId: 'd'.repeat(40) };
  const ai = new AiResponder({ getConfig: () => cfg, getCloud: () => creds });
  assert.equal(await ai.ask('Во что играем?', { nickname: 'Alice' }), 'Сегодня Minecraft!');
  assert.deepEqual(ai.quota, { plan: 'pro', used: 1, limit: 500 });
  assert.equal(s.lsCalls[0].instance_id, 'inst');

  s.setLs({ valid: false, error: 'expired' });
  s.service.licenseCache.clear();
  await assert.rejects(ai.ask('ещё?', { nickname: 'Alice' }), (e) => e.status === 402 && /TikLive Pro/.test(e.message));

  creds = { url, licenseKey: '', deviceId: 'd'.repeat(40) }; // trial user
  assert.equal(await ai.ask('привет', { nickname: 'Bob' }), 'Сегодня Minecraft!');
  assert.equal(ai.quota.plan, 'trial');
  http.close();
});
