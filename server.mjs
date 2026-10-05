#!/usr/bin/env node
// TikLive Studio server: static dashboard/overlays, JSON API and a WebSocket hub.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normPath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Studio } from './src/studio.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DEMO = process.argv.includes('--demo');

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

const clients = new Set();
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

const studio = new Studio({ dataDir: join(ROOT, 'data'), broadcast });

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

const routes = {
  'GET /api/state': () => studio.state(),
  'PUT /api/config': (b) => {
    for (const key of ['settings', 'rules', 'goals', 'wheel']) if (b[key] !== undefined) studio.cfg[key] = b[key];
    studio.config.save();
    broadcast('config', studio.cfg);
    broadcast('goals', studio.cfg.goals);
    return { ok: true };
  },
  'POST /api/connect': async (b) => {
    await studio.connect(b.username);
    return { ok: true };
  },
  'POST /api/disconnect': async () => {
    await studio.source.disconnect();
    return { ok: true };
  },
  'POST /api/obs/connect': async () => {
    await studio.connectObs();
    return { ok: true };
  },
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
  'GET /api/export.csv': () => ({ __raw: studio.stats.toCSV(), type: 'text/csv; charset=utf-8' }),
};

async function serveStatic(req, res, pathname) {
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
  if (!handler) return serveStatic(req, res, url.pathname);
  try {
    const body = req.method === 'GET' ? {} : await readJson(req);
    const out = await handler(body);
    if (out && out.__raw !== undefined) return send(res, 200, out.__raw, out.type);
    send(res, 200, out ?? { ok: true });
  } catch (err) {
    send(res, 400, { error: err?.message || String(err) });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', payload: studio.state() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  TikLive Studio запущен\n  Панель управления: ${base}/\n  Оверлеи для OBS:   ${base}/overlay/?w=alerts  (см. вкладку «Оверлеи»)\n`);
  if (DEMO) {
    studio.sim.start(1);
    console.log('  Демо-режим: симулятор событий включён\n');
  } else if (studio.cfg.settings.username && studio.cfg.settings.autoReconnect) {
    studio.connect().catch((e) => console.log(`  Автоподключение не удалось: ${e.message}`));
  }
});

async function stop() {
  await studio.shutdown();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
