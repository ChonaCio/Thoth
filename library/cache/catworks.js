// Catalog works cache (its own process): ready answers (JSON text) for the external catalog's lists, filters and
// work pages, keyed by the request. An answer only counts for the catalog data version it was built for (the
// server sends the current one with each lookup: the sources' crawled files, merges, settings, the library), so a
// crawl flushing new works or any change makes old answers miss. LRU by size (cfg.memMb, Server settings).
const { createLru } = require('./lru');

let maxMb = 32;
let lru = createLru({ maxBytes: maxMb * 1024 * 1024, sizeOf: v => v.body.length });
const stats = { lookups: 0, answered: 0, stale: 0, stored: 0 };
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
  clear() { lru.clear(); return true; }
};
const info = () => Object.assign({}, lru.info(), stats, { hits: stats.answered, misses: stats.lookups - stats.answered });
module.exports = { handlers, info };
