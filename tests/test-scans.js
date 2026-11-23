// node tests/test-scans.js <app dir> — scan modes and the saved scan index: the first scan is full, startup
// and scheduled scans are quick (unchanged folders aren't looked into), "Scan changes" checks every file,
// "Full scan" reads everything; plus the library's default order. Offline.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-scans-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const cbz = (n, pages = 2) => makeZip(Array.from({ length: pages }, (_, i) => [`p${i}.png`, png(20, 30, [n * 25 % 255, 90, 140], i)]));
for (let w = 0; w < 6; w++) for (let c = 1; c <= 3; c++) {
  fs.mkdirSync(path.join(MEDIA, `Work ${w}`), { recursive: true });
  fs.writeFileSync(path.join(MEDIA, `Work ${w}`, `Ch ${c}.cbz`), cbz(w * 3 + c));
}

const PORT = 3989, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, cookie, log = '';
function start() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA } });
    srv.stdout.on('data', d => { log += d; if (log.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => { log += d; });
    srv.on('exit', c => reject(new Error('exit ' + c + log)));
  });
}
async function stop() {
  // Let pending saves (batched 300 ms) finish: on Windows, killing the supervisor kills the server at once
  await wait(1000);
  const pid = (await call('GET', '/api/processes')).data.server.pid;
  srv.removeAllListeners('exit');
  await new Promise(r => { srv.on('exit', r); srv.kill(); });
  await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
}
const call = async (m, u, b, c = cookie) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const lib = async () => (await call('GET', '/api/libraries')).data.libraries[0];
let L;
async function scan(body) {
  const before = (await lib()).lastScan;
  await call('POST', `/api/libraries/${L}/scan`, body);
  return until(async () => { const l = await lib(); return !l.scanning && l.lastScan && (!before || l.lastScan.at !== before.at) && l.lastScan; });
}
// Change a file's contents without touching its folder's modification time (as some tools do)
function rewriteInPlace(file, buf) {
  const dir = path.dirname(file), st = fs.statSync(dir);
  fs.writeFileSync(file, buf);
  fs.utimesSync(dir, st.atime, st.mtime);
}

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library.id;
  let s = await until(async () => { const l = await lib(); return !l.scanning && l.lastScan; });
  ok(s.scanMode === 'full' && s.reason === 'new' && s.read === 18 && s.books === 18, 'first scan of a new library: full, every file read');
  ok(fs.existsSync(path.join(DATA, 'scan-index', `${L}.json`)), 'scan index saved (data/scan-index/<library>.json)');

  // ---- startup: quick ----
  await stop(); log = ''; await start();
  s = await until(async () => { const l = await lib(); return !l.scanning && l.lastScan && l.lastScan.reason === 'startup' && l.lastScan; });
  ok(s.scanMode === 'quick' && s.read === 0 && s.folders === 7 && s.foldersSkipped === 7 && s.filesChecked === 0 && s.books === 18,
    `startup scan is quick: ${s.foldersSkipped} of ${s.folders} folders unchanged, no file checked or read`);
  ok(/quick scan of "Comics" \(startup\)/.test(log), 'the log says which kind of scan ran and why');

  // ---- quick scans notice added, removed and renamed files (their folder changes) ----
  fs.writeFileSync(path.join(MEDIA, 'Work 2', 'Ch 4.cbz'), cbz(99));
  fs.rmSync(path.join(MEDIA, 'Work 3', 'Ch 1.cbz'));
  fs.mkdirSync(path.join(MEDIA, 'Work 9'));
  fs.writeFileSync(path.join(MEDIA, 'Work 9', 'Ch 1.cbz'), cbz(42));
  s = await scan({ mode: 'quick' });
  ok(s.scanMode === 'quick' && s.added === 1 && s.removed === 1 && s.read === 2 && s.books === 19, `quick scan: new work, new chapter and a deleted chapter found (+${s.added} works, ${s.read} files read, ${s.removed} removed)`);
  ok(s.foldersSkipped === s.folders - 4, `only the changed folders were looked into (${s.folders - s.foldersSkipped} of ${s.folders})`);

  // ---- a file rewritten in place: quick misses it, "Scan changes" finds it ----
  // (Some file systems, like NTFS, still move the folder's date afterwards, so a quick scan may notice too)
  rewriteInPlace(path.join(MEDIA, 'Work 1', 'Ch 2.cbz'), cbz(7, 4));
  s = await scan({ mode: 'quick' });
  console.log(`    quick scan after an in-place rewrite: ${s.updated ? 'noticed (the folder date moved)' : 'not noticed (folder date unchanged)'}`);
  rewriteInPlace(path.join(MEDIA, 'Work 1', 'Ch 2.cbz'), cbz(7, 5));
  s = await scan({});
  ok(s.scanMode === 'changes' && s.reason === 'manual' && s.updated === 1 && s.read === 1 && s.filesChecked === 19, '"Scan changes" checks every file: the changed one is read again');
  const w1 = (await call('GET', '/api/series?limit=50')).data.items.find(x => x.title === 'Work 1');
  ok((await call('GET', `/api/series/${w1.id}`)).data.books.find(b => b.fileName === 'Ch 2.cbz').pageCount === 5, 'its new page count is in');
  s = await scan({ full: true });
  ok(s.scanMode === 'full' && s.read === 19 && s.updated === 19, '"Full scan" reads every file');

  // ---- requests while a scan waits: the strongest mode wins ----
  ok((await call('POST', `/api/libraries/${L}/scan`, { mode: 'bogus' })).status === 202, 'unknown mode falls back to "changes"');
  await until(async () => !(await lib()).scanning);

  // ---- index follows the library folder ----
  const other = path.join(TMP, 'other');
  fs.mkdirSync(path.join(other, 'Solo'), { recursive: true });
  fs.writeFileSync(path.join(other, 'Solo', '1.cbz'), cbz(5));
  await call('PATCH', `/api/libraries/${L}`, { root: other });
  s = await until(async () => { const l = await lib(); return !l.scanning && l.lastScan && l.lastScan.reason === 'settings' && l.lastScan; });
  ok(s.scanMode === 'full' && s.books === 1 && s.removed === 19, 'another library folder: full scan from scratch');

  // ---- default order ----
  ok((await call('PATCH', `/api/libraries/${L}`, { defaults: { sort: 'random' } })).status === 400, 'invalid default order rejected');
  await call('PATCH', `/api/libraries/${L}`, { defaults: { sort: 'added' } });
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  const bl = (await call('GET', '/api/libraries', null, bob)).data.libraries[0];
  ok(bl.defaultSort === 'added' && bl.root === undefined, 'every user gets the library’s default order (not its folder)');

  // ---- deleting the library deletes its index ----
  await call('DELETE', `/api/libraries/${L}`);
  ok(!fs.existsSync(path.join(DATA, 'scan-index', `${L}.json`)), 'deleting the library removes its scan index');

  console.log(`\nALL ${passed} SCAN CHECKS PASSED`);
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2000)); try { srv.kill(); } catch {} process.exit(1); });
