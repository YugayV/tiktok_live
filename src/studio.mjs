// Studio wires every subsystem together: event source -> stats/points/goals/games -> rules -> actions.
// It knows nothing about HTTP; the server only calls its methods and forwards `broadcast` messages.

import { join } from 'node:path';
import { RuleEngine } from './rules.mjs';
import { AlertQueue } from './queue.mjs';
import { SessionStats, applyGoals, pointsFor } from './stats.mjs';
import { JsonStore, DEFAULT_CONFIG } from './store.mjs';
import { Poll, GiftBattle, pickWeighted } from './games.mjs';
import { Simulator, fakeEvent } from './simulator.mjs';
import { TikTokSource } from './tiktok.mjs';
import { ObsClient } from './obs.mjs';
import { render } from './template.mjs';
import { normalize } from './normalize.mjs';
import { AiResponder } from './ai.mjs';
import { SongQueue } from './songs.mjs';
import { KeyController, createOsDriver } from './keyboard.mjs';

const DEDUPE_WINDOW_MS = 1500;

export class Studio {
  constructor({ dataDir, broadcast = () => {}, fetchImpl = globalThis.fetch, keyDriver, createAiClient } = {}) {
    this.broadcast = broadcast;
    this.fetch = fetchImpl;
    this.config = new JsonStore(dataDir && join(dataDir, 'config.json'), DEFAULT_CONFIG);
    this.viewers = new JsonStore(dataDir && join(dataDir, 'viewers.json'), { users: {} }, { delay: 3000 });
    this.engine = new RuleEngine();
    this.stats = new SessionStats();
    this.queue = new AlertQueue({ onPlay: (a) => this.broadcast('alert', a) });
    this.sim = new Simulator((ev) => this.handleEvent(ev));
    this.source = new TikTokSource();
    this.obs = new ObsClient();
    this.ai = new AiResponder({ getConfig: () => this.cfg.settings.ai, ...(createAiClient ? { createClient: createAiClient } : {}) });
    this.songs = new SongQueue({ getConfig: () => this.cfg.settings.songs });
    this.keys = new KeyController({ driver: keyDriver || createOsDriver(), getConfig: () => this.cfg.settings.keyboard });
    this.poll = null;
    this.battle = null;
    this.recentKeys = new Map();
    this.feed = [];
    this.log = [];
    this.statsDirty = true;

    this.source.on('event', (ev) => this.handleEvent(ev));
    this.source.on('status', (s) => {
      this.status = s;
      this.broadcast('status', s);
      this.logLine(`TikTok: ${s.state}${s.error ? ' — ' + s.error : ''}`);
    });
    this.source.on('warn', (m) => this.logLine(`⚠ ${m}`));
    this.status = { state: 'disconnected' };

    this.statsTimer = setInterval(() => this.flushStats(), 1000);
    this.statsTimer.unref?.();
  }

  get cfg() {
    return this.config.data;
  }

  logLine(text) {
    const line = { ts: Date.now(), text };
    this.log.unshift(line);
    this.log.length = Math.min(this.log.length, 200);
    this.broadcast('log', line);
  }

  // --- viewer points -----------------------------------------------------
  viewer(user) {
    const users = this.viewers.data.users;
    const v = (users[user.uniqueId] ||= { nickname: user.nickname, points: 0, diamonds: 0, firstSeen: Date.now() });
    v.nickname = user.nickname || v.nickname;
    return v;
  }

  getPoints(uniqueId) {
    return Math.floor(this.viewers.data.users[uniqueId]?.points || 0);
  }

  addPoints(user, amount) {
    if (!amount || !user?.uniqueId || user.uniqueId === 'anonymous') return;
    const v = this.viewer(user);
    v.points = Math.max(0, (v.points || 0) + amount);
    this.viewers.save();
  }

  topPoints(n = 10) {
    return Object.entries(this.viewers.data.users)
      .map(([uniqueId, v]) => ({ uniqueId, nickname: v.nickname, points: Math.floor(v.points) }))
      .sort((a, b) => b.points - a.points)
      .slice(0, n);
  }

  // --- event pipeline ----------------------------------------------------
  isDuplicate(ev) {
    if (ev.type !== 'gift' && ev.type !== 'follow' && ev.type !== 'share') return false;
    const key = `${ev.type}|${ev.user.uniqueId}|${ev.giftId || ''}|${ev.count || ''}|${ev.groupId || ''}|${ev.streaking ? 's' : ''}`;
    const now = Date.now();
    for (const [k, t] of this.recentKeys) if (now - t > DEDUPE_WINDOW_MS) this.recentKeys.delete(k);
    if (this.recentKeys.has(key)) return true;
    this.recentKeys.set(key, now);
    return false;
  }

