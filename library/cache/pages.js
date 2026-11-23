// Pages cache (its own process): chapter pages read from the archives, kept in memory (THOTH_MEDIA_CACHE_MB,
// default 128); reading a page also reads the next PREFETCH pages, so turning pages is answered from memory.
// Keys include the file's modification time: a changed file gets new keys (old entries age out).
const fs = require('fs');
const { pages: readPages } = require('../media-worker');
const { createLru } = require('./lru');

const lru = createLru({ maxBytes: Math.max(8, Number(process.env.THOTH_MEDIA_CACHE_MB) || 128) * 1024 * 1024 });
const PREFETCH = 3;
const stats = { requests: 0, read: 0, prefetched: 0 };
const inflight = new Map();
const err = (status, code) => Object.assign(new Error(code), { status, code });
const keyOf = (bookId, mtimeMs, n) => `p:${bookId}:${Math.round(mtimeMs)}:${n}`;

async function load(bookId, file, mtimeMs, n, prefetch, pageCount) {
  const key = keyOf(bookId, mtimeMs, n);
  if (inflight.has(key)) return inflight.get(key);
  const wanted = [n];
  for (let i = 1; i <= prefetch && n + i <= (pageCount || Infinity); i++) if (!lru.has(keyOf(bookId, mtimeMs, n + i))) wanted.push(n + i);
  const job = readPages(file, mtimeMs, wanted).then(result => {
    let mine = null;
    for (const r of result) {
      if (r.error) { if (r.n === n) throw err(404, r.error === 'pageNotFound' ? 'pageNotFound' : 'pageUnreadable'); continue; }
      const v = { buf: r.buf, type: r.type };
      lru.set(keyOf(bookId, mtimeMs, r.n), v);
      stats.read++;
      if (r.n === n) mine = v; else stats.prefetched++;
    }
    if (!mine) throw err(404, 'pageNotFound');
    return mine;
  }, e => { throw e.code === 'ENOENT' ? err(404, 'fileMissing') : e; });
  inflight.set(key, job);
  job.then(() => inflight.delete(key), () => inflight.delete(key));
  return job;
}

const handlers = {
  // { bookId, file, n, pageCount } → { buf, type, etag }
  async page({ bookId, file, n, pageCount, prefetch = PREFETCH }) {
    stats.requests++;
    const st = await fs.promises.stat(file).catch(() => { throw err(404, 'fileMissing'); });
    const etag = `"${bookId}-${Math.round(st.mtimeMs)}-${n}"`;
    const hit = lru.get(keyOf(bookId, st.mtimeMs, n));
    if (hit) {
      // Keep reading ahead while the reader turns pages
      const next = [];
      for (let i = 1; i <= prefetch && n + i <= (pageCount || Infinity); i++) if (!lru.has(keyOf(bookId, st.mtimeMs, n + i))) next.push(n + i);
      if (next.length) load(bookId, file, st.mtimeMs, next[0], next.length - 1, pageCount).catch(() => {});
      return Object.assign({ etag }, hit);
    }
    return Object.assign({ etag }, await load(bookId, file, st.mtimeMs, n, prefetch, pageCount));
  },
  clear() { lru.clear(); return true; }
};
const info = () => Object.assign({ prefetch: PREFETCH }, lru.info(), stats);
module.exports = { handlers, info };
