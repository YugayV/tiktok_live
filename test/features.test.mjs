import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.mjs';
import { SongQueue, youtubeId, DEFAULT_SONGS } from '../src/songs.mjs';
import { KeyController, parseKeys } from '../src/keyboard.mjs';
import { AiResponder, DEFAULT_AI } from '../src/ai.mjs';
import { Studio } from '../src/studio.mjs';

const alice = { uniqueId: 'alice', nickname: 'Alice' };
const bob = { uniqueId: 'bob', nickname: 'Bob' };

test('youtube id extraction', () => {
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=3', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://music.youtube.com/watch?list=x&v=dQw4w9WgXcQ'])
    assert.equal(youtubeId(url), 'dQw4w9WgXcQ', url);
  assert.equal(youtubeId('Believer'), '');
});

test('song queue: limits, duplicates, priority bump, next', () => {
  const q = new SongQueue({ getConfig: () => ({ ...DEFAULT_SONGS, maxPerUser: 2 }) });
  assert.ok(q.request(alice, 'Song A').ok);
  assert.ok(q.request(alice, 'Song B').ok);
  assert.match(q.request(alice, 'Song C').error, /не больше 2/);
  assert.match(q.request(bob, 'song a').error, /уже в очереди/);
  assert.ok(q.request(bob, 'Song D').ok);
  q.bump('bob', 1);
  assert.equal(q.next().query, 'Song D');
  assert.equal(q.removeLastOf('alice').query, 'Song B');
  assert.equal(q.next().query, 'Song A');
  assert.equal(q.next(), null);
  const yt = new SongQueue({ getConfig: () => ({ ...DEFAULT_SONGS, youtubeOnly: true }) });
  assert.match(yt.request(alice, 'no link').error, /YouTube/);
});

test('parseKeys', () => {
  assert.deepEqual(parseKeys('w'), [['w']]);
  assert.deepEqual(parseKeys('Ctrl+Shift+A, space'), [['ctrl', 'shift', 'a'], ['space']]);
  assert.deepEqual(parseKeys('↑ esc lclick'), [['up'], ['escape'], ['lmb']]);
  assert.throws(() => parseKeys('ctrl+banana'), /banana/);
  assert.throws(() => parseKeys(''), /Не указаны/);
});

function fakeKeys(cfg = {}) {
  const log = [];
  let t = 0;
  const kc = new KeyController({
    driver: { name: 'fake', down: (k) => log.push(`+${k}`), up: (k) => log.push(`-${k}`) },
    getConfig: () => ({ enabled: true, maxStepsPerSec: 100, maxQueue: 30, maxHoldMs: 10000, ...cfg }),
    sleepFn: async (ms) => {
      t += ms;
      await null;
    },
    now: () => t,
  });
  return { kc, log, idle: async () => { while (kc.running) await new Promise((r) => setImmediate(r)); } };
}

test('key controller presses combos in order and respects disabled/queue limits', async () => {
  const { kc, log, idle } = fakeKeys();
  assert.equal(kc.enqueue({ keys: 'ctrl+a, b', repeat: 2 }), 4);
  await idle();
  assert.deepEqual(log, ['+ctrl', '+a', '-a', '-ctrl', '+b', '-b', '+ctrl', '+a', '-a', '-ctrl', '+b', '-b']);
  assert.equal(fakeKeys({ maxQueue: 3 }).kc.enqueue({ keys: 'a', repeat: 10 }), 3);
  assert.equal(fakeKeys({ enabled: false }).kc.enqueue({ keys: 'a' }), 0);
});

