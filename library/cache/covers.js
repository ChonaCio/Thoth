// Covers cache (its own process): book/work covers (first pages) in memory and on disk (data/cache/thumbs/), so
// grids of thousands of works don't open archives again, even after a restart; downloaded/custom cover files in
// memory. It also reads covers ahead (warm: the server sends the list after scans), one at a time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pages: readPages } = require('../media-worker');
const { createLru } = require('./lru');

const DATA_DIR = path.resolve(process.env.THOTH_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
const THUMB_DIR = path.join(DATA_DIR, 'cache', 'thumbs');
const MAX_DISK_FILES = 100000;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/jxl': '.jxl' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));
const lru = createLru({ maxBytes: Math.max(8, Number(process.env.THOTH_COVER_CACHE_MB) || 64) * 1024 * 1024 });
const stats = { requests: 0, diskHits: 0, read: 0 };
const warm = { running: false, total: 0, done: 0, added: 0, startedAt: null, finishedAt: null };
const err = (status, code) => Object.assign(new Error(code), { status, code });
const diskName = key => crypto.createHash('sha1').update(key).digest('hex');

async function diskGet(key) {
  const base = path.join(THUMB_DIR, diskName(key));
  for (const ext of Object.values(EXT)) {
    const buf = await fs.promises.readFile(base + ext).catch(() => null);
    if (buf) return { buf, type: TYPE[ext] };
  }
  return null;
}
let writes = 0;
async function diskSet(key, v) {
  const ext = EXT[v.type];
  if (!ext) return;
  await fs.promises.mkdir(THUMB_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(THUMB_DIR, diskName(key) + ext), v.buf);
  if (++writes % 1000 === 0) pruneDisk().catch(() => {});
}
// Keep the folder bounded: past MAX_DISK_FILES, the oldest 10% go
async function pruneDisk() {
  const names = await fs.promises.readdir(THUMB_DIR).catch(() => []);
  if (names.length <= MAX_DISK_FILES) return;
  const withTime = await Promise.all(names.map(async n => ({ n, t: ((await fs.promises.stat(path.join(THUMB_DIR, n)).catch(() => null)) || { mtimeMs: 0 }).mtimeMs })));
  withTime.sort((a, b) => a.t - b.t);
  for (const x of withTime.slice(0, Math.ceil(names.length / 10))) await fs.promises.rm(path.join(THUMB_DIR, x.n), { force: true });
}
async function bookCover({ bookId, file }, { warming = false } = {}) {
  if (!warming) stats.requests++;
  const st = await fs.promises.stat(file).catch(() => { throw err(404, 'fileMissing'); });
  const key = `t:${bookId}:${Math.round(st.mtimeMs)}`;
  const etag = `"${bookId}-${Math.round(st.mtimeMs)}-1"`;
  let v = lru.get(key);
  if (v) return Object.assign({ etag }, v);
  v = await diskGet(key);
  if (v) { stats.diskHits++; lru.set(key, v); return Object.assign({ etag, added: false }, v); }
  const [r] = await readPages(file, st.mtimeMs, [1]).catch(e => { throw e.code === 'ENOENT' ? err(404, 'fileMissing') : e; });
  if (!r || r.error) throw err(404, 'noCover');
  stats.read++;
  v = { buf: r.buf, type: r.type };
  lru.set(key, v);
  await diskSet(key, v).catch(e => console.error('[covers] could not save a cover:', e.message));
  return Object.assign({ etag, added: true }, v);
}

const handlers = {
  bookCover: args => bookCover(args),
  // A cover image file (downloaded/custom): { file, version } → { buf, type } | null
  async imageFile({ file, version }) {
    stats.requests++;
    const key = `f:${file}:${version}`;
    let v = lru.get(key);
    if (v) return v;
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st || st.size > 16 * 1024 * 1024) return null;
    const buf = await fs.promises.readFile(file).catch(() => null);
    if (!buf) return null;
    v = { buf, type: TYPE[path.extname(file).toLowerCase().replace('.jpeg', '.jpg')] || 'application/octet-stream' };
    lru.set(key, v);
    return v;
  },
  // Covers of these works read ahead in the background: { items: [{ bookId, file }] } (answers at once)
  warm({ items }) {
    if (warm.running) { warm.next = items; return { queued: true }; }
    (async function run(list) {
      Object.assign(warm, { running: true, total: list.length, done: 0, added: 0, startedAt: new Date().toISOString(), finishedAt: null, next: null });
      for (const it of list) {
        try { const r = await bookCover(it, { warming: true }); if (r.added) warm.added++; } catch { /* unreadable: a placeholder is shown */ }
        warm.done++;
        await new Promise(r => setImmediate(r)); // requests go first
      }
      warm.running = false; warm.finishedAt = new Date().toISOString();
      if (warm.added) console.log(`[covers] ${warm.added} work cover(s) cached ahead (${warm.total} works)`);
      if (warm.next) { const n = warm.next; warm.next = null; run(n); }
    })(items || []);
    return { started: true };
  },
  clear() { lru.clear(); return true; }
};
const info = () => Object.assign({ warm: { running: warm.running, total: warm.total, done: warm.done, added: warm.added, finishedAt: warm.finishedAt } }, lru.info(), stats);
module.exports = { handlers, info, THUMB_DIR };
