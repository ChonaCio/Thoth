// node tests/test-display.js <app dir> — library defaults and per-work settings (chapter layout, reading
// mode, cover choice), library filters and their facets, scan progress with time estimates, the metadata
// concurrency setting. Offline.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-disp-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media'), BIG = path.join(TMP, 'big');
execFileSync(process.execPath, [path.join(__dirname, 'make-comics.js'), MEDIA]);
// Slow-ish library for watching scan progress: PDFs whose page count needs the whole file read
fs.mkdirSync(BIG);
for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(BIG, `Doc ${i}.pdf`), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(24 * 1024 * 1024, 'y'), Buffer.from('\n1 0 obj << /Type /Pages /Count 3 >> endobj\n')]));

const PORT = 3987, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, cookie, log = '';
function start() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA } });
    srv.stdout.on('data', d => { log += d; if (log.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => { log += d; });
    srv.on('exit', c => reject(new Error('exit ' + c + log)));
  });
}
const call = async (m, u, b, c = cookie) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json(), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 60000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const libs = async () => (await call('GET', '/api/libraries')).data.libraries;
const works = async (qs = '') => (await call('GET', '/api/series?limit=200' + qs)).data.items;

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;

  // ---- library defaults ----
  let L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library;
  ok(L.defaults.bookLayout === 'tiles' && L.defaults.readingDirection === null, 'new library: tiles, automatic reading mode');
  await until(async () => { const l = (await libs()).find(x => x.id === L.id); return !l.scanning && l.lastScan; });
  let items = await works();
  const alpha = items.find(s => s.title === 'Alpha!'), beta = items.find(s => s.title === 'Beta'), web = items.find(s => s.title === 'Webtoon Tale');
  ok(alpha.readingDirection === 'rtl' && web.readingDirection === 'vertical' && beta.readingDirection === 'ltr', 'automatic: detected from ComicInfo (manga → right to left, webtoon → continuous)');
  ok(alpha.bookLayout === 'tiles' && alpha.libraryDirection === null && alpha.detectedDirection === 'rtl', 'works report layout, library default and detected mode');

  ok((await call('PATCH', `/api/libraries/${L.id}`, { defaults: { bookLayout: 'grid' } })).status === 400
    && (await call('PATCH', `/api/libraries/${L.id}`, { defaults: { readingDirection: 'up' } })).status === 400, 'invalid defaults rejected');
  L = (await call('PATCH', `/api/libraries/${L.id}`, { defaults: { bookLayout: 'list', readingDirection: 'ltr' } })).data.library;
  ok(L.defaults.bookLayout === 'list' && L.defaults.readingDirection === 'ltr', 'library defaults saved');
  items = await works();
  ok(items.every(s => s.bookLayout === 'list' && s.readingDirection === 'ltr'), 'a fixed library mode applies to every work (even detected manga/webtoon)');

  // ---- per-work settings win ----
  await call('PATCH', `/api/series/${alpha.id}`, { readingDirection: 'rtl', bookLayout: 'tiles' });
  let a = (await call('GET', `/api/series/${alpha.id}`)).data.series;
  ok(a.readingDirection === 'rtl' && a.bookLayout === 'tiles', 'the work’s own reading mode and layout beat the library defaults');
  ok((await call('PATCH', `/api/series/${alpha.id}`, { bookLayout: 'cards' })).status === 400 && (await call('PATCH', `/api/series/${alpha.id}`, { cover: 'web' })).status === 400, 'invalid work settings rejected');
  await call('PATCH', `/api/series/${alpha.id}`, { readingDirection: '', bookLayout: '' });
  a = (await call('GET', `/api/series/${alpha.id}`)).data.series;
  ok(a.readingDirection === 'ltr' && a.bookLayout === 'list', 'clearing them falls back to the library defaults');
  await call('PATCH', `/api/libraries/${L.id}`, { defaults: { readingDirection: '' } });
  a = (await call('GET', `/api/series/${alpha.id}`)).data.series;
  ok(a.readingDirection === 'rtl', 'library back to automatic: detected mode again');
  const cv = (await call('PATCH', `/api/series/${alpha.id}`, { cover: 'metadata' })).data.series;
  ok(cv.coverChoice === 'metadata' && cv.coverSource === 'file', 'cover choice saved; without a downloaded cover the first page is still used');
  await call('PATCH', `/api/series/${alpha.id}`, { cover: '' });

  // ---- genres apart from tags ----
  ok(a.genres.join() === 'Action,Comedy' && !a.tags.includes('Comedy'), 'ComicInfo <Genre> → genres');
  await call('PATCH', `/api/series/${beta.id}`, { genres: 'Drama, Action', tags: 'Found Family', status: 'ended', type: 'manhwa' });

  // ---- filters & facets ----
  const f = (await call('GET', `/api/series/facets?library=${L.id}`)).data;
  ok(f.genres.find(g => g.name === 'Action').count === 2 && f.genres.find(g => g.name === 'Drama').count === 1, `facets: genres with counts (${f.genres.map(g => g.name + ' ' + g.count).join(', ')})`);
  ok(f.tags.some(t => t.name === 'Found Family') && f.types.manhwa === 1 && f.statuses.ended === 1 && f.metadata.none === items.length, 'facets: tags, types, statuses, metadata state');
  const names = list => list.map(s => s.title).sort().join();
  ok(names(await works('&genre=action')) === 'Alpha!,Beta', 'filter by genre (any case)');
  ok(names(await works('&tag=Found%20Family')) === 'Beta', 'filter by tag');
  ok(names(await works('&status=ended')) === 'Beta' && names(await works('&type=manhwa')) === 'Beta', 'filter by status and type');
  ok(names(await works('&genre=Action&status=ended')) === 'Beta', 'filters combine');
  ok((await works('&metadata=matched')).length === 0 && (await works('&metadata=none')).length === items.length, 'filter by metadata state');
  ok(names(await works('&q=drama')) === 'Beta', 'text search also looks at genres');
  const bob = (await call('POST', '/api/users', { username: 'bob', password: 'bobpass12', libraries: [] }), (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie);
  ok((await call('GET', '/api/series/facets', null, bob)).data.genres.length === 0, 'facets only cover libraries the user can see');

  // ---- scan progress with an estimate ----
  // One process reading one file at a time, so the scan lasts long enough to watch
  await call('PATCH', '/api/config', { scanWorkers: 1, scanConcurrency: 1 });
  await until(async () => (await call('GET', '/api/processes')).data.scanService.workers.length <= 1); // (started on demand)
  const B = (await call('POST', '/api/libraries', { name: 'Big', root: BIG, metadata: { autoFetch: false } })).data.library;
  const seen = { listing: false, reading: false, eta: null, percents: [] };
  await until(async () => {
    const l = (await libs()).find(x => x.id === B.id);
    const p = l.scanProgress && l.scanProgress.progress;
    if (p) {
      if (p.phase === 'listing') seen.listing = true;
      if (p.phase === 'reading') { seen.reading = true; seen.percents.push(p.percent); if (p.etaMs != null) seen.eta = seen.eta || p; }
    }
    return !l.scanning && l.lastScan;
  }, 120000);
  ok(seen.reading && seen.percents.length > 1 && seen.percents.every((v, i, arr) => i === 0 || v >= arr[i - 1]), `progress while reading files: ${seen.percents.slice(0, 6).join('%, ')}% …`);
  ok(seen.eta && seen.eta.etaMs >= 0 && seen.eta.total === 30 && seen.eta.done < 30, `time left estimated (${seen.eta && Math.round(seen.eta.etaMs / 1000)} s with ${seen.eta && seen.eta.done}/30 done)`);
  const proc = (await call('GET', '/api/processes')).data;
  ok(proc.scanService.current === null && proc.metadata.concurrency === 3 && proc.metadata.progress === null, 'processes: nothing running; metadata concurrency 3 by default');

  // ---- metadata concurrency setting ----
  ok((await call('PATCH', '/api/config', { metadataConcurrency: 0 })).status === 400 && (await call('PATCH', '/api/config', { metadataConcurrency: 9 })).status === 400, 'metadata concurrency limited to 1–8');
  await call('PATCH', '/api/config', { metadataConcurrency: 5 });
  ok((await call('GET', '/api/processes')).data.metadata.concurrency === 5, 'metadata concurrency saved and used');

  // ---- genres re-read once from files read by an older version ----
  ok(/read \d+ files/.test(log), 'scans report how many files were read');

  console.log(`\nALL ${passed} DISPLAY/FILTER CHECKS PASSED`);
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2000)); try { srv.kill(); } catch {} process.exit(1); });
