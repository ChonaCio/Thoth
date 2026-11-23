// Search cache (its own process): an index of the works for searching titles and looking up genres
// ("categories"), tags, people (writers, artists…) and types, with recent answers kept. The server sends a
// snapshot of the works (load) when the data changed; each answer only counts works in the libraries the asker
// may see (libs).
//   load({ gen, docs: [{ id, libs, title, sort, text, genres, tags, people, type, status }] })
//   query({ q, libs, limit }) → [id]                  (title first, then other matches)
//   terms({ field, q, libs, limit }) → [{ name, count }] (field: genre | tag | person | type)
const { createLru } = require('./lru');

const FIELDS = { genre: 'genres', tag: 'tags', person: 'people', type: 'type' };
const searchable = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
let state = { gen: null, docs: [], terms: {}, loadedAt: null };
const answers = createLru({ maxBytes: 5000, sizeOf: () => 1 }); // recent answers (count, not bytes)
const stats = { queries: 0, termLookups: 0, answered: 0, loads: 0 };

function load({ gen, docs }) {
  const terms = {};
  for (const [field, prop] of Object.entries(FIELDS)) {
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
  for (const d of docs) { d._t = searchable(d.text || d.title); d._title = searchable(d.title); }
  state = { gen, docs, terms, loadedAt: new Date().toISOString() };
  answers.clear();
  stats.loads++;
  return { gen, docs: docs.length };
}
const allowed = libs => (Array.isArray(libs) ? new Set(libs) : null);
const visible = (d, set) => !set || d.libs.some(l => set.has(l));
function cached(key, build) {
  const hit = answers.get(key);
  if (hit !== undefined) { stats.answered++; return hit; }
  const v = build();
  answers.set(key, v);
  return v;
}
const handlers = {
  load,
  status: () => ({ gen: state.gen, docs: state.docs.length }),
  query({ q, libs, limit = 30 }) {
    stats.queries++;
    const term = searchable(q).trim();
    if (!term) return [];
    return cached(`q\0${term}\0${(libs || ['*']).join(',')}\0${limit}`, () => {
      const set = allowed(libs);
      const hits = [];
      for (const d of state.docs) {
        if (!visible(d, set) || !d._t.includes(term)) continue;
        hits.push({ d, rank: d._title.startsWith(term) ? 0 : d._title.includes(term) ? 1 : 2 });
      }
      hits.sort((a, b) => a.rank - b.rank || String(a.d.sort).localeCompare(String(b.d.sort), undefined, { numeric: true, sensitivity: 'base' }));
      return hits.slice(0, limit).map(h => h.d.id);
    });
  },
  terms({ field, q = '', libs, limit = 50 }) {
    stats.termLookups++;
    const list = state.terms[field];
    if (!list) throw Object.assign(new Error('Unknown field'), { status: 400, code: 'invalid' });
    const term = searchable(q).trim();
    return cached(`t\0${field}\0${term}\0${(libs || ['*']).join(',')}\0${limit}`, () => {
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
  clear() { answers.clear(); return true; }
};
const info = () => Object.assign({ gen: state.gen, docs: state.docs.length, loadedAt: state.loadedAt,
  terms: Object.fromEntries(Object.entries(state.terms).map(([f, l]) => [f, l.length])) }, answers.info(), stats, { hits: stats.answered, misses: stats.queries + stats.termLookups - stats.answered });
module.exports = { handlers, info };
