// Wrapper around tiktok-live-connector with exponential-backoff auto-reconnect
// and a single normalized `event` stream.

import { EventEmitter } from 'node:events';
import { normalize } from './normalize.mjs';

const EVENT_MAP = {
  chat: 'chat',
  gift: 'gift',
  like: 'like',
  follow: 'follow',
  share: 'share',
  member: 'member',
  subscribe: 'subscribe',
  roomUser: 'roomUser',
  questionNew: 'question',
  envelope: 'envelope',
};

// Turn library errors into something a streamer can act on.
export function explainError(err) {
  const name = err?.constructor?.name || err?.name || '';
  const msg = String(err?.message || err || '');
  if (name === 'UserOfflineError' || /isn't online|offline/i.test(msg)) return 'Стример сейчас не в эфире. Подключайтесь, когда эфир уже идёт — при включённом автопереподключении программа попробует снова сама.';
  if (name === 'InvalidUniqueIdError' || /invalid value for 'uniqueId'/i.test(msg)) return 'Неверный ник. Укажите ник из ссылки на профиль: tiktok.com/@ник';
  if (name === 'SignatureRateLimitError' || /rate.?limit|too many/i.test(msg)) return 'Достигнут лимит бесплатных подключений сервиса подписи (Euler Stream). Подождите несколько минут или укажите свой ключ Euler Stream в настройках.';
  if (name === 'PremiumFeatureError' || /Business plan|paid plan|permission from the signature provider/i.test(msg)) return `Сервис подписи TikTok (Euler Stream) отказал: ${msg.replace(/^\[[^\]]*\]\s*/g, '')}`;
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(msg)) return 'Нет связи с TikTok. Проверьте интернет, VPN или брандмауэр.';
  return msg;
}

export class TikTokSource extends EventEmitter {
  constructor() {
    super();
    this.conn = null;
    this.username = '';
    this.state = 'disconnected';
    this.retry = 0;
    this.retryTimer = null;
    this.wantConnected = false;
  }

  setState(state, info = {}) {
    this.state = state;
    this.emit('status', { state, username: this.username, ...info });
  }

  async connect(username, { autoReconnect = true, signApiKey = '' } = {}) {
    await this.disconnect();
    this.username = String(username).replace(/^@/, '').trim();
    if (!this.username) throw new Error('Укажите имя пользователя TikTok');
    this.wantConnected = true;
    this.autoReconnect = autoReconnect;
    this.signApiKey = signApiKey;
    return this.open();
  }

  async open() {
    const { TikTokLiveConnection } = await import('tiktok-live-connector');
    this.setState('connecting');
    if (this.conn) {
      this.conn.removeAllListeners();
      this.conn.disconnect().catch(() => {});
    }
    const conn = new TikTokLiveConnection(this.username, {
      // Must stay off: loading the gift catalogue needs a signed request that Euler Stream only
      // allows on its paid Business plan. Gift name/price/image already arrive in every gift event.
      enableExtendedGiftInfo: false,
      processInitialData: false,
      ...(this.signApiKey ? { signApiKey: this.signApiKey } : {}),
    });
    this.conn = conn;

    for (const [src, type] of Object.entries(EVENT_MAP)) {
      conn.on(src, (data) => {
        try {
          this.emit('event', normalize(type, data));
        } catch (err) {
          this.emit('warn', `normalize ${type}: ${err.message}`);
        }
      });
    }
    conn.on('streamEnd', () => {
      this.setState('ended');
      this.scheduleReconnect();
    });
    conn.on('disconnected', () => {
      if (this.conn !== conn) return;
      this.setState('disconnected');
      this.scheduleReconnect();
    });
    conn.on('error', (err) => this.emit('warn', err?.message || String(err)));

    try {
      const state = await conn.connect();
      this.retry = 0;
      this.setState('connected', { roomId: state?.roomId });
      return state;
    } catch (err) {
      this.setState('error', { error: explainError(err) });
      this.scheduleReconnect();
      throw err;
    }
  }

  scheduleReconnect() {
    if (!this.wantConnected || !this.autoReconnect || this.retryTimer) return;
    const delay = Math.min(60, 2 ** this.retry) * 1000 + Math.random() * 500;
    this.retry++;
    this.setState('reconnecting', { inMs: Math.round(delay) });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open().catch(() => {});
    }, delay);
  }

  async disconnect() {
    this.wantConnected = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      conn.removeAllListeners();
      await conn.disconnect().catch(() => {});
    }
    if (this.state !== 'disconnected') this.setState('disconnected');
  }
}
