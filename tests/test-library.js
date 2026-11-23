// node test-library.js <app dir> — end-to-end test of libraries, scanning, reading and organizing
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), zlib = require('zlib');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-lib-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media'), MEDIA2 = path.join(TMP, 'media2');
execFileSync(process.execPath, [path.join(__dirname, 'make-comics.js'), MEDIA]);
fs.mkdirSync(path.join(MEDIA2, 'Gamma'), { recursive: true });
fs.copyFileSync(path.join(MEDIA, 'loose.cbz'), path.join(MEDIA2, 'Gamma', 'Gamma 1.cbz'));
const PORT = 3993, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, out = '';

function start() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA } });
    out += '\n--- server start ---\n';
    srv.stdout.on('data', d => { out += d; if (out.includes('Libraries:')) resolve(out); });
    srv.stderr.on('data', d => { out += d; });
    srv.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });
}
// Windows can't send SIGTERM (kill is instant), so give batched saves (300 ms) time to land first,
// as a normal shutdown would flush them
async function stop() { await new Promise(r => setTimeout(r, 600)); return new Promise(r => { srv.removeAllListeners('exit'); srv.on('exit', r); srv.kill(); }); }
async function call(method, url, body, cookie, extra = {}) {
  const headers = Object.assign({}, extra);
  if (method !== 'GET' && method !== 'HEAD') headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {}) });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, headers: res.headers, cookie: sc ? sc.split(';')[0] : null };
}
const ok = (c, name) => { assert(c, name); passed++; console.log('  ✓', name); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitScan(cookie) {
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', '/api/libraries', null, cookie);
    if (r.data.libraries.every(l => !l.scanning && l.lastScan)) return r.data.libraries;
    await wait(100);
  }
  throw new Error('scan did not finish');
}

