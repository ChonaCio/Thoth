// HTTP API for libraries, series, books, pages, reading progress, collections, read lists and search.
// Every route requires a signed-in user and only returns content from libraries that user may access.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./db');
const scanner = require('./scanner');
const metadata = require('./metadata');
const rename = require('./rename');
const terms = require('./metadata/terms');
const media = require('./media');
const { cacheService } = require('./cache/client');
const catalog = require('./catalog');

const { db } = store;
const STATUSES = ['ongoing', 'ended', 'hiatus', 'abandoned', 'unknown'];
const DIRECTIONS = ['ltr', 'rtl', 'vertical'];

function httpError(status, code, message) {
  return Object.assign(new Error(message || code), { status, code });
}
const isAdmin = u => u.role === 'admin';
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const searchable = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Hidden (logically deleted) works and their books exist only for administrators (who can restore them)
const shown = s => Boolean(s) && !s.hidden;
const bookShown = b => Boolean(b) && shown(db.series[b.seriesId]);

function getSeries(user, id) {
  const s = db.series[id];
  if (!s || !store.canAccessLibrary(user, s.libraryId) || (s.hidden && !isAdmin(user))) throw httpError(404, 'notFound');
  return s;
}
function getBook(user, id) {
  const b = db.books[id];
  if (!b || !store.canAccessLibrary(user, b.libraryId) || (!bookShown(b) && !isAdmin(user))) throw httpError(404, 'notFound');
  return b;
}
const bookFile = b => path.join(db.libraries[b.libraryId].root, b.relPath);

/* ---------------- libraries ---------------- */
// Counts of every library in one pass, once per data generation
let libStatsMemo = { gen: -1, map: new Map() };
function libStats(id) {
  const gen = store.generation();
  if (libStatsMemo.gen !== gen) {
    const map = new Map();
    const get = k => { let x = map.get(k); if (!x) map.set(k, (x = { series: 0, books: 0, matched: 0, hidden: 0 })); return x; };
    for (const s of Object.values(db.series)) {
      const x = get(s.libraryId);
      if (s.hidden) x.hidden++; else x.series++;
      if (s.provider && (s.provider.matches || []).length) x.matched++;
    }
    for (const b of Object.values(db.books)) if (bookShown(b)) get(b.libraryId).books++;
    libStatsMemo = { gen, map };
  }
  return libStatsMemo.map.get(id) || { series: 0, books: 0, matched: 0, hidden: 0 };
}
function libraryView(lib, user) {
  const stats = libStats(lib.id);
  const series = stats.series, books = stats.books;
  const v = { id: lib.id, name: lib.name, seriesCount: series, booksCount: books, scanning: scanner.scanning.has(lib.id),
    defaultSort: store.libraryDefaults(lib).sort }; // everyone: the library page opens with this order
  if (isAdmin(user)) {
    const progress = scanner.scanning.get(lib.id);
    Object.assign(v, {
      root: lib.root, created: lib.created, lastScan: lib.lastScan || null, scanError: lib.scanError || null, oneshots: scanner.oneshotSettings(lib),
      metadata: metadata.librarySettings(lib),
      metadataCount: stats.matched,
      scanProgress: progress ? Object.assign({}, progress, { serviceStopped: progress.queued && scanner.serviceState() !== 'running', progress: scanner.progressOf(progress) }) : null,
      defaults: store.libraryDefaults(lib),
      hiddenCount: stats.hidden
    });
  }
  return v;
}

// { oneshotsEnabled, oneshotsFolder } from a request → { enabled, folder }, or undefined if not sent
// { oneshotsFolder } → { folder } (an extra folder whose files are one-shots, besides the library folder).
// The old { oneshotsEnabled: false } still means "no extra folder". undefined if not sent.
function parseOneshots(body, current) {
  if (!('oneshotsEnabled' in body) && !('oneshotsFolder' in body)) return undefined;
  let folder = 'oneshotsFolder' in body ? scanner.normalizeOneshotFolder(body.oneshotsFolder) : (current || {}).folder || '';
  if (folder === null) throw httpError(400, 'oneshotsFolderInvalid');
  if (body.oneshotsEnabled === false) folder = '';
  return { folder };
}
// { bookLayout: 'tiles'|'list', readingDirection: ''|'ltr'|'rtl'|'vertical' } → the library's work defaults
function parseDefaults(body, current) {
  const d = Object.assign({}, current || {});
  if (!body || typeof body !== 'object') return d;
  if ('bookLayout' in body) {
    if (!store.BOOK_LAYOUTS.includes(body.bookLayout)) throw httpError(400, 'invalid');
    d.bookLayout = body.bookLayout;
  }
  if ('bookOrder' in body) {
    if (!store.BOOK_ORDERS.includes(body.bookOrder)) throw httpError(400, 'invalid');
    d.bookOrder = body.bookOrder;
  }
  if ('sort' in body) {
    if (!store.SORTS.includes(body.sort)) throw httpError(400, 'invalid');
    d.sort = body.sort;
  }
  if ('readingDirection' in body) {
    if (body.readingDirection && !store.DIRECTIONS.includes(body.readingDirection)) throw httpError(400, 'invalid');
    d.readingDirection = body.readingDirection || null; // null = automatic (from the files and metadata)
  }
  return d;
}
async function validateRoot(root) {
  const abs = path.resolve(clean(root, 4096));
  if (!clean(root, 4096)) throw httpError(400, 'folderRequired');
  let st;
  try { st = await fs.promises.stat(abs); } catch { throw httpError(400, 'folderNotFound'); }
  if (!st.isDirectory()) throw httpError(400, 'folderNotFound');
  try { await fs.promises.access(abs, fs.constants.R_OK); } catch { throw httpError(400, 'folderNoAccess'); }
  const dataDir = path.resolve(store.DATA_DIR);
  if (abs === dataDir || abs.startsWith(dataDir + path.sep)) throw httpError(400, 'folderNotAllowed');
  return abs;
}

/* ---------------- folder browser (admins, for picking a library folder) ---------------- */
async function listFolders(p) {
  if (!p) {
    if (process.platform === 'win32') {
      const drives = [];
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        try { await fs.promises.access(`${l}:\\`); drives.push({ name: `${l}:`, path: `${l}:\\` }); } catch { /* no drive */ }
      }
      return { path: '', parent: null, dirs: drives };
    }
    p = '/';
  }
  const abs = path.resolve(p);
  let entries;
  try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (e) {
    throw httpError(400, e.code === 'EACCES' || e.code === 'EPERM' ? 'folderNoAccess' : 'folderNotFound');
  }
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, path: path.join(abs, e.name) }))
    .sort((a, b) => store.collator.compare(a.name, b.name));
  const parent = path.dirname(abs) !== abs ? path.dirname(abs) : (process.platform === 'win32' ? '' : null);
  const books = entries.filter(e => e.isFile() && scanner.BOOK_EXT[path.extname(e.name).toLowerCase()]).length;
  return { path: abs, parent, dirs, books, home: os.homedir() };
}

/* ---------------- series filtering ---------------- */
function readState(c) {
  if (!c.booksCount) return 'unread';
  if (c.booksRead === c.booksCount) return 'read';
  if (c.booksRead || c.booksInProgress) return 'inProgress';
  return 'unread';
}
/* ---------------- works: versions of the same title grouped together ----------------
 * Takes series views and returns one entry per work: the main version (Base first, then Colored, Raw,
 * Uncensored, Animated) with `editions` listing every version. Dates come from the newest version.
 */
