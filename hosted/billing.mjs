// Lemon Squeezy subscription webhooks → Pro on the account, no license key to paste.
//
// The checkout link carries the account id (checkout[custom][user_id]); Lemon Squeezy echoes it
// back in every subscription webhook (meta.custom_data). Each webhook is signed with the
// store's signing secret (X-Signature = hex HMAC-SHA256 of the raw body).

import { createHmac, timingSafeEqual } from 'node:crypto';

// Statuses that keep Pro on. past_due: Lemon Squeezy is still retrying the card.
const ACTIVE = new Set(['active', 'on_trial', 'past_due']);

export function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  let got;
  try {
    got = Buffer.from(String(signature), 'hex');
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function subscriptionActive(sub, now = Date.now()) {
  if (!sub) return false;
  if (ACTIVE.has(sub.status)) return true;
  // Cancelled subscriptions run until the end of the paid period.
  return sub.status === 'cancelled' && Boolean(sub.endsAt) && Date.parse(sub.endsAt) > now;
}

export function checkoutUrlFor(base, { email, userId }) {
  if (!base) return '';
  const u = new URL(base);
  if (email) u.searchParams.set('checkout[email]', email);
  if (userId) u.searchParams.set('checkout[custom][user_id]', userId);
  return u.toString();
}

const SUBSCRIPTION_EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
  'subscription_payment_success',
  'subscription_payment_failed',
  'subscription_payment_recovered',
]);

// Returns { handled, userId?, reason? }. Never throws on unknown/foreign events: Lemon Squeezy
// retries anything that isn't 2xx, so only bad signatures get an error status.
export function applyWebhook(accounts, payload, { storeId, productId }) {
  const event = payload?.meta?.event_name;
  if (!SUBSCRIPTION_EVENTS.has(event)) return { handled: false, reason: `ignored event ${event}` };
  const data = payload.data || {};
  const a = data.attributes || {};
  // Payment events carry an invoice; the subscription itself arrives in subscription_updated.
  if (data.type !== 'subscriptions') return { handled: false, reason: `ignored ${data.type}` };
  if (String(a.store_id) !== String(storeId) || String(a.product_id) !== String(productId)) return { handled: false, reason: 'other store/product' };

  const userId = accounts.user(payload.meta?.custom_data?.user_id) ? payload.meta.custom_data.user_id : accounts.idByEmail(a.user_email);
  if (!userId) return { handled: false, reason: `no account for ${a.user_email}` };

  const prev = accounts.user(userId).subscription;
  const updatedAt = a.updated_at || new Date().toISOString();
  // Webhooks can arrive out of order: never let an older snapshot overwrite a newer one.
  if (prev && prev.id === String(data.id) && prev.updatedAt && Date.parse(prev.updatedAt) > Date.parse(updatedAt)) return { handled: false, userId, reason: 'stale' };

  accounts.setSubscription(userId, {
    id: String(data.id),
    status: a.status,
    endsAt: a.ends_at || null,
    renewsAt: a.renews_at || null,
    manageUrl: a.urls?.customer_portal || prev?.manageUrl || '',
    updatedAt,
  });
  return { handled: true, userId };
}
