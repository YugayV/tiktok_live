#!/usr/bin/env node
// TikLive Studio CLI entry point. Desktop app: see electron/main.mjs.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './src/server-app.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const app = startServer({
  port: Number(process.env.PORT) || 8787,
  host: process.env.HOST || '127.0.0.1',
  dataDir: process.env.TIKLIVE_DATA || join(ROOT, 'data'),
  demo: process.argv.includes('--demo'),
});

app.ready.catch((err) => {
  console.error(`Не удалось запустить сервер: ${err.message}`);
  process.exit(1);
});

async function stop() {
  await app.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
