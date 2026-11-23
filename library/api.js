// HTTP API for libraries, series, books, pages, reading progress, collections, read lists and search.
// Every route requires a signed-in user and only returns content from libraries that user may access.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./db');
const scanner = require('./scanner');
const metadata = require('./metadata');
const rename = require('./rename');
const zip = require('./zip');

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
function libraryView(lib, user) {
  const series = Object.values(db.series).filter(s => s.libraryId === lib.id && shown(s)).length;
  const books = Object.values(db.books).filter(b => b.libraryId === lib.id && bookShown(b)).length;
  const v = { id: lib.id, name: lib.name, seriesCount: series, booksCount: books, scanning: scanner.scanning.has(lib.id),
    defaultSort: store.libraryDefaults(lib).sort }; // everyone: the library page opens with this order
  if (isAdmin(user)) {
    const progress = scanner.scanning.get(lib.id);
    Object.assign(v, {
      root: lib.root, created: lib.created, lastScan: lib.lastScan || null, scanError: lib.scanError || null, oneshots: scanner.oneshotSettings(lib),
      metadata: metadata.librarySettings(lib),
      metadataCount: Object.values(db.series).filter(s => s.libraryId === lib.id && s.provider && (s.provider.matches || []).length).length,
      scanProgress: progress ? Object.assign({}, progress, { serviceStopped: progress.queued && scanner.serviceState() !== 'running', progress: scanner.progressOf(progress) }) : null,
      defaults: store.libraryDefaults(lib),
      hiddenCount: Object.values(db.series).filter(s => s.libraryId === lib.id && s.hidden).length
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
// preferLibrary: on a library's page, the card shows the version that lives in that library
function groupWorks(views, preferLibrary) {
  const works = new Map();
  for (const v of views) {
    if (!works.has(v.workKey)) works.set(v.workKey, []);
    works.get(v.workKey).push(v);
  }
  return [...works.values()].flatMap(splitByEdition).map(list => {
    const shown = (preferLibrary && list.find(v => v.libraryId === preferLibrary)) || list[0];
    const work = Object.assign({}, shown);
    work.workTitle = list[0].title; // the Regular (or first) version's title names the work
    work.editions = list.map(editionSummary);
    work.created = list.reduce((m, v) => (v.created > m ? v.created : m), work.created);
    work.updated = list.reduce((m, v) => (v.updated > m ? v.updated : m), work.updated);
    return work;
  });
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

// Every work the user can see, grouped across libraries (versions may live in different libraries);
// with a library: the works that have a version in it
// deleted: only the hidden works (administrators restoring them)
function worksFor(user, library, { deleted = false } = {}) {
  const libs = new Set(store.accessibleLibraries(user).map(l => l.id));
  let items = groupWorks(Object.values(db.series)
    .filter(s => libs.has(s.libraryId) && (deleted ? Boolean(s.hidden) : !s.hidden))
    .map(s => store.seriesView(s, user)), library || null);
  if (library) items = items.filter(w => w.editions.some(e => e.libraryId === library));
  return items;
}
// Online metadata state of a work: 'matched', 'unmatched' (looked up, nothing found) or 'none' (never looked up)
const metadataState = s => ((s.localSources && s.localSources.length) || (s.metadata && s.metadata.matched) ? 'matched' : !s.metadata ? 'none' : 'unmatched');
const same = (a, b) => searchable(a) === searchable(b);

function listSeries(user, q) {
  let items = worksFor(user, q.get('library'), { deleted: isAdmin(user) && q.get('deleted') === '1' });
  const term = searchable(q.get('q'));
  if (term) items = items.filter(s => searchable(s.title).includes(term) || searchable(s.publisher).includes(term)
    || s.tags.some(t => searchable(t).includes(term)) || s.genres.some(t => searchable(t).includes(term))
    || s.altTitles.some(t => searchable(t).includes(term)) || s.authors.some(a => searchable(a.name).includes(term)));
  const read = q.get('read');
  if (read) items = items.filter(s => readState(s) === read);
  // Advanced search: include/exclude any number of values (repeated parameters; x… = exclude).
  //   genre, tag (lists on a work): ALL included values present, NONE of the excluded
  //   type, status, metadata (one value per work): ANY of the included values, none of the excluded
  const all = k => q.getAll(k).map(v => String(v).trim()).filter(Boolean).slice(0, 50);
  const has = (list, v) => list.some(x => same(x, v));
  const incG = all('genre'), excG = all('xgenre'), incT = all('tag'), excT = all('xtag');
  if (incG.length || excG.length) items = items.filter(s => incG.every(g => has(s.genres, g)) && !excG.some(g => has(s.genres, g)));
  if (incT.length || excT.length) items = items.filter(s => incT.every(x => has(s.tags, x)) && !excT.some(x => has(s.tags, x)));
  const single = (inc, exc, valueOf) => { if (inc.length || exc.length) items = items.filter(s => (!inc.length || inc.includes(valueOf(s))) && !exc.includes(valueOf(s))); };
  single(all('type'), all('xtype'), s => s.type || 'unknown');
  single(all('status'), all('xstatus'), s => s.status);
  single(all('metadata'), all('xmetadata'), metadataState);
  const yearFrom = Number(q.get('yearFrom')) || 0, yearTo = Number(q.get('yearTo')) || 0;
  if (yearFrom || yearTo) items = items.filter(s => s.year && (!yearFrom || s.year >= yearFrom) && (!yearTo || s.year <= yearTo));
  const author = searchable(q.get('author'));
  if (author) items = items.filter(s => s.authors.some(a => searchable(a.name).includes(author)));
  const sort = q.get('sort') || 'title';
  if (sort === 'added') items.sort((a, b) => b.created.localeCompare(a.created));
  else if (sort === 'updated') items.sort((a, b) => b.updated.localeCompare(a.updated));
  else items.sort((a, b) => store.collator.compare(a.sortTitle, b.sortTitle));
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 60));
  return { total: items.length, offset, items: items.slice(offset, offset + limit) };
}
// The values the library filters can offer, with how many works have each
function seriesFacets(user, library) {
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
  const items = worksFor(user, library);
  const tally = values => { const m = {}; for (const v of values) m[v] = (m[v] || 0) + 1; return m; };
  return {
    genres: count(items.flatMap(s => s.genres), 'genres'),
    tags: count(items.flatMap(s => s.tags), 'tags'),
    types: tally(items.map(s => s.type || 'unknown')),
    statuses: tally(items.map(s => s.status)),
    metadata: tally(items.map(metadataState))
  };
}

/* ---------------- home ---------------- */
function home(user) {
  const libs = new Set(store.accessibleLibraries(user).map(l => l.id));
  const books = Object.values(db.books).filter(b => libs.has(b.libraryId) && bookShown(b));
  const series = Object.values(db.series).filter(s => libs.has(s.libraryId) && shown(s));
  const keepReading = books
    .map(b => ({ b, p: store.progressOf(user, b.id) }))
    .filter(x => x.p && !x.p.completed)
    .sort((a, b) => b.p.updatedAt.localeCompare(a.p.updatedAt))
    .slice(0, 24).map(x => store.bookView(x.b, user));
  const onDeck = [];
  for (const s of series) {
    const list = store.booksOf(s.id);
    const c = store.seriesCounts(s, user);
    if (!c.booksRead || c.booksInProgress || c.booksRead === c.booksCount) continue;
    const next = list.find(b => !store.progressOf(user, b.id));
    if (next) onDeck.push({ book: next, at: c.lastRead });
  }
  onDeck.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    keepReading,
    onDeck: onDeck.slice(0, 24).map(x => store.bookView(x.book, user)),
    recentSeries: groupWorks(series.map(s => store.seriesView(s, user))).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 24),
    recentBooks: books.sort((a, b) => b.created.localeCompare(a.created) || store.compareBooks(a, b)).slice(0, 24).map(b => store.bookView(b, user)),
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
async function sendPage(req, res, book, n) {
  if (book.format !== 'cbz') throw httpError(400, 'notAnImageBook');
  const file = bookFile(book);
  const st = await fs.promises.stat(file).catch(() => { throw httpError(404, 'fileMissing'); });
  const images = await scanner.imageEntries(file, st.mtimeMs);
  const entry = images[n - 1];
  if (!entry) throw httpError(404, 'pageNotFound');
  const buf = await zip.readEntry(file, entry);
  const type = scanner.IMAGE_TYPES[path.extname(entry.name).toLowerCase()] || 'application/octet-stream';
  return sendImage(req, res, buf, type, `"${book.id}-${Math.round(st.mtimeMs)}-${n}"`);
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
async function handle(ctx) {
  const { method, pathname: p, query: q, body, req, res, user, send } = ctx;
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
      return send(200, { series: store.seriesView(s, user, { admin }), editions, workTitle: editions.length ? editions[0].title : store.seriesView(s, user).title,
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
      const st = await fs.promises.stat(cover.file).catch(() => null);
      const buf = st && st.size <= 16 * 1024 * 1024 ? await fs.promises.readFile(cover.file).catch(() => null) : null;
      if (buf) {
        const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(cover.file).toLowerCase()] || 'application/octet-stream';
        return sendImage(req, res, buf, type, `"${s.id}-${cover.source}-${cover.version}"`).then(() => true);
      }
    }
    const cover = store.booksOf(s.id).find(b => b.format === 'cbz' && b.pageCount);
    if (!cover) throw httpError(404, 'noCover');
    await sendPage(req, res, cover, 1);
    return true;
  }

  // ---- renaming files (admins) ----
  // GET  /api/rename/preview?library=<id|all>  → { checked, items: [{ bookId, from, to, fromName, toName, status, … }] }
  // POST /api/rename/apply { items: [{ bookId, toName }], renameJson }
  if (p === '/api/rename/preview' && method === 'GET') {
    requireAdmin();
    return send(200, rename.preview(q.get('library') || 'all'));
  }
  if (p === '/api/rename/apply' && method === 'POST') {
    requireAdmin();
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 5000).filter(x => x && typeof x.bookId === 'string');
    const result = await rename.apply(items, { renameJson: body.renameJson !== false, metadata });
    // Book order/numbers follow file names: let a quick scan put them in order (and refresh folder sources)
    for (const id of result.libraries) scanner.scanLibrary(id, { mode: 'quick', reason: 'rename' }).catch(() => {});
    console.log(`[library] ${user.username} renamed ${result.renamed} file(s)${result.json ? ` and ${result.json} JSON file(s)` : ''}; ${result.failed.length} failed`);
    return send(200, result);
  }

  // ---- a work's cover (admins, Edit dialog) ----
  // GET  /api/series/:id/covers                 → { current, candidates: [{ id, kind, … }] }
  // GET  /api/series/:id/cover-candidate?id=…   → the image of a candidate stored on this server (preview)
  // POST /api/series/:id/cover { choice } | { upload: 'data:image/…;base64,…' }
  if ((m = /^\/api\/series\/([\w-]+)\/(covers|cover-candidate|cover)$/.exec(p))) {
    requireAdmin();
    const s = getSeries(user, m[1]);
    // ?search=1: also ask the online sites that weren't asked during the lookup (slower)
    if (m[2] === 'covers' && method === 'GET') return send(200, await metadata.coverCandidates(s, { search: q.get('search') === '1' }));
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
    await sendPage(req, res, b, 1);
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

  // ---- home & search ----
  if (p === '/api/home' && method === 'GET') return send(200, home(user));
  if (p === '/api/search' && method === 'GET') {
    const term = searchable(q.get('q'));
    if (!term) return send(200, { series: [], books: [], collections: [], readlists: [] });
    const libs = new Set(store.accessibleLibraries(user).map(l => l.id));
    const series = groupWorks(Object.values(db.series).filter(s => libs.has(s.libraryId) && shown(s)).map(s => store.seriesView(s, user)))
      .filter(s => searchable(s.title).includes(term) || s.tags.some(t => searchable(t).includes(term)) || s.genres.some(t => searchable(t).includes(term))
        || s.altTitles.some(t => searchable(t).includes(term)) || s.authors.some(a => searchable(a.name).includes(term)))
      .sort((a, b) => store.collator.compare(a.sortTitle, b.sortTitle)).slice(0, 30);
    const books = Object.values(db.books).filter(b => libs.has(b.libraryId) && bookShown(b))
      .map(b => store.bookView(b, user)).filter(b => searchable(b.title).includes(term) || searchable(b.fileName).includes(term) || b.authors.some(a => searchable(a.name).includes(term)))
      .slice(0, 30);
    const collections = visibleCollections(user).filter(c => searchable(c.name).includes(term)).slice(0, 20);
    const readlists = visibleReadlists(user).filter(r => searchable(r.name).includes(term)).slice(0, 20);
    return send(200, { series, books, collections, readlists });
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

module.exports = { handle, httpError };