  handleEvent(ev) {
    if (this.isDuplicate(ev)) return;
    this.stats.record(ev);
    this.statsDirty = true;

    if (ev.user?.uniqueId) {
      this.addPoints(ev.user, pointsFor(ev, this.cfg.settings.pointRates));
      if (ev.type === 'gift' && !ev.streaking) this.viewer(ev.user).diamonds += ev.totalDiamonds;
      ev.points = this.getPoints(ev.user.uniqueId);
    }

    if (ev.type !== 'roomUser') {
      this.feed.unshift(ev);
      this.feed.length = Math.min(this.feed.length, 100);
      this.broadcast('event', ev);
    }

    for (const goal of applyGoals(this.cfg.goals, ev)) {
      this.logLine(`🎯 Цель достигнута: ${goal.title}`);
      this.broadcast('goalComplete', goal);
      this.handleEvent({ ...normalize('goal', {}), text: goal.title, goalId: goal.id });
    }
    if (ev.type === 'gift' || ev.type === 'like' || ev.type === 'follow' || ev.type === 'share') {
      this.broadcast('goals', this.cfg.goals);
      this.config.save();
    }

    if (ev.type === 'chat') {
      if (this.handleSongCommand(ev)) return;
      if (this.poll?.vote(ev.user, ev.text)) this.broadcast('poll', this.poll.snapshot());
      if (this.cfg.settings.tts.readAllChat && !ev.text.startsWith('!')) this.speak(`${ev.user.nickname}: ${ev.text}`);
    }
    if (this.battle?.handle(ev)) this.broadcast('battle', this.battle.snapshot());

    const matches = this.engine.evaluate(ev, this.cfg.rules, { getPoints: (id) => this.getPoints(id) });
    for (const { rule, ev: mev, times, denied } of matches) {
      if (denied === 'points') {
        this.logLine(`⛔ ${ev.user.nickname}: не хватает очков для «${rule.name}» (нужно ${rule.cost})`);
        continue;
      }
      if (rule.cost) {
        this.addPoints(ev.user, -rule.cost);
        mev.points = this.getPoints(ev.user.uniqueId);
      }
      this.logLine(`⚡ ${rule.name}${times > 1 ? ` ×${times}` : ''} ← ${ev.user.nickname}`);
      for (let i = 0; i < times; i++) for (const action of rule.actions || []) this.runAction(action, mev, rule);
    }
  }

