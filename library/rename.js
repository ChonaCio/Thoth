// Batch renaming of book files to a consistent naming:
//   chapter-0.cbz              → Chapter 0.cbz
//   chapter-1.1.cbz            → Chapter 1.1.cbz
//   chapter-1x1.cbz            → Chapter 1.1.cbz        ("x" between numbers is a decimal point)
//   Chapter 001.cbz            → Chapter 1.cbz          (no zero padding)
//   chapter-1-chapter name.cbz → Chapter 1 - Chapter Name.cbz
//   chapter-83-the-end.cbz     → Chapter 83 - The End.cbz (dashes inside a name are spaces)
//   ch_12_the_end.cbz          → Chapter 12 - The End.cbz
//   vol.3.cbz                  → Volume 3.cbz
// The preview lists proposals (and conflicts); nothing changes until an administrator applies the ones they
// pick. Applying renames the files on disk in a separate, short-lived process (rename-worker.js) and moves
// everything attached to the book to its new name (book ids come from the file path): reading progress, read
// lists. Matching JSON files of folder sources can be renamed along (otherwise 11.json would stop matching
// once 11.cbz is renamed).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const store = require('./db');
const local = require('./metadata/local');
const renameWorker = require('./rename-worker');

const { db } = store;
// The naming rules (shared with the external catalog's crawls)
const { KINDS, parse, cleanNumber, cleanName, titleCase, proposedName, nameWithNumber } = require('./naming');

// A chapter number that lost its decimal point: a work with chapters 1 to 70 and a `505` most likely has 50.5
// (the number is far past the others, and with a point it falls in the run, next to a chapter it has, on a
// number it doesn't have). Returns { book → { from, to, first, last } } for one work's books; these are only
// suggestions, never picked by default.
function sequenceGuesses(books) {
  const out = new Map();
  const byWord = new Map();
  for (const b of books) {
    const ext = path.extname(b.fileName);
    const p = parse(b.fileName.slice(0, b.fileName.length - ext.length));
    if (!p) continue;
    if (!byWord.has(p.word)) byWord.set(p.word, []);
    byWord.get(p.word).push({ b, s: p.number, n: parseFloat(p.number) });
  }
  for (const list of byWord.values()) {
    if (list.length < 5) continue;
    const sorted = list.map(x => x.n).filter(Number.isFinite).sort((a, b) => a - b);
    const q = sorted[Math.floor((sorted.length - 1) * 0.8)];
    const regular = sorted.filter(n => n <= q * 1.5 + 10);
    if (regular.length < 5) continue;
    const have = new Set(regular), first = regular[0], last = regular[regular.length - 1];
    for (const x of list) {
      if (!/^\d{3,}$/.test(x.s) || x.n <= last * 1.5 || x.n - last <= 10) continue;
      let best = null;
      for (let i = x.s.length - 1; i >= x.s.length - 1; i--) { // (only the last digit as the decimal: 505 → 50.5)
        const s = x.s.slice(0, i).replace(/^0+(?=\d)/, '') + '.' + x.s.slice(i);
        const v = parseFloat(s);
        if (v >= first && v <= last + 1 && !have.has(v) && have.has(Math.floor(v))) { best = s; break; } // one decimal first (50.5 before 5.05)
      }
      if (best) out.set(x.b, { from: x.s, to: best, first, last });
    }
  }
  return out;
}

const sep = rel => rel.split(/[\\/]/);
function relWithName(relPath, name) {
  const parts = sep(relPath);
  parts[parts.length - 1] = name;
  return parts.join(path.sep);
}

