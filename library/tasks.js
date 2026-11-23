// Tasks: everything long-running the server does (library scans, metadata lookups, file jobs, catalog crawls)
// as one list for the Processes page's Tasks tab, each with its own log file in data/logs/ (the Logs page lists,
// shows and downloads them; they're deleted after Server settings → logRetentionDays).
//
//   const task = tasks.start({ kind: 'scan', title: 'Quick scan of "Comics"', progress: () => ({ percent, etaMs, … }),
//                              cancel: () => …, logFile? })
//   task.log('read 120 files')          a timestamped line in its log file
//   task.end('done' | 'failed' | 'stopped', 'summary line')
//
// A task's progress is read when asked (progress()), so the code doing the work keeps its own status as before.
// A task done in another process (a catalog crawl) writes its log itself: start() takes that file (logFile) and
// the server only reads it.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = path.resolve(process.env.THOTH_DATA_DIR || path.join(__dirname, '..', 'data'));
const LOG_DIR = path.join(DATA_DIR, 'logs');
const KEEP_FINISHED = 60; // in the Tasks list (their logs stay on disk)
const KINDS = ['scan', 'metadata', 'files', 'crawl', 'covers', 'other'];

const tasks = []; // running and the last finished ones (newest last)
let seq = 0;

const stamp = d => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261123-104512
const safeKind = k => (KINDS.includes(k) ? k : 'other');
function logPathFor(kind, id, at) { return path.join(LOG_DIR, `${stamp(at)}_${safeKind(kind)}_${id}.log`); }
function appendLine(file, line) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(file, line + '\n'); } catch (e) { /* a full disk mustn't stop the work */ }
}
const timeOf = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function start({ kind = 'other', title, progress = null, cancel = null, logFile = null, id = null, startedAt = null } = {}) {
  const at = startedAt ? new Date(startedAt) : new Date();
  const tid = String(id || 't' + Date.now().toString(36) + (++seq)).replace(/[^\w-]/g, '');
  const t = {
    id: tid, kind: safeKind(kind), title: String(title || kind), status: 'running',
    startedAt: at.toISOString(), finishedAt: null, summary: null, progressFn: progress, cancelFn: cancel, lastProgress: null,
    file: logFile || logPathFor(kind, tid, at), external: Boolean(logFile)
  };
  if (!t.external) appendLine(t.file, `# ${t.title}\n${timeOf()} started`);
  tasks.push(t);
  return {
    id: t.id, file: t.file,
    log: (...parts) => { if (!t.external) appendLine(t.file, `${timeOf()} ${parts.join(' ')}`); },
    end: (status = 'done', summary = null) => end(t, status, summary)
  };
}
function end(t, status, summary) {
  if (t.status !== 'running') return;
  try { t.lastProgress = t.progressFn ? t.progressFn() : null; } catch { /* gone */ }
  t.status = status; t.summary = summary; t.finishedAt = new Date().toISOString();
  if (!t.external) appendLine(t.file, `${timeOf()} ${status}${summary ? ': ' + summary : ''}`);
  const finished = tasks.filter(x => x.status !== 'running');
  for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) tasks.splice(tasks.indexOf(old), 1);
}
// A running task by id (for code that keeps only the id), or one done in another process found again
const find = id => tasks.find(t => t.id === id) || null;
function endById(id, status, summary) { const t = find(id); if (t) end(t, status, summary); }

function view(t) {
  let progress = t.lastProgress;
  if (t.status === 'running' && t.progressFn) try { progress = t.progressFn(); } catch { progress = null; }
  return { id: t.id, kind: t.kind, title: t.title, status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt, summary: t.summary,
    progress: progress || null, canStop: t.status === 'running' && Boolean(t.cancelFn), log: path.basename(t.file) };
}
function list() {
  const all = tasks.map(view);
  return { running: all.filter(t => t.status === 'running').reverse(), recent: all.filter(t => t.status !== 'running').reverse(), retentionDays: retentionDays() };
}
// The end of a log file (what the console view shows): the last `lines` lines
function tail(file, lines = 200) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const text = buf.toString('utf8').split('\n');
    if (size < st.size) text.shift(); // (a partial first line)
    return text.filter((l, i) => l !== '' || i < text.length - 1).slice(-lines);
  } catch { return []; }
}
function get(id, { lines = 200 } = {}) {
  const t = find(id);
  if (!t) return null;
  return Object.assign(view(t), { lines: tail(t.file, lines) });
}
function stop(id) {
  const t = find(id);
  if (!t || t.status !== 'running' || !t.cancelFn) return false;
  try { t.cancelFn(); } catch (e) { return false; }
  return true;
}

