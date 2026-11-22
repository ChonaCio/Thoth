// Library scanner: keeps series/books in sync with the files on disk.
//   Series = a folder that directly contains book files.  Book = a .cbz/.zip/.pdf file.
//   One-shots: files directly in the library's one-shots folder are each their own series.
//
// The slow part (walking folders, opening archives, reading ComicInfo.xml and PDFs) runs in a separate
// low-priority process (scan-worker.js), so a big scan doesn't slow down browsing and reading.
// Scans are queued and run one library at a time. This process only applies the results to the database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const core = require('./scan-core');
const store = require('./db');

const { BOOK_EXT, IMAGE_TYPES, parseComicInfo } = core;
const WORKER = path.join(__dirname, 'scan-worker.js');
const IN_PROCESS = process.env.THOTH_SCAN_IN_PROCESS === '1'; // debugging / platforms without fork

// libraryId -> { queued, startedAt, filesSeen, analyzed, again }
const scanning = new Map();

/* ---------------- page images for the reader (main process, cached) ---------------- */
const entryCache = new Map(); // `${file}|${mtime}` -> sorted image entries
async function imageEntries(file, mtimeMs) {
  const key = `${file}|${mtimeMs}`;
  if (entryCache.has(key)) {
    const v = entryCache.get(key);
    entryCache.delete(key); entryCache.set(key, v); // LRU bump
    return v;
  }
  const images = await core.listImages(file);
  entryCache.set(key, images);
  if (entryCache.size > 64) entryCache.delete(entryCache.keys().next().value);
  return images;
}

/* ---------------- one-shots ----------------
 * lib.oneshots = { enabled, folder }. folder is relative to the library folder; '' = the library folder
 * itself (the default). Book files directly in that folder are one-shots: each is its own series.
 */
function oneshotSettings(lib) {
  const o = lib.oneshots || {};
  return { enabled: o.enabled !== false, folder: o.folder || '' };
}
// "One-shots/", "\\Extras\\Singles" → "One-shots", "Extras<sep>Singles"; null if it tries to leave the library
function normalizeOneshotFolder(value) {
  const parts = String(value || '').split(/[\\/]+/).map(s => s.trim()).filter(Boolean);
  if (parts.some(p => p === '..' || p === '.') || /^[a-zA-Z]:/.test(parts[0] || '')) return null;
  return parts.join(path.sep);
}

/* ---------------- the worker process ---------------- */
let activeChild = null;
process.on('exit', () => { if (activeChild) try { activeChild.kill(); } catch { /* gone */ } });

function collectInWorker(root, known, status) {
  return new Promise((resolve, reject) => {
    let child, settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; activeChild = null; fn(v); } };
    try {
      child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
    } catch (e) {
      return reject(Object.assign(e, { forkFailed: true }));
    }
    activeChild = child;
    // Lowest CPU priority so the web server always wins (nice 19 / idle priority on Windows)
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed here */ }
    status.worker = child.pid;
    child.on('message', m => {
      if (m.type === 'progress') { status.filesSeen = m.filesSeen; status.analyzed = m.analyzed; }
      else if (m.type === 'result') done(resolve, m.result);
      else if (m.type === 'error') done(reject, Object.assign(new Error(m.message), { code: m.code }));
    });
    child.on('error', e => done(reject, Object.assign(e, { forkFailed: true })));
    child.on('exit', code => done(reject, new Error(`Scan process stopped unexpectedly (exit code ${code})`)));
    child.send({ type: 'scan', root, known });
  });
}

async function collect(lib, known, status) {
  const progress = p => { status.filesSeen = p.filesSeen; status.analyzed = p.analyzed; };
  status.mode = 'server';
  if (IN_PROCESS) return core.collect(lib.root, known, progress);
  try {
    status.mode = 'worker';
    return await collectInWorker(lib.root, known, status);
  } catch (e) {
    if (!e.forkFailed) throw e;
    console.warn(`[library] couldn't start the scan process (${e.message}); scanning in the server process`);
    status.mode = 'server';
    return core.collect(lib.root, known, progress);
  }
}

