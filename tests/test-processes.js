// node test-processes.js <app dir> â€” Server settings, the scan pool (start/stop/restart/crash), scan
// speed with concurrency, server restart, "code changed" detection. Runs on a copy of the app.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), zlib = require('zlib');
const SRC = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-proc-'));
const APP = path.join(TMP, 'app');
fs.cpSync(SRC, APP, { recursive: true, filter: p => !/[\\/](\.git|\.updates|data|node_modules|media)([\\/]|$)/.test(p.slice(SRC.length)) });
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media'), HEAVY = path.join(TMP, 'heavy'), MANY = path.join(TMP, 'many');
execFileSync(process.execPath, [path.join(__dirname, 'make-comics.js'), MEDIA]);
// heavy: big PDFs so a full scan takes a few seconds (time to stop it mid-way)
fs.mkdirSync(HEAVY);
const filler = Buffer.alloc(60 * 1024 * 1024, 'x');
for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(HEAVY, `Big ${i}.pdf`), Buffer.concat([Buffer.from('%PDF-1.4\n'), filler, Buffer.from(`\n1 0 obj << /Type /Pages /Count ${i + 1} >> endobj\n`)]));
// many: lots of compressed CBZs with ComicInfo.xml (CPU work: inflating) for the speed comparison
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const info = Buffer.from('<ComicInfo><Series>Speed</Series><Summary>' + 'lorem ipsum '.repeat(20000) + '</Summary></ComicInfo>');
const cbz = makeZip([['ComicInfo.xml', info], ...Array.from({ length: 20 }, (_, i) => [`p${i}.png`, png(40, 60, [i * 10, 50, 90], i)])], { deflate: true });
for (let s = 0; s < 20; s++) { fs.mkdirSync(path.join(MANY, `S${s}`), { recursive: true }); for (let b = 0; b < 30; b++) fs.writeFileSync(path.join(MANY, `S${s}`, `B${b}.cbz`), cbz); }
// PDFs make the page counter read the whole file: real I/O + CPU per file
for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(MANY, `Doc ${i}.pdf`), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(24 * 1024 * 1024, 'y'), Buffer.from('\n1 0 obj << /Type /Pages /Count 3 >> endobj\n')]));

