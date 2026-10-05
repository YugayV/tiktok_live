// AI answers to viewer questions via the Claude API.
// Requests run one at a time (chat bursts must not fan out into parallel paid calls)
// and are capped per minute.

import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_AI = {
  enabled: false,
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  maxPerMinute: 6,
  maxAnswerChars: 220,
  persona:
    'Ты — весёлый помощник стримера в TikTok LIVE. Отвечай на вопросы зрителей на их языке, коротко (1–2 предложения, до 200 символов), дружелюбно, без markdown и списков. Не выдумывай факты о самом стримере: если не знаешь, так и скажи.',
  streamInfo: '',
};

const SKIP = Symbol('skip');

export class AiResponder {
  constructor({ getConfig, createClient = (opts) => new Anthropic(opts), now = () => Date.now() }) {
    this.getConfig = getConfig;
    this.createClient = createClient;
    this.now = now;
    this.chain = Promise.resolve();
    this.recent = []; // timestamps of calls in the last minute
    this.pending = 0;
    this.client = null;
    this.clientKey = null;
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

  // Resolves to the answer text, or null when skipped (disabled, rate limited, busy, refused).
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
    const system = [cfg.persona, cfg.streamInfo && `О стриме: ${cfg.streamInfo}`].filter(Boolean).join('\n\n');
    const response = await this.getClient().beta.messages.create({
      model: cfg.model || DEFAULT_AI.model,
      max_tokens: 2048,
      output_config: { effort: cfg.effort || 'low' },
      // On a safety decline the API re-runs the request on a suitable fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: `Зритель ${user.nickname || 'аноним'} спрашивает: ${question.slice(0, 500)}` }],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return null;
    const max = cfg.maxAnswerChars || 220;
    return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
  }
}
