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
const { PROVIDERS, BY_ID, matchScore } = require('./providers');

const { db } = store;
const COVERS_DIR = path.join(store.DATA_DIR, 'covers');
const MATCH_THRESHOLD = 0.85;
const FIELDS = ['summary', 'status', 'year', 'type', 'publisher', 'authors', 'tags', 'rating', 'cover', 'altTitles', 'readingDirection', 'ageRating'];
const CORE = ['summary', 'status', 'year', 'type', 'authors', 'tags', 'cover']; // stop asking providers once these are filled
const TYPES = ['manga', 'manhwa', 'manhua', 'webcomic', 'comic', 'novel', 'book', 'other'];
const COVER_MODES = ['missing', 'always', 'never'];
const MAX_COVER = 8 * 1024 * 1024;

const has = v => v != null && v !== '' && !(Array.isArray(v) && !v.length);
const keys = () => { const c = config.get(); return { comicVineApiKey: c.comicVineApiKey, googleBooksApiKey: c.googleBooksApiKey }; };

/* ---------------- per-library settings ---------------- */
// lib.metadata = { providers: [{ id, enabled }], autoFetch, cover }  (order = priority)
function librarySettings(lib) {
  const m = (lib && lib.metadata) || {};
  const saved = Array.isArray(m.providers) ? m.providers.filter(p => BY_ID[p.id]) : [];
  const seen = new Set(saved.map(p => p.id));
  // Providers added in a later version are appended with their default on/off
  const providers = saved.map(p => ({ id: p.id, enabled: p.enabled !== false }))
    .concat(PROVIDERS.filter(p => !seen.has(p.id)).map(p => ({ id: p.id, enabled: !p.defaultOff })));
  return { providers, autoFetch: m.autoFetch !== false, cover: COVER_MODES.includes(m.cover) ? m.cover : 'missing' };
}
function parseLibrarySettings(body, current) {
  const cur = current || librarySettings(null);
  const out = { providers: cur.providers, autoFetch: cur.autoFetch, cover: cur.cover };
  if (Array.isArray(body.providers)) {
    const list = [], seen = new Set();
    for (const p of body.providers) {
      if (!p || !BY_ID[p.id] || seen.has(p.id)) continue;
      seen.add(p.id);
      list.push({ id: p.id, enabled: p.enabled !== false });
    }
    out.providers = list.concat(cur.providers.filter(p => !seen.has(p.id)));
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
  return PROVIDERS.map(p => ({
    id: p.id, name: p.name, homepage: p.homepage, types: p.types, defaultOn: !p.defaultOff,
    needsKey: p.needsKey || null, optionalKey: p.optionalKey || null,
    keySet: Boolean((p.needsKey && k[p.needsKey]) || (p.optionalKey && k[p.optionalKey]))
  }));
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
async function refreshSeries(seriesId) {
  const s = db.series[seriesId];
  if (!s) throw Object.assign(new Error('Series not found'), { status: 404, code: 'notFound' });
  if (running.has(seriesId)) return s.provider || null;
  running.add(seriesId);
  try {
    const lib = db.libraries[s.libraryId];
    const settings = librarySettings(lib);
    const query = queryFor(s);
    const year = yearHint(s);
    const locked = s.provider && s.provider.locked;
    const merged = {}, sources = {}, matches = [], errors = [];
    for (const { id: pid, enabled } of settings.providers) {
      const provider = BY_ID[pid];
      const isLocked = locked && locked.provider === pid;
      if (!enabled && !isLocked) continue;
      if (provider.needsKey && !keys()[provider.needsKey]) continue;
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
      } catch (e) {
        errors.push(e.message);
      }
      if (CORE.every(f => has(merged[f]))) break;
    }
    // Cover: downloaded once and served from the data folder (only when this library uses metadata covers)
    let coverFile = s.provider && s.provider.coverFile;
    const prevCoverUrl = s.provider && s.provider.coverUrl;
    if (merged.cover && settings.cover !== 'never') {
      if (merged.cover !== prevCoverUrl || !coverFile || !fs.existsSync(path.join(COVERS_DIR, coverFile))) {
        try { coverFile = await downloadCover(s.id, merged.cover); } catch (e) { errors.push(`cover: ${e.message}`); coverFile = null; }
      }
    } else if (coverFile) {
      removeCover(s);
      coverFile = null;
    }
    const current = db.series[seriesId]; // may have been removed by a scan meanwhile
    if (!current) return null;
    current.provider = {
      fetchedAt: new Date().toISOString(), query, locked: locked || null, matches, sources, errors,
      merged: Object.fromEntries(Object.entries(merged).filter(([k]) => k !== 'cover')),
      coverUrl: merged.cover || null, coverFile: coverFile || null,
      links: matches.map(x => ({ provider: x.provider, url: x.url })).filter(x => x.url)
    };
    current.updated = new Date().toISOString();
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
const status = { done: 0, current: null, lastError: null };
let busy = false;

function enqueue(seriesIds) {
  let added = 0;
  for (const id of seriesIds) if (!queue.includes(id) && !running.has(id)) { queue.push(id); added++; }
  pump();
  return added;
}
// mode 'missing': works never looked up; 'all': every work in the library
function enqueueLibrary(libraryId, mode = 'missing') {
  const ids = Object.values(db.series)
    .filter(s => s.libraryId === libraryId && (mode === 'all' || !s.provider))
    .sort((a, b) => store.collator.compare(store.seriesMeta(a).sortTitle, store.seriesMeta(b).sortTitle))
    .map(s => s.id);
  return enqueue(ids);
}
// After a scan: look up new works if the library fetches metadata automatically
function afterScan(libraryId) {
  const lib = db.libraries[libraryId];
  if (lib && librarySettings(lib).autoFetch) enqueueLibrary(libraryId, 'missing');
}
async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const s = db.series[id];
      if (!s) continue;
      status.current = { seriesId: id, title: store.seriesMeta(s).title, startedAt: new Date().toISOString() };
      try { await refreshSeries(id); } catch (e) { status.lastError = e.message; }
    }
  } finally {
    status.current = null;
    busy = false;
  }
}
function info() {
  return { queue: queue.length, current: status.current, done: status.done, lastError: status.lastError };
}
// Remove a deleted library's or series' covers
function forgetSeries(s) { removeCover(s); const i = queue.indexOf(s.id); if (i !== -1) queue.splice(i, 1); }

module.exports = {
  TYPES, COVER_MODES, providerList, librarySettings, parseLibrarySettings,
  refreshSeries, searchForSeries, identify, clear, enqueueLibrary, afterScan, info, coverPath, forgetSeries
};