// Proposals for a library ('all' = every library). Each: { bookId, seriesId, libraryId, library, work, from,
// to, fromName, toName, status: 'ok' | 'conflict' | 'exists', with: … } — conflicts are never applied.
// Only the first `limit` proposals are listed (a page can't show 100 000 rows); the counts cover all of them.
// checkDisk: each proposal's file is looked for on disk. If it's not there under its old name but its new name
// is, the database is behind the disk (a scan that trusted an unchanged folder date: Docker bind mounts, network
// shares and FAT drives don't always update it): it isn't proposed again, and `stale` lists the libraries to
// re-check (the caller starts a full check of their files).
const PREVIEW_LIMIT = 2000;
function preview(libraryId, { limit = PREVIEW_LIMIT, checkDisk = false } = {}) {
  const titles = new Map(); // work titles, once per work
  const libs = Object.values(db.libraries).filter(l => !libraryId || libraryId === 'all' || l.id === libraryId);
  const items = [];
  const stale = { count: 0, libraries: new Set() };
  let checked = 0;
  for (const lib of libs) {
    const root = path.resolve(lib.root);
    const books = Object.values(db.books).filter(b => b.libraryId === lib.id);
    const taken = new Map(); // folder\0lowercase name → the book with that file
    const key = (rel, name) => sep(rel).slice(0, -1).join('/') + '\0' + name.toLowerCase();
    for (const b of books) taken.set(key(b.relPath, b.fileName), b);
    // Each work's chapter numbers, to spot one that lost its decimal point
    const bySeries = new Map();
    for (const b of books) { if (!bySeries.has(b.seriesId)) bySeries.set(b.seriesId, []); bySeries.get(b.seriesId).push(b); }
    const guesses = new Map();
    for (const list of bySeries.values()) for (const [b, g] of sequenceGuesses(list)) guesses.set(b, g);
    const props = [];
    for (const b of books) {
      checked++;
      const guess = guesses.get(b) || null;
      const toName = guess ? nameWithNumber(b.fileName, guess.to) : proposedName(b.fileName);
      if (!toName) continue;
      if (checkDisk && !fs.existsSync(path.join(root, b.relPath))) {
        // Gone or already renamed on disk: the database is behind; don't propose it
        stale.count++; stale.libraries.add(lib.id);
        continue;
      }
      const s = db.series[b.seriesId];
      if (s && !titles.has(s.id)) titles.set(s.id, store.seriesMeta(s).title);
      props.push({ b, toName, guess, work: s ? titles.get(s.id) : '' });
    }
    // Conflicts: the new name is another existing file, or two files would get the same name. Every file
    // involved is listed with what helps to choose (pages, size, date, reading progress).
    const fileInfo = (b, role) => {
      const readers = Object.values(store.progress).filter(p => p[b.id]).length;
      return { bookId: b.id, fileName: b.fileName, role, size: b.size || 0, pageCount: b.pageCount || 0, modified: b.fileModified || null, added: b.created || null, readers, error: b.error || null };
    };
    const wanted = new Map();
    for (const x of props) { const k = key(x.b.relPath, x.toName); if (!wanted.has(k)) wanted.set(k, []); wanted.get(k).push(x.b); }
    for (const x of props) {
      const k = key(x.b.relPath, x.toName);
      const other = taken.get(k);
      const rivals = wanted.get(k).filter(b => b !== x.b);
      const status = other && other !== x.b ? 'exists' : rivals.length ? 'conflict' : x.guess ? 'guess' : 'ok';
      const involved = status === 'ok' || status === 'guess' ? undefined
        : [fileInfo(x.b, 'this')].concat(status === 'exists' ? [fileInfo(other, 'has')] : [], rivals.filter(b => b !== other).map(b => fileInfo(b, 'wants')));
      // Same pages and size: very likely the same chapter twice
      if (involved) { const a = involved[0]; involved.forEach(f => { f.same = f !== a && f.pageCount === a.pageCount && f.size === a.size && f.pageCount > 0; }); }
      items.push({
        bookId: x.b.id, seriesId: x.b.seriesId, libraryId: lib.id, library: lib.name, work: x.work,
        from: sep(x.b.relPath).join('/'), to: sep(relWithName(x.b.relPath, x.toName)).join('/'), fromName: x.b.fileName, toName: x.toName,
        status, with: status === 'exists' ? sep(other.relPath).join('/') : undefined,
        size: x.b.size, pageCount: x.b.pageCount, involved,
        guess: x.guess || undefined,
        other: status === 'exists' ? { bookId: other.id, fileName: other.fileName, size: other.size, pageCount: other.pageCount, modified: other.fileModified } : undefined
      });
    }
  }
  items.sort((a, b) => store.collator.compare(a.library + '\0' + a.work, b.library + '\0' + b.work) || store.collator.compare(a.fromName, b.fromName));
  const ok = items.reduce((n, x) => n + (x.status === 'ok' ? 1 : 0), 0);
  const exists = items.reduce((n, x) => n + (x.status === 'exists' ? 1 : 0), 0);
  const guessCount = items.reduce((n, x) => n + (x.status === 'guess' ? 1 : 0), 0);
  return { checked, total: items.length, ok, guesses: guessCount, conflicts: items.length - ok - guessCount, exists, truncated: items.length > limit, items: items.slice(0, limit),
    stale: { count: stale.count, libraries: [...stale.libraries] } };
}

// Folder-source JSON files that describe this book (same name next to it in path mode, or by name)
function jsonFilesFor(b, metadata) {
  const out = [];
  const lib = db.libraries[b.libraryId];
  const indexCache = metadata.indexCache;
  const settings = metadata.librarySettings(lib).providers.filter(p => p.enabled && db.metadataSources[p.id]);
  for (const p of settings) {
    const src = db.metadataSources[p.id];
    const index = indexCache.get(src.id);
    if (!index) continue;
    const { pathKeys, nameKey } = local.bookKeys(b);
    const k = local.findKey(index, src.match, pathKeys, nameKey);
    if (k && index.files.get(k).json) out.push(index.files.get(k).json);
  }
  return out;
}

/* ---------------- renaming: a queue of jobs ----------------
 * Applying is a job: queued, then run one at a time. A job goes through its files in chunks (CHUNK files
 * per message to the rename process, the server yielding between chunks), so even hundreds of thousands of
 * renames don't hold up the server. The rename process (rename-worker.js) is started when a job begins and
 * closed when the queue is empty. Only proposals still valid when their chunk runs are applied (same file,
 * same proposed name, no conflict). */
const CHUNK = 200;
const MAX_QUEUED = 20;
const KEEP_FINISHED = 10;
const jobs = []; // queued, running and the last finished ones (newest last)
let jobSeq = 0, pumping = false;
const state = { worker: null, last: null };

