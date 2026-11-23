// Metadata service (like Jellyfin's metadata fetchers): looks works up on online providers and stores
// what it finds next to the files' own metadata.
//
// Per library: an ordered list of providers, each on or off. For each work the enabled providers are
// asked in that order; the first one with a good title match fills each field (summary, status, year,
// type, publisher, authors, tags, rating, cover, …) and later providers only fill fields still empty.
// It stops early once the main fields are filled. Precedence when shown: admin edits > ComicInfo.xml in
// the files > provider metadata. Titles stay the library's (folder/ComicInfo) titles.
//
// Runs in the server process (it's network-bound, not CPU-bound), one work at a time from a queue.
const fs = require('fs');
const path = require('path');
const store = require('../db');
const config = require('../../config');
const crypto = require('crypto');
const { PROVIDERS, BY_ID, matchScore } = require('./providers');
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
const CORE = ['summary', 'status', 'year', 'type', 'authors', 'genres', 'cover']; // stop asking providers once these are filled
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
  const unused = jsonKeys.filter(([k]) => !used.has(k)).map(([, e]) => path.relative(src.folder, e.json).split(path.sep).join('/'));
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
async function bestMatch(provider, query, year) {
  const results = await provider.search(query, keys());
  let best = null;
  for (const r of results) {
    const score = matchScore(query, r, year);
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = Object.assign({ score }, r);
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
    const year = yearHint(s);
    const locked = s.provider && s.provider.locked;
    const merged = {}, sources = {}, matches = [], errors = [], covers = [];
    for (const { id: pid, enabled } of settings.providers) {
      const provider = BY_ID[pid];
      if (!provider) continue; // a folder source (applied above)
      const isLocked = locked && locked.provider === pid;
      if (!enabled && !isLocked) continue;
      if (provider.needsKey && !keys()[provider.needsKey]) continue;
      step('searching', pid);
      try {
        let id, score = 1;
        if (isLocked) id = locked.id;
        else {
          const best = await bestMatch(provider, query, year);
          if (!best) continue;
          id = best.id; score = best.score;
        }
        const m = await provider.fetch(id, keys());
        if (!m) continue;
        matches.push({ provider: pid, id: String(m.id || id), title: m.title, url: m.url, score, locked: Boolean(isLocked) });
        for (const f of FIELDS) if (!has(merged[f]) && has(m[f])) { merged[f] = m[f]; sources[f] = pid; }
        if (m.cover) covers.push({ url: m.cover, provider: pid });
      } catch (e) {
        errors.push(e.message);
      }
      if (CORE.every(f => has(merged[f]))) break;
    }
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
      query, locked: locked || null, matches, sources, errors,
      merged: Object.fromEntries(Object.entries(merged).filter(([k]) => k !== 'cover')),
      coverUrl: coverUrl || null, coverFile: coverFile || null, coverProvider: coverProvider || null,
      links: matches.map(x => ({ provider: x.provider, url: x.url })).filter(x => x.url)
    };
    // Delta: the work only counts as updated (sort "Recently updated", cover cache) when something changed
    const old = current.provider || {};
    const strip = p => JSON.stringify(Object.assign({}, p, { fetchedAt: undefined, checkedAt: undefined, errors: undefined }));
    const changed = strip(old) !== strip(next) || (next.coverFile && next.coverFile !== old.coverFile);
    current.provider = Object.assign(next, { fetchedAt: changed || !old.fetchedAt ? now : old.fetchedAt, checkedAt: now });
    if (changed) current.updated = now;
    status.changed = (status.changed || 0) + (changed ? 1 : 0);
    store.saveLibrary();
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
      for (const r of await p.search(q, keys())) results.push(Object.assign({ provider: pid, providerName: p.name, score: matchScore(q, r, yearHint(s)) }, r));
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

async function identify(seriesId, providerId, id) {
  const s = db.series[seriesId];
  if (!s) throw Object.assign(new Error('Series not found'), { status: 404, code: 'notFound' });
  if (!BY_ID[providerId] || !id) throw Object.assign(new Error('Unknown provider'), { status: 400, code: 'invalid' });
  s.provider = Object.assign({}, s.provider || {}, { locked: { provider: providerId, id: String(id) } });
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

function enqueue(seriesIds) {
  if (!active && !queue.length) Object.assign(batch, { total: 0, done: 0, startedAt: Date.now() }); // a new batch
  let added = 0;
  for (const id of seriesIds) if (!queue.includes(id) && !running.has(id)) { queue.push(id); added++; }
  batch.total += added;
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
      .catch(e => { status.lastError = e.message; })
      .finally(() => {
        active--;
        batch.done++;
        status.current = status.current.filter(c => c !== cur);
        pump();
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
  applyLocal, applyLocalEverywhere, sourceView, testSearch, folderSources, createSource, updateSource, removeSource, checkSource, BY_ID,
  refreshSeries, searchForSeries, identify, clear, enqueueLibrary, afterScan, info, coverPath, forgetSeries
};
