// Search cache (its own process): indexes for searching, with recent answers kept. Two of them (ns):
//   library — the library's works: titles (every version's other titles), genres ("categories"), tags, people
//             (writers, artists…) and types; each answer only counts works in the libraries the asker may see (libs)
//   catalog — the external catalog's works: every title of every site and version, and authors
// The server sends a snapshot of the works (load) when the data changed (its generation, gen).
//   load({ ns, gen, docs: [{ id, libs, title, sort, text, genres, tags, people, type, status }] })
//   query({ ns, q, libs, limit }) → [id]                  (title first, then other matches)
//   terms({ field, q, libs, limit }) → [{ name, count }]  (library; field: genre | tag | person | type)
// Both are saved to disk (save/restore) with the fingerprint of the data they were built from.
const { createLru } = require('./lru');
const persist = require('./persist');

const FIELDS = { genre: 'genres', tag: 'tags', person: 'people', type: 'type' };
const searchable = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Punctuation ignored ("solo leveling ragnarok" finds "Solo Leveling: Ragnarok"); one title per line kept
const loose = s => String(s || '').replace(/[^\p{L}\p{N}\n]+/gu, ' ').replace(/ ?\n ?/g, '\n').trim();
const empty = () => ({ gen: null, docs: [], terms: {}, loadedAt: null });
const states = { library: empty(), catalog: empty() };
const nsOf = ns => (ns === 'catalog' ? 'catalog' : 'library');
const answers = createLru({ maxBytes: 5000, sizeOf: () => 1 }); // recent answers (count, not bytes)
const stats = { queries: 0, termLookups: 0, answered: 0, loads: 0, catalogQueries: 0 };

