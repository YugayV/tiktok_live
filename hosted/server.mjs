// TikLive Web: the hosted, multi-user version (like TikFinity's web app).
// Streamers sign up in the browser, the server keeps their TikTok LIVE connection,
// and overlays are personal URLs (/o/<token>/?w=alerts) added to OBS / TikTok LIVE Studio.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize as normPath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AccountStore } from './accounts.mjs';
import { TenantManager } from './tenants.mjs';
import { PUBLIC, MIME, send, readJson } from '../src/server-app.mjs';

const HOSTED_PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const COOKIE = 'tl_session';
const SESSION_MAX_AGE = 30 * 86400;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Simple fixed-window limiter for auth endpoints (per IP).
class Limiter {
  constructor(max, windowMs, now) {
    Object.assign(this, { max, windowMs, now, hits: new Map() });
  }
  hit(key) {
    const t = this.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 50000) this.hits.clear();
    return list.length <= this.max;
  }
}

export function startHostedServer({
  port = 8080,
  host = '0.0.0.0',
  dataDir = './web-data',
  serverSecret,
  anthropic = null,
  ai = {},
  licenseConfig = {},
  signApiKey = '',
  trustProxy = false,
  secureCookies = false,
  allowSignup = true,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = console.log,
} = {}) {
  const accounts = new AccountStore(join(dataDir, 'accounts.json'), { now });
  const tenants = new TenantManager({ dataDir, accounts, anthropic, ai, licenseConfig, serverSecret, signApiKey, fetchImpl, now, log });
  const authLimiter = new Limiter(10, 15 * 60 * 1000, now);

  const ipOf = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const isSecure = (req) => secureCookies || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const sessionUser = (req) => accounts.getSession(parseCookies(req.headers.cookie)[COOKIE]);

  function setSession(req, res, userId) {
    const tok = accounts.createSession(userId);
    res.setHeader('set-cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${isSecure(req) ? '; Secure' : ''}`);
  }

  async function file(res, path, extraHeaders = {}) {
    try {
      const data = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', ...extraHeaders });
      res.end(data);
    } catch {
      send(res, 404, 'Not found', 'text/plain');
    }
  }

  function staticFrom(root, res, pathname) {
    const p = normPath(join(root, pathname));
    if (!p.startsWith(root)) return send(res, 403, 'Forbidden', 'text/plain');
    return file(res, p);
  }

  function redirect(res, to) {
    res.writeHead(302, { location: to });
    res.end();
  }

  // JSON-only mutations: a cross-site <form> cannot send application/json without a CORS preflight,
  // which this server never grants — together with SameSite=Lax this blocks CSRF.
  const jsonOnly = (req) => req.method === 'GET' || String(req.headers['content-type'] || '').startsWith('application/json');

  async function handleApi(req, res, routes, path) {
    const handler = routes[`${req.method} ${path}`];
    if (!handler) return send(res, 404, { error: 'Not found' });
    try {
      const body = req.method === 'GET' ? {} : await readJson(req);
      const out = await handler(body);
      if (out && out.__raw !== undefined) return send(res, 200, out.__raw, out.type);
      send(res, 200, out ?? { ok: true });
    } catch (err) {
      send(res, [400, 402, 403, 404, 429].includes(err?.status) ? err.status : 400, { error: err?.message || String(err), ...(err?.feature ? { feature: err.feature } : {}) });
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    try {
      if (path === '/healthz') return send(res, 200, { ok: true, tenants: tenants.tenants.size });
      if (!jsonOnly(req)) return send(res, 415, { error: 'Content-Type must be application/json' });

      // --- auth ---------------------------------------------------------------
      if (req.method === 'POST' && (path === '/auth/signup' || path === '/auth/login')) {
        if (!authLimiter.hit(ipOf(req))) return send(res, 429, { error: 'Слишком много попыток. Подождите 15 минут.' });
        const b = await readJson(req);
        if (path === '/auth/signup' && !allowSignup) return send(res, 403, { error: 'Регистрация закрыта' });
        try {
          const userId = path === '/auth/signup' ? accounts.signup(b.email, b.password) : accounts.login(b.email, b.password);
          setSession(req, res, userId);
          return send(res, 200, { ok: true });
        } catch (err) {
          return send(res, path === '/auth/login' ? 401 : 400, { error: err.message });
        }
      }
      if (req.method === 'POST' && path === '/auth/logout') {
        accounts.destroySession(parseCookies(req.headers.cookie)[COOKIE]);
        res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return send(res, 200, { ok: true });
      }

      // --- pages --------------------------------------------------------------
      if (path === '/') return redirect(res, sessionUser(req) ? '/app' : '/login');
      if (path === '/login' || path === '/signup') return sessionUser(req) ? redirect(res, '/app') : file(res, join(HOSTED_PUBLIC, 'auth.html'));
      if (path === '/app') return sessionUser(req) ? file(res, join(PUBLIC, 'dashboard.html'), { 'content-security-policy': "frame-ancestors 'self'" }) : redirect(res, '/login');

      // --- dashboard API (session) ---------------------------------------------
      if (path.startsWith('/api/')) {
        const userId = sessionUser(req);
        if (!userId) return send(res, 401, { error: 'Войдите в аккаунт' });
        return handleApi(req, res, tenants.get(userId).routes, path);
      }

      // --- personal overlay URLs: /o/<token>/ ----------------------------------
      const m = /^\/o\/([\w-]{10,64})(\/.*)?$/.exec(path);
      if (m) {
        const userId = accounts.userByOverlayToken(m[1]);
        if (!userId) return send(res, 404, 'Ссылка на оверлей недействительна', 'text/plain; charset=utf-8');
        const rest = m[2] || '/';
        if (rest === '/') return file(res, join(PUBLIC, 'overlay', 'index.html'));
        // The YouTube player overlay reports track end / title.
        if (rest === '/api/songs/next' || rest === '/api/songs/title') return handleApi(req, res, tenants.get(userId).routes, rest);
        return send(res, 404, 'Not found', 'text/plain');
      }

      // --- shared static assets (dashboard.js/css, overlay.js/css, icons) --------
      if (req.method === 'GET') {
        if (path.startsWith('/auth-assets/')) return staticFrom(HOSTED_PUBLIC, res, path.slice('/auth-assets'.length));
        if (path === '/dashboard.js' || path === '/dashboard.css' || path.startsWith('/overlay/')) return staticFrom(PUBLIC, res, path);
      }
      send(res, 404, 'Not found', 'text/plain');
    } catch (err) {
      log(`[web] ${req.method} ${path}: ${err?.stack || err}`);
      if (!res.headersSent) send(res, 500, { error: 'Внутренняя ошибка' });
    }
  });

  // WebSocket: dashboards authenticate with the session cookie, overlays with ?t=<overlay token>.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const overlayToken = url.searchParams.get('t');
    const userId = overlayToken ? accounts.userByOverlayToken(overlayToken) : sessionUser(req);
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const t = tenants.get(userId);
      ws.kind = overlayToken ? 'overlay' : 'dashboard';
      t.clients.add(ws);
      ws.send(JSON.stringify({ type: 'hello', payload: t.studio.state() }));
      const bye = () => {
        t.clients.delete(ws);
        t.lastActive = now();
      };
      ws.on('close', bye);
      ws.on('error', bye);
    });
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log(`TikLive Web слушает порт ${server.address().port}`);
      resolve(server.address().port);
    });
  });

  async function close() {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => server.close(r));
    await tenants.shutdown();
    accounts.save();
  }

  return { server, ready, close, accounts, tenants };
}
