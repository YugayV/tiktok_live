// Sound + animation for gift alerts. Tiers by the gift's total value (diamonds × count) give
// every gift a sound and an effect out of the box; a personal setting per gift (Rose, Lion…)
// overrides the tier. A rule's own sound/effect still wins over both.

export const SOUNDS = [
  ['coin', 'Монетка'],
  ['pop', 'Поп'],
  ['heart', 'Сердечко'],
  ['chime', 'Колокольчик'],
  ['sparkle', 'Искры'],
  ['levelup', 'Новый уровень'],
  ['fanfare', 'Фанфары'],
  ['tada', 'Та-дам!'],
  ['whoosh', 'Вжух'],
  ['drumroll', 'Барабанная дробь'],
  ['horn', 'Горн'],
];
export const EFFECTS = ['none', 'confetti', 'hearts', 'diamonds', 'stars', 'fireworks', 'giftRain'];
export const ANIMATIONS = ['pop', 'slide', 'bounce', 'zoom', 'flip', 'shake'];

export const DEFAULT_GIFT_FX = {
  enabled: true,
  volume: 0.8,
  tiers: [
    { min: 1, sound: 'coin', effect: 'none', animation: 'pop' },
    { min: 10, sound: 'chime', effect: 'hearts', animation: 'bounce' },
    { min: 100, sound: 'fanfare', effect: 'confetti', animation: 'zoom' },
    { min: 1000, sound: 'tada', effect: 'fireworks', animation: 'shake' },
  ],
  gifts: [], // { gift: 'Rose', sound: 'heart' | 'media/…mp3' | 'https://…', effect, animation, video }
};

// Built-in name → /sounds/<name>.mp3; uploaded file or https link → as is; anything else → ''.
export function soundUrl(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  if (SOUNDS.some(([k]) => k === v)) return `/sounds/${v}.mp3`;
  if (/^\/sounds\/[a-z]+\.mp3$/.test(v)) return v;
  if (/^media\/[a-f0-9]{16}\.(mp3|wav|ogg)$/.test(v)) return v;
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return v;
  return '';
}

const pick = (v, list) => (list.includes(v) ? v : '');
const norm = (s) => String(s || '').trim().toLowerCase();

export function giftFx(ev, cfg = DEFAULT_GIFT_FX) {
  const c = { ...DEFAULT_GIFT_FX, ...cfg };
  if (!c.enabled || ev.type !== 'gift') return null;
  const value = ev.totalDiamonds || ev.diamonds || 0;
  const tier = [...(c.tiers || [])].filter((x) => value >= (Number(x.min) || 0)).sort((a, b) => b.min - a.min)[0] || {};
  const own = (c.gifts || []).find((g) => g.enabled !== false && norm(g.gift) && (norm(g.gift) === norm(ev.giftName) || String(g.gift) === String(ev.giftId)));
  const from = (key) => (own?.[key] ? own[key] : tier[key]);
  return {
    sound: soundUrl(from('sound')),
    effect: pick(from('effect'), EFFECTS),
    animation: pick(from('animation'), ANIMATIONS),
    video: own?.video || '',
    volume: Math.max(0, Math.min(1, Number(c.volume ?? 0.8))),
  };
}
