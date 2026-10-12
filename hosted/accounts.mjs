// Accounts for the hosted (web) version: email + password, cookie sessions, overlay tokens.
// Stored in one JSON file; passwords are scrypt-hashed, session tokens are stored only as hashes.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const SESSION_DAYS = 30;
const RESET_MS = 60 * 60 * 1000;
const VERIFY_MS = 48 * 60 * 60 * 1000;
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
    this.data = { users: {}, sessions: {}, resets: {}, verifies: {} };
    if (file && existsSync(file)) this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) };
    this.data.verifies ||= {};
    this.byEmail = new Map(Object.entries(this.data.users).map(([id, u]) => [u.email, id]));
    this.byOverlay = new Map(Object.entries(this.data.users).map(([id, u]) => [u.overlayToken, id]));
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.file}.tmp`, this.file);
  }

  // verified=false when the server sends a confirmation letter; accounts created before
  // this feature (no field) count as verified.
  signup(rawEmail, password, { verified = true } = {}) {
    const email = normalizeEmail(rawEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Error('Некорректный e-mail');
    if (String(password || '').length < 8) throw new Error('Пароль должен быть не короче 8 символов');
    if (this.byEmail.has(email)) throw new Error('Этот e-mail уже зарегистрирован');
    const id = `u_${token(9)}`;
    const { salt, hash } = hashPassword(password);
    this.data.users[id] = { email, salt, hash, createdAt: this.now(), overlayToken: token(18), autoConnect: false, emailVerified: verified };
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
    return (id && this.data.users[id]) || null;
  }

  idByEmail(email) {
    return this.byEmail.get(normalizeEmail(email)) || null;
  }

  setSubscription(id, subscription) {
    this.data.users[id].subscription = subscription;
    this.save();
  }

  // --- e-mail confirmation -----------------------------------------------------
  isVerified(id) {
    return this.data.users[id]?.emailVerified !== false;
  }

  createVerifyToken(id) {
    const t = token(32);
    for (const [k, v] of Object.entries(this.data.verifies)) if (v.userId === id || v.expires < this.now()) delete this.data.verifies[k];
    this.data.verifies[sha(t)] = { userId: id, expires: this.now() + VERIFY_MS };
    this.save();
    return t;
  }

  // Returns the user id; throws for unknown/expired links.
  verifyEmail(t) {
    const key = sha(t || '');
    const v = this.data.verifies[key];
    if (!v || v.expires < this.now() || !this.data.users[v.userId]) throw new Error('Ссылка подтверждения недействительна или устарела. Отправьте письмо ещё раз из панели.');
    delete this.data.verifies[key];
    this.data.users[v.userId].emailVerified = true;
    this.save();
    return v.userId;
  }

  // --- password reset ----------------------------------------------------------
  // Single-use token, valid for an hour, stored only as a hash.
  createResetToken(id) {
    const t = token(32);
    for (const [k, r] of Object.entries(this.data.resets)) if (r.userId === id || r.expires < this.now()) delete this.data.resets[k];
    this.data.resets[sha(t)] = { userId: id, expires: this.now() + RESET_MS };
    this.save();
    return t;
  }

  resetPassword(t, password) {
    const key = sha(t || '');
    const r = this.data.resets[key];
    if (!r || r.expires < this.now() || !this.data.users[r.userId]) throw new Error('Ссылка для сброса недействительна или устарела. Запросите новую.');
    if (String(password || '').length < 8) throw new Error('Пароль должен быть не короче 8 символов');
    delete this.data.resets[key];
    // The reset link proved access to the mailbox, so the address counts as confirmed too.
    Object.assign(this.data.users[r.userId], hashPassword(password), { emailVerified: true });
    // Log out everywhere: whoever knew the old password loses access.
    for (const [k, s] of Object.entries(this.data.sessions)) if (s.userId === r.userId) delete this.data.sessions[k];
    this.save();
    return r.userId;
  }

  changePassword(id, current, password) {
    const u = this.data.users[id];
    if (!u || !verifyPassword(current, u.salt, u.hash)) throw new Error('Текущий пароль неверный');
    if (String(password || '').length < 8) throw new Error('Пароль должен быть не короче 8 символов');
    Object.assign(u, hashPassword(password));
    this.save();
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
