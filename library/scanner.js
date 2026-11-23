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

/* ---------------- the scan service (a long-running worker process) ----------------
 * state: 'running' | 'starting' (restarting after a crash) | 'stopped' | 'crashed' (gave up after repeated crashes)
 * mode:  'process' (separate process) | 'inline' (inside the server: THOTH_SCAN_IN_PROCESS=1 or fork unavailable)
 * Whether it should run is saved (settings.scanServiceEnabled), so a stopped service stays stopped after a restart.
 */
const service = {
  mode: IN_PROCESS ? 'inline' : 'process',
  state: 'stopped', child: null, pid: null, startedAt: null,
  restarts: 0, crashTimes: [], lastError: null, stats: null
};
let activeWorkerJob = null; // { jobId, resolve, reject, status } — the scan the worker is doing now
let jobSeq = 0;
const cancelled = () => Object.assign(new Error('Scan stopped'), { code: 'cancelled' });

process.on('exit', () => { if (service.child) try { service.child.kill(); } catch { /* gone */ } });

function setEnabled(enabled) {
  store.db.settings.scanServiceEnabled = enabled;
  store.saveLibrary();
}
function serviceEnabled() { return store.db.settings.scanServiceEnabled !== false; }

function startService({ persist = true } = {}) {
  if (persist) setEnabled(true);
  if (service.state === 'running') return;
  // An admin starting it clears the last problem; an automatic restart after a crash keeps it visible
  if (persist) service.lastError = null;
  if (service.mode === 'inline') {
    Object.assign(service, { state: 'running', pid: process.pid, startedAt: new Date().toISOString() });
    pump();
    return;
  }
  let child;
  try {
    child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
  } catch (e) {
    console.warn(`[library] couldn't start the scan process (${e.message}); scanning inside the server`);
    service.mode = 'inline';
    service.lastError = e.message;
    return startService({ persist: false });
  }
  // Lowest CPU priority so the web server always wins (nice 19 / idle priority on Windows)
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed here */ }
  Object.assign(service, { child, pid: child.pid, state: 'running', startedAt: new Date().toISOString(), stats: null });
  child.on('message', m => onWorkerMessage(child, m));
  child.on('error', e => { service.lastError = e.message; });
  child.on('exit', code => onWorkerExit(child, code));
  console.log(`[library] scan service started (pid ${child.pid})`);
  pump();
}

function stopService({ persist = true } = {}) {
  if (persist) setEnabled(false);
  const child = service.child;
  Object.assign(service, { state: 'stopped', child: null, pid: null, startedAt: null, stats: null });
  // The scan in progress is cancelled and put back at the front of the queue
  if (activeWorkerJob) { const j = activeWorkerJob; activeWorkerJob = null; j.reject(cancelled()); }
  if (child) {
    child.removeAllListeners('exit');
    child.on('exit', () => {});
    try { child.kill(); } catch { /* already gone */ }
    console.log(`[library] scan service stopped (pid ${child.pid})`);
  }
}

function restartService() {
  stopService({ persist: false });
  service.restarts++;
  startService({ persist: true });
}

function onWorkerMessage(child, m) {
  if (child !== service.child) return;
  if (m.type === 'stats') { service.stats = { rss: m.rss, heapUsed: m.heapUsed, cpuMs: m.cpuMs, at: new Date().toISOString() }; return; }
  const j = activeWorkerJob;
  if (!j || m.jobId !== j.jobId) return;
  if (m.type === 'progress') { j.status.filesSeen = m.filesSeen; j.status.analyzed = m.analyzed; }
  else if (m.type === 'result') { activeWorkerJob = null; j.resolve(m.result); }
  else if (m.type === 'error') { activeWorkerJob = null; j.reject(Object.assign(new Error(m.message), { code: m.code })); }
}

// The worker died on its own: fail the scan it was doing, then restart (unless it keeps crashing)
function onWorkerExit(child, code) {
  if (child !== service.child) return;
  const msg = `Scan process stopped unexpectedly (exit code ${code})`;
  console.error(`[library] ${msg}`);
  Object.assign(service, { child: null, pid: null, startedAt: null, stats: null, lastError: msg });
  if (activeWorkerJob) { const j = activeWorkerJob; activeWorkerJob = null; j.reject(new Error(msg)); }
  const now = Date.now();
  service.crashTimes = service.crashTimes.filter(t => now - t < 60000).concat(now);
  if (service.crashTimes.length >= 3) {
    service.state = 'crashed';
    console.error('[library] scan service crashed 3 times in a minute; not restarting it automatically');
    return;
  }
  service.state = 'starting';
  setTimeout(() => {
    if (service.state !== 'starting') return; // stopped meanwhile
    service.state = 'stopped';
    service.restarts++;
    startService({ persist: false });
  }, 1000).unref();
}

