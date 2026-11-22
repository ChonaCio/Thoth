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
  { libraries: {}, series: {}, books: {}, collections: {}, readlists: {}, settings: {} },
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
 * "Work", "Work (Colored)", "Work [Raw]", "Work (Uncensored)", "Work (Animated)" are versions of the
 * work "Work". Each version is its own series (own folder, books and progress); the browser groups them.
 */
const EDITIONS = ['base', 'colored', 'raw', 'uncensored', 'animated'];
const EDITION_WORDS = [
  [/^(colou?red|colou?r|full[ -]?colou?r)$/i, 'colored'],
  [/^raw$/i, 'raw'],
  [/^(uncensored|uncen)$/i, 'uncensored'],
  [/^(animated|motion)$/i, 'animated'],
  [/^(base|original)$/i, 'base']
];
// "Work (Colored)" → { title: 'Work', edition: 'colored' }; no recognized suffix → edition null
function splitEdition(name) {
  const m = /^(.*\S)\s*[([]\s*([^)\]]+?)\s*[)\]]\s*$/.exec(String(name || ''));
  if (m) for (const [re, edition] of EDITION_WORDS) if (re.test(m[2])) return { title: m[1], edition };
  return { title: String(name || ''), edition: null };
}

/* ---------------- metadata (scanned values + admin overrides) ---------------- */
function seriesMeta(s) {
  const m = Object.assign({}, s.meta || {}, s.overrides || {});
  // Version: admin override, else a suffix on the title or on the folder/file name, else Base
  const fromTitle = splitEdition(m.title || s.name);
  const fromName = splitEdition(s.name);
  const edition = EDITIONS.includes(m.edition) ? m.edition : (fromTitle.edition || fromName.edition || 'base');
  const title = fromTitle.title || s.name;
  return {
    title,
    edition,
    workKey: s.libraryId + '\0' + title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(),
    sortTitle: m.sortTitle || title,
    summary: m.summary || '',
    status: m.status || 'unknown', // ongoing | ended | hiatus | abandoned | unknown
    publisher: m.publisher || '',
    readingDirection: m.readingDirection || 'ltr', // ltr | rtl | vertical
    tags: Array.isArray(m.tags) ? m.tags : [],
    ageRating: m.ageRating || null
  };
}
function bookMeta(b) {
  const m = Object.assign({}, b.meta || {}, b.overrides || {});
  const number = m.number != null && m.number !== '' ? String(m.number) : String(b.index + 1);
  const parsed = parseFloat(number);
  return {
    title: m.title || b.fileName.replace(/\.[^.]+$/, ''),
    number,
    numberSort: Number.isFinite(parsed) ? parsed : b.index + 1,
    summary: m.summary || '',
    releaseDate: m.releaseDate || '',
    authors: Array.isArray(m.authors) ? m.authors : []
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
    fileName: b.fileName, format: b.format, size: b.size, pageCount: b.pageCount,
    created: b.created, modified: b.fileModified, v: Math.round(b.fileModified ? Date.parse(b.fileModified) / 1000 : 0),
    progress: progressOf(user, b.id), error: b.error || null,
    seriesTitle: db.series[b.seriesId] ? seriesMeta(db.series[b.seriesId]).title : '',
    edition: db.series[b.seriesId] ? seriesMeta(db.series[b.seriesId]).edition : 'base',
    oneshot: Boolean(db.series[b.seriesId] && db.series[b.seriesId].oneshot),
    overrides: b.overrides || {}
  };
  if (admin) v.path = b.relPath;
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
  const v = Object.assign({
    id: s.id, libraryId: s.libraryId, libraryName: (db.libraries[s.libraryId] || {}).name || '', oneshot: Boolean(s.oneshot),
    title: m.title, edition: m.edition, workKey: m.workKey, sortTitle: m.sortTitle, summary: m.summary, status: m.status, publisher: m.publisher,
    depth: String(s.relPath || '').split(/[\\/]/).filter(Boolean).length, // folder depth in the library (tie-breaker when grouping versions)
    readingDirection: m.readingDirection, tags: m.tags, ageRating: m.ageRating,
    created: s.created, updated: s.updated,
    coverBookId: cover ? cover.id : null, coverV: cover ? Math.round(Date.parse(cover.fileModified || 0) / 1000) : 0,
    coverFormat: cover ? cover.format : null,
    overrides: s.overrides || {}
  }, seriesCounts(s, user));
  if (admin) v.path = s.relPath;
  return v;
}

module.exports = {
  DATA_DIR, db, progress, saveLibrary, saveProgress, flushAll, reindex,
  booksOf: seriesId => booksBySeries.get(seriesId) || [],
  newId, stableId, collator, seriesMeta, bookMeta, compareBooks, EDITIONS, splitEdition,
  userKey, canAccessLibrary, accessibleLibraries, progressOf, setProgress, clearProgress, removeUser,
  bookView, seriesView, seriesCounts
};
