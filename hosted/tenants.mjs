// One Studio per user: own data dir, TikTok connection, rules, overlays and WebSocket clients.
// Tenants start on demand (dashboard, overlay or auto-connect) and are evicted when idle.

import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Studio } from '../src/studio.mjs';
import { License } from '../src/license.mjs';
import { AiError } from '../src/ai.mjs';
import { buildRoutes } from '../src/server-app.mjs';
import { subscriptionActive, checkoutUrlFor } from './billing.mjs';

const IDLE_MS = 30 * 60 * 1000;
const NOOP_KEYS = { name: 'disabled-in-web', down: () => {}, up: () => {} };
const DESKTOP_ONLY = 'Доступно только в приложении для ПК: сервер не может нажимать клавиши или управлять OBS на вашем компьютере.';
const LIVE_STATES = new Set(['connecting', 'connected', 'reconnecting']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class TenantManager {
  constructor({
    dataDir,
    accounts,
    anthropic = null, // shared Claude client; null = AI disabled on this server
    ai = {},
    licenseConfig = {},
    serverSecret,
    signApiKey = '',
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    log = console.log,
  }) {
    if (!serverSecret) throw new Error('serverSecret is required');
    this.dataDir = dataDir;
    this.accounts = accounts;
    this.anthropic = anthropic;
    this.ai = { model: 'claude-opus-5-5', effort: 'low', proMonthlyLimit: 500, trialLimit: 100, ...Object.fromEntries(Object.entries(ai).filter(([, v]) => v != null && v !== '')) };
    this.licenseConfig = licenseConfig;
    this.serverSecret = serverSecret;
    this.signApiKey = signApiKey;
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.tenants = new Map();
    this.sweeper = setInterval(() => this.evictIdle(), 5 * 60 * 1000);
    this.sweeper.unref?.();
  }

  userDir(userId) {
    return join(this.dataDir, 'users', userId);
  }

  get(userId) {
    let t = this.tenants.get(userId);
    if (!t) {
      t = this.create(userId);
      this.tenants.set(userId, t);
    }
    t.lastActive = this.now();
    return t;
  }

  create(userId) {
    const dir = this.userDir(userId);
    mkdirSync(dir, { recursive: true });
    const clients = new Set();
    const broadcast = (type, payload) => {
      const msg = JSON.stringify({ type, payload });
      for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
    };
    // Subscription belongs to the account, not a machine: the trial starts at sign-up.
    const account = this.accounts.user(userId);
    const license = new License({
      file: join(dir, 'license.json'),
      backupFile: null,
      // The checkout link carries the account id, so the webhook can grant Pro without a key.
      config: { ...this.licenseConfig, checkoutUrl: checkoutUrlFor(this.licenseConfig.checkoutUrl, { email: account?.email, userId }) },
      entitlement: () => {
        const sub = this.accounts.user(userId)?.subscription;
        return sub ? { active: subscriptionActive(sub, this.now()), status: sub.status, expiresAt: sub.endsAt || sub.renewsAt, manageUrl: sub.manageUrl } : null;
      },
      fetchImpl: this.fetch,
      now: this.now,
      secret: createHmac('sha256', this.serverSecret).update(`license:${userId}`).digest(),
      instanceName: `web-${userId}`,
    });
    const studio = new Studio({ dataDir: dir, broadcast, fetchImpl: this.fetch, license, keyDriver: NOOP_KEYS, createAiClient: () => this.aiClient(userId, license) });
    this.enforceHostedSettings(studio);

    // The server's TikTok signing key is used for everyone but never written into user config
    // (config is sent to the browser).
    studio.connect = async (username) => {
      const s = studio.cfg.settings;
      if (username) {
        s.username = username;
        studio.config.save();
      }
      return studio.source.connect(s.username, { autoReconnect: true, signApiKey: this.signApiKey || s.signApiKey });
    };

    const user = this.accounts.user(userId);
    const baseState = studio.state.bind(studio);
    studio.state = () => ({
      ...baseState(),
      hosted: { email: this.accounts.user(userId)?.email, overlayPath: `/o/${this.accounts.user(userId)?.overlayToken}/`, desktopOnly: ['keyboard', 'obs'], aiReady: Boolean(this.anthropic) },
    });

    const routes = buildRoutes(studio, broadcast);
    const desktopOnly = () => {
      throw new HttpError(400, DESKTOP_ONLY);
    };
    const putConfig = routes['PUT /api/config'];
    const connect = routes['POST /api/connect'];
    const disconnect = routes['POST /api/disconnect'];
    Object.assign(routes, {
      'POST /api/obs/connect': desktopOnly,
      'POST /api/keys/test': desktopOnly,
      'PUT /api/config': (b) => {
        if (b.settings) b.settings.signApiKey = String(b.settings.signApiKey || '').slice(0, 200);
        const out = putConfig(b);
        this.enforceHostedSettings(studio);
        return out;
      },
      'POST /api/connect': async (b) => {
        const out = await connect(b);
        this.accounts.setAutoConnect(userId, true);
        return out;
      },
      'POST /api/disconnect': async (b) => {
        this.accounts.setAutoConnect(userId, false);
        return disconnect(b);
      },
      'GET /api/account': () => ({ email: this.accounts.user(userId)?.email, overlayPath: `/o/${this.accounts.user(userId)?.overlayToken}/` }),
      'POST /api/overlay/rotate': () => {
        const overlayToken = this.accounts.rotateOverlayToken(userId);
        for (const ws of clients) if (ws.kind === 'overlay') ws.close(4404, 'overlay link rotated');
        return { overlayPath: `/o/${overlayToken}/` };
      },
    });

    studio.license.startAutoValidate();
    this.log(`[tenant] started ${userId} (${user?.email})`);
    return { userId, studio, clients, routes, lastActive: this.now() };
  }

  // Push the new plan to an open dashboard right after a subscription webhook.
  notifyLicense(userId) {
    const t = this.tenants.get(userId);
    if (t) t.studio.license.emit();
  }

  // Settings that make no sense on a shared server are pinned regardless of what the browser sends.
  enforceHostedSettings(studio) {
    const s = studio.cfg.settings;
    s.ai.mode = 'own'; // answered by the server's Claude client below, with quotas
    s.keyboard.enabled = false;
    s.obs.enabled = false;
  }

  usageFile(userId) {
    return join(this.userDir(userId), 'ai-usage.json');
  }

  // Claude client handed to the user's AiResponder: enforces plan quotas, pins model and effort.
  aiClient(userId, license) {
    return {
      beta: {
        messages: {
          create: async (req) => {
            if (!this.anthropic) throw new AiError('ИИ на этом сервере не настроен', 503);
            const plan = license.status().plan;
            if (plan === 'expired') throw new AiError('Пробный период закончился — оформите TikLive Pro, чтобы ИИ продолжал отвечать', 402);
            const month = new Date(this.now()).toISOString().slice(0, 7);
            const file = this.usageFile(userId);
            const u = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { month, used: 0, trialUsed: 0 };
            if (u.month !== month) Object.assign(u, { month, used: 0 });
            const [used, limit] = plan === 'pro' ? [u.used, this.ai.proMonthlyLimit] : [u.trialUsed, this.ai.trialLimit];
            if (used >= limit) throw new AiError(plan === 'pro' ? 'Лимит ответов ИИ на этот месяц исчерпан' : 'Лимит ответов ИИ пробного периода исчерпан', 429);
            if (plan === 'pro') u.used++;
            else u.trialUsed++;
            writeFileSync(file, JSON.stringify(u));
            return this.anthropic.beta.messages.create({ ...req, model: this.ai.model, output_config: { ...req.output_config, effort: this.ai.effort } });
          },
        },
      },
    };
  }

  // After a restart, streams that were connected come back on their own.
  async autostart({ delayMs = 2000 } = {}) {
    for (const id of this.accounts.allUserIds()) {
      if (!this.accounts.user(id)?.autoConnect) continue;
      const t = this.get(id);
      if (t.studio.cfg.settings.username) t.studio.connect().catch((e) => this.log(`[tenant] autostart ${id}: ${e.message}`));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); // don't hammer TikTok/sign server at once
    }
  }

  isIdle(t) {
    return t.clients.size === 0 && !LIVE_STATES.has(t.studio.source.state) && !t.studio.sim.running && this.now() - t.lastActive > IDLE_MS;
  }

  async evictIdle() {
    for (const [id, t] of this.tenants) {
      if (!this.isIdle(t)) continue;
      this.tenants.delete(id);
      await t.studio.shutdown().catch(() => {});
      this.log(`[tenant] evicted idle ${id}`);
    }
  }

  async shutdown() {
    clearInterval(this.sweeper);
    await Promise.all([...this.tenants.values()].map((t) => t.studio.shutdown().catch(() => {})));
    this.tenants.clear();
  }
}
