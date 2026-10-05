// Tiny "{placeholder}" renderer for alert/TTS/webhook text.

export function eventVars(ev) {
  return {
    nickname: ev.user?.nickname ?? '',
    username: ev.user?.uniqueId ?? '',
    giftName: ev.giftName ?? '',
    count: ev.count ?? ev.likes ?? 1,
    diamonds: ev.totalDiamonds ?? ev.diamonds ?? 0,
    likes: ev.likes ?? 0,
    totalLikes: ev.totalLikes ?? 0,
    text: ev.text ?? '',
    args: ev.args ?? '',
    type: ev.type,
    points: ev.points ?? 0,
  };
}

export function render(template, ev) {
  if (!template) return '';
  const vars = eventVars(ev);
  return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}
