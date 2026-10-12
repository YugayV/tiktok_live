import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Studio } from '../src/studio.mjs';
import { normalize } from '../src/normalize.mjs';

test('old configs: paid !tts becomes free and audio plays in the app', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-mig-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    settings: { tts: { lang: 'ru-RU', rate: 1, volume: 1, maxLength: 200, readAllChat: false } },
    rules: [{ id: 'r-tts', name: 'Команда !tts (стоит 50 очков)', enabled: true, trigger: { type: 'chat', command: '!tts' }, cooldown: { perUser: 30 }, cost: 50, actions: [{ type: 'tts', text: '{nickname} говорит: {args}' }] }],
  }));
  const sent = [];
  const studio = new Studio({ dataDir: dir, broadcast: (type, payload) => sent.push({ type, payload }) });
  assert.equal(studio.cfg.rules[0].cost, 0);
  assert.equal(studio.cfg.settings.tts.output, 'app');
  studio.cfg.settings.tts.engine = 'system';
  // A brand-new viewer (no points) can use !tts right away.
  studio.handleEvent(normalize('chat', { user: { uniqueId: 'newbie', nickname: 'Новичок' }, comment: '!tts привет всем' }));
  const tts = sent.find((m) => m.type === 'tts');
  assert.equal(tts.payload.text, 'Новичок говорит: привет всем');
  assert.equal(tts.payload.output, 'app');
  // A streamer who deliberately set a price keeps it (migration runs once).
  studio.cfg.rules[0].cost = 50;
  studio.migrateConfig();
  assert.equal(studio.cfg.rules[0].cost, 50);
  await studio.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test('alerts carry the output setting so the app plays their sound', async () => {
  const sent = [];
  const studio = new Studio({ broadcast: (type, payload) => sent.push({ type, payload }) });
  studio.handleEvent(normalize('follow', { user: { uniqueId: 'a', nickname: 'A' } }));
  assert.equal(sent.find((m) => m.type === 'alert').payload.output, 'app');
  studio.cfg.settings.tts.output = 'obs';
  studio.cfg.settings.tts.engine = 'system';
  studio.speak('проверка');
  assert.equal(sent.filter((m) => m.type === 'tts').at(-1).payload.output, 'obs');
  await studio.shutdown();
});
