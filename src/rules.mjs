// Rules engine: decides which configured rules fire for an incoming event.
// Keeps only the runtime state needed for matching (cooldowns, like counters);
// executing actions is the caller's job.

const ROLE_CHECK = {
  all: () => true,
  follower: (u) => u.isFollower || u.isSubscriber || u.isModerator,
  subscriber: (u) => u.isSubscriber || u.isModerator,
  moderator: (u) => u.isModerator,
};

function lower(s) {
  return String(s ?? '').trim().toLowerCase();
}

function splitList(s) {
  return String(s ?? '')
    .split(',')
    .map((x) => lower(x))
    .filter(Boolean);
}

export class RuleEngine {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.lastGlobal = new Map(); // ruleId -> ts
    this.lastUser = new Map(); // ruleId|user -> ts
    this.likeBuckets = new Map(); // ruleId -> accumulated likes
  }

  reset() {
    this.lastGlobal.clear();
    this.lastUser.clear();
    this.likeBuckets.clear();
  }

  // Returns how many times the trigger matched (0 = no match) and mutates ev.args for commands.
  matchTrigger(rule, ev) {
    const t = rule.trigger || {};
    if (t.type !== 'any' && t.type !== ev.type) return 0;

    switch (ev.type) {
      case 'gift': {
        if (ev.streaking) return 0;
        const names = splitList(t.giftName);
        if (names.length && !names.includes(lower(ev.giftName)) && !names.includes(lower(ev.giftId))) return 0;
        if (t.minDiamonds && ev.totalDiamonds < Number(t.minDiamonds)) return 0;
        if (t.maxDiamonds && ev.totalDiamonds > Number(t.maxDiamonds)) return 0;
        return 1;
      }
      case 'chat': {
        const text = String(ev.text ?? '');
        const ltext = lower(text);
        if (t.command) {
          const cmds = splitList(t.command);
          const hit = cmds.find((c) => ltext === c || ltext.startsWith(c + ' '));
          if (!hit) return 0;
          ev.args = text.trim().slice(hit.length).trim();
        }
        if (t.contains) {
          const words = splitList(t.contains);
          if (!words.some((w) => ltext.includes(w))) return 0;
        }
        if (t.regex) {
          try {
            if (!new RegExp(t.regex, 'i').test(text)) return 0;
          } catch {
            return 0;
          }
        }
        return 1;
      }
      case 'like': {
        const every = Number(t.likeEvery) || 0;
        if (!every) return 1;
        const acc = (this.likeBuckets.get(rule.id) || 0) + ev.likes;
        const times = Math.floor(acc / every);
        this.likeBuckets.set(rule.id, acc % every);
        return times;
      }
      default:
        return 1;
    }
  }

  // ctx.getPoints(uniqueId) -> number, used for point-cost rules (viewer economy).
  evaluate(ev, rules, ctx = {}) {
    const out = [];
    const now = this.now();
    const sorted = [...rules].filter((r) => r.enabled !== false).sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const rule of sorted) {
      const f = rule.filter || {};
      const user = ev.user || {};
      if (!(ROLE_CHECK[f.role || 'all'] || ROLE_CHECK.all)(user)) continue;
      if (f.users && !splitList(f.users).includes(lower(user.uniqueId))) continue;

      const cd = rule.cooldown || {};
      const g = this.lastGlobal.get(rule.id);
      if (cd.global && g !== undefined && now - g < cd.global * 1000) continue;
      const uKey = `${rule.id}|${user.uniqueId}`;
      const u = this.lastUser.get(uKey);
      if (cd.perUser && u !== undefined && now - u < cd.perUser * 1000) continue;

      const evCopy = { ...ev };
      const times = this.matchTrigger(rule, evCopy);
      if (!times) continue;

      const cost = Number(rule.cost) || 0;
      if (cost > 0 && ctx.getPoints && ctx.getPoints(user.uniqueId) < cost) {
        out.push({ rule, ev: evCopy, times: 0, denied: 'points' });
        continue;
      }

      let repeat = times;
      if (rule.repeat === 'perCount' && ev.type === 'gift') repeat = ev.count;
      repeat = Math.min(repeat, Number(rule.maxRepeat) || 50);

      this.lastGlobal.set(rule.id, now);
      this.lastUser.set(uKey, now);
      out.push({ rule, ev: evCopy, times: repeat });
      if (rule.stopOnMatch) break;
    }
    return out;
  }
}