const jobView = j => ({
  id: j.id, kind: j.kind, status: j.status, createdAt: j.createdAt, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null,
  by: j.by || null, total: j.total, done: j.done, renamed: j.renamed, deleted: j.deleted, moved: j.moved, skipped: j.skipped || 0, repeats: j.repeats || [], foldersDeleted: j.foldersDeleted || [], json: j.json, failedCount: j.failed.length, foldersKept: j.foldersKept || [],
  failed: j.failed.slice(0, 50), error: j.error || null, libraries: j.libraries ? [...j.libraries] : [], process: j.process || null,
  phase: j.status === 'queued' ? 'waiting' : j.status === 'running' ? j.phase || 'checking' : null, phaseDetail: j.status === 'running' ? j.phaseDetail || null : null,
  file: j.status === 'running' && j.file ? path.basename(j.file) : null, quietSec: j.status === 'running' && j.progressAt ? Math.floor((Date.now() - j.progressAt) / 1000) : 0,
  waitingFor: j.status === 'queued' ? (jobs.find(x => x.status === 'running') || {}).id || null : null,
  progress: j.total ? Math.min(100, Math.floor(j.done / j.total * 100)) : (j.status === 'done' ? 100 : 0)
});
function info() {
  const running = jobs.find(j => j.status === 'running');
  const w = state.worker;
  return {
    running: running ? { jobId: running.id, pid: w ? w.pid : null, mode: w ? w.mode : null, startedAt: running.startedAt, done: running.done, total: running.total } : null,
    queued: jobs.filter(j => j.status === 'queued').length,
    last: state.last,
    jobs: jobs.map(jobView)
  };
}
const getJob = id => { const j = jobs.find(x => x.id === id); return j ? jobView(j) : null; };

// The rename process for the running job (inline if it can't be started)
function startWorker() {
  if (process.env.THOTH_SCAN_IN_PROCESS === '1') return { mode: 'inline', pid: null };
  let child;
  try { child = fork(path.join(__dirname, 'rename-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' }); }
  catch (e) { console.warn(`[library] couldn't start the rename process (${e.message}); renaming inside the server`); return { mode: 'inline', pid: null }; }
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed here */ }
  const w = { mode: 'process', pid: child.pid, child, pending: new Map(), seq: 0, dead: null };
  child.on('message', m => {
    const p = m && w.pending.get(m.reqId);
    if (!p) return;
    if (m.type === 'progress') { p.at = Date.now(); if (m.r) p.results.push(m.r); if (p.onProgress) p.onProgress(m.done, m.file); return; }
    w.pending.delete(m.reqId);
    if (m.type === 'result') p.resolve(m.result); else p.reject(new Error(m.message));
  });
  const fail = err => { w.dead = err; for (const p of w.pending.values()) p.reject(err); w.pending.clear(); };
  child.on('error', e => fail(e));
  child.on('exit', code => fail(new Error(`Rename process stopped unexpectedly (exit code ${code})`)));
  return w;
}
function stopWorker() {
  const w = state.worker;
  state.worker = null;
  if (w && w.child) { w.child.removeAllListeners('exit'); try { w.child.kill(); } catch { /* gone */ } }
}
// A file operation that doesn't answer for this long (a network drive gone, a disk that hangs) stops the rename
// process: the files done so far keep their results, the rest are reported 'stalled' and the job goes on
const STALL_MS = Number(process.env.THOTH_RENAME_STALL_MS) || 120000;
function runOps(ops, onProgress) {
  let w = state.worker;
  if (!w || w.dead) w = state.worker = startWorker();
  if (w.mode === 'inline') return renameWorker.run(ops, onProgress);
  return new Promise((resolve, reject) => {
    const reqId = ++w.seq;
    const p = { onProgress, results: [], at: Date.now() };
    const finish = () => { clearInterval(watch); w.pending.delete(reqId); };
    p.resolve = r => { finish(); resolve(r); };
    p.reject = e => { finish(); reject(e); };
    const watch = setInterval(() => {
      if (Date.now() - p.at < STALL_MS) return;
      finish();
      const stuck = ops[p.results.length];
      console.warn(`[library] a file operation hasn't answered for ${Math.round(STALL_MS / 1000)} s (${stuck && stuck.from}); restarting the rename process`);
      if (state.worker === w) stopWorker(); else try { w.child.kill(); } catch { /* gone */ }
      resolve(ops.map((op, k) => p.results[k] || { ok: false, error: 'stalled', json: [] }));
    }, Math.min(5000, STALL_MS / 4));
    w.pending.set(reqId, p);
    w.child.send({ type: 'rename', reqId, ops });
  });
}
// What a job is doing: 'waiting' (another job runs) → 'sources' (reading folder sources) → 'checking'
// (the proposals) → 'files'
function setPhase(job, phase, detail) {
  const same = job.phase === phase && !detail;
  job.phase = phase; job.phaseDetail = detail || null; job.progressAt = Date.now();
  if (job.task && !same) job.task.log(phase === 'sources' ? `reading the folder source "${detail.name}" (${detail.n} of ${detail.of})` : phase === 'files' ? `${job.total} file(s) to go through` : phase);
}
const JOB_TITLES = { rename: 'Renaming files', delete: 'Deleting files', merge: 'Merging works' };

