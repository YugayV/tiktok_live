import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.mjs';
import { RuleEngine } from '../src/rules.mjs';
import { AlertQueue } from '../src/queue.mjs';
import { SessionStats, applyGoals, pointsFor } from '../src/stats.mjs';
import { render } from '../src/template.mjs';
import { Poll, GiftBattle, pickWeighted } from '../src/games.mjs';
import { obsAuth } from '../src/obs.mjs';
import { Studio } from '../src/studio.mjs';

const user = { uniqueId: 'alice', nickname: 'Alice' };
const gift = (name, diamonds, count = 1, extra = {}) =>
  normalize('gift', { user, giftId: name, repeatCount: count, repeatEnd: 1, giftDetails: { giftName: name, diamondCount: diamonds, giftType: 1 }, ...extra });

test('normalize handles proto v2 and v3 field names', () => {
  const v2 = gift('Rose', 1, 5);
  assert.equal(v2.giftName, 'Rose');
  assert.equal(v2.totalDiamonds, 5);
  assert.equal(v2.streaking, false);

  const v3 = normalize('gift', { user: { displayId: 'bob', nickname: 'Bob', avatarThumb: { urlList: ['a.png'] } }, repeatCount: 2, repeatEnd: 0, gift: { name: 'Rose', diamondCount: 1, type: 1 } });
  assert.equal(v3.user.uniqueId, 'bob');
  assert.equal(v3.user.avatar, 'a.png');
  assert.equal(v3.streaking, true);

  assert.equal(normalize('chat', { user, content: 'hi' }).text, 'hi');
  assert.equal(normalize('like', { user, count: 7, total: '100' }).likes, 7);
});

test('rule engine: gift filters, streak skip, perCount repeat', () => {
  const e = new RuleEngine();
  const rules = [{ id: 'r', trigger: { type: 'gift', giftName: 'rose, galaxy', minDiamonds: 3 }, repeat: 'perCount', actions: [] }];
  assert.equal(e.evaluate(gift('Rose', 1, 2), rules).length, 0); // below min diamonds
  assert.equal(e.evaluate(gift('Lion', 100), rules).length, 0); // wrong gift
  const [m] = e.evaluate(gift('Rose', 1, 4), rules);
  assert.equal(m.times, 4);
  const streak = normalize('gift', { user, repeatCount: 9, repeatEnd: 0, giftDetails: { giftName: 'Rose', diamondCount: 1, giftType: 1 } });
  assert.equal(e.evaluate(streak, rules).length, 0);
});

test('rule engine: chat commands set args, cooldowns, points cost', () => {
  let t = 0;
  const e = new RuleEngine({ now: () => t });
  const rules = [{ id: 'tts', trigger: { type: 'chat', command: '!tts,!say' }, cooldown: { perUser: 10 }, cost: 50, actions: [] }];
  const chat = (text) => normalize('chat', { user, comment: text });
  assert.equal(e.evaluate(chat('!ttsx no'), rules, { getPoints: () => 100 }).length, 0);
  const [m] = e.evaluate(chat('!say Hello there'), rules, { getPoints: () => 100 });
  assert.equal(m.ev.args, 'Hello there');
  assert.equal(e.evaluate(chat('!tts again'), rules, { getPoints: () => 100 }).length, 0); // cooldown
  t = 11000;
  assert.equal(e.evaluate(chat('!tts again'), rules, { getPoints: () => 10 })[0].denied, 'points');
});

test('rule engine: likeEvery accumulates across events and priority ordering', () => {
  const e = new RuleEngine();
  const rules = [
    { id: 'low', priority: 0, trigger: { type: 'like', likeEvery: 100 }, actions: [] },
    { id: 'high', priority: 5, trigger: { type: 'any' }, actions: [] },
  ];
  const like = (n) => normalize('like', { user, likeCount: n });
  assert.deepEqual(e.evaluate(like(60), rules).map((m) => m.rule.id), ['high']);
  const res = e.evaluate(like(150), rules);
  assert.deepEqual(res.map((m) => m.rule.id), ['high', 'low']);
  assert.equal(res[1].times, 2);
});

