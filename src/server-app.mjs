// HTTP API + static files + WebSocket hub. Used by the CLI (server.mjs) and the Electron shell.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normPath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Studio } from './studio.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error('Body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function buildRoutes(studio, broadcast) {
  return {
    'GET /api/state': () => studio.state(),
    'PUT /api/config': (b) => {
      for (const key of ['settings', 'rules', 'goals', 'wheel']) if (b[key] !== undefined) studio.cfg[key] = b[key];
      studio.config.save();
      broadcast('config', studio.cfg);
      broadcast('goals', studio.cfg.goals);
      return { ok: true };
    },
    'POST /api/connect': async (b) => (await studio.connect(b.username), { ok: true }),
    'POST /api/disconnect': async () => (await studio.source.disconnect(), { ok: true }),
    'POST /api/obs/connect': async () => (await studio.connectObs(), { ok: true }),
    'POST /api/simulate': (b) => studio.simulate(b.type || 'gift', b),
    'POST /api/simulator': (b) => {
      if (b.running) studio.sim.start(Number(b.intensity) || 1);
      else studio.sim.stop();
      return { running: studio.sim.running };
    },
    'POST /api/alert/skip': () => (studio.queue.skip(), { ok: true }),
    'POST /api/alert/clear': () => (studio.queue.clear(), { ok: true }),
    'POST /api/alert/pause': (b) => (studio.queue.setPaused(Boolean(b.paused)), studio.queue.snapshot()),
    'POST /api/tts': (b) => (studio.speak(String(b.text || '')), { ok: true }),
    'POST /api/wheel/spin': (b) => studio.spinWheel(b.by),
    'POST /api/poll/start': (b) => studio.startPoll(b),
    'POST /api/poll/end': () => studio.endPoll(),
    'POST /api/battle/start': (b) => studio.startBattle(b),
    'POST /api/battle/end': () => studio.endBattle(),
    'POST /api/session/reset': () => (studio.resetSession(), { ok: true }),
    'POST /api/points': (b) => {
      studio.addPoints({ uniqueId: b.uniqueId, nickname: b.uniqueId }, Number(b.amount) || 0);
      return { points: studio.getPoints(b.uniqueId) };
    },
    'GET /api/license': () => studio.license.status(),
    'POST /api/license/activate': (b) => studio.license.activate(b.key),
    'POST /api/license/refresh': () => studio.license.validate(),
    'POST /api/license/deactivate': () => studio.license.deactivate(),
    'POST /api/ai/ask': async (b) => {
      studio.requirePro('ai');
      const answer = await studio.ai.ask(String(b.question || ''), { nickname: 'стример' });
      if (answer && studio.ai.quota) return { answer, quota: studio.ai.quota };
      if (!answer) throw new Error('Нет ответа: ИИ выключен, нет ключа или превышен лимит запросов');
      return { answer };
    },
    'POST /api/songs/add': (b) => {
      studio.requirePro('songs');
      const res = studio.songs.request({ uniqueId: '__host__', nickname: b.nickname || 'Стример' }, String(b.text || ''), { priority: 100 });
      if (!res.ok) throw new Error(res.error);
      studio.fetchSongTitle(res.song);
      if (!studio.songs.current) studio.songNext();
      else studio.broadcastSongs();
      return res;
    },
    'POST /api/songs/next': (b) => {
      // Several player overlays may report the same track ending; only the first advances.
      if (b.expectId && studio.songs.current?.id !== b.expectId) return studio.songs.current || { done: true };
      return studio.songNext() || { done: true };
    },
    'POST /api/songs/remove': (b) => (studio.songs.remove(b.id), studio.broadcastSongs(), { ok: true }),
    'POST /api/songs/clear': () => (studio.songs.clear(), studio.broadcastSongs(), { ok: true }),
    'POST /api/songs/title': (b) => (studio.songs.setTitle(b.id, b.title), studio.broadcastSongs(), { ok: true }),
    'POST /api/keys/test': (b) => {
      studio.requirePro('keyboard');
      if (!studio.cfg.settings.keyboard.enabled) throw new Error('Управление клавиатурой выключено в настройках');
      return { queued: studio.keys.enqueue(b) };
    },
    'POST /api/keys/stop': async () => (await studio.keys.stop(), { ok: true }),
    'GET /api/export.csv': () => ({ __raw: studio.stats.toCSV(), type: 'text/csv; charset=utf-8' }),
  };
}

export function startServer({ port = 8787, host = '127.0.0.1', dataDir, demo = false, log = console.log } = {}) {
  const clients = new Set();
  const broadcast = (type, payload) => {
    const msg = JSON.stringify({ type, payload });
    for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
  };
  const studio = new Studio({ dataDir, broadcast });
  const routes = buildRoutes(studio, broadcast);
  studio.license.startAutoValidate();

  async function serveStatic(res, pathname) {
    if (pathname === '/') pathname = '/dashboard.html';
    if (pathname.startsWith('/overlay/') && !extname(pathname)) pathname = '/overlay/index.html';
    const file = normPath(join(PUBLIC, pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      send(res, 404, 'Not found', 'text/plain');
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return serveStatic(res, url.pathname);
    try {
      const body = req.method === 'GET' ? {} : await readJson(req);
      const out = await handler(body);
      if (out && out.__raw !== undefined) return send(res, 200, out.__raw, out.type);
      send(res, 200, out ?? { ok: true });
    } catch (err) {
      send(res, err?.status === 402 ? 402 : 400, { error: err?.message || String(err), ...(err?.feature ? { feature: err.feature } : {}) });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', payload: studio.state() }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`;
      log(`\n  TikLive Studio запущен\n  Панель управления: ${base}/\n  Оверлеи для OBS:   ${base}/overlay/?w=alerts  (см. вкладку «Оверлеи»)\n`);
      if (demo) {
        studio.sim.start(1);
        log('  Демо-режим: симулятор событий включён\n');
      } else if (studio.cfg.settings.username && studio.cfg.settings.autoReconnect) {
        studio.connect().catch((e) => log(`  Автоподключение не удалось: ${e.message}`));
      }
      resolve(base);
    });
  });

  async function close() {
    for (const ws of clients) ws.terminate();
    wss.close();
    await new Promise((r) => server.close(r));
    await studio.shutdown();
  }

  return { studio, server, ready, close };
}
