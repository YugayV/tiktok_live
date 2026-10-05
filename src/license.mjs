// Licensing: 7-day free trial (no card), then TikLive Pro by subscription ($8/month).
// Subscriptions and license keys are issued by Lemon Squeezy (merchant of record: it
// handles card payments, VAT and recurring billing); the app only talks to its public
// License API to activate/validate keys, so no backend of our own is needed.
//
// Trial and license state is signed with a machine-bound key and mirrored to a second
// location, so deleting the app data or editing the JSON does not restart the trial.
// A purely local check can still be patched out of the source by a determined user;
// it is meant to keep honest users honest, not to be DRM.

import { createHmac, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

const DAY = 24 * 60 * 60 * 1000;
const API = 'https://api.lemonsqueezy.com/v1/licenses';

export const LICENSE_DEFAULTS = {
  trialDays: 7,
  priceLabel: '$8 / месяц',
  checkoutUrl: '', // Lemon Squeezy checkout link of the "TikLive Pro" subscription
  storeId: null, // keys from other stores/products are rejected
  productId: null,
  offlineGraceDays: 7, // keep Pro working this long without reaching the license server
  revalidateHours: 12,
};

// Features that need Pro once the trial is over. Everything else stays free.
export const PRO_FEATURES = {
  ai: 'Ответы ИИ',
  songs: 'Заказ песен',
  keyboard: 'Управление играми',
  games: 'Колесо, голосования, битвы',
  obs: 'Автоматизация OBS',
  webhook: 'Webhooks',
};

export function machineSecret() {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {}
  return createHash('sha256').update(['tiklive', os.hostname(), os.platform(), os.arch(), os.homedir(), user].join('|')).digest();
}

function sign(secret, obj) {
  return createHmac('sha256', secret).update(JSON.stringify(obj)).digest('hex');
}

function readSigned(file, secret) {
  if (!file || !existsSync(file)) return { exists: false };
  try {
    const { body, sig } = JSON.parse(readFileSync(file, 'utf8'));
    return { exists: true, ok: sig === sign(secret, body), body };
  } catch {
    return { exists: true, ok: false };
  }
}

function writeSigned(file, secret, body) {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ body, sig: sign(secret, body) }));
    renameSync(`${file}.tmp`, file);
  } catch {
    // read-only location: state is kept in memory for this run
  }
}

export function maskKey(key) {
  return key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '';
}