// kind 'rename': picks = [{ bookId, toName }] or { all: true, library, exclude: [bookId] } (every valid proposal)
// kind 'delete': picks = [{ bookId, replace? }] (replace: delete the file holding this book's proposed name, then
//   rename this one) or { allExists: true, library, keep: 'existing' | 'renamed' } (every "name exists" proposal)
// kind 'merge':  picks = { target: seriesId, sources: [seriesId] } (their files move into the target's folder)
function enqueue(picks, { kind = 'rename', renameJson = true, metadata, by, onDone } = {}) {
  if (jobs.filter(j => j.status === 'queued').length >= MAX_QUEUED) throw Object.assign(new Error('Too many file jobs waiting'), { status: 429, code: 'renameQueueFull' });
  const job = { id: 'r' + (++jobSeq), kind, status: 'queued', createdAt: new Date().toISOString(), by, picks, renameJson, metadata, onDone,
    total: Array.isArray(picks) ? picks.length : 0, done: 0, renamed: 0, deleted: 0, moved: 0, json: 0, failed: [], libraries: new Set() };
  jobs.push(job);
  setImmediate(pump);
  return jobView(job);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let job;
    while ((job = jobs.find(j => j.status === 'queued'))) {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      // A task for the Processes page's Tasks tab, with its own log file
      job.task = require('./tasks').start({ kind: 'files', title: `${JOB_TITLES[job.kind] || job.kind}` + (job.by ? ` (by ${job.by})` : ''),
        progress: () => { const v = jobView(job); return { percent: v.progress, done: v.done, total: v.total, phase: v.phase, detail: v.file || null }; } });
      setPhase(job, 'checking');
      try { await (job.kind === 'delete' ? runDeleteJob(job) : job.kind === 'merge' ? runMergeJob(job) : runJob(job)); job.status = 'done'; } catch (e) { job.status = 'failed'; job.error = e.message; console.error('[library] rename job failed:', e.message); }
      job.finishedAt = new Date().toISOString();
      for (const f of job.failed.slice(0, 1000)) job.task.log('not done:', f.from, '-', f.error);
      job.task.end(job.status === 'failed' ? 'failed' : 'done', job.status === 'failed' ? job.error : [job.renamed && `renamed ${job.renamed}`, job.deleted && `deleted ${job.deleted}`, job.moved && `moved ${job.moved}`, job.failed.length && `${job.failed.length} not done`].filter(Boolean).join(', ') || 'nothing to do');
      const w = state.worker;
      state.last = { at: job.finishedAt, files: job.total, renamed: job.renamed, mode: w ? w.mode : null, pid: w ? w.pid : null, durationMs: Date.parse(job.finishedAt) - Date.parse(job.startedAt) };
      job.process = w ? { mode: w.mode, pid: w.pid } : null;
      delete job.picks; delete job.metadata;
      if (job.onDone) try { job.onDone(jobView(job)); } catch (e) { console.error('[library] after renaming:', e.message); }
      // Keep only the last finished jobs
      const finished = jobs.filter(j => j.status === 'done' || j.status === 'failed');
      for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.splice(jobs.indexOf(old), 1);
    }
  } finally {
    stopWorker(); // nothing left: close the rename process
    pumping = false;
  }
}

async function runJob(job) {
  const { renameJson, metadata } = job;
  // The indexes of the folder sources the libraries use (to find the JSON files): reading a big folder takes
  // a while after a restart, so the job says which one it is reading
  if (renameJson && metadata) {
    const ids = new Set();
    for (const lib of Object.values(db.libraries)) for (const p of metadata.librarySettings(lib).providers) if (p.enabled && db.metadataSources[p.id]) ids.add(p.id);
    await metadata.warmIndexes(ids, (src, i, n) => setPhase(job, 'sources', { name: src.name, n: i + 1, of: n }));
  }
  // The proposals as they are now (conflicts included, to say why something isn't renamed)
  setPhase(job, 'checking');
  await new Promise(r => setImmediate(r));
  const current = new Map(preview('all', { limit: Infinity }).items.map(x => [x.bookId, x]));
  let picks = job.picks;
  if (!Array.isArray(picks)) {
    // Every sure proposal but the excluded ones, plus the guesses (a missing decimal point) ticked one by one
    const exclude = new Set(picks.exclude || []), include = new Set(picks.include || []);
    picks = [...current.values()].filter(x => (x.status === 'ok' ? !exclude.has(x.bookId) : x.status === 'guess' && include.has(x.bookId)) && (!picks.library || picks.library === 'all' || x.libraryId === picks.library))
      .map(x => ({ bookId: x.bookId, toName: x.toName }));
  }
  job.total = picks.length;
  setPhase(job, 'files');
  for (let i = 0; i < picks.length; i += CHUNK) {
    const chunk = picks.slice(i, i + CHUNK);
    const todo = [];
    for (const pick of chunk) {
      const x = current.get(pick.bookId);
      const b = x && db.books[x.bookId];
      // Still the same file with the same proposal?
      if (!x || !b || x.toName !== pick.toName || b.fileName !== x.fromName) { job.failed.push({ from: (x && x.from) || pick.from || pick.bookId, error: 'changed' }); continue; }
      if (x.status !== 'ok' && x.status !== 'guess') { job.failed.push({ from: x.from, error: x.status }); continue; } // (a guess only when picked)
      const lib = db.libraries[b.libraryId];
      if (!lib) { job.failed.push({ from: x.from, error: 'changed' }); continue; }
      const root = path.resolve(lib.root);
      const fromAbs = path.resolve(root, b.relPath);
      const newRel = relWithName(b.relPath, x.toName);
      const toAbs = path.resolve(root, newRel);
      if (!fromAbs.startsWith(root + path.sep) || !toAbs.startsWith(root + path.sep)) { job.failed.push({ from: x.from, error: 'outside the library folder' }); continue; }
      // The JSON files that described it get the same new name (".json" kept)
      const jsonOps = (renameJson && metadata ? jsonFilesFor(b, metadata) : [])
        .map(jf => ({ from: jf, to: path.join(path.dirname(jf), path.basename(x.toName, path.extname(x.toName)) + '.json') }));
      todo.push({ x, b, lib, newRel, op: { from: fromAbs, to: toAbs, json: jsonOps } });
    }
    const base = job.done;
    const results = todo.length ? await runOps(todo.map(t => t.op), (n, file) => { job.done = base + Math.round(n / todo.length * chunk.length); job.file = file; job.progressAt = Date.now(); }) : [];
    const moved = new Map();
    todo.forEach((t, k) => {
      const r = results[k] || { ok: false, error: 'not done', json: [] };
      if (!r.ok) { job.failed.push({ from: t.x.from, error: r.error }); return; }
      moved.set(t.b.id, moveBook(t.b, t.newRel));
      job.renamed++;
      job.libraries.add(t.lib.id);
      for (const j of r.json) { if (j.ok) job.json++; else job.failed.push({ from: j.from, error: 'JSON: ' + j.error }); }
    });
    // Read lists follow the renamed books (once per chunk)
    if (moved.size) for (const rl of Object.values(db.readlists)) if (rl.bookIds.some(id => moved.has(id))) rl.bookIds = rl.bookIds.map(id => moved.get(id) || id);
    job.done = base + chunk.length;
    if (moved.size) { store.saveLibrary(); store.saveProgress(); }
    // Indexes now and then (cheap enough) and let the server answer requests between chunks
    if ((i / CHUNK) % 10 === 9) store.reindex();
    await new Promise(r => setImmediate(r));
  }
  store.reindex();
  store.saveLibrary();
  store.saveProgress();
}

