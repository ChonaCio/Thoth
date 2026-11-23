// Library scanner: keeps series/books in sync with the files on disk.
//   Series = a folder that directly contains book files.  Book = a .cbz/.zip/.pdf file.
//   One-shots: every book file directly in the library folder (and in the optional one-shots folder) is
//   its own work, shown like any other work.
//
// The slow part (walking folders, opening archives, reading ComicInfo.xml and PDFs) runs in the scan
// service: a pool of long-running, lowest-priority worker processes (scan-worker.js). A scan lists the
// files in one worker, then spreads the new/changed files over all workers, each reading several files at
// a time (Server settings: "Scan processes" and "Files at once per process"). Libraries are scanned one
// at a time; this process applies the results to the database.
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const core = require('./scan-core');
const store = require('./db');
const config = require('../config');

const { BOOK_EXT, IMAGE_TYPES, parseComicInfo } = core;
const WORKER = path.join(__dirname, 'scan-worker.js');
const IN_PROCESS = process.env.THOTH_SCAN_IN_PROCESS === '1'; // debugging / platforms without fork

// libraryId -> { queued, full, startedAt, filesSeen, toAnalyze, analyzed, again, againFull, worker, mode }
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
 * Book files directly in the library folder are always one-shots (each its own work). lib.oneshots.folder
 * optionally names one more folder, relative to the library folder, whose files are one-shots too.
 */
function oneshotSettings(lib) {
  const o = lib.oneshots || {};
  // (Older settings had an on/off switch; the library folder itself no longer depends on it)
  return { folder: o.enabled === false ? '' : (o.folder || '') };
}
// "One-shots/", "\\Extras\\Singles" → "One-shots", "Extras<sep>Singles"; null if it tries to leave the library
function normalizeOneshotFolder(value) {
  const parts = String(value || '').split(/[\\/]+/).map(s => s.trim()).filter(Boolean);
  if (parts.some(p => p === '..' || p === '.') || /^[a-zA-Z]:/.test(parts[0] || '')) return null;
  return parts.join(path.sep);
}

/* ---------------- the scan service: a pool of worker processes ----------------
 * state: 'running' | 'stopped' | 'crashed' (gave up after repeated crashes)
 * mode:  'process' (worker processes) | 'inline' (inside the server: THOTH_SCAN_IN_PROCESS=1 or fork unavailable)
 * Whether it should run is saved (settings.scanServiceEnabled), so a stopped service stays stopped after a restart.
 */
const service = {
  mode: IN_PROCESS ? 'inline' : 'process',
  state: 'stopped', workers: [], startedAt: null,
  restarts: 0, crashTimes: [], lastError: null
};
let reqSeq = 0;
const cancelled = () => Object.assign(new Error('Scan stopped'), { code: 'cancelled' });

process.on('exit', () => { for (const w of service.workers) try { w.child.kill(); } catch { /* gone */ } });

function setEnabled(enabled) {
  store.db.settings.scanServiceEnabled = enabled;
  store.saveLibrary();
}
function serviceEnabled() { return store.db.settings.scanServiceEnabled !== false; }

function spawnWorker() {
  const child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
  // Lowest CPU priority so the web server always wins (nice 19 / idle priority on Windows)
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed here */ }
  const w = { child, pid: child.pid, startedAt: new Date().toISOString(), stats: null, pending: new Map() };
  child.on('message', m => onWorkerMessage(w, m));
  child.on('error', e => { service.lastError = e.message; });
  child.on('exit', code => onWorkerExit(w, code));
  return w;
}

function startService({ persist = true } = {}) {
  if (persist) { setEnabled(true); service.lastError = null; }
  if (service.state === 'running') return;
  if (service.mode === 'process') {
    const count = config.get().scanWorkers;
    try {
      service.workers = Array.from({ length: count }, spawnWorker);
    } catch (e) {
      console.warn(`[library] couldn't start scan processes (${e.message}); scanning inside the server`);
      for (const w of service.workers) try { w.child.kill(); } catch { /* ignore */ }
      service.workers = [];
      service.mode = 'inline';
      service.lastError = e.message;
    }
  }
  service.state = 'running';
  service.startedAt = new Date().toISOString();
  if (service.mode === 'process') console.log(`[library] scan service started: ${service.workers.length} process(es), pids ${service.workers.map(w => w.pid).join(', ')}`);
  pump();
}

function stopService({ persist = true } = {}) {
  if (persist) setEnabled(false);
  const workers = service.workers;
  Object.assign(service, { state: 'stopped', workers: [], startedAt: null });
  // Requests in flight are cancelled; the scan goes back to the front of the queue
  for (const w of workers) {
    for (const p of w.pending.values()) p.reject(cancelled());
    w.pending.clear();
    w.child.removeAllListeners('exit');
    w.child.on('exit', () => {});
    try { w.child.kill(); } catch { /* already gone */ }
  }
  if (workers.length) console.log(`[library] scan service stopped (pids ${workers.map(w => w.pid).join(', ')})`);
}