export class License {
  constructor({
    file, // primary state file (app data dir); null = memory only (tests)
    backupFile = file ? join(os.homedir(), '.tiklive', 'state.json') : null,
    config = {},
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    secret = machineSecret(),
    instanceName = os.hostname(),
  } = {}) {
    this.file = file;
    this.backupFile = backupFile;
    this.cfg = { ...LICENSE_DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v != null && v !== '')) };
    this.fetch = fetchImpl;
    this.now = now;
    this.secret = secret;
    this.instanceName = instanceName;
    this.listeners = new Set();
    this.load();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  emit() {
    const s = this.status();
    for (const fn of this.listeners) fn(s);
  }

  load() {
    const now = this.now();
    const main = readSigned(this.file, this.secret);
    const backup = readSigned(this.backupFile, this.secret);
    const tampered = (main.exists && !main.ok) || (backup.exists && !backup.ok);
    const starts = [main, backup].filter((x) => x.ok && x.body?.trialStartedAt).map((x) => x.body.trialStartedAt);

    this.state = {
      // Earliest known trial start wins; a forged file ends the trial instead of restarting it.
      trialStartedAt: tampered ? 0 : starts.length ? Math.min(...starts) : now,
      lastSeenAt: Math.max(main.ok ? main.body.lastSeenAt || 0 : 0, backup.ok ? backup.body.lastSeenAt || 0 : 0),
      key: '',
      instanceId: '',
      licenseStatus: '',
      expiresAt: null,
      lastValidatedAt: 0,
      customerEmail: '',
      ...(main.ok ? pick(main.body) : {}),
    };
    if (tampered && main.body?.key) {
      // Keep the key but force an online check before it counts again.
      this.state.key = main.body.key;
      this.state.instanceId = main.body.instanceId || '';
      this.state.lastValidatedAt = 0;
    }
    this.touch();
  }

  // Clock rollback protection: time never goes backwards for trial/grace maths.
  clock() {
    return Math.max(this.now(), this.state.lastSeenAt || 0);
  }

  touch() {
    this.state.lastSeenAt = this.clock();
    this.save();
  }

  save() {
    writeSigned(this.file, this.secret, this.state);
    writeSigned(this.backupFile, this.secret, { trialStartedAt: this.state.trialStartedAt, lastSeenAt: this.state.lastSeenAt });
  }

  trialEndsAt() {
    return this.state.trialStartedAt + this.cfg.trialDays * DAY;
  }

  hasActiveLicense() {
    const s = this.state;
    if (!s.key || s.licenseStatus !== 'active') return false;
    if (s.expiresAt && Date.parse(s.expiresAt) < this.clock()) return false;
    return this.clock() - s.lastValidatedAt < this.cfg.offlineGraceDays * DAY;
  }

  isPro() {
    return this.hasActiveLicense() || this.clock() < this.trialEndsAt();
  }

  can(feature) {
    return !(feature in PRO_FEATURES) || this.isPro();
  }

  status() {
    const t = this.clock();
    const licensed = this.hasActiveLicense();
    const trialLeftMs = Math.max(0, this.trialEndsAt() - t);
    return {
      plan: licensed ? 'pro' : trialLeftMs > 0 ? 'trial' : 'expired',
      trialEndsAt: this.trialEndsAt(),
      trialDaysLeft: Math.ceil(trialLeftMs / DAY),
      trialDays: this.cfg.trialDays,
      key: maskKey(this.state.key),
      licenseStatus: this.state.licenseStatus,
      expiresAt: this.state.expiresAt,
      customerEmail: this.state.customerEmail,
      lastValidatedAt: this.state.lastValidatedAt,
      priceLabel: this.cfg.priceLabel,
      checkoutUrl: this.cfg.checkoutUrl,
      storeConfigured: Boolean(this.cfg.storeId && this.cfg.productId),
      features: PRO_FEATURES,
    };
  }

  async call(action, params) {
    const res = await this.fetch(`${API}/${action}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15000),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    return { httpOk: res.ok, httpStatus: res.status, data };
  }

  // Rejects keys issued for some other Lemon Squeezy store or product.
  assertStoreConfigured() {
    if (!this.cfg.storeId || !this.cfg.productId) throw new Error('Магазин не настроен: укажите storeId и productId в package.json → "tiklive"');
  }

  checkMeta(meta = {}) {
    this.assertStoreConfigured();
    if (String(meta.store_id) !== String(this.cfg.storeId) || String(meta.product_id) !== String(this.cfg.productId))
      throw new Error('Этот ключ выдан не для TikLive Pro');
  }

  applyKeyInfo(info = {}, meta = {}) {
    this.state.licenseStatus = info.status || '';
    this.state.expiresAt = info.expires_at || null;
    if (meta.customer_email) this.state.customerEmail = meta.customer_email;
  }

  async activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (!/^[\w-]{8,}$/.test(key)) throw new Error('Неверный формат ключа');
    this.assertStoreConfigured();
    let reply;
    try {
      reply = await this.call('activate', { license_key: key, instance_name: this.instanceName });
    } catch (err) {
      throw new Error(`Нет связи с сервером лицензий: ${err.message}`);
    }
    const { data, httpStatus } = reply;
    if (!data.activated) throw new Error(data.error || `Сервер лицензий недоступен (HTTP ${httpStatus})`);
    this.checkMeta(data.meta);
    Object.assign(this.state, { key, instanceId: data.instance?.id || '', lastValidatedAt: this.clock() });
    this.applyKeyInfo(data.license_key, data.meta);
    this.save();
    this.emit();
    if (this.state.licenseStatus !== 'active') throw new Error(`Ключ активирован, но подписка не активна (${this.state.licenseStatus})`);
    return this.status();
  }

  // Periodic online check. Network failures keep the cached state (offline grace period applies).
  async validate() {
    if (!this.state.key) return this.status();
    try {
      const { httpOk, data } = await this.call('validate', { license_key: this.state.key, ...(this.state.instanceId ? { instance_id: this.state.instanceId } : {}) });
      if (data.valid) {
        this.checkMeta(data.meta);
        this.applyKeyInfo(data.license_key, data.meta);
        this.state.lastValidatedAt = this.clock();
      } else if (httpOk || data.error) {
        // The server answered "not valid": subscription cancelled/expired, key disabled or instance removed.
        this.state.licenseStatus = data.license_key?.status || 'invalid';
      }
    } catch {
      // offline — try again later
    }
    this.touch();
    this.emit();
    return this.status();
  }

  async deactivate() {
    if (this.state.key && this.state.instanceId) {
      try {
        await this.call('deactivate', { license_key: this.state.key, instance_id: this.state.instanceId });
      } catch {}
    }
    Object.assign(this.state, { key: '', instanceId: '', licenseStatus: '', expiresAt: null, lastValidatedAt: 0, customerEmail: '' });
    this.save();
    this.emit();
    return this.status();
  }

  startAutoValidate() {
    this.validate();
    this.timer = setInterval(() => this.validate(), this.cfg.revalidateHours * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}

function pick(b) {
  const keys = ['key', 'instanceId', 'licenseStatus', 'expiresAt', 'lastValidatedAt', 'customerEmail'];
  return Object.fromEntries(keys.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
}