(async () => {
  await start();
  const admin = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  ok((await call('GET', '/api/series')).status === 401, 'library API requires sign-in');

  let r = await call('POST', '/api/libraries', { name: 'Comics', root: path.join(TMP, 'nope') }, admin);
  ok(r.status === 400 && r.data.error === 'folderNotFound', 'missing folder rejected');
  r = await call('POST', '/api/libraries', { name: 'Data', root: DATA }, admin);
  ok(r.status === 400 && r.data.error === 'folderNotAllowed', 'data folder cannot be a library');
  r = await call('GET', '/api/fs?path=' + encodeURIComponent(TMP), null, admin);
  ok(r.data.dirs.some(d => d.name === 'media'), 'folder browser lists folders');

  r = await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA }, admin);
  ok(r.status === 201, 'library created');
  const lib = r.data.library.id;
  r = await call('POST', '/api/libraries', { name: 'Again', root: MEDIA }, admin);
  ok(r.data.error === 'folderInUse', 'same folder cannot be added twice');
  const lib2 = (await call('POST', '/api/libraries', { name: 'Private', root: MEDIA2 }, admin)).data.library.id;
  let libs = await waitScan(admin);
  const L = libs.find(l => l.id === lib);
  ok(L.seriesCount === 4 && L.booksCount === 7, `scan found 4 series / 7 books (got ${L.seriesCount}/${L.booksCount})`);
  ok(L.lastScan.unsupported === 1 && L.lastScan.failedBooks === 1, 'unsupported .cbr counted, broken archive flagged');

  r = await call('GET', `/api/series?library=${lib}`, null, admin);
  const titles = r.data.items.map(s => s.title);
  ok(JSON.stringify(titles) === JSON.stringify(['Alpha!', 'Beta', 'loose', 'Webtoon Tale']), `series titles & sort (loose file = one-shot by default): ${titles.join(', ')}`);
  const alpha = r.data.items.find(s => s.title === 'Alpha!');
  ok(alpha.readingDirection === 'rtl' && alpha.publisher === 'Thoth Press' && alpha.genres.includes('Comedy') && !alpha.tags.includes('Comedy'), 'ComicInfo series metadata (rtl, publisher, <Genre> as genres)');
  ok(r.data.items.find(s => s.title === 'Webtoon Tale').readingDirection === 'vertical', 'webtoon format → vertical reading');

  r = await call('GET', `/api/series/${alpha.id}`, null, admin);
  const books = r.data.books;
  ok(books.map(b => b.fileName).join() === 'Alpha v01.cbz,Alpha v02.cbz,Alpha v10.cbz', 'books in natural order (v02 before v10)');
  ok(books[0].title === 'The First & Best' && books[0].authors.some(a => a.name === 'Ann Writer' && a.role === 'writer') && books[0].releaseDate === '2024-03-01', 'ComicInfo book metadata');
  ok(books[0].pageCount === 3 && books[1].pageCount === 2, 'page counts');

  // pages: sorted by name even though stored reversed; content equals the PNG in the archive
  const p1 = await call('GET', `/api/books/${books[0].id}/pages/1`, null, admin);
  ok(p1.status === 200 && p1.headers.get('content-type') === 'image/png' && p1.data.subarray(1, 4).toString() === 'PNG', 'page image served as PNG');
  const etag = p1.headers.get('etag');
  ok((await call('GET', `/api/books/${books[0].id}/pages/1`, null, admin, { 'If-None-Match': etag })).status === 304, 'unchanged page answers 304 (browser cache)');
  ok((await call('GET', `/api/books/${books[0].id}/pages/9`, null, admin)).status === 404, 'missing page 404');
  ok((await call('GET', `/api/series/${alpha.id}/thumbnail`, null, admin)).status === 200, 'series cover');

  const beta = (await call('GET', `/api/series?library=${lib}&q=beta`, null, admin)).data.items[0];
  const betaBooks = (await call('GET', `/api/series/${beta.id}`, null, admin)).data.books;
  const pdfBook = betaBooks.find(b => b.format === 'pdf');
  ok(pdfBook.pageCount === 2, 'PDF page count read');
  ok(betaBooks.find(b => b.fileName === 'broken.cbz').error, 'broken book has an error');
  r = await call('GET', `/api/books/${pdfBook.id}/file`, null, admin, { Range: 'bytes=0-7' });
  ok(r.status === 206 && r.data.toString() === '%PDF-1.4' && r.headers.get('content-range').startsWith('bytes 0-7/'), 'file download supports ranges (PDF reader)');
  r = await call('GET', `/api/books/${books[0].id}/file?download=1`, null, admin);
  ok(r.status === 200 && /attachment/.test(r.headers.get('content-disposition')), 'download as attachment');

  // progress
  r = await call('PUT', `/api/books/${books[0].id}/progress`, { page: 2 }, admin);
  ok(r.data.progress.page === 2 && !r.data.progress.completed, 'progress saved');
  await wait(800);
  ok(fs.existsSync(path.join(DATA, 'progress.json')), 'progress written to disk within a moment');
  let home = (await call('GET', '/api/home', null, admin)).data;
  ok(home.keepReading[0].id === books[0].id, 'home: keep reading');
  await call('PUT', `/api/books/${books[0].id}/progress`, { page: 3 }, admin);
  home = (await call('GET', '/api/home', null, admin)).data;
  ok(!home.keepReading.length && home.onDeck[0].id === books[1].id, 'finishing a book puts the next one on deck');
  r = await call('GET', `/api/books/${books[1].id}`, null, admin);
  ok(r.data.prev.id === books[0].id && r.data.next.id === books[2].id, 'book has previous/next');
  await call('POST', `/api/series/${alpha.id}/progress`, { completed: true }, admin);
  r = await call('GET', `/api/series/${alpha.id}`, null, admin);
  ok(r.data.series.booksRead === 3, 'mark series as read');
  ok((await call('GET', `/api/series?library=${lib}&read=read`, null, admin)).data.items.length === 1, 'filter series by read status');

  // admin edits
  r = await call('PATCH', `/api/series/${alpha.id}`, { title: 'Alpha (edited)', status: 'ended', tags: 'x, y' }, admin);
  ok(r.data.series.title === 'Alpha (edited)' && r.data.series.status === 'ended' && r.data.series.tags.join() === 'x,y', 'admin edits series metadata');
  r = await call('PATCH', `/api/books/${books[2].id}`, { number: '0.5' }, admin);
  r = await call('GET', `/api/series/${alpha.id}`, null, admin);
  ok(r.data.books[0].fileName === 'Alpha v10.cbz', 'editing a book number reorders the series');

  // search, collections, read lists
  r = await call('GET', '/api/search?q=ann%20writer', null, admin);
  ok(r.data.books.length === 1, 'search books by author');
  r = await call('GET', '/api/search?q=alpha', null, admin);
  ok(r.data.series.length === 1, 'search series');
  const coll = (await call('POST', '/api/collections', { name: 'Favorites', seriesIds: [alpha.id, beta.id] }, admin)).data.collection;
  ok(coll.seriesCount === 2, 'collection created');
  const rl = (await call('POST', '/api/readlists', { name: 'Crossover', bookIds: [books[1].id, pdfBook.id] }, admin)).data.readlist;
  r = await call('GET', `/api/books/${books[1].id}?readlist=${rl.id}`, null, admin);
  ok(r.data.next.id === pdfBook.id, 'reading inside a read list follows the list order');

  // a regular user restricted to one library
  await call('POST', '/api/users', { username: 'kid', password: 'kidpass12', libraries: [lib2] }, admin);
  const kid = (await call('POST', '/api/login', { username: 'kid', password: 'kidpass12' })).cookie;
  r = await call('GET', '/api/libraries', null, kid);
  ok(r.data.libraries.length === 1 && r.data.libraries[0].id === lib2 && !('root' in r.data.libraries[0]), 'user only sees allowed libraries (no server paths)');
  ok((await call('GET', `/api/series/${alpha.id}`, null, kid)).status === 404, 'other library series hidden');
  ok((await call('GET', `/api/books/${books[0].id}/pages/1`, null, kid)).status === 404, 'other library pages hidden');
  ok((await call('GET', '/api/search?q=alpha', null, kid)).data.series.length === 0, 'search respects access');
  ok((await call('GET', '/api/collections', null, kid)).data.collections.length === 0, 'collections with no visible series are hidden');
  ok((await call('POST', '/api/libraries', { name: 'X', root: MEDIA }, kid)).status === 403, 'users cannot add libraries');
  ok((await call('GET', '/api/fs', null, kid)).status === 403, 'users cannot browse server folders');
  ok((await call('PATCH', `/api/series/${alpha.id}`, { title: 'hack' }, kid)).status === 404, 'users cannot edit hidden series');
  const gamma = (await call('GET', '/api/series', null, kid)).data.items[0];
  ok((await call('PATCH', `/api/series/${gamma.id}`, { title: 'hack' }, kid)).status === 403, 'users cannot edit metadata');
  const gBook = (await call('GET', `/api/series/${gamma.id}`, null, kid)).data.books[0];
  await call('PUT', `/api/books/${gBook.id}/progress`, { page: 1 }, kid);
  ok((await call('GET', `/api/series/${gamma.id}`, null, admin)).data.series.booksInProgress === 0, 'reading progress is per user');

  // rescans: removed + changed files
  fs.unlinkSync(path.join(MEDIA, 'Alpha Series', 'Alpha v02.cbz'));
  fs.copyFileSync(path.join(MEDIA, 'Webtoon Tale', 'Episode 1.cbz'), path.join(MEDIA, 'loose.cbz'));
  const later = new Date(Date.now() + 5000); fs.utimesSync(path.join(MEDIA, 'loose.cbz'), later, later);
  await call('POST', `/api/libraries/${lib}/scan`, {}, admin);
  libs = await waitScan(admin);
  const s2 = libs.find(l => l.id === lib).lastScan;
  ok(s2.removed === 1 && s2.updated === 1 && s2.added === 0, `rescan: 1 removed, 1 changed (got -${s2.removed} ~${s2.updated} +${s2.added})`);
  ok((await call('GET', `/api/books/${books[1].id}`, null, admin)).status === 404, 'removed file is gone');
  r = await call('GET', `/api/readlists/${rl.id}`, null, admin);
  ok(r.data.readlist.books.length === 1, 'removed book dropped from read list');
  r = await call('GET', `/api/series/${alpha.id}`, null, admin);
  ok(r.data.series.title === 'Alpha (edited)', 'admin edits survive a rescan');

  // persistence & deletion
  await stop(); await start();
  ok((await call('GET', `/api/books/${books[0].id}`, null, admin)).data.book.progress.completed, 'library and progress survive restart');
  await call('DELETE', '/api/users/kid', {}, admin);
  await wait(600);
  const prog = JSON.parse(fs.readFileSync(path.join(DATA, 'progress.json'), 'utf8'));
  ok(!prog.kid, "deleting a user deletes their progress");
  ok((await call('DELETE', `/api/libraries/${lib}`, {}, admin)).status === 200, 'library deleted');
  ok(fs.existsSync(path.join(MEDIA, 'Alpha Series', 'Alpha v01.cbz')), 'deleting a library never deletes files');
  r = await call('GET', `/api/collections/${coll.id}`, null, admin);
  ok(r.data.collection.seriesCount === 0, 'collection emptied when library removed');
  ok((await fetch(BASE + '/library/db.js')).status === 403, 'server code not served');

  await stop();
  console.log(`\nALL ${passed} LIBRARY CHECKS PASSED`);
  process.exit(0);
})().catch(async e => { console.error('\nFAILED:', e.message, '\nSERVER LOG:', out, '\nDATA:', fs.readdirSync(DATA)); try { srv.kill(); } catch {} process.exit(1); });