/* ---------------- deleting files (a "name exists" proposal: keep one of the two) ---------------- */
const absOf = b => { const lib = db.libraries[b.libraryId]; if (!lib) return null; const root = path.resolve(lib.root); const a = path.resolve(root, b.relPath); return a.startsWith(root + path.sep) ? a : null; };
// A deleted file's book disappears with its reading progress and read-list entries (its work goes with the
// quick scan afterwards if nothing is left in it)
function removeBooks(ids) {
  if (!ids.size) return;
  for (const id of ids) delete db.books[id];
  for (const user of Object.keys(store.progress)) { const p = store.progress[user]; for (const id of ids) delete p[id]; }
  for (const rl of Object.values(db.readlists)) if (rl.bookIds.some(id => ids.has(id))) rl.bookIds = rl.bookIds.filter(id => !ids.has(id));
}
async function runDeleteJob(job) {
  const current = new Map(preview('all', { limit: Infinity }).items.map(x => [x.bookId, x]));
  let picks = job.picks;
  if (!Array.isArray(picks)) {
    const replace = picks.keep === 'renamed';
    picks = [...current.values()].filter(x => x.status === 'exists' && (!picks.library || picks.library === 'all' || x.libraryId === picks.library))
      .map(x => ({ bookId: x.bookId, replace }));
  }
  job.total = picks.length;
  setPhase(job, 'files');
  for (let i = 0; i < picks.length; i += CHUNK) {
    const chunk = picks.slice(i, i + CHUNK);
    const todo = [], ops = [];
    for (const pick of chunk) {
      const b = db.books[pick.bookId];
      const from = b && absOf(b);
      if (!b || !from) { job.failed.push({ from: pick.bookId, error: 'changed' }); continue; }
      if (!pick.replace) { todo.push({ b, at: ops.length, n: 1 }); ops.push({ kind: 'delete', from }); continue; }
      // Keep this one under its new name: the file that has that name goes first
      const x = current.get(b.id);
      const other = x && x.status === 'exists' && x.other && db.books[x.other.bookId];
      const otherAbs = other && absOf(other);
      if (!otherAbs || b.fileName !== x.fromName) { job.failed.push({ from: x ? x.from : b.relPath, error: 'changed' }); continue; }
      const newRel = relWithName(b.relPath, x.toName);
      todo.push({ b, other, newRel, at: ops.length, n: 2, from: x.from });
      ops.push({ kind: 'delete', from: otherAbs }, { kind: 'rename', from, to: path.resolve(path.dirname(from), x.toName) });
    }
    const base = job.done;
    const results = ops.length ? await runOps(ops, (n, file) => { job.done = base + Math.round(n / ops.length * chunk.length); job.file = file; job.progressAt = Date.now(); }) : [];
    const gone = new Set(), renames = [];
    for (const t of todo) {
      const r1 = results[t.at] || { ok: false, error: 'not done' };
      if (t.n === 1) {
        if (r1.ok || r1.error === 'missing') { gone.add(t.b.id); job.deleted++; job.libraries.add(t.b.libraryId); }
        else job.failed.push({ from: t.b.relPath.split(/[\\/]/).join('/'), error: r1.error });
        continue;
      }
      const r2 = results[t.at + 1] || { ok: false, error: 'not done' };
      if (r1.ok || r1.error === 'missing') { gone.add(t.other.id); job.deleted++; job.libraries.add(t.other.libraryId); }
      else { job.failed.push({ from: t.other.relPath.split(/[\\/]/).join('/'), error: r1.error }); continue; }
      if (r2.ok) { renames.push(t); job.renamed++; } else job.failed.push({ from: t.from, error: r2.error });
    }
    // Deleted books first: a kept file takes the deleted one's name, so its new id is the deleted book's id
    removeBooks(gone);
    for (const t of renames) moveBook(t.b, t.newRel);
    job.done = base + chunk.length;
    if (gone.size) { store.saveLibrary(); store.saveProgress(); }
    await new Promise(r => setImmediate(r));
  }
  store.reindex();
  store.saveLibrary();
  store.saveProgress();
}