const PORT = 3984, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, cookie, srvLog = '';
function start(env = {}) {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA, THOTH_WORKER_IDLE_MS: '3000', ...env } });
    let out = ''; srv.stdout.on('data', d => { out += d; srvLog += d; if (out.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => { out += d; srvLog += d; });
    srv.on('exit', c => reject(new Error('exit ' + c + out)));
  });
}
// Stops the supervisor and waits for the server child too (on Windows, killing the supervisor is abrupt and
// the child finishes saving on its own; the next server must not start before that)
const stop = async () => {
  await wait(500);
  let child = null;
  try { child = (await call('GET', '/api/processes')).data.server.pid; } catch {}
  await new Promise(r => { srv.removeAllListeners('exit'); srv.on('exit', r); srv.kill(); });
  if (child && child !== srv.pid) await until(async () => !alive(child), 60000);
};
const call = async (m, u, b, c = cookie) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json(), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, n) => { assert(c, n); passed++; console.log('  âœ“', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const svc = async () => (await call('GET', '/api/processes')).data.scanService;
const pids = s => s.workers.map(w => w.pid);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const lib = async id => (await call('GET', '/api/libraries')).data.libraries.find(l => l.id === id);
async function timedFullScan(id) {
  await call('POST', `/api/libraries/${id}/scan`, { full: true });
  const l = await until(async () => { const x = await lib(id); return !x.scanning && x.lastScan && x.lastScan.full && x; }, 300000);
  return l.lastScan;
}

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;

  // ---- server settings ----
  let cfg = (await call('GET', '/api/config')).data;
  ok(cfg.cpus >= 1 && cfg.values.scanWorkers === cfg.schema.scanWorkers.default && cfg.values.scanConcurrency === 4, `defaults: ${cfg.values.scanWorkers} processes (of ${cfg.cpus} cores), 4 files at once`);
  let s = await svc();
  ok(s.state === 'running' && s.idle && !s.workers.length, 'service running but idle: no scan processes while there is nothing to scan');
  ok((await call('PATCH', '/api/config', { scanWorkers: 999 })).status === 400 && (await call('PATCH', '/api/config', { scanConcurrency: 0 })).status === 400, 'out-of-range values rejected');
  const bob = (await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' }), (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie);
  ok((await call('GET', '/api/config', null, bob)).status === 403 && (await call('PATCH', '/api/config', { scanWorkers: 1 }, bob)).status === 403, 'only admins see and change server settings');
  cfg = (await call('PATCH', '/api/config', { scanWorkers: 3 })).data;
  ok(!(await svc()).workers.length, 'changing "scan processes" while idle starts nothing');

  // ---- scan modes (processes start with the first scan) ----
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA })).data.library.id;
  s = await until(async () => { const x = await svc(); return x.workers.length === 3 && x; });
  ok(s.workers.length === 3 && pids(s).every(p => p !== srv.pid), `a scan starts the pool: ${s.workers.length} scan processes`);
  const workerPrio = os.getPriority(s.workers[0].pid);
  ok(s.workers.every(w => os.getPriority(w.pid) === os.constants.priority.PRIORITY_LOW), `every scan process has the lowest priority (${workerPrio})`);
  s = await until(async () => { const x = await svc(); return x.workers.length === 3 && x.workers.every(w => w.stats) && x; });
  ok(s.workers.every(w => w.stats.rss > 0), 'each process reports its memory');
  await until(async () => { const l = await lib(L); return !l.scanning && l.lastScan; });
  const oldPids = pids(s);
  s = await until(async () => { const x = await svc(); return !x.workers.length && x; });
  await until(async () => oldPids.every(p => !alive(p)));
  ok(s.idle && oldPids.every(p => !alive(p)), 'nothing left to scan: the processes are closed after a moment');
  await call('POST', `/api/libraries/${L}/scan`, {});
  let l = await until(async () => { const x = await lib(L); return !x.scanning && x.lastScan && x.lastScan.full === false && x; });
  ok(l.lastScan.updated === 0 && l.lastScan.read === 0, 'scan changes: nothing read when nothing changed');
  l = { lastScan: await timedFullScan(L) };
  ok(l.lastScan.updated === l.lastScan.books && l.lastScan.read === l.lastScan.books, `full scan: every book read (${l.lastScan.read}/${l.lastScan.books})`);

  // ---- speed: same library, 1 process Ã— 1 file vs 4 processes Ã— 4 files ----
  const M = (await call('POST', '/api/libraries', { name: 'Many', root: MANY })).data.library.id;
  await until(async () => { const x = await lib(M); return !x.scanning && x.lastScan && x; }, 300000);
  await call('PATCH', '/api/config', { scanWorkers: 1, scanConcurrency: 1 });
  const slow = await timedFullScan(M);
  await call('PATCH', '/api/config', { scanWorkers: 4, scanConcurrency: 4 });
  const fast = await timedFullScan(M);
  console.log(`    full scan of ${fast.books} books: 1 process Ã— 1 file = ${slow.durationMs} ms; 4 processes Ã— 4 files = ${fast.durationMs} ms (${(slow.durationMs / fast.durationMs).toFixed(1)}Ã— faster)`);
  ok(slow.books === fast.books && fast.processes === 4 && fast.concurrency === 4, 'both scans found every book; the report says how it ran');
  ok(fast.durationMs < slow.durationMs, 'more processes and files at once is faster');
  await call('PATCH', '/api/config', { scanWorkers: 2, scanConcurrency: 4 });

  // ---- stop / start ----
  await call('POST', `/api/libraries/${M}/scan`, { full: true });
  const before = pids(await until(async () => { const x = await svc(); return x.workers.length === 2 && x; }));
  s = (await call('POST', '/api/processes/scan-service/stop', {})).data.scanService;
  ok(s.state === 'stopped' && !s.workers.length, 'stop: service stopped');
  await until(async () => before.every(p => !alive(p)));
  ok(before.every(p => !alive(p)), 'stop: every process is gone');
  let r = await call('POST', `/api/libraries/${L}/scan`, {});
  ok(r.data.serviceRunning === false && (await lib(L)).scanProgress.serviceStopped, 'scanning while stopped: waits in line');
  await wait(600);
  ok((await lib(L)).scanning, 'it does not run while stopped');
  s = (await call('POST', '/api/processes/scan-service/start', {})).data.scanService;
  ok(s.state === 'running' && s.workers.length === 2 && pids(s).every(p => !before.includes(p)), 'start: new processes for the waiting scans');
  await until(async () => !(await lib(L)).scanning && !(await lib(M)).scanning, 300000);
  ok(true, 'the waiting scans ran after starting');

  // ---- restart ----
  const b2 = await svc();
  s = (await call('POST', '/api/processes/scan-service/restart', {})).data.scanService;
  ok(s.state === 'running' && pids(s).every(p => !pids(b2).includes(p)) && s.restarts === b2.restarts + 1, 'restart: counted (processes start again when needed)');

  // ---- stop in the middle of a scan ----
  const H = (await call('POST', '/api/libraries', { name: 'Heavy', root: HEAVY })).data.library.id;
  await until(async () => { const x = (await svc()).current; return x && x.libraryId === H && x.toAnalyze; });
  await call('POST', '/api/processes/scan-service/stop', {});
  s = await svc();
  ok(!s.current && s.queue[0] && s.queue[0].libraryId === H && !(await lib(H)).scanError, 'stop mid-scan: cancelled (not an error) and back at the front of the line');
  await stop(); await start();
  s = await svc();
  ok(s.state === 'stopped' && !s.workers.length, 'stopped service stays stopped after a server restart');
  ok((await call('GET', '/api/config')).data.values.scanWorkers === 2, 'server settings survive a restart');
  await call('POST', '/api/processes/scan-service/start', {});
  const dbg = (await call('GET', '/api/libraries')).data;
  if (!dbg.libraries || !dbg.libraries.find(l => l.id === H)) { console.log('DEBUG libraries', JSON.stringify(dbg).slice(0, 600), 'H', H); console.log(srvLog.slice(-3000)); }
  const done = await until(async () => { const x = await lib(H); return !x.scanning && x.lastScan && x; }, 120000);
  ok(done.booksCount === 8 && !done.scanError, 'after starting again, the heavy library scans completely');

  // ---- crash recovery: a dead process is replaced while scanning; 3 crashes in a minute â†’ give up ----
  const busyPool = async () => { await call('POST', `/api/libraries/${H}/scan`, { full: true }); return until(async () => { const x = await svc(); return x.workers.length === 2 && x.current && x; }); };
  let victim = (await busyPool()).workers[0].pid;
  process.kill(victim);
  s = await until(async () => { const x = await svc(); return /unexpectedly/.test(x.lastError || '') && !pids(x).includes(victim) && x; });
  ok(s.state === 'running', 'a crashed scan process is noticed; the service keeps running');
  for (let i = 0; i < 2; i++) { await until(async () => !(await lib(H)).scanning, 120000); victim = (await busyPool()).workers[0].pid; process.kill(victim); await until(async () => !pids(await svc()).includes(victim)); }
  s = await until(async () => { const x = await svc(); return x.state === 'crashed' && x; });
  ok(s.state === 'crashed' && !s.workers.length, '3 crashes in a minute: gives up (state "crashed")');
  ok((await call('POST', '/api/processes/scan-service/start', {})).data.scanService.state === 'running', 'an admin can start it again');

  // ---- server restart & code-changed detection ----
  fs.appendFileSync(path.join(APP, 'library', 'api.js'), '\n// changed\n');
  let srvInfo = (await call('GET', '/api/processes')).data.server;
  ok(srvInfo.restartNeeded === true, 'changing server code on disk â†’ restart needed');
  ok(srvInfo.supervised && srvInfo.supervisorPid === srv.pid && srvInfo.pid !== srv.pid, 'npm start runs the server under the built-in supervisor');
  r = await call('POST', '/api/processes/server/restart', {});
  ok(r.status === 202, 'restart server accepted (no systemd/Docker needed)');
  const newInfo = await until(async () => { try { const x = (await call('GET', '/api/processes')).data.server; return x.pid !== srvInfo.pid && x; } catch { return false; } }, 20000);
  ok(newInfo.restarts === srvInfo.restarts + 1 && newInfo.restartNeeded === false && alive(srv.pid), 'server came back with a new process, running the new code, same supervisor');
  ok((await svc()).state === 'running', 'scan service is running again after the restart');
  await stop();
  await start({ THOTH_NO_SUPERVISOR: '1' });
  r = await call('POST', '/api/processes/server/restart', {});
  ok(r.status === 409 && r.data.error === 'notSupervised', 'without the supervisor (THOTH_NO_SUPERVISOR=1) restart is refused');
  await stop();
  await start({ THOTH_NO_SUPERVISOR: '1', THOTH_SELF_RESTART: '1' });
  const exited = new Promise(res => { srv.removeAllListeners('exit'); srv.on('exit', c => res(c)); });
  ok((await call('POST', '/api/processes/server/restart', {})).status === 202, 'supervised: restart accepted');
  ok(await Promise.race([exited, wait(8000).then(() => 'timeout')]) === 0, 'with an outside supervisor (systemd/Docker): exits cleanly for it to restart');

  console.log(`\nALL ${passed} PROCESS CHECKS PASSED`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message); try { srv.kill(); } catch {} process.exit(1); });
