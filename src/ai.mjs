// AI answers to viewer questions.
//
// Two modes:
//  - "cloud" (default): the app sends the question to the TikLive cloud service
//    (cloud/server.mjs). The Anthropic key lives only on that server, and the server
//    checks the trial/subscription itself, so the paywall cannot be patched out locally.
//  - "own": the streamer's own Anthropic API key, calling the Claude API directly.
//
// Requests run one at a time (chat bursts must not fan out into parallel paid calls)
// and are capped per minute on the client; the cloud enforces its own quotas too.

import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_AI = {
  enabled: false,
  mode: 'cloud',
  cloudUrl: '', // empty = package.json → tiklive.cloudUrl
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  maxPerMinute: 6,
  maxAnswerChars: 220,
  persona:
    'Ты — весёлый помощник стримера в TikTok LIVE. Отвечай на вопросы зрителей на их языке, коротко (1–2 предложения, до 200 символов), дружелюбно, без markdown и списков. Не выдумывай факты о самом стримере: если не знаешь, так и скажи.',
  streamInfo: '',
};

export const LIMITS = { question: 500, persona: 1500, streamInfo: 1500, nickname: 40 };

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// One Claude call shared by the "own key" mode and the cloud service.
// Returns the answer text, or null when the model declined or returned nothing.
export async function askClaude(client, { model = DEFAULT_AI.model, effort = 'low', system, question, nickname, maxChars = 220 }) {
  const response = await client.beta.messages.create({
    model,
    max_tokens: 2048,
    output_config: { effort },
    // On a safety decline the API re-runs the request on a suitable fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: `Зритель ${clip(nickname, LIMITS.nickname) || 'аноним'} спрашивает: ${clip(question, LIMITS.question)}` }],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
  return clip(text, maxChars) || null;
}

export function buildSystem(persona, streamInfo) {
  return [clip(persona, LIMITS.persona), streamInfo && `О стриме: ${clip(streamInfo, LIMITS.streamInfo)}`].filter(Boolean).join('\n\n');
}

export class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const SKIP = Symbol('skip');

export class AiResponder {
  constructor({
    getConfig,
    getCloud = () => ({ url: '', licenseKey: '', instanceId: '', deviceId: '' }),
    createClient = (opts) => new Anthropic(opts),
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  }) {
    this.getConfig = getConfig;
    this.getCloud = getCloud;
    this.createClient = createClient;
    this.fetch = fetchImpl;
    this.now = now;
    this.chain = Promise.resolve();
    this.recent = []; // timestamps of calls in the last minute
    this.pending = 0;
    this.client = null;
    this.clientKey = null;
    this.quota = null; // last quota info reported by the cloud
  }

  getClient() {
    const key = this.getConfig().apiKey || undefined;
    if (!this.client || this.clientKey !== key) {
      // No key in settings → the SDK falls back to ANTHROPIC_API_KEY / `ant auth login`.
      this.client = this.createClient(key ? { apiKey: key } : {});
      this.clientKey = key;
    }
    return this.client;
  }

  // Resolves to the answer text, or null when skipped (disabled, rate limited, busy, declined).
  // Cloud errors with a reason (subscription, quota) reject with AiError.
  ask(question, user = {}) {
    const cfg = this.getConfig();
    const q = String(question || '').trim();
    if (!cfg.enabled || !q) return Promise.resolve(null);
    const now = this.now();
    this.recent = this.recent.filter((t) => now - t < 60000);
    if (this.recent.length + this.pending >= cfg.maxPerMinute || this.pending >= 3) return Promise.resolve(null);
    this.pending++;
    const job = this.chain.then(() => this.call(q, user, cfg)).finally(() => this.pending--);
    this.chain = job.catch(() => SKIP);
    return job;
  }

  async call(question, user, cfg) {
    this.recent.push(this.now());
    const maxChars = cfg.maxAnswerChars || 220;
    if (cfg.mode === 'own') {
      return askClaude(this.getClient(), {
        model: cfg.model || DEFAULT_AI.model,
        effort: cfg.effort || 'low',
        system: buildSystem(cfg.persona, cfg.streamInfo),
        question,
        nickname: user.nickname,
        maxChars,
      });
    }
    return this.callCloud(question, user, cfg, maxChars);
  }

  async callCloud(question, user, cfg, maxChars) {
    const cloud = this.getCloud();
    const base = String(cfg.cloudUrl || cloud.url || '').replace(/\/+$/, '');
    if (!base) throw new AiError('Облако TikLive не настроено (cloudUrl). Выберите режим «свой ключ» или укажите адрес сервера.', 503);
    let res;
    try {
      res = await this.fetch(`${base}/v1/ai/answer`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cloud.licenseKey ? { authorization: `Bearer ${cloud.licenseKey}` } : {}),
        },
        body: JSON.stringify({
          question: clip(question, LIMITS.question),
          nickname: clip(user.nickname, LIMITS.nickname),
          persona: clip(cfg.persona, LIMITS.persona),
          streamInfo: clip(cfg.streamInfo, LIMITS.streamInfo),
          maxChars,
          instanceId: cloud.instanceId || undefined,
          deviceId: cloud.deviceId || undefined,
        }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (err) {
      throw new AiError(`Облако TikLive недоступно: ${err.message}`, 503);
    }
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (data.quota) this.quota = data.quota;
    if (!res.ok) throw new AiError(data.error || `Облако TikLive: HTTP ${res.status}`, res.status);
    return data.answer || null;
  }
}
