// Metadata service (like Jellyfin's metadata fetchers): looks works up on online providers and stores
// what it finds next to the files' own metadata.
//
// Per library: an ordered list of providers, each on or off. For each work the enabled providers are
// asked in that order; the first one with a good title match fills each field (summary, status, year,
// type, publisher, authors, rating, cover, …) and later providers only fill fields still empty. Genres, tags
// and alternative titles are combined from every site, with one name per genre/tag (terms.js). Precedence
// when shown: admin edits > folder sources > ComicInfo.xml in the files > provider metadata (genres/tags of
// all of them combined, see db.seriesMeta). Titles stay the library's (folder/ComicInfo) titles.
//
// Runs in the server process (it's network-bound, not CPU-bound), one work at a time from a queue.
const fs = require('fs');
const path = require('path');
const store = require('../db');
const config = require('../../config');
const crypto = require('crypto');
const { PROVIDERS, BY_ID, matchScore, normTitle, fromUrl, withDeadline } = require('./providers');
const local = require('./local');

const { db } = store;
if (!db.metadataSources) db.metadataSources = {};

/* ---------------- the sources: online sites + folder sources ---------------- */
// Folder sources (db.metadataSources) look like providers to the library settings, marked local: true
function folderSources() {
  return Object.values(db.metadataSources).sort((a, b) => String(a.created).localeCompare(String(b.created)));
}
function asProvider(src) {
  return { id: src.id, name: src.name, kind: 'folder', local: true, types: [], folder: src.folder, match: src.match };
}
function byId(id) {
  return BY_ID[id] || (db.metadataSources[id] ? asProvider(db.metadataSources[id]) : null);
}
// Folder sources always come before online sites (an admin's own data is more specific than a search)
const localFirst = list => list.filter(p => db.metadataSources[p.id]).concat(list.filter(p => !db.metadataSources[p.id]));
const COVERS_DIR = path.join(store.DATA_DIR, 'covers');
const MATCH_THRESHOLD = 0.85;
const FIELDS = ['summary', 'status', 'year', 'type', 'publisher', 'authors', 'genres', 'tags', 'rating', 'cover', 'altTitles', 'readingDirection', 'ageRating'];
const LISTS = ['genres', 'tags', 'altTitles']; // combined from every matched site (the rest: first site wins)
const terms = require('./terms');
// Alternative titles of several sites, without repeats (ignoring case and accents)
function mergeTitles(a, b) {
  const out = [], seen = new Set();
  for (const t of [].concat(a || [], b || [])) { const k = terms.keyOf(t); if (k && !seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}
const TYPES = ['manga', 'manhwa', 'manhua', 'webcomic', 'comic', 'novel', 'book', 'other'];
const COVER_MODES = ['missing', 'always', 'never'];
const MAX_COVER = 8 * 1024 * 1024;

const has = v => v != null && v !== '' && !(Array.isArray(v) && !v.length);
const keys = () => { const c = config.get(); return { comicVineApiKey: c.comicVineApiKey, googleBooksApiKey: c.googleBooksApiKey }; };

/* ---------------- per-library settings ---------------- */
// lib.metadata = { providers: [{ id, enabled }], autoFetch, cover }  (order = priority)
function librarySettings(lib) {
  const m = (lib && lib.metadata) || {};
  const saved = Array.isArray(m.providers) ? m.providers.filter(p => byId(p.id)) : [];
  const seen = new Set(saved.map(p => p.id));
  // Sources the library hasn't seen yet: new folder sources are on; online providers added in a later
  // version get their default on/off
  const providers = localFirst(saved.map(p => ({ id: p.id, enabled: p.enabled !== false }))
    .concat(folderSources().filter(s => !seen.has(s.id)).map(s => ({ id: s.id, enabled: true })))
    .concat(PROVIDERS.filter(p => !seen.has(p.id)).map(p => ({ id: p.id, enabled: !p.defaultOff }))));
  return { providers, autoFetch: m.autoFetch !== false, cover: COVER_MODES.includes(m.cover) ? m.cover : 'missing' };
}
function parseLibrarySettings(body, current) {
  const cur = current || librarySettings(null);
  const out = { providers: cur.providers, autoFetch: cur.autoFetch, cover: cur.cover };
  if (Array.isArray(body.providers)) {
    const list = [], seen = new Set();
    for (const p of body.providers) {
      if (!p || !byId(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      list.push({ id: p.id, enabled: p.enabled !== false });
    }
    out.providers = localFirst(list.concat(cur.providers.filter(p => !seen.has(p.id))));
  }
  if ('autoFetch' in body) out.autoFetch = Boolean(body.autoFetch);
  if ('cover' in body) {
    if (!COVER_MODES.includes(body.cover)) throw Object.assign(new Error('Invalid cover setting'), { status: 400, code: 'invalid' });
    out.cover = body.cover;
  }
  return out;
}
function providerList() {
  const k = keys();
  return folderSources().map(s => ({ id: s.id, name: s.name, kind: 'folder', folder: s.folder, match: s.match, types: [], defaultOn: true }))
    .concat(PROVIDERS.map(p => ({
      id: p.id, name: p.name, kind: 'online', homepage: p.homepage, types: p.types, defaultOn: !p.defaultOff,
      needsKey: p.needsKey || null, optionalKey: p.optionalKey || null,
      keySet: Boolean((p.needsKey && k[p.needsKey]) || (p.optionalKey && k[p.optionalKey]))
    })));
}

/* ---------------- folder sources: applying them ---------------- */
// Reads the library's enabled folder sources and stores what matches on each work (s.local) and book
// (b.local). Cheap (no network): runs after every scan, on Refresh metadata and when sources change.
// onlySeriesId: just that work. Returns { works, books } matched.
// Each source's folder index (JSON files and their parsed contents) stays in memory between runs; a refresh
// re-reads only JSON files that are new or changed (size/date), so matching never reads files.
const indexCache = new Map(); // sourceId → index (local.buildIndex)
async function sourceIndex(src) {
  const index = await local.buildIndex(src.folder, indexCache.get(src.id));
  indexCache.set(src.id, index);
  return index;
}
const relOf = (src, file) => path.relative(src.folder, file).split(path.sep).join('/');

// Every folder source's index in memory (e.g. after a restart, before anything applied them)
// ids: only these sources; onSource(src, i, count): told before each one is read (it can take a while)
async function warmIndexes(ids, onSource) {
  const todo = folderSources().filter(s => (!ids || ids.has(s.id)) && !indexCache.has(s.id));
  for (let i = 0; i < todo.length; i++) {
    if (onSource) try { onSource(todo[i], i, todo.length); } catch { /* only a report */ }
    try { await sourceIndex(todo[i]); } catch { /* folder gone */ }
  }
}

async function applyLocal(libraryId, onlySeriesId) {
  const t0 = Date.now();
  const lib = db.libraries[libraryId];
  if (!lib) return { works: 0, books: 0 };
  const sources = librarySettings(lib).providers.filter(p => p.enabled && db.metadataSources[p.id]).map(p => db.metadataSources[p.id]);
  // 1. Refresh the in-memory indexes (the only file reading, and only of new/changed JSON files)
  const indexes = [];
  let parsed = 0, reused = 0;
  for (const src of sources) {
    const index = await sourceIndex(src);
    parsed += index.parsed; reused += index.reused;
    indexes.push({ src, index });
  }
  // 2. Match in memory: the library's works and books against the indexes
  let works = 0, books = 0, changed = false;
  const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  const covers = []; // works whose cover image needs its date (step 3)
  const libSeries = Object.values(db.series).filter(s => s.libraryId === libraryId && (!onlySeriesId || s.id === onlySeriesId));
  for (const s of libSeries) {
    // The work: first source with data fills each field
    const merged = {}, fields = {}, ids = [];
    let file = null, coverPath = null;
    const sk = local.seriesKeys(s);
    for (const { src, index } of indexes) {
      const key = local.findKey(index, src.match, sk.pathKeys, sk.nameKey);
      if (!key) continue;
      const entry = index.files.get(key);
      if (!entry.data) continue;
      const rec = local.seriesRecord(entry.data);
      for (const [k, v] of Object.entries(rec)) if (k !== 'coverRel' && merged[k] === undefined) { merged[k] = v; fields[k] = src.id; }
      if (!coverPath) coverPath = local.coverFor(index, key, rec, entry.json, src.folder);
      ids.push(src.id);
      if (!file) file = relOf(src, entry.json);
    }
    let next = null;
    if (ids.length) {
      // Same cover as before: keep its version; a new one gets its date below
      const coverVersion = coverPath && s.local && s.local.coverPath === coverPath ? s.local.coverVersion : 0;
      next = { merged, fields, sourceIds: ids, file, coverPath, coverVersion };
      if (coverPath && !coverVersion) covers.push(next);
      works++;
    }
    if (!same(next, s.local)) { if (next) s.local = next; else delete s.local; changed = true; }
    // Its books (chapters/volumes/issues)
    for (const b of store.booksOf(s.id)) {
      const bm = {};
      let first = null, bfile = null;
      const bk = local.bookKeys(b);
      for (const { src, index } of indexes) {
        const key = local.findKey(index, src.match, bk.pathKeys, bk.nameKey);
        if (!key) continue;
        const entry = index.files.get(key);
        if (!entry.data) continue;
        for (const [k, v] of Object.entries(local.bookRecord(entry.data))) if (bm[k] === undefined) bm[k] = v;
        if (!first) { first = src.id; bfile = relOf(src, entry.json); }
      }
      const bnext = first ? { merged: bm, sourceId: first, file: bfile } : null;
      if (bnext) books++;
      if (!same(bnext, b.local)) { if (bnext) b.local = bnext; else delete b.local; changed = true; }
    }
  }
  // 3. Dates of new cover images (for the browser cache)
  for (const c of covers) {
    try { c.coverVersion = Math.round((await fs.promises.stat(c.coverPath)).mtimeMs / 1000); } catch { c.coverPath = null; }
  }
  if (changed) {
    store.reindex(); // book numbers may have changed
    store.saveLibrary();
  }
  return { works, books, jsonRead: parsed, jsonReused: reused, ms: Date.now() - t0 };
}
async function applyLocalEverywhere() {
  const out = {};
  for (const id of Object.keys(db.libraries)) {
    try { out[id] = await applyLocal(id); } catch (e) { console.error('[metadata] folder sources:', e.message); }
  }
  return out;
}

/* ---------------- folder sources: managing them ---------------- */
const invalid = (msg, field) => Object.assign(new Error(msg), { status: 400, code: 'invalid', field });
function sourceView(src) {
  const libs = Object.values(db.libraries);
  const usedBy = libs.filter(l => librarySettings(l).providers.some(p => p.id === src.id && p.enabled)).map(l => ({ id: l.id, name: l.name }));
  return Object.assign({ kind: 'folder' }, src, { usedBy });
}
// folder: already validated by the caller (exists, readable, not the data folder)
function createSource({ name, folder, match }) {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw invalid('A name is needed', 'name');
  if (match && !local.MATCH_MODES.includes(match)) throw invalid('Unknown match mode', 'match');
  const id = 'folder-' + crypto.randomBytes(5).toString('hex');
  db.metadataSources[id] = { id, name: n, folder, match: match || 'path', created: new Date().toISOString() };
  store.saveLibrary();
  applyLocalEverywhere().catch(() => {});
  return db.metadataSources[id];
}
function updateSource(id, { name, folder, match }) {
  const src = db.metadataSources[id];
  if (!src) throw Object.assign(new Error('Source not found'), { status: 404, code: 'notFound' });
  if (name !== undefined) { const n = String(name || '').trim().slice(0, 80); if (!n) throw invalid('A name is needed', 'name'); src.name = n; }
  if (match !== undefined) { if (!local.MATCH_MODES.includes(match)) throw invalid('Unknown match mode', 'match'); src.match = match; }
  if (folder !== undefined) { if (folder !== src.folder) indexCache.delete(id); src.folder = folder; }
  src.updated = new Date().toISOString();
  store.saveLibrary();
  applyLocalEverywhere().catch(() => {});
  return src;
}
async function removeSource(id) {
  if (!db.metadataSources[id]) throw Object.assign(new Error('Source not found'), { status: 404, code: 'notFound' });
  delete db.metadataSources[id];
  indexCache.delete(id);
  for (const lib of Object.values(db.libraries)) {
    if (lib.metadata && Array.isArray(lib.metadata.providers)) lib.metadata.providers = lib.metadata.providers.filter(p => p.id !== id);
  }
  store.saveLibrary();
  await applyLocalEverywhere(); // its data disappears from works and books
}
// What a folder source would match, without changing anything: per library, works and books matched (with
// examples), JSON files nothing uses, names used by several files (by-name matching), files that can't be read
async function checkSource(id) {
  const src = db.metadataSources[id];
  if (!src) throw Object.assign(new Error('Source not found'), { status: 404, code: 'notFound' });
  const index = await sourceIndex(src);
  const used = new Set(), ambiguous = new Set(), errors = [];
  const libraries = [];
  for (const lib of Object.values(db.libraries)) {
    const enabled = librarySettings(lib).providers.some(p => p.id === id && p.enabled);
    const r = { id: lib.id, name: lib.name, enabled, works: 0, worksTotal: 0, books: 0, booksTotal: 0, examples: [] };
    for (const s of Object.values(db.series)) {
      if (s.libraryId !== lib.id) continue;
      r.worksTotal++;
      const sk = local.seriesKeys(s);
      const key = local.findKey(index, src.match, sk.pathKeys, sk.nameKey, ambiguous);
      if (key) { r.works++; used.add(key); if (r.examples.length < 6) r.examples.push({ what: s.relPath.split(/[\\/]/).join('/'), file: path.relative(src.folder, index.files.get(key).json).split(path.sep).join('/') }); }
      for (const b of store.booksOf(s.id)) {
        r.booksTotal++;
        const bk = local.bookKeys(b);
        const k2 = local.findKey(index, src.match, bk.pathKeys, bk.nameKey, ambiguous);
        if (k2) { r.books++; used.add(k2); if (r.examples.length < 6) r.examples.push({ what: b.relPath.split(/[\\/]/).join('/'), file: path.relative(src.folder, index.files.get(k2).json).split(path.sep).join('/') }); }
      }
    }
    libraries.push(r);
  }
  const jsonKeys = [...index.files.entries()].filter(([, e]) => e.json);
  for (const [, e] of jsonKeys) {
    if (e.error && errors.length < 20) errors.push({ file: relOf(src, e.json), error: e.error });
  }
  const unused = jsonKeys.filter(([k, e]) => !used.has(k) && !e.error).map(([, e]) => path.relative(src.folder, e.json).split(path.sep).join('/'));
  let folderOk = true;
  try { await fs.promises.access(src.folder, fs.constants.R_OK); } catch { folderOk = false; }
  return { id, folderOk, files: jsonKeys.length, truncated: index.truncated, jsonRead: index.parsed, jsonReused: index.reused, libraries, unused: unused.slice(0, 20), unusedCount: unused.length,
    ambiguous: [...ambiguous].slice(0, 20), errors };
}

/* ---------------- looking a work up ---------------- */
// The title to search: the library's title for the work, without a version suffix
function queryFor(s) {
  const m = store.seriesMeta(s);
  return store.splitEdition(m.title).title || s.name;
}
function yearHint(s) {
  for (const b of store.booksOf(s.id)) { const y = /^(\d{4})/.exec(store.bookMeta(b).releaseDate || ''); if (y) return Number(y[1]); }
  return undefined;
}
// Every title the work is known by: its main title first, then its alternative titles (from its own edits,
// folder sources, ComicInfo.xml or an earlier online match), without repeats
const MAX_TITLES = 8, MAX_QUERIES = 3;
function titlesFor(s) {
  const main = queryFor(s);
  const out = [main], seen = new Set([normTitle(main)]);
  for (const t of store.seriesMeta(s).altTitles || []) {
    const k = normTitle(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_TITLES) break;
  }
  return out;
}
// The best result of a site for a work. Each result is compared with ALL of the work's titles (the best
// comparison counts), against the result's title and its alternative titles. The site is searched with the
// main title first; if nothing matches well enough, with the next alternative titles (up to MAX_QUERIES
// searches). `via` = the title whose search found it.
async function bestMatch(provider, titles, year) {
  if (!Array.isArray(titles)) titles = [titles];
  let best = null;
  for (let i = 0; i < titles.length && i < MAX_QUERIES; i++) {
    const results = await provider.search(titles[i], keys());
    for (const r of results) {
      const score = Math.max(...titles.map(t => matchScore(t, r, year)));
      if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = Object.assign({ score, via: titles[i] }, r);
    }
    if (best) break;
  }
  return best;
}

async function downloadCover(seriesId, url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Thoth-Library-Server/1.0' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`cover download answered ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[type];
  if (!ext) throw new Error(`cover isn't an image (${type || 'unknown type'})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_COVER) throw new Error('cover is too large');
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  for (const old of fs.readdirSync(COVERS_DIR).filter(f => f.startsWith(seriesId + '.'))) fs.rmSync(path.join(COVERS_DIR, old), { force: true });
  const file = seriesId + ext;
  fs.writeFileSync(path.join(COVERS_DIR, file), buf);
  return file;
}
function removeCover(s) {
  if (s.provider && s.provider.coverFile) fs.rmSync(path.join(COVERS_DIR, s.provider.coverFile), { force: true });
  removeCustomCover(s);
}

/* ---------------- choosing a work's cover (Edit dialog) ----------------
 * Candidates: automatic (library setting), the first page of its files, each matched site's cover image,
 * the downloaded cover, images in folder sources that belong to the work, and the cover chosen/uploaded
 * before. Choosing an image (site, folder, upload) stores a copy as the work's own cover
 * (data/covers/custom-<id>.<ext>), which then always wins (store.metadataCover). */
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const IMAGE_EXTS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function removeCustomCover(s) {
  if (s.customCover && s.customCover.file) fs.rmSync(path.join(COVERS_DIR, s.customCover.file), { force: true });
  delete s.customCover;
}
function saveCustomCover(s, buf, ext, from) {
  if (buf.length > MAX_COVER) throw Object.assign(new Error('Image is too large (8 MB at most)'), { status: 413, code: 'tooLarge' });
  removeCustomCover(s);
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const file = `custom-${s.id}-${Date.now().toString(36)}${ext}`;
  fs.writeFileSync(path.join(COVERS_DIR, file), buf);
  s.customCover = { file, from, at: new Date().toISOString() }; // (its date refreshes browser caches)
  store.saveLibrary();
}
// Images in the library's enabled folder sources that belong to this work: an image named like the work
// (or its JSON), anything inside the work's folder (same structure), the cover the JSON points to
async function localCoverImages(s) {
  const lib = db.libraries[s.libraryId];
  const out = [];
  for (const p of librarySettings(lib).providers) {
    const src = p.enabled && db.metadataSources[p.id];
    if (!src) continue;
    const index = indexCache.get(src.id) || await sourceIndex(src);
    const { pathKeys, nameKey } = local.seriesKeys(s);
    const base = pathKeys[0];
    for (const img of index.images) {
      const key = local.keyOf(path.relative(src.folder, img));
      const name = key.split('/').pop();
      const mine = key === base || key.startsWith(base + '/') || (src.match === 'name' && name === nameKey) ||
        (s.local && s.local.coverPath === img);
      if (mine && out.length < 40) out.push({ sourceId: src.id, sourceName: src.name, rel: relOf(src, img), file: img });
    }
  }
  return out;
}
// The picker's second step: the enabled online sites that weren't asked during the lookup (it stops once
// the main fields are filled) are searched now for this work's title, in parallel, a few seconds at most.
// Found covers are remembered with the work's other candidates.
// Only ordinary web addresses: no other protocols, nothing on this machine or the local network
function publicUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (/^(::1?|f[cd][0-9a-f]{2}:|fe80:)/.test(h)) return false;
  return true;
}
// The image a web page offers for sharing (og:image / twitter:image), or null. Reads at most 512 KB of it.
async function pageImage(url, ms = 8000) {
  if (!publicUrl(url)) return null;
  const res = await fetch(url, { headers: { 'User-Agent': 'Thoth-Library-Server/1.0', Accept: 'text/html' }, signal: AbortSignal.timeout(Math.max(1000, ms)), redirect: 'follow' });
  if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return null;
  const reader = res.body.getReader();
  let html = '', size = 0;
  while (size < 512 * 1024) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    html += Buffer.from(value).toString('utf8');
    if (/<\/head>/i.test(html)) break;
  }
  try { reader.cancel(); } catch { /* done */ }
  for (const name of ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/:/g, '\\:')}["'][^>]*content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name.replace(/:/g, '\\:')}["']`, 'i');
    const m = re1.exec(html) || re2.exec(html);
    if (m) {
      try {
        const img = new URL(m[1].replace(/&amp;/g, '&'), res.url || url).href;
        return publicUrl(img) ? img : null;
      } catch { return null; }
    }
  }
  return null;
}
// Covers from the work's links: a link to a metadata site → that entry's cover (no search needed); any other
// page → the image it offers for sharing. Each link is tried once per picker opening, a few seconds at most.
async function linkCovers(s, have) {
  const found = [];
  await Promise.all(store.seriesMeta(s).links.slice(0, 10).map(async url => {
    const x = fromUrl(url);
    try {
      if (x) {
        const provider = BY_ID[x.provider];
        if (have.has(x.provider) || (provider.needsKey && !keys()[provider.needsKey])) return;
        const m = await Promise.race([provider.fetch(x.id, keys()), new Promise(resolve => setTimeout(() => resolve(null), COVER_SEARCH_MS))]);
        if (m && m.cover) { found.push({ provider: x.provider, url: m.cover, page: url }); have.add(x.provider); }
      } else {
        const key = 'web:' + new URL(url).hostname.replace(/^www\./, '');
        if (have.has(key)) return;
        const img = await pageImage(url, COVER_SEARCH_MS - 500);
        if (img) { found.push({ provider: key, url: img, page: url }); have.add(key); }
      }
    } catch { /* that page is unavailable; skip it */ }
  }));
  return found;
}
// The picker's search for more covers: the work's links and the enabled sites without a candidate yet, all at
// once, within COVER_SEARCH_MS (requests that couldn't get their turn at a site in time aren't made: see
// providers.withDeadline). Done at most once a week per work unless asked again (force); the same work is
// never searched twice at the same time.
const COVER_SEARCH_MS = 6000, COVER_SEARCH_EVERY = 7 * 86400000;
const coverSearches = new Map();
function searchMoreCovers(s, { force = false } = {}) {
  const p = s.provider = s.provider || {};
  if (!force && p.coverSearchAt && Date.now() - Date.parse(p.coverSearchAt) < COVER_SEARCH_EVERY) return Promise.resolve(0);
  if (coverSearches.has(s.id)) return coverSearches.get(s.id);
  const job = withDeadline(COVER_SEARCH_MS, async () => {
    const have = new Set((p.coverCandidates || []).map(c => c.provider));
    const titles = titlesFor(s), year = yearHint(s);
    const ids = librarySettings(db.libraries[s.libraryId]).providers.filter(x => x.enabled && BY_ID[x.id] && !have.has(x.id)).map(x => x.id);
    const found = [];
    const [fromLinks] = await Promise.all([
      linkCovers(s, have),
      Promise.all(ids.map(async pid => {
        const provider = BY_ID[pid];
        if (provider.needsKey && !keys()[provider.needsKey]) return;
        try {
          const best = await Promise.race([bestMatch(provider, titles, year), new Promise(resolve => setTimeout(() => resolve(null), COVER_SEARCH_MS))]);
          if (best && best.cover && !have.has(pid)) found.push({ provider: pid, url: best.cover });
        } catch { /* that site is unavailable or busy; skip it */ }
      }))
    ]);
    const added = fromLinks.concat(found);
    if (added.length) p.coverCandidates = (p.coverCandidates || []).concat(added);
    p.coverSearchAt = new Date().toISOString();
    store.saveLibrary({ series: s });
    return added.length;
  });
  coverSearches.set(s.id, job);
  job.then(() => coverSearches.delete(s.id), () => coverSearches.delete(s.id));
  return job;
}
async function coverCandidates(s, { search = false, force = false } = {}) {
  if (search) await searchMoreCovers(s, { force });
  const out = [{ id: 'auto', kind: 'auto' }];
  const firstPage = store.booksOf(s.id).find(b => b.format === 'cbz' && b.pageCount);
  if (firstPage) out.push({ id: 'file', kind: 'file', bookId: firstPage.id });
  const p = s.provider || {};
  if (p.coverFile) out.push({ id: 'downloaded', kind: 'downloaded', provider: p.coverProvider || null });
  const seen = new Set();
  for (const c of p.coverCandidates || (p.coverUrl ? [{ provider: p.coverProvider, url: p.coverUrl }] : [])) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ id: 'online:' + c.provider, kind: 'online', provider: c.provider, url: c.url, page: c.page || null });
  }
  for (const img of await localCoverImages(s)) out.push({ id: 'local:' + img.sourceId + ':' + img.rel, kind: 'local', sourceName: img.sourceName, rel: img.rel });
  if (s.customCover) out.push({ id: 'custom', kind: 'custom', from: s.customCover.from });
  // Which one is in use now
  const o = s.overrides || {};
  const current = s.customCover ? 'custom' : o.cover === 'file' ? 'file' : o.cover === 'metadata' ? 'downloaded' : 'auto';
  return { current, candidates: out, searchedAt: (s.provider && s.provider.coverSearchAt) || null };
}
// The file behind a candidate that lives on this server (for previews): downloaded, custom, local
function candidateFile(s, id) {
  if (id === 'downloaded' && s.provider && s.provider.coverFile) return path.join(COVERS_DIR, s.provider.coverFile);
  if (id === 'custom' && s.customCover) return path.join(COVERS_DIR, s.customCover.file);
  const m = /^local:([\w-]+):(.+)$/.exec(id || '');
  if (m) {
    const src = db.metadataSources[m[1]];
    if (!src) return null;
    const file = path.resolve(src.folder, m[2]);
    if (!file.startsWith(path.resolve(src.folder) + path.sep) || !IMAGE_EXTS[path.extname(file).toLowerCase()]) return null;
    const index = indexCache.get(src.id);
    return !index || index.images.has(file) ? file : null;
  }
  return null;
}
// Preview of a site's cover candidate, fetched by the server; the last 60 are kept in memory
// Previews give up after PREVIEW_MS (a slow image host can't keep the picker waiting) and a failure is
// remembered for a while, so the picker shows "not available" at once instead of waiting again. The same
// image asked twice at once is fetched once.
const previewCache = new Map(); // url → { buf, type }
const previewFailed = new Map(); // url → time it failed
const previewInflight = new Map();
const PREVIEW_MS = 8000, PREVIEW_FAILED_MS = 10 * 60 * 1000;
async function fetchImage(url, { timeout = 20000 } = {}) {
  if (previewCache.has(url)) return previewCache.get(url);
  const failedAt = previewFailed.get(url);
  if (failedAt && Date.now() - failedAt < PREVIEW_FAILED_MS && timeout <= PREVIEW_MS) throw Object.assign(new Error('The site didn’t send an image'), { status: 502, code: 'coverDownloadFailed' });
  if (previewInflight.has(url)) return previewInflight.get(url);
  const job = (async () => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Thoth-Library-Server/1.0' }, signal: AbortSignal.timeout(timeout) });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok || !IMAGE_TYPES[type]) throw Object.assign(new Error('The site didn’t send an image'), { status: 502, code: 'coverDownloadFailed' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_COVER) throw Object.assign(new Error('Image is too large'), { status: 413, code: 'tooLarge' });
      previewCache.set(url, { buf, type });
      if (previewCache.size > 60) previewCache.delete(previewCache.keys().next().value);
      previewFailed.delete(url);
      return { buf, type };
    } catch (e) {
      previewFailed.set(url, Date.now());
      if (previewFailed.size > 500) previewFailed.delete(previewFailed.keys().next().value);
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw Object.assign(new Error('The site didn’t send the image in time'), { status: 504, code: 'coverDownloadFailed' });
      throw e;
    }
  })();
  previewInflight.set(url, job);
  job.then(() => previewInflight.delete(url), () => previewInflight.delete(url));
  return job;
}
async function onlineCandidateImage(s, id) {
  const provider = String(id).replace(/^online:/, '');
  const c = ((s.provider && s.provider.coverCandidates) || []).find(x => x.provider === provider) ||
    (s.provider && s.provider.coverProvider === provider && s.provider.coverUrl ? { url: s.provider.coverUrl } : null);
  if (!c) return null;
  try { return await fetchImage(c.url, { timeout: PREVIEW_MS }); } catch { return null; }
}
// Apply a choice from the Edit dialog. choice: a candidate id; upload: 'data:image/…;base64,…'
async function chooseCover(s, { choice, upload }) {
  const o = s.overrides = s.overrides || {};
  if (upload) {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(upload));
    if (!m) throw Object.assign(new Error('Not an image'), { status: 400, code: 'notAnImage' });
    delete o.cover;
    saveCustomCover(s, Buffer.from(m[2], 'base64'), IMAGE_TYPES[m[1]], 'upload');
    return;
  }
  const { candidates } = await coverCandidates(s);
  const c = candidates.find(x => x.id === choice);
  if (!c) throw Object.assign(new Error('Unknown cover'), { status: 400, code: 'invalid' });
  if (c.kind === 'custom') return; // keep it
  if (c.kind === 'auto' || c.kind === 'file' || c.kind === 'downloaded') {
    removeCustomCover(s);
    if (c.kind === 'auto') delete o.cover; else o.cover = c.kind === 'file' ? 'file' : 'metadata';
    store.saveLibrary();
    return;
  }
  if (c.kind === 'online') {
    const img = await fetchImage(c.url); // (reuses the preview the picker just showed)
    delete o.cover;
    saveCustomCover(s, img.buf, IMAGE_TYPES[img.type], c.id);
    return;
  }
  if (c.kind === 'local') {
    const file = candidateFile(s, c.id);
    if (!file) throw Object.assign(new Error('Image not found'), { status: 404, code: 'notFound' });
    delete o.cover;
    saveCustomCover(s, await fs.promises.readFile(file), path.extname(file).toLowerCase().replace('.jpeg', '.jpg'), c.id);
  }
}
function coverPath(s) {
  return s.provider && s.provider.coverFile ? path.join(COVERS_DIR, s.provider.coverFile) : null;
}

