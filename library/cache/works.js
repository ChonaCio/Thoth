// Works cache (its own process): ready answers (JSON text) for work lists, filters, work pages and Home, keyed
// by the user and the request. An answer is only given back for the data version it was built for (the server
// sends the current one with each lookup), so a change anywhere makes old answers miss. LRU by size
// (THOTH_RESPONSE_CACHE_MB, default 32).
const { createLru } = require('./lru');

const lru = createLru({ maxBytes: Math.max(4, Number(process.env.THOTH_RESPONSE_CACHE_MB) || 32) * 1024 * 1024, sizeOf: v => v.body.length });
const stats = { lookups: 0, answered: 0, stale: 0 };
const handlers = {
  get({ key, ver }) {
    stats.lookups++;
    const v = lru.get(key);
    if (!v) return null;
    if (v.ver !== ver) { lru.delete(key); stats.stale++; return null; }
    stats.answered++;
    return v.body;
  },
  put({ key, ver, body }) { lru.set(key, { ver, body }); return true; },
  clear() { lru.clear(); return true; }
};
const info = () => Object.assign({}, lru.info(), stats, { hits: stats.answered, misses: stats.lookups - stats.answered });
module.exports = { handlers, info };