/* ---------------- applying a scan to the database ---------------- */
async function runScan(libraryId, status) {
  const lib = store.db.libraries[libraryId];
  if (!lib) throw Object.assign(new Error('Library not found'), { status: 404, code: 'notFound' });
  const started = Date.now();
  try {
    // What the database already knows, so the worker only re-reads new or changed files
    const known = {};
    for (const b of Object.values(store.db.books)) {
      if (b.libraryId === libraryId) known[b.relPath] = [b.size, b.fileModified];
    }
    const found = await collect(lib, known, status);
    if (!store.db.libraries[libraryId]) throw Object.assign(new Error('Library was removed'), { code: 'notFound' });

    const byRel = new Map(found.files.map(f => [f.rel, f]));
    const now = new Date().toISOString();
    const seenBooks = new Set(), seenSeries = new Set();
    let added = 0, updated = 0;

    // Group book files by folder → series. Files directly in the one-shots folder (by default the
    // library folder itself) each become their own single-book series instead.
    const one = oneshotSettings(lib);
    const groups = new Map();
    for (const f of found.files) {
      const dir = path.dirname(f.rel) === '.' ? '' : path.dirname(f.rel);
      if (one.enabled && dir === one.folder) { groups.set('oneshot\0' + f.rel, { dir, files: [f.rel], oneshot: true }); continue; }
      if (!groups.has(dir)) groups.set(dir, { dir, files: [], oneshot: false });
      groups.get(dir).files.push(f.rel);
    }

    for (const { dir, files, oneshot } of groups.values()) {
      files.sort((a, b) => store.collator.compare(path.basename(a), path.basename(b)));
      const seriesId = oneshot ? store.stableId(libraryId, 'oneshot', files[0]) : store.stableId(libraryId, 'series', dir);
      seenSeries.add(seriesId);
      let series = store.db.series[seriesId];
      if (!series) {
        series = store.db.series[seriesId] = {
          id: seriesId, libraryId, relPath: oneshot ? files[0] : dir,
          name: oneshot ? path.basename(files[0]).replace(/\.[^.]+$/, '') : (dir ? path.basename(dir) : lib.name),
          oneshot, meta: {}, overrides: {}, created: now, updated: now
        };
        added++;
      }
      let seriesChanged = false;

      for (let i = 0; i < files.length; i++) {
        const f = byRel.get(files[i]);
        const bookId = store.stableId(libraryId, 'book', f.rel);
        seenBooks.add(bookId);
        let book = store.db.books[bookId];
        const isNew = !book;
        if (isNew) {
          book = store.db.books[bookId] = {
            id: bookId, seriesId, libraryId, relPath: f.rel, fileName: path.basename(f.rel),
            format: BOOK_EXT[path.extname(f.rel).toLowerCase()], overrides: {}, created: now
          };
        }
        // A book can move between series when the one-shot setting changes; its id (and progress) stays
        if (book.seriesId !== seriesId) { book.seriesId = seriesId; seriesChanged = true; }
        if (book.index !== i) { book.index = i; seriesChanged = true; }
        if (f.changed) {
          book.pageCount = f.error ? (book.pageCount || 0) : f.pageCount;
          book.meta = f.meta || {};
          if (f.error) book.error = f.error; else delete book.error;
          book.size = f.size;
          book.fileModified = f.fileModified;
          book.analyzedAt = now;
          if (!isNew) updated++;
          seriesChanged = true;
        }
      }

      if (seriesChanged) {
        // Series-level metadata from the first book's ComicInfo (admin overrides still win)
        const books = files.map(rel => store.db.books[store.stableId(libraryId, 'book', rel)]).filter(Boolean);
        const first = books.find(b => b.meta && Object.keys(b.meta).length);
        const fm = (first && first.meta) || {};
        series.meta = {
          // A one-shot is named after its book (ComicInfo title first); a series after ComicInfo's series name
          title: (oneshot ? fm.title || fm.series : fm.series) || undefined,
          summary: fm.summary && files.length === 1 ? fm.summary : undefined,
          publisher: fm.publisher, readingDirection: fm.readingDirection, ageRating: fm.ageRating,
          tags: [...new Set(books.flatMap(b => (b.meta || {}).tags || []))]
        };
        series.updated = now;
      }
    }

    // Remove books/series whose files are gone
    let removed = 0;
    for (const b of Object.values(store.db.books)) {
      if (b.libraryId === libraryId && !seenBooks.has(b.id)) { delete store.db.books[b.id]; removed++; }
    }
    for (const s of Object.values(store.db.series)) {
      if (s.libraryId === libraryId && !seenSeries.has(s.id)) delete store.db.series[s.id];
    }
    for (const c of Object.values(store.db.collections)) c.seriesIds = c.seriesIds.filter(id => store.db.series[id]);
    for (const r of Object.values(store.db.readlists)) r.bookIds = r.bookIds.filter(id => store.db.books[id]);

    store.reindex();
    lib.lastScan = {
      at: new Date().toISOString(), durationMs: Date.now() - started, mode: status.mode,
      series: seenSeries.size, books: seenBooks.size, added, updated, removed,
      unsupported: found.unsupported.length, unsupportedExamples: found.unsupported.slice(0, 5),
      errors: found.errors.slice(0, 20),
      failedBooks: Object.values(store.db.books).filter(b => b.libraryId === libraryId && b.error).length
    };
    delete lib.scanError;
    store.saveLibrary();
    console.log(`[library] scanned "${lib.name}": ${seenSeries.size} series, ${seenBooks.size} books (+${added} new, ${updated} changed, ${removed} removed) in ${Date.now() - started} ms`);
    return lib.lastScan;
  } catch (e) {
    if (store.db.libraries[libraryId]) {
      lib.scanError = e.code === 'ENOENT' ? 'folderNotFound' : (e.code === 'EACCES' || e.code === 'EPERM') ? 'folderNoAccess' : e.message;
      store.saveLibrary();
    }
    console.error(`[library] scan of "${lib.name}" failed: ${e.message}`);
    throw e;
  }
}

