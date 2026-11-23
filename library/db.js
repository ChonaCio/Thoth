// Library database: libraries, series, books, collections, read lists and per-user reading progress.
// Stored as JSON in the data folder; writes are batched (debounced) and flushed on exit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.THOTH_DATA_DIR || path.join(__dirname, '..', 'data'));
const LIB_FILE = 'library.json';
const PROGRESS_FILE = 'progress.json';

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Can't read ${path.join(DATA_DIR, file)}: ${e.message}`);
  }
}
function saveNow(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, target);
}

const db = Object.assign(
  // metadataSources: folder sources created by admins (library/metadata/local.js)
  { libraries: {}, series: {}, books: {}, collections: {}, readlists: {}, settings: {}, metadataSources: {} },
  load(LIB_FILE, {})
);
db.settings = Object.assign({ scanIntervalMinutes: 60 }, db.settings);
const progress = load(PROGRESS_FILE, {}); // { userKey: { bookId: { page, completed, updatedAt } } }

// Batch writes: the first change schedules a save 300 ms later and later changes ride along with it.
// (Not reset on every change, so a busy server can't postpone saving forever.)
const timers = {};
function scheduleSave(which) {
  if (!timers[which]) timers[which] = setTimeout(() => flush(which), 300);
}
function flush(which) {
  clearTimeout(timers[which]);
  delete timers[which];
  if (which === 'library') saveNow(LIB_FILE, db);
  else saveNow(PROGRESS_FILE, progress);
}
function flushAll() {
  for (const w of Object.keys(timers)) { try { flush(w); } catch (e) { console.error('[library] save failed:', e.message); } }
}
process.on('exit', flushAll);

const saveLibrary = () => scheduleSave('library');
const saveProgress = () => scheduleSave('progress');

/* ---------------- indexes ---------------- */
// Defined before the first reindex() below: sorting books with equal numbers falls back to comparing names
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let booksBySeries = new Map();
function reindex() {
  booksBySeries = new Map();
  for (const b of Object.values(db.books)) {
    if (!booksBySeries.has(b.seriesId)) booksBySeries.set(b.seriesId, []);
    booksBySeries.get(b.seriesId).push(b);
  }
  for (const list of booksBySeries.values()) list.sort(compareBooks);
}
reindex();

function compareBooks(a, b) {
  const na = bookMeta(a).numberSort, nb = bookMeta(b).numberSort;
  if (na !== nb) return na - nb;
  return collator.compare(a.fileName, b.fileName);
}

const newId = () => crypto.randomBytes(8).toString('hex');
const stableId = (...parts) => crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);

/* ---------------- versions of a work ----------------
 * "One Piece", "One Piece (Colored)", "One Piece [Raw]", "One Piece (Uncensored)", "One Piece (Animated)"
 * are versions of the work "One Piece": Regular (stored as 'base'), Colored, Raw, Uncensored, Animated.
 * Each version is its own series (own folder, books and progress); the browser shows them as one work
 * with a tab per version. Grouping uses the folder/file name, so it works even when ComicInfo.xml names
 * the versions differently, and across libraries.
 */
const EDITIONS = ['base', 'colored', 'raw', 'uncensored', 'animated'];
const EDITION_WORDS = [
  [/^(colou?red|colou?r|full[ -]?colou?r)$/i, 'colored'],
  [/^raw$/i, 'raw'],
  [/^(uncensored|uncen)$/i, 'uncensored'],
  [/^(animated|motion)$/i, 'animated'],
  [/^(regular|normal|base|original)$/i, 'base']
];
// "Work (Colored)" → { title: 'Work', edition: 'colored' }; no recognized suffix → edition null
function splitEdition(name) {
  const m = /^(.*\S)\s*[([]\s*([^)\]]+?)\s*[)\]]\s*$/.exec(String(name || ''));
  if (m) for (const [re, edition] of EDITION_WORDS) if (re.test(m[2])) return { title: m[1], edition };
  return { title: String(name || ''), edition: null };
}

