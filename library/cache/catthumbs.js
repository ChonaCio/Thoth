// Catalog thumbnails cache (its own process): the covers of the external catalog's works and the sources' icons,
// fetched from the sites once and then served from memory (LRU) and disk (data/cache/catalog-covers/), so grids
// of thousands of works never wait on the sites twice, even after a restart.
//   - only public addresses (redirects checked again), images only, at most 5 MB each, Thoth's generic user agent
//   - a few requests per site at once; an image that failed isn't asked for again for 30 minutes
//   - disk bounded (cfg.diskMb): past it, the oldest go first
//   - read ahead (warm): after a crawl the server sends the covers of the source's works; the missing ones are
//     fetched one at a time per site, cfg.perMin a minute at most (0: never ahead)
// cfg (sent with the calls): { memMb, diskMb, perMin }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLru } = require('./lru');
const { publicUrl, refererFor, UA } = require('../catalog/fetcher');

const DATA_DIR = path.resolve(process.env.THOTH_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
const DIR = path.join(DATA_DIR, 'cache', 'catalog-covers');
const ALLOW_LOCAL = process.env.THOTH_CATALOG_ALLOW_LOCAL === '1'; // tests only
const MAX_IMAGE = 5 * 1024 * 1024;
const FAIL_MS = 30 * 60 * 1000;
const PER_HOST = 4;
const err = (status, code) => Object.assign(new Error(code), { status, code });
const nameOf = url => crypto.createHash('sha1').update(url).digest('hex');
const etagOf = name => `"cc-${name.slice(0, 16)}"`;

let cfg = { memMb: 48, diskMb: 2048, perMin: 30 };
let lru = createLru({ maxBytes: cfg.memMb * 1024 * 1024 });
function configure(c) {
  if (!c || typeof c !== 'object') return;
  const next = Object.assign({}, cfg);
  for (const k of ['memMb', 'diskMb', 'perMin']) if (Number.isFinite(Number(c[k]))) next[k] = Number(c[k]);
  if (next.memMb !== cfg.memMb) lru = createLru({ maxBytes: Math.max(4, next.memMb) * 1024 * 1024 }); // (a new size: emptied)
  const smaller = next.diskMb < cfg.diskMb;
  cfg = next;
  if (smaller) prune().catch(() => {});
}

const stats = { requests: 0, memoryHits: 0, diskHits: 0, fetched: 0, failed: 0, skippedFailed: 0 };
const failedUntil = new Map(); // url → time it may be tried again
const inflight = new Map();    // name → promise
let epoch = 0;                 // bumped by clear: downloads started before it aren't kept
const hosts = new Map();       // host → { active, waiting: [] }

/* ---------- disk ---------- */
let disk = null; // { files, bytes } (counted once, then kept up to date)
async function diskCount() {
  if (disk) return disk;
  const names = await fs.promises.readdir(DIR).catch(() => []);
  let files = 0, bytes = 0;
  for (const n of names) {
    if (n.endsWith('.type')) continue;
    const st = await fs.promises.stat(path.join(DIR, n)).catch(() => null);
    if (st) { files++; bytes += st.size; }
  }
  disk = disk || { files, bytes };
  return disk;
}
async function diskGet(name) {
  const buf = await fs.promises.readFile(path.join(DIR, name)).catch(() => null);
  if (!buf) return null;
  const type = await fs.promises.readFile(path.join(DIR, name + '.type'), 'utf8').catch(() => 'image/jpeg');
  return { buf, type: type.trim() || 'image/jpeg' };
}
async function diskSet(name, v) {
  await fs.promises.mkdir(DIR, { recursive: true });
  const had = await fs.promises.stat(path.join(DIR, name)).catch(() => null);
  await fs.promises.writeFile(path.join(DIR, name), v.buf);
  await fs.promises.writeFile(path.join(DIR, name + '.type'), v.type);
  const d = await diskCount();
  if (had) d.bytes -= had.size; else d.files++;
  d.bytes += v.buf.length;
  if (d.bytes > cfg.diskMb * 1024 * 1024) prune().catch(() => {});
}
let pruning = null;
function prune() {
  if (pruning) return pruning;
  pruning = (async () => {
    const limit = cfg.diskMb * 1024 * 1024;
    const names = (await fs.promises.readdir(DIR).catch(() => [])).filter(n => !n.endsWith('.type'));
    const list = [];
    for (const n of names) { const st = await fs.promises.stat(path.join(DIR, n)).catch(() => null); if (st) list.push({ n, t: st.mtimeMs, size: st.size }); }
    let bytes = list.reduce((a, x) => a + x.size, 0);
    disk = { files: list.length, bytes };
    if (bytes <= limit) return;
    list.sort((a, b) => a.t - b.t);
    for (const x of list) {
      if (bytes <= limit * 0.9) break; // (down to 90%: not again at the next image)
      await fs.promises.rm(path.join(DIR, x.n), { force: true });
      await fs.promises.rm(path.join(DIR, x.n + '.type'), { force: true });
      bytes -= x.size; disk.files--; disk.bytes -= x.size; stats.pruned = (stats.pruned || 0) + 1;
    }
  })().finally(() => { pruning = null; });
  return pruning;
}

/* ---------- fetching from the site ---------- */
async function slot(host) {
  const h = hosts.get(host) || hosts.set(host, { active: 0, waiting: [] }).get(host);
  if (h.active >= PER_HOST) await new Promise(r => h.waiting.push(r));
  h.active++;
  return () => { h.active--; const next = h.waiting.shift(); if (next) next(); else if (!h.active) hosts.delete(host); };
}
// (the Referer: what a browser sends for an image shown on the work's page — refererFor in catalog/fetcher.js)
// What an image's first bytes say it is (some image servers send "application/octet-stream" or no type at all)
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp' && /^(avif|avis)$/.test(buf.slice(8, 12).toString('latin1'))) return 'image/avif';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  return null;
}
async function download(url, referer) {
  let u = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!publicUrl(u, ALLOW_LOCAL)) throw err(404, 'noCover');
    const release = await slot(new URL(u).host);
    let res;
    try {
      const headers = { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' };
      const ref = refererFor(referer, u);
      if (ref) headers.Referer = ref;
      res = await fetch(u, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u).href; continue; }
      let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      // (a page, an error or a bot check instead of the image: not kept)
      if (!res.ok || /^(text\/|application\/(json|xml|xhtml))/.test(type)) throw err(404, 'noCover');
      if (Number(res.headers.get('content-length')) > MAX_IMAGE) throw err(404, 'noCover');
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_IMAGE) throw err(404, 'noCover');
      // An image sent with another type (octet-stream, none) is taken by what its bytes are
      if (!/^image\//.test(type)) type = sniff(buf) || (/\.ico(\?|$)/i.test(u) ? 'image/x-icon' : '');
      if (!type) throw err(404, 'noCover'); // (an SVG is served sandboxed, its scripts never run: see sendImage)
      return { buf, type };
    } finally { release(); }
  }
  throw err(404, 'noCover');
}
// → { buf, type, etag, fetched } ; fromWarm: not counted as a request
async function image({ url, referer }, { warming = false } = {}) {
  if (!warming) stats.requests++;
  url = String(url || '');
  if (!publicUrl(url, ALLOW_LOCAL)) throw err(404, 'noCover');
  const name = nameOf(url), etag = etagOf(name);
  const m = lru.get(name);
  if (m) { if (!warming) stats.memoryHits++; return Object.assign({ etag, fetched: false }, m); }
  const d = await diskGet(name);
  if (d) { if (!warming) stats.diskHits++; lru.set(name, d); return Object.assign({ etag, fetched: false }, d); }
  const until = failedUntil.get(url);
  if (until && until > Date.now()) { stats.skippedFailed++; throw err(404, 'noCover'); }
  if (inflight.has(name)) return inflight.get(name);
  const started = epoch;
  const job = download(url, referer).then(async v => {
    stats.fetched++;
    failedUntil.delete(url);
    if (started !== epoch) return Object.assign({ etag, fetched: true }, v); // (emptied meanwhile: not kept)
    lru.set(name, v);
    await diskSet(name, v).catch(e => console.error('[catalog thumbnails] could not save an image:', e.message));
    return Object.assign({ etag, fetched: true }, v);
  }, e => {
    stats.failed++;
    if (failedUntil.size > 20000) failedUntil.clear();
    failedUntil.set(url, Date.now() + FAIL_MS);
    throw e.code === 'noCover' ? e : err(404, 'noCover');
  }).finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
}

