// One overlay script, many widgets: /overlay/?w=alerts|goals|chat|top|wheel|poll|battle|counter|audio
(() => {
  const params = new URLSearchParams(location.search);
  const widget = params.get('w') || 'alerts';
  // Web version: personal overlay URLs look like /o/<token>/?w=alerts
  const overlayToken = (/^\/o\/([\w-]+)/.exec(location.pathname) || [])[1] || '';
  const root = document.getElementById('root');
  if (params.has('preview')) document.body.classList.add('preview');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.floor(n)));
  const img = (src, cls) => (src ? `<img class="${cls}" src="${esc(src)}" onerror="this.remove()" alt="">` : '');

  // ---------------- audio (sound + TTS) ----------------
  // Where sound plays is a setting: 'app' (TikLive window, default) or 'obs' (this overlay).
  // ?w=audio always plays, &audio=1 forces it on, &audio=0 forces it off.
  const forced = widget === 'audio' || params.get('audio') === '1';
  const audioOn = (output) => params.get('audio') !== '0' && (forced || (widget === 'alerts' && output === 'obs'));
  function playSound(url, volume = 1, output) {
    if (!audioOn(output) || !url) return;
    const a = new Audio(url);
    a.volume = Math.max(0, Math.min(1, volume));
    a.play().catch(() => {});
  }
  // Phrases play in order: neural mp3 from the server, else the browser's voice.
  const ttsQueue = [];
  let ttsBusy = false;
  function speak(p) {
    if (!audioOn(p.output) || !p.text) return;
    if (ttsQueue.length >= 4) ttsQueue.shift();
    ttsQueue.push(p);
    nextTts();
  }
  function nextTts() {
    if (ttsBusy || !ttsQueue.length) return;
    const p = ttsQueue.shift();
    ttsBusy = true;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      ttsBusy = false;
      nextTts();
    };
    const guard = setTimeout(done, 30000);
    if (p.audio) {
      const a = new Audio(p.audio);
      a.volume = Math.max(0, Math.min(1, p.volume ?? 1));
      a.onended = a.onerror = done;
      a.play().catch(done);
    } else if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(p.text);
      u.lang = p.lang || 'ru-RU';
      u.rate = p.rate || 1;
      u.volume = p.volume ?? 1;
      const voices = speechSynthesis.getVoices();
      const voice = voices.find((v) => v.name === p.voice) || voices.find((v) => v.lang === u.lang);
      if (voice) u.voice = voice;
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    } else done();
  }

  // ---------------- effects: confetti, hearts, diamonds, stars, fireworks, gift rain ----------------
  const cv = document.getElementById('confetti');
  const cx = cv.getContext('2d');
  let parts = [];
  let running = false;
  const COLORS = ['#fe2c55', '#25f4ee', '#ffc93c', '#b86bff', '#06d6a0'];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const images = new Map();
  function loadImg(src) {
    if (!src) return null;
    if (!images.has(src)) {
      const im = new Image();
      im.src = src;
      images.set(src, im);
    }
    return images.get(src);
  }
  function add(p) {
    parts.push({ life: 150, max: p.life || 150, rot: 0, vr: 0, g: 0.45, drag: 1, alpha: 1, ...p });
    if (!running) {
      running = true;
      requestAnimationFrame(draw);
    }
  }
  function confetti() {
    for (let i = 0; i < 180; i++)
      add({ kind: 'rect', x: innerWidth / 2, y: innerHeight / 2, vx: rnd(-9, 9), vy: rnd(-22, -4), r: rnd(3, 9), c: COLORS[i % COLORS.length], life: rnd(120, 180), vr: rnd(-0.3, 0.3) });
  }
  function emojiRain(chars, { up = false, n = 40 } = {}) {
    for (let i = 0; i < n; i++)
      add({
        kind: 'text', t: chars[i % chars.length], x: rnd(0, innerWidth), y: up ? innerHeight + rnd(20, 300) : rnd(-400, -30),
        vx: rnd(-1, 1), vy: up ? rnd(-7, -3) : rnd(3, 7), g: 0, size: rnd(26, 54), life: rnd(160, 230), sway: rnd(0, 6), vr: up ? 0 : rnd(-0.05, 0.05),
      });
  }
  function stars() {
    for (let i = 0; i < 70; i++) {
      const a = rnd(0, Math.PI * 2), v = rnd(4, 14);
      add({ kind: 'text', t: i % 3 ? '✨' : '⭐', x: innerWidth / 2, y: innerHeight / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0.08, drag: 0.97, size: rnd(18, 40), life: rnd(70, 110) });
    }
  }
  function fireworks() {
    for (let k = 0; k < 6; k++)
      setTimeout(() => {
        const x = rnd(innerWidth * 0.15, innerWidth * 0.85), y = rnd(innerHeight * 0.12, innerHeight * 0.45), c = COLORS[k % COLORS.length];
        for (let i = 0; i < 90; i++) {
          const a = (i / 90) * Math.PI * 2, v = rnd(2, 9);
          add({ kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0.07, drag: 0.98, r: rnd(2, 4), c: i % 4 ? c : '#fff', life: rnd(60, 100) });
        }
      }, k * 420);
  }
  function giftRain(src) {
    const im = loadImg(src);
    for (let i = 0; i < 36; i++)
      add(im ? { kind: 'img', im, x: rnd(0, innerWidth), y: rnd(-600, -40), vx: rnd(-1, 1), vy: rnd(3, 8), g: 0.03, size: rnd(48, 96), life: 260, vr: rnd(-0.04, 0.04) }
        : { kind: 'text', t: '🎁', x: rnd(0, innerWidth), y: rnd(-600, -40), vx: rnd(-1, 1), vy: rnd(3, 8), g: 0.03, size: rnd(40, 70), life: 260, vr: rnd(-0.04, 0.04) });
  }
  function effect(name, a = {}) {
    if (name === 'confetti') confetti();
    else if (name === 'hearts') emojiRain(['❤️', '💖', '💕', '💗'], { up: true });
    else if (name === 'diamonds') emojiRain(['💎']);
    else if (name === 'stars') stars();
    else if (name === 'fireworks') fireworks();
    else if (name === 'giftRain') giftRain(a.giftImage || a.image);
  }
  function draw() {
    if (cv.width !== innerWidth || cv.height !== innerHeight) {
      cv.width = innerWidth;
      cv.height = innerHeight;
    }
    cx.clearRect(0, 0, cv.width, cv.height);
    parts = parts.filter((p) => p.life-- > 0 && p.y < innerHeight + 200 && p.y > -800);
    for (const p of parts) {
      p.vy += p.g;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.x += p.vx + (p.sway ? Math.sin(p.life / 12) * p.sway * 0.15 : 0);
      p.y += p.vy;
      p.rot += p.vr;
      cx.globalAlpha = Math.min(1, p.life / 30);
      cx.save();
      cx.translate(p.x, p.y);
      cx.rotate(p.rot);
      if (p.kind === 'rect') {
        cx.fillStyle = p.c;
        cx.fillRect(-p.r / 2, -p.r, p.r, p.r * 1.6);
      } else if (p.kind === 'spark') {
        cx.fillStyle = p.c;
        cx.beginPath();
        cx.arc(0, 0, p.r, 0, Math.PI * 2);
        cx.fill();
      } else if (p.kind === 'text') {
        cx.font = `${p.size}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        cx.fillText(p.t, 0, 0);
      } else if (p.kind === 'img' && p.im.complete && p.im.naturalWidth) {
        cx.drawImage(p.im, -p.size / 2, -p.size / 2, p.size, p.size);
      }
      cx.restore();
    }
    cx.globalAlpha = 1;
    if (parts.length) requestAnimationFrame(draw);
    else {
      running = false;
      cx.clearRect(0, 0, cv.width, cv.height);
    }
  }

  // ---------------- widgets ----------------
  const W = {};

  W.alerts = {
    init() {
      root.innerHTML = '<div class="alert-stage"></div>';
      this.stage = root.firstChild;
    },
    alert(a) {
      const el = document.createElement('div');
      el.className = `alert ${a.style || ''} ${a.animation ? `anim-${a.animation}` : ''}`;
      el.innerHTML = `${img(a.avatar, 'avatar')}<div class="txt shadow">${esc(a.text)}${a.count > 1 ? `<span class="cnt">×${a.count}</span>` : ''}</div>${img(a.image, 'gift')}`;
      // Entrance video (or any alert with media): above the text, ends with the alert.
      if (a.video) {
        const isImg = /\.(gif|png|jpe?g|webp)(\?|$)/i.test(a.video);
        const m = document.createElement(isImg ? 'img' : 'video');
        m.className = 'alert-media';
        m.src = a.video;
        if (!isImg) {
          m.autoplay = true;
          m.playsInline = true;
          // Sound of the video goes to OBS; the in-app preview stays silent.
          m.muted = params.get('audio') === '0';
          m.volume = Math.max(0, Math.min(1, a.volume ?? 0.8));
          m.play().catch(() => {
            m.muted = true;
            m.play().catch(() => {});
          });
          m.onended = () => el.classList.add('out');
        }
        el.classList.add('has-media');
        el.prepend(m);
      }
      this.stage.replaceChildren(el);
      playSound(a.sound, a.volume ?? 1, a.output);
      effect(a.effect || (a.confetti ? 'confetti' : ''), a);
      if (a.animation === 'shake') document.body.classList.add('shake-screen'), setTimeout(() => document.body.classList.remove('shake-screen'), 700);
      const ms = (a.duration || 5) * 1000;
      setTimeout(() => el.classList.add('out'), Math.max(300, ms - 400));
      setTimeout(() => el.remove(), ms);
    },
  };

  W.goals = {
    init(state) {
      this.only = params.get('goal');
      this.goals(state.config.goals);
    },
    goals(goals) {
      const list = goals.filter((g) => g.enabled !== false && (!this.only || g.id === this.only));
      root.innerHTML = `<div class="goals">${list
        .map((g) => {
          const pct = Math.min(100, (g.current / Math.max(1, g.target)) * 100);
          return `<div class="goal ${pct >= 100 ? 'done' : ''}"><div class="head shadow"><span>${esc(g.title)}</span><span>${fmt(g.current)} / ${fmt(g.target)}</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
        })
        .join('')}</div>`;
    },
    goalComplete() {
      confetti();
    },
  };

  W.chat = {
    init(state) {
      root.innerHTML = '<div class="chat"></div>';
      this.box = root.firstChild;
      this.max = Number(params.get('max')) || 12;
      this.showAll = params.get('all') === '1';
      state.feed.slice(0, this.max).reverse().forEach((ev) => this.event(ev));
    },
    event(ev) {
      let body;
      if (ev.type === 'chat') body = esc(ev.text);
      else if (!this.showAll) return;
      else if (ev.type === 'gift') {
        if (ev.streaking) return;
        body = `🎁 ${esc(ev.giftName)} ×${ev.count}`;
      } else if (ev.type === 'follow') body = '💖 подписался';
      else if (ev.type === 'share') body = '🔁 поделился';
      else return;
      const el = document.createElement('div');
      el.className = `msg ${ev.type}`;
      el.innerHTML = `${img(ev.user.avatar, '')}<div><b>${esc(ev.user.nickname)}</b>${body}</div>`;
      this.box.append(el);
      while (this.box.children.length > this.max) this.box.firstChild.remove();
    },
  };

  W.top = {
    init(state) {
      this.by = params.get('by') || 'diamonds';
      this.n = Number(params.get('n')) || 5;
      this.stats({ ...state.stats, topPoints: state.topPoints });
    },
    stats(s) {
      const map = { diamonds: ['🏆 Топ донатеров', s.topGifters, 'diamonds', '💎'], likes: ['❤️ Топ лайкеров', s.topLikers, 'likes', ''], chats: ['💬 Самые активные', s.topChatters, 'chats', ''], points: ['⭐ Топ по очкам', s.topPoints, 'points', ''] };
      const [title, list = [], field, suffix] = map[this.by] || map.diamonds;
      root.innerHTML = `<div class="board"><h3 class="shadow">${title}</h3>${list
        .slice(0, this.n)
        .map((u, i) => `<div class="row"><span class="n">${i + 1}</span>${img(u.avatar, '')}<span>${esc(u.nickname)}</span><span class="v">${fmt(u[field])}${suffix}</span></div>`)
        .join('')}</div>`;
    },
  };

  W.counter = {
    init(state) {
      this.metric = params.get('metric') || 'likes';
      this.label = params.get('label') || { likes: '❤️', viewers: '👀', diamonds: '💎', follows: '💖', shares: '🔁' }[this.metric] || '';
      root.innerHTML = `<div class="counter shadow"><span>${esc(this.label)}</span><span class="val">0</span></div>`;
      this.val = root.querySelector('.val');
      this.stats(state.stats);
    },
    stats(s) {
      const v = this.metric === 'viewers' ? s.viewers : s.totals[this.metric] ?? 0;
      if (this.val.textContent !== fmt(v)) {
        this.val.textContent = fmt(v);
        this.val.classList.remove('bump');
        void this.val.offsetWidth;
        this.val.classList.add('bump');
      }
    },
  };

  W.wheel = {
    init(state) {
      const size = Number(params.get('size')) || 500;
      root.innerHTML = `<div class="wheel-wrap"><div class="pointer"></div><canvas width="${size}" height="${size}"></canvas><div class="wheel-result shadow"></div></div>`;
      this.canvas = root.querySelector('canvas');
      this.result = root.querySelector('.wheel-result');
      this.angle = 0;
      this.segments = state.config.wheel.segments;
      this.draw();
    },
    config(cfg) {
      this.segments = cfg.wheel.segments;
      this.draw();
    },
    draw() {
      const c = this.canvas.getContext('2d');
      const { width: s } = this.canvas;
      const r = s / 2;
      const segs = this.segments;
      const total = segs.reduce((a, x) => a + (Number(x.weight) || 0), 0) || 1;
      c.clearRect(0, 0, s, s);
      let a0 = this.angle - Math.PI / 2;
      for (const seg of segs) {
        const da = ((Number(seg.weight) || 0) / total) * Math.PI * 2;
        c.beginPath();
        c.moveTo(r, r);
        c.arc(r, r, r - 4, a0, a0 + da);
        c.fillStyle = seg.color || '#888';
        c.fill();
        c.strokeStyle = '#111';
        c.lineWidth = 3;
        c.stroke();
        c.save();
        c.translate(r, r);
        c.rotate(a0 + da / 2);
        c.fillStyle = '#111';
        c.font = `bold ${Math.round(s / 26)}px sans-serif`;
        c.textAlign = 'right';
        c.fillText(seg.label.slice(0, 18), r - 16, 6);
        c.restore();
        a0 += da;
      }
      c.beginPath();
      c.arc(r, r, s / 14, 0, Math.PI * 2);
      c.fillStyle = '#fff';
      c.fill();
    },
    wheel(res) {
      this.segments = res.segments;
      const total = res.segments.reduce((a, x) => a + (Number(x.weight) || 0), 0);
      let start = 0;
      for (let i = 0; i < res.index; i++) start += Number(res.segments[i].weight) || 0;
      const mid = ((start + (Number(res.segments[res.index].weight) || 0) / 2) / total) * Math.PI * 2;
      // Land the winning segment's middle under the top pointer, after several full turns.
      const from = this.angle % (Math.PI * 2);
      const to = Math.PI * 2 * 6 - mid;
      const t0 = performance.now();
      const dur = 5000;
      this.result.textContent = res.by ? `Крутит: ${res.by}` : '';
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const ease = 1 - Math.pow(1 - k, 4);
        this.angle = from + (to - from) * ease;
        this.draw();
        if (k < 1) requestAnimationFrame(step);
        else {
          this.result.textContent = `🎉 ${res.label}`;
          confetti();
        }
      };
      requestAnimationFrame(step);
    },
  };

  function countdown(el, endsAt) {
    clearInterval(el._t);
    const tick = () => {
      const s = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      el.textContent = s ? `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '⏱ время вышло';
      if (!s) clearInterval(el._t);
    };
    tick();
    el._t = setInterval(tick, 1000);
  }

  W.poll = {
    init(state) {
      this.poll(state.poll);
    },
    poll(p) {
      if (!p) return (root.innerHTML = '');
      const total = p.options.reduce((s, o) => s + o.votes, 0) || 1;
      const win = p.winner ? p.winner.index : -1;
      root.innerHTML = `<div class="poll"><h2 class="shadow">📊 ${esc(p.question)}</h2>${p.options
        .map((o, i) => `<div class="opt ${i === win ? 'win' : ''}"><div class="lbl shadow"><span>${i + 1}. ${esc(o.label)}</span><span>${o.votes} (${Math.round((o.votes / total) * 100)}%)</span></div><div class="bar"><i style="width:${(o.votes / total) * 100}%"></i></div></div>`)
        .join('')}<div class="timer"></div></div>`;
      const timer = root.querySelector('.timer');
      if (p.active) countdown(timer, p.endsAt);
      else timer.textContent = p.winner ? `🏁 Победил: ${p.winner.label}` : '🏁 Голосование завершено';
      if (!p.active && p.winner) confetti();
    },
  };

  W.battle = {
    init(state) {
      this.battle(state.battle);
    },
    battle(b) {
      if (!b) return (root.innerHTML = '');
      const [a, c] = b.teams;
      const sum = a.score + c.score || 1;
      root.innerHTML = `<div class="battle"><h2 class="shadow">⚔ ${esc(a.name)} vs ${esc(c.name)}</h2><div class="versus"><div style="background:${esc(a.color || '#fe2c55')};flex-grow:${a.score / sum + 0.01}">${esc(a.name)} ${fmt(a.score)}</div><div style="background:${esc(c.color || '#25f4ee')};flex-grow:${c.score / sum + 0.01};color:#111">${fmt(c.score)} ${esc(c.name)}</div></div><div class="timer"></div></div>`;
      const timer = root.querySelector('.timer');
      if (b.active) countdown(timer, b.endsAt);
      else {
        timer.textContent = b.winner ? `🏆 Победа: ${b.winner}` : '🤝 Ничья';
        confetti();
      }
    },
  };

  W.audio = { init() {} };

  W.songs = {
    init(state) {
      this.n = Number(params.get('n')) || 5;
      this.songs(state.songs);
    },
    songs(snap) {
      if (!snap) return;
      const label = (x) => esc(x.title || (x.videoId ? 'YouTube-трек' : x.query));
      const c = snap.current;
      root.innerHTML = `<div class="songs">${c ? `<div class="np"><span class="eq"><i></i><i></i><i></i></span><div><div class="t shadow">${label(c)}</div><div class="by">заказал ${esc(c.nickname)}</div></div></div>` : '<div class="np idle shadow">🎵 Закажи песню: !sr название</div>'}${snap.queue
        .slice(0, this.n)
        .map((x, i) => `<div class="next"><b>${i + 1}</b> ${label(x)} <span>— ${esc(x.nickname)}</span></div>`)
        .join('')}</div>`;
    },
  };

  W.player = {
    init(state) {
      root.innerHTML = '<div id="yt"></div>';
      if (params.get('video') === '0') root.style.opacity = '0';
      this.pending = state.songs?.current || null;
      window.onYouTubeIframeAPIReady = () => {
        this.yt = new YT.Player('yt', {
          width: Number(params.get('width')) || 640,
          height: Number(params.get('height')) || 360,
          playerVars: { autoplay: 1, controls: 0, rel: 0 },
          events: {
            onReady: () => this.play(this.pending),
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.PLAYING && this.cur) {
                const title = this.yt.getVideoData?.().title;
                if (title && title !== this.cur.title) post('/api/songs/title', { id: this.cur.id, title });
              }
              if (e.data === YT.PlayerState.ENDED) this.advance();
            },
            onError: () => this.advance(),
          },
        });
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.append(tag);
    },
    // expectId makes the server ignore duplicate "next" calls from several player instances.
    advance() {
      if (this.cur) post('/api/songs/next', { expectId: this.cur.id });
    },
    play(song) {
      this.pending = song;
      if (!this.yt?.loadVideoById) return;
      if (song?.id === this.cur?.id) return;
      this.cur = song;
      if (song?.videoId) this.yt.loadVideoById(song.videoId);
      else this.yt.stopVideo();
    },
    songs(snap) {
      this.play(snap.current);
    },
  };

  W.ai = {
    init() {
      this.sec = Number(params.get('sec')) || 12;
    },
    ai(a) {
      root.innerHTML = `<div class="aicard">${img(a.avatar, 'avatar')}<div><div class="q shadow"><b>${esc(a.nickname)}:</b> ${esc(a.question)}</div><div class="a">🤖 ${esc(a.answer)}</div></div></div>`;
      clearTimeout(this.t);
      this.t = setTimeout(() => root.firstChild?.classList.add('out'), this.sec * 1000);
    },
  };

  function post(path, body) {
    fetch(overlayToken ? `/o/${overlayToken}${path}` : path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }

  // ---------------- transport ----------------
  const w = W[widget] || W.alerts;
  let first = true;
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${overlayToken ? `?t=${encodeURIComponent(overlayToken)}` : ''}`);
    ws.onmessage = (m) => {
      const { type, payload } = JSON.parse(m.data);
      if (type === 'hello') {
        if (first) w.init(payload);
        first = false;
        return;
      }
      if (type === 'sound') return playSound(payload.url, payload.volume, payload.output);
      if (type === 'tts') return speak(payload);
      if (type === 'config' && w.config) return w.config(payload);
      if (typeof w[type] === 'function' && type !== 'init') w[type](payload);
    };
    ws.onclose = () => setTimeout(connect, 2000); // survive server restarts without touching OBS
  }
  connect();
})();
