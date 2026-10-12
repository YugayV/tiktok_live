// Decides which chat messages are worth reading aloud. Live chat is full of noise —
// "1", "+", emoji walls, "ааааааа", links, the same line pasted ten times — and reading
// all of it makes TTS useless. Every rule here can be switched off in settings.

export const DEFAULT_CHAT_TTS = {
  enabled: false,
  template: '{nickname}: {text}',
  readNames: true,
  skipCommands: true,
  minLength: 3,
  skipEmojiOnly: true,
  skipLinks: true,
  skipRepeats: true,
  perUserCooldownSec: 10,
  maxPerMinute: 12,
  onlyFollowers: false,
  blockUsers: '',
  blockWords: '',
};

const LETTER = /[\p{L}\p{N}]/u;
const SHORT_NOISE = new Set(['+', '++', '+++', '1', '11', '111', '0', '?', '??', '!', '.', 'ок', 'ok', 'k', 'да', 'нет', 'lol', 'лол', 'ахах', 'хах', 'хд', 'xd']);

const list = (s) =>
  String(s || '')
    .split(/[,\n]/)
    .map((w) => w.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

// "ааааааа!!!!!!" → "ааа!!!": keeps meaning, kills the 10-second scream.
export function collapseRepeats(text) {
  return String(text).replace(/(.)\1{2,}/gu, '$1$1$1');
}

// Text that will actually be spoken: no emoji, no links, squeezed whitespace.
export function cleanForSpeech(text) {
  return collapseRepeats(
    String(text)
      .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export class ChatReader {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.lastByUser = new Map();
    this.recentTexts = [];
    this.spoken = [];
  }

  // Returns { ok: true, text } with the phrase to speak, or { ok: false, reason }.
  check(ev, cfg = DEFAULT_CHAT_TTS) {
    const c = { ...DEFAULT_CHAT_TTS, ...cfg };
    const raw = String(ev.text || '').trim();
    const nick = String(ev.user?.uniqueId || '').toLowerCase();
    const now = this.now();
    if (!c.enabled) return { ok: false, reason: 'off' };
    if (c.skipCommands && /^[!/]/.test(raw)) return { ok: false, reason: 'command' };
    if (list(c.blockUsers).some((u) => u === nick || u === String(ev.user?.nickname || '').toLowerCase())) return { ok: false, reason: 'blocked-user' };
    if (c.onlyFollowers && !(ev.user?.isFollower || ev.user?.isSubscriber || ev.user?.isModerator)) return { ok: false, reason: 'not-follower' };
    if (c.skipLinks && /https?:\/\/|www\./i.test(raw)) return { ok: false, reason: 'link' };
    const lower = raw.toLowerCase();
    if (list(c.blockWords).some((w) => lower.includes(w))) return { ok: false, reason: 'blocked-word' };

    const text = cleanForSpeech(raw);
    if (c.skipEmojiOnly && !LETTER.test(text)) return { ok: false, reason: 'emoji' };
    const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    if (letters < (Number(c.minLength) || 0) || SHORT_NOISE.has(text.toLowerCase().replace(/[\s!?.]+$/g, '') || text)) return { ok: false, reason: 'short' };

    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    this.recentTexts = this.recentTexts.filter((r) => now - r.ts < 60000);
    if (c.skipRepeats && this.recentTexts.some((r) => r.key === key)) return { ok: false, reason: 'repeat' };

    const cd = (Number(c.perUserCooldownSec) || 0) * 1000;
    if (cd && now - (this.lastByUser.get(nick) ?? -Infinity) < cd) return { ok: false, reason: 'cooldown' };
    this.spoken = this.spoken.filter((t) => now - t < 60000);
    if (c.maxPerMinute > 0 && this.spoken.length >= c.maxPerMinute) return { ok: false, reason: 'rate' };

    this.recentTexts.push({ key, ts: now });
    this.lastByUser.set(nick, now);
    this.spoken.push(now);
    if (this.lastByUser.size > 2000) this.lastByUser.clear();
    const name = cleanForSpeech(ev.user?.nickname || ev.user?.uniqueId || '') || 'Зритель';
    const template = c.readNames ? c.template || '{nickname}: {text}' : '{text}';
    return { ok: true, text: template.replaceAll('{nickname}', name).replaceAll('{text}', text) };
  }
}