/* ---------------- merging works: missing chapters move into the kept work's folder ----------------
 * A chapter the kept work already has (same file name, or the same chapter: "chapter-2.cbz" = "Chapter 2.cbz"
 * = "Chapter 2 - Title.cbz", also by the number from the book's own metadata) is a repeat: it isn't moved.
 * With deleteSources, the other works' folders are deleted afterwards with what's left in them (the repeats);
 * a one-shot source's file goes if it was a repeat. */
const extless = f => f.replace(/\.[^.]+$/, '');
// The ways a book can be "the same chapter" as another
function chapterKeys(b) {
  const keys = new Set();
  const name = extless(b.fileName);
  keys.add('n:' + name.toLowerCase());
  const better = proposedName(b.fileName);
  if (better) keys.add('n:' + extless(better).toLowerCase());
  const p = parse(name);
  if (p) keys.add('c:' + p.word.toLowerCase() + ':' + p.number);
  // An explicit number from the book's ComicInfo/JSON (not the position-based fallback)
  const own = (b.overrides && b.overrides.number) || (b.local && b.local.merged && b.local.merged.number) || (b.meta && b.meta.number);
  if (own != null && own !== '') { const n = String(own).trim().replace(/^0+(?=\d)/, ''); if (n) keys.add('c:chapter:' + n); }
  return [...keys];
}
// A work's folder that may be deleted as a whole: inside its library, not the library itself, and neither
// inside nor around the kept work's folder
function deletableFolder(s, tDir) {
  const lib = db.libraries[s.libraryId];
  if (!lib || s.oneshot || !s.relPath) return null;
  const root = path.resolve(lib.root), dir = path.resolve(root, s.relPath);
  if (!dir.startsWith(root + path.sep) || dir === root) return null;
  if (tDir === dir || tDir.startsWith(dir + path.sep) || dir.startsWith(tDir + path.sep)) return null;
  return dir;
}
async function runMergeJob(job) {
  const { target, sources, deleteSources } = job.picks;
  const t = db.series[target];
  const tLib = t && db.libraries[t.libraryId];
  if (!t || !tLib || t.oneshot) throw Object.assign(new Error('The work to merge into must be a folder'), { code: 'mergeTarget' });
  const tRoot = path.resolve(tLib.root);
  const tDir = path.resolve(tRoot, t.relPath);
  if (!tDir.startsWith(tRoot + path.sep)) throw new Error('outside the library folder');
  const srcs = (sources || []).map(id => db.series[id]).filter(s => s && s.id !== t.id);
  // The kept work gets the other works' titles it doesn't have (their main title and alternative titles) as
  // alternative titles: saved apart (s.mergedTitles), so they stay when its metadata is refreshed
  {
    const tm = store.seriesMeta(t);
    const have = new Set([tm.title].concat(tm.altTitles).map(store.titleKey));
    const add = [];
    for (const s of srcs) {
      const sm = store.seriesMeta(s);
      for (const title of [sm.title].concat(sm.altTitles, s.mergedTitles || [])) { const k = store.titleKey(title); if (k && !have.has(k)) { have.add(k); add.push(title); } }
    }
    if (add.length) { t.mergedTitles = (t.mergedTitles || []).concat(add); job.titlesAdded = add; if (job.task) job.task.log('alternative titles added:', add.join(' | ')); }
    // English first: when the kept work's title isn't English and a merged work's is, that becomes its title
    // (unless an administrator set the title; the old one stays among the other titles)
    const best = require('./titles').preferEnglish([tm.title].concat(srcs.map(s => store.seriesMeta(s).title)));
    if (best && best !== tm.title && !(t.overrides && t.overrides.title)) {
      t.overrides = Object.assign({}, t.overrides, { title: best });
      if (!(t.mergedTitles || []).some(x => store.titleKey(x) === store.titleKey(tm.title))) t.mergedTitles = (t.mergedTitles || []).concat(tm.title);
      job.titleChanged = { from: tm.title, to: best };
      if (job.task) job.task.log(`title: "${tm.title}" → "${best}" (English)`);
    }
  }
  // What the kept work already has (and what earlier files of this merge bring): names and chapters
  const names = new Set(store.booksOf(t.id).map(b => b.fileName.toLowerCase()));
  const have = new Set(store.booksOf(t.id).flatMap(chapterKeys));
  job.skipped = 0; job.repeats = [];
  const plan = [];
  for (const s of srcs) for (const b of store.booksOf(s.id).slice()) plan.push({ s, b });
  job.total = plan.length;
  setPhase(job, 'files');
  for (let i = 0; i < plan.length; i += CHUNK) {
    const chunk = plan.slice(i, i + CHUNK);
    const todo = [];
    for (const { s, b } of chunk) {
      const from = absOf(b);
      if (!from || db.books[b.id] !== b) { job.failed.push({ from: b.relPath, error: 'changed' }); continue; }
      const keys = chapterKeys(b);
      if (keys.some(k => have.has(k))) {
        // A repeat: the kept work has this chapter already
        job.skipped++;
        if (job.repeats.length < 50) job.repeats.push(b.relPath.split(/[\\/]/).join('/'));
        continue;
      }
      if (names.has(b.fileName.toLowerCase())) { job.failed.push({ from: b.relPath.split(/[\\/]/).join('/'), error: 'exists' }); continue; }
      names.add(b.fileName.toLowerCase());
      keys.forEach(k => have.add(k));
      todo.push({ s, b, keys, newRel: path.join(t.relPath, b.fileName), op: { kind: 'move', from, to: path.join(tDir, b.fileName) } });
    }
    const base = job.done;
    const results = todo.length ? await runOps(todo.map(x => x.op), (n, file) => { job.done = base + Math.round(n / todo.length * chunk.length); job.file = file; job.progressAt = Date.now(); }) : [];
    const moved = new Map();
    todo.forEach((x, k) => {
      const r = results[k] || { ok: false, error: 'not done' };
      if (!r.ok) { names.delete(x.b.fileName.toLowerCase()); job.failed.push({ from: x.b.relPath.split(/[\\/]/).join('/'), error: r.error }); return; }
      job.libraries.add(x.b.libraryId);
      x.b.libraryId = t.libraryId;
      moved.set(x.b.id, moveBook(x.b, x.newRel));
      x.b.seriesId = t.id;
      job.moved++;
    });
    if (moved.size) for (const rl of Object.values(db.readlists)) if (rl.bookIds.some(id => moved.has(id))) rl.bookIds = rl.bookIds.map(id => moved.get(id) || id);
    job.done = base + chunk.length;
    if (moved.size) { store.reindex(); store.saveLibrary(); store.saveProgress(); }
    await new Promise(r => setImmediate(r));
  }
  job.libraries.add(t.libraryId);
  store.reindex();
  // The other works: deleted with their folders when asked (repeats included), else removed when emptied
  const ops = [], after = [];
  job.foldersDeleted = [];
  for (const s of srcs) {
    const left = store.booksOf(s.id).slice();
    const dir = deleteSources ? deletableFolder(s, tDir) : null;
    if (deleteSources && dir) { ops.push({ kind: 'rmtree', from: dir }); after.push({ s, left, all: true, rel: s.relPath }); continue; }
    if (deleteSources && s.oneshot && left.length) {
      // A one-shot: its file goes only if it was a repeat (anything else would have moved)
      for (const b of left) { const a = absOf(b); if (a) { ops.push({ kind: 'delete', from: a }); after.push({ s, left: [b], file: true }); } }
      continue;
    }
    if (left.length) { if (deleteSources) job.failed.push({ from: String(s.relPath || '').split(/[\\/]/).join('/'), error: 'notDeletable' }); continue; }
    const lib = db.libraries[s.libraryId];
    if (!s.oneshot && lib && s.relPath) {
      const root = path.resolve(lib.root), d = path.resolve(root, s.relPath);
      if (d.startsWith(root + path.sep)) { ops.push({ kind: 'rmdir', from: d }); after.push({ s, left: [], rmdir: true, rel: s.relPath }); continue; }
    }
    after.push({ s, left: [], none: true });
  }
  const res = ops.length ? await runOps(ops) : [];
  job.foldersKept = [];
  const gone = new Set();
  let k = 0;
  for (const a of after) {
    const r = a.none ? { ok: true } : res[k++] || { ok: false, error: 'not done' };
    const rel = String(a.rel || '').split(/[\\/]/).join('/');
    if (a.all) {
      if (r.ok || r.error === 'missing') { a.left.forEach(b => gone.add(b.id)); job.deleted += a.left.length; job.foldersDeleted.push(rel); }
      else { job.failed.push({ from: rel, error: r.error }); continue; }
    } else if (a.file) {
      if (r.ok || r.error === 'missing') { gone.add(a.left[0].id); job.deleted++; } else { job.failed.push({ from: a.left[0].relPath, error: r.error }); continue; }
    } else if (a.rmdir && !r.ok) job.foldersKept.push(rel); // other (non-book) files are still in it
    if (a.left.some(b => !gone.has(b.id))) continue; // the work still has books
    for (const c of Object.values(db.collections)) if (c.seriesIds.includes(a.s.id)) c.seriesIds = [...new Set(c.seriesIds.map(id => (id === a.s.id ? t.id : id)))];
    if (job.metadata) job.metadata.forgetSeries(a.s);
    delete db.series[a.s.id];
  }
  removeBooks(gone);
  t.updated = new Date().toISOString();
  store.reindex();
  store.saveLibrary();
  store.saveProgress();
}

