import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { giftFx, soundUrl, SOUNDS, DEFAULT_GIFT_FX } from '../src/gift-fx.mjs';
import { Studio } from '../src/studio.mjs';
import { startServer } from '../src/server-app.mjs';

const gift = (giftName, diamonds, count = 1) => ({ type: 'gift', giftName, giftId: 1, diamonds, totalDiamonds: diamonds * count });

test('gift value picks the tier; per-gift settings override it', () => {
  assert.deepEqual(giftFx(gift('Rose', 1)), { sound: '/sounds/coin.mp3', effect: 'none', animation: 'pop', video: '', volume: 0.8 });
  assert.equal(giftFx(gift('Doughnut', 30)).effect, 'hearts');
  assert.equal(giftFx(gift('Rose', 1, 150)).effect, 'confetti'); // a 150-rose combo counts as 150💎
  assert.equal(giftFx(gift('Galaxy', 1000)).effect, 'fireworks');
  const cfg = { ...DEFAULT_GIFT_FX, gifts: [{ gift: 'rose', sound: 'heart', effect: 'hearts', animation: '', video: 'media/0123456789abcdef.mp4' }] };
  const r = giftFx(gift('Rose', 1), cfg);
  assert.equal(r.sound, '/sounds/heart.mp3');
  assert.equal(r.effect, 'hearts');
  assert.equal(r.animation, 'pop'); // empty → from the tier
  assert.equal(r.video, 'media/0123456789abcdef.mp4');
  assert.equal(giftFx(gift('Rose', 1), { ...cfg, enabled: false }), null);
  assert.equal(giftFx({ type: 'follow' }), null);
});

test('only built-in, uploaded or https sounds are allowed', () => {
  assert.equal(soundUrl('fanfare'), '/sounds/fanfare.mp3');
  assert.equal(soundUrl('media/0123456789abcdef.mp3'), 'media/0123456789abcdef.mp3');
  assert.equal(soundUrl('https://x.com/a.mp3'), 'https://x.com/a.mp3');
  for (const bad of ['javascript:x', 'http://x.com/a.mp3', '/sounds/../../x', 'media/../a.mp3']) assert.equal(soundUrl(bad), '');
  for (const [name] of SOUNDS) assert.ok(statSync(new URL(`../public/sounds/${name}.mp3`, import.meta.url)).size > 1000, name);
});

test('gift alerts carry sound, effect and animation; rule settings win', async () => {
  const sent = [];
  const studio = new Studio({ broadcast: (type, payload) => sent.push({ type, payload }) });
  studio.simulate('gift', { diamonds: 1000, count: 1 });
  const big = sent.find((m) => m.type === 'alert').payload;
  assert.equal(big.sound, '/sounds/tada.mp3');
  assert.equal(big.effect, 'fireworks');
  assert.equal(big.animation, 'shake');
  // A rule with its own sound/effect keeps them.
  const alert = studio.cfg.rules.find((r) => r.id === 'r-gift-big').actions[0];
  Object.assign(alert, { sound: 'horn', effect: 'diamonds', animation: 'flip' });
  studio.queue.clear();
  sent.length = 0;
  studio.simulate('gift', { diamonds: 500, count: 1 });
  studio.queue.skip(); // finish the 1000💎 alert so the new one plays
  const own = sent.find((m) => m.type === 'alert').payload;
  assert.deepEqual([own.sound, own.effect, own.animation], ['/sounds/horn.mp3', 'diamonds', 'flip']);
  assert.ok(studio.seenGifts.size >= 1);
  await studio.shutdown();
});

test('built-in sounds are served to the app and overlays', async () => {
  const app = startServer({ port: 0, log: () => {} });
  const base = await app.ready;
  const r = await fetch(`${base}/sounds/coin.mp3`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  await app.close();
});
