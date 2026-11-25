// Works cache (its own process): ready answers (JSON text) for work lists, filters, work pages and Home, keyed
// by the user and the request. An answer is only given back for the data version it was built for (the server
// sends the current one with each lookup), so a change anywhere makes old answers miss. LRU by size
// (THOTH_RESPONSE_CACHE_MB, default 32).
// Saved to disk (save) and taken back when the process starts again (restore): the answers still good when saved,
// kept with a fingerprint of the data files; restored for the current version only if the data is the same.
const { createLru } = require('./lru');
const persist = require('./persist');

const lru = createLru({ maxBytes: Math.max(4, Number(process.env.THOTH_RESPONSE_CACHE_MB) || 32) * 1024 * 1024, sizeOf: v => v.body.length });
const stats = { lookups: 0, answered: 0, stale: 0 };
const snap = { savedAt: null, saved: 0, bytes: 0, restored: 0, restoredAt: null, skipped: null };
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
  clear() { lru.clear(); return true; },
  // { sig, ver }: the answers good for this version, with the data's fingerprint
  async save({ sig, ver }) {
    const list = [];
    for (const [key, v] of lru.entries()) if (v.ver === ver) list.push({ key, data: v.body });
    const r = await persist.write('works', { sig }, list);
    if (r) Object.assign(snap, { savedAt: new Date().toISOString(), saved: r.entries, bytes: r.bytes });
    return r;
  },
  // { sig, ver }: the saved answers, good for this version when the data is still what they were built from
  async restore({ sig, ver }) {
    const s = await persist.read('works');
    if (!s) return { restored: 0 };
    if (s.header.sig !== sig) { snap.skipped = 'the library changed since'; return { restored: 0, changed: true }; }
    for (const e of s.entries) if (!lru.has(e.key)) lru.set(e.key, { ver, body: e.data.toString('utf8') });
    Object.assign(snap, { restored: s.entries.length, restoredAt: new Date().toISOString(), skipped: null });
    return { restored: s.entries.length };
  }
};
const info = () => Object.assign({}, lru.info(), stats, { hits: stats.answered, misses: stats.lookups - stats.answered, snapshot: snap });
module.exports = { handlers, info };
