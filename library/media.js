// Media service: page images and covers for the browser, answered from a key-value cache.
//   memory: an LRU of recent images (key → { buf, type }), THOTH_MEDIA_CACHE_MB (default 128)
//   disk:   covers/thumbnails in data/cache/thumbs/<key hash>.<ext>, so a grid of thousands of works doesn't
//           open thousands of archives again after a restart
// What isn't cached is read by the media process (media-worker.js): started when needed, closed when idle
// (THOTH_WORKER_IDLE_MS, like the scan processes). Reading a page also reads the next few pages of the
// chapter (PREFETCH), so turning pages is answered from memory. Keys include the file's modification time:
// a changed file gets new keys (old entries just age out).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const store = require('./db');
const worker = require('./media-worker');

const MAX_BYTES = Math.max(8, Number(process.env.THOTH_MEDIA_CACHE_MB) || 128) * 1024 * 1024;
const IDLE_MS = Math.max(0, Number(process.env.THOTH_WORKER_IDLE_MS) || 10000);
const PREFETCH = 3;
const THUMB_DIR = path.join(store.DATA_DIR, 'cache', 'thumbs');
const MAX_DISK_FILES = 100000;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/jxl': '.jxl' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));

const stats = { hits: 0, diskHits: 0, misses: 0, prefetched: 0, requests: 0 };

/* ---------------- memory: LRU by bytes ---------------- */
const lru = new Map();
let bytes = 0;
function get(key) {
  const v = lru.get(key);
  if (!v) return null;
  lru.delete(key); lru.set(key, v);
  return v;
}
function set(key, v) {
  if (!v || !v.buf || v.buf.length > MAX_BYTES / 8) return;
  const old = lru.get(key);
  if (old) { bytes -= old.buf.length; lru.delete(key); }
  lru.set(key, v);
  bytes += v.buf.length;
  while (bytes > MAX_BYTES && lru.size) { const [k, o] = lru.entries().next().value; lru.delete(k); bytes -= o.buf.length; }
}

/* ---------------- disk: thumbnails ---------------- */
const diskName = key => crypto.createHash('sha1').update(key).digest('hex');
let diskWrites = 0;
async function diskGet(key) {
  const base = path.join(THUMB_DIR, diskName(key));
  for (const ext of Object.values(EXT)) {
    const buf = await fs.promises.readFile(base + ext).catch(() => null);
    if (buf) return { buf, type: TYPE[ext] };
  }
  return null;
}
function diskSet(key, v) {
  const ext = EXT[v.type];
  if (!ext) return;
  fs.promises.mkdir(THUMB_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(path.join(THUMB_DIR, diskName(key) + ext), v.buf))
    .then(() => { if (++diskWrites % 1000 === 0) pruneDisk(); })
    .catch(e => console.error('[media] could not save a thumbnail:', e.message));
}
// Keep the folder bounded: past MAX_DISK_FILES, the oldest 10% go
async function pruneDisk() {
  const names = await fs.promises.readdir(THUMB_DIR).catch(() => []);
  if (names.length <= MAX_DISK_FILES) return;
  const withTime = await Promise.all(names.map(async n => ({ n, t: ((await fs.promises.stat(path.join(THUMB_DIR, n)).catch(() => null)) || { mtimeMs: 0 }).mtimeMs })));
  withTime.sort((a, b) => a.t - b.t);
  for (const x of withTime.slice(0, Math.ceil(names.length / 10))) await fs.promises.rm(path.join(THUMB_DIR, x.n), { force: true });
}

