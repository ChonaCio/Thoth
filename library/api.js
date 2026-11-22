// HTTP API for libraries, series, books, pages, reading progress, collections, read lists and search.
// Every route requires a signed-in user and only returns content from libraries that user may access.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./db');
const scanner = require('./scanner');
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

function getSeries(user, id) {
  const s = db.series[id];
  if (!s || !store.canAccessLibrary(user, s.libraryId)) throw httpError(404, 'notFound');
  return s;
}
function getBook(user, id) {
  const b = db.books[id];
  if (!b || !store.canAccessLibrary(user, b.libraryId)) throw httpError(404, 'notFound');
  return b;
}
const bookFile = b => path.join(db.libraries[b.libraryId].root, b.relPath);

/* ---------------- libraries ---------------- */
function libraryView(lib, user) {
  const series = Object.values(db.series).filter(s => s.libraryId === lib.id).length;
  const books = Object.values(db.books).filter(b => b.libraryId === lib.id).length;
  const v = { id: lib.id, name: lib.name, seriesCount: series, booksCount: books, scanning: scanner.scanning.has(lib.id) };
  if (isAdmin(user)) Object.assign(v, { root: lib.root, created: lib.created, lastScan: lib.lastScan || null, scanError: lib.scanError || null, scanProgress: scanner.scanning.get(lib.id) || null });
  return v;
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
function listSeries(user, q) {
  const libs = new Set(store.accessibleLibraries(user).map(l => l.id));
  const library = q.get('library');
  const term = searchable(q.get('q'));
  const read = q.get('read');
  let items = Object.values(db.series)
    .filter(s => libs.has(s.libraryId) && (!library || s.libraryId === library))
    .map(s => store.seriesView(s, user));
  if (term) items = items.filter(s => searchable(s.title).includes(term) || searchable(s.publisher).includes(term) || s.tags.some(t => searchable(t).includes(term)));
  if (read) items = items.filter(s => readState(s) === read);
  const sort = q.get('sort') || 'title';
  if (sort === 'added') items.sort((a, b) => b.created.localeCompare(a.created));
  else if (sort === 'updated') items.sort((a, b) => b.updated.localeCompare(a.updated));
  else items.sort((a, b) => store.collator.compare(a.sortTitle, b.sortTitle));
  const offset = Math.max(0, Number(q.get('offset')) || 0);
  const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 60));
  return { total: items.length, offset, items: items.slice(offset, offset + limit) };
}

/* ---------------- home ---------------- */
function home(user) {
  const libs = new Set(store.accessibleLibraries(user).map(l => l.id));
  const books = Object.values(db.books).filter(b => libs.has(b.libraryId));
  const series = Object.values(db.series).filter(s => libs.has(s.libraryId));
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
    recentSeries: series.sort((a, b) => b.created.localeCompare(a.created)).slice(0, 24).map(s => store.seriesView(s, user)),
    recentBooks: books.sort((a, b) => b.created.localeCompare(a.created) || store.compareBooks(a, b)).slice(0, 24).map(b => store.bookView(b, user)),
    libraries: libs.size
  };
}

/* ---------------- collections & read lists ---------------- */
function collectionView(c, user, full) {
  const series = c.seriesIds.map(id => db.series[id]).filter(s => s && store.canAccessLibrary(user, s.libraryId));
  const v = { id: c.id, name: c.name, seriesCount: series.length, created: c.created, updated: c.updated,
    coverSeries: series.slice(0, 4).map(s => store.seriesView(s, user)).map(s => ({ id: s.id, coverBookId: s.coverBookId, coverV: s.coverV, coverFormat: s.coverFormat })) };
  if (full) v.series = series.map(s => store.seriesView(s, user));
  return v;
}
function readlistView(r, user, full) {
  const books = r.bookIds.map(id => db.books[id]).filter(b => b && store.canAccessLibrary(user, b.libraryId));
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
    const lib = { id: store.newId(), name, root, created: new Date().toISOString() };
    db.libraries[lib.id] = lib;
    store.saveLibrary();
    scanner.scanLibrary(lib.id).catch(() => {});
    return send(201, { library: libraryView(lib, user) });
  }
  if ((m = /^\/api\/libraries\/([\w-]+)$/.exec(p)) && (method === 'PATCH' || method === 'DELETE')) {
    requireAdmin();
    const lib = db.libraries[m[1]];
    if (!lib) throw httpError(404, 'notFound');
    if (method === 'DELETE') {
      for (const b of Object.values(db.books)) if (b.libraryId === lib.id) delete db.books[b.id];
      for (const s of Object.values(db.series)) if (s.libraryId === lib.id) delete db.series[s.id];
      for (const c of Object.values(db.collections)) c.seriesIds = c.seriesIds.filter(id => db.series[id]);
      for (const r of Object.values(db.readlists)) r.bookIds = r.bookIds.filter(id => db.books[id]);
      delete db.libraries[lib.id];
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
        lib.root = root; rescan = true;
      }
    }
    store.saveLibrary();
    if (rescan) scanner.scanLibrary(lib.id).catch(() => {});
    return send(200, { library: libraryView(lib, user) });
  }
  if ((m = /^\/api\/libraries\/([\w-]+)\/scan$/.exec(p)) && method === 'POST') {
    requireAdmin();
    if (!db.libraries[m[1]]) throw httpError(404, 'notFound');
    scanner.scanLibrary(m[1]).catch(() => {});
    return send(202, { library: libraryView(db.libraries[m[1]], user) });
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
  if ((m = /^\/api\/series\/([\w-]+)$/.exec(p))) {
    const s = getSeries(user, m[1]);
    if (method === 'GET') {
      return send(200, { series: store.seriesView(s, user, { admin }), books: store.booksOf(s.id).map(b => store.bookView(b, user, { admin })),
        collections: Object.values(db.collections).filter(c => c.seriesIds.includes(s.id)).map(c => ({ id: c.id, name: c.name })) });
    }
    if (method === 'PATCH') {
      requireAdmin();
      const o = Object.assign({}, s.overrides);
      for (const k of ['title', 'sortTitle', 'summary', 'publisher']) if (k in body) { const v = clean(body[k], k === 'summary' ? 5000 : 200); if (v) o[k] = v; else delete o[k]; }
      if ('status' in body) { if (body.status && !STATUSES.includes(body.status)) throw httpError(400, 'invalid'); if (body.status) o.status = body.status; else delete o.status; }
      if ('readingDirection' in body) { if (body.readingDirection && !DIRECTIONS.includes(body.readingDirection)) throw httpError(400, 'invalid'); if (body.readingDirection) o.readingDirection = body.readingDirection; else delete o.readingDirection; }
      if ('tags' in body) { const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',')).map(t => clean(t, 40)).filter(Boolean).slice(0, 50); if (tags.length) o.tags = tags; else delete o.tags; }
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
    const cover = store.booksOf(s.id).find(b => b.format === 'cbz' && b.pageCount);
    if (!cover) throw httpError(404, 'noCover');
    await sendPage(req, res, cover, 1);
    return true;
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
    const series = Object.values(db.series).filter(s => libs.has(s.libraryId))
      .map(s => store.seriesView(s, user)).filter(s => searchable(s.title).includes(term) || s.tags.some(t => searchable(t).includes(term)))
      .sort((a, b) => store.collator.compare(a.sortTitle, b.sortTitle)).slice(0, 30);
    const books = Object.values(db.books).filter(b => libs.has(b.libraryId))
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