function load({ ns, gen, docs }) {
  ns = nsOf(ns);
  const terms = {};
  if (ns === 'library') for (const [field, prop] of Object.entries(FIELDS)) {
    const m = new Map(); // key → { name, docs: [index] }
    docs.forEach((d, i) => {
      for (const name of [].concat(d[prop] || [])) {
        const k = searchable(name);
        if (!k) continue;
        if (!m.has(k)) m.set(k, { name, key: k, docs: [] });
        const e = m.get(k);
        if (e.docs[e.docs.length - 1] !== i) e.docs.push(i);
      }
    });
    terms[field] = [...m.values()];
  }
  for (const d of docs) { d._t = searchable(d.text || d.title); d._title = searchable(d.title); d._l = loose(d._t); }
  states[ns] = { gen, docs, terms, loadedAt: new Date().toISOString() };
  answers.clear();
  stats.loads++;
  return { gen, docs: docs.length };
}
const allowed = libs => (Array.isArray(libs) ? new Set(libs) : null);
const visible = (d, set) => !set || !d.libs || d.libs.some(l => set.has(l));
function cached(key, build) {
  const hit = answers.get(key);
  if (hit !== undefined) { stats.answered++; return hit; }
  const v = build();
  answers.set(key, v);
  return v;
}
const snaps = { library: { savedAt: null, saved: 0, bytes: 0, restored: 0, restoredAt: null, skipped: null }, catalog: { savedAt: null, saved: 0, bytes: 0, restored: 0, restoredAt: null, skipped: null } };
const FILE = { library: 'search', catalog: 'searchcatalog' };
const handlers = {
  load,
  status: ({ ns } = {}) => { const s = states[nsOf(ns)]; return { gen: s.gen, docs: s.docs.length }; },
  query({ ns, q, libs, limit = 30 }) {
    ns = nsOf(ns);
    stats.queries++; if (ns === 'catalog') stats.catalogQueries++;
    const term = searchable(q).trim();
    if (!term) return [];
    const state = states[ns];
    return cached(`${ns}\0q\0${term}\0${(libs || ['*']).join(',')}\0${limit}`, () => {
      const set = allowed(libs);
      const hits = [];
      const lt = loose(term);
      for (const d of state.docs) {
        if (!visible(d, set) || !(d._t.includes(term) || (lt && (d._l || '').includes(lt)))) continue;
        hits.push({ d, rank: d._title.startsWith(term) ? 0 : d._title.includes(term) ? 1 : 2 });
      }
      hits.sort((a, b) => a.rank - b.rank || String(a.d.sort).localeCompare(String(b.d.sort), undefined, { numeric: true, sensitivity: 'base' }));
      return hits.slice(0, limit).map(h => h.d.id);
    });
  },
  terms({ field, q = '', libs, limit = 50 }) {
    stats.termLookups++;
    const state = states.library;
    const list = state.terms[field];
    if (!list) throw Object.assign(new Error('Unknown field'), { status: 400, code: 'invalid' });
    const term = searchable(q).trim();
    return cached(`library\0t\0${field}\0${term}\0${(libs || ['*']).join(',')}\0${limit}`, () => {
      const set = allowed(libs);
      const out = [];
      for (const e of list) {
        if (term && !e.key.includes(term)) continue;
        const count = set ? e.docs.reduce((n, i) => n + (visible(state.docs[i], set) ? 1 : 0), 0) : e.docs.length;
        if (count) out.push({ name: e.name, count, starts: term ? e.key.startsWith(term) : false });
      }
      // Names starting with what was typed first, then the most used
      out.sort((a, b) => (b.starts - a.starts) || b.count - a.count || a.name.localeCompare(b.name));
      return out.slice(0, limit).map(({ name, count }) => ({ name, count }));
    });
  },
  clear() { answers.clear(); return true; },
  // Each index's works saved with the data's fingerprint; taken back (as the current generation) when the data is
  // the same, so searching after a restart doesn't wait for the index to be sent and built again.
  // { sig, gen, catSig, catGen }: an index older than its data isn't saved
  async save({ sig, gen, catSig, catGen }) {
    let last = null;
    for (const [ns, s, g] of [['library', sig, gen], ['catalog', catSig, catGen]]) {
      const state = states[ns];
      if (s == null || state.gen == null || state.gen !== g) continue;
      const docs = state.docs.map(d => { const o = Object.assign({}, d); delete o._t; delete o._title; delete o._l; return o; });
      const r = await persist.write(FILE[ns], { sig: s }, [{ key: 'docs', data: JSON.stringify(docs) }]);
      if (r) { Object.assign(snaps[ns], { savedAt: new Date().toISOString(), saved: docs.length, bytes: r.bytes }); last = r; }
    }
    return last;
  },
  async restore({ sig, gen, catSig, catGen }) {
    let restored = 0;
    for (const [ns, s, g] of [['library', sig, gen], ['catalog', catSig, catGen]]) {
      if (s == null) continue;
      const file = await persist.read(FILE[ns]);
      if (!file || !file.entries.length) continue;
      if (file.header.sig !== s) { snaps[ns].skipped = ns === 'catalog' ? 'the catalog changed since' : 'the library changed since'; continue; }
      if (states[ns].gen != null) continue; // (already loaded meanwhile)
      const docs = JSON.parse(file.entries[0].data.toString('utf8'));
      load({ ns, gen: g, docs });
      Object.assign(snaps[ns], { restored: docs.length, restoredAt: new Date().toISOString(), skipped: null });
      restored += docs.length;
    }
    return { restored };
  }
};
const info = () => {
  const lib = states.library, cat = states.catalog;
  // (snapshot: the library index's, with the catalog's counted in; catalog: its own index)
  const snapshot = Object.assign({}, snaps.library, { saved: snaps.library.saved + snaps.catalog.saved, bytes: snaps.library.bytes + snaps.catalog.bytes,
    restored: snaps.library.restored + snaps.catalog.restored, savedAt: [snaps.library.savedAt, snaps.catalog.savedAt].filter(Boolean).sort().pop() || null,
    skipped: snaps.library.skipped || snaps.catalog.skipped });
  return Object.assign({ snapshot, gen: lib.gen, docs: lib.docs.length, loadedAt: lib.loadedAt, catalog: { gen: cat.gen, docs: cat.docs.length, loadedAt: cat.loadedAt },
    terms: Object.fromEntries(Object.entries(lib.terms).map(([f, l]) => [f, l.length])) }, answers.info(), stats, { hits: stats.answered, misses: stats.queries + stats.termLookups - stats.answered });
};
module.exports = { handlers, info };
