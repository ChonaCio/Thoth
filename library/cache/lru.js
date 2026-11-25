// A key-value cache bounded by size (bytes, or entries counted as 1 each): the least recently used go first.
function createLru({ maxBytes = 64 * 1024 * 1024, sizeOf = v => (v && v.buf ? v.buf.length : v && v.length) || 1 } = {}) {
  const map = new Map();
  let bytes = 0;
  const stats = { hits: 0, misses: 0, sets: 0, evicted: 0 };
  return {
    get(key) {
      const v = map.get(key);
      if (v === undefined) { stats.misses++; return undefined; }
      map.delete(key); map.set(key, v);
      stats.hits++;
      return v;
    },
    peek: key => map.get(key),
    has: key => map.has(key),
    set(key, v) {
      const size = sizeOf(v);
      if (size > maxBytes / 8) return false;
      if (map.has(key)) { bytes -= sizeOf(map.get(key)); map.delete(key); }
      map.set(key, v);
      bytes += size;
      stats.sets++;
      while (bytes > maxBytes && map.size) { const [k, o] = map.entries().next().value; map.delete(k); bytes -= sizeOf(o); stats.evicted++; }
      return true;
    },
    delete(key) { if (map.has(key)) { bytes -= sizeOf(map.get(key)); map.delete(key); } },
    clear() { map.clear(); bytes = 0; },
    // Every entry, least recently used first (saving a snapshot; loading them in this order keeps the order)
    entries: () => map.entries(),
    info: () => ({ entries: map.size, bytes, maxBytes, hits: stats.hits, misses: stats.misses, evicted: stats.evicted })
  };
}
module.exports = { createLru };