test('key controller emergency stop releases held keys', async () => {
  const log = [];
  let release;
  const kc = new KeyController({
    driver: { name: 'fake', down: (k) => log.push(`+${k}`), up: (k) => log.push(`-${k}`) },
    getConfig: () => ({ enabled: true, maxStepsPerSec: 100, maxQueue: 30, maxHoldMs: 10000 }),
    sleepFn: (ms) => (ms > 1000 ? new Promise((r) => (release = r)) : Promise.resolve()),
  });
  kc.enqueue({ keys: 'w', holdMs: 5000, repeat: 3 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(kc.snapshot().held, ['w']);
  await kc.stop();
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['+w', '-w']); // released once by stop, queue dropped
  assert.equal(kc.snapshot().queued, 0);
});

function fakeAiClient(reply = 'Играем в Minecraft!', stop = 'end_turn') {
  const calls = [];
  const client = { beta: { messages: { create: async (req) => (calls.push(req), { stop_reason: stop, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: reply }] }) } } };
  return { calls, create: () => client };
}

test('ai responder: request shape, truncation, refusal, disabled, rate limit', async () => {
  const fake = fakeAiClient('x'.repeat(500));
  const cfg = { ...DEFAULT_AI, mode: 'own', enabled: true, maxAnswerChars: 50, maxPerMinute: 2, streamInfo: 'Minecraft' };
  const ai = new AiResponder({ getConfig: () => cfg, createClient: fake.create });
  const a = await ai.ask('Во что играем?', alice);
  assert.equal(a.length, 50);
  assert.ok(a.endsWith('…'));
  const req = fake.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.match(req.system, /Minecraft/);
  assert.match(req.messages[0].content, /Alice спрашивает: Во что играем\?/);

  await ai.ask('2', alice);
  assert.equal(await ai.ask('3', alice), null); // 2 per minute
  assert.equal(fake.calls.length, 2);

  const refused = new AiResponder({ getConfig: () => ({ ...cfg, maxPerMinute: 9 }), createClient: fakeAiClient('no', 'refusal').create });
  assert.equal(await refused.ask('?', alice), null);
  const off = new AiResponder({ getConfig: () => ({ ...cfg, enabled: false }), createClient: fake.create });
  assert.equal(await off.ask('?', alice), null);
});

test('studio: !sr starts playback, !ai answers via alert + broadcast, keys action presses', async () => {
  const sent = [];
  const pressed = [];
  const fake = fakeAiClient('Сегодня Minecraft!');
  const studio = new Studio({
    broadcast: (type, payload) => sent.push({ type, payload }),
    createAiClient: fake.create,
    keyDriver: { name: 'fake', down: (k) => pressed.push(k), up: () => {} },
  });
  studio.cfg.settings.ai.enabled = true;
  studio.cfg.settings.ai.mode = 'own';
  studio.cfg.settings.keyboard.enabled = true;

  studio.handleEvent(normalize('chat', { user: alice, comment: '!sr https://youtu.be/dQw4w9WgXcQ' }));
  assert.equal(studio.songs.current.videoId, 'dQw4w9WgXcQ');
  studio.handleEvent(normalize('chat', { user: bob, comment: '!sr Believer' }));
  assert.equal(studio.songs.snapshot().queue[0].query, 'Believer');

  studio.handleEvent(normalize('chat', { user: alice, comment: '!ai во что играем?' }));
  await new Promise((r) => setTimeout(r, 10));
  const ai = sent.find((m) => m.type === 'ai');
  assert.equal(ai.payload.answer, 'Сегодня Minecraft!');
  assert.equal(fake.calls[0].messages[0].content, 'Зритель Alice спрашивает: во что играем?');

  studio.cfg.rules.push({ id: 'k', trigger: { type: 'gift', giftName: 'Rose' }, repeat: 'perCount', actions: [{ type: 'keys', keys: 'space', holdMs: 20, intervalMs: 0 }] });
  studio.handleEvent(normalize('gift', { user: bob, repeatCount: 3, repeatEnd: 1, giftDetails: { giftName: 'Rose', diamondCount: 1, giftType: 1 } }));
  while (studio.keys.running) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(pressed, ['space', 'space', 'space']);
  await studio.shutdown();
});
