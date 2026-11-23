// An independent crawl: `node crawler.js <source folder>`, started detached by catalog/index.js. It doesn't
// depend on the server: it keeps going if the server restarts or stops, and talks to it only through files
// in the source's folder (data/catalog/<source>/):
//   job.json       what to do: { jobId, source (settings), mode: 'full' | 'update', allowLocal, reason, concurrency }
//   progress.json  { jobId, pid, status: 'running' | 'done' | 'failed' | 'stopped', startedAt, heartbeatAt,
//                    finishedAt, progress, result, error } (written every second while it runs)
//   stop           present → finish the current work, save, end (removed when it ends)
//   crawl.log      its output (also in job.logFile, the task's log in data/logs/)
// Lowest CPU priority; never touches the library database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const worker = require('./worker');

const dir = path.resolve(process.argv[2] || '');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const job = read('job.json', null);
if (!job || !job.source) { console.error('[crawler] no job.json in', dir); process.exit(2); }
try { os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed here */ }

const state = { jobId: job.jobId, sourceId: job.source.id, mode: job.mode, reason: job.reason || null, pid: process.pid, status: 'running',
  startedAt: new Date().toISOString(), heartbeatAt: null, finishedAt: null, progress: null, result: null, error: null };
function save() {
  state.heartbeatAt = new Date().toISOString();
  const file = path.join(dir, 'progress.json'), tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(state)); require('./store').replaceFile(tmp, file); } catch (e) { console.error('[crawler] progress:', e.message); }
}
save();
const beat = setInterval(() => {
  save();
  if (fs.existsSync(path.join(dir, 'stop')) && worker.stop()) console.log('[crawler] stop asked: saving and ending');
}, 1000);

// Its output: crawl.log (stdout) and the task's log file the server shows (job.logFile)
const log = (...a) => {
  console.log(new Date().toISOString(), ...a);
  if (job.logFile) try { fs.appendFileSync(job.logFile, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + a.join(' ').replace(/^\[crawler\] /, '') + '\n'); } catch { /* best effort */ }
};
log(`[crawler] ${job.mode} crawl of "${job.source.name}" (pid ${process.pid})`);
worker.crawl({ reqId: 1, source: job.source, dir, mode: job.mode, allowLocal: Boolean(job.allowLocal), concurrency: job.concurrency }, m => {
  if (m.type === 'progress') { state.progress = Object.assign({}, m, { type: undefined, reqId: undefined }); }
  else if (m.type === 'log') log(m.line);
}).then(result => {
  state.status = result.stopped ? 'stopped' : 'done';
  state.result = result;
  log(`[crawler] ${state.status}: ${result.listed} listed, ${result.added} new, ${result.read} read, ${result.errors} errors`);
}, e => {
  state.status = e.code === 'stopped' ? 'stopped' : 'failed';
  state.error = e.message;
  state.result = e.stats || null;
  log(`[crawler] failed: ${e.message}`);
}).finally(() => {
  clearInterval(beat);
  state.finishedAt = new Date().toISOString();
  save();
  fs.rmSync(path.join(dir, 'stop'), { force: true });
  process.exit(0);
});
