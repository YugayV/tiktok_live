// Personal entrance videos: when a viewer joins the LIVE, the alerts overlay plays the video
// set for that viewer (or a common one for everybody). Each viewer is greeted once per session
// (or once per N minutes), so reconnects and app restarts mid-stream don't replay it.

export const DEFAULT_ENTRANCES = {
  enabled: true,
  defaultVideo: '', // played for viewers without a personal video ('' = only listed viewers)
  defaultText: '👋 {nickname} заходит на эфир!',
  repeatMinutes: 0, // 0 = once per session
  duration: 10, // seconds, max; a shorter video ends earlier
  volume: 0.8,
  list: [], // { id, user, video, text }
};

const handle = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

// Media in the overlay: an uploaded file (media/<id>.<ext>) or a direct https link.
export function safeMediaUrl(url) {
  const u = String(url || '').trim();
  if (/^media\/[a-f0-9]{16}\.(mp4|webm|gif|png|jpe?g|webp)$/.test(u)) return u;
  if (/^https:\/\/[^\s"'<>]+$/i.test(u)) return u;
  return '';
}

export class Entrances {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.seen = new Map();
  }

  reset() {
    this.seen.clear();
  }

  // Returns the alert to show for a 'member' event, or null.
  check(ev, cfg = DEFAULT_ENTRANCES) {
    const c = { ...DEFAULT_ENTRANCES, ...cfg };
    const id = handle(ev.user?.uniqueId);
    if (!c.enabled || !id) return null;
    const entry = (c.list || []).find((e) => handle(e.user) === id && e.enabled !== false);
    const video = safeMediaUrl(entry ? entry.video : c.defaultVideo);
    if (!video) return null;
    const last = this.seen.get(id);
    const repeatMs = (Number(c.repeatMinutes) || 0) * 60000;
    if (last !== undefined && (!repeatMs || this.now() - last < repeatMs)) return null;
    this.seen.set(id, this.now());
    if (this.seen.size > 5000) this.seen.clear();
    return {
      video,
      text: (entry?.text || c.defaultText || '').replaceAll('{nickname}', ev.user.nickname || ev.user.uniqueId),
      duration: Math.max(2, Math.min(60, Number(c.duration) || 10)),
      volume: Math.max(0, Math.min(1, Number(c.volume ?? 0.8))),
    };
  }
}
