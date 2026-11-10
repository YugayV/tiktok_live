import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entrances, safeMediaUrl, DEFAULT_ENTRANCES } from '../src/entrances.mjs';
import { MediaStore } from '../src/media.mjs';
import { CloudTTS } from '../src/cloud-tts.mjs';
import { Studio } from '../src/studio.mjs';
import { startServer } from '../src/server-app.mjs';
import { normalize } from '../src/normalize.mjs';

const join_ = (uniqueId) => ({ type: 'member', user: { uniqueId, nickname: uniqueId.toUpperCase() } });

test('entrance video plays once per session for listed viewers', () => {
  let t = 0;
  const e = new Entrances({ now: () => t });
  const cfg = { ...DEFAULT_ENTRANCES, list: [{ user: '@Vasya', video: 'media/0123456789abcdef.mp4', text: '{nickname} в здании!' }] };
  const a = e.check(join_('vasya'), cfg);
  assert.deepEqual(a, { video: 'media/0123456789abcdef.mp4', text: 'VASYA в здании!', duration: 10, volume: 0.8 });
  assert.equal(e.check(join_('vasya'), cfg), null); // rejoin: not again
  assert.equal(e.check(join_('petya'), cfg), null); // not listed, no common video
  // Common video for everyone else, with a repeat interval.
  const all = { ...cfg, defaultVideo: 'https://cdn.example.com/hi.mp4', repeatMinutes: 30 };
  assert.equal(e.check(join_('petya'), all).text, '👋 PETYA заходит на эфир!');
  t = 29 * 60000;
  assert.equal(e.check(join_('petya'), all), null);
  t = 31 * 60000;
  assert.ok(e.check(join_('petya'), all));
  e.reset();
  assert.ok(e.check(join_('vasya'), cfg));
  assert.equal(e.check(join_('x'), { ...cfg, enabled: false }), null);
});

test('only uploaded files or https links reach the overlay', () => {
  assert.equal(safeMediaUrl('media/0123456789abcdef.webm'), 'media/0123456789abcdef.webm');
  assert.equal(safeMediaUrl('https://x.com/a.mp4'), 'https://x.com/a.mp4');
  for (const bad of ['javascript:alert(1)', 'http://x.com/a.mp4', 'media/../config.json', 'https://x.com/"onerror=', 'file:///c:/a.mp4']) assert.equal(safeMediaUrl(bad), '');
});

test('media store: type, size and quota checks; safe names only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-media-'));
  const m = new MediaStore({ dir, maxFileMB: 1, maxTotalMB: 2 });
  const mb = (n) => Buffer.alloc(n * 1024 * 1024 * 0.9).toString('base64');
  const a = m.save('Мой вход.MP4', mb(1));
  assert.match(a.url, /^media\/[a-f0-9]{16}\.mp4$/);
  assert.throws(() => m.save('virus.exe', mb(1)), /Поддерживаются/);
  assert.throws(() => m.save('big.mp4', Buffer.alloc(2 * 1024 * 1024).toString('base64')), /больше 1 МБ/);
  m.save('b.webm', mb(1));
  assert.throws(() => m.save('c.gif', mb(1)), /закончилось/);
  assert.equal(m.list().length, 2);
  assert.equal(m.path('../config.json'), null);
  assert.ok(m.path(a.file));
  m.remove(a.file);
  assert.equal(m.list().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('a viewer joining queues an alert with their video', async () => {
  const sent = [];
  const studio = new Studio({ broadcast: (type, payload) => sent.push({ type, payload }) });
  studio.cfg.settings.entrances.list = [{ user: 'vip', video: 'media/0123456789abcdef.mp4', text: '' }];
  studio.handleEvent(normalize('member', { user: { uniqueId: 'vip', nickname: 'VIP' } }));
  const alert = sent.find((m) => m.type === 'alert');
  assert.equal(alert.payload.video, 'media/0123456789abcdef.mp4');
  assert.equal(alert.payload.style, 'entrance');
  await studio.shutdown();
});

test('server: upload, serve with ranges, test an entrance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-srv-'));
  const app = startServer({ port: 0, dataDir: dir, log: () => {} });
  const base = await app.ready;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const bytes = Buffer.from('0123456789'.repeat(100));
  const up = await post('/api/media/upload', { name: 'clip.mp4', data: bytes.toString('base64') });
  assert.match(up.url, /^media\//);
  const full = await fetch(`${base}/overlay/${up.url}`);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal((await full.arrayBuffer()).byteLength, 1000);
  const part = await fetch(`${base}/overlay/${up.url}`, { headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '0123456789');
  assert.equal((await fetch(`${base}/overlay/media/..%2Fconfig.json`)).status, 404);
  assert.equal((await post('/api/media/list', {})).files.length, 1);

  const alerts = [];
  app.studio.queue.onPlay = (a) => alerts.push(a);
  app.studio.cfg.settings.entrances.list = [{ user: 'vip', video: up.url }];
  await post('/api/entrance/test', { user: '@vip' });
  await post('/api/entrance/test', { user: 'vip' }); // the test button always replays
  assert.equal(app.studio.queue.items.length + (app.studio.queue.current ? 1 : 0), 2);
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('cloud TTS: Azure and Yandex requests, readable errors', async () => {
  const reqs = [];
  let status = 200;
  const fetchImpl = async (url, init) => {
    reqs.push({ url, init });
    return new Response(status === 200 ? Buffer.alloc(1000) : 'Unauthorized', { status });
  };
  const tts = new CloudTTS({ fetchImpl });
  const mp3 = await tts.synth('Привет <b>&', { engine: 'azure', azureKey: ' key ', azureRegion: 'WestEurope', azureVoice: 'ru-RU-DmitryNeural', rate: 1.2, pitch: -10 });
  assert.equal(mp3.length, 1000);
  assert.equal(reqs[0].url, 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(reqs[0].init.headers['Ocp-Apim-Subscription-Key'], 'key');
  assert.match(reqs[0].init.body, /<voice name="ru-RU-DmitryNeural"><prosody rate="\+20%" pitch="-10%">Привет &lt;b&gt;&amp;<\/prosody>/);
  await tts.synth('hi', { engine: 'yandex', yandexKey: 'yk', yandexVoice: 'filipp' });
  assert.equal(reqs[1].init.headers.Authorization, 'Api-Key yk');
  assert.equal(reqs[1].init.body.get('voice'), 'filipp');
  assert.equal(reqs[1].init.body.get('format'), 'mp3');
  status = 401;
  await assert.rejects(tts.synth('x', { engine: 'azure', azureKey: 'bad', azureRegion: 'eastus' }), /ключ неверный или не подходит к региону/);
  await assert.rejects(tts.synth('x', { engine: 'azure', azureKey: '', azureRegion: 'eastus' }), /укажите ключ/);
  await assert.rejects(tts.synth('x', { engine: 'azure', azureKey: 'k', azureRegion: 'evil.com/' }), /регион/);
});

test('0.3.3 configs: broken "neural" engine switches to system voice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiklive-mig2-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ settings: { migrations: ['tts-in-app', 'chat-tts'], tts: { engine: 'neural', neuralVoice: 'ru-RU-SvetlanaNeural' } } }));
  const studio = new Studio({ dataDir: dir });
  assert.equal(studio.cfg.settings.tts.engine, 'system');
  assert.equal('neuralVoice' in studio.cfg.settings.tts, false);
  await studio.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
