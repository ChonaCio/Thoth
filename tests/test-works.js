// node tests/test-works.js <app dir> — chapter order, advanced search (include/exclude), deleting works
// (hide/restore and deleting files). Offline.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-works-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const cbz = (n, info) => makeZip([...(info ? [['ComicInfo.xml', Buffer.from(info)]] : []), ['p1.png', png(20, 30, [n * 40 % 255, 90, 140], n)]]);
const ci = (genres, tags, year, writer) => `<ComicInfo><Genre>${genres}</Genre><Tags>${tags}</Tags><Year>${year}</Year><Writer>${writer}</Writer></ComicInfo>`;
// Works with known genres/tags/years/authors (ComicInfo in their first book)
const WORKS = {
  Alpha: ci('Action, Comedy', 'Pirates', 1997, 'Ann Writer'),
  Beta: ci('Action, Drama', 'Gore', 2005, 'Bob Author'),
  Gamma: ci('Comedy', 'School', 2015, 'Ann Writer'),
  Delta: ci('Drama, Romance', 'School, Gore', 2020, 'Cid Pen')
};
Object.entries(WORKS).forEach(([name, info], i) => {
  fs.mkdirSync(path.join(MEDIA, name), { recursive: true });
  for (let c = 1; c <= 3; c++) fs.writeFileSync(path.join(MEDIA, name, `Ch ${c}.cbz`), cbz(i * 3 + c, c === 1 ? info : null));
});
fs.mkdirSync(path.join(MEDIA, 'Epsilon'), { recursive: true });
fs.writeFileSync(path.join(MEDIA, 'Epsilon', 'Ch 1.cbz'), cbz(20));
fs.writeFileSync(path.join(MEDIA, 'Epsilon', 'notes.txt'), 'keep me'); // keeps the folder after deleting files
fs.mkdirSync(path.join(MEDIA, 'Zeta'), { recursive: true });
fs.writeFileSync(path.join(MEDIA, 'Zeta', 'Ch 1.cbz'), cbz(21));
fs.writeFileSync(path.join(MEDIA, 'Zeta', 'Ch 2.cbz'), cbz(22));

