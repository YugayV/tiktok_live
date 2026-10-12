// TikLive Studio dashboard (vanilla JS, no build step).
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
  let S = null; // last full state from server

  // ---------- helpers ----------
  function toast(msg, err = false) {
    const el = document.createElement('div');
    el.textContent = msg;
    if (err) el.className = 'err';
    $('#toast').append(el);
    setTimeout(() => el.remove(), 3500);
  }
  async function api(path, body, method = 'POST') {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) location.href = '/login'; // web version: session expired
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  // Overlay links: personal /o/<token>/ in the web version, local /overlay/ in the desktop app.
  const overlayBase = () => location.origin + (S?.hosted?.overlayPath || '/overlay/');
  const call = (path, body, okMsg) =>
    api(path, body)
      .then((r) => (okMsg && toast(okMsg), r))
      .catch((e) => toast(e.message, true));
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, p, v) {
    const ks = p.split('.');
    let cur = o;
    for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
    cur[ks.at(-1)] = v;
  }
  const saveConfig = (part, msg = 'Сохранено') => call('/api/config', part, msg).then(() => (dirty = false));
  let dirty = false;

  // Builds a labeled input bound to obj[path].
  function field(obj, path, label, kind = 'text', options) {
    const wrap = document.createElement('label');
    let input;
    if (kind === 'select') {
      input = document.createElement('select');
      for (const [v, t] of options) input.add(new Option(t, v));
      input.value = getPath(obj, path) ?? options[0][0];
    } else if (kind === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 2;
      input.value = getPath(obj, path) ?? '';
    } else {
      input = document.createElement('input');
      input.type = kind;
      if (kind === 'checkbox') input.checked = Boolean(getPath(obj, path));
      else input.value = getPath(obj, path) ?? '';
    }
    input.addEventListener('input', () => {
      let v = kind === 'checkbox' ? input.checked : input.value;
      if (kind === 'number') v = input.value === '' ? undefined : Number(input.value);
      setPath(obj, path, v);
      dirty = true;
    });
    if (kind === 'checkbox') {
      wrap.className = 'check';
      wrap.append(input, document.createTextNode(label));
    } else wrap.append(document.createTextNode(label), input);
    return wrap;
  }

  // ---------- tabs ----------
  $$('#tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
      if (b.dataset.tab === 'overlays') renderOverlays();
      if (b.dataset.tab === 'home') drawChart();
    }),
  );
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  // ---------- connection ----------
  $('#connectForm').addEventListener('submit', (e) => {
    e.preventDefault();
    call('/api/connect', { username: $('#username').value.trim() });
  });
  $('#disconnectBtn').onclick = () => call('/api/disconnect', {});
  const STATUS_TEXT = { connected: 'в эфире', connecting: 'подключение…', reconnecting: 'переподключение…', disconnected: 'отключено', error: 'ошибка', ended: 'эфир завершён' };
  function renderStatus(s) {
    $('#statusDot').className = `dot ${s.state}`;
    $('#statusText').textContent = `${STATUS_TEXT[s.state] || s.state}${s.username ? ' · @' + s.username : ''}${s.error ? ' — ' + s.error : ''}`;
  }

  // ---------- home ----------
  const ICON = { chat: '💬', gift: '🎁', like: '❤️', follow: '💖', share: '🔁', member: '👋', subscribe: '⭐', question: '❓', goal: '🎯', envelope: '💰' };
  function eventText(ev) {
    switch (ev.type) {
      case 'chat': return `<b>${esc(ev.user.nickname)}</b>: ${esc(ev.text)}`;
      case 'gift': return `<b>${esc(ev.user.nickname)}</b> → ${esc(ev.giftName)} ×${ev.count} <span class="muted">(${ev.totalDiamonds}💎${ev.streaking ? ', серия…' : ''})</span>`;
      case 'like': return `<b>${esc(ev.user.nickname)}</b> +${ev.likes} лайков`;
      case 'follow': return `<b>${esc(ev.user.nickname)}</b> подписался`;
      case 'share': return `<b>${esc(ev.user.nickname)}</b> поделился`;
      case 'member': return `<b>${esc(ev.user.nickname)}</b> зашёл`;
      case 'goal': return `Цель достигнута: <b>${esc(ev.text)}</b>`;
      default: return `<b>${esc(ev.user?.nickname)}</b> ${esc(ev.type)} ${esc(ev.text || '')}`;
    }
  }
  const time = (ts) => new Date(ts).toLocaleTimeString('ru-RU');
  function addFeed(ev, prepend = true) {
    if (ev.type === 'like' && $('#feed').children.length && Math.random() < 0.7) return; // likes are noisy
    const el = document.createElement('div');
    el.className = 'it';
    el.innerHTML = `<span class="ic">${ICON[ev.type] || '•'}</span><span>${eventText(ev)}</span><span class="t">${time(ev.ts)}</span>`;
    prepend ? $('#feed').prepend(el) : $('#feed').append(el);
    while ($('#feed').children.length > 80) $('#feed').lastChild.remove();
  }
  function addLog(line, prepend = true) {
    const el = document.createElement('div');
    el.className = 'it';
    el.innerHTML = `<span>${esc(line.text)}</span><span class="t">${time(line.ts)}</span>`;
    prepend ? $('#log').prepend(el) : $('#log').append(el);
    while ($('#log').children.length > 80) $('#log').lastChild.remove();
  }
  const listHtml = (rows, field, suffix = '') => rows.map((u, i) => `<div class="r"><span>${i + 1}. ${esc(u.nickname)}</span><b>${fmt(u[field])}${suffix}</b></div>`).join('') || '<div class="muted">Пока пусто</div>';

  function renderStats(st) {
    S.stats = st;
    if (st.topPoints) S.topPoints = st.topPoints;
    const t = st.totals;
    const mins = Math.max(1, Math.round((Date.now() - st.startedAt) / 60000));
    const k = [
      ['💎', fmt(t.diamonds), 'алмазов'],
      ['👀', fmt(st.viewers), `зрителей (пик ${fmt(st.peakViewers)})`],
      ['❤️', fmt(t.likes), 'лайков'],
      ['💖', fmt(t.follows), 'подписок'],
      ['🔁', fmt(t.shares), 'репостов'],
      ['💬', fmt(t.chats), 'сообщений'],
      ['🎁', fmt(t.gifts), 'подарков'],
      ['⏱', `${mins} мин`, 'сессия'],
    ];
    $('#kpis').innerHTML = k.map(([i, v, l]) => `<div class="kpi"><div class="v">${i} ${v}</div><div class="l">${l}</div></div>`).join('');
    $('#rateInfo').textContent = `${fmt(st.diamondsPerMin)} 💎/мин · ${fmt(st.likesPerMin)} ❤️/мин (5 мин)`;
    $('#topGifters').innerHTML = listHtml(st.topGifters, 'diamonds', '💎');
    $('#topLikers').innerHTML = listHtml(st.topLikers, 'likes');
    $('#topChatters').innerHTML = listHtml(st.topChatters, 'chats');
    $('#topPoints').innerHTML = listHtml(S.topPoints || [], 'points');
    $('#newFollowers').textContent = st.newFollowers.join(', ') || '—';
    if (st.queue) renderQueue(st.queue);
    drawChart();
  }
  function renderQueue(q) {
    S.queue = q;
    $('#queueInfo').textContent = `${q.current ? 'Сейчас: ' + q.current.text : 'Нет активного алерта'} · в очереди: ${q.pending}${q.paused ? ' · ПАУЗА' : ''}`;
    $('#pauseBtn').textContent = q.paused ? '▶ Продолжить' : '⏸ Пауза';
  }
  function drawChart() {
    const c = $('#chart');
    if (!c || !S || !c.offsetWidth) return;
    c.width = c.offsetWidth * devicePixelRatio;
    c.height = 140 * devicePixelRatio;
    const x = c.getContext('2d');
    x.scale(devicePixelRatio, devicePixelRatio);
    const W = c.offsetWidth, H = 140, data = S.stats.timeline.slice(-60);
    x.clearRect(0, 0, W, H);
    if (!data.length) return;
    const max = Math.max(10, ...data.map((d) => d.diamonds));
    const bw = W / Math.max(30, data.length);
    data.forEach((d, i) => {
      const h = (d.diamonds / max) * (H - 20);
      const g = x.createLinearGradient(0, H - h, 0, H);
      g.addColorStop(0, '#fe2c55');
      g.addColorStop(1, '#25f4ee');
      x.fillStyle = g;
      x.fillRect(i * bw + 1, H - h, bw - 2, h);
    });
    x.fillStyle = '#8b90a6';
    x.font = '11px sans-serif';
    x.fillText(`макс ${fmt(max)}💎/мин`, 4, 12);
  }
  window.addEventListener('resize', drawChart);
  $('#pauseBtn').onclick = () => call('/api/alert/pause', { paused: !S.queue?.paused }).then((q) => q && renderQueue(q));
  $('#skipBtn').onclick = () => call('/api/alert/skip', {});
  $('#clearBtn').onclick = () => call('/api/alert/clear', {}, 'Очередь очищена');
  $('#ttsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    call('/api/tts', { text: $('#ttsText').value });
    $('#ttsText').value = '';
  });
  $('#resetBtn').onclick = () => confirm('Сбросить статистику и прогресс целей?') && call('/api/session/reset', {}, 'Сессия сброшена');

  // ---------- rules ----------
  const TRIGGERS = [
    ['gift', '🎁 Подарок'], ['chat', '💬 Сообщение / команда'], ['follow', '💖 Подписка'], ['share', '🔁 Репост'], ['like', '❤️ Лайки'],
    ['member', '👋 Вход зрителя'], ['subscribe', '⭐ Платная подписка'], ['question', '❓ Вопрос'], ['goal', '🎯 Цель достигнута'], ['any', '✳ Любое событие'],
  ];
  const ACTIONS = {
    alert: ['🔔 Алерт на экране', [['text', 'Текст', 'grow'], ['duration', 'Сек', 'number'], ['style', 'Стиль', 'select', [['default', 'Обычный'], ['gold', 'Золото'], ['pink', 'Розовый'], ['blue', 'Голубой'], ['red', 'Красный'], ['epic', 'Эпик']]], ['image', 'Картинка/GIF URL'], ['sound', 'Звук URL'], ['showGiftImage', 'Картинка подарка', 'checkbox'], ['confetti', 'Конфетти', 'checkbox']]],
    tts: ['🗣 Озвучить (TTS)', [['text', 'Текст', 'grow']]],
    sound: ['🔊 Звук', [['url', 'URL (mp3/wav)', 'grow'], ['volume', 'Громкость 0–1', 'number']]],
    goal: ['🎯 Изменить цель', [['goalId', 'Цель', 'goal'], ['amount', 'Сколько (число или diamonds)']]],
    points: ['⭐ Начислить очки', [['amount', 'Очки', 'number']]],
    wheel: ['🎡 Крутить колесо', []],
    obs: ['🎬 OBS', [['scene', 'Переключить на сцену'], ['sceneName', 'Сцена источника'], ['source', 'Источник'], ['visible', 'Показать (иначе скрыть)', 'checkbox']]],
    webhook: ['🌐 Webhook', [['url', 'URL', 'grow'], ['method', 'Метод'], ['body', 'Тело (шаблон, пусто = JSON события)', 'grow']]],
    overlay: ['🧩 Своё событие оверлея', [['widget', 'Виджет'], ['payload', 'Данные', 'grow']]],
    ai: ['🤖 Ответ ИИ', [['prompt', 'Вопрос (шаблон, обычно {args})', 'grow'], ['alert', 'Алерт', 'checkbox'], ['speak', 'Озвучить', 'checkbox']]],
    keys: ['🎮 Нажать клавиши', [['keys', 'Клавиши (w, space, ctrl+a)'], ['holdMs', 'Удержание, мс', 'number'], ['repeat', 'Повторов', 'number'], ['intervalMs', 'Пауза, мс', 'number']]],
    songBump: ['🎵 Поднять песню зрителя', [['amount', 'На сколько', 'number']]],
    songSkip: ['⏭ Пропустить песню', []],
  };
  const ACTION_DEFAULTS = { alert: { text: '{nickname}', duration: 5 }, ai: { prompt: '{args}', alert: true, speak: true }, keys: { keys: 'space', holdMs: 100 }, songBump: { amount: 1 } };

  function renderRules() {
    const box = $('#rules');
    box.replaceChildren();
    S.config.rules.forEach((rule, idx) => box.append(ruleCard(rule, idx)));
  }

  function ruleCard(rule, idx) {
    rule.trigger ||= { type: 'gift' };
    rule.actions ||= [];
    const card = document.createElement('div');
    card.className = `rule ${rule.enabled === false ? 'off' : ''}`;
    const top = document.createElement('div');
    top.className = 'rule-top';
    const name = document.createElement('input');
    name.className = 'name';
    name.value = rule.name || '';
    name.placeholder = 'Название правила';
    name.oninput = () => ((rule.name = name.value), (dirty = true));
    const en = field(rule, 'enabled', 'Вкл', 'checkbox');
    if (rule.enabled === undefined) en.querySelector('input').checked = true;
    en.querySelector('input').addEventListener('change', (e) => card.classList.toggle('off', !e.target.checked));
    const trig = field(rule, 'trigger.type', 'Событие', 'select', TRIGGERS);
    trig.querySelector('select').addEventListener('change', () => renderRules());
    const test = button('▶ Тест', () => testRule(rule));
    const up = button('↑', () => moveRule(idx, -1));
    const del = button('✕', () => {
      if (!confirm(`Удалить «${rule.name}»?`)) return;
      S.config.rules.splice(idx, 1);
      dirty = true;
      renderRules();
    });
    del.className = 'x danger';
    top.append(name, trig, en, test, up, del);

    const body = document.createElement('div');
    body.className = 'rule-body';
    const t = rule.trigger.type;
    if (t === 'gift') body.append(field(rule, 'trigger.giftName', 'Подарки (через запятую, пусто = любой)'), field(rule, 'trigger.minDiamonds', 'Мин. 💎', 'number'), field(rule, 'trigger.maxDiamonds', 'Макс. 💎', 'number'), field(rule, 'repeat', 'Повтор действий', 'select', [['once', 'Один раз'], ['perCount', 'За каждый подарок в серии']]), field(rule, 'maxRepeat', 'Макс. повторов', 'number'));
    if (t === 'chat') body.append(field(rule, 'trigger.command', 'Команды (!dance, !танец)'), field(rule, 'trigger.contains', 'Содержит слова'), field(rule, 'trigger.regex', 'RegExp'));
    if (t === 'like') body.append(field(rule, 'trigger.likeEvery', 'Каждые N лайков', 'number'));
    body.append(
      field(rule, 'filter.role', 'Кто может', 'select', [['all', 'Все'], ['follower', 'Подписчики'], ['subscriber', 'Платные сабы'], ['moderator', 'Модераторы']]),
      field(rule, 'filter.users', 'Только эти username'),
      field(rule, 'cooldown.global', 'Кулдаун общий, сек', 'number'),
      field(rule, 'cooldown.perUser', 'Кулдаун на зрителя, сек', 'number'),
      field(rule, 'cost', 'Цена в очках', 'number'),
      field(rule, 'priority', 'Приоритет', 'number'),
      field(rule, 'stopOnMatch', 'Остановить проверку других правил', 'checkbox'),
    );

    const acts = document.createElement('div');
    acts.className = 'actions';
    rule.actions.forEach((a, ai) => acts.append(actionRow(rule, a, ai)));
    const addSel = document.createElement('select');
    addSel.add(new Option('+ Добавить действие…', ''));
    for (const [k, [label]] of Object.entries(ACTIONS)) addSel.add(new Option(label, k));
    addSel.onchange = () => {
      if (!addSel.value) return;
      rule.actions.push({ type: addSel.value, ...(ACTION_DEFAULTS[addSel.value] || {}) });
      dirty = true;
      renderRules();
    };
    card.append(top, body, acts, addSel);
    return card;
  }

  function actionRow(rule, a, ai) {
    const row = document.createElement('div');
    row.className = 'action';
    const [label, fields] = ACTIONS[a.type] || [a.type, []];
    const tag = document.createElement('b');
    tag.textContent = label;
    tag.style.flex = '0 0 150px';
    row.append(tag);
    for (const [key, lab, kind = 'text', opts] of fields) {
      let el;
      if (kind === 'goal') el = field(a, key, lab, 'select', S.config.goals.map((g) => [g.id, g.title]));
      else if (kind === 'grow') (el = field(a, key, lab, 'text')), el.classList.add('grow');
      else el = field(a, key, lab, kind, opts);
      row.append(el);
    }
    const del = button('✕', () => {
      rule.actions.splice(ai, 1);
      dirty = true;
      renderRules();
    });
    del.className = 'x danger';
    row.append(del);
    return row;
  }

  function button(text, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.onclick = onclick;
    return b;
  }
  function moveRule(idx, d) {
    const r = S.config.rules;
    if (idx + d < 0 || idx + d >= r.length) return;
    [r[idx], r[idx + d]] = [r[idx + d], r[idx]];
    dirty = true;
    renderRules();
  }
  async function testRule(rule) {
    await saveConfig({ rules: S.config.rules }, '');
    const t = rule.trigger;
    const body = { type: t.type === 'any' || t.type === 'goal' ? 'follow' : t.type, nickname: 'Tester' };
    if (t.type === 'gift') Object.assign(body, { giftName: (t.giftName || 'Galaxy').split(',')[0].trim(), count: 1 });
    if (t.type === 'chat') body.text = `${(t.command || '').split(',')[0].trim()} тест`.trim() || 'тест';
    if (t.type === 'like') body.count = Number(t.likeEvery) || 10;
    call('/api/simulate', body, 'Тестовое событие отправлено');
  }
  $('#addRule').onclick = () => {
    S.config.rules.unshift({ id: uid('r'), name: 'Новое правило', enabled: true, priority: 0, trigger: { type: 'gift' }, actions: [{ type: 'alert', text: '{nickname} — {giftName} ×{count}', duration: 5 }] });
    dirty = true;
    renderRules();
  };
  $('#saveRules').onclick = () => saveConfig({ rules: S.config.rules }, 'Правила сохранены');

  // ---------- goals ----------
  function renderGoals() {
    const box = $('#goals');
    box.replaceChildren();
    S.config.goals.forEach((g, i) => {
      const card = document.createElement('div');
      card.className = 'rule';
      const body = document.createElement('div');
      body.className = 'rule-body';
      const pct = Math.min(100, Math.round((g.current / Math.max(1, g.target)) * 100));
      body.append(
        field(g, 'title', 'Название'),
        field(g, 'metric', 'Считать', 'select', [['diamonds', '💎 Алмазы'], ['likes', '❤️ Лайки'], ['follows', '💖 Подписки'], ['shares', '🔁 Репосты'], ['gifts', '🎁 Кол-во подарков'], ['manual', '✋ Вручную / действиями']]),
        field(g, 'current', `Текущее (${pct}%)`, 'number'),
        field(g, 'target', 'Цель', 'number'),
        field(g, 'enabled', 'Включена', 'checkbox'),
      );
      const url = `${overlayBase()}?w=goals&goal=${encodeURIComponent(g.id)}`;
      const copy = button('📋 URL оверлея', () => navigator.clipboard?.writeText(url).then(() => toast('Скопировано')));
      const del = button('✕ Удалить', () => {
        S.config.goals.splice(i, 1);
        dirty = true;
        renderGoals();
      });
      del.className = 'danger';
      body.append(copy, del);
      card.append(body);
      box.append(card);
    });
  }
  $('#addGoal').onclick = () => {
    S.config.goals.push({ id: uid('g'), title: 'Новая цель', metric: 'diamonds', current: 0, target: 500, enabled: true });
    dirty = true;
    renderGoals();
  };
  $('#saveGoals').onclick = () => saveConfig({ goals: S.config.goals }, 'Цели сохранены');

  // ---------- games ----------
  function renderWheel() {
    const box = $('#wheelSegs');
    box.replaceChildren();
    S.config.wheel.segments.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'seg';
      row.innerHTML = `<input type="text" value="${esc(s.label)}"><input type="number" min="0" value="${esc(s.weight)}" title="Вес (шанс)"><input type="color" value="${esc(s.color || '#888888')}">`;
      const [l, w, c] = row.querySelectorAll('input');
      l.oninput = () => ((s.label = l.value), (dirty = true));
      w.oninput = () => ((s.weight = Number(w.value)), (dirty = true));
      c.oninput = () => ((s.color = c.value), (dirty = true));
      row.append(button('✕', () => (S.config.wheel.segments.splice(i, 1), renderWheel())));
      box.append(row);
    });
  }
  $('#addSeg').onclick = () => (S.config.wheel.segments.push({ label: 'Новый сектор', weight: 1, color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0') }), renderWheel());
  $('#saveWheel').onclick = () => saveConfig({ wheel: S.config.wheel }, 'Колесо сохранено');
  $('#spinWheel').onclick = () => saveConfig({ wheel: S.config.wheel }, '').then(() => call('/api/wheel/spin', { by: '' }));
  $('#pollForm').addEventListener('submit', (e) => {
    e.preventDefault();
    call('/api/poll/start', Object.fromEntries(new FormData(e.target)), 'Голосование запущено');
  });
  $('#endPoll').onclick = () => call('/api/poll/end', {});
  $('#battleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    call('/api/battle/start', { durationSec: f.durationSec, teams: [{ name: f.n1, gifts: f.g1, color: '#fe2c55' }, { name: f.n2, gifts: f.g2, color: '#25f4ee' }] }, 'Битва началась!');
  });
  $('#endBattle').onclick = () => call('/api/battle/end', {});
  function renderPoll(p) {
    if (!p) return ($('#pollState').innerHTML = '');
    $('#pollState').innerHTML = `<h4>${esc(p.question)} ${p.active ? '(идёт)' : '(завершено)'}</h4>` + p.options.map((o, i) => `<div class="r list"><span>${i + 1}. ${esc(o.label)}</span><b>${o.votes}</b></div>`).join('');
  }
  function renderBattle(b) {
    if (!b) return ($('#battleState').innerHTML = '');
    $('#battleState').innerHTML = b.teams.map((t) => `<div class="r list"><span>${esc(t.name)}</span><b>${fmt(t.score)}💎</b></div>`).join('') + (b.active ? '' : `<p>🏆 ${esc(b.winner || 'Ничья')}</p>`);
  }

  // ---------- viewers ----------
  $('#pointsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    call('/api/points', { uniqueId: f.uniqueId.replace(/^@/, '').toLowerCase(), amount: Number(f.amount) }).then((r) => r && toast(`Теперь у ${f.uniqueId}: ${r.points} очков`));
  });

  // ---------- overlays ----------
  const OVERLAYS = [
    ['alerts', '🔔 Алерты (+ звук и TTS)', 'Подарки, подписки, репосты — с очередью и приоритетами', ''],
    ['goals', '🎯 Цели', 'Прогресс-бары всех целей (или &goal=ID для одной)', ''],
    ['chat', '💬 Чат', '&all=1 — показывать также подарки и подписки, &max=N', '&all=1'],
    ['top', '🏆 Топ донатеров', '&by=diamonds|likes|chats|points &n=5', '&by=diamonds&n=5'],
    ['counter', '❤️ Счётчик', '&metric=likes|viewers|diamonds|follows|shares', '&metric=likes'],
    ['wheel', '🎡 Колесо фортуны', '&size=500', ''],
    ['poll', '📊 Голосование', 'Появляется, когда запущено голосование', ''],
    ['battle', '⚔ Битва подарков', 'Появляется, когда идёт битва', ''],
    ['songs', '🎵 Очередь песен', 'Сейчас играет + следующие треки, &n=5', '&n=5'],
    ['player', '▶ Проигрыватель YouTube', 'Играет заказанные YouTube-ссылки (без картинки: &video=0)', ''],
    ['ai', '🤖 Ответы ИИ', 'Карточка «вопрос → ответ», &sec=12 — сколько показывать', ''],
    ['audio', '🔊 Только звук/TTS', 'Отдельный источник для звука, если алерты без аудио (&audio=0)', ''],
  ];
  function renderOverlays() {
    const box = $('#overlayList');
    if (box.children.length) return;
    for (const [w, title, hint, extra] of OVERLAYS) {
      const url = `${overlayBase()}?w=${w}${extra}`;
      const el = document.createElement('div');
      el.className = 'card ov';
      el.innerHTML = `<h3>${title}</h3><div class="muted">${hint}</div><div class="url"><input readonly value="${esc(url)}"><button type="button">📋</button></div>${w === 'audio' || w === 'player' ? '' : `<iframe src="${esc(url)}&preview=1&audio=0" loading="lazy"></iframe>`}`;
      el.querySelector('button').onclick = () => navigator.clipboard?.writeText(url).then(() => toast('URL скопирован'));
      box.append(el);
    }
  }

  // ---------- test ----------
  const SIM = [['follow', '💖 Подписка'], ['share', '🔁 Репост'], ['like', '❤️ Лайки'], ['member', '👋 Вход'], ['subscribe', '⭐ Саб'], ['gift', '🎁 Случайный подарок'], ['roomUser', '👀 Зрители']];
  for (const [type, label] of SIM) $('#simBtns').append(button(label, () => call('/api/simulate', { type })));
  $('#simGift').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    call('/api/simulate', { type: 'gift', giftName: f.giftName, count: Number(f.count) || 1, nickname: f.nickname || undefined });
  });
  $('#simChat').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    call('/api/simulate', { type: 'chat', text: f.text, nickname: f.nickname || undefined });
  });
  function renderSim(running) {
    S.simulator = running;
    $('#simToggle').textContent = running ? '⏹ Остановить' : '▶ Запустить';
  }
  $('#simToggle').onclick = () => call('/api/simulator', { running: !S.simulator, intensity: $('#simIntensity').value }).then((r) => r && renderSim(r.running));

  // ---------- settings ----------
  function renderSettings() {
    const f = $('#settingsForm');
    for (const el of f.elements) {
      if (!el.name) continue;
      const v = getPath(S.config.settings, el.name);
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = v ?? '';
    }
    $('#obsState').textContent = S.obs ? '● подключен' : '';
    loadVoices();
    renderAudioHint();
  }
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const st = S.config.settings;
    for (const el of e.target.elements) {
      if (!el.name) continue;
      setPath(st, el.name, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value);
    }
    saveConfig({ settings: st }, 'Настройки сохранены');
  });
  $('#obsConnect').onclick = () => {
    $('#settingsForm').requestSubmit();
    setTimeout(() => call('/api/obs/connect', {}, 'OBS подключен').then((r) => r && ($('#obsState').textContent = '● подключен')), 300);
  };

  // ---------- sub-settings forms (songs / ai / keyboard) ----------
  function fillForm(form, obj) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = getPath(obj, el.name);
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = v ?? '';
    }
  }
  function bindSettingsForm(sel, key, msg) {
    $(sel).addEventListener('submit', (e) => {
      e.preventDefault();
      const obj = (S.config.settings[key] ||= {});
      for (const el of e.target.elements) {
        if (!el.name) continue;
        setPath(obj, el.name, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value);
      }
      saveConfig({ settings: S.config.settings }, msg);
    });
  }
  bindSettingsForm('#songsForm', 'songs', 'Настройки песен сохранены');
  bindSettingsForm('#aiForm', 'ai', 'Настройки ИИ сохранены');
  bindSettingsForm('#kbForm', 'keyboard', 'Настройки клавиатуры сохранены');

  // ---------- songs ----------
  const songLabel = (s) => (s.videoId ? `▶ ${esc(s.title || 'YouTube ' + s.videoId)}` : esc(s.title || s.query));
  function renderSongs(snap) {
    if (!snap) return;
    S.songs = snap;
    const c = snap.current;
    $('#songCurrent').innerHTML = c ? `<b>${songLabel(c)}</b> <span class="muted">— заказал ${esc(c.nickname)}</span>${c.videoId ? ` <a class="muted" href="https://youtu.be/${esc(c.videoId)}" target="_blank" rel="noopener">↗</a>` : ''}` : 'Ничего не играет';
    const q = $('#songQueue');
    q.replaceChildren();
    if (!snap.queue.length) q.innerHTML = '<div class="muted">Очередь пуста. Зрители заказывают командой <code>!sr название</code></div>';
    snap.queue.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'r';
      row.innerHTML = `<span>${i + 1}. ${songLabel(s)} <span class="muted">— ${esc(s.nickname)}${s.priority ? ' ⬆' + s.priority : ''}</span></span>`;
      const del = button('✕', () => call('/api/songs/remove', { id: s.id }));
      del.className = 'x danger';
      row.append(del);
      q.append(row);
    });
  }
  $('#songNext').onclick = () => call('/api/songs/next', {});
  $('#songClear').onclick = () => confirm('Очистить очередь песен?') && call('/api/songs/clear', {});
  $('#songAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    call('/api/songs/add', { text: e.target.text.value }, 'Добавлено').then(() => (e.target.text.value = ''));
  });

  // ---------- ai ----------
  function addAi(a) {
    const el = document.createElement('div');
    el.className = 'it';
    el.innerHTML = `<span><b>${esc(a.nickname)}:</b> ${esc(a.question)}<br>🤖 ${esc(a.answer)}</span><span class="t">${time(a.ts)}</span>`;
    $('#aiLog').prepend(el);
    while ($('#aiLog').children.length > 30) $('#aiLog').lastChild.remove();
  }
  $('#aiAsk').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#aiAnswer').textContent = 'Думаю…';
    try {
      const r = await api('/api/ai/ask', { question: e.target.question.value });
      $('#aiAnswer').textContent = `🤖 ${r.answer}`;
      if (r.quota) $('#aiQuota').textContent = `${r.quota.plan === 'pro' ? 'Pro' : 'Пробный период'}: использовано ${r.quota.used} из ${r.quota.limit} ответов${r.quota.plan === 'pro' ? ' в этом месяце' : ''}`;
    } catch (err) {
      $('#aiAnswer').textContent = `⚠ ${err.message}`;
    }
  });

  const syncAiMode = () => $('#aiOwn')?.classList.toggle('hidden', $('#aiMode').value !== 'own');
  $('#aiMode').addEventListener('change', syncAiMode);

  // ---------- keyboard ----------
  $('#kbStop').onclick = () => call('/api/keys/stop', {}, 'Клавиши остановлены');
  $('#kbTest').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    toast('Переключитесь в окно игры — нажатие через 3 секунды');
    setTimeout(() => call('/api/keys/test', { keys: f.keys, holdMs: Number(f.holdMs) }), 3000);
  });
  function renderKeyboard(k) {
    if (k) $('#kbState').textContent = `Драйвер: ${k.driver}`;
  }

  // ---------- license / Pro ----------
  const FREE_ROWS = ['Алерты, очередь, антиспам', 'Правила, цели, очки зрителей', 'Оверлеи чата, топа, счётчиков', 'Аналитика и экспорт CSV', 'Симулятор эфира', 'Озвучка (TTS)'];
  function renderLicense(l) {
    if (!l) return;
    S.license = l;
    const banner = $('#planBanner');
    const buy = l.checkoutUrl ? `<a class="btn primary" href="${esc(l.checkoutUrl)}" target="_blank" rel="noopener">Оформить Pro — ${esc(l.priceLabel)}</a>` : '';
    banner.className = `plan-banner ${l.plan}`;
    if (l.plan === 'trial') banner.innerHTML = `🎁 Пробный период Pro: осталось ${l.trialDaysLeft} дн. Затем ${esc(l.priceLabel)}. ${buy}`;
    else if (l.plan === 'expired') banner.innerHTML = `⏳ Пробный период закончился — ${Object.values(l.features).join(', ')} отключены. ${buy}`;
    else banner.classList.add('hidden');
    const locked = l.plan === 'expired';
    $$('#tabs [data-pro]').forEach((b) => b.classList.toggle('locked', locked));

    const st = $('#proStatus');
    st.className = `pro-status ${l.plan}`;
    const sub = l.subscription;
    const SUB_STATUS = { active: 'активна', on_trial: 'активна', past_due: 'проблема с оплатой — обновите карту', cancelled: 'отменена', paused: 'на паузе', unpaid: 'не оплачена', expired: 'закончилась' };
    if (sub?.active) st.innerHTML = `Статус: <b>Pro активен</b> · подписка ${esc(SUB_STATUS[sub.status] || sub.status)}${sub.expiresAt ? (sub.status === 'cancelled' ? ' · работает до ' : ' · следующее списание ') + new Date(sub.expiresAt).toLocaleDateString('ru-RU') : ''}`;
    else if (l.plan === 'pro') st.innerHTML = `Статус: <b>Pro активен</b> · ключ ${esc(l.key)}${l.customerEmail ? ' · ' + esc(l.customerEmail) : ''}${l.expiresAt ? ' · до ' + new Date(l.expiresAt).toLocaleDateString('ru-RU') : ''}`;
    else if (l.plan === 'trial') st.innerHTML = `Статус: <b>пробный период</b> — до ${new Date(l.trialEndsAt).toLocaleDateString('ru-RU')} (${l.trialDaysLeft} дн.)`;
    else st.innerHTML = `Статус: <b>пробный период закончился</b>${l.key ? ` · ключ ${esc(l.key)}: ${esc(l.licenseStatus || 'не подтверждён')}` : ''}`;
    $('#proPrice').textContent = l.priceLabel;
    const btn = $('#buyBtn');
    if (sub?.manageUrl && (sub.active || sub.status === 'past_due')) {
      btn.href = sub.manageUrl;
      btn.classList.remove('disabled');
      btn.textContent = 'Управление подпиской';
    } else if (l.checkoutUrl) {
      btn.href = l.checkoutUrl;
      btn.classList.remove('disabled');
      btn.textContent = l.plan === 'pro' ? 'Управление подпиской' : 'Оформить подписку';
    } else {
      btn.removeAttribute('href');
      btn.classList.add('disabled');
      btn.textContent = 'Оплата ещё не настроена (checkoutUrl)';
    }
    $('#licDeactivate').classList.toggle('hidden', !l.key);
    $('#planTable').innerHTML =
      FREE_ROWS.map((r) => `<tr><td>${r}</td><td>✅</td><td>✅</td></tr>`).join('') +
      Object.values(l.features).map((r) => `<tr><td>${esc(r)}</td><td>${l.trialDays} дней</td><td>✅</td></tr>`).join('');
  }
  $('#licenseForm').addEventListener('submit', (e) => {
    e.preventDefault();
    call('/api/license/activate', { key: e.target.key.value }, '💎 Pro активирован!').then((r) => r && (renderLicense(r), (e.target.key.value = '')));
  });
  $('#licRefresh').onclick = () => call('/api/license/refresh', {}).then((r) => r && (renderLicense(r), toast(r.plan === 'pro' ? 'Подписка активна' : 'Подписка не активна')));
  $('#licDeactivate').onclick = () => confirm('Отвязать ключ от этого компьютера? Его можно будет активировать на другом.') && call('/api/license/deactivate', {}, 'Ключ отвязан').then(renderLicense);

  // ---------- app updates ----------
  function renderUpdate(u, version, canInstall) {
    if (version) $('#appVersion').textContent = `v${version}`;
    if (canInstall !== undefined) S.canInstall = canInstall;
    const b = $('#updateBanner');
    if (!u) return;
    if (u.state === 'downloading') b.innerHTML = `⬇ Загружается обновление ${u.version ? 'v' + esc(u.version) : ''} <span class="bar"><i style="width:${u.percent || 0}%"></i></span> ${u.percent || 0}%`;
    else if (u.state === 'ready') b.innerHTML = `✅ Версия ${esc(u.version)} готова. <button id="updInstall" class="primary">Перезапустить и обновить</button> <span class="muted">или установится при следующем закрытии</span>`;
    else if (u.state === 'available-web') b.innerHTML = `🆕 Вышла версия ${esc(u.version)}. <a class="btn primary" href="${esc(u.url)}" target="_blank" rel="noopener">Скачать</a>`;
    else return b.classList.add('hidden');
    b.classList.remove('hidden');
    $('#updInstall')?.addEventListener('click', () => call('/api/update/install', {}, 'Перезапуск…'));
  }
  $('#appVersion').addEventListener('click', () =>
    call('/api/update/check', {}).then((u) => {
      if (!u) return;
      renderUpdate(u);
      const msg = { latest: 'У вас последняя версия', checking: 'Проверяю…', dev: 'Режим разработки: обновления отключены', portable: 'Портативная версия обновляется вручную — скачайте новую с сайта', error: `Ошибка проверки: ${u.error || ''}` }[u.state];
      if (msg) toast(msg, u.state === 'error');
    }),
  );

  // ---------- sound & TTS in the app ----------
  // By default TikLive speaks and plays sounds itself: OBS's built-in browser often has no
  // speech voices, so relying on the overlay alone left streamers with silent TTS.
  const inApp = (output) => (output || S?.config?.settings?.tts?.output || 'app') === 'app';
  let voices = [];
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    voices = speechSynthesis.getVoices();
    const sel = $('#ttsVoice');
    if (!sel || !voices.length) return;
    const current = S?.config?.settings?.tts?.voice || sel.value;
    sel.replaceChildren(new Option('Автоматически по языку', ''), ...voices.map((v) => new Option(`${v.name} (${v.lang})`, v.name)));
    sel.value = current;
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  }
  function speakInApp(p) {
    if (!inApp(p.output) || !('speechSynthesis' in window) || !p.text) return;
    const u = new SpeechSynthesisUtterance(p.text);
    u.lang = p.lang || 'ru-RU';
    u.rate = p.rate || 1;
    u.volume = p.volume ?? 1;
    const v = voices.find((x) => x.name === p.voice) || voices.find((x) => x.lang === u.lang) || voices.find((x) => x.lang.startsWith(u.lang.slice(0, 2)));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
  function soundInApp(url, volume = 1, output) {
    if (!inApp(output) || !url) return;
    const a = new Audio(url);
    a.volume = Math.max(0, Math.min(1, volume));
    a.play().catch(() => {});
  }
  // Browsers unlock audio after the first click; a no-op utterance warms the speech engine up.
  document.addEventListener('click', () => 'speechSynthesis' in window && speechSynthesis.resume(), { once: true });
  $('#ttsCheck').onclick = () => {
    const f = $('#settingsForm');
    speakInApp({ text: 'Привет! Так будет звучать озвучка на эфире.', lang: f.elements['tts.lang'].value, voice: f.elements['tts.voice'].value, rate: Number(f.elements['tts.rate'].value) || 1, volume: 1, output: 'app' });
  };
  function renderAudioHint() {
    const o = S?.config?.settings?.tts?.output || 'app';
    $('#audioHint').textContent = o === 'app' ? '🔊 Звук и озвучка играют в этой программе' : '🔊 Звук и озвучка — в оверлее OBS';
    const src = `${overlayBase()}?w=alerts&preview=1&audio=0`;
    if ($('#alertPreview').getAttribute('src') !== src) $('#alertPreview').src = src;
  }

  // ---------- live socket ----------
  // Web version: account bar, hide what a server cannot do on the streamer's PC.
  function renderVerify(verified) {
    let b = $('#verifyBanner');
    if (verified) return b?.remove();
    if (b) return;
    b = document.createElement('div');
    b.id = 'verifyBanner';
    b.className = 'plan-banner expired';
    b.innerHTML = `📧 Подтвердите e-mail ${esc(S.hosted.email)} — ссылка в письме. До этого не работают подключение эфира и ИИ.`;
    b.append(button('Отправить письмо ещё раз', () => api('/api/account/resend-verification', {}).then((r) => toast(r.message)).catch((e) => toast(e.message, true))));
    $('header').after(b);
  }

  function applyHosted(h) {
    if (!h) return;
    renderVerify(h.emailVerified);
    const q = new URLSearchParams(location.search);
    if (q.has('verified')) toast('✅ E-mail подтверждён');
    if (q.get('verify_error')) toast(q.get('verify_error'), true);
    if (q.get('error')) toast(q.get('error'), true);
    if (q.get('linked') === 'tiktok') toast('✅ TikTok привязан');
    if (['verified', 'verify_error', 'error', 'linked'].some((k) => q.has(k))) history.replaceState(null, '', location.pathname);
    if ($('#account')) return;
    const bar = document.createElement('div');
    bar.id = 'account';
    bar.className = 'account';
    bar.innerHTML = `${h.tiktok?.avatar ? `<img class="avatar" src="${esc(h.tiktok.avatar)}" alt="" onerror="this.remove()">` : ''}<span>${esc(h.label || h.email)}</span>`;
    bar.append(button('Выйти', () => api('/auth/logout', {}).finally(() => (location.href = '/login'))));
    $('header').append(bar);
    $('#tabs [data-tab=keyboard]')?.remove();
    for (const el of $$('[name="obs.url"], [name="obs.password"], #obsConnect')) el.disabled = true;
    const obsNote = document.createElement('p');
    obsNote.className = 'muted';
    obsNote.textContent = 'Управление OBS и клавиатурой работает в приложении для ПК. В веб-версии оверлеи добавляются в OBS по ссылкам с вкладки «Оверлеи».';
    $('#obsConnect')?.after(obsNote);
    $('#aiMode')?.closest('label')?.classList.add('hidden');
    $('#aiOwn')?.remove();
    const aiNote = document.createElement('p');
    aiNote.className = 'muted';
    aiNote.textContent = h.aiReady ? 'ИИ работает на сервере TikLive — ключи настраивать не нужно.' : 'ИИ на этом сервере пока не подключён.';
    $('#aiForm h3')?.after(aiNote);
    const rot = button('🔄 Сменить ссылки оверлеев', () => {
      if (!confirm('Старые ссылки в OBS перестанут работать. Продолжить?')) return;
      call('/api/overlay/rotate', {}, 'Новые ссылки созданы — обновите источники в OBS').then((r) => {
        if (!r) return;
        S.hosted.overlayPath = r.overlayPath;
        $('#overlayList').replaceChildren();
        renderOverlays();
      });
    });
    $('#tab-overlays p.muted')?.after(rot);

    const payNote = $('#tab-pro .pro-card > p.muted');
    if (payNote) payNote.textContent = 'Оплата картой через Lemon Squeezy (налоги и чеки — на их стороне). Подписка привязывается к этому аккаунту. Отменить можно в любой момент кнопкой «Управление подпиской» — Pro будет работать до конца оплаченного месяца.';
    // Pro arrives by itself after payment; the key form stays only as a fallback.
    const licForm = $('#licenseForm');
    if (licForm) {
      const d = document.createElement('details');
      d.innerHTML = '<summary class="muted">У меня есть ключ лицензии</summary>';
      licForm.before(d);
      d.append(licForm);
      $('#tab-pro h3')?.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'После оплаты Pro включится автоматически в течение минуты — ключ вводить не нужно.' }));
    }

    // Change password (web accounts only).
    const card = document.createElement('form');
    card.className = 'card';
    // Accounts created through Google can set a password (to also log in by e-mail) without a current one.
    // TikTok-only accounts have no e-mail, so a password would be useless: they sign in with TikTok.
    card.innerHTML = !h.email
      ? '<h3>Аккаунт</h3><p class="muted">Вы входите через TikTok. Пароль не нужен.</p>'
      : h.hasPassword
      ? '<h3>Аккаунт</h3><label>Текущий пароль<input name="current" type="password" autocomplete="current-password" required></label><label>Новый пароль<input name="password" type="password" minlength="8" autocomplete="new-password" required></label><button class="save">Сменить пароль</button>'
      : '<h3>Аккаунт</h3><p class="muted">Вы входите через Google. Можно задать пароль, чтобы входить и по e-mail.</p><label>Пароль<input name="password" type="password" minlength="8" autocomplete="new-password" required></label><button class="save">Задать пароль</button>';
    if (h.googleLinked) card.querySelector('h3').insertAdjacentHTML('afterend', '<p class="muted">✅ Привязан аккаунт Google</p>');
    if (h.tiktok) card.querySelector('h3').insertAdjacentHTML('afterend', `<p class="muted">✅ Привязан TikTok ${esc(h.tiktok.username ? '@' + h.tiktok.username : h.tiktok.displayName || '')}</p>`);
    else if (h.tiktokLogin) {
      const a = document.createElement('a');
      a.className = 'btn';
      a.href = '/auth/tiktok?link=1';
      a.textContent = 'Привязать TikTok — ник подставится сам';
      card.querySelector('h3').after(a);
    }
    card.addEventListener('submit', (e) => {
      e.preventDefault();
      call('/auth/change', Object.fromEntries(new FormData(card)), 'Пароль сохранён').then((r) => r && card.reset());
    });
    $('#settingsForm')?.after(card);
  }

  function hydrate(state) {
    S = state;
    applyHosted(state.hosted);
    $('#username').value = state.config.settings.username || '';
    renderStatus(state.status);
    renderStats({ ...state.stats, queue: state.queue });
    $('#feed').replaceChildren();
    state.feed.forEach((ev) => addFeed(ev, false));
    $('#log').replaceChildren();
    state.log.forEach((l) => addLog(l, false));
    renderRules();
    renderGoals();
    renderWheel();
    renderPoll(state.poll);
    renderBattle(state.battle);
    renderSim(state.simulator);
    renderSettings();
    renderSongs(state.songs);
    renderLicense(state.license);
    renderUpdate(state.app?.update, state.app?.version, state.app?.canInstall);
    renderKeyboard(state.keyboard);
    fillForm($('#songsForm'), state.config.settings.songs || {});
    fillForm($('#aiForm'), state.config.settings.ai || {});
    syncAiMode();
    fillForm($('#kbForm'), state.config.settings.keyboard || {});
  }
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onmessage = (m) => {
      const { type, payload } = JSON.parse(m.data);
      if (type === 'hello') return dirty && S ? null : hydrate(payload);
      if (!S) return;
      switch (type) {
        case 'status': return renderStatus(payload);
        case 'event': return addFeed(payload);
        case 'log': return addLog(payload);
        case 'stats': return renderStats(payload);
        case 'alert':
          soundInApp(payload.sound, 1, payload.output);
          return renderQueue({ ...S.queue, current: payload });
        case 'tts': return speakInApp(payload);
        case 'sound': return soundInApp(payload.url, payload.volume, payload.output);
        case 'config':
          if (!dirty) {
            S.config = payload;
            renderAudioHint();
          }
          return;
        case 'poll': return renderPoll(payload);
        case 'battle': return renderBattle(payload);
        case 'songs': return renderSongs(payload);
        case 'license': return renderLicense(payload);
        case 'update': return renderUpdate(payload);
        case 'account':
          if (S.hosted && payload.emailVerified) {
            S.hosted.emailVerified = true;
            renderVerify(true);
            toast('✅ E-mail подтверждён');
          }
          return;
        case 'ai': return addAi(payload);
        case 'goals':
          if (!dirty) {
            S.config.goals = payload;
            if ($('#tab-goals').classList.contains('active')) renderGoals();
          }
          return;
      }
    };
    ws.onclose = (e) => {
      if (S?.hosted && e.code === 1006) fetch('/api/license').then((r) => r.status === 401 && (location.href = '/login')).catch(() => {});
      renderStatus({ state: 'error', error: 'нет связи с сервером' });
      setTimeout(connect, 2000);
    };
  }
  connect();
})();