const editionRank = e => { const i = store.EDITIONS.indexOf(e); return i === -1 ? 99 : i; };
function sortEditions(list) {
  // Same version twice: the folder nearest the library root wins, then the older one
  return list.sort((a, b) => editionRank(a.edition) - editionRank(b.edition) || a.depth - b.depth || a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}
// Only different versions are grouped: the first series of each version joins the work; another series
// with an already-taken version (e.g. two unrelated "Base" folders that happen to share a title) stays separate.
function splitByEdition(list) {
  sortEditions(list);
  const main = [], separate = [], taken = new Set();
  for (const v of list) {
    if (taken.has(v.edition)) separate.push([v]);
    else { taken.add(v.edition); main.push(v); }
  }
  return [main, ...separate];
}
function editionSummary(v) {
  return { id: v.id, edition: v.edition, title: v.title, libraryId: v.libraryId, libraryName: v.libraryName,
    booksCount: v.booksCount, booksRead: v.booksRead, booksInProgress: v.booksInProgress, oneshot: v.oneshot, coverBookId: v.coverBookId };
}
// Every version of the work a series belongs to, in any library this user may see
function editionsOf(s, user) {
  const key = store.seriesMeta(s).workKey;
  const groups = splitByEdition(Object.values(db.series)
    .filter(x => store.canAccessLibrary(user, x.libraryId) && (shown(x) || x.id === s.id) && store.seriesMeta(x).workKey === key)
    .map(x => store.seriesView(x, user)));
  return (groups.find(g => g.some(v => v.id === s.id)) || []).map(editionSummary);
}

// Every version (series) of the same work, hidden ones included, in libraries the user can see
function versionsOf(s, user) {
  const key = store.seriesMeta(s).workKey;
  return Object.values(db.series).filter(x => store.canAccessLibrary(user, x.libraryId) && store.seriesMeta(x).workKey === key);
}
// Physically deletes the book files of these works. A work whose files are all gone is removed (and its
// folder too, if nothing else is left in it). Files that can't be deleted (read-only library folder, no
// permission) are reported and their books kept.
async function deleteWorkFiles(targets) {
  const failed = [];
  let deletedBooks = 0, deletedWorks = 0;
  for (const s of targets) {
    const lib = db.libraries[s.libraryId];
    if (!lib) continue;
    const root = path.resolve(lib.root);
    for (const b of store.booksOf(s.id).slice()) {
      const abs = path.resolve(root, b.relPath);
      if (!abs.startsWith(root + path.sep)) { failed.push({ file: b.relPath, error: 'outside the library folder' }); continue; }
      try { await fs.promises.unlink(abs); } catch (e) {
        if (e.code !== 'ENOENT') { failed.push({ file: b.relPath, error: e.code === 'EROFS' ? 'read-only' : e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission' : e.code || e.message }); continue; }
      }
      delete db.books[b.id];
      deletedBooks++;
    }
    if (!Object.values(db.books).some(b => b.seriesId === s.id)) {
      if (!s.oneshot && s.relPath) {
        const dir = path.resolve(root, s.relPath);
        if (dir.startsWith(root + path.sep)) await fs.promises.rmdir(dir).catch(() => {}); // only if now empty
      }
      metadata.forgetSeries(s);
      delete db.series[s.id];
      deletedWorks++;
    }
  }
  for (const c of Object.values(db.collections)) c.seriesIds = c.seriesIds.filter(id => db.series[id]);
  for (const r of Object.values(db.readlists)) r.bookIds = r.bookIds.filter(id => db.books[id]);
  store.reindex();
  store.saveLibrary();
  return { deletedBooks, deletedWorks, failed };
}

/* ---------------- the works index (for tens of thousands of works) ----------------
 * Grouping versions into works, and the keys filters and search use, are worked out once per data
 * generation (store.generation(): any save or reindex) and set of visible libraries, then reused by every
 * request. A request filters and sorts these light entries and builds full work objects (with the user's
 * reading counts) only for the page it returns. Entries hold the memoized base views: read, never change. */
const workIndexMemo = new Map();
function workIndex(user, library, { deleted = false } = {}) {
  const libs = store.accessibleLibraries(user).map(l => l.id).sort();
  const key = libs.join(',') + '|' + (library || '') + '|' + (deleted ? 1 : 0);
  const gen = store.generation();
  const c = workIndexMemo.get(key);
  if (c && c.gen === gen) return c.entries;
  const libSet = new Set(libs);
  const groups = new Map();
  for (const s of Object.values(db.series)) {
    if (!libSet.has(s.libraryId) || (deleted ? !s.hidden : s.hidden)) continue;
    const v = store.seriesBaseView(s);
    let g = groups.get(v.workKey);
    if (!g) groups.set(v.workKey, (g = []));
    g.push(v);
  }
  const entries = [];
  for (const versions of groups.values()) {
    for (const list of splitByEdition(versions.slice())) {
      // With a library: the works that have a version in it, shown with that version
      if (library && !list.some(v => v.libraryId === library)) continue;
      const v = (library && list.find(v => v.libraryId === library)) || list[0];
      let created = v.created, updated = v.updated;
      for (const x of list) { if (x.created > created) created = x.created; if (x.updated > updated) updated = x.updated; }
      entries.push({ v, list, workTitle: list[0].title, created, updated, _text: null, _genres: null, _tags: null, _people: null });
    }
  }
  if (workIndexMemo.size > 64) workIndexMemo.clear();
  workIndexMemo.set(key, { gen, entries, facets: new Map() });
  return entries;
}
const textOf = e => e._text || (e._text = searchable([e.v.title, e.v.publisher].concat(e.v.tags, e.v.genres, e.v.altTitles, e.v.authors.map(a => a.name)).join('\n')));
const termKey = v => terms.keyOf(terms.canonical(v));
const genreKeys = e => e._genres || (e._genres = new Set(e.v.genres.map(termKey)));
const tagKeys = e => e._tags || (e._tags = new Set(e.v.tags.map(termKey)));
const peopleKeys = e => e._people || (e._people = new Set(e.v.authors.map(a => searchable(a.name))));
// The full work object for the browser (one page of results at a time)
function workObject(e, user) {
  const work = store.seriesView(db.series[e.v.id], user);
  work.workTitle = e.workTitle; // the Regular (or first) version's title names the work
  work.editions = e.list.map(v => editionSummary(Object.assign({}, v, store.seriesCounts(db.series[v.id], user))));
  work.created = e.created;
  work.updated = e.updated;
  return work;
}
// Every work the user can see as full objects (small lists only: collections, tests)
function worksFor(user, library, opts) { return workIndex(user, library, opts).map(e => workObject(e, user)); }
// Online metadata state of a work: 'matched', 'unmatched' (looked up, nothing found) or 'none' (never looked up)
const metadataState = s => ((s.localSources && s.localSources.length) || (s.metadata && s.metadata.matched) ? 'matched' : !s.metadata ? 'none' : 'unmatched');
const same = (a, b) => searchable(a) === searchable(b);
const SORTERS = {
  added: (a, b) => b.created.localeCompare(a.created),
  updated: (a, b) => b.updated.localeCompare(a.updated),
  // Score: best first; works without one at the end (by title)
  rating: (a, b) => (b.v.rating != null) - (a.v.rating != null) || (b.v.rating || 0) - (a.v.rating || 0) || store.collator.compare(a.v.sortTitle, b.v.sortTitle),
  title: (a, b) => store.collator.compare(a.v.sortTitle, b.v.sortTitle)
};

function listSeries(user, q) {
  let items = workIndex(user, q.get('library'), { deleted: isAdmin(user) && q.get('deleted') === '1' });
  const term = searchable(q.get('q'));
  if (term) items = items.filter(e => textOf(e).includes(term));
  const read = q.get('read');
  if (read) items = items.filter(e => readState(store.seriesCounts(db.series[e.v.id], user)) === read);
  // Advanced search: include/exclude any number of values (repeated parameters; x… = exclude).
  //   genre, tag, person (lists on a work): ALL included values present, NONE of the excluded
  //   type, status, metadata (one value per work): ANY of the included values, none of the excluded
  // (genres/tags by their standard name: "Science Fiction" finds "Sci-Fi"; people by name, any role)
  const all = k => q.getAll(k).map(v => String(v).trim()).filter(Boolean).slice(0, 50);
  const multi = (inc, exc, keysOf, norm) => {
    if (!inc.length && !exc.length) return;
    const i = inc.map(norm), x = exc.map(norm);
    items = items.filter(e => { const k = keysOf(e); return i.every(v => k.has(v)) && !x.some(v => k.has(v)); });
  };
  multi(all('genre'), all('xgenre'), genreKeys, termKey);
  multi(all('tag'), all('xtag'), tagKeys, termKey);
  multi(all('person'), all('xperson'), peopleKeys, searchable);
  const single = (inc, exc, valueOf) => { if (inc.length || exc.length) items = items.filter(e => (!inc.length || inc.includes(valueOf(e.v))) && !exc.includes(valueOf(e.v))); };
  single(all('type'), all('xtype'), s => s.type || 'unknown');
  single(all('status'), all('xstatus'), s => s.status);
  single(all('metadata'), all('xmetadata'), metadataState);
  const yearFrom = Number(q.get('yearFrom')) || 0, yearTo = Number(q.get('yearTo')) || 0;
  if (yearFrom || yearTo) items = items.filter(e => e.v.year && (!yearFrom || e.v.year >= yearFrom) && (!yearTo || e.v.year <= yearTo));
  const author = searchable(q.get('author'));
  if (author) items = items.filter(e => e.v.authors.some(a => searchable(a.name).includes(author)));
  items = items.slice().sort(SORTERS[q.get('sort')] || SORTERS.title);
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 60));
  return { total: items.length, offset, items: items.slice(offset, offset + limit).map(e => workObject(e, user)) };
}
// The values the library filters can offer, with how many works have each (memoized with the index)
function seriesFacets(user, library) {
  const items = workIndex(user, library);
  const memo = workIndexMemo.get(store.accessibleLibraries(user).map(l => l.id).sort().join(',') + '|' + (library || '') + '|0');
  if (memo && memo.facets.has('all')) return memo.facets.get('all');
  const count = (list, key) => {
    const m = new Map();
    for (const v of list) {
      const k = searchable(v);
      if (!k) continue;
      if (!m.has(k)) m.set(k, { name: v, count: 0 });
      m.get(k).count++;
    }
    return [...m.values()].sort((a, b) => store.collator.compare(a.name, b.name)).slice(0, key === 'tags' ? 300 : 100);
  };
  const tally = values => { const m = {}; for (const v of values) m[v] = (m[v] || 0) + 1; return m; };
  const people = new Map();
  for (const e of items) {
    const seen = new Set();
    for (const a of e.v.authors || []) {
      const k = searchable(a.name);
      if (!k) continue;
      if (!people.has(k)) people.set(k, { name: a.name, count: 0, roles: [] });
      const p = people.get(k);
      if (!seen.has(k)) { seen.add(k); p.count++; }
      if (a.role && !p.roles.includes(a.role)) p.roles.push(a.role);
    }
  }
  const out = {
    genres: count(items.flatMap(e => e.v.genres), 'genres'),
    tags: count(items.flatMap(e => e.v.tags), 'tags'),
    // People with their roles: [{ name, count, roles: ['writer', …] }]
    people: [...people.values()].sort((a, b) => store.collator.compare(a.name, b.name)).slice(0, 500),
    types: tally(items.map(e => e.v.type || 'unknown')),
    statuses: tally(items.map(e => e.v.status)),
    metadata: tally(items.map(e => metadataState(e.v)))
  };
  if (memo) memo.facets.set('all', out);
  return out;
}

/* ---------------- home ---------------- */
// Recently added books per set of visible libraries (memoized like the works index)
const recentBooksMemo = new Map();
function recentBooks(libs) {
  const key = [...libs].sort().join(',');
  const gen = store.generation();
  const c = recentBooksMemo.get(key);
  if (c && c.gen === gen) return c.books;
  const top = [];
  for (const b of Object.values(db.books)) {
    if (!libs.has(b.libraryId) || !bookShown(b)) continue;
    top.push(b);
    if (top.length > 200) { top.sort((a, x) => x.created.localeCompare(a.created) || store.compareBooks(a, x)); top.length = 24; }
  }
  top.sort((a, x) => x.created.localeCompare(a.created) || store.compareBooks(a, x));
  const books = top.slice(0, 24);
  if (recentBooksMemo.size > 64) recentBooksMemo.clear();
  recentBooksMemo.set(key, { gen, books });
  return books;
}
function home(user) {
  const libs = new Set(store.accessibleLibraries(user).map(l => l.id));
  // Only what this user has progress on is looked at (not every book of the server)
  const mine = Object.entries(store.progress[store.userKey(user)] || {})
    .map(([id, p]) => ({ b: db.books[id], p }))
    .filter(x => x.b && libs.has(x.b.libraryId) && bookShown(x.b));
  const keepReading = mine.filter(x => !x.p.completed)
    .sort((a, b) => b.p.updatedAt.localeCompare(a.p.updatedAt))
    .slice(0, 24).map(x => store.bookView(x.b, user));
  const onDeck = [];
  for (const id of new Set(mine.map(x => x.b.seriesId))) {
    const s = db.series[id];
    if (!s) continue;
    const c = store.seriesCounts(s, user);
    if (!c.booksRead || c.booksInProgress || c.booksRead === c.booksCount) continue;
    const next = store.booksOf(s.id).find(b => !store.progressOf(user, b.id));
    if (next) onDeck.push({ book: next, at: c.lastRead });
  }
  onDeck.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    keepReading,
    onDeck: onDeck.slice(0, 24).map(x => store.bookView(x.book, user)),
    recentSeries: workIndex(user, null).slice().sort(SORTERS.added).slice(0, 24).map(e => workObject(e, user)),
    recentBooks: recentBooks(libs).map(b => store.bookView(b, user)),
    libraries: libs.size
  };
}

/* ---------------- collections & read lists ---------------- */
function collectionView(c, user, full) {
  const series = c.seriesIds.map(id => db.series[id]).filter(s => shown(s) && store.canAccessLibrary(user, s.libraryId));
  const v = { id: c.id, name: c.name, seriesCount: series.length, created: c.created, updated: c.updated,
    coverSeries: series.slice(0, 4).map(s => store.seriesView(s, user)).map(s => ({ id: s.id, coverBookId: s.coverBookId, coverV: s.coverV, coverFormat: s.coverFormat, coverSource: s.coverSource })) };
  if (full) v.series = series.map(s => store.seriesView(s, user));
  return v;
}
function readlistView(r, user, full) {
  const books = r.bookIds.map(id => db.books[id]).filter(b => bookShown(b) && store.canAccessLibrary(user, b.libraryId));
  const v = { id: r.id, name: r.name, summary: r.summary || '', booksCount: books.length, created: r.created, updated: r.updated,
    booksRead: books.filter(b => (store.progressOf(user, b.id) || {}).completed).length,
    coverBooks: books.slice(0, 4).map(b => ({ id: b.id, format: b.format, v: Math.round(Date.parse(b.fileModified || 0) / 1000) })) };
  if (full) v.books = books.map(b => store.bookView(b, user));
  return v;
}
function visibleCollections(user) {
  return Object.values(db.collections).map(c => collectionView(c, user)).filter(c => c.seriesCount || isAdmin(user))
    .sort((a, b) => store.collator.compare(a.name, b.name));
}
function visibleReadlists(user) {
  return Object.values(db.readlists).map(r => readlistView(r, user)).filter(r => r.booksCount || isAdmin(user))
    .sort((a, b) => store.collator.compare(a.name, b.name));
}
function ids(list, table) {
  return Array.isArray(list) ? [...new Set(list.map(String))].filter(id => table[id]) : null;
}

/* ---------------- sending files ---------------- */
async function sendImage(req, res, buf, type, etag) {
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=604800', ETag: etag });
  res.end(buf);
}
// Pages and covers come from the media service (key-value cache + its own process, see media.js)
async function sendPage(req, res, book, n) {
  if (book.format !== 'cbz') throw httpError(400, 'notAnImageBook');
  if (!(n >= 1)) throw httpError(404, 'pageNotFound');
  const img = await media.page(book, bookFile(book), n, { pageCount: book.pageCount });
  return sendImage(req, res, img.buf, img.type, img.etag);
}
async function sendBookCover(req, res, book) {
  const img = await media.bookCover(book, bookFile(book));
  return sendImage(req, res, img.buf, img.type, img.etag);
}
async function sendFile(req, res, book, download) {
  const file = bookFile(book);
  const st = await fs.promises.stat(file).catch(() => { throw httpError(404, 'fileMissing'); });
  const type = book.format === 'pdf' ? 'application/pdf' : 'application/vnd.comicbook+zip';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(book.fileName)}`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, status = 200;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

/* ---------------- router ---------------- */
// ctx: { method, pathname, query, body, req, res, user, send(status, body) } → true when handled
/* ---------------- works responses: the Works cache process ----------------
 * Work lists, filters, work pages and Home are answered from the Works cache (cache/works.js, a process of its
 * own) when nothing changed since they were built: the key is the user (and what they may see) + the request;
 * an answer counts only for the data version it was built for (the data generation — any save/reindex — and
 * the reading-progress version). If that process can't answer, the request is simply built here. */
const RESPONSE_ROUTES = /^\/api\/(series|series\/facets|series\/[\w-]+|home)$/;
const worksCache = cacheService('works', { label: 'Works', idleMs: 30 * 60 * 1000 });
function responseVersion() { return store.generation() + ':' + store.progressVersion(); }
function responseKey(user, p, q) {
  const sorted = [...q.entries()].sort((a, b) => (a[0] + '=' + a[1]).localeCompare(b[0] + '=' + b[1]));
  return [user.username.toLowerCase(), user.role, Array.isArray(user.libraries) ? user.libraries.join(',') : '*', p, new URLSearchParams(sorted).toString()].join('\0');
}
function cacheInfo() { const i = worksCache.info(); return Object.assign({ pid: i.pid }, i.stats || {}); }

/* ---------------- the Search cache process ----------------
 * An index of every work (titles, genres, tags, people, types, libraries) lives in the Search cache process
 * (cache/search.js). It's sent again when the data changed (checked on each search: its loaded generation
 * against the current one), and answers only count works in the libraries the asker may see. */
const searchCache = cacheService('search', { label: 'Search', idleMs: 30 * 60 * 1000 });
const SEARCH_USER = { username: '\0search', role: 'admin' }; // sees every library (answers are filtered per user)
let searchLoading = null;
async function ensureSearch() {
  const gen = store.generation();
  const st = await searchCache.call('status');
  if (st.gen === gen) return;
  if (!searchLoading) {
    const docs = workIndex(SEARCH_USER, null).map(e => ({
      id: e.v.id, libs: [...new Set(e.list.map(v => v.libraryId))], title: e.workTitle || e.v.title, sort: e.v.sortTitle, text: textOf(e),
      genres: e.v.genres, tags: e.v.tags, people: [...new Set(e.v.authors.map(a => a.name))], type: e.v.type || 'unknown', status: e.v.status
    }));
    searchLoading = searchCache.call('load', { gen, docs }).finally(() => { searchLoading = null; });
  }
  await searchLoading;
}
async function searchWorks(text, user, limit) {
  await ensureSearch();
  return searchCache.call('query', { q: text, libs: store.accessibleLibraries(user).map(l => l.id), limit });
}
const sendCachedJson = (res, body, hit) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Thoth-Cache': hit ? 'hit' : 'miss' });
  res.end(body);
  return true;
};

async function handle(ctx) {
  const { method, pathname: p, query: q, body, req, res, user } = ctx;
  let { send } = ctx;
  if (method === 'GET' && RESPONSE_ROUTES.test(p)) {
    const key = responseKey(user, p, q);
    const ver = responseVersion();
    const hit = await worksCache.call('get', { key, ver }).catch(() => null);
    if (hit) return sendCachedJson(res, hit, true);
    send = (status, data) => {
      if (status !== 200) return ctx.send(status, data);
      const json = JSON.stringify(data);
      if (ver === responseVersion()) worksCache.call('put', { key, ver, body: json }).catch(() => {}); // (not if something changed while it was built)
      return sendCachedJson(res, json, false);
    };
  }
  const admin = isAdmin(user);
  const requireAdmin = () => { if (!admin) throw httpError(403, 'forbidden'); };
  let m;

  // ---- libraries ----
  if (p === '/api/libraries' && method === 'GET') {
    return send(200, { libraries: store.accessibleLibraries(user).sort((a, b) => store.collator.compare(a.name, b.name)).map(l => libraryView(l, user)) });
  }
  if (p === '/api/libraries' && method === 'POST') {
    requireAdmin();
    const name = clean(body.name, 80);
    if (!name) throw httpError(400, 'nameRequired');
    const root = await validateRoot(body.root);
    if (Object.values(db.libraries).some(l => l.root === root)) throw httpError(409, 'folderInUse');
    const lib = { id: store.newId(), name, root, created: new Date().toISOString(), oneshots: parseOneshots(body) || { folder: '' },
      metadata: metadata.parseLibrarySettings(body.metadata || {}), defaults: parseDefaults(body.defaults) };
    db.libraries[lib.id] = lib;
    store.saveLibrary();
    scanner.scanLibrary(lib.id, { mode: 'full', reason: 'new' }).catch(() => {}); // first scan: read everything
    return send(201, { library: libraryView(lib, user) });
  }
  if ((m = /^\/api\/libraries\/([\w-]+)$/.exec(p)) && (method === 'PATCH' || method === 'DELETE')) {
    requireAdmin();
    const lib = db.libraries[m[1]];
    if (!lib) throw httpError(404, 'notFound');
    if (method === 'DELETE') {
      for (const b of Object.values(db.books)) if (b.libraryId === lib.id) delete db.books[b.id];
      for (const s of Object.values(db.series)) if (s.libraryId === lib.id) { metadata.forgetSeries(s); delete db.series[s.id]; }
      for (const c of Object.values(db.collections)) c.seriesIds = c.seriesIds.filter(id => db.series[id]);
      for (const r of Object.values(db.readlists)) r.bookIds = r.bookIds.filter(id => db.books[id]);
      delete db.libraries[lib.id];
      scanner.forgetIndex(lib.id);
      store.reindex();
      store.saveLibrary();
      return send(200, { ok: true });
    }
    if ('name' in body) { const name = clean(body.name, 80); if (!name) throw httpError(400, 'nameRequired'); lib.name = name; }
    let rescan = false;
    if ('root' in body) {
      const root = await validateRoot(body.root);
      if (root !== lib.root) {
        if (Object.values(db.libraries).some(l => l.id !== lib.id && l.root === root)) throw httpError(409, 'folderInUse');
        lib.root = root; rescan = 'full'; scanner.forgetIndex(lib.id); // another folder: start over
      }
    }
    const oneshots = parseOneshots(body, scanner.oneshotSettings(lib));
    if (oneshots) {
      const cur = scanner.oneshotSettings(lib);
      if (oneshots.folder !== cur.folder) rescan = rescan || 'changes';
      lib.oneshots = oneshots;
    }
    if (body.metadata && typeof body.metadata === 'object') {
      lib.metadata = metadata.parseLibrarySettings(body.metadata, metadata.librarySettings(lib));
      metadata.applyLocal(lib.id).catch(() => {}); // folder sources turned on/off or reordered
    }
    if (body.defaults && typeof body.defaults === 'object') lib.defaults = parseDefaults(body.defaults, lib.defaults);
    store.saveLibrary();
    if (rescan) scanner.scanLibrary(lib.id, { mode: rescan, reason: 'settings' }).catch(() => {});
    return send(200, { library: libraryView(lib, user) });
  }
  if ((m = /^\/api\/libraries\/([\w-]+)\/scan$/.exec(p)) && method === 'POST') {
    requireAdmin();
    if (!db.libraries[m[1]]) throw httpError(404, 'notFound');
    // { full: true } re-reads every file; otherwise every file's size/date is checked and only new and changed files are read
    scanner.scanLibrary(m[1], { mode: body.full === true ? 'full' : scanner.MODES.includes(body.mode) ? body.mode : 'changes', reason: 'manual' }).catch(() => {});
    return send(202, { library: libraryView(db.libraries[m[1]], user), serviceRunning: scanner.serviceState() === 'running' });
  }
  if (p === '/api/library-settings') {
    requireAdmin();
    if (method === 'PATCH') {
      const n = Number(body.scanIntervalMinutes);
      if (!Number.isFinite(n) || n < 0 || n > 10080) throw httpError(400, 'invalid');
      db.settings.scanIntervalMinutes = Math.round(n);
      store.saveLibrary();
      scanner.startSchedule();
    }
    return send(200, db.settings);
  }
  if (p === '/api/fs' && method === 'GET') {
    requireAdmin();
    return send(200, await listFolders(q.get('path') || ''));
  }

  // ---- series ----
  if (p === '/api/series' && method === 'GET') return send(200, listSeries(user, q));
  if (p === '/api/series/facets' && method === 'GET') return send(200, seriesFacets(user, q.get('library') || null));
  if ((m = /^\/api\/series\/([\w-]+)$/.exec(p))) {
    const s = getSeries(user, m[1]);
    if (method === 'GET') {
      const editions = editionsOf(s, user);
      // A version other than the work's main one shows the work's title, metadata and cover (`work`); only its
      // chapters are its own
      const ownerId = store.workOwnerId(s);
      const owner = ownerId !== s.id && db.series[ownerId] && store.canAccessLibrary(user, db.series[ownerId].libraryId) ? db.series[ownerId] : null;
      const work = owner ? store.seriesView(owner, user, { admin }) : null;
      return send(200, { series: store.seriesView(s, user, { admin }), work, editions, workTitle: work ? work.title : editions.length ? editions[0].title : store.seriesView(s, user).title,
        books: store.booksOf(s.id).map(b => store.bookView(b, user, { admin })),
        collections: Object.values(db.collections).filter(c => c.seriesIds.includes(s.id)).map(c => ({ id: c.id, name: c.name })) });
    }
    if (method === 'PATCH') {
      requireAdmin();
      const o = Object.assign({}, s.overrides);
      for (const k of ['title', 'sortTitle', 'summary', 'publisher']) if (k in body) { const v = clean(body[k], k === 'summary' ? 5000 : 200); if (v) o[k] = v; else delete o[k]; }
      if ('status' in body) { if (body.status && !STATUSES.includes(body.status)) throw httpError(400, 'invalid'); if (body.status) o.status = body.status; else delete o.status; }
      if ('readingDirection' in body) { if (body.readingDirection && !DIRECTIONS.includes(body.readingDirection)) throw httpError(400, 'invalid'); if (body.readingDirection) o.readingDirection = body.readingDirection; else delete o.readingDirection; }
      if ('bookOrder' in body) { if (body.bookOrder && !store.BOOK_ORDERS.includes(body.bookOrder)) throw httpError(400, 'invalid'); if (body.bookOrder) o.bookOrder = body.bookOrder; else delete o.bookOrder; }
      if ('bookLayout' in body) { if (body.bookLayout && !store.BOOK_LAYOUTS.includes(body.bookLayout)) throw httpError(400, 'invalid'); if (body.bookLayout) o.bookLayout = body.bookLayout; else delete o.bookLayout; }
      if ('cover' in body) { if (body.cover && !['file', 'metadata'].includes(body.cover)) throw httpError(400, 'invalid'); if (body.cover) o.cover = body.cover; else delete o.cover; }
      if ('type' in body) { if (body.type && !metadata.TYPES.includes(body.type)) throw httpError(400, 'invalid'); if (body.type) o.type = body.type; else delete o.type; }
      if ('edition' in body) { if (body.edition && !store.EDITIONS.includes(body.edition)) throw httpError(400, 'invalid'); if (body.edition) o.edition = body.edition; else delete o.edition; }
      for (const k of ['tags', 'genres']) {
        if (!(k in body)) continue;
        const list = (Array.isArray(body[k]) ? body[k] : String(body[k] || '').split(',')).map(t => clean(t, 40)).filter(Boolean).slice(0, 50);
        if (list.length) o[k] = list; else delete o[k];
      }
      if ('links' in body) {
        const list = (Array.isArray(body.links) ? body.links : String(body.links || '').split(/\r?\n/)).map(t => clean(t, 500)).filter(Boolean).slice(0, 20);
        if (list.some(u => !/^https?:\/\/\S+$/i.test(u))) throw httpError(400, 'invalidLink');
        if (list.length) o.links = list; else delete o.links;
      }
      if ('year' in body) {
        const y = String(body.year == null ? '' : body.year).trim();
        if (y && !/^\d{4}$/.test(y)) throw httpError(400, 'invalid');
        if (y) o.year = Number(y); else delete o.year;
      }
      if ('altTitles' in body) {
        // One per line (titles can contain commas)
        const list = (Array.isArray(body.altTitles) ? body.altTitles : String(body.altTitles || '').split(/\r?\n|;/)).map(t => clean(t, 200)).filter(Boolean).slice(0, 20);
        if (list.length) o.altTitles = list; else delete o.altTitles;
        delete s.mergedTitles; // (the list as edited includes the titles merges added, or leaves them out on purpose)
      }
      if ('authors' in body) {
        // Names; a name already credited keeps its role(s), a new one is a writer
        const names = (Array.isArray(body.authors) ? body.authors : String(body.authors || '').split(',')).map(t => clean(t, 120)).filter(Boolean).slice(0, 30);
        const current = store.seriesMeta(s).authors;
        const list = [];
        for (const n of names) {
          const known = current.filter(a => a.name.toLowerCase() === n.toLowerCase());
          if (known.length) known.forEach(a => list.push({ name: n, role: a.role })); else list.push({ name: n, role: 'writer' });
        }
        if (list.length) o.authors = list; else delete o.authors;
      }
      s.overrides = o;
      s.updated = new Date().toISOString();
      store.saveLibrary();
      return send(200, { series: store.seriesView(s, user, { admin }) });
    }
  }
  if ((m = /^\/api\/series\/([\w-]+)\/progress$/.exec(p)) && method === 'POST') {
    const s = getSeries(user, m[1]);
    for (const b of store.booksOf(s.id)) {
      if (body.completed) store.setProgress(user, b, b.pageCount || 1, true);
      else store.clearProgress(user, b.id);
    }
    return send(200, { series: store.seriesView(s, user) });
  }
  if ((m = /^\/api\/series\/([\w-]+)\/thumbnail$/.exec(p)) && method === 'GET') {
    const s = getSeries(user, m[1]);
    if (store.coverFromMetadata(s)) {
      const cover = store.metadataCover(s);
      const etag = `"${s.id}-${cover.source}-${cover.version}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return true; }
      const img = await media.imageFile(cover.file, cover.version, etag);
      if (img) { await sendImage(req, res, img.buf, img.type, img.etag); return true; }
    }
    const cover = store.booksOf(s.id).find(b => b.format === 'cbz' && b.pageCount);
    if (!cover) throw httpError(404, 'noCover');
    await sendBookCover(req, res, cover);
    return true;
  }

  // ---- renaming files (admins) ----
  // GET  /api/rename/preview?library=<id|all>  → { checked, items: [{ bookId, from, to, fromName, toName, status, … }] }
  // POST /api/rename/apply { items: [{ bookId, toName }], renameJson }
  if (p === '/api/rename/preview' && method === 'GET') {
    requireAdmin();
    const pv = rename.preview(q.get('library') || 'all', { checkDisk: true });
    // Files already renamed (or gone) on disk while the database still has their old names: re-check those
    // libraries' files (every file, not trusting folder dates) so the database catches up
    for (const id of pv.stale.libraries) scanner.scanLibrary(id, { mode: 'changes', reason: 'files' }).catch(() => {});
    return send(200, pv);
  }
  // GET  /api/rename/rules → examples of the naming rules, worked out by them
  if (p === '/api/rename/rules' && method === 'GET') {
    requireAdmin();
    return send(200, { examples: rename.examples() });
  }
  // POST /api/rename/apply { items: [{ bookId, toName }] } or { all: true, library, exclude: [bookId] }, renameJson
  //   → 202 { job } (queued; follow it with GET /api/rename/jobs/:id). ?wait=1 answers when it's done.
  if (p === '/api/rename/apply' && method === 'POST') {
    requireAdmin();
    const picks = body.all
      ? { all: true, library: typeof body.library === 'string' ? body.library : 'all', exclude: (Array.isArray(body.exclude) ? body.exclude : []).filter(x => typeof x === 'string').slice(0, 200000),
          include: (Array.isArray(body.include) ? body.include : []).filter(x => typeof x === 'string').slice(0, 200000) }
      : (Array.isArray(body.items) ? body.items : []).slice(0, 200000).filter(x => x && typeof x.bookId === 'string' && typeof x.toName === 'string');
    const by = user.username;
    const job = rename.enqueue(picks, {
      renameJson: body.renameJson !== false, metadata, by,
      onDone: j => {
        // Book order/numbers follow file names: let a quick scan put them in order (and refresh folder sources)
        // Every file checked (not a quick scan: a folder's date isn't updated reliably on every disk, and a scan
        // trusting it would bring the old names back)
        for (const id of j.libraries) scanner.scanLibrary(id, { mode: 'changes', reason: 'rename' }).catch(() => {});
        console.log(`[library] ${by} renamed ${j.renamed} file(s)${j.json ? ` and ${j.json} JSON file(s)` : ''}; ${j.failedCount} failed`);
      }
    });
    if (q.get('wait') === '1') return send(200, await rename.waitFor(job.id));
    return send(202, { job });
  }
  // ---- External catalog: sources (sites crawled for their works) and the works found ----
  if (p.startsWith('/api/catalog')) {
    // Administrators only (the catalog is a server tool, like file management)
    requireAdmin();
    if (p === '/api/catalog' && method === 'GET') {
      return send(200, catalog.list({ q: q.get('q'), source: q.get('source'), inLibrary: q.get('inLibrary'), genre: q.get('genre'), merged: q.get('merged'), sort: q.get('sort'), offset: q.get('offset'), limit: q.get('limit') }));
    }
    if (p === '/api/catalog/facets' && method === 'GET') return send(200, catalog.facets());
    if (p === '/api/catalog/work' && method === 'GET') return send(200, { work: catalog.detail(String(q.get('key') || '')) });
    if (p === '/api/catalog/cover' && method === 'GET') {
      const img = await catalog.cover(String(q.get('key') || ''));
      await sendImage(req, res, img.buf, img.type, img.etag);
      return true;
    }
    requireAdmin();
    if (p === '/api/catalog/types' && method === 'GET') return send(200, { types: catalog.types() });
    if (p === '/api/catalog/sources' && method === 'GET') return send(200, { sources: catalog.listSources(), jobs: catalog.jobs(), defaultConcurrency: catalog.info().concurrency });
    // POST { name, baseUrl } → settings detected from the site; or the full settings (with type) as given
    if (p === '/api/catalog/sources' && method === 'POST') return send(201, { source: await catalog.createSource(body) });
    if (p === '/api/catalog/sources/test' && method === 'POST') return send(200, { test: await catalog.testSource(body) });
    // POST /api/catalog/sources/detect { url } → proposed settings from the site's robots.txt, sitemaps and pages
    if (p === '/api/catalog/sources/detect' && method === 'POST') return send(200, { detect: await catalog.detectSource(body.url) });
    if ((m = /^\/api\/catalog\/sources\/([\w-]+)\/icon$/.exec(p)) && method === 'GET') {
      const img = await catalog.sourceIcon(m[1]);
      await sendImage(req, res, img.buf, img.type, img.etag);
      return true;
    }
    if ((m = /^\/api\/catalog\/sources\/([\w-]+)$/.exec(p))) {
      if (method === 'PATCH') return send(200, { source: catalog.updateSource(m[1], body) });
      if (method === 'DELETE') { catalog.removeSource(m[1]); console.log(`[catalog] ${user.username} removed a source`); return send(200, { ok: true }); }
    }
    if ((m = /^\/api\/catalog\/sources\/([\w-]+)\/crawl$/.exec(p)) && method === 'POST') {
      return send(202, { job: catalog.crawl(m[1], { mode: body.mode === 'update' ? 'update' : 'full' }) });
    }
    if ((m = /^\/api\/catalog\/sources\/([\w-]+)\/stop$/.exec(p)) && method === 'POST') return send(200, { stopping: catalog.stopCrawl(m[1]) });
    // Site files (robots.txt, sitemaps) and pages for the wizard's picker
    if ((m = /^\/api\/catalog\/sources\/([\w-]+)\/files$/.exec(p)) && method === 'GET') return send(200, catalog.siteFiles(m[1]));
    if ((m = /^\/api\/catalog\/sources\/([\w-]+)\/file$/.exec(p)) && method === 'GET') return send(200, { file: await catalog.readSiteFile(m[1], q.get('url')) });
    if (p === '/api/catalog/preview' && method === 'GET') {
      // actions: the clicks to make first (JSON list of { selector, mode })
      let actions = null;
      try { actions = q.get('actions') ? JSON.parse(q.get('actions')) : null; } catch { throw httpError(400, 'invalid'); }
      return send(200, { page: await catalog.previewPage(q.get('url'), { inert: q.get('inert') === '1', actions, render: q.get('render') === '1', waitMs: Number(q.get('waitMs')) || 0 }) });
    }
    // Text never part of a title (removed from every catalog title, for merging): one per line
    if (p === '/api/catalog/title-cleanup' && method === 'GET') return send(200, catalog.titleCleanup());
    if (p === '/api/catalog/title-cleanup' && method === 'PUT') return send(200, catalog.setTitleCleanup(body.remove));
    if (p === '/api/catalog/merge-suggestions' && method === 'GET') return send(200, catalog.mergeSuggestions({ source: q.get('source') || null }));
    if (p === '/api/catalog/merged' && method === 'GET') return send(200, catalog.mergedGroups({ source: q.get('source') || null }));
    if (p === '/api/catalog/merge/auto' && method === 'POST') return send(200, { merged: catalog.autoMerge() });
    if ((m = /^\/api\/catalog\/merge\/([\w-]+)\/split$/.exec(p)) && method === 'POST') return send(200, catalog.splitOff(m[1], String(body.key || '')));
    if (p === '/api/catalog/merge-suggestions/dismiss' && method === 'POST') {
      if (typeof body.key !== 'string' || !body.key) throw httpError(400, 'invalid');
      catalog.dismiss(body.key);
      return send(200, { ok: true });
    }
    if (p === '/api/catalog/merge' && method === 'POST') return send(200, catalog.merge(body.keys, body.primary));
    if ((m = /^\/api\/catalog\/merge\/([\w-]+)$/.exec(p)) && method === 'DELETE') { catalog.unmerge(m[1]); return send(200, { ok: true }); }
  }

  // ---- File management: deleting files, merging works (same job queue as renaming) ----
  const fileJobDone = (by, what) => j => {
    for (const id of j.libraries) if (db.libraries[id]) scanner.scanLibrary(id, { mode: 'changes', reason: 'files' }).catch(() => {});
    console.log(`[library] ${by} ${what}: ${j.renamed ? `${j.renamed} renamed, ` : ''}${j.deleted ? `${j.deleted} deleted, ` : ''}${j.moved ? `${j.moved} moved, ` : ''}${j.failedCount} failed`);
  };
  // POST /api/files/delete { items: [{ bookId, replace }] } or { allExists: true, library, keep: 'existing'|'renamed' } → 202 { job }
  if (p === '/api/files/delete' && method === 'POST') {
    requireAdmin();
    const picks = body.allExists
      ? { allExists: true, library: typeof body.library === 'string' ? body.library : 'all', keep: body.keep === 'renamed' ? 'renamed' : 'existing' }
      : (Array.isArray(body.items) ? body.items : []).slice(0, 200000).filter(x => x && typeof x.bookId === 'string').map(x => ({ bookId: x.bookId, replace: x.replace === true }));
    if (Array.isArray(picks) && !picks.length) throw httpError(400, 'invalid');
    const job = rename.enqueue(picks, { kind: 'delete', metadata, by: user.username, onDone: fileJobDone(user.username, 'deleted files') });
    if (q.get('wait') === '1') return send(200, await rename.waitFor(job.id));
    return send(202, { job });
  }
  // GET /api/files/works?q= → { works: [{ id, title, library, path, books, oneshot }] } (folders/files, not grouped)
  if (p === '/api/files/works' && method === 'GET') {
    requireAdmin();
    const term = searchable(q.get('q'));
    const works = [];
    if (term) for (const s of Object.values(db.series)) {
      if (s.hidden) continue;
      const m = store.seriesMeta(s);
      if (!searchable(m.title).includes(term) && !searchable(s.relPath).includes(term) && !m.altTitles.some(x => searchable(x).includes(term))) continue;
      works.push({ id: s.id, title: m.title, edition: m.edition, library: (db.libraries[s.libraryId] || {}).name || '', libraryId: s.libraryId,
        path: String(s.relPath || '').split(/[\\/]/).join('/'), books: store.booksOf(s.id).length, oneshot: Boolean(s.oneshot) });
      if (works.length >= 30) break;
    }
    works.sort((a, b) => store.collator.compare(a.title, b.title) || store.collator.compare(a.path, b.path));
    return send(200, { works });
  }
  // GET /api/files/merge-suggestions?library=→ { total, groups: [{ key, reason, detail, target, works }] }
  if (p === '/api/files/merge-suggestions' && method === 'GET') {
    requireAdmin();
    return send(200, rename.mergeSuggestions({ library: q.get('library') || 'all' }));
  }
  if (p === '/api/files/merge-suggestions/dismiss' && method === 'POST') {
    requireAdmin();
    if (typeof body.key !== 'string' || !body.key) throw httpError(400, 'invalid');
    rename.dismissSuggestion(body.key);
    return send(200, { ok: true });
  }
  // POST /api/files/merge { target, sources: [seriesId], deleteSources } → 202 { job }: the chapters the target lacks move into its folder
  if (p === '/api/files/merge' && method === 'POST') {
    requireAdmin();
    const t = db.series[body.target];
    if (!t) throw httpError(404, 'notFound');
    if (t.oneshot) throw httpError(400, 'mergeTarget');
    const sources = [...new Set((Array.isArray(body.sources) ? body.sources : []).filter(id => typeof id === 'string' && id !== t.id))];
    if (!sources.length || sources.some(id => !db.series[id])) throw httpError(400, 'invalid');
    // deleteSources: the other works' folders are deleted afterwards, with the chapters the kept work already had
    const job = rename.enqueue({ target: t.id, sources, deleteSources: body.deleteSources === true }, { kind: 'merge', metadata, by: user.username, onDone: fileJobDone(user.username, `merged ${sources.length} work(s) into "${store.seriesMeta(t).title}"`) });
    if (q.get('wait') === '1') return send(200, await rename.waitFor(job.id));
    return send(202, { job });
  }
  if ((p === '/api/files/jobs' || p === '/api/rename/jobs') && method === 'GET') { requireAdmin(); return send(200, { jobs: rename.info().jobs }); }
  // GET /api/rename/jobs → { jobs: [...] } (queued, running, last finished); /api/rename/jobs/:id → { job }
  if (p === '/api/rename/jobs' && method === 'GET') { requireAdmin(); return send(200, { jobs: rename.info().jobs }); }
  if ((m = p.match(/^\/api\/(?:rename|files)\/jobs\/([\w-]+)$/)) && method === 'GET') {
    requireAdmin();
    const job = rename.getJob(m[1]);
    if (!job) throw httpError(404, 'notFound');
    return send(200, { job });
  }

  // ---- a work's cover (admins, Edit dialog) ----
  // GET  /api/series/:id/covers                 → { current, candidates: [{ id, kind, … }] }
  // GET  /api/series/:id/cover-candidate?id=…   → the image of a candidate stored on this server (preview)
  // POST /api/series/:id/cover { choice } | { upload: 'data:image/…;base64,…' }
  if ((m = /^\/api\/series\/([\w-]+)\/(covers|cover-candidate|cover)$/.exec(p))) {
    requireAdmin();
    const s = getSeries(user, m[1]);
    // ?search=1: also ask the online sites without a candidate yet (a few seconds at most, once a week per work;
    // &force=1 asks again now)
    if (m[2] === 'covers' && method === 'GET') return send(200, await metadata.coverCandidates(s, { search: q.get('search') === '1', force: q.get('force') === '1' }));
    if (m[2] === 'cover-candidate' && method === 'GET') {
      // A site's cover: fetched by the server (some sites refuse images shown on other pages; the browser
      // also never contacts the sites), kept in memory for a while
      if (/^online:/.test(q.get('id') || '')) {
        const img = await metadata.onlineCandidateImage(s, q.get('id'));
        if (!img) throw httpError(404, 'notFound');
        await sendImage(req, res, img.buf, img.type, `"${s.id}-${q.get('id')}-${img.buf.length}"`);
        return true;
      }
      const file = metadata.candidateFile(s, q.get('id'));
      const buf = file && await fs.promises.readFile(file).catch(() => null);
      if (!buf) throw httpError(404, 'notFound');
      await sendImage(req, res, buf, metadata.IMAGE_EXTS[path.extname(file).toLowerCase()] || 'application/octet-stream', `"${s.id}-cand-${buf.length}"`);
      return true;
    }
    if (m[2] === 'cover' && method === 'POST') {
      await metadata.chooseCover(s, { choice: body.choice, upload: body.upload });
      return send(200, { series: store.seriesView(s, user, { admin }) });
    }
  }

  // ---- deleting works (admins) ----
  // POST /api/series/:id/delete { mode: 'hide' | 'files', scope: 'version' | 'work', confirm }
  //   hide:  logical delete; the work disappears for everyone, its files stay, rescans keep it hidden
  //   files: physical delete of the book files (and the work's folder if that leaves it empty);
  //          `confirm` must be the work's title
  // POST /api/series/:id/restore { scope } brings hidden works back
  if ((m = /^\/api\/series\/([\w-]+)\/(delete|restore)$/.exec(p)) && method === 'POST') {
    requireAdmin();
    const s = getSeries(user, m[1]);
    const targets = body.scope === 'work' ? versionsOf(s, user) : [s];
    if (m[2] === 'restore') {
      let restored = 0;
      for (const x of targets) if (x.hidden) { delete x.hidden; restored++; }
      store.saveLibrary();
      console.log(`[library] ${user.username} restored ${restored} hidden work(s): "${store.seriesMeta(s).title}"`);
      return send(200, { restored, series: store.seriesView(s, user, { admin }) });
    }
    if (body.mode === 'files') {
      const title = store.seriesMeta(s).title;
      if (searchable(clean(body.confirm, 300)) !== searchable(title.trim())) throw httpError(400, 'confirmMismatch');
      const result = await deleteWorkFiles(targets);
      console.log(`[library] ${user.username} deleted the files of "${title}": ${result.deletedBooks} book(s), ${result.deletedWorks} work(s) removed, ${result.failed.length} failed`);
      return send(200, result);
    }
    const at = new Date().toISOString();
    for (const x of targets) x.hidden = { at, by: user.username };
    store.saveLibrary();
    console.log(`[library] ${user.username} hid ${targets.length} work(s): "${store.seriesMeta(s).title}"`);
    return send(200, { hidden: targets.length });
  }

  // ---- online metadata (admins) ----
  if (p === '/api/metadata/providers' && method === 'GET') {
    requireAdmin();
    return send(200, { providers: metadata.providerList(), status: metadata.info() });
  }
  // ---- metadata sources: online sites (read-only) and folder sources (create / edit / delete / check) ----
  if (p === '/api/metadata/sources' && method === 'GET') {
    requireAdmin();
    const libs = Object.values(db.libraries);
    const online = metadata.providerList().filter(x => x.kind === 'online').map(x => Object.assign(x, {
      usedBy: libs.filter(l => metadata.librarySettings(l).providers.some(pp => pp.id === x.id && pp.enabled)).map(l => ({ id: l.id, name: l.name }))
    }));
    return send(200, { folder: metadata.folderSources().map(metadata.sourceView), online, matchModes: metadata.MATCH_MODES });
  }
  if (p === '/api/metadata/sources' && method === 'POST') {
    requireAdmin();
    const folder = await validateRoot(body.folder);
    return send(201, { source: metadata.sourceView(metadata.createSource({ name: body.name, folder, match: body.match })) });
  }
  if ((m = /^\/api\/metadata\/sources\/([\w-]+)(\/check|\/apply|\/search)?$/.exec(p))) {
    requireAdmin();
    const id = m[1], action = m[2] || '';
    if (action === '/search' && method === 'GET') {
      // Try an online site from the sources page
      const prov = metadata.BY_ID[id];
      if (!prov) throw httpError(404, 'notFound');
      const term = clean(q.get('q'), 200);
      if (!term) throw httpError(400, 'invalid');
      return send(200, { results: await metadata.testSearch(id, term) });
    }
    if (!db.metadataSources[id]) throw httpError(404, 'notFound');
    if (action === '/check' && method === 'GET') return send(200, await metadata.checkSource(id));
    if (action === '/apply' && method === 'POST') return send(200, { applied: await metadata.applyLocalEverywhere() });
    if (action === '' && method === 'PATCH') {
      const patch = { name: body.name, match: body.match };
      if ('folder' in body) patch.folder = await validateRoot(body.folder);
      return send(200, { source: metadata.sourceView(metadata.updateSource(id, patch)) });
    }
    if (action === '' && method === 'DELETE') { await metadata.removeSource(id); return send(200, { ok: true }); }
  }
  if ((m = /^\/api\/libraries\/([\w-]+)\/metadata$/.exec(p)) && method === 'POST') {
    requireAdmin();
    if (!db.libraries[m[1]]) throw httpError(404, 'notFound');
    // First the folder sources (JSON files): matched again for the whole library right away (local files,
    // unreadable ones ignored). Then the online lookups are queued:
    // 'stale' (delta: new, changed or old), 'missing' (never looked up) or 'all' (everything again)
    let folder = null;
    try { folder = await metadata.applyLocal(m[1]); } catch (e) { console.error('[metadata] folder sources:', e.message); }
    const queued = metadata.enqueueLibrary(m[1], ['all', 'stale'].includes(body.mode) ? body.mode : 'missing');
    return send(202, { queued, folder, status: metadata.info() });
  }
  if ((m = /^\/api\/series\/([\w-]+)\/metadata(\/refresh|\/search|\/identify)?$/.exec(p))) {
    requireAdmin();
    const s = getSeries(user, m[1]);
    const action = m[2] || '';
    if (action === '/refresh' && method === 'POST') {
      await metadata.refreshSeries(s.id);
      return send(200, { series: store.seriesView(db.series[s.id] || s, user, { admin }) });
    }
    if (action === '/search' && method === 'GET') {
      const provider = q.get('provider') || '';
      return send(200, await metadata.searchForSeries(s.id, clean(q.get('q'), 200), provider || null));
    }
    if (action === '/identify' && method === 'POST') {
      // { matches: [{ provider, id }, …] } (several sites at once), or the older { provider, id }
      const picks = Array.isArray(body.matches) ? body.matches.slice(0, 20).map(x => ({ provider: String((x && x.provider) || ''), id: clean(x && x.id, 100) }))
        : [{ provider: String(body.provider || ''), id: clean(body.id, 100) }];
      // Several sites: a background task (the answer comes at once; the page follows the task)
      if (picks.length > 1) return send(202, await metadata.identify(s.id, picks, { background: true }));
      await metadata.identify(s.id, picks);
      return send(200, { series: store.seriesView(db.series[s.id] || s, user, { admin }) });
    }
    if (action === '' && method === 'DELETE') {
      metadata.clear(s.id);
      return send(200, { series: store.seriesView(s, user, { admin }) });
    }
  }

  // ---- books ----
  if ((m = /^\/api\/books\/([\w-]+)$/.exec(p))) {
    const b = getBook(user, m[1]);
    if (method === 'GET') {
      let siblings = store.booksOf(b.seriesId);
      const rl = q.get('readlist') && db.readlists[q.get('readlist')];
      if (rl) siblings = rl.bookIds.map(id => db.books[id]).filter(x => x && store.canAccessLibrary(user, x.libraryId));
      const i = siblings.findIndex(x => x.id === b.id);
      const s = db.series[b.seriesId];
      return send(200, {
        book: store.bookView(b, user, { admin }),
        series: s ? store.seriesView(s, user) : null,
        prev: i > 0 ? store.bookView(siblings[i - 1], user) : null,
        next: i >= 0 && i < siblings.length - 1 ? store.bookView(siblings[i + 1], user) : null,
        readlists: Object.values(db.readlists).filter(r => r.bookIds.includes(b.id)).map(r => ({ id: r.id, name: r.name }))
      });
    }
    if (method === 'PATCH') {
      requireAdmin();
      const o = Object.assign({}, b.overrides);
      for (const k of ['title', 'number', 'summary', 'releaseDate']) if (k in body) { const v = clean(body[k], k === 'summary' ? 5000 : 200); if (v) o[k] = v; else delete o[k]; }
      if (o.releaseDate && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(o.releaseDate)) throw httpError(400, 'invalidDate');
      b.overrides = o;
      store.reindex();
      store.saveLibrary();
      return send(200, { book: store.bookView(b, user, { admin }) });
    }
  }
  if ((m = /^\/api\/books\/(\w+)\/pages\/(\d+)$/.exec(p)) && method === 'GET') {
    await sendPage(req, res, getBook(user, m[1]), Number(m[2]));
    return true;
  }
  if ((m = /^\/api\/books\/(\w+)\/thumbnail$/.exec(p)) && method === 'GET') {
    const b = getBook(user, m[1]);
    if (b.format !== 'cbz' || !b.pageCount) throw httpError(404, 'noCover');
    await sendBookCover(req, res, b);
    return true;
  }
  if ((m = /^\/api\/books\/(\w+)\/file$/.exec(p)) && (method === 'GET' || method === 'HEAD')) {
    await sendFile(req, res, getBook(user, m[1]), q.get('download') === '1');
    return true;
  }
  if ((m = /^\/api\/books\/(\w+)\/progress$/.exec(p))) {
    const b = getBook(user, m[1]);
    if (method === 'PUT') return send(200, { progress: store.setProgress(user, b, body.page, body.completed) });
    if (method === 'DELETE') { store.clearProgress(user, b.id); return send(200, { progress: null }); }
  }
  if ((m = /^\/api\/books\/(\w+)\/page-count$/.exec(p)) && method === 'POST') {
    // The PDF reader reports the real page count when the server's estimate was missing or wrong
    const b = getBook(user, m[1]);
    const n = Number(body.pageCount);
    if (b.format !== 'pdf' || !Number.isInteger(n) || n < 1 || n > 100000) throw httpError(400, 'invalid');
    if (b.pageCount !== n) { b.pageCount = n; store.saveLibrary(); }
    return send(200, { pageCount: n });
  }

  // GET /api/search/terms?field=genre|tag|person|type&q=&library= → { terms: [{ name, count }] }: genres
  // (categories), tags, people and types matching what was typed, with how many works have each (only works
  // the user may see; with a library, only that library's), from the Search cache process
  if (p === '/api/search/terms' && method === 'GET') {
    const field = String(q.get('field') || '');
    if (!['genre', 'tag', 'person', 'type'].includes(field)) throw httpError(400, 'invalid');
    const lib = q.get('library');
    const libs = store.accessibleLibraries(user).map(l => l.id).filter(id => !lib || lib === 'all' || id === lib);
    await ensureSearch();
    const terms = await searchCache.call('terms', { field, q: String(q.get('q') || '').slice(0, 100), libs, limit: Math.min(200, Number(q.get('limit')) || 60) });
    return send(200, { terms });
  }
  // ---- home & search ----
  if (p === '/api/home' && method === 'GET') return send(200, home(user));
  if (p === '/api/search' && method === 'GET') {
    const term = searchable(q.get('q'));
    if (!term) return send(200, { series: [], books: [], collections: [], readlists: [] });
    const libs = new Set(store.accessibleLibraries(user).map(l => l.id));
    // Works: from the Search cache process (built here if it can't answer)
    let series;
    try {
      const ids = await searchWorks(q.get('q'), user, 30);
      const byId = new Map();
      for (const e of workIndex(user, null)) for (const v of e.list) byId.set(v.id, e);
      series = [...new Set(ids.map(id => byId.get(id)).filter(Boolean))].map(e => workObject(e, user));
    } catch (e) {
      series = workIndex(user, null).filter(x => textOf(x).includes(term)).sort(SORTERS.title).slice(0, 30).map(x => workObject(x, user));
    }
    // Books: matched on their memoized metadata; views only for the first 30 found
    const books = [];
    for (const b of Object.values(db.books)) {
      if (!libs.has(b.libraryId) || !bookShown(b)) continue;
      const m = store.bookMeta(b);
      if (searchable(m.title).includes(term) || searchable(b.fileName).includes(term) || m.authors.some(a => searchable(a.name).includes(term))) books.push(b);
      if (books.length >= 30) break;
    }
    const collections = visibleCollections(user).filter(c => searchable(c.name).includes(term)).slice(0, 20);
    const readlists = visibleReadlists(user).filter(r => searchable(r.name).includes(term)).slice(0, 20);
    return send(200, { series, books: books.map(b => store.bookView(b, user)), collections, readlists });
  }

  // ---- collections (groups of series) ----
  if (p === '/api/collections' && method === 'GET') return send(200, { collections: visibleCollections(user) });
  if (p === '/api/collections' && method === 'POST') {
    requireAdmin();
    const name = clean(body.name, 80);
    if (!name) throw httpError(400, 'nameRequired');
    const now = new Date().toISOString();
    const c = { id: store.newId(), name, seriesIds: ids(body.seriesIds, db.series) || [], created: now, updated: now };
    db.collections[c.id] = c;
    store.saveLibrary();
    return send(201, { collection: collectionView(c, user, true) });
  }
  if ((m = /^\/api\/collections\/([\w-]+)$/.exec(p))) {
    const c = db.collections[m[1]];
    if (!c) throw httpError(404, 'notFound');
    if (method === 'GET') {
      const v = collectionView(c, user, true);
      if (!v.seriesCount && !admin) throw httpError(404, 'notFound');
      return send(200, { collection: v });
    }
    requireAdmin();
    if (method === 'DELETE') { delete db.collections[c.id]; store.saveLibrary(); return send(200, { ok: true }); }
    if (method === 'PATCH') {
      if ('name' in body) { const name = clean(body.name, 80); if (!name) throw httpError(400, 'nameRequired'); c.name = name; }
      const set = ids(body.seriesIds, db.series); if (set) c.seriesIds = set;
      const add = ids(body.addSeriesIds, db.series); if (add) c.seriesIds = [...new Set([...c.seriesIds, ...add])];
      const remove = ids(body.removeSeriesIds, db.series); if (remove) c.seriesIds = c.seriesIds.filter(id => !remove.includes(id));
      c.updated = new Date().toISOString();
      store.saveLibrary();
      return send(200, { collection: collectionView(c, user, true) });
    }
  }

  // ---- read lists (ordered books) ----
  if (p === '/api/readlists' && method === 'GET') return send(200, { readlists: visibleReadlists(user) });
  if (p === '/api/readlists' && method === 'POST') {
    requireAdmin();
    const name = clean(body.name, 80);
    if (!name) throw httpError(400, 'nameRequired');
    const now = new Date().toISOString();
    const r = { id: store.newId(), name, summary: clean(body.summary, 2000), bookIds: ids(body.bookIds, db.books) || [], created: now, updated: now };
    db.readlists[r.id] = r;
    store.saveLibrary();
    return send(201, { readlist: readlistView(r, user, true) });
  }
  if ((m = /^\/api\/readlists\/([\w-]+)$/.exec(p))) {
    const r = db.readlists[m[1]];
    if (!r) throw httpError(404, 'notFound');
    if (method === 'GET') {
      const v = readlistView(r, user, true);
      if (!v.booksCount && !admin) throw httpError(404, 'notFound');
      return send(200, { readlist: v });
    }
    requireAdmin();
    if (method === 'DELETE') { delete db.readlists[r.id]; store.saveLibrary(); return send(200, { ok: true }); }
    if (method === 'PATCH') {
      if ('name' in body) { const name = clean(body.name, 80); if (!name) throw httpError(400, 'nameRequired'); r.name = name; }
      if ('summary' in body) r.summary = clean(body.summary, 2000);
      const set = ids(body.bookIds, db.books); if (set) r.bookIds = set;
      const add = ids(body.addBookIds, db.books); if (add) r.bookIds = [...r.bookIds, ...add.filter(id => !r.bookIds.includes(id))];
      const remove = ids(body.removeBookIds, db.books); if (remove) r.bookIds = r.bookIds.filter(id => !remove.includes(id));
      r.updated = new Date().toISOString();
      store.saveLibrary();
      return send(200, { readlist: readlistView(r, user, true) });
    }
  }

  return false;
}

module.exports = {
  cacheInfo, handle, httpError };
