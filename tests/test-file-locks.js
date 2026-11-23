// node tests/test-file-locks.js <app dir> — file jobs that can't go on: a file locked by another program
// (reported as "locked", the others renamed), a disk that stops answering (the job moves on after the stall
// time, the file reported "stalled"), and what a job says it is doing. Offline.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-locks-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
let n = 0;
const book = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, makeZip([['p.png', png(10, 15, [n * 30 % 255, 50, 90], n++)]])); };
for (let i = 1; i <= 6; i++) book(path.join(MEDIA, 'Locked', `chapter-${i}.cbz`));
for (let i = 1; i <= 4; i++) book(path.join(MEDIA, 'Hangs', `episode-${i}.cbz`));

const PORT = 3983, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, cookie, log = '', locker = null;
function start() {
  return new Promise((resolve, reject) => {
    // A disk that stops answering on one file; given up on after 3 s
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA, THOTH_RENAME_STALL_MS: '3000', THOTH_TEST_RENAME_HANG: 'episode-3.cbz' } });
    srv.stdout.on('data', d => { log += d; if (log.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => { log += d; });
    srv.on('exit', c => reject(new Error('exit ' + c + log)));
  });
}
const call = async (m, u, b, c = cookie) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const jobOf = id => until(async () => { const j = (await call('GET', `/api/rename/jobs/${id}`)).data.job; return (j.status === 'done' || j.status === 'failed') && j; }, 60000);
// Windows: another program holding a file with no sharing (as a reader or an antivirus would)
function lock(file) {
  return new Promise((resolve, reject) => {
    locker = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','None'); 'locked'; Start-Sleep 60; $f.Close()`], { stdio: ['ignore', 'pipe', 'inherit'] });
    locker.stdout.on('data', d => { if (String(d).includes('locked')) resolve(); });
    locker.on('error', reject);
  });
}

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library.id;
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  const pv = (await call('GET', `/api/rename/preview?library=${L}`)).data;
  ok(pv.items.filter(x => x.status === 'ok').length === 10, 'ten renames proposed');
  const of = dir => pv.items.filter(x => x.from.includes(dir)).map(x => ({ bookId: x.bookId, toName: x.toName }));

  // ---- a locked file ----
  if (process.platform === 'win32') {
    await lock(path.join(MEDIA, 'Locked', 'chapter-4.cbz'));
    const j = await jobOf((await call('POST', '/api/rename/apply', { items: of('Locked') })).data.job.id);
    const f = j.failed.find(x => /chapter-4/.test(x.from));
    ok(j.renamed === 5 && f && f.error === 'locked', `a file in use by another program is reported "locked" and the others are renamed (${j.renamed} renamed, ${JSON.stringify(j.failed)})`);
    ok(fs.existsSync(path.join(MEDIA, 'Locked', 'chapter-4.cbz')) && fs.existsSync(path.join(MEDIA, 'Locked', 'Chapter 5.cbz')), 'on disk: the locked file kept its name, the next one was renamed');
    locker.kill();
  } else console.log('  - (locked files: Windows only)');

  // ---- a disk that stops answering ----
  const t0 = Date.now();
  const id = (await call('POST', '/api/rename/apply', { items: of('Hangs') })).data.job.id;
  const seen = await until(async () => { const v = (await call('GET', `/api/rename/jobs/${id}`)).data.job; return v.status === 'running' && v.phase === 'files' && v.file === 'episode-3.cbz' && v; }, 10000);
  ok(seen.done >= 2, `while it works, the job says what it is doing and on which file (${seen.phase}: ${seen.file}, ${seen.done} of ${seen.total})`);
  const quiet = await until(async () => { const v = (await call('GET', `/api/rename/jobs/${id}`)).data.job; return v.status === 'running' && v.quietSec >= 2 && v; }, 10000);
  ok(quiet.quietSec >= 2, `and for how long the disk hasn't answered (${quiet.quietSec} s)`);
  const j2 = await jobOf(id);
  const stalled = j2.failed.find(x => /episode-3/.test(x.from));
  ok(j2.status === 'done' && stalled && stalled.error === 'stalled' && Date.now() - t0 < 30000, `a file that doesn't answer is given up on after the stall time ("stalled"), the job finishes (${JSON.stringify(j2.failed)})`);
  ok(j2.renamed === 2, `the files before it were renamed and kept (${j2.renamed}); the ones after it are left for another try`);
  // The rename process was restarted: the next job works
  const again = (await call('GET', `/api/rename/preview?library=${L}`)).data.items.filter(x => /episode-4/.test(x.from)).map(x => ({ bookId: x.bookId, toName: x.toName }));
  const j3 = await jobOf((await call('POST', '/api/rename/apply', { items: again })).data.job.id);
  ok(j3.renamed === 1, 'after that, the next job renames with a new rename process');

  // ---- tasks and their logs ----
  const tl = (await call('GET', '/api/tasks')).data;
  const scanTask = tl.recent.find(x => x.kind === 'scan'), fileTask = tl.recent.find(x => x.kind === 'files' && /2 not done/.test(x.summary || ''));
  ok(scanTask && scanTask.status === 'done' && /works/.test(scanTask.summary) && fileTask, `scans and file jobs are tasks (${scanTask && scanTask.summary}; ${fileTask && fileTask.summary})`);
  const fileLog = (await call('GET', `/api/logs/${fileTask.log}`)).data.lines.join('\n');
  ok(/episode-3\.cbz - stalled/.test(fileLog) && /file\(s\) to go through/.test(fileLog), 'a file job’s log says what it did and which files weren’t done, and why');
  // Old logs are deleted after the number of days set in Server settings
  const logDir = path.join(DATA, 'logs');
  const old = path.join(logDir, '20200101-000000_other_old.log');
  fs.writeFileSync(old, '# old\n'); const past = new Date(Date.now() - 3 * 86400000); fs.utimesSync(old, past, past);
  ok((await call('GET', '/api/logs')).data.logs.some(l => l.name === '20200101-000000_other_old.log'), 'the Logs page lists every log file');
  await call('PATCH', '/api/config', { logRetentionDays: 2 });
  ok(!fs.existsSync(old) && fs.existsSync(path.join(logDir, fileTask.log)), 'log files older than the days set are deleted (newer ones kept)');

  console.log(`\n${passed} checks passed`);
  srv.kill(); if (locker) locker.kill();
  await wait(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* still in use */ }
})().catch(e => { console.error('FAILED:', e.message); console.error(log.slice(-3000)); if (srv) srv.kill(); if (locker) locker.kill(); process.exit(1); });
