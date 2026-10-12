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
import { verifySignature, applyWebhook } from './billing.mjs';
import { createMailer, resetEmail, verifyEmail } from './mailer.mjs';

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
  blocked(key) {
    const t = this.now();
    return (this.hits.get(key) || []).filter((x) => t - x < this.windowMs).length >= this.max;
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
  publicUrl = '', // https://app.example.com — required for links in e-mails
  mailer = createMailer({}),
  webhookSecret = '', // Lemon Squeezy signing secret
  authLimit = 10, // auth attempts per IP per 15 minutes
  requireEmailVerification, // default: on whenever e-mail can actually be sent
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = console.log,
} = {}) {
  const accounts = new AccountStore(join(dataDir, 'accounts.json'), { now });
  const tenants = new TenantManager({ dataDir, accounts, anthropic, ai, licenseConfig, serverSecret, signApiKey, fetchImpl, now, log });
  const authLimiter = new Limiter(authLimit, 15 * 60 * 1000, now); // failed logins, resets, password changes
  const signupLimiter = new Limiter(authLimit, 15 * 60 * 1000, now);
  const resetLimiter = new Limiter(3, 60 * 60 * 1000, now); // per e-mail address
  const baseUrl = publicUrl.replace(/\/+$/, '');
  const verifyOn = requireEmailVerification ?? Boolean(baseUrl && mailer.enabled);
  if (!verifyOn) log('[web] подтверждение e-mail выключено (нужны PUBLIC_URL и почта) — новые аккаунты активны сразу');
  const resendLimiter = new Limiter(3, 60 * 60 * 1000, now); // per account

  function sendVerification(userId) {
    const u = accounts.user(userId);
    const link = `${baseUrl}/verify?token=${encodeURIComponent(accounts.createVerifyToken(userId))}`;
    mailer.send({ to: u.email, ...verifyEmail(link) }).catch((err) => log(`[mail] verify for ${userId}: ${err.message}`));
  }

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

      // --- Lemon Squeezy subscription webhooks -------------------------------------
      if (req.method === 'POST' && path === '/webhooks/lemonsqueezy') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 1e6) return send(res, 413, { error: 'too large' });
        }
        if (!verifySignature(raw, req.headers['x-signature'], webhookSecret)) return send(res, 401, { error: 'bad signature' });
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'bad json' });
        }
        const r = applyWebhook(accounts, payload, licenseConfig);
        log(`[billing] ${payload?.meta?.event_name}: ${r.handled ? `user ${r.userId} → ${accounts.user(r.userId)?.subscription?.status}` : r.reason}`);
        if (r.handled) tenants.notifyLicense(r.userId);
        return send(res, 200, { ok: true });
      }

      // --- password reset -------------------------------------------------------
      if (req.method === 'POST' && path === '/auth/forgot') {
        if (!authLimiter.hit(ipOf(req))) return send(res, 429, { error: 'Слишком много попыток. Подождите 15 минут.' });
        const b = await readJson(req);
        if (!baseUrl || !mailer.enabled) return send(res, 503, { error: 'Восстановление пароля на этом сервере не настроено — напишите в поддержку.' });
        const email = String(b.email || '').trim().toLowerCase();
        const userId = accounts.idByEmail(email);
        // Same answer whether or not the account exists; the mail goes out in the background.
        if (userId && resetLimiter.hit(email)) {
          const link = `${baseUrl}/reset?token=${encodeURIComponent(accounts.createResetToken(userId))}`;
          mailer.send({ to: email, ...resetEmail(link) }).catch((err) => log(`[mail] reset for ${userId}: ${err.message}`));
        }
        return send(res, 200, { ok: true, message: 'Если аккаунт с этим e-mail существует, мы отправили письмо со ссылкой для сброса пароля.' });
      }
      if (req.method === 'POST' && path === '/auth/reset') {
        if (!authLimiter.hit(ipOf(req))) return send(res, 429, { error: 'Слишком много попыток. Подождите 15 минут.' });
        const b = await readJson(req);
        try {
          setSession(req, res, accounts.resetPassword(b.token, b.password));
          return send(res, 200, { ok: true });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }
      if (req.method === 'POST' && path === '/auth/change') {
        const userId = sessionUser(req);
        if (!userId) return send(res, 401, { error: 'Войдите в аккаунт' });
        if (!authLimiter.hit(ipOf(req))) return send(res, 429, { error: 'Слишком много попыток. Подождите 15 минут.' });
        const b = await readJson(req);
        try {
          accounts.changePassword(userId, b.current, b.password);
          return send(res, 200, { ok: true });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }

      // --- auth ---------------------------------------------------------------
      if (req.method === 'POST' && (path === '/auth/signup' || path === '/auth/login')) {
        // Sign-ups always count; logins count only when they fail (guessing), so a user who
        // logs in successfully many times is never locked out.
        if (path === '/auth/signup' && !signupLimiter.hit(ipOf(req))) return send(res, 429, { error: 'Слишком много попыток. Подождите 15 минут.' });
        if (path === '/auth/login' && authLimiter.blocked(ipOf(req))) return send(res, 429, { error: 'Слишком много неудачных попыток. Подождите 15 минут.' });
        const b = await readJson(req);
        if (path === '/auth/signup' && !allowSignup) return send(res, 403, { error: 'Регистрация закрыта' });
        try {
          const userId = path === '/auth/signup' ? accounts.signup(b.email, b.password, { verified: !verifyOn }) : accounts.login(b.email, b.password);
          if (path === '/auth/signup' && verifyOn) sendVerification(userId);
          setSession(req, res, userId);
          return send(res, 200, { ok: true });
        } catch (err) {
          if (path === '/auth/login') authLimiter.hit(ipOf(req));
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
      // Link from the confirmation letter. Single-use token; a mail scanner opening it first still confirms.
      if (req.method === 'GET' && path === '/verify') {
        try {
          const userId = accounts.verifyEmail(url.searchParams.get('token'));
          tenants.notifyVerified(userId);
          return redirect(res, sessionUser(req) ? '/app?verified=1' : '/login?verified=1');
        } catch (err) {
          return redirect(res, `${sessionUser(req) ? '/app' : '/login'}?verify_error=${encodeURIComponent(err.message)}`);
        }
      }
      if (req.method === 'POST' && path === '/api/account/resend-verification') {
        const userId = sessionUser(req);
        if (!userId) return send(res, 401, { error: 'Войдите в аккаунт' });
        if (accounts.isVerified(userId)) return send(res, 200, { ok: true, message: 'E-mail уже подтверждён' });
        if (!verifyOn) return send(res, 503, { error: 'Отправка писем на этом сервере не настроена' });
        if (!resendLimiter.hit(userId)) return send(res, 429, { error: 'Письмо уже отправлялось несколько раз. Проверьте папку «Спам» или попробуйте через час.' });
        sendVerification(userId);
        return send(res, 200, { ok: true, message: `Письмо отправлено на ${accounts.user(userId).email}` });
      }
      if (path === '/forgot' || path === '/reset') return file(res, join(HOSTED_PUBLIC, 'auth.html'));
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
