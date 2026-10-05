// Live session analytics: totals, leaderboards, per-minute timeline and goals.

const TOP_N = 10;

function bump(map, user, field, amount) {
  const key = user.uniqueId;
  const row = map.get(key) || { uniqueId: key, nickname: user.nickname, avatar: user.avatar, diamonds: 0, likes: 0, chats: 0, gifts: 0 };
  row.nickname = user.nickname || row.nickname;
  row.avatar = user.avatar || row.avatar;
  row[field] += amount;
  map.set(key, row);
}

export class SessionStats {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.startedAt = this.now();
    this.totals = { diamonds: 0, gifts: 0, likes: 0, follows: 0, shares: 0, chats: 0, joins: 0, subscribes: 0 };
    this.viewers = 0;
    this.peakViewers = 0;
    this.users = new Map();
    this.timeline = []; // [{ minute, diamonds, likes, chats }]
    this.newFollowers = [];
  }

  minuteBucket() {
    const minute = Math.floor((this.now() - this.startedAt) / 60000);
    let last = this.timeline[this.timeline.length - 1];
    if (!last || last.minute !== minute) {
      last = { minute, diamonds: 0, likes: 0, chats: 0 };
      this.timeline.push(last);
      if (this.timeline.length > 240) this.timeline.shift();
    }
    return last;
  }

  record(ev) {
    const b = this.minuteBucket();
    switch (ev.type) {
      case 'gift':
        if (ev.streaking) return;
        this.totals.diamonds += ev.totalDiamonds;
        this.totals.gifts += ev.count;
        b.diamonds += ev.totalDiamonds;
        bump(this.users, ev.user, 'diamonds', ev.totalDiamonds);
        bump(this.users, ev.user, 'gifts', ev.count);
        break;
      case 'like':
        this.totals.likes = Math.max(this.totals.likes + ev.likes, ev.totalLikes || 0);
        b.likes += ev.likes;
        bump(this.users, ev.user, 'likes', ev.likes);
        break;
      case 'chat':
        this.totals.chats++;
        b.chats++;
        bump(this.users, ev.user, 'chats', 1);
        break;
      case 'follow':
        this.totals.follows++;
        this.newFollowers.unshift(ev.user.nickname);
        this.newFollowers.length = Math.min(this.newFollowers.length, 20);
        break;
      case 'share':
        this.totals.shares++;
        break;
      case 'member':
        this.totals.joins++;
        break;
      case 'subscribe':
        this.totals.subscribes++;
        break;
      case 'roomUser':
        this.viewers = ev.viewers;
        this.peakViewers = Math.max(this.peakViewers, ev.viewers);
        break;
    }
  }

  top(field, n = TOP_N) {
    return [...this.users.values()]
      .filter((u) => u[field] > 0)
      .sort((a, b) => b[field] - a[field])
      .slice(0, n);
  }

  // Diamonds per minute over the last `minutes` window — a quick "hype" indicator.
  rate(field = 'diamonds', minutes = 5) {
    const cur = Math.floor((this.now() - this.startedAt) / 60000);
    const recent = this.timeline.filter((x) => x.minute > cur - minutes);
    const sum = recent.reduce((s, x) => s + x[field], 0);
    return Math.round((sum / Math.max(1, Math.min(minutes, cur + 1))) * 10) / 10;
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      totals: this.totals,
      viewers: this.viewers,
      peakViewers: this.peakViewers,
      diamondsPerMin: this.rate('diamonds'),
      likesPerMin: this.rate('likes'),
      topGifters: this.top('diamonds'),
      topLikers: this.top('likes'),
      topChatters: this.top('chats'),
      timeline: this.timeline,
      newFollowers: this.newFollowers,
    };
  }

  toCSV() {
    const rows = [['uniqueId', 'nickname', 'diamonds', 'gifts', 'likes', 'chats']];
    for (const u of this.users.values()) rows.push([u.uniqueId, u.nickname, u.diamonds, u.gifts, u.likes, u.chats]);
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }
}

// Goals auto-track a metric (diamonds/likes/follows/shares/gifts) or are moved manually by actions.
export function applyGoals(goals, ev) {
  const completed = [];
  for (const goal of goals) {
    if (goal.enabled === false) continue;
    const before = goal.current;
    let delta = 0;
    if (goal.metric === 'diamonds' && ev.type === 'gift' && !ev.streaking) delta = ev.totalDiamonds;
    else if (goal.metric === 'gifts' && ev.type === 'gift' && !ev.streaking) delta = ev.count;
    else if (goal.metric === 'likes' && ev.type === 'like') delta = ev.likes;
    else if (goal.metric === 'follows' && ev.type === 'follow') delta = 1;
    else if (goal.metric === 'shares' && ev.type === 'share') delta = 1;
    if (!delta) continue;
    goal.current = before + delta;
    if (before < goal.target && goal.current >= goal.target) completed.push(goal);
  }
  return completed;
}

// Viewer points economy: earned for engagement, spent on point-cost rules.
export const DEFAULT_POINT_RATES = { chat: 1, follow: 50, share: 25, perDiamond: 10, per100Likes: 5, subscribe: 100 };

export function pointsFor(ev, rates = DEFAULT_POINT_RATES) {
  switch (ev.type) {
    case 'chat':
      return rates.chat;
    case 'follow':
      return rates.follow;
    case 'share':
      return rates.share;
    case 'subscribe':
      return rates.subscribe;
    case 'gift':
      return ev.streaking ? 0 : ev.totalDiamonds * rates.perDiamond;
    case 'like':
      return (ev.likes / 100) * rates.per100Likes;
    default:
      return 0;
  }
}
