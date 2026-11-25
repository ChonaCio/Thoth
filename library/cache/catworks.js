// Catalog works cache (its own process): ready answers (JSON text) for the external catalog's lists, filters and
// work pages, keyed by the request. An answer only counts for the catalog data version it was built for (the
// server sends the current one with each lookup: the sources' crawled files, merges, settings, the library), so a
// crawl flushing new works or any change makes old answers miss. LRU by size (cfg.memMb, Server settings).
// Saved to disk and taken back when the process starts again, like the Works cache (only while the library and
// the crawled files are the same as when it was saved).
const { createLru } = require('./lru');
const persist = require('./persist');

let maxMb = 32;
let lru = createLru({ maxBytes: maxMb * 1024 * 1024, sizeOf: v => v.body.length });
const stats = { lookups: 0, answered: 0, stale: 0, stored: 0 };
const snap = { savedAt: null, saved: 0, bytes: 0, restored: 0, restoredAt: null, skipped: null };
function size(mb) {
  const n = Number(mb);
  if (!Number.isFinite(n) || n === maxMb || n < 4) return;
  maxMb = n;
  lru = createLru({ maxBytes: maxMb * 1024 * 1024, sizeOf: v => v.body.length });
}
const handlers = {
  get({ key, ver, memMb }) {
    size(memMb);
    stats.lookups++;
    const v = lru.get(key);
    if (!v) return null;
    if (v.ver !== ver) { lru.delete(key); stats.stale++; return null; }
    stats.answered++;
    return v.body;
  },
  put({ key, ver, body, memMb }) { size(memMb); lru.set(key, { ver, body }); stats.stored++; return true; },
  clear() { lru.clear(); return true; },
  async save({ sig, ver }) {
    const list = [];
    for (const [key, v] of lru.entries()) if (v.ver === ver) list.push({ key, data: v.body });
    const r = await persist.write('catworks', { sig }, list);
    if (r) Object.assign(snap, { savedAt: new Date().toISOString(), saved: r.entries, bytes: r.bytes });
    return r;
  },
  async restore({ sig, ver, memMb }) {
    size(memMb);
    const s = await persist.read('catworks');
    if (!s) return { restored: 0 };
    if (s.header.sig !== sig) { snap.skipped = 'the catalog changed since'; return { restored: 0, changed: true }; }
    for (const e of s.entries) if (!lru.has(e.key)) lru.set(e.key, { ver, body: e.data.toString('utf8') });
    Object.assign(snap, { restored: s.entries.length, restoredAt: new Date().toISOString(), skipped: null });
    return { restored: s.entries.length };
  }
};
const info = () => Object.assign({}, lru.info(), stats, { hits: stats.answered, misses: stats.lookups - stats.answered, snapshot: snap });
module.exports = { handlers, info };
