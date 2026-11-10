// Files the streamer uploads for overlays (entrance videos, pictures). Stored next to the config
// under random names; served to overlays at <overlay base>/media/<name>.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

export const MEDIA_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const NAME = /^[a-f0-9]{16}\.(mp4|webm|gif|png|jpe?g|webp)$/;
const MB = 1024 * 1024;

export class MediaStore {
  constructor({ dir, maxFileMB = 60, maxTotalMB = 1000 } = {}) {
    this.dir = dir;
    this.maxFile = maxFileMB * MB;
    this.maxTotal = maxTotalMB * MB;
  }

  list() {
    if (!this.dir || !existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => NAME.test(f))
      .map((f) => {
        const st = statSync(join(this.dir, f));
        return { file: f, url: `media/${f}`, size: st.size, ts: st.mtimeMs };
      })
      .sort((a, b) => b.ts - a.ts);
  }

  // data: base64 string (the dashboard sends JSON so CSRF protection stays intact).
  save(originalName, data) {
    if (!this.dir) throw new Error('Хранилище файлов недоступно');
    const ext = extname(String(originalName || '')).toLowerCase();
    if (!MEDIA_TYPES[ext]) throw new Error('Поддерживаются видео MP4/WebM и картинки GIF/PNG/JPG/WebP');
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) throw new Error('Пустой файл');
    if (buf.length > this.maxFile) throw new Error(`Файл больше ${Math.round(this.maxFile / MB)} МБ — сожмите видео или обрежьте его`);
    const used = this.list().reduce((n, f) => n + f.size, 0);
    if (used + buf.length > this.maxTotal) throw new Error(`Место для файлов закончилось (${Math.round(this.maxTotal / MB)} МБ) — удалите старые`);
    mkdirSync(this.dir, { recursive: true });
    const file = `${randomBytes(8).toString('hex')}${ext === '.jpeg' ? '.jpg' : ext}`;
    writeFileSync(join(this.dir, file), buf);
    return { file, url: `media/${file}`, size: buf.length };
  }

  remove(file) {
    if (!NAME.test(String(file)) || !this.dir) throw new Error('Нет такого файла');
    const p = join(this.dir, file);
    if (existsSync(p)) unlinkSync(p);
  }

  // Absolute path for serving, or null for anything that isn't one of our files.
  path(file) {
    if (!this.dir || !NAME.test(String(file))) return null;
    const p = join(this.dir, file);
    return existsSync(p) ? p : null;
  }
}

// Serves a media file with Range support (video players seek and probe with ranges).
export async function serveMedia(req, res, path) {
  const { createReadStream } = await import('node:fs');
  const size = statSync(path).size;
  const type = MEDIA_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'max-age=3600' });
    return createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'max-age=3600' });
  createReadStream(path).pipe(res);
}
