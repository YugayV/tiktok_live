#!/usr/bin/env node
// TikLive cloud HTTP server. Configuration via environment variables (see cloud/README.md).

import { createServer } from 'node:http';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { CloudService, JsonStore } from './service.mjs';

const env = process.env;
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));

for (const name of ['ANTHROPIC_API_KEY', 'LS_STORE_ID', 'LS_PRODUCT_ID']) {
  if (!env[name]) {
    console.error(`Не задана переменная окружения ${name}`);
    process.exit(1);
  }
}

const store = new JsonStore(join(env.DATA_DIR || './cloud-data', 'state.json'));
const service = new CloudService({
  anthropic: new Anthropic(), // reads ANTHROPIC_API_KEY
  store,
  config: {
    storeId: env.LS_STORE_ID,
    productId: env.LS_PRODUCT_ID,
    model: env.AI_MODEL,
    effort: env.AI_EFFORT,
    proMonthlyLimit: num(env.PRO_MONTHLY_LIMIT),
    trialDays: num(env.TRIAL_DAYS),
    trialLimit: num(env.TRIAL_LIMIT),
    trialsPerIp: num(env.TRIALS_PER_IP),
    perMinute: num(env.PER_MINUTE),
    maxConcurrent: num(env.MAX_CONCURRENT),
  },
});

function clientIp(req) {
  // Behind a reverse proxy (Render, Railway, Fly, nginx) set TRUST_PROXY=1.
  if (env.TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || pathname !== '/v1/ai/answer') return send(res, 404, { error: 'Not found' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) return send(res, 413, { error: 'Слишком большой запрос' });
  }
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return send(res, 400, { error: 'Некорректный JSON' });
  }
  const out = await service.answer(body, { authorization: req.headers.authorization, ip: clientIp(req) });
  send(res, out.status, out.body);
});

server.requestTimeout = 90000;
server.listen(Number(env.PORT) || 8080, env.HOST || '0.0.0.0', () => console.log(`TikLive cloud слушает порт ${server.address().port}`));

function stop() {
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
