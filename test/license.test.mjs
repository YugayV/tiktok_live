import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { License } from '../src/license.mjs';
import { Studio } from '../src/studio.mjs';
import { normalize } from '../src/normalize.mjs';

const DAY = 86400000;
const secret = Buffer.from('test-secret');
const config = { storeId: 11, productId: 22 };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-lic-'));
  let t = Date.UTC(2026, 9, 1);
  const clock = { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
  const replies = [];
  const requests = [];
  const fetchImpl = async (url, opts) => {
    requests.push({ url, body: Object.fromEntries(new URLSearchParams(opts.body)) });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, json: async () => r.data };
  };
  const make = () => new License({ file: join(dir, 'license.json'), backupFile: join(dir, 'backup.json'), config, fetchImpl, now: clock.now, secret, instanceName: 'pc' });
  return { dir, clock, replies, requests, make, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const meta = { store_id: 11, product_id: 22, customer_email: 'a@b.c' };

test('trial lasts 7 days, then Pro features lock but free ones stay', () => {
  const { clock, make, cleanup } = setup();
  const lic = make();
  assert.equal(lic.status().plan, 'trial');
  assert.equal(lic.status().trialDaysLeft, 7);
  assert.ok(lic.can('ai'));
  clock.advance(7 * DAY + 1);
  assert.equal(lic.status().plan, 'expired');
  assert.equal(lic.can('ai'), false);
  assert.equal(lic.can('alerts'), true);
  cleanup();
});

test('trial survives reinstall, resists tampering and clock rollback', () => {
  const { dir, clock, make, cleanup } = setup();
  const start = clock.now();
  make();
  clock.advance(3 * DAY);
  make();
  // Deleting the app data keeps the original start via the backup copy.
  rmSync(join(dir, 'license.json'));
  assert.equal(make().state.trialStartedAt, start);
  // Editing the signed file ends the trial instead of restarting it.
  const f = join(dir, 'license.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  j.body.trialStartedAt = clock.now();
  writeFileSync(f, JSON.stringify(j));
  assert.equal(make().status().plan, 'expired');
  cleanup();

  const s2 = setup();
  s2.make();
  s2.clock.advance(8 * DAY);
  s2.make(); // records lastSeenAt
  s2.clock.advance(-5 * DAY); // user winds the clock back
  assert.equal(s2.make().status().plan, 'expired');
  s2.cleanup();
});

test('activation checks store/product, validation and offline grace', async () => {
  const { clock, replies, requests, make, cleanup } = setup();
  const lic = make();
  clock.advance(10 * DAY); // trial over

  replies.push({ data: { activated: true, instance: { id: 'i1' }, license_key: { status: 'active' }, meta: { ...meta, store_id: 99 } } });
  await assert.rejects(lic.activate('ABCD-1234-EFGH'), /не для TikLive Pro/);
  assert.equal(lic.status().plan, 'expired');

  replies.push({ ok: false, data: { activated: false, error: 'license_key not found.' } });
  await assert.rejects(lic.activate('ABCD-1234-EFGH'), /not found/);

  replies.push({ data: { activated: true, instance: { id: 'i1' }, license_key: { status: 'active', expires_at: null }, meta } });
  const st = await lic.activate('ABCD-1234-EFGH');
  assert.equal(st.plan, 'pro');
  assert.equal(st.key, 'ABCD…EFGH');
  assert.deepEqual(requests.at(-1).body, { license_key: 'ABCD-1234-EFGH', instance_name: 'pc' });
  assert.ok(requests.at(-1).url.endsWith('/v1/licenses/activate'));

  // Survives restart.
  assert.equal(make().status().plan, 'pro');

  // Offline: keeps Pro during the grace period, then locks.
  clock.advance(3 * DAY);
  replies.push(new Error('offline'));
  assert.equal((await lic.validate()).plan, 'pro');
  clock.advance(5 * DAY);
  replies.push(new Error('offline'));
  assert.equal((await lic.validate()).plan, 'expired');

  // Back online and still paid.
  replies.push({ data: { valid: true, license_key: { status: 'active' }, meta } });
  assert.equal((await lic.validate()).plan, 'pro');
  assert.deepEqual(requests.at(-1).body, { license_key: 'ABCD-1234-EFGH', instance_id: 'i1' });

  // Subscription cancelled → key expires.
  replies.push({ data: { valid: false, error: null, license_key: { status: 'expired' }, meta } });
  assert.equal((await lic.validate()).plan, 'expired');

  replies.push({ data: { deactivated: true } });
  const d = await lic.deactivate();
  assert.equal(d.key, '');
  assert.ok(requests.at(-1).url.endsWith('/deactivate'));
  cleanup();
});

test('studio locks Pro features after the trial', async () => {
  const { clock, make, cleanup } = setup();
  const license = make();
  clock.advance(8 * DAY);
  const pressed = [];
  const sent = [];
  const studio = new Studio({ license, broadcast: (type, payload) => sent.push({ type, payload }), keyDriver: { name: 'f', down: (k) => pressed.push(k), up: () => {} } });
  studio.cfg.settings.keyboard.enabled = true;
  studio.cfg.rules.push({ id: 'k', trigger: { type: 'follow' }, actions: [{ type: 'keys', keys: 'space' }] });
  studio.handleEvent(normalize('follow', { user: { uniqueId: 'a', nickname: 'A' } }));
  studio.handleEvent(normalize('chat', { user: { uniqueId: 'a', nickname: 'A' }, comment: '!sr Believer' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(pressed, []);
  assert.equal(studio.songs.current, null);
  assert.ok(sent.some((m) => m.type === 'alert')); // free features keep working
  assert.throws(() => studio.spinWheel(), (e) => e.status === 402);
  assert.equal(studio.state().license.plan, 'expired');
  await studio.shutdown();
  cleanup();
});