const running = new Set(); // series being refreshed right now
// cur (optional): the queue's progress entry for this work; its `step` says what's happening now
async function refreshSeries(seriesId, cur) {
  const step = (name, provider) => { if (cur) { cur.step = name; cur.provider = provider || null; } };
  const s = db.series[seriesId];
  if (!s) throw Object.assign(new Error('Series not found'), { status: 404, code: 'notFound' });
  if (running.has(seriesId)) return s.provider || null;
  running.add(seriesId);
  try {
    const lib = db.libraries[s.libraryId];
    const settings = librarySettings(lib);
    // Folder sources first (local files, instant), then the online sites
    step('folder');
    try { await applyLocal(s.libraryId, s.id); } catch (e) { console.error('[metadata] folder sources:', e.message); }
    const query = queryFor(s);
    const titles = titlesFor(s); // the main title and the alternative titles
    const year = yearHint(s);
    // Matches picked by hand (Identify; one per site, several sites possible), and the work's links that point
    // at a site's entry (from its JSON files, edits or earlier matches): those sites need no search
    const locked = lockList(s.provider && s.provider.locked);
    const linked = {};
    for (const url of store.seriesMeta(s).links) {
      const x = fromUrl(url);
      if (x && !linked[x.provider]) linked[x.provider] = x.id;
    }
    const merged = {}, sources = {}, matches = [], errors = [], covers = [];
    for (const { id: pid, enabled } of settings.providers) {
      const provider = BY_ID[pid];
      if (!provider) continue; // a folder source (applied above)
      const lock = locked.find(l => l.provider === pid);
      const linkId = linked[pid];
      if (!enabled && !lock) continue;
      // Every enabled site is asked (genres, tags and alternative titles are combined from all of them)
      if (provider.needsKey && !keys()[provider.needsKey]) continue;
      step('searching', pid);
      try {
        let id, score = 1, via = null;
        if (lock) id = lock.id;
        else if (linkId) { id = linkId; via = 'link'; }
        else {
          const best = await bestMatch(provider, titles, year);
          if (!best) continue;
          id = best.id; score = best.score; via = best.via;
        }
        const m = await provider.fetch(id, keys());
        if (!m) continue;
        matches.push({ provider: pid, id: String(m.id || id), title: m.title, url: m.url, score, via, locked: Boolean(lock) });
        for (const f of FIELDS) {
          if (!has(m[f])) continue;
          if (LISTS.includes(f) && has(merged[f])) {
            // Lists complement each other: what one site has and the others don't is added
            const next = f === 'altTitles' ? mergeTitles(merged[f], m[f]) : terms.unify(merged[f], m[f]);
            if (next.length > merged[f].length) { merged[f] = next; sources[f] = [].concat(sources[f], pid).filter((v, i, a) => a.indexOf(v) === i).join(','); }
          } else if (!has(merged[f])) { merged[f] = LISTS.includes(f) && f !== 'altTitles' ? terms.unify(m[f]) : m[f]; sources[f] = pid; }
        }
        if (m.cover) covers.push({ url: m.cover, provider: pid });
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (merged.genres || merged.tags) Object.assign(merged, terms.unifyGenresTags([merged.genres], [merged.tags]));
    if (merged.tags && !merged.tags.length) { delete merged.tags; delete sources.tags; }
    // Cover: part of the check. Downloaded once to data/covers/ (unless the library never uses metadata
    // covers); if the first source's image can't be downloaded, the next source's is tried.
    let coverFile = s.provider && s.provider.coverFile;
    let coverUrl = s.provider && s.provider.coverUrl;
    let coverProvider = s.provider && s.provider.coverProvider;
    const haveFile = coverFile && fs.existsSync(path.join(COVERS_DIR, coverFile));
    if (covers.length && settings.cover !== 'never') {
      if (!haveFile || !covers.some(c => c.url === coverUrl)) {
        step('cover', covers[0].provider);
        let got = null;
        for (const c of covers) {
          try { got = { file: await downloadCover(s.id, c.url), url: c.url, provider: c.provider }; break; } catch (e) { errors.push(`cover (${c.provider}): ${e.message}`); }
        }
        if (got) { coverFile = got.file; coverUrl = got.url; coverProvider = got.provider; status.covers++; } else if (!haveFile) coverFile = coverUrl = coverProvider = null;
      } else {
        coverProvider = (covers.find(c => c.url === coverUrl) || {}).provider || coverProvider; // same image as before
      }
    } else if (coverFile) {
      removeCover(s);
      coverFile = coverUrl = coverProvider = null;
    }
    if (!covers.length && !haveFile) coverFile = coverUrl = coverProvider = null;
    const current = db.series[seriesId]; // may have been removed by a scan meanwhile
    if (!current) return null;
    const now = new Date().toISOString();
    const next = {
      query, locked: locked.length ? locked : null, matches, sources, errors,
      merged: Object.fromEntries(Object.entries(merged).filter(([k]) => k !== 'cover')),
      coverUrl: coverUrl || null, coverFile: coverFile || null, coverProvider: coverProvider || null,
      coverCandidates: covers, // every matched site's cover image (choices in the Edit dialog)
      links: matches.map(x => ({ provider: x.provider, url: x.url })).filter(x => x.url)
    };
    // Delta: the work only counts as updated (sort "Recently updated", cover cache) when something changed
    const old = current.provider || {};
    // Only the data counts: which entries matched (not how they were found or their scores), the merged
    // values, the cover and the links
    const strip = p => JSON.stringify({
      matches: (p.matches || []).map(m => m.provider + ':' + m.id).sort(),
      merged: p.merged || null, sources: p.sources || null, coverUrl: p.coverUrl || null, coverFile: p.coverFile || null,
      links: (p.links || []).map(l => l.url).sort(), locked: p.locked || null
    });
    const changed = strip(old) !== strip(next) || (next.coverFile && next.coverFile !== old.coverFile);
    current.provider = Object.assign(next, { fetchedAt: changed || !old.fetchedAt ? now : old.fetchedAt, checkedAt: now });
    if (changed) current.updated = now;
    status.changed = (status.changed || 0) + (changed ? 1 : 0);
    store.saveLibrary({ series: current }); // only this work changed (its memoized views are redone)
    status.done++;
    if (!matches.length && errors.length) status.lastError = errors[0];
    return current.provider;
  } finally {
    running.delete(seriesId);
  }
}

// Search every enabled provider (or one) for the Identify dialog
async function searchForSeries(seriesId, query, onlyProvider) {
  const s = db.series[seriesId];
  if (!s) throw Object.assign(new Error('Series not found'), { status: 404, code: 'notFound' });
  const settings = librarySettings(db.libraries[s.libraryId]);
  const q = String(query || '').trim() || queryFor(s);
  const ids = onlyProvider ? [onlyProvider] : settings.providers.filter(p => p.enabled).map(p => p.id);
  const results = [], errors = [];
  await Promise.all(ids.map(async pid => {
    const p = BY_ID[pid];
    if (!p) return;
    if (p.needsKey && !keys()[p.needsKey]) { errors.push(`${p.name}: needs an API key (Server settings)`); return; }
    try {
      // Ranked against the searched text and every title the work is known by
      const all = [q].concat(titlesFor(s));
      for (const r of await p.search(q, keys())) results.push(Object.assign({ provider: pid, providerName: p.name, score: Math.max(...all.map(x => matchScore(x, r, yearHint(s)))) }, r));
    } catch (e) { errors.push(e.message); }
  }));
  const order = Object.fromEntries(ids.map((id, i) => [id, i]));
  results.sort((a, b) => b.score - a.score || order[a.provider] - order[b.provider]);
  return { query: q, results: results.slice(0, 40), errors };
}

// The sources page's "Try a search" for one online site
async function testSearch(providerId, query) {
  const p = BY_ID[providerId];
  if (p.needsKey && !keys()[p.needsKey]) throw Object.assign(new Error(`${p.name}: needs an API key (Server settings)`), { status: 400, code: 'needsKey' });
  const t0 = Date.now();
  const results = (await p.search(query, keys())).map(r => Object.assign({ score: matchScore(query, r) }, r));
  results.sort((a, b) => b.score - a.score);
  return { ms: Date.now() - t0, items: results.slice(0, 8) };
}

// Matches picked by hand: older data has one { provider, id }, now a list (one per site)
function lockList(v) {
  return [].concat(v || []).filter(x => x && BY_ID[x.provider] && x.id).map(x => ({ provider: x.provider, id: String(x.id) }));
}
// picks: [{ provider, id }] — the matches chosen in the Identify dialog (several sites at once are fine; one
// per site, the last one wins). They replace earlier hand-picked matches and are kept for later refreshes.
async function identify(seriesId, picks) {
  const s = db.series[seriesId];
  if (!s) throw Object.assign(new Error('Series not found'), { status: 404, code: 'notFound' });
  const bySite = {};
  for (const p of [].concat(picks || [])) {
    if (!p || !BY_ID[p.provider] || !p.id) throw Object.assign(new Error('Unknown provider'), { status: 400, code: 'invalid' });
    bySite[p.provider] = { provider: p.provider, id: String(p.id).slice(0, 100) };
  }
  const list = Object.values(bySite);
  if (!list.length) throw Object.assign(new Error('Nothing picked'), { status: 400, code: 'invalid' });
  s.provider = Object.assign({}, s.provider || {}, { locked: list });
  return refreshSeries(seriesId);
}

function clear(seriesId) {
  const s = db.series[seriesId];
  if (!s) throw Object.assign(new Error('Series not found'), { status: 404, code: 'notFound' });
  removeCover(s);
  delete s.provider;
  s.updated = new Date().toISOString();
  store.saveLibrary();
}

/* ---------------- background queue ---------------- */
const queue = [];
const status = { done: 0, covers: 0, current: [], lastError: null }; // current: works being looked up right now
const batch = { total: 0, done: 0, startedAt: 0 };
let active = 0;

// Each batch is a task (Processes → Tasks), logging every work looked up
let batchTask = null;
function enqueue(seriesIds) {
  if (!active && !queue.length) Object.assign(batch, { total: 0, done: 0, startedAt: Date.now() }); // a new batch
  let added = 0;
  for (const id of seriesIds) if (!queue.includes(id) && !running.has(id)) { queue.push(id); added++; }
  batch.total += added;
  if (added && !batchTask) batchTask = require('../tasks').start({ kind: 'metadata', title: 'Metadata lookups', progress: batchProgress });
  if (added && batchTask) batchTask.log(`+${added} work(s) to look up`);
  pump();
  return added;
}
// A matched work whose cover should be downloaded but isn't
function missingCover(s) {
  const p = s.provider;
  if (!p || !(p.matches || []).length || librarySettings(db.libraries[s.libraryId]).cover === 'never') return false;
  return !p.coverFile || !fs.existsSync(path.join(COVERS_DIR, p.coverFile));
}
// Works whose metadata is worth checking again (delta update): never looked up, a matched work missing its
// cover, looked up more than STALE_DAYS ago, or whose files changed since the last check
const STALE_DAYS = 30;
function needsUpdate(s) {
  const p = s.provider;
  if (!p) return true;
  if (missingCover(s) && p.coverUrl) return true;
  const checked = p.checkedAt || p.fetchedAt || '';
  if (!checked || Date.now() - Date.parse(checked) > STALE_DAYS * 86400000) return true;
  return Boolean(s.updated && s.updated > checked);
}
// mode 'missing': works never looked up, and matched works still missing their cover;
// 'stale': the delta — works needsUpdate() picks; 'all': every work
function enqueueLibrary(libraryId, mode = 'missing') {
  const ids = Object.values(db.series)
    .filter(s => s.libraryId === libraryId && !s.hidden && (mode === 'all' || (mode === 'stale' ? needsUpdate(s) : !s.provider || (missingCover(s) && s.provider.coverUrl))))
    .sort((a, b) => store.collator.compare(store.seriesMeta(a).sortTitle, store.seriesMeta(b).sortTitle))
    .map(s => s.id);
  return enqueue(ids);
}
// After a scan: look up new works if the library fetches metadata automatically
function afterScan(libraryId) {
  const lib = db.libraries[libraryId];
  if (!lib) return;
  // Folder sources are re-read on every scan (new chapters get their JSON right away), then online lookups
  applyLocal(libraryId)
    .catch(e => console.error('[metadata] folder sources:', e.message))
    .then(() => { if (db.libraries[libraryId] && librarySettings(lib).autoFetch) enqueueLibrary(libraryId, 'missing'); });
}
// Several works at once (Server settings → metadataConcurrency). Each site still gets its own pause between
// requests, so more works at once mostly overlaps waiting on different sites and downloads.
function concurrency() { return Math.max(1, Number(config.get().metadataConcurrency) || 1); }
function pump() {
  while (active < concurrency() && queue.length) {
    const id = queue.shift();
    const s = db.series[id];
    if (!s) { batch.done++; continue; }
    active++;
    const cur = { seriesId: id, title: store.seriesMeta(s).title, startedAt: new Date().toISOString(), step: 'searching', provider: null };
    status.current.push(cur);
    refreshSeries(id, cur)
      .then(() => { if (batchTask) batchTask.log(`"${cur.title}": ` + (db.series[id] && db.series[id].provider && (db.series[id].provider.matches || []).length ? 'matched on ' + db.series[id].provider.matches.map(m => m.provider).join(', ') : 'no match')); })
      .catch(e => { status.lastError = e.message; if (batchTask) batchTask.log(`"${cur.title}": failed - ${e.message}`); })
      .finally(() => {
        active--;
        batch.done++;
        status.current = status.current.filter(c => c !== cur);
        pump();
        if (!active && !queue.length && batchTask) { batchTask.end('done', `${batch.done} work(s) looked up`); batchTask = null; }
      });
  }
}
config.onChange(changed => { if (changed.includes('metadataConcurrency')) pump(); });

// Progress of the current batch (everything queued since the queue was last empty), with time left
// estimated from the average time per work so far
function batchProgress() {
  if (!batch.total || (!active && !queue.length)) return null;
  const elapsed = Date.now() - batch.startedAt;
  const done = Math.min(batch.done, batch.total);
  return { done, total: batch.total, percent: Math.floor(done / batch.total * 100), elapsedMs: elapsed,
    etaMs: done >= 1 ? Math.round(elapsed / done * (batch.total - done)) : null };
}
function info() {
  return {
    queue: queue.length, current: status.current, done: status.done, changed: status.changed || 0, covers: status.covers, lastError: status.lastError,
    concurrency: concurrency(), progress: batchProgress()
  };
}
// Remove a deleted library's or series' covers
function forgetSeries(s) { removeCover(s); const i = queue.indexOf(s.id); if (i !== -1) { queue.splice(i, 1); batch.done++; } }

module.exports = {
  TYPES, COVER_MODES, MATCH_MODES: local.MATCH_MODES, providerList, librarySettings, parseLibrarySettings,
  applyLocal, applyLocalEverywhere, sourceView, testSearch, coverCandidates, candidateFile, chooseCover, onlineCandidateImage, IMAGE_EXTS, indexCache, warmIndexes,
  folderSources, createSource, updateSource, removeSource, checkSource, BY_ID,
  bestMatch, titlesFor, publicUrl, pageImage, // (exported for tests)
  refreshSeries, searchForSeries, identify, clear, enqueueLibrary, afterScan, info, coverPath, forgetSeries
};
