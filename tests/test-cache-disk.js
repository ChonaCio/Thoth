// node tests/test-cache-disk.js <app dir> — Caches kept on disk: the Works, Search and Pages caches save what they
// keep (data/cache/snapshots/), and after the server starts again they answer from it at once — but only while the
// data is what the answers were built from (a change made while the server was off: built again).
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-cdisk-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
for (const [w, n] of [['Alpha Saga', 3], ['Beta Tales', 2]]) for (let i = 1; i <= n; i++) {
  fs.mkdirSync(path.join(MEDIA, w), { recursive: true });
  fs.writeFileSync(path.join(MEDIA, w, `Chapter ${i}.cbz`), makeZip([1, 2, 3].map(p => [`${p}.png`, png(40, 60, [i * 40, p * 50, 90], i * 10 + p)])));
}

const PORT = 3992, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, cookie, log = '';
function start() {
  log = '';
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA, THOTH_CACHE_SAVE_MS: '1500' } });
    srv.stdout.on('data', d => { log += d; if (log.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => { log += d; });
    srv.on('exit', c => reject(new Error('exit ' + c + log)));
  });
}
async function stop() { await new Promise(r => { srv.removeAllListeners('exit'); srv.on('exit', r); srv.kill(); }); await wait(500); }
const raw = (u, c = cookie) => fetch(BASE + u, { headers: c ? { Cookie: c } : {} });
const call = async (m, u, b, c = cookie) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150); } throw new Error('timeout waiting'); }
const cacheOf = async kind => ((await call('GET', '/api/processes')).data.caches || []).find(c => c.kind === kind) || {};
const SNAP = path.join(DATA, 'cache', 'snapshots');

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library.id;
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  // A quick scan that finds nothing new keeps the data's version: answers cached before it stay good
  const a1 = await raw('/api/series?limit=20'); await a1.text();
  await call('POST', `/api/libraries/${L}/scan`, {});
  await wait(300);
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l; });
  const a2 = await raw('/api/series?limit=20'); const list = JSON.parse(await a2.text());
  ok(a2.headers.get('x-thoth-cache') === 'hit', 'a scan that found nothing new leaves cached answers good');
  const alpha = list.items.find(s => s.title === 'Alpha Saga');
  const book = (await call('GET', `/api/series/${alpha.id}`)).data.books[0];
  ok((await raw(`/api/books/${book.id}/pages/1`)).status === 200, 'a page read (into the Pages cache)');
  ok((await call('GET', '/api/search?q=beta')).data.series.some(s => s.title === 'Beta Tales'), 'a search (the Search index loaded)');
  await raw('/api/series?limit=20'); // (used again since)
  const saved = await until(async () => ['works.snap', 'pages.snap', 'search.snap'].every(f => fs.existsSync(path.join(SNAP, f))) && (await cacheOf('works')).stats.snapshot.savedAt && true, 15000).catch(() => false);
  ok(saved, `the caches saved what they keep to disk (${fs.existsSync(SNAP) ? fs.readdirSync(SNAP).join(', ') : 'nothing'})`);

  // ---- the server starts again: answers from what was saved ----
  await stop();
  await start();
  const b1 = await raw('/api/series?limit=20'); await b1.text();
  if (b1.headers.get('x-thoth-cache') !== 'hit') console.log('works cache now:', JSON.stringify((await cacheOf('works')).stats));
  ok(b1.headers.get('x-thoth-cache') === 'hit', 'after a restart, the first works list is answered from the saved cache (not built again)');
  const w = await until(async () => { const c = await cacheOf('works'); return c.stats && c.stats.snapshot && c.stats.snapshot.restored && c; }, 10000).catch(() => ({}));
  ok(w.stats && w.stats.snapshot.restored >= 1, `the Works cache took back ${w.stats && w.stats.snapshot.restored} answer(s) from disk`);
  const pg = await until(async () => { const c = await cacheOf('pages'); return c.stats && c.stats.snapshot && c.stats.snapshot.restored && c; }, 10000).catch(() => null);
  ok(pg && pg.stats.snapshot.restored >= 1, `the Pages cache took back ${pg && pg.stats.snapshot.restored} page(s)`);
  await wait(2200); // (the processes' statistics come every 2 s)
  const sr = await cacheOf('search');
  ok(sr.stats && sr.stats.snapshot.restored === 2 && (await call('GET', '/api/search?q=alpha')).data.series.length === 1, 'the Search index came back too (2 works) and answers');

  // ---- changed while the server was off: nothing taken back ----
  await raw('/api/series?limit=20');
  await wait(2500); // (saved again)
  await stop();
  const lib = JSON.parse(fs.readFileSync(path.join(DATA, 'library.json'), 'utf8'));
  Object.values(lib.series).find(s => s.name === 'Beta Tales').overrides = { title: 'Beta Renamed' };
  fs.writeFileSync(path.join(DATA, 'library.json'), JSON.stringify(lib));
  await start();
  const c1 = await raw('/api/series?limit=20'); const body = JSON.parse(await c1.text());
  ok(c1.headers.get('x-thoth-cache') === 'miss' && body.items.some(s => s.title === 'Beta Renamed'), 'data changed while the server was off: the saved answers aren’t used (the new title shows)');
  await wait(2200);
  const w2 = await cacheOf('works');
  ok(w2.stats && !w2.stats.snapshot.restored && w2.stats.snapshot.skipped, `nothing was taken back (${w2.stats && w2.stats.snapshot.skipped})`);

  console.log(`\nALL ${passed} CACHE-ON-DISK CHECKS PASSED`);
  srv.kill();
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); }, 500);
})().catch(e => { console.error('FAILED:', e.message); console.error(log.slice(-3000)); try { srv.kill(); } catch {} process.exit(1); });
