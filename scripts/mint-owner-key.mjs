#!/usr/bin/env node
// Mints an owner key (Pro + admin, works offline) for the desktop app and the AI cloud.
//   node scripts/mint-owner-key.mjs <private-key.pem> <name> [--days N] [--role admin|pro] [--note text]
// Keep the .pem file private: anyone holding it can mint keys. To retire a leaked key, add its id
// to OWNER_KEYS_REVOKED on the cloud server (the desktop app checks keys offline and can't be told).

import { readFileSync } from 'node:fs';
import { signOwnerKey, verifyOwnerKey } from '../src/owner-key.mjs';

const [pem, sub, ...rest] = process.argv.slice(2);
if (!pem || !sub) {
  console.error('Использование: node scripts/mint-owner-key.mjs <private-key.pem> <имя> [--days N] [--role admin|pro] [--note текст]');
  process.exit(1);
}
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const role = opt('role') || 'admin';
if (!['admin', 'pro'].includes(role)) throw new Error('--role: admin или pro');
const { token, payload } = signOwnerKey({ sub, role, days: Number(opt('days')) || 0, note: opt('note') || '' }, readFileSync(pem, 'utf8'));
const pub = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).tiklive.ownerPublicKey;
if (!verifyOwnerKey(token, pub)) throw new Error('Ключ не проходит проверку публичным ключом из package.json — это не тот .pem');
console.log(`Ключ для ${payload.sub} (роль ${payload.role}, id ${payload.id}${payload.exp ? `, до ${new Date(payload.exp).toISOString().slice(0, 10)}` : ', бессрочный'}):\n\n${token}\n`);
