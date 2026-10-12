import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRoutes } from '../src/server-app.mjs';
import { Studio } from '../src/studio.mjs';

// Settings were silently never saved because the dashboard POSTed a PUT-only route.
// Every API call in the dashboard must hit a route the server actually has.
test('every dashboard API call matches a server route and method', async () => {
  const src = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const studio = new Studio({});
  const routes = buildRoutes(studio, () => {});
  const hostedOnly = ['/api/account/resend-verification', '/api/overlay/rotate'];
  const calls = [...src.matchAll(/\b(call|api)\('(\/api\/[\w/-]+)'(.*)$/gm)];
  assert.ok(calls.length > 20);
  for (const [, fn, path, rest] of calls) {
    if (hostedOnly.includes(path)) continue;
    // saveConfig passes the method explicitly; everything else is POST.
    const method = /'(PUT|GET|DELETE)'\)/.exec(rest)?.[1] || 'POST';
    assert.ok(routes[`${method} ${path}`], `${fn}(${path}) → no route ${method} ${path}`);
  }
  await studio.shutdown();
});