  censor(text, { stripLinks = true } = {}) {
    const words = String(this.cfg.settings.bannedWords || '')
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
    let out = String(text);
    for (const w of words) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '***');
    return stripLinks ? out.replace(/https?:\/\/\S+/gi, '[ссылка]') : out;
  }

  speak(text) {
    const tts = this.cfg.settings.tts;
    const clean = this.censor(text).slice(0, tts.maxLength || 200);
    if (clean.trim()) this.broadcast('tts', { text: clean, lang: tts.lang, rate: tts.rate, volume: tts.volume });
  }

  runAction(action, ev, rule) {
    try {
      switch (action.type) {
        case 'alert':
          this.queue.push({
            id: `${ev.id}-${rule.id}`,
            text: this.censor(render(action.text, ev)),
            image: action.showGiftImage ? ev.giftImage : action.image || '',
            avatar: ev.user?.avatar,
            sound: action.sound || '',
            style: action.style || 'default',
            confetti: Boolean(action.confetti),
            duration: Number(action.duration) || 5,
            priority: rule.priority || 0,
            mergeKey: this.cfg.settings.alertMergeWindow && ev.type === 'gift' ? `${rule.id}|${ev.user.uniqueId}|${ev.giftId}` : '',
          });
          break;
        case 'tts':
          this.speak(render(action.text, ev));
          break;
        case 'sound':
          this.broadcast('sound', { url: action.url, volume: action.volume ?? 1 });
          break;
        case 'goal': {
          const goal = this.cfg.goals.find((g) => g.id === action.goalId);
          if (goal) {
            goal.current += action.amount === 'diamonds' ? ev.totalDiamonds || 0 : Number(action.amount) || 1;
            this.broadcast('goals', this.cfg.goals);
            this.config.save();
          }
          break;
        }
        case 'points':
          this.addPoints(ev.user, Number(action.amount) || 0);
          break;
        case 'wheel':
          this.spinWheel(ev.user?.nickname);
          break;
        case 'obs':
          if (action.scene) this.obs.setScene(action.scene).catch((e) => this.logLine(`OBS: ${e.message}`));
          if (action.source)
            this.obs
              .setSourceVisible(action.sceneName, action.source, action.visible !== false)
              .catch((e) => this.logLine(`OBS: ${e.message}`));
          break;
        case 'webhook':
          this.webhook(action, ev);
          break;
        case 'ai':
          this.answerWithAi(render(action.prompt || '{args}', ev) || ev.text, ev, action);
          break;
        case 'keys':
          this.keys.enqueue(action);
          break;
        case 'songBump':
          if (this.songs.bump(ev.user.uniqueId, Number(action.amount) || 1)) this.broadcastSongs();
          break;
        case 'songSkip':
          this.songNext();
          break;
        case 'overlay':
          this.broadcast('custom', { widget: action.widget, payload: render(action.payload, ev) });
          break;
        default:
          this.logLine(`Неизвестное действие: ${action.type}`);
      }
    } catch (err) {
      this.logLine(`Ошибка действия ${action.type}: ${err.message}`);
    }
  }

  async webhook(action, ev) {
    if (!action.url || !this.fetch) return;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
      const body = action.body ? render(action.body, ev) : JSON.stringify({ event: ev });
      const res = await this.fetch(action.url, {
        method: action.method || 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ctl.signal,
      });
      if (!res.ok) this.logLine(`Webhook ${action.url}: HTTP ${res.status}`);
    } catch (err) {
      this.logLine(`Webhook ${action.url}: ${err.message}`);
    } finally {
      clearTimeout(t);
    }
  }

  // --- AI answers ----------------------------------------------------------
  async answerWithAi(question, ev, action = {}) {
    try {
      const answer = await this.ai.ask(question, ev.user);
      if (!answer) return;
      const clean = this.censor(answer);
      this.logLine(`🤖 ${ev.user.nickname}: ${question} → ${clean}`);
      this.broadcast('ai', { question: this.censor(question), answer: clean, nickname: ev.user.nickname, avatar: ev.user.avatar, ts: Date.now() });
      if (action.alert !== false)
        this.queue.push({ id: `${ev.id}-ai`, text: `🤖 @${ev.user.nickname}, ${clean}`, avatar: ev.user.avatar, style: 'blue', duration: Math.min(15, 4 + clean.length / 20), priority: 1 });
      if (action.speak) this.speak(clean);
    } catch (err) {
      this.logLine(`🤖 Ошибка ИИ: ${err?.status ? `HTTP ${err.status} ` : ''}${err?.message || err}`);
    }
  }

  // --- song requests -------------------------------------------------------
  broadcastSongs() {
    this.broadcast('songs', this.songs.snapshot());
  }

  matchCommand(text, list) {
    const lt = text.trim().toLowerCase();
    for (const c of String(list || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
      if (lt === c || lt.startsWith(c + ' ')) return text.trim().slice(c.length).trim();
    return null;
  }

  songNotice(text) {
    this.queue.push({ id: `song-${Date.now()}`, text, style: 'blue', duration: 4, priority: 0 });
  }

  // Built-in chat commands for the song queue. Returns true when the message was a song command.
  handleSongCommand(ev) {
    const cfg = this.cfg.settings.songs;
    if (!cfg?.enabled) return false;
    const u = ev.user;
    let args = this.matchCommand(ev.text, cfg.requestCommand);
    if (args !== null) {
      if (cfg.cost && this.getPoints(u.uniqueId) < cfg.cost) {
        this.songNotice(`🎵 @${u.nickname}, заказ стоит ${cfg.cost} очков`);
        return true;
      }
      const res = this.songs.request(u, this.censor(args, { stripLinks: false }), { priority: u.isSubscriber ? 1 : 0 });
      if (res.ok) {
        if (cfg.cost) this.addPoints(u, -cfg.cost);
        this.songNotice(`🎵 ${u.nickname} заказал: ${res.song.title || 'YouTube-трек'} (#${res.position})`);
        this.logLine(`🎵 Заказ: ${res.song.query} ← ${u.nickname}`);
        this.fetchSongTitle(res.song);
        if (!this.songs.current && cfg.autoplay) this.songNext();
        else this.broadcastSongs();
      } else this.songNotice(`🎵 @${u.nickname}: ${res.error}`);
      return true;
    }
    if (this.matchCommand(ev.text, cfg.currentCommand) !== null) {
      const c = this.songs.current;
      this.songNotice(c ? `🎵 Сейчас: ${c.title || c.query} (от ${c.nickname})` : '🎵 Сейчас ничего не играет');
      return true;
    }
    if (this.matchCommand(ev.text, cfg.removeCommand) !== null) {
      if (this.songs.removeLastOf(u.uniqueId)) this.broadcastSongs();
      return true;
    }
    if (this.matchCommand(ev.text, cfg.skipCommand) !== null && u.isModerator) {
      this.songNext();
      return true;
    }
    return false;
  }

  // Fills in real titles for YouTube requests (oEmbed needs no API key). Best effort.
  async fetchSongTitle(song) {
    if (!song?.videoId || !this.fetch) return;
    try {
      const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + song.videoId)}`;
      const res = await this.fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const { title } = await res.json();
      if (title) {
        this.songs.setTitle(song.id, this.censor(title));
        this.broadcastSongs();
      }
    } catch {
      // offline or blocked: the player overlay reports the title once the video starts
    }
  }

  songNext() {
    const song = this.songs.next();
    this.broadcastSongs();
    if (song) this.logLine(`▶ Играет: ${song.title || song.query} (от ${song.nickname})`);
    return song;
  }

  // --- games -------------------------------------------------------------
  spinWheel(by = '') {
    const segments = this.cfg.wheel.segments;
    const index = pickWeighted(segments);
    if (index < 0) return null;
    const result = { index, segments, label: segments[index].label, by, spinId: Date.now() };
    this.broadcast('wheel', result);
    setTimeout(() => this.logLine(`🎡 Колесо: ${result.label}${by ? ` (${by})` : ''}`), 5000).unref?.();
    return result;
  }

  startPoll({ question, options, durationSec }) {
    const opts = (Array.isArray(options) ? options : String(options).split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (opts.length < 2) throw new Error('Нужно минимум 2 варианта');
    this.poll = new Poll({ question, options: opts, durationSec: Number(durationSec) || 60 });
    this.broadcast('poll', this.poll.snapshot());
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.endPoll(), (Number(durationSec) || 60) * 1000);
    return this.poll.snapshot();
  }

  endPoll() {
    if (!this.poll) return null;
    clearTimeout(this.pollTimer);
    this.poll.active = false;
    const snap = { ...this.poll.snapshot(), winner: this.poll.winner() };
    this.broadcast('poll', snap);
    if (snap.winner) this.logLine(`📊 Голосование: победил «${snap.winner.label}» (${snap.winner.votes})`);
    return snap;
  }

  startBattle({ teams, durationSec }) {
    this.battle = new GiftBattle({ teams, durationSec: Number(durationSec) || 180 });
    this.broadcast('battle', this.battle.snapshot());
    clearTimeout(this.battleTimer);
    this.battleTimer = setTimeout(() => this.endBattle(), (Number(durationSec) || 180) * 1000);
    return this.battle.snapshot();
  }

  endBattle() {
    if (!this.battle) return null;
    clearTimeout(this.battleTimer);
    this.battle.active = false;
    const snap = this.battle.snapshot();
    const [a, b] = snap.teams;
    snap.winner = a.score === b.score ? null : a.score > b.score ? a.name : b.name;
    this.broadcast('battle', snap);
    this.logLine(`⚔ Битва окончена: ${snap.winner || 'ничья'}`);
    return snap;
  }

  // --- control -----------------------------------------------------------
  async connect(username) {
    const s = this.cfg.settings;
    if (username) {
      s.username = username;
      this.config.save();
    }
    return this.source.connect(s.username, { autoReconnect: s.autoReconnect, signApiKey: s.signApiKey });
  }

  async connectObs() {
    const { url, password } = this.cfg.settings.obs;
    await this.obs.connect(url, password);
    this.logLine('OBS подключен');
  }

  simulate(type, opts) {
    const ev = fakeEvent(type, opts);
    this.handleEvent(ev);
    return ev;
  }

  resetSession() {
    this.stats.reset();
    this.engine.reset();
    for (const g of this.cfg.goals) g.current = 0;
    this.config.save();
    this.broadcast('goals', this.cfg.goals);
    this.statsDirty = true;
  }

  flushStats() {
    if (!this.statsDirty) return;
    this.statsDirty = false;
    this.broadcast('stats', { ...this.stats.snapshot(), topPoints: this.topPoints(), queue: this.queue.snapshot() });
  }

  state() {
    return {
      status: this.status,
      config: this.cfg,
      stats: this.stats.snapshot(),
      topPoints: this.topPoints(),
      feed: this.feed.slice(0, 50),
      log: this.log.slice(0, 50),
      poll: this.poll?.snapshot() || null,
      battle: this.battle?.snapshot() || null,
      queue: this.queue.snapshot(),
      simulator: this.sim.running,
      songs: this.songs.snapshot(),
      keyboard: this.keys.snapshot(),
      obs: this.obs.ready,
    };
  }

  async shutdown() {
    clearInterval(this.statsTimer);
    this.sim.stop();
    await this.keys.stop();
    await this.source.disconnect();
    this.obs.close();
    this.config.flush();
    this.viewers.flush();
  }
}