function restartService() {
  stopService({ persist: false });
  service.restarts++;
  startService({ persist: true });
}

// Server settings changed: a running pool restarts with the new number of processes
config.onChange(changed => {
  if (changed.includes('scanWorkers') && service.state === 'running' && service.mode === 'process') {
    stopService({ persist: false });
    startService({ persist: false });
  }
});

function request(w, msg, onProgress) {
  return new Promise((resolve, reject) => {
    const reqId = ++reqSeq;
    w.pending.set(reqId, { resolve, reject, onProgress });
    w.child.send(Object.assign({ reqId }, msg));
  });
}

function onWorkerMessage(w, m) {
  if (m.type === 'stats') { w.stats = { rss: m.rss, heapUsed: m.heapUsed, cpuMs: m.cpuMs, at: new Date().toISOString() }; return; }
  const p = w.pending.get(m.reqId);
  if (!p) return;
  if (m.type === 'progress') { if (p.onProgress) p.onProgress(m); }
  else if (m.type === 'result') { w.pending.delete(m.reqId); p.resolve(m.result); }
  else if (m.type === 'error') { w.pending.delete(m.reqId); p.reject(Object.assign(new Error(m.message), { code: m.code })); }
}

// A worker died on its own: fail what it was doing, then replace it (unless processes keep crashing)
function onWorkerExit(w, code) {
  if (!service.workers.includes(w)) return;
  const msg = `Scan process stopped unexpectedly (exit code ${code})`;
  console.error(`[library] ${msg} (pid ${w.pid})`);
  service.lastError = msg;
  service.workers = service.workers.filter(x => x !== w);
  for (const p of w.pending.values()) p.reject(new Error(msg));
  w.pending.clear();
  const now = Date.now();
  service.crashTimes = service.crashTimes.filter(t => now - t < 60000).concat(now);
  if (service.crashTimes.length >= 3) {
    stopService({ persist: false });
    service.state = 'crashed';
    service.lastError = msg;
    console.error('[library] scan processes crashed 3 times in a minute; not restarting them automatically');
    return;
  }
  setTimeout(() => {
    if (service.state !== 'running') return;
    try { service.workers.push(spawnWorker()); service.restarts++; pump(); } catch (e) { service.lastError = e.message; }
  }, 1000).unref();
}

/* ---------------- running one scan ---------------- */
async function listFiles(lib, status) {
  if (service.mode === 'inline') { status.mode = 'server'; return core.listFiles(lib.root, n => { status.filesSeen = n; }); }
  const w = service.workers[0];
  if (!w || service.state !== 'running') throw cancelled();
  status.mode = 'worker';
  status.worker = w.pid;
  return request(w, { type: 'list', root: lib.root }, m => { status.filesSeen = m.filesSeen; });
}

// Spread the files to read over every worker; each reads `scanConcurrency` files at a time
async function analyzeFiles(lib, rels, status) {
  const concurrency = config.get().scanConcurrency;
  status.toAnalyze = rels.length;
  status.analyzed = 0;
  if (!rels.length) return [];
  if (service.mode === 'inline') return core.analyzeFiles(lib.root, rels, concurrency, n => { status.analyzed = n; });
  const workers = service.workers.slice();
  if (!workers.length || service.state !== 'running') throw cancelled();
  // Small batches handed out as workers finish, so a slow file doesn't hold up the others
  const size = Math.max(2, Math.min(50, Math.ceil(rels.length / (workers.length * 4))));
  const batches = [];
  for (let i = 0; i < rels.length; i += size) batches.push(rels.slice(i, i + size));
  const results = [];
  let next = 0, finished = 0;
  const inFlight = new Map();
  const report = () => { status.analyzed = finished + [...inFlight.values()].reduce((a, b) => a + b, 0); };
  await Promise.all(workers.map(async w => {
    while (next < batches.length) {
      if (service.state !== 'running') throw cancelled();
      const batch = batches[next++];
      inFlight.set(w, 0);
      const res = await request(w, { type: 'analyze', root: lib.root, files: batch, concurrency }, m => { inFlight.set(w, m.analyzed); report(); });
      inFlight.delete(w);
      finished += batch.length;
      report();
      results.push(...res);
    }
  }));
  return results;
}