/* ---------------- the queue: one scan at a time ---------------- */
const queue = [];
let running = false;

function scanLibrary(libraryId) {
  if (!store.db.libraries[libraryId]) return Promise.reject(Object.assign(new Error('Library not found'), { status: 404, code: 'notFound' }));
  const existing = scanning.get(libraryId);
  if (existing) {
    // Already queued: nothing to do. Already running: run once more afterwards (settings may have changed).
    if (!existing.queued) existing.again = true;
    return Promise.resolve({ alreadyScheduled: true });
  }
  const status = { queued: true, filesSeen: 0, analyzed: 0 };
  scanning.set(libraryId, status);
  return new Promise((resolve, reject) => {
    queue.push({ libraryId, status, resolve, reject });
    pump();
  });
}

async function pump() {
  if (running || !queue.length) return;
  running = true;
  const job = queue.shift();
  job.status.queued = false;
  job.status.startedAt = new Date().toISOString();
  try {
    job.resolve(await runScan(job.libraryId, job.status));
  } catch (e) {
    job.reject(e);
  } finally {
    scanning.delete(job.libraryId);
    running = false;
    if (job.status.again && store.db.libraries[job.libraryId]) scanLibrary(job.libraryId).catch(() => {});
    pump();
  }
}

// Scan every library now, and again every N minutes (settings.scanIntervalMinutes; 0 = never)
let timer = null;
function scanAll() {
  for (const id of Object.keys(store.db.libraries)) scanLibrary(id).catch(() => {});
}
function startSchedule() {
  clearInterval(timer);
  const minutes = Number(store.db.settings.scanIntervalMinutes) || 0;
  if (minutes > 0) timer = setInterval(scanAll, minutes * 60 * 1000).unref();
}

module.exports = { scanLibrary, scanAll, startSchedule, scanning, imageEntries, IMAGE_TYPES, BOOK_EXT, parseComicInfo, oneshotSettings, normalizeOneshotFolder };