/* ---------- reading ahead ---------- */
// Waiting covers per site (round-robin between sites; one at a time each, cfg.perMin a minute at most)
const warm = { queue: new Map(), seen: new Set(), running: false, total: 0, done: 0, added: 0, failed: 0, startedAt: null, finishedAt: null, waiters: [] };
function warmAdd(items) {
  let n = 0;
  if (!warm.running && !warm.queue.size) Object.assign(warm, { total: 0, done: 0, added: 0, failed: 0 }); // (a new round)
  for (const it of items || []) {
    const url = it && String(it.url || '');
    if (!url || warm.seen.has(url) || !publicUrl(url, ALLOW_LOCAL)) continue;
    let host; try { host = new URL(url).host; } catch { continue; }
    warm.seen.add(url);
    if (!warm.queue.has(host)) warm.queue.set(host, []);
    warm.queue.get(host).push({ url, referer: it.referer || '' });
    n++;
  }
  warm.total += n;
  return n;
}
async function warmRun() {
  if (warm.running) return;
  Object.assign(warm, { running: true, startedAt: new Date().toISOString(), finishedAt: null });
  const nextAt = new Map(); // host → time its next download may start
  try {
    while (warm.queue.size && cfg.perMin > 0) {
      const gap = 60000 / cfg.perMin;
      // The site whose turn comes first
      let host = null, at = Infinity;
      for (const h of warm.queue.keys()) { const t = nextAt.get(h) || 0; if (t < at) { at = t; host = h; } }
      const wait = at - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 5000)));
      if (wait > 5000) continue;
      const list = warm.queue.get(host);
      const it = list.shift();
      if (!list.length) warm.queue.delete(host);
      try {
        const r = await image(it, { warming: true });
        if (r.fetched) { warm.added++; nextAt.set(host, Date.now() + gap); }
      } catch { warm.failed++; nextAt.set(host, Date.now() + gap); }
      warm.done++;
      await new Promise(r => setImmediate(r)); // (requests for pages being looked at go first)
    }
  } finally {
    const left = warm.queue.size;
    warm.running = false; warm.finishedAt = new Date().toISOString();
    if (!left) { warm.seen.clear(); if (warm.added) console.log(`[catalog thumbnails] ${warm.added} cover(s) fetched ahead (${warm.total} looked at)`); }
    for (const w of warm.waiters.splice(0)) w();
  }
}

