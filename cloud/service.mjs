// TikLive cloud: answers viewer questions with Claude on behalf of the desktop app.
// The Anthropic key never leaves this server; every request is authorised here:
//  - Pro: "Authorization: Bearer <license key>", validated against the Lemon Squeezy
//    License API (store/product must match, status must be active), cached briefly;
//  - trial: no key, identified by the app's deviceId; a server-side trial starts on the
//    first question and is limited in days and answers, with a cap on new trials per IP.
// Monthly answer quotas keep the Claude bill below the subscription price.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { askClaude, buildSystem, LIMITS } from '../src/ai.mjs';

const DAY = 86400000;
const LS_VALIDATE = 'https://api.lemonsqueezy.com/v1/licenses/validate';

export const CLOUD_DEFAULTS = {
  storeId: null,
  productId: null,
  model: 'claude-opus-5-5',
  effort: 'low',
  proMonthlyLimit: 500, // answers per subscriber per calendar month
  trialDays: 7,
  trialLimit: 100, // answers per trial in total
  trialsPerIp: 2, // new trials per IP per 30 days
  perMinute: 10, // answers per credential per minute
  maxConcurrent: 8, // parallel Claude calls across all users
  licenseCacheMs: 10 * 60 * 1000,
};

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const monthKey = (t) => new Date(t).toISOString().slice(0, 7);

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = { trials: {}, usage: {}, ipTrials: {} };
    if (file && existsSync(file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch (err) {
        console.error(`[store] cannot read ${file}: ${err.message}`);
      }
    }
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class CloudService {
  constructor({ anthropic, fetchImpl = globalThis.fetch, store = new JsonStore(null), now = () => Date.now(), config = {}, log = console.log }) {
    this.anthropic = anthropic;
    this.fetch = fetchImpl;
    this.store = store;
    this.now = now;
    this.cfg = { ...CLOUD_DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v != null && v !== '')) };
    this.log = log;
    this.licenseCache = new Map(); // keyHash -> { until, ok, reason }
    this.minute = new Map(); // credential -> timestamps
    this.inFlight = 0;
  }

  // ---- auth ---------------------------------------------------------------
  async checkLicense(key, instanceId) {
    const h = sha(key);
    const cached = this.licenseCache.get(h);
    if (cached && cached.until > this.now()) return cached;
    let result;
    try {
      const res = await this.fetch(LS_VALIDATE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ license_key: key, ...(instanceId ? { instance_id: instanceId } : {}) }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      // No verdict (outage, proxy error page): treat as unreachable, never as "invalid key".
      if (typeof data.valid !== 'boolean') throw new Error(`HTTP ${res.status}`);
      const meta = data.meta || {};
      if (!data.valid) result = { ok: false, reason: data.error || 'ключ недействителен' };
      else if (String(meta.store_id) !== String(this.cfg.storeId) || String(meta.product_id) !== String(this.cfg.productId)) result = { ok: false, reason: 'ключ выдан не для TikLive Pro' };
      else if (data.license_key?.status !== 'active') result = { ok: false, reason: `подписка не активна (${data.license_key?.status})` };
      else result = { ok: true };
      result.until = this.now() + (result.ok ? this.cfg.licenseCacheMs : 60000);
    } catch (err) {
      // License server unreachable: trust a recent positive answer, otherwise fail closed.
      if (cached?.ok && this.now() - cached.until < DAY) return cached;
      throw new HttpError(503, `Сервер лицензий недоступен, попробуйте позже (${err.message})`);
    }
    this.licenseCache.set(h, result);
    return result;
  }

  async authorize({ authorization, deviceId, instanceId, ip }) {
    const now = this.now();
    const key = /^Bearer\s+(.+)$/i.exec(authorization || '')?.[1]?.trim();
    if (key) {
      const lic = await this.checkLicense(key, instanceId);
      if (!lic.ok) throw new HttpError(402, `TikLive Pro: ${lic.reason}`);
      const id = `pro:${sha(key)}`;
      const usage = (this.store.data.usage[id] ||= { month: monthKey(now), used: 0 });
      if (usage.month !== monthKey(now)) Object.assign(usage, { month: monthKey(now), used: 0 });
      return { id, plan: 'pro', used: () => usage.used, limit: this.cfg.proMonthlyLimit, count: () => usage.used++ };
    }

    if (!deviceId || !/^[\w-]{16,128}$/.test(deviceId)) throw new HttpError(402, 'Нужна подписка TikLive Pro');
    const id = `trial:${sha(deviceId)}`;
    let trial = this.store.data.trials[id];
    if (!trial) {
      const ipKey = sha(ip || 'unknown');
      const recent = (this.store.data.ipTrials[ipKey] || []).filter((t) => now - t < 30 * DAY);
      if (recent.length >= this.cfg.trialsPerIp) throw new HttpError(402, 'Пробный период уже использован. Оформите TikLive Pro, чтобы продолжить.');
      this.store.data.ipTrials[ipKey] = [...recent, now];
      trial = this.store.data.trials[id] = { startedAt: now, used: 0 };
      this.store.save();
    }
    if (now > trial.startedAt + this.cfg.trialDays * DAY) throw new HttpError(402, 'Пробный период закончился. Оформите TikLive Pro, чтобы ИИ продолжал отвечать.');
    return { id, plan: 'trial', used: () => trial.used, limit: this.cfg.trialLimit, count: () => trial.used++ };
  }

  rateLimit(id) {
    const now = this.now();
    const list = (this.minute.get(id) || []).filter((t) => now - t < 60000);
    if (list.length >= this.cfg.perMinute) throw new HttpError(429, 'Слишком много вопросов подряд, подождите минуту');
    list.push(now);
    this.minute.set(id, list);
    if (this.minute.size > 10000) this.minute.clear(); // bounded memory
  }

  // ---- main endpoint ------------------------------------------------------
  // Returns { status, body } so the HTTP layer stays trivial and tests need no sockets.
  async answer(body = {}, { authorization = '', ip = '' } = {}) {
    try {
      const question = String(body.question || '').trim();
      if (!question) throw new HttpError(400, 'Пустой вопрос');
      const who = await this.authorize({ authorization, deviceId: body.deviceId, instanceId: body.instanceId, ip });
      const quota = () => ({ plan: who.plan, used: who.used(), limit: who.limit });
      if (who.used() >= who.limit)
        throw new HttpError(429, who.plan === 'pro' ? 'Лимит ответов ИИ на этот месяц исчерпан' : 'Лимит ответов пробного периода исчерпан. Оформите TikLive Pro.', { quota: quota() });
      this.rateLimit(who.id);
      if (this.inFlight >= this.cfg.maxConcurrent) throw new HttpError(503, 'Сервер ИИ перегружен, попробуйте через минуту');

      this.inFlight++;
      who.count(); // every Claude call costs money, declined or not
      this.store.save();
      let answer;
      try {
        answer = await askClaude(this.anthropic, {
          model: this.cfg.model,
          effort: this.cfg.effort,
          system: buildSystem(body.persona, body.streamInfo),
          question: question.slice(0, LIMITS.question),
          nickname: body.nickname,
          maxChars: Math.max(50, Math.min(300, Number(body.maxChars) || 220)),
        });
      } catch (err) {
        this.log(`[ai] Claude error: ${err?.status || ''} ${err?.message || err}`);
        throw new HttpError(502, 'ИИ временно недоступен, попробуйте позже', { quota: quota() });
      } finally {
        this.inFlight--;
      }
      return { status: 200, body: { answer, quota: quota() } };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message, ...err.extra } };
      this.log(`[cloud] unexpected: ${err?.stack || err}`);
      return { status: 500, body: { error: 'Внутренняя ошибка сервера' } };
    }
  }
}