/* ---------------- works that look like the same work (merge suggestions) ----------------
 * Two works (series of the same version: Regular with Regular…) are suggested together when their metadata
 * says they're one: matched to the same entry of a metadata site, sharing a link, or sharing a title (main or
 * alternative, ignoring case/punctuation). Different versions (Colored, Raw…) are never suggested: they're
 * grouped as versions already. Groups an administrator dismissed ("not the same") aren't suggested again. */
const REASONS = ['match', 'link', 'title']; // strongest first
function mergeSuggestions({ library = 'all', limit = 200 } = {}) {
  const { normTitle } = require('./metadata/providers');
  const dismissed = new Set((db.settings && db.settings.mergeDismissed) || []);
  const list = Object.values(db.series).filter(s => !s.hidden && (library === 'all' || !library || s.libraryId === library));
  const meta = new Map(list.map(s => [s.id, store.seriesMeta(s)]));
  const parent = new Map(list.map(s => [s.id, s.id]));
  const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
  const why = new Map(); // root → { reason, detail }
  // Works kept apart (merged separately from one suggestion): never put in the same suggestion again
  const apart = new Set((db.settings && db.settings.mergeApart) || []);
  const members = new Map(list.map(s => [s.id, [s.id]])); // root → its works
  const separated = (ra, rb) => apart.size && members.get(ra).some(x => members.get(rb).some(y => apart.has(x < y ? x + '|' + y : y + '|' + x)));
  const keys = new Map(); // `${reason}\0${key}` → [series ids]
  const add = (reason, key, id, detail) => { if (!key) return; const k = reason + '\0' + key; if (!keys.has(k)) keys.set(k, { ids: [], detail }); const e = keys.get(k); if (!e.ids.includes(id)) e.ids.push(id); };
  for (const s of list) {
    for (const m of (s.provider && s.provider.matches) || []) add('match', m.provider + ':' + m.id, s.id, { provider: m.provider, id: m.id });
    for (const url of meta.get(s.id).links) add('link', String(url).replace(/\/+$/, '').toLowerCase(), s.id, { url });
    const m = meta.get(s.id);
    for (const title of [m.title, s.name].concat(m.altTitles || [])) { const n = normTitle(title); if (n && n.length > 2) add('title', n, s.id, { title }); }
  }
  for (const [k, e] of keys) {
    if (e.ids.length < 2 || e.ids.length > 20) continue; // (a key shared by dozens of works says nothing)
    const reason = k.split('\0')[0];
    for (let i = 1; i < e.ids.length; i++) {
      const a = e.ids[0], b = e.ids[i];
      if (meta.get(a).edition !== meta.get(b).edition) continue; // versions of one work, not duplicates
      const ra = find(a), rb = find(b);
      if (ra !== rb && separated(ra, rb)) continue;
      const best = [why.get(ra), why.get(rb), { reason, detail: e.detail }].filter(Boolean).sort((x, y) => REASONS.indexOf(x.reason) - REASONS.indexOf(y.reason))[0];
      if (ra !== rb) { parent.set(rb, ra); members.set(ra, members.get(ra).concat(members.get(rb))); }
      why.set(find(a), best);
    }
  }
  const groups = new Map();
  for (const s of list) { const r = find(s.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); }
  const out = [];
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    const key = members.map(s => s.id).sort().join(',');
    if (dismissed.has(key)) continue;
    const works = members.map(s => {
      const m = meta.get(s.id), lib = db.libraries[s.libraryId] || {};
      return { id: s.id, title: m.title, edition: m.edition, libraryId: s.libraryId, library: lib.name || '', path: String(s.relPath || '').split(/[\\/]/).join('/'),
        oneshot: Boolean(s.oneshot), books: store.booksOf(s.id).length, matched: Boolean(s.provider && (s.provider.matches || []).length) };
    }).sort((a, b) => (a.oneshot - b.oneshot) || (b.books - a.books) || store.collator.compare(a.path, b.path));
    // Suggested target: a folder work, the one with the most books
    const target = (works.find(w => !w.oneshot) || {}).id || null;
    out.push(Object.assign({ key, works, target }, why.get(root) || { reason: 'title', detail: {} }));
  }
  out.sort((a, b) => REASONS.indexOf(a.reason) - REASONS.indexOf(b.reason) || store.collator.compare(a.works[0].title, b.works[0].title));
  return { total: out.length, groups: out.slice(0, limit) };
}
// Works merged separately out of one suggestion (each merge's kept work): kept apart from then on
function keepApart(ids) {
  const s = new Set((db.settings && db.settings.mergeApart) || []);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) s.add(ids[i] < ids[j] ? ids[i] + '|' + ids[j] : ids[j] + '|' + ids[i]);
  db.settings.mergeApart = [...s].slice(-20000);
  store.saveLibrary();
}
function dismissSuggestion(key) {
  db.settings.mergeDismissed = [...new Set(((db.settings.mergeDismissed) || []).concat(String(key)))].slice(-5000);
  store.saveLibrary();
}