const PORT = 3990, BASE = `http://127.0.0.1:${PORT}`;
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
  return { status: r.status, data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const titles = async (qs, c) => (await call('GET', '/api/series?limit=100' + qs, null, c)).data.items.map(s => s.title).sort().join(',');

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library.id;
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  const id = async title => (await call('GET', '/api/series?limit=100')).data.items.find(s => s.title === title).id;
  const alpha = await id('Alpha');

  // ---- chapter order ----
  let s = (await call('GET', `/api/series/${alpha}`)).data.series;
  ok(s.bookOrder === 'asc', 'default chapter order: first chapter first');
  ok((await call('PATCH', `/api/libraries/${L}`, { defaults: { bookOrder: 'random' } })).status === 400, 'invalid chapter order rejected');
  await call('PATCH', `/api/libraries/${L}`, { defaults: { bookOrder: 'desc' } });
  ok((await call('GET', `/api/series/${alpha}`)).data.series.bookOrder === 'desc', 'library default: last chapter first');
  await call('PATCH', `/api/series/${alpha}`, { bookOrder: 'asc' });
  ok((await call('GET', `/api/series/${alpha}`)).data.series.bookOrder === 'asc', 'a work’s own order beats the library default');
  await call('PATCH', `/api/series/${alpha}`, { bookOrder: '' });
  ok((await call('GET', `/api/series/${alpha}`)).data.series.bookOrder === 'desc', 'cleared: back to the library default');

  // ---- advanced search ----
  ok(await titles('&genre=Action') === 'Alpha,Beta', 'include one genre');
  ok(await titles('&genre=Action&genre=Comedy') === 'Alpha', 'include two genres: works need both');
  ok(await titles('&genre=Action&xgenre=Drama') === 'Alpha', 'include + exclude genres');
  ok(await titles('&xtag=Gore') === 'Alpha,Epsilon,Gamma,Zeta', 'exclude a tag (works without tags stay)');
  ok(await titles('&tag=School&xgenre=Romance') === 'Gamma', 'tag included, genre excluded');
  ok(await titles('&yearFrom=2000&yearTo=2016') === 'Beta,Gamma', 'year range');
  ok(await titles('&author=ann') === 'Alpha,Gamma', 'author contains');
  ok(await titles('&genre=comedy&yearFrom=2010&author=writer') === 'Gamma', 'several criteria at once');
  ok(await titles('&metadata=none&xgenre=Action&xgenre=Comedy') === 'Delta,Epsilon,Zeta', 'metadata state + several exclusions');
  ok(await titles('&status=unknown&xstatus=unknown') === '', 'the same value included and excluded matches nothing');

  // ---- hide (logical delete) ----
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  const beta = await id('Beta');
  const betaBook = (await call('GET', `/api/series/${beta}`)).data.books[0].id;
  ok((await call('POST', `/api/series/${beta}/delete`, { mode: 'hide' }, bob)).status === 403, 'only admins delete works');
  ok((await call('POST', `/api/series/${beta}/delete`, { mode: 'hide' })).data.hidden === 1, 'hide a work');
  ok(!(await titles('', bob)).includes('Beta') && !(await titles('')).includes('Beta'), 'hidden: gone from the library (users and admins)');
  ok((await call('GET', `/api/series/${beta}`, null, bob)).status === 404 && (await call('GET', `/api/books/${betaBook}`, null, bob)).status === 404, 'users can’t open it or its books');
  ok(!(await call('GET', '/api/search?q=beta', null, bob)).data.series.length, 'not in search');
  const lib = (await call('GET', '/api/libraries')).data.libraries[0];
  ok(lib.hiddenCount === 1 && lib.seriesCount === 5, 'library counts skip it; admins see how many are hidden');
  ok(await titles('&deleted=1') === 'Beta' && await titles('&deleted=1', bob) !== 'Beta', 'admins list hidden works (users can’t)');
  const hv = (await call('GET', `/api/series/${beta}`)).data.series;
  ok(hv.hidden && hv.hidden.by === 'admin', 'admins can open it: hidden by whom and when');
  fs.writeFileSync(path.join(MEDIA, 'Beta', 'Ch 4.cbz'), cbz(30));
  await call('POST', `/api/libraries/${L}/scan`, {});
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan.books === 16 && l; });
  ok(!(await titles('')).includes('Beta') && (await call('GET', `/api/series/${beta}`)).data.books.length === 4, 'stays hidden after a scan (new chapter added to it)');
  ok((await call('POST', `/api/series/${beta}/restore`, {})).data.restored === 1 && (await titles('', bob)).includes('Beta'), 'restore: back for everyone');

  // ---- delete files (physical) ----
  const zeta = await id('Zeta');
  ok((await call('POST', `/api/series/${zeta}/delete`, { mode: 'files', confirm: 'Wrong' })).data.error === 'confirmMismatch', 'deleting files needs the title typed');
  ok(fs.existsSync(path.join(MEDIA, 'Zeta', 'Ch 1.cbz')), '…and nothing was deleted');
  let r = (await call('POST', `/api/series/${zeta}/delete`, { mode: 'files', confirm: ' zeta ' })).data;
  ok(r.deletedBooks === 2 && r.deletedWorks === 1 && !r.failed.length, 'files deleted (title match ignores case and spaces)');
  ok(!fs.existsSync(path.join(MEDIA, 'Zeta')) && (await call('GET', `/api/series/${zeta}`)).status === 404, 'the empty folder is gone and so is the work');
  const eps = await id('Epsilon');
  r = (await call('POST', `/api/series/${eps}/delete`, { mode: 'files', confirm: 'Epsilon' })).data;
  ok(r.deletedWorks === 1 && fs.existsSync(path.join(MEDIA, 'Epsilon', 'notes.txt')), 'a folder with other files in it is kept');
  await call('POST', `/api/libraries/${L}/scan`, { mode: 'quick' });
  await until(async () => !(await call('GET', '/api/libraries')).data.libraries[0].scanning);
  ok(!(await titles('')).includes('Zeta') && !(await titles('')).includes('Epsilon'), 'deleted works don’t come back with the next scan');

  console.log(`\nALL ${passed} WORK CHECKS PASSED`);
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2000)); try { srv.kill(); } catch {} process.exit(1); });