/* ---------------- applying a scan to the database ---------------- */
async function runScan(job) {
  const { libraryId, status } = job;
  const lib = store.db.libraries[libraryId];
  if (!lib) throw Object.assign(new Error('Library not found'), { status: 404, code: 'notFound' });
  const started = Date.now();
  try {
    const listing = await listFiles(lib, status);
    status.filesSeen = listing.files.length;

    // Read only new or changed files (by size and modification time), or every file for a full scan
    const books = new Map(Object.values(store.db.books).filter(b => b.libraryId === libraryId).map(b => [b.relPath, b]));
    const toRead = listing.files.filter(f => {
      const b = books.get(f.rel);
      return job.full || !b || b.size !== f.size || b.fileModified !== f.fileModified;
    }).map(f => f.rel);
    const analysis = new Map((await analyzeFiles(lib, toRead, status)).map(r => [r.rel, r]));
    if (!store.db.libraries[libraryId]) throw Object.assign(new Error('Library was removed'), { code: 'notFound' });

    const byRel = new Map(listing.files.map(f => [f.rel, Object.assign({}, f, analysis.has(f.rel) ? Object.assign({ changed: true }, analysis.get(f.rel)) : {})]));
    const now = new Date().toISOString();
    const seenBooks = new Set(), seenSeries = new Set();
    let added = 0, updated = 0;

    // Group book files by folder → series. Files directly in the library folder (and in the optional
    // one-shots folder) each become their own work instead.
    const one = oneshotSettings(lib);
    const groups = new Map();
    for (const f of listing.files) {
      const dir = path.dirname(f.rel) === '.' ? '' : path.dirname(f.rel);
      if (dir === '' || (one.folder && dir === one.folder)) { groups.set('oneshot\0' + f.rel, { dir, files: [f.rel], oneshot: true }); continue; }
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
          name: oneshot ? path.basename(files[0]).replace(/\.[^.]+$/, '') : path.basename(dir),
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
        const list = files.map(rel => store.db.books[store.stableId(libraryId, 'book', rel)]).filter(Boolean);
        const first = list.find(b => b.meta && Object.keys(b.meta).length);
        const fm = (first && first.meta) || {};
        series.meta = {
          // A one-shot is named after its book (ComicInfo title first); a series after ComicInfo's series name
          title: (oneshot ? fm.title || fm.series : fm.series) || undefined,
          summary: fm.summary && files.length === 1 ? fm.summary : undefined,
          publisher: fm.publisher, readingDirection: fm.readingDirection, ageRating: fm.ageRating,
          tags: [...new Set(list.flatMap(b => (b.meta || {}).tags || []))]
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
    const cfg = config.get();
    lib.lastScan = {
      at: new Date().toISOString(), durationMs: Date.now() - started, mode: status.mode, full: Boolean(job.full),
      processes: status.mode === 'worker' ? service.workers.length : 1, concurrency: cfg.scanConcurrency, read: toRead.length,
      series: seenSeries.size, books: seenBooks.size, added, updated, removed,
      unsupported: listing.unsupported.length, unsupportedExamples: listing.unsupported.slice(0, 5),
      errors: listing.errors.slice(0, 20),
      failedBooks: Object.values(store.db.books).filter(b => b.libraryId === libraryId && b.error).length
    };
    delete lib.scanError;
    store.saveLibrary();
    console.log(`[library] scanned "${lib.name}": ${seenSeries.size} series, ${seenBooks.size} books (+${added} new, ${updated} changed, ${removed} removed; read ${toRead.length} files) in ${Date.now() - started} ms`);
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

/* ---------------- the queue: one library at a time ---------------- */
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
  const status = { queued: true, full, filesSeen: 0, toAnalyze: 0, analyzed: 0 };
  scanning.set(libraryId, status);
  return new Promise((resolve, reject) => {
    queue.push({ libraryId, full, status, resolve, reject });
    pump();
  });
}

async function pump() {
  if (currentJob || !queue.length || service.state !== 'running') return;
  const job = currentJob = queue.shift();
  Object.assign(job.status, { queued: false, startedAt: new Date().toISOString(), filesSeen: 0, toAnalyze: 0, analyzed: 0 });
  let result, error;
  try { result = await runScan(job); } catch (e) { error = e; }
  currentJob = null;
  if (error && error.code === 'cancelled') {
    // Service stopped: back to the front of the line, to run when it starts again
    Object.assign(job.status, { queued: true, startedAt: null, filesSeen: 0, toAnalyze: 0, analyzed: 0 });
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
  const cfg = config.get();
  return {
    mode: service.mode, state: service.state, enabled: serviceEnabled(),
    startedAt: service.startedAt, restarts: service.restarts, lastError: service.lastError,
    processes: cfg.scanWorkers, concurrency: cfg.scanConcurrency,
    workers: service.workers.map(w => ({ pid: w.pid, startedAt: w.startedAt, stats: w.stats, busy: w.pending.size > 0 })),
    current: currentJob ? { libraryId: currentJob.libraryId, name: name(currentJob.libraryId), full: Boolean(currentJob.full),
      startedAt: currentJob.status.startedAt, filesSeen: currentJob.status.filesSeen, toAnalyze: currentJob.status.toAnalyze, analyzed: currentJob.status.analyzed } : null,
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