test('alert queue: priority, merge, pacing', () => {
  const played = [];
  const timers = [];
  const q = new AlertQueue({ onPlay: (a) => played.push(a.text), setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
  q.push({ text: 'first' });
  q.push({ text: 'low', priority: 0 });
  q.push({ text: 'rose', mergeKey: 'k' });
  q.push({ text: 'rose2', mergeKey: 'k' });
  q.push({ text: 'big', priority: 10 });
  assert.deepEqual(played, ['first']);
  timers.shift()();
  assert.equal(played.at(-1), 'big');
  timers.shift()();
  timers.shift()();
  assert.deepEqual(played, ['first', 'big', 'low', 'rose2']);
  assert.equal(q.current.count, 2);
});

test('stats, goals and points', () => {
  const s = new SessionStats();
  s.record(gift('Galaxy', 1000));
  s.record(normalize('like', { user, likeCount: 30 }));
  s.record(normalize('roomUser', { viewerCount: 42 }));
  assert.equal(s.totals.diamonds, 1000);
  assert.equal(s.peakViewers, 42);
  assert.equal(s.top('diamonds')[0].uniqueId, 'alice');
  assert.match(s.toCSV(), /"alice","Alice","1000"/);

  const goals = [{ id: 'g', metric: 'diamonds', current: 900, target: 1000 }];
  assert.equal(applyGoals(goals, gift('Rose', 1, 50)).length, 0);
  assert.equal(applyGoals(goals, gift('Lion', 60)).length, 1);
  assert.equal(applyGoals(goals, gift('Lion', 60)).length, 0); // only fires when crossing
  assert.equal(pointsFor(gift('Rose', 1, 3)), 30);
});

test('template rendering', () => {
  assert.equal(render('{nickname} sent {giftName} x{count} {unknown}', gift('Rose', 1, 3)), 'Alice sent Rose x3 {unknown}');
});

test('games: weighted pick, poll, battle', () => {
  assert.equal(pickWeighted([{ weight: 0 }, { weight: 1 }], () => 0.5), 1);
  const p = new Poll({ question: 'q', options: ['A', 'B'] });
  assert.ok(p.vote(user, '2'));
  assert.ok(p.vote(user, '!vote 1')); // re-vote moves the vote
  assert.ok(p.vote({ uniqueId: 'bob' }, 'a'));
  assert.equal(p.winner().label, 'A');
  assert.equal(p.snapshot().total, 2);

  const b = new GiftBattle({ teams: [{ name: 'R', gifts: 'Rose' }, { name: 'T', gifts: 'TikTok' }] });
  b.handle(gift('Rose', 1, 10));
  b.handle(normalize('chat', { user: { uniqueId: 'bob' }, comment: '!team2' }));
  b.handle(normalize('gift', { user: { uniqueId: 'bob' }, repeatCount: 1, repeatEnd: 1, giftDetails: { giftName: 'Galaxy', diamondCount: 1000 } }));
  assert.deepEqual(b.snapshot().teams.map((t) => t.score), [10, 1000]);
});

test('obs auth matches obs-websocket v5 reference', () => {
  // Reference values from the obs-websocket protocol docs example.
  assert.equal(obsAuth('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY='), '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=');
});

test('studio end-to-end: event -> rule -> alert/tts broadcast + points', async () => {
  const sent = [];
  const studio = new Studio({ broadcast: (type, payload) => sent.push({ type, payload }) });
  studio.handleEvent(gift('Galaxy', 1000));
  const alert = sent.find((m) => m.type === 'alert');
  assert.match(alert.payload.text, /МЕГА ДОНАТ! Alice — 1000💎/);
  assert.ok(sent.some((m) => m.type === 'tts'));
  assert.equal(studio.getPoints('alice'), 10000);

  // !tts costs 50 points and censors links.
  studio.handleEvent(normalize('chat', { user, comment: '!tts look https://spam.example now' }));
  const tts = sent.filter((m) => m.type === 'tts').at(-1);
  assert.equal(tts.payload.text, 'Alice говорит: look [ссылка] now');
  assert.equal(studio.getPoints('alice'), 10000 + 1 - 50);

  // Duplicate gift events are ignored.
  const before = studio.stats.totals.diamonds;
  const dup = gift('Rose', 1, 1, { groupId: 'x' });
  studio.handleEvent(dup);
  studio.handleEvent({ ...dup, id: 'other' });
  assert.equal(studio.stats.totals.diamonds, before + 1);
  await studio.shutdown();
});
