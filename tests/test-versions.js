// node test-versions.js <app dir> — versions of a work, and scanning in a separate process
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const { makeZip, png } = (() => { const m = {}; const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-ver-'));
const PORT = 3987, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0;

const book = (n, c) => makeZip(Array.from({ length: n }, (_, i) => [`p${String(i + 1).padStart(3, '0')}.png`, png(60, 90, [c, 100, 200 - c], i)]));
function write(dir, name, data) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), data); }

// Library 1: versions
const V = path.join(TMP, 'versions');
write(path.join(V, 'Work'), 'Work 01.cbz', book(3, 10)); write(path.join(V, 'Work'), 'Work 02.cbz', book(2, 20));
write(path.join(V, 'Work (Colored)'), 'Work 01.cbz', book(3, 30));
write(path.join(V, 'Work [Raw]'), 'Work 01.cbz', book(3, 40)); write(path.join(V, 'Work [Raw]'), 'Work 02.cbz', book(3, 50)); write(path.join(V, 'Work [Raw]'), 'Work 03.cbz', book(3, 60));
write(path.join(V, 'Other (2019)'), 'Other 1.cbz', book(2, 70));
write(V, 'Solo.cbz', book(2, 80)); write(V, 'Solo (Uncensored).cbz', book(2, 90));
write(path.join(V, 'Late (Animated)'), 'Late 1.cbz', book(1, 100)); // a work with only a non-base version
write(path.join(V, 'Extras', 'Work'), 'Bonus.cbz', book(1, 110));  // another "Work" folder that is also Base → separate card
// One Piece: the colored version's ComicInfo calls it something else; grouping must use the folder name
write(path.join(V, 'One Piece'), 'Chapter 1.cbz', book(2, 10)); write(path.join(V, 'One Piece'), 'Chapter 2.cbz', book(2, 20));
write(path.join(V, 'One Piece (Colored)'), 'Chapter 1.cbz', makeZip([['ComicInfo.xml', Buffer.from('<ComicInfo><Series>One Piece - Digital Colored Comics</Series><Number>1</Number></ComicInfo>')], ['p001.png', png(60, 90, [200, 30, 30], 0)]]));
// Library 3: another version of "Work", in a different library
const X = path.join(TMP, 'other-library');
write(path.join(X, 'Work (Uncensored)'), 'Work 01.cbz', book(2, 120));

// Library 2: heavy (many archives + big PDFs) to measure server responsiveness during a scan
const H = path.join(TMP, 'heavy');
const small = book(40, 5);
for (let s = 0; s < 30; s++) for (let b = 0; b < 15; b++) write(path.join(H, `Series ${s}`), `Book ${b}.cbz`, small);
const filler = Buffer.alloc(40 * 1024 * 1024, 'x'); // 40 MB of text the PDF page counter has to read through
for (let i = 0; i < 6; i++) write(path.join(H, 'PDFs'), `Big ${i}.pdf`, Buffer.concat([Buffer.from('%PDF-1.4\n'), filler, Buffer.from(`\n1 0 obj << /Type /Pages /Count ${i + 1} >> endobj\n%%EOF\n`)]));

function start(env = {}) {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: path.join(TMP, 'data-' + (env.THOTH_SCAN_IN_PROCESS ? 'inproc' : 'worker')), ...env } });
    let out = ''; srv.stdout.on('data', d => { out += d; if (out.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => out += d);
    srv.on('exit', c => reject(new Error('exit ' + c + out)));
  });
}
const stop = () => new Promise(r => { srv.removeAllListeners('exit'); srv.on('exit', r); srv.kill(); });
const call = async (m, u, b, c) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json(), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function idle(c) {
  await wait(100);
  for (let i = 0; i < 600; i++) { const ls = (await call('GET', '/api/libraries', null, c)).data.libraries; if (ls.every(l => !l.scanning)) return ls; await wait(100); }
  throw new Error('scan timeout');
}
// Mark every file in the heavy library as changed, so the next scan re-reads all of them
let touchN = 0;
function touchAll(dir) {
  const t = new Date(Date.now() + 1000000 + (++touchN) * 1000);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) touchAll(p); else fs.utimesSync(p, t, t);
  }
}
// Response times of a cheap request while a full re-scan of the heavy library runs
async function latencyDuringScan(c, libId) {
  touchAll(H);
  await call('POST', `/api/libraries/${libId}/scan`, {}, c);
  const times = [];
  let sawScanning = false;
  for (let i = 0; i < 400; i++) {
    const t0 = performance.now();
    const ls = (await call('GET', '/api/libraries', null, c)).data.libraries;
    times.push(performance.now() - t0);
    const l = ls.find(x => x.id === libId);
    if (l.scanning) sawScanning = true; else if (sawScanning) break;
    await wait(10);
  }
  times.sort((a, b) => a - b);
  return { samples: times.length, median: Math.round(times[times.length >> 1]), p95: Math.round(times[Math.floor(times.length * 0.95)]), max: Math.round(times[times.length - 1]) };
}