const handlers = {
  image: args => { configure(args.cfg); return image(args); },
  // Covers to fetch ahead: { items: [{ url, referer }], cfg } → answers when the queue is empty (so the process
  // stays open while it works), or at once with { off: true } when reading ahead is off
  async warm({ items, cfg: c }) {
    configure(c);
    if (!(cfg.perMin > 0)) return { off: true };
    const added = warmAdd(items);
    if (!warm.running) warmRun();
    if (warm.running) await new Promise(r => warm.waiters.push(r));
    return { added };
  },
  stopWarm() { warm.queue.clear(); warm.seen.clear(); return true; },
  configure({ cfg: c }) { configure(c); return true; },
  // Emptied: memory (and the disk with { disk: true }); failures forgotten
  async clear({ disk: all } = {}) {
    epoch++;
    lru = createLru({ maxBytes: Math.max(4, cfg.memMb) * 1024 * 1024 });
    failedUntil.clear();
    if (all) { warm.queue.clear(); warm.seen.clear(); await fs.promises.rm(DIR, { recursive: true, force: true }); disk = { files: 0, bytes: 0 }; }
    return true;
  }
};
diskCount().catch(() => {});
const info = () => Object.assign({}, lru.info(), stats, {
  disk: disk ? { files: disk.files, bytes: disk.bytes, maxBytes: cfg.diskMb * 1024 * 1024 } : null,
  failedNow: [...failedUntil.values()].filter(t => t > Date.now()).length,
  warm: { running: warm.running, total: warm.total, done: warm.done, added: warm.added, failed: warm.failed, waiting: [...warm.queue.values()].reduce((a, l) => a + l.length, 0), perMin: cfg.perMin, finishedAt: warm.finishedAt }
});
module.exports = { handlers, info, DIR };
