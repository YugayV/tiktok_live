// Generates realistic fake LIVE traffic so overlays and rules can be built and tested offline.

import { normalize } from './normalize.mjs';

const NAMES = ['Алина', 'Max_Power', 'котик_2007', 'Dasha.dance', 'GamerPro', 'Света', 'NightOwl', 'Тимур', 'lucky_star', 'Ваня'];
const CHAT = ['Привет! 👋', 'Лучший стрим!', '!tts всем привет', 'Откуда ты?', '1', '2', '!points', 'ахахах 😂', 'Давай танец!', '!team1', '!team2', '!sr Imagine Dragons - Believer', '!sr https://youtu.be/dQw4w9WgXcQ', '!ai какая сегодня игра?'];
export const GIFTS = [
  { name: 'Rose', diamonds: 1, type: 1 },
  { name: 'TikTok', diamonds: 1, type: 1 },
  { name: 'Finger Heart', diamonds: 5, type: 1 },
  { name: 'Doughnut', diamonds: 30, type: 1 },
  { name: 'Hat and Mustache', diamonds: 99, type: 0 },
  { name: 'Galaxy', diamonds: 1000, type: 0 },
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function fakeUser(name = pick(NAMES)) {
  return { userId: name, uniqueId: name.toLowerCase(), nickname: name, profilePicture: { url: [`https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(name)}`] } };
}

export function fakeEvent(type, opts = {}) {
  const user = fakeUser(opts.nickname);
  switch (type) {
    case 'gift': {
      const g = opts.giftName ? GIFTS.find((x) => x.name === opts.giftName) || { name: opts.giftName, diamonds: 1, type: 0 } : pick(GIFTS);
      return normalize('gift', {
        user,
        giftId: g.name,
        repeatCount: opts.count || (g.type === 1 ? 1 + Math.floor(Math.random() * 5) : 1),
        repeatEnd: 1,
        giftDetails: { giftName: g.name, diamondCount: g.diamonds, giftType: g.type },
      });
    }
    case 'chat':
      return normalize('chat', { user, comment: opts.text || pick(CHAT) });
    case 'like':
      return normalize('like', { user, likeCount: opts.count || 5 + Math.floor(Math.random() * 30) });
    case 'roomUser':
      return normalize('roomUser', { viewerCount: opts.count || 50 + Math.floor(Math.random() * 300) });
    default:
      return normalize(type, { user });
  }
}

export class Simulator {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.timer = null;
  }

  get running() {
    return Boolean(this.timer);
  }

  start(intensity = 1) {
    this.stop();
    const tick = () => {
      const r = Math.random();
      let type = 'chat';
      if (r < 0.35) type = 'like';
      else if (r < 0.45) type = 'gift';
      else if (r < 0.5) type = 'follow';
      else if (r < 0.53) type = 'share';
      else if (r < 0.6) type = 'member';
      else if (r < 0.63) type = 'roomUser';
      this.onEvent(fakeEvent(type));
      this.timer = setTimeout(tick, (300 + Math.random() * 1500) / Math.max(0.1, intensity));
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
