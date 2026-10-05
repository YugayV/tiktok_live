// Song request queue: viewers request with "!sr <name or YouTube link>",
// limits per viewer, priority boost for gifters, moderator skip.

export const DEFAULT_SONGS = {
  enabled: true,
  requestCommand: '!sr,!song,!песня',
  currentCommand: '!np,!трек',
  removeCommand: '!wrongsong,!отмена',
  skipCommand: '!skip',
  maxPerUser: 2,
  maxQueue: 50,
  cost: 0,
  youtubeOnly: false,
  autoplay: true,
};

const YT = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/i;

export function youtubeId(text) {
  const m = YT.exec(String(text || ''));
  return m ? m[1] : '';
}

let seq = 0;

export class SongQueue {
  constructor({ getConfig = () => DEFAULT_SONGS } = {}) {
    this.getConfig = getConfig;
    this.items = [];
    this.current = null;
    this.history = [];
  }

  // Returns { ok, song?, error? } — errors are short Russian strings suitable for alerts.
  request(user, text, { priority = 0 } = {}) {
    const cfg = this.getConfig();
    const query = String(text || '').trim().slice(0, 200);
    if (!query) return { ok: false, error: 'укажите название или ссылку' };
    const videoId = youtubeId(query);
    if (cfg.youtubeOnly && !videoId) return { ok: false, error: 'нужна ссылка на YouTube' };
    if (this.items.length >= cfg.maxQueue) return { ok: false, error: 'очередь заполнена' };
    const mine = this.items.filter((s) => s.uniqueId === user.uniqueId).length;
    if (cfg.maxPerUser && mine >= cfg.maxPerUser) return { ok: false, error: `не больше ${cfg.maxPerUser} песен в очереди` };
    const key = (videoId || query).toLowerCase();
    if (this.items.some((s) => (s.videoId || s.query).toLowerCase() === key) || (this.current && (this.current.videoId || this.current.query).toLowerCase() === key))
      return { ok: false, error: 'эта песня уже в очереди' };

    const song = {
      id: `s${Date.now().toString(36)}${(seq++).toString(36)}`,
      query,
      title: videoId ? '' : query,
      videoId,
      uniqueId: user.uniqueId,
      nickname: user.nickname,
      priority,
      requestedAt: Date.now(),
    };
    this.insert(song);
    return { ok: true, song, position: this.items.indexOf(song) + 1 };
  }

  insert(song) {
    let i = this.items.findIndex((x) => x.priority < song.priority);
    if (i === -1) i = this.items.length;
    this.items.splice(i, 0, song);
  }

  // Moves the viewer's earliest queued song up by `amount` priority (e.g. after a gift).
  bump(uniqueId, amount = 1) {
    const song = this.items.find((s) => s.uniqueId === uniqueId);
    if (!song) return null;
    this.items.splice(this.items.indexOf(song), 1);
    song.priority += amount;
    this.insert(song);
    return song;
  }

  next() {
    if (this.current) this.history.unshift(this.current);
    this.history.length = Math.min(this.history.length, 20);
    this.current = this.items.shift() || null;
    return this.current;
  }

  remove(id) {
    const i = this.items.findIndex((s) => s.id === id);
    return i === -1 ? null : this.items.splice(i, 1)[0];
  }

  removeLastOf(uniqueId) {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].uniqueId === uniqueId) return this.items.splice(i, 1)[0];
    return null;
  }

  setTitle(id, title) {
    const s = this.current?.id === id ? this.current : this.items.find((x) => x.id === id);
    if (s && title) s.title = String(title).slice(0, 120);
  }

  clear() {
    this.items = [];
  }

  snapshot() {
    return { current: this.current, queue: this.items, history: this.history.slice(0, 5) };
  }
}
