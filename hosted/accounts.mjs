// Accounts for the hosted (web) version: email + password, cookie sessions, overlay tokens.
// Stored in one JSON file; passwords are scrypt-hashed, session tokens are stored only as hashes.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const SESSION_DAYS = 30;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export class AccountStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { users: {}, sessions: {} };
    if (file && existsSync(file)) this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) };
    this.byEmail = new Map(Object.entries(this.data.users).map(([id, u]) => [u.email, id]));
    this.byOverlay = new Map(Object.entries(this.data.users).map(([id, u]) => [u.overlayToken, id]));
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.file}.tmp`, this.file);
  }

  signup(rawEmail, password) {
    const email = normalizeEmail(rawEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Error('Некорректный e-mail');
    if (String(password || '').length < 8) throw new Error('Пароль должен быть не короче 8 символов');
    if (this.byEmail.has(email)) throw new Error('Этот e-mail уже зарегистрирован');
    const id = `u_${token(9)}`;
    const { salt, hash } = hashPassword(password);
    this.data.users[id] = { email, salt, hash, createdAt: this.now(), overlayToken: token(18), autoConnect: false };
    this.byEmail.set(email, id);
    this.byOverlay.set(this.data.users[id].overlayToken, id);
    this.save();
    return id;
  }

  login(rawEmail, password) {
    const id = this.byEmail.get(normalizeEmail(rawEmail));
    const u = id && this.data.users[id];
    // Always run the hash so response time doesn't reveal whether the e-mail exists.
    const ok = u ? verifyPassword(password, u.salt, u.hash) : (hashPassword(password), false);
    if (!ok) throw new Error('Неверный e-mail или пароль');
    return id;
  }

  createSession(userId) {
    const t = token(32);
    this.data.sessions[sha(t)] = { userId, expires: this.now() + SESSION_DAYS * 86400000 };
    this.pruneSessions();
    this.save();
    return t;
  }

  getSession(t) {
    if (!t) return null;
    const s = this.data.sessions[sha(t)];
    if (!s || s.expires < this.now() || !this.data.users[s.userId]) return null;
    return s.userId;
  }

  destroySession(t) {
    if (t && delete this.data.sessions[sha(t)]) this.save();
  }

  pruneSessions() {
    const now = this.now();
    for (const [k, s] of Object.entries(this.data.sessions)) if (s.expires < now) delete this.data.sessions[k];
  }

  user(id) {
    return this.data.users[id] || null;
  }

  userByOverlayToken(t) {
    return (t && this.byOverlay.get(t)) || null;
  }

  // A leaked overlay link can be revoked: old URLs stop working immediately.
  rotateOverlayToken(id) {
    const u = this.data.users[id];
    this.byOverlay.delete(u.overlayToken);
    u.overlayToken = token(18);
    this.byOverlay.set(u.overlayToken, id);
    this.save();
    return u.overlayToken;
  }

  setAutoConnect(id, value) {
    const u = this.data.users[id];
    if (u && u.autoConnect !== value) {
      u.autoConnect = value;
      this.save();
    }
  }

  allUserIds() {
    return Object.keys(this.data.users);
  }
}
