// "Sign in with Google" — OpenID Connect authorization code flow with PKCE, no SDK.
//
// Security: a random state + nonce + PKCE verifier live in a short-lived HMAC-signed cookie;
// the callback must present the same state, the token exchange proves the PKCE verifier, and
// the ID token's issuer, audience, expiry, nonce and email_verified are checked. The ID token
// comes straight from Google's token endpoint over TLS, which OIDC Core §3.1.3.7 accepts in
// place of verifying its signature.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const FLOW_TTL_MS = 10 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const rnd = () => b64url(randomBytes(32));

export function pkceChallenge(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}

// Signed, expiring cookie value: base64url(json).hmac
export function sealFlow(data, secret, now = Date.now()) {
  const body = b64url(JSON.stringify({ ...data, exp: now + FLOW_TTL_MS }));
  return `${body}.${createHmac('sha256', secret).update(`oauth:${body}`).digest('base64url')}`;
}

export function openFlow(value, secret, now = Date.now()) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`oauth:${body}`).digest('base64url'));
  const got = Buffer.from(mac);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data.exp > now ? data : null;
  } catch {
    return null;
  }
}

export function startFlow({ clientId, redirectUri }) {
  const flow = { state: rnd(), nonce: rnd(), verifier: rnd() };
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: pkceChallenge(flow.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { flow, url: url.toString() };
}

export function decodeJwtPayload(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) throw new Error('bad id_token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export function validateIdToken(claims, { clientId, nonce, now = Date.now() }) {
  if (!ISSUERS.has(claims.iss)) throw new Error('Неверный издатель токена Google');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('Токен Google выдан другому приложению');
  if (!claims.exp || claims.exp * 1000 < now - 60000) throw new Error('Токен Google устарел');
  if (!nonce || claims.nonce !== nonce) throw new Error('Ответ Google не совпадает с запросом');
  if (!claims.sub) throw new Error('В ответе Google нет идентификатора');
  if (!claims.email || claims.email_verified !== true) throw new Error('E-mail в аккаунте Google не подтверждён');
  return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), name: claims.name || '' };
}

export async function finishFlow({ code, flow, clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: flow.verifier }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(`Google отклонил вход${data.error ? ` (${data.error})` : ''}`);
  return validateIdToken(decodeJwtPayload(data.id_token), { clientId, nonce: flow.nonce, now });
}