/* ---------------- the media process ---------------- */
const proc = { child: null, pid: null, pending: new Map(), seq: 0, startedAt: null, idleTimer: null, mode: process.env.THOTH_SCAN_IN_PROCESS === '1' ? 'inline' : 'process', restarts: 0, lastError: null };
process.on('exit', () => { if (proc.child) try { proc.child.kill(); } catch { /* gone */ } });
function ensureProcess() {
  clearTimeout(proc.idleTimer); proc.idleTimer = null;
  if (proc.mode !== 'process' || proc.child) return;
  try {
    const child = fork(path.join(__dirname, 'media-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here */ }
    proc.child = child; proc.pid = child.pid; proc.startedAt = new Date().toISOString();
    child.on('message', m => {
      const p = m && proc.pending.get(m.reqId);
      if (!p) return;
      proc.pending.delete(m.reqId);
      if (m.type === 'result') p.resolve(m.result); else p.reject(Object.assign(new Error(m.message), { code: m.code }));
      if (!proc.pending.size) scheduleIdle();
    });
    const gone = err => {
      if (proc.child !== child) return;
      proc.child = null; proc.pid = null;
      for (const p of proc.pending.values()) p.reject(err);
      proc.pending.clear();
    };
    child.on('error', e => { proc.lastError = e.message; gone(e); });
    child.on('exit', code => { if (code) proc.lastError = `Media process stopped unexpectedly (exit code ${code})`; gone(new Error(proc.lastError || 'Media process stopped')); });
  } catch (e) {
    console.warn(`[media] couldn't start the media process (${e.message}); reading pages inside the server`);
    proc.mode = 'inline';
    proc.lastError = e.message;
  }
}
function scheduleIdle() {
  clearTimeout(proc.idleTimer);
  proc.idleTimer = setTimeout(() => {
    if (proc.pending.size || !proc.child) return;
    const child = proc.child;
    proc.child = null; proc.pid = null;
    child.removeAllListeners('exit');
    try { child.kill(); } catch { /* gone */ }
  }, IDLE_MS);
  proc.idleTimer.unref();
}
function readPages(file, mtimeMs, pages) {
  ensureProcess();
  if (proc.mode === 'inline' || !proc.child) return worker.pages(file, mtimeMs, pages);
  return new Promise((resolve, reject) => {
    const reqId = ++proc.seq;
    proc.pending.set(reqId, { resolve, reject });
    proc.child.send({ type: 'pages', reqId, file, mtimeMs, pages });
  });
}
// The same page asked twice at once (a grid scrolling, two readers) is read once
const inflight = new Map();

/* ---------------- what the API uses ---------------- */
const httpError = (status, code) => Object.assign(new Error(code), { status, code });
async function fileStat(file) {
  return fs.promises.stat(file).catch(() => { throw httpError(404, 'fileMissing'); });
}
const pageKey = (bookId, mtimeMs, n) => `p:${bookId}:${Math.round(mtimeMs)}:${n}`;

// Page n of a CBZ book: { buf, type, etag }. prefetch: also read the next pages of the chapter into memory.
async function page(book, file, n, { prefetch = PREFETCH, pageCount } = {}) {
  stats.requests++;
  const st = await fileStat(file);
  const key = pageKey(book.id, st.mtimeMs, n);
  const etag = `"${book.id}-${Math.round(st.mtimeMs)}-${n}"`;
  const hit = get(key);
  if (hit) {
    stats.hits++;
    // Keep reading ahead while the reader turns pages
    if (prefetch) readAhead(book, file, st.mtimeMs, n, prefetch, pageCount);
    return Object.assign({ etag }, hit);
  }
  stats.misses++;
  const v = await load(book, file, st.mtimeMs, n, prefetch, pageCount);
  return Object.assign({ etag }, v);
}
async function load(book, file, mtimeMs, n, prefetch, pageCount) {
  const key = pageKey(book.id, mtimeMs, n);
  if (inflight.has(key)) return inflight.get(key);
  const max = pageCount || Infinity;
  const wanted = [n];
  for (let i = 1; i <= prefetch && n + i <= max; i++) if (!lru.has(pageKey(book.id, mtimeMs, n + i))) wanted.push(n + i);
  const job = readPages(file, mtimeMs, wanted).then(result => {
    let mine = null;
    for (const r of result) {
      if (r.error) { if (r.n === n) throw httpError(404, r.error === 'pageNotFound' ? 'pageNotFound' : 'pageUnreadable'); continue; }
      const buf = Buffer.isBuffer(r.buf) ? r.buf : Buffer.from(r.buf.buffer, r.buf.byteOffset, r.buf.byteLength); // (a Uint8Array after IPC)
      const v = { buf, type: r.type };
      set(pageKey(book.id, mtimeMs, r.n), v);
      if (r.n === n) mine = v; else stats.prefetched++;
    }
    if (!mine) throw httpError(404, 'pageNotFound');
    return mine;
  }, e => { throw e.code === 'ENOENT' ? httpError(404, 'fileMissing') : e; });
  inflight.set(key, job);
  job.then(() => inflight.delete(key), () => inflight.delete(key));
  return job;
}
function readAhead(book, file, mtimeMs, n, prefetch, pageCount) {
  const max = pageCount || Infinity;
  const next = [];
  for (let i = 1; i <= prefetch && n + i <= max; i++) if (!lru.has(pageKey(book.id, mtimeMs, n + i))) next.push(n + i);
  if (!next.length) return;
  load(book, file, mtimeMs, next[0], next.length - 1, pageCount).catch(() => {});
}

// A book's cover (its first page), also kept on disk: { buf, type, etag }
async function bookCover(book, file) {
  stats.requests++;
  const st = await fileStat(file);
  const key = `t:${book.id}:${Math.round(st.mtimeMs)}`;
  const etag = `"${book.id}-${Math.round(st.mtimeMs)}-1"`;
  let v = get(key);
  if (v) { stats.hits++; return Object.assign({ etag }, v); }
  v = await diskGet(key);
  if (v) { stats.diskHits++; set(key, v); return Object.assign({ etag }, v); }
  stats.misses++;
  v = await load(book, file, st.mtimeMs, 1, 0);
  set(key, v);
  diskSet(key, v);
  return Object.assign({ etag }, v);
}
// An image file (downloaded/custom cover), by path and version: { buf, type, etag }
async function imageFile(file, version, etag) {
  stats.requests++;
  const key = `f:${file}:${version}`;
  let v = get(key);
  if (v) { stats.hits++; return Object.assign({ etag }, v); }
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || st.size > 16 * 1024 * 1024) return null;
  const buf = await fs.promises.readFile(file).catch(() => null);
  if (!buf) return null;
  stats.misses++;
  v = { buf, type: TYPE[path.extname(file).toLowerCase().replace('.jpeg', '.jpg')] || 'application/octet-stream' };
  set(key, v);
  return Object.assign({ etag }, v);
}

// What the Processes page shows
function info() {
  return {
    mode: proc.mode, pid: proc.pid, startedAt: proc.child ? proc.startedAt : null, busy: proc.pending.size, lastError: proc.lastError,
    idleCloseMs: IDLE_MS, prefetch: PREFETCH,
    cache: { entries: lru.size, bytes, maxBytes: MAX_BYTES },
    stats: Object.assign({}, stats)
  };
}
// Drop what's cached for a book or everything (tests, changed covers)
function clear() { lru.clear(); bytes = 0; }

module.exports = { page, bookCover, imageFile, info, clear, THUMB_DIR };