/* ---------------- the Logs page ---------------- */
const NAME = /^(\d{8}-\d{6})_([a-z]+)_([\w-]+)\.log$/;
function titleOf(file) {
  try {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(400); const n = fs.readSync(fd, buf, 0, 400, 0); fs.closeSync(fd);
    const first = buf.slice(0, n).toString('utf8').split('\n')[0];
    return first.startsWith('# ') ? first.slice(2).trim() : null;
  } catch { return null; }
}
// { logs: [{ name, kind, taskId, at, size, modified, title, running }] } newest first; kind/q filter
function listLogs({ kind = null, q = '' } = {}) {
  let names = [];
  try { names = fs.readdirSync(LOG_DIR).filter(n => NAME.test(n)); } catch { /* none yet */ }
  const runningFiles = new Set(tasks.filter(t => t.status === 'running').map(t => path.basename(t.file)));
  const term = String(q || '').toLowerCase();
  const out = [];
  for (const name of names.sort().reverse()) {
    const [, at, k, taskId] = NAME.exec(name);
    if (kind && k !== kind) continue;
    let st; try { st = fs.statSync(path.join(LOG_DIR, name)); } catch { continue; }
    const title = titleOf(path.join(LOG_DIR, name));
    if (term && !(String(title || '') + ' ' + name).toLowerCase().includes(term)) continue;
    out.push({ name, kind: k, taskId, at: `${at.slice(0, 4)}-${at.slice(4, 6)}-${at.slice(6, 8)}T${at.slice(9, 11)}:${at.slice(11, 13)}:${at.slice(13, 15)}Z`,
      size: st.size, modified: st.mtime.toISOString(), title, running: runningFiles.has(name) });
    if (out.length >= 1000) break;
  }
  return { logs: out, retentionDays: retentionDays(), kinds: KINDS };
}
// A log file's path, only for names the Logs page lists (no other file can be reached through it)
function logFile(name) {
  if (!NAME.test(String(name || ''))) return null;
  const file = path.join(LOG_DIR, name);
  return fs.existsSync(file) ? file : null;
}
function deleteLog(name) {
  const file = logFile(name);
  if (!file) return false;
  if (tasks.some(t => t.status === 'running' && t.file === file)) throw Object.assign(new Error('That task is still running'), { status: 409, code: 'logInUse' });
  fs.rmSync(file, { force: true });
  return true;
}

/* ---------------- keeping logs for so many days ---------------- */
function retentionDays() { return Math.max(1, Number(config.get().logRetentionDays) || 30); }
function cleanup() {
  const limit = Date.now() - retentionDays() * 86400000;
  const running = new Set(tasks.filter(t => t.status === 'running').map(t => t.file));
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(LOG_DIR); } catch { return 0; }
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const file = path.join(LOG_DIR, name);
    if (running.has(file)) continue;
    try { if (fs.statSync(file).mtimeMs < limit) { fs.rmSync(file, { force: true }); removed++; } } catch { /* gone */ }
  }
  if (removed) console.log(`[logs] ${removed} log file(s) older than ${retentionDays()} days deleted`);
  return removed;
}
let cleanupTimer = null;
function startCleanup() {
  if (cleanupTimer) return;
  setTimeout(cleanup, 10000).unref();
  cleanupTimer = setInterval(cleanup, 3600000);
  cleanupTimer.unref();
}
config.onChange(changed => { if (changed.includes('logRetentionDays')) cleanup(); });

module.exports = { start, find, endById, list, get, stop, tail, listLogs, logFile, deleteLog, cleanup, startCleanup, logPathFor, LOG_DIR, KINDS };