// Waits for a job to finish (tests, small batches): resolves with its final view
function waitFor(id, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function check() {
      const j = getJob(id);
      if (!j) return reject(new Error('unknown job'));
      if (j.status === 'done' || j.status === 'failed') return resolve(j);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout'));
      setTimeout(check, 50);
    })();
  });
}

// A renamed file's book gets the id of its new path; reading progress follows it. Returns the new id.
function moveBook(b, newRel) {
  const oldId = b.id;
  const newId = store.stableId(b.libraryId, 'book', newRel);
  delete db.books[oldId];
  b.id = newId;
  b.relPath = newRel;
  b.fileName = path.basename(newRel);
  db.books[newId] = b;
  for (const user of Object.keys(store.progress)) {
    const p = store.progress[user];
    if (p[oldId]) { p[newId] = p[oldId]; delete p[oldId]; }
  }
  return newId;
}

// The examples the Rename page shows, worked out with the rules themselves (so they never go stale)
const EXAMPLES = ['chapter-0.cbz', 'chapter-1.1.cbz', 'chapter-1x1.cbz', 'Chapter 001.cbz', 'chapter-1-chapter name.cbz',
  'chapter-83-the-end.cbz', 'Chapter 5 - Spider-Man.cbz', 'ch_12_the_end.cbz', 'vol.3.cbz', 'ep-04.pdf', 'Saga 001.cbz'];
function examples() { return EXAMPLES.map(f => ({ from: f, to: proposedName(f) })); }

module.exports = { sequenceGuesses, preview, enqueue, waitFor, getJob, proposedName, parse, info, examples, mergeSuggestions, dismissSuggestion, keepApart };
