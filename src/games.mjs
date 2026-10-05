// Interactive mini-games driven by chat and gifts: wheel of fortune, chat polls, gift battles.

export function pickWeighted(segments, rand = Math.random) {
  const total = segments.reduce((s, x) => s + Math.max(0, Number(x.weight) || 0), 0);
  if (!segments.length || total <= 0) return -1;
  let r = rand() * total;
  for (let i = 0; i < segments.length; i++) {
    r -= Math.max(0, Number(segments[i].weight) || 0);
    if (r < 0) return i;
  }
  return segments.length - 1;
}

export class Poll {
  constructor({ question, options, durationSec = 60, now = () => Date.now() }) {
    this.question = question;
    this.options = options.map((label) => ({ label, votes: 0 }));
    this.voters = new Map(); // uniqueId -> option index (one vote per viewer, re-vote moves it)
    this.now = now;
    this.endsAt = now() + durationSec * 1000;
    this.active = true;
  }

  // Accepts "2", "!vote 2" or the option text itself.
  vote(user, text) {
    if (!this.active) return false;
    if (this.now() > this.endsAt) {
      this.active = false;
      return false;
    }
    const t = String(text).trim().toLowerCase().replace(/^!(vote|голос)\s*/, '');
    let idx = /^\d+$/.test(t) ? Number(t) - 1 : this.options.findIndex((o) => o.label.toLowerCase() === t);
    if (idx < 0 || idx >= this.options.length) return false;
    const prev = this.voters.get(user.uniqueId);
    if (prev === idx) return false;
    if (prev !== undefined) this.options[prev].votes--;
    this.options[idx].votes++;
    this.voters.set(user.uniqueId, idx);
    return true;
  }

  winner() {
    return this.options.reduce((best, o, i) => (o.votes > (best ? best.votes : -1) ? { ...o, index: i } : best), null);
  }

  snapshot() {
    return {
      question: this.question,
      options: this.options,
      total: this.voters.size,
      endsAt: this.endsAt,
      active: this.active && this.now() <= this.endsAt,
    };
  }
}

// Two teams, each "owns" a set of gift names; diamonds from those gifts score points for that team.
// Viewers can also join a team via chat ("!team1"/"!team2") so any gift they send counts for it.
export class GiftBattle {
  constructor({ teams, durationSec = 180, now = () => Date.now() }) {
    this.teams = teams.map((t) => ({
      name: t.name,
      color: t.color,
      gifts: String(t.gifts || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
      score: 0,
    }));
    this.members = new Map();
    this.now = now;
    this.endsAt = now() + durationSec * 1000;
    this.active = true;
  }

  handle(ev) {
    if (!this.active || this.now() > this.endsAt) {
      this.active = false;
      return false;
    }
    if (ev.type === 'chat') {
      const m = /^!team\s*(\d)/i.exec(ev.text.trim());
      if (m && this.teams[Number(m[1]) - 1]) {
        this.members.set(ev.user.uniqueId, Number(m[1]) - 1);
        return true;
      }
      return false;
    }
    if (ev.type !== 'gift' || ev.streaking) return false;
    let idx = this.teams.findIndex((t) => t.gifts.includes(ev.giftName.toLowerCase()));
    if (idx === -1 && this.members.has(ev.user.uniqueId)) idx = this.members.get(ev.user.uniqueId);
    if (idx === -1) return false;
    this.teams[idx].score += ev.totalDiamonds;
    return true;
  }

  snapshot() {
    return { teams: this.teams.map(({ name, color, score }) => ({ name, color, score })), endsAt: this.endsAt, active: this.active && this.now() <= this.endsAt };
  }
}
