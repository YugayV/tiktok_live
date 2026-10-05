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
      enableExtendedGiftInfo: true,
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
      this.setState('error', { error: err?.message || String(err) });
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