(async () => {
  await start();
  const c = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const lv = (await call('POST', '/api/libraries', { name: 'Versions', root: V }, c)).data.library.id;
  const lh = (await call('POST', '/api/libraries', { name: 'Heavy', root: H }, c)).data.library.id;
  // second library waits while the first scans
  const both = (await call('GET', '/api/libraries', null, c)).data.libraries;
  ok(both.some(l => l.scanProgress && l.scanProgress.queued), 'scans are queued: one library waits while another scans');
  let libs = await idle(c);
  ok(libs.every(l => l.lastScan.mode === 'worker'), 'scans ran in the separate scan process');
  ok(libs.find(l => l.id === lh).booksCount === 456, `heavy library fully scanned (${libs.find(l => l.id === lh).booksCount} books)`);

  // ---- versions ----
  let r = await call('GET', `/api/series?library=${lv}`, null, c);
  const desc = r.data.items.map(s => `${s.title}[${s.editions.map(e => e.edition).join('+')}]`).join(', ');
  ok(r.data.total === 6, `works grouped: ${desc}`);
  const op = r.data.items.find(s => s.title === 'One Piece');
  ok(op && op.editions.map(e => e.edition).join() === 'base,colored', 'One Piece + One Piece (Colored) combined, even though ComicInfo names the colored one differently');
  r = await call('GET', `/api/series/${op.editions[1].id}`, null, c);
  ok(r.data.workTitle === 'One Piece' && r.data.series.edition === 'colored' && r.data.books.length === 1, 'Colored tab: work title "One Piece", its own chapters');
  r = await call('GET', `/api/series?library=${lv}`, null, c);
  const works = r.data.items.filter(s => s.title === 'Work');
  ok(works.length === 2 && works.some(w => w.editions.length === 1 && w.booksCount === 1), 'a second Base "Work" folder stays a separate card (no two Base tabs)');
  const work = works.find(w => w.editions.length === 3);
  ok((await call('GET', `/api/series/${works.find(w => w.editions.length === 1).id}`, null, c)).data.editions.length === 1, 'the separate one has no tabs');
  ok(work.edition === 'base' && work.editions.map(e => e.edition).join() === 'base,colored,raw', 'Work: Base card with Colored and Raw versions, in order');
  ok(work.booksCount === 2, 'the card shows the Base version\'s books');
  ok(r.data.items.find(s => s.title === 'Other (2019)').editions.length === 1, '"(2019)" is part of the title, not a version');
  const solo = r.data.items.find(s => s.title === 'Solo');
  ok(solo.oneshot && solo.editions.map(e => e.edition).join() === 'base,uncensored', 'one-shot files group too (Solo + Solo (Uncensored))');
  const late = r.data.items.find(s => s.title === 'Late');
  ok(late && late.edition === 'animated' && late.editions.length === 1, 'a work with only an Animated version still shows');

  const colored = work.editions.find(e => e.edition === 'colored');
  r = await call('GET', `/api/series/${colored.id}`, null, c);
  ok(r.data.series.title === 'Work' && r.data.series.edition === 'colored', 'version page: work title + its version');
  ok(r.data.editions.map(e => e.edition).join() === 'base,colored,raw' && r.data.editions[2].booksCount === 3, 'version page lists all versions for the tabs');
  ok(r.data.books.length === 1, 'each version keeps its own books');

  // progress is per version
  const coloredBook = r.data.books[0];
  await call('PUT', `/api/books/${coloredBook.id}/progress`, { page: 3 }, c);
  r = await call('GET', `/api/series/${work.id}`, null, c);
  ok(r.data.series.booksRead === 0 && r.data.editions.find(e => e.edition === 'colored').booksRead === 1, 'reading a version doesn\'t mark the other versions');

  r = await call('GET', '/api/search?q=work', null, c);
  ok(r.data.series.length === 2 && r.data.series.filter(s => s.editions.length === 3).length === 1, 'search returns the work once (plus the separate Base folder)');
  r = await call('GET', '/api/home', null, c);
  const keys = r.data.recentSeries.map(s => s.libraryId + '/' + s.title);
  ok(keys.length === new Set(keys).size && r.data.recentSeries.every(s => s.editions), 'home never shows a work twice');

  // admin corrects a version
  const raw = work.editions.find(e => e.edition === 'raw');
  r = await call('PATCH', `/api/series/${raw.id}`, { edition: 'uncensored' }, c);
  ok(r.data.series.edition === 'uncensored', 'admin can override a version');
  r = await call('GET', `/api/series/${work.id}`, null, c);
  ok(r.data.editions.map(e => e.edition).join() === 'base,colored,uncensored', 'tabs follow the override');
  ok((await call('PATCH', `/api/series/${raw.id}`, { edition: 'deluxe' }, c)).status === 400, 'unknown versions rejected');
  await call('PATCH', `/api/series/${raw.id}`, { edition: '' }, c);
  ok((await call('GET', `/api/series/${raw.id}`, null, c)).data.series.edition === 'raw', 'clearing the override goes back to the detected version');

  // ---- versions across libraries ----
  const lx = (await call('POST', '/api/libraries', { name: 'Other', root: X }, c)).data.library.id;
  await idle(c);
  r = await call('GET', `/api/series?library=${lv}`, null, c);
  let w = r.data.items.find(s => s.title === 'Work' && s.editions.length > 1);
  ok(w.editions.map(e => e.edition).join() === 'base,colored,raw,uncensored', `a version in another library joins the work (${w.editions.map(e => e.edition).join(', ')})`);
  r = await call('GET', `/api/series?library=${lx}`, null, c);
  ok(r.data.total === 1 && r.data.items[0].edition === 'uncensored' && r.data.items[0].libraryId === lx && r.data.items[0].editions.length === 4,
    'on the other library\'s page, the card shows its own version, with all 4 tabs');
  // a user who can't see the other library doesn't get its tab
  await call('POST', '/api/users', { username: 'viewer', password: 'viewerpass1', libraries: [lv] }, c);
  const vc = (await call('POST', '/api/login', { username: 'viewer', password: 'viewerpass1' })).cookie;
  r = await call('GET', `/api/series/${w.id}`, null, vc);
  ok(r.data.editions.map(e => e.edition).join() === 'base,colored,raw', 'tabs only include versions in libraries the user can access');
  ok((await call('GET', '/api/nope', null, c)).data.error === 'unknownEndpoint', 'unknown API routes answer "unknownEndpoint" (not "not found")');

  // ---- the scan process ----
  const worker = await latencyDuringScan(c, lh);
  console.log(`    response times during a heavy scan (separate process): median ${worker.median} ms, p95 ${worker.p95} ms, max ${worker.max} ms (${worker.samples} samples)`);

  // killing the scan process mid-scan: error recorded, server keeps running, next scan works
  fs.utimesSync(path.join(H, 'PDFs', 'Big 0.pdf'), new Date(), new Date(Date.now() + 60000)); // force re-reading
  for (let i = 1; i < 6; i++) fs.utimesSync(path.join(H, 'PDFs', `Big ${i}.pdf`), new Date(), new Date(Date.now() + 60000));
  await call('POST', `/api/libraries/${lh}/scan`, {}, c);
  let pid = null;
  for (let i = 0; i < 100 && !pid; i++) { const l = (await call('GET', '/api/libraries', null, c)).data.libraries.find(x => x.id === lh); pid = l.scanProgress && l.scanProgress.worker; await wait(20); }
  ok(pid && pid !== srv.pid, `scan runs in its own process (pid ${pid}, server ${srv.pid})`);
  const prio = os.getPriority(pid), serverPrio = os.getPriority(srv.pid);
  ok(prio === os.constants.priority.PRIORITY_LOW && serverPrio !== prio, `scan process has the lowest CPU priority (${prio}; server ${serverPrio})`);
  process.kill(pid);
  libs = await idle(c);
  const h = libs.find(l => l.id === lh);
  ok(/stopped unexpectedly/.test(h.scanError || ''), `killed scan process is reported: "${h.scanError}"`);
  ok((await call('GET', '/api/session', null, c)).status === 200, 'server keeps running');
  await call('POST', `/api/libraries/${lh}/scan`, {}, c);
  libs = await idle(c);
  ok(!libs.find(l => l.id === lh).scanError && libs.find(l => l.id === lh).booksCount === 456, 'next scan succeeds and clears the error');
  await stop();

  // Same heavy scan inside the server process, for comparison
  await start({ THOTH_SCAN_IN_PROCESS: '1' });
  const c2 = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const lh2 = (await call('POST', '/api/libraries', { name: 'Heavy', root: H }, c2)).data.library.id;
  const libs2 = await idle(c2);
  ok(libs2[0].lastScan.mode === 'server', 'THOTH_SCAN_IN_PROCESS=1 scans inside the server');
  const inproc = await latencyDuringScan(c2, lh2);
  console.log(`    response times during the same scan inside the server: median ${inproc.median} ms, p95 ${inproc.p95} ms, max ${inproc.max} ms (${inproc.samples} samples)`);
  await stop();

  console.log(`\nALL ${passed} VERSION/WORKER CHECKS PASSED`);
  process.exit(0);
})().catch(async e => { console.error('\nFAILED:', e.message); try { srv.kill(); } catch {} process.exit(1); });
