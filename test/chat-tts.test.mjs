import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatReader, cleanForSpeech, DEFAULT_CHAT_TTS } from '../src/chat-filter.mjs';
import { escapeSsml } from '../src/neural-tts.mjs';
import { Studio } from '../src/studio.mjs';
import { normalize } from '../src/normalize.mjs';

const on = { ...DEFAULT_CHAT_TTS, enabled: true };
const chat = (text, uniqueId = 'u1', extra = {}) => ({ text, user: { uniqueId, nickname: uniqueId.toUpperCase(), ...extra } });

test('chat reader drops junk and reads real messages', () => {
  let t = 0;
  const r = new ChatReader({ now: () => t });
  const reason = (text, id) => r.check(chat(text, id), on).reason;
  assert.equal(reason('!song abc', 'a'), 'command');
  assert.equal(reason('😂😂😂🔥', 'a'), 'emoji');
  assert.equal(reason('+', 'a'), 'emoji'); // no letters at all
  assert.equal(reason('111', 'a'), 'short');
  assert.equal(reason('ok', 'a'), 'short');
  assert.equal(reason('смотри https://spam.example', 'a'), 'link');
  const ok = r.check(chat('Привет, как дела? 😊', 'a'), on);
  assert.deepEqual(ok, { ok: true, text: 'A: Привет, как дела?' });
  // Same viewer again too soon, then another viewer repeating the same line.
  t = 2000;
  assert.equal(reason('ещё одно сообщение', 'a'), 'cooldown');
  assert.equal(reason('привет как дела', 'b'), 'repeat');
  assert.equal(r.check(chat('аааааааааа круто!!!!!!', 'c'), on).text, 'C: ааа круто!!!');
  assert.equal(r.check(chat('hello', 'd'), { ...on, enabled: false }).reason, 'off');
  assert.equal(r.check(chat('нормальный текст', 'spammer'), { ...on, blockUsers: '@Spammer' }).reason, 'blocked-user');
  assert.equal(r.check(chat('купи подписчиков тут', 'e'), { ...on, blockWords: 'подписчиков' }).reason, 'blocked-word');
  assert.equal(r.check(chat('без имени пожалуйста', 'f'), { ...on, readNames: false }).text, 'без имени пожалуйста');
});

test('chat reader limits messages per minute', () => {
  let t = 0;
  const r = new ChatReader({ now: () => t });
  const cfg = { ...on, maxPerMinute: 2 };
  assert.ok(r.check(chat('первое сообщение', 'a'), cfg).ok);
  assert.ok(r.check(chat('второе сообщение', 'b'), cfg).ok);
  assert.equal(r.check(chat('третье сообщение', 'c'), cfg).reason, 'rate');
  t = 61000;
  assert.ok(r.check(chat('третье сообщение', 'c'), cfg).ok);
});

test('speech cleanup and SSML escaping', () => {
  assert.equal(cleanForSpeech('  hi 👋🏽   there www.x.com '), 'hi there');
  assert.equal(escapeSsml('<voice name="x">&'), '&lt;voice name=&quot;x&quot;&gt;&amp;');
});

test('neural voice sends mp3 audio; failure falls back to the system voice', async () => {
  const sent = [];
  const calls = [];
  let fail = false;
  const neuralTts = { synth: async (text, opts) => { calls.push({ text, opts }); if (fail) throw new Error('offline'); return Buffer.from('ID3fake'); } };
  const studio = new Studio({ neuralTts, broadcast: (type, payload) => sent.push({ type, payload }) });
  studio.cfg.settings.tts.neuralVoice = 'ru-RU-DmitryNeural';
  await studio.speak('привет');
  assert.equal(calls[0].opts.voice, 'ru-RU-DmitryNeural');
  assert.match(sent.at(-1).payload.audio, /^data:audio\/mpeg;base64,/);
  fail = true;
  await studio.speak('второй раз');
  assert.equal(sent.at(-1).payload.audio, undefined);
  assert.equal(sent.at(-1).payload.text, 'второй раз');
  // While the service is down, phrases go straight to the system voice.
  studio.speak('третий');
  assert.equal(calls.length, 2);
  assert.equal(sent.at(-1).payload.text, 'третий');
  await studio.shutdown();
});

test('chat reading: old "read all chat" setting is migrated and filtered chat is spoken', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-chat-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ settings: { tts: { readAllChat: true } } }));
  const sent = [];
  const studio = new Studio({ dataDir: dir, broadcast: (type, payload) => sent.push({ type, payload }) });
  assert.equal(studio.cfg.settings.tts.chat.enabled, true);
  assert.equal('readAllChat' in studio.cfg.settings.tts, false);
  studio.cfg.settings.tts.engine = 'system';
  studio.handleEvent(normalize('chat', { user: { uniqueId: 'v1', nickname: 'Вася' }, comment: '🔥🔥🔥' }));
  studio.handleEvent(normalize('chat', { user: { uniqueId: 'v2', nickname: 'Петя' }, comment: 'Какая игра сегодня?' }));
  const spoken = sent.filter((m) => m.type === 'tts').map((m) => m.payload.text);
  assert.deepEqual(spoken, ['Петя: Какая игра сегодня?']);
  await studio.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
