// JSON-file persistence with debounced writes (config + viewer points).

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_POINT_RATES } from './stats.mjs';
import { DEFAULT_AI } from './ai.mjs';
import { DEFAULT_SONGS } from './songs.mjs';
import { DEFAULT_KEYBOARD } from './keyboard.mjs';

export const DEFAULT_CONFIG = {
  settings: {
    username: '',
    autoReconnect: true,
    signApiKey: '',
    obs: { enabled: false, url: 'ws://127.0.0.1:4455', password: '' },
    tts: { lang: 'ru-RU', rate: 1, volume: 1, maxLength: 200, readAllChat: false },
    bannedWords: '',
    pointRates: DEFAULT_POINT_RATES,
    alertMergeWindow: true,
    ai: DEFAULT_AI,
    songs: DEFAULT_SONGS,
    keyboard: DEFAULT_KEYBOARD,
  },
  rules: [
    {
      id: 'r-follow',
      name: 'Новый подписчик',
      enabled: true,
      priority: 1,
      trigger: { type: 'follow' },
      cooldown: { perUser: 600 },
      actions: [{ type: 'alert', text: '💖 {nickname} подписался!', duration: 4, style: 'pink' }],
    },
    {
      id: 'r-gift-any',
      name: 'Любой подарок',
      enabled: true,
      priority: 2,
      trigger: { type: 'gift' },
      actions: [
        { type: 'alert', text: '🎁 {nickname} отправил {giftName} ×{count}', duration: 5, style: 'gold', showGiftImage: true },
      ],
    },
    {
      id: 'r-gift-big',
      name: 'Крупный донат (≥ 100💎)',
      enabled: true,
      priority: 10,
      trigger: { type: 'gift', minDiamonds: 100 },
      actions: [
        { type: 'alert', text: '🚀 МЕГА ДОНАТ! {nickname} — {diamonds}💎', duration: 8, style: 'epic', confetti: true },
        { type: 'tts', text: '{nickname}, огромное спасибо за {giftName}!' },
      ],
      stopOnMatch: true,
    },
    {
      id: 'r-share',
      name: 'Репост',
      enabled: true,
      priority: 0,
      trigger: { type: 'share' },
      cooldown: { perUser: 300 },
      actions: [{ type: 'alert', text: '🔁 {nickname} поделился эфиром', duration: 3, style: 'blue' }],
    },
    {
      id: 'r-likes',
      name: 'Каждые 1000 лайков',
      enabled: true,
      priority: 0,
      trigger: { type: 'like', likeEvery: 1000 },
      actions: [{ type: 'alert', text: '❤️ Ещё 1000 лайков! Всего: {totalLikes}', duration: 3, style: 'red' }],
    },
    {
      id: 'r-tts',
      name: 'Команда !tts (стоит 50 очков)',
      enabled: true,
      priority: 0,
      trigger: { type: 'chat', command: '!tts' },
      cooldown: { perUser: 30 },
      cost: 50,
      actions: [{ type: 'tts', text: '{nickname} говорит: {args}' }],
    },
    {
      id: 'r-points',
      name: 'Команда !points',
      enabled: true,
      trigger: { type: 'chat', command: '!points,!очки' },
      cooldown: { perUser: 20 },
      actions: [{ type: 'alert', text: '⭐ {nickname}: {points} очков', duration: 3, style: 'blue' }],
    },
    {
      id: 'r-ai',
      name: '🤖 Вопрос ИИ: !ai / !вопрос',
      enabled: true,
      trigger: { type: 'chat', command: '!ai,!вопрос,!бот' },
      cooldown: { perUser: 60, global: 5 },
      actions: [{ type: 'ai', prompt: '{args}', alert: true, speak: true }],
    },
    {
      id: 'r-ai-question',
      name: '🤖 ИИ отвечает на вопросы (функция «Вопросы» TikTok)',
      enabled: true,
      trigger: { type: 'question' },
      cooldown: { global: 10 },
      actions: [{ type: 'ai', prompt: '{text}', alert: true, speak: true }],
    },
    {
      id: 'r-song-bump',
      name: '🎵 Подарок от 5💎 поднимает песню зрителя в очереди',
      enabled: true,
      trigger: { type: 'gift', minDiamonds: 5 },
      actions: [{ type: 'songBump', amount: 1 }],
    },
    {
      id: 'r-keys-rose',
      name: '🎮 Роза = прыжок (пробел)',
      enabled: false,
      trigger: { type: 'gift', giftName: 'Rose' },
      repeat: 'perCount',
      maxRepeat: 10,
      actions: [{ type: 'keys', keys: 'space', holdMs: 80 }],
    },
    {
      id: 'r-keys-chat',
      name: '🎮 Чат управляет: !left / !right',
      enabled: false,
      trigger: { type: 'chat', command: '!left,!лево' },
      cooldown: { perUser: 3 },
      actions: [{ type: 'keys', keys: 'a', holdMs: 400 }],
    },
  ],
  goals: [
    { id: 'g-diamonds', title: 'Цель по донатам', metric: 'diamonds', current: 0, target: 1000, enabled: true },
    { id: 'g-likes', title: 'Цель по лайкам', metric: 'likes', current: 0, target: 10000, enabled: true },
    { id: 'g-follows', title: 'Новые подписчики', metric: 'follows', current: 0, target: 50, enabled: true },
  ],
  wheel: {
    segments: [
      { label: '10 отжиманий', weight: 1, color: '#ff4d6d' },
      { label: 'Спеть песню', weight: 1, color: '#ffb703' },
      { label: 'Ничего 😅', weight: 2, color: '#8ecae6' },
      { label: 'Смешной акцент', weight: 1, color: '#90be6d' },
      { label: 'Танец', weight: 1, color: '#c77dff' },
      { label: 'Ответ на вопрос', weight: 1, color: '#f8961e' },
    ],
  },
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base !== 'object' || base === null) return extra ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export class JsonStore {
  constructor(file, defaults, { delay = 500 } = {}) {
    this.file = file;
    this.delay = delay;
    this.timer = null;
    let loaded = {};
    if (file && existsSync(file)) {
      try {
        loaded = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        console.warn(`[store] ${file} is corrupt, using defaults: ${err.message}`);
      }
    }
    this.data = deepMerge(structuredClone(defaults), loaded);
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file); // atomic replace: never leaves a half-written config
  }
}