/* ---------------- metadata (scanned values + admin overrides) ---------------- */
// Precedence: admin edits > the files' own metadata (ComicInfo.xml) > online providers. Titles are never
// taken from providers (the library's names group versions and stay recognizable).
const BOOK_LAYOUTS = ['tiles', 'list'];
const DIRECTIONS = ['ltr', 'rtl', 'vertical'];
const SORTS = ['title', 'added', 'updated'];
const BOOK_ORDERS = ['asc', 'desc'];
// A library's defaults for its works: { bookLayout: 'tiles'|'list', readingDirection: null (automatic)|'ltr'|'rtl'|'vertical' }
function libraryDefaults(lib) {
  const d = (lib && lib.defaults) || {};
  return {
    bookLayout: BOOK_LAYOUTS.includes(d.bookLayout) ? d.bookLayout : 'tiles',
    readingDirection: DIRECTIONS.includes(d.readingDirection) ? d.readingDirection : null,
    sort: SORTS.includes(d.sort) ? d.sort : 'title', // how the library page orders works by default
    bookOrder: BOOK_ORDERS.includes(d.bookOrder) ? d.bookOrder : 'asc' // chapters on a work page: first (asc) or last (desc) first
  };
}
// (a function declaration: bookMeta uses it during the first reindex(), before this line runs)
function filled(o) { return Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))); }
function seriesMeta(s) {
  const online = filled(s.provider && s.provider.merged);
  delete online.title;
  // Folder sources (JSON files the admin keeps) beat the files' ComicInfo.xml and online sites. Their main
  // title is shown as the work's title (grouping of versions still uses the folder name).
  const local = filled(s.local && s.local.merged);
  const overrides = filled(s.overrides);
  const m = Object.assign({}, online, filled(s.meta), local, overrides);
  const defaults = libraryDefaults(db.libraries[s.libraryId]);
  // Reading mode: the work's own setting > the library's fixed default > detected (files, then online) > left to right
  const readingDirection = overrides.readingDirection || defaults.readingDirection || m.readingDirection || 'ltr';
  // Version: admin override, else a suffix on the folder/file name, else on the title, else Regular
  const fromTitle = splitEdition(m.title || s.name);
  const fromName = splitEdition(s.name);
  const edition = EDITIONS.includes(m.edition) ? m.edition : (fromName.edition || fromTitle.edition || 'base');
  const title = fromTitle.title || s.name;
  return {
    title,
    edition,
    // The work = the folder/file name without its version suffix ("One Piece (Colored)" → "one piece")
    workKey: (fromName.title || s.name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(),
    sortTitle: m.sortTitle || title,
    summary: m.summary || '',
    status: m.status || 'unknown', // ongoing | ended | hiatus | abandoned | unknown
    publisher: m.publisher || '',
    readingDirection, // ltr | rtl | vertical (continuous)
    // Detected reading mode (files/online), shown as "Automatic (…)" when editing
    detectedDirection: Object.assign({}, online, filled(s.meta), local).readingDirection || 'ltr',
    // How the work page lists chapters/books: the work's own setting > the library default
    bookLayout: BOOK_LAYOUTS.includes(overrides.bookLayout) ? overrides.bookLayout : defaults.bookLayout,
    // Chapter order on the work page: the work's own setting > the library default
    bookOrder: BOOK_ORDERS.includes(overrides.bookOrder) ? overrides.bookOrder : defaults.bookOrder,
    // Which cover to show: 'file' (first page), 'metadata' (downloaded) or null (library setting decides)
    coverChoice: ['file', 'metadata'].includes(overrides.cover) ? overrides.cover : null,
    genres: Array.isArray(m.genres) ? m.genres : [],
    tags: Array.isArray(m.tags) ? m.tags : [],
    ageRating: m.ageRating || null,
    type: m.type || null, // manga | manhwa | manhua | webcomic | comic | novel | book | other
    // Year and authors: the work's own, else from its books (ComicInfo puts them on each book)
    year: Number.isInteger(Number(m.year)) && m.year ? Number(m.year) : fromBooks(s).year,
    rating: m.rating != null && Number.isFinite(Number(m.rating)) ? Number(m.rating) : null, // 0–100
    authors: Array.isArray(m.authors) && m.authors.length ? m.authors : fromBooks(s).authors,
    altTitles: Array.isArray(m.altTitles) ? m.altTitles : [],
    links: linksOf(s).map(l => l.url)
  };
}
// A work's links (its pages on metadata sites and elsewhere): [{ url, from: 'edit'|'folder'|'online', site }]
// An administrator's list replaces the rest; otherwise the folder sources' JSON links, then the addresses of
// the online matches, without repeats. `site` = the metadata site the address belongs to (or null).
const { fromUrl } = require('./metadata/providers');
function linksOf(s) {
  const o = s.overrides || {};
  const out = [], seen = new Set();
  const add = (url, from) => {
    const k = String(url || '').replace(/\/+$/, '').toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    const x = fromUrl(url);
    out.push({ url, from, site: x ? x.provider : null });
  };
  if (Array.isArray(o.links) && o.links.length) { o.links.forEach(u => add(u, 'edit')); return out; }
  ((s.local && s.local.merged && s.local.merged.links) || []).forEach(u => add(u, 'folder'));
  ((s.provider && s.provider.links) || []).forEach(l => add(l.url, 'online'));
  return out;
}
// Where each shown value of a work comes from (for the Edit dialog): { field: { kind, name? } } with kind
// 'edit' (an administrator's), 'folder' (a folder source, name), 'files' (ComicInfo.xml), 'online' (a site
// id in name) or 'books' (taken from its books). Same precedence as seriesMeta.
const EDIT_FIELDS = ['title', 'sortTitle', 'summary', 'status', 'publisher', 'type', 'year', 'genres', 'tags', 'altTitles', 'authors', 'readingDirection', 'links'];
function fieldSources(s) {
  const has = v => v != null && v !== '' && !(Array.isArray(v) && !v.length);
  const o = s.overrides || {}, l = (s.local && s.local.merged) || {}, f = s.meta || {}, p = (s.provider && s.provider.merged) || {};
  const out = {};
  for (const k of EDIT_FIELDS) {
    if (has(o[k])) out[k] = { kind: 'edit' };
    else if (has(l[k])) out[k] = { kind: 'folder', name: ((db.metadataSources[(s.local.fields || {})[k]] || {}).name) || '' };
    else if (has(f[k])) out[k] = { kind: 'files' };
    else if (has(p[k]) && k !== 'title') out[k] = { kind: 'online', name: ((s.provider.sources || {})[k]) || '' };
    else if (k === 'links' && s.provider && (s.provider.links || []).length) out[k] = { kind: 'online', name: s.provider.links[0].provider };
    else if ((k === 'year' || k === 'authors') && has(fromBooks(s)[k])) out[k] = { kind: 'books' };
  }
  return out;
}
// The earliest release year and the authors (up to 12) of a work's books
function fromBooks(s) {
  let year = null;
  const authors = [], seen = new Set();
  for (const b of booksBySeries.get(s.id) || []) {
    const m = Object.assign({}, filled(b.meta), filled(b.local && b.local.merged), filled(b.overrides));
    const y = /^(\d{4})/.exec(m.releaseDate || '');
    if (y && (!year || Number(y[1]) < year)) year = Number(y[1]);
    for (const a of Array.isArray(m.authors) ? m.authors : []) {
      const k = a.name + '\0' + a.role;
      if (authors.length < 12 && !seen.has(k)) { seen.add(k); authors.push(a); }
    }
  }
  return { year, authors };
}
// Book precedence: admin edits > folder source JSON (e.g. 11.json for 11.cbz) > ComicInfo.xml
function bookMeta(b) {
  const m = Object.assign({}, filled(b.meta), filled(b.local && b.local.merged), filled(b.overrides));
  const number = m.number != null && m.number !== '' ? String(m.number) : String(b.index + 1);
  const parsed = parseFloat(number);
  return {
    title: m.title || b.fileName.replace(/\.[^.]+$/, ''),
    number,
    numberSort: Number.isFinite(parsed) ? parsed : b.index + 1,
    summary: m.summary || '',
    releaseDate: m.releaseDate || '',
    authors: Array.isArray(m.authors) ? m.authors : [],
    altTitles: Array.isArray(m.altTitles) ? m.altTitles : [],
    genres: Array.isArray(m.genres) ? m.genres : [],
    tags: Array.isArray(m.tags) ? m.tags : []
  };
}

/* ---------------- access & progress ---------------- */
const userKey = user => user.username.toLowerCase();
function canAccessLibrary(user, libraryId) {
  if (!db.libraries[libraryId]) return false;
  if (user.role === 'admin' || !Array.isArray(user.libraries)) return true;
  return user.libraries.includes(libraryId);
}
const accessibleLibraries = user => Object.values(db.libraries).filter(l => canAccessLibrary(user, l.id));

function progressOf(user, bookId) {
  const p = (progress[userKey(user)] || {})[bookId];
  return p || null;
}
function setProgress(user, book, page, completed) {
  const key = userKey(user);
  progress[key] = progress[key] || {};
  const count = book.pageCount || 0;
  const pg = Math.max(1, Math.min(Number(page) || 1, count || Number(page) || 1));
  const done = completed != null ? Boolean(completed) : count > 0 && pg >= count;
  progress[key][book.id] = { page: done && count ? count : pg, completed: done, updatedAt: new Date().toISOString() };
  saveProgress();
  return progress[key][book.id];
}
function clearProgress(user, bookId) {
  const p = progress[userKey(user)];
  if (p && p[bookId]) { delete p[bookId]; saveProgress(); }
}
function removeUser(username) {
  if (progress[username.toLowerCase()]) { delete progress[username.toLowerCase()]; saveProgress(); }
}

/* ---------------- views sent to the browser ---------------- */
function bookView(b, user, { admin = false } = {}) {
  const m = bookMeta(b);
  const v = {
    id: b.id, seriesId: b.seriesId, libraryId: b.libraryId,
    title: m.title, number: m.number, summary: m.summary, releaseDate: m.releaseDate, authors: m.authors,
    altTitles: m.altTitles, genres: m.genres, tags: m.tags,
    fileName: b.fileName, format: b.format, size: b.size, pageCount: b.pageCount,
    created: b.created, modified: b.fileModified, v: Math.round(b.fileModified ? Date.parse(b.fileModified) / 1000 : 0),
    progress: progressOf(user, b.id), error: b.error || null,
    seriesTitle: db.series[b.seriesId] ? seriesMeta(db.series[b.seriesId]).title : '',
    edition: db.series[b.seriesId] ? seriesMeta(db.series[b.seriesId]).edition : 'base',
    oneshot: Boolean(db.series[b.seriesId] && db.series[b.seriesId].oneshot),
    overrides: b.overrides || {},
    // The folder source whose JSON describes this book, if any
    localSource: b.local ? { id: b.local.sourceId, name: (db.metadataSources[b.local.sourceId] || {}).name || b.local.sourceId } : null
  };
  if (admin) { v.path = b.relPath; if (b.local) v.localFile = b.local.file; }
  return v;
}
function seriesCounts(s, user) {
  const books = booksBySeries.get(s.id) || [];
  let read = 0, inProgress = 0, lastRead = null;
  for (const b of books) {
    const p = progressOf(user, b.id);
    if (!p) continue;
    if (p.completed) read++; else inProgress++;
    if (!lastRead || p.updatedAt > lastRead) lastRead = p.updatedAt;
  }
  return { booksCount: books.length, booksRead: read, booksInProgress: inProgress, booksUnread: books.length - read - inProgress, lastRead };
}
function seriesView(s, user, { admin = false } = {}) {
  const m = seriesMeta(s);
  const books = booksBySeries.get(s.id) || [];
  const cover = books.find(b => b.format === 'cbz' && b.pageCount) || books[0];
  const online = coverFromMetadata(s);
  const v = Object.assign({
    id: s.id, libraryId: s.libraryId, libraryName: (db.libraries[s.libraryId] || {}).name || '', oneshot: Boolean(s.oneshot),
    title: m.title, edition: m.edition, workKey: m.workKey, sortTitle: m.sortTitle, summary: m.summary, status: m.status, publisher: m.publisher,
    depth: String(s.relPath || '').split(/[\\/]/).filter(Boolean).length, // folder depth in the library (tie-breaker when grouping versions)
    readingDirection: m.readingDirection, tags: m.tags, ageRating: m.ageRating,
    type: m.type, year: m.year, rating: m.rating, authors: m.authors, altTitles: m.altTitles, genres: m.genres,
    links: linksOf(s), // [{ url, from, site }]
    bookLayout: m.bookLayout, bookOrder: m.bookOrder, detectedDirection: m.detectedDirection, coverChoice: m.coverChoice,
    libraryDirection: libraryDefaults(db.libraries[s.libraryId]).readingDirection,
    created: s.created, updated: s.updated,
    coverBookId: cover ? cover.id : null, coverV: cover ? Math.round(Date.parse(cover.fileModified || 0) / 1000) : 0,
    coverFormat: cover ? cover.format : null,
    // Where /api/series/:id/thumbnail gets its image: 'metadata' (downloaded cover), 'file' (first page) or null
    coverSource: online ? 'metadata' : cover && cover.format === 'cbz' && cover.pageCount ? 'file' : null,
    // Online metadata: where it came from (the cover image itself is served by /api/series/:id/thumbnail)
    metadata: s.provider ? {
      fetchedAt: s.provider.fetchedAt, checkedAt: s.provider.checkedAt || s.provider.fetchedAt, links: s.provider.links || [], sources: s.provider.sources || {},
      matched: (s.provider.matches || []).length > 0,
      // Matches chosen by hand (Identify), one per site: [{ provider, id }]
      locked: s.provider.locked ? [].concat(s.provider.locked) : null,
      cover: Boolean(s.provider.coverFile), coverProvider: s.provider.coverFile ? s.provider.coverProvider || null : null, errors: admin ? s.provider.errors || [] : undefined
    } : null,
    // Folder sources that gave this work data ({ id, name } each), and whether one gave its cover
    // Logically deleted (hidden from everyone but administrators): { at, by }
    hidden: s.hidden ? { at: s.hidden.at, by: admin ? s.hidden.by : undefined } : null,
    localSources: s.local ? (s.local.sourceIds || []).map(id => ({ id, name: (db.metadataSources[id] || {}).name || id })) : [],
    localCover: Boolean(s.local && s.local.coverPath),
    customCover: s.customCover ? { from: s.customCover.from, at: s.customCover.at } : null,
    localFile: admin && s.local ? s.local.file || null : undefined,
    overrides: s.overrides || {}
  }, seriesCounts(s, user));
  if (admin) { v.path = s.relPath; v.fieldSources = fieldSources(s); }
  if (online) v.coverV = metadataCover(s).version;
  return v;
}
// Use the downloaded cover? Per library: 'always', 'missing' (only when the files have no cover page) or 'never'
// The cover image a work's metadata offers: a folder source's image (e.g. "One Piece.jpg" next to its
// JSON) first, else the one downloaded from an online site. { file (absolute path), version } or null.
function metadataCover(s) {
  // A cover chosen or uploaded in the work's Edit dialog always wins
  if (s.customCover && s.customCover.file) return { file: path.join(DATA_DIR, 'covers', s.customCover.file), version: Math.round(Date.parse(s.customCover.at || 0) / 1000), source: 'custom' };
  if (s.local && s.local.coverPath) return { file: s.local.coverPath, version: s.local.coverVersion || 0, source: 'local' };
  if (s.provider && s.provider.coverFile) return { file: path.join(DATA_DIR, 'covers', s.provider.coverFile), version: Math.round(Date.parse(s.provider.fetchedAt || 0) / 1000), source: 'online' };
  return null;
}
function coverFromMetadata(s) {
  if (!metadataCover(s)) return false;
  if (s.customCover && s.customCover.file) return true;
  const choice = (s.overrides || {}).cover; // the work's own choice wins
  if (choice === 'metadata') return true;
  if (choice === 'file') return !(booksBySeries.get(s.id) || []).some(b => b.format === 'cbz' && b.pageCount);
  const mode = ((db.libraries[s.libraryId] || {}).metadata || {}).cover || 'missing';
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return !(booksBySeries.get(s.id) || []).some(b => b.format === 'cbz' && b.pageCount);
}

module.exports = {
  DATA_DIR, db, progress, saveLibrary, saveProgress, flushAll, reindex,
  booksOf: seriesId => booksBySeries.get(seriesId) || [],
  newId, stableId, collator, seriesMeta, bookMeta, compareBooks, EDITIONS, splitEdition,
  userKey, canAccessLibrary, accessibleLibraries, progressOf, setProgress, clearProgress, removeUser,
  bookView, seriesView, seriesCounts, coverFromMetadata, metadataCover, libraryDefaults, BOOK_LAYOUTS, DIRECTIONS, SORTS, BOOK_ORDERS
};