function collectInWorker(root, known, status) {
  return new Promise((resolve, reject) => {
    if (!service.child) return reject(cancelled());
    const jobId = ++jobSeq;
    activeWorkerJob = { jobId, resolve, reject, status };
    status.worker = service.pid;
    service.child.send({ type: 'scan', jobId, root, known });
  });
}

function collect(lib, known, status) {
  if (service.mode === 'inline') {
    status.mode = 'server';
    return core.collect(lib.root, known, p => { status.filesSeen = p.filesSeen; status.analyzed = p.analyzed; });
  }
  status.mode = 'worker';
  return collectInWorker(lib.root, known, status);
}

/* ---------------- applying a scan to the database ---------------- */
async function runScan(job) {
  const { libraryId, status } = job;
  const lib = store.db.libraries[libraryId];
  if (!lib) throw Object.assign(new Error('Library not found'), { status: 404, code: 'notFound' });
  const started = Date.now();
  try {
    // What the database already knows, so the worker only re-reads new or changed files.
    // A full scan sends nothing, so every file is read again.
    const known = {};
    if (!job.full) {
      for (const b of Object.values(store.db.books)) {
        if (b.libraryId === libraryId) known[b.relPath] = [b.size, b.fileModified];
      }
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
      at: new Date().toISOString(), durationMs: Date.now() - started, mode: status.mode, full: Boolean(job.full),
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
    if (e.code === 'cancelled') throw e; // stopped from the Processes page: not an error, it runs again later
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
let currentJob = null;

// full: re-read every file (otherwise only new and changed files are read)
function scanLibrary(libraryId, { full = false } = {}) {
  if (!store.db.libraries[libraryId]) return Promise.reject(Object.assign(new Error('Library not found'), { status: 404, code: 'notFound' }));
  const existing = scanning.get(libraryId);
  if (existing) {
    // Waiting in line: a full scan request upgrades it. Running: run once more afterwards
    // (settings may have changed), as a full scan if one was asked for.
    const waiting = queue.find(j => j.libraryId === libraryId);
    if (waiting) { waiting.full = waiting.full || full; existing.full = waiting.full; }
    else { existing.again = true; existing.againFull = existing.againFull || full; }
    return Promise.resolve({ alreadyScheduled: true });
  }
  const status = { queued: true, full, filesSeen: 0, analyzed: 0 };
  scanning.set(libraryId, status);
  return new Promise((resolve, reject) => {
    queue.push({ libraryId, full, status, resolve, reject });
    pump();
  });
}

async function pump() {
  if (currentJob || !queue.length || service.state !== 'running') return;
  const job = currentJob = queue.shift();
  Object.assign(job.status, { queued: false, startedAt: new Date().toISOString(), filesSeen: 0, analyzed: 0 });
  let result, error;
  try { result = await runScan(job); } catch (e) { error = e; }
  currentJob = null;
  if (error && error.code === 'cancelled') {
    // Service stopped: back to the front of the line, to run when it starts again
    Object.assign(job.status, { queued: true, startedAt: null, filesSeen: 0, analyzed: 0 });
    queue.unshift(job);
  } else {
    scanning.delete(job.libraryId);
    if (error) job.reject(error); else job.resolve(result);
    if (job.status.again && store.db.libraries[job.libraryId]) scanLibrary(job.libraryId, { full: job.status.againFull }).catch(() => {});
  }
  pump();
}

// What the Processes page shows
function serviceInfo() {
  const name = id => (store.db.libraries[id] || {}).name || '';
  return {
    mode: service.mode, state: service.state, enabled: serviceEnabled(),
    pid: service.pid, startedAt: service.startedAt, restarts: service.restarts, lastError: service.lastError, stats: service.stats,
    current: currentJob ? { libraryId: currentJob.libraryId, name: name(currentJob.libraryId), full: Boolean(currentJob.full),
      startedAt: currentJob.status.startedAt, filesSeen: currentJob.status.filesSeen, analyzed: currentJob.status.analyzed } : null,
    queue: queue.map(j => ({ libraryId: j.libraryId, name: name(j.libraryId), full: Boolean(j.full) }))
  };
}

// On server start: start the service unless an admin stopped it
function init() {
  if (serviceEnabled()) startService({ persist: false });
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

module.exports = {
  scanLibrary, scanAll, startSchedule, init, scanning, imageEntries, IMAGE_TYPES, BOOK_EXT, parseComicInfo,
  oneshotSettings, normalizeOneshotFolder,
  startService, stopService, restartService, serviceInfo, serviceState: () => service.state
};
