// "Continue with TikTok" — TikTok Login Kit for Web (OAuth 2.0, API v2), no SDK.
//
// Flow: /v2/auth/authorize → code → POST /v2/oauth/token/ (client_key + client_secret) →
// GET /v2/user/info/. TikTok does not share the user's e-mail, so accounts are keyed by
// open_id; the TikTok @username (scope user.info.profile) pre-fills the LIVE connection.
// CSRF protection: random state in the same HMAC-signed short-lived cookie as Google sign-in.

import { randomBytes } from 'node:crypto';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const USER_URL = 'https://open.tiktokapis.com/v2/user/info/';
export const DEFAULT_TIKTOK_SCOPES = 'user.info.basic,user.info.profile';

export function startTikTokFlow({ clientKey, redirectUri, scopes = DEFAULT_TIKTOK_SCOPES, link = false }) {
  const flow = { state: randomBytes(32).toString('base64url'), link };
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({ client_key: clientKey, scope: scopes, response_type: 'code', redirect_uri: redirectUri, state: flow.state }).toString();
  return { flow, url: url.toString() };
}

export async function finishTikTokFlow({ code, clientKey, clientSecret, redirectUri, scopes = DEFAULT_TIKTOK_SCOPES, fetchImpl = globalThis.fetch }) {
  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const tok = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tok.access_token || !tok.open_id) throw new Error(`TikTok отклонил вход${tok.error ? ` (${tok.error})` : ''}`);

  // username needs user.info.profile; ask only for fields covered by the granted scopes.
  const granted = String(tok.scope || scopes);
  const fields = ['open_id', 'union_id', 'avatar_url', 'display_name', ...(granted.includes('user.info.profile') ? ['username'] : [])];
  const userRes = await fetchImpl(`${USER_URL}?fields=${fields.join(',')}`, {
    headers: { authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = await userRes.json().catch(() => ({}));
  const u = body?.data?.user;
  if (!userRes.ok || (body?.error?.code && body.error.code !== 'ok') || !u) throw new Error('Не удалось получить профиль TikTok');
  if (u.open_id && u.open_id !== tok.open_id) throw new Error('Ответ TikTok не совпадает с входом');
  return {
    openId: String(tok.open_id),
    unionId: u.union_id ? String(u.union_id) : '',
    username: String(u.username || '').replace(/^@/, ''),
    displayName: String(u.display_name || '').slice(0, 80),
    avatar: /^https:\/\//.test(u.avatar_url || '') ? u.avatar_url : '',
  };
}
