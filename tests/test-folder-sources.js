// node tests/test-folder-sources.js <app dir> — folder metadata sources (JSON files matched to books and
// works): create/edit/delete, both match modes, precedence, covers, applying after scans, the check report.
// Offline.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-fsrc-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media'), SRC_A = path.join(TMP, 'meta-a'), SRC_B = path.join(TMP, 'meta-b');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const cbz = (n, extra = []) => makeZip([...extra, ...Array.from({ length: 2 }, (_, i) => [`p${i}.png`, png(20, 30, [n * 30 % 255, 80, 120], i)])]);
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };

// Library: two works that both have an "11", and a one-shot
write(path.join(MEDIA, 'One Piece', '11.cbz'), cbz(1, [['ComicInfo.xml', Buffer.from('<ComicInfo><Title>From ComicInfo</Title><Summary>CI summary</Summary></ComicInfo>')]]));
write(path.join(MEDIA, 'One Piece', '12.cbz'), cbz(2));
write(path.join(MEDIA, 'Naruto', '11.cbz'), cbz(3));
write(path.join(MEDIA, 'Short.cbz'), cbz(4));
// Source A, same structure as the library
const COVER = png(60, 90, [200, 30, 30], 1);
write(path.join(SRC_A, 'One Piece.json'), { Summary: 'Pirates!', Genres: ['Adventure', 'Action'], Tags: 'Pirates, Ships', Status: 'Completed', Type: 'manga', Year: 1997, Rating: 9.1, Writer: 'Eiichiro Oda', cover: 'covers/op.png', Title: 'Ignored title' });
write(path.join(SRC_A, 'covers', 'op.png'), COVER);
write(path.join(SRC_A, 'One Piece', '11.json'), { title: 'The Eleventh', number: '11', date: '1998-03-04', summary: 'Chapter 11 from JSON' });
write(path.join(SRC_A, 'Short.json'), { title: 'A Short Story', summary: 'Short from JSON', genre: 'Drama' });
write(path.join(SRC_A, 'Short.jpg'), COVER);
// Source B, flat, matched by file name
write(path.join(SRC_B, '11.json'), { title: 'Eleven by name', chapter: 11 });
write(path.join(SRC_B, 'Naruto.json'), { description: 'Ninjas', 'reading direction': 'right to left' });
write(path.join(SRC_B, 'bad.json'), '{ not json');
write(path.join(SRC_B, 'unused-thing.json'), { title: 'nothing' });

const PORT = 3988, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, cookie, log = '';
function start() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA } });
    srv.stdout.on('data', d => { log += d; if (log.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => { log += d; });
    srv.on('exit', c => reject(new Error('exit ' + c + log)));
  });
}
const call = async (m, u, b, c = cookie) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' || (m === 'DELETE' && !b) ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const works = async (qs = '') => (await call('GET', '/api/series?limit=200' + qs)).data.items;
const work = async title => (await works()).find(s => s.title === title);
const books = async seriesId => (await call('GET', `/api/series/${seriesId}`)).data.books;

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library;
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  let op = await work('One Piece');
  ok(op.localSources.length === 0 && (await books(op.id)).find(b => b.fileName === '11.cbz').title === 'From ComicInfo', 'before: ComicInfo title, no folder data');

  // ---- create ----
  ok((await call('POST', '/api/metadata/sources', { name: 'X', folder: path.join(TMP, 'nope') })).data.error === 'folderNotFound', 'missing folder rejected');
  ok((await call('POST', '/api/metadata/sources', { name: 'X', folder: SRC_A, match: 'fuzzy' })).status === 400, 'unknown match mode rejected');
  ok((await call('POST', '/api/metadata/sources', { name: '', folder: SRC_A })).status === 400, 'a name is required');
  const A = (await call('POST', '/api/metadata/sources', { name: 'My JSON (paths)', folder: SRC_A, match: 'path' })).data.source;
  ok(A.id.startsWith('folder-') && A.match === 'path' && A.usedBy.length === 1, 'source created; every library uses it');
  const provs = (await call('GET', '/api/libraries')).data.libraries[0].metadata.providers;
  ok(provs[0].id === A.id && provs[0].enabled, 'it comes first in the library’s source order, on');

  op = await until(async () => { const w = await work('One Piece'); return w.localSources.length && w; });
  ok(op.summary === 'Pirates!' && op.genres.join() === 'Adventure,Action' && op.tags.join() === 'Pirates,Ships' && op.status === 'ended' && op.type === 'manga' && op.year === 1997 && op.rating === 91,
    'work JSON: summary, genres, tags, status (Completed → ended), type, year, rating (9.1 → 91)');
  ok(op.authors.some(a => a.name === 'Eiichiro Oda') && op.title === 'One Piece' && op.localSources[0].name === 'My JSON (paths)', 'authors; the title stays the library’s; source named on the work');
  const opBooks = await books(op.id);
  const b11 = opBooks.find(b => b.fileName === '11.cbz'), b12 = opBooks.find(b => b.fileName === '12.cbz');
  ok(b11.title === 'The Eleventh' && b11.summary === 'Chapter 11 from JSON' && b11.releaseDate === '1998-03-04' && b11.localSource.id === A.id, '11.json → 11.cbz: title, summary, date (beats ComicInfo)');
  ok(!b12.localSource && b12.title === '12', 'a book without a JSON is untouched');
  const naruto = await work('Naruto');
  ok(!naruto.localSources.length && (await books(naruto.id))[0].title === '11', 'path mode: Naruto/11.cbz is not matched by One Piece/11.json');
  const short = await work('Short');
  ok(short.summary === 'Short from JSON' && short.genres.join() === 'Drama' && (await books(short.id))[0].title === 'A Short Story', 'one-shot: Short.json fills the work and its book');

  // ---- covers ----
  ok(op.localCover && op.coverSource === 'file', 'cover from the JSON’s "cover" path found; the CBZ keeps its first page (library setting)');
  await call('PATCH', `/api/series/${op.id}`, { cover: 'metadata' });
  const th = await fetch(`${BASE}/api/series/${op.id}/thumbnail`, { headers: { Cookie: cookie } });
  ok(th.ok && Buffer.from(await th.arrayBuffer()).equals(COVER), 'work set to "downloaded/metadata cover": serves the folder’s image');
  ok((await work('Short')).localCover, 'an image named like the JSON (Short.jpg) is a cover too');

  // ---- precedence ----
  await call('PATCH', `/api/series/${op.id}`, { summary: 'Admin summary' });
  ok((await work('One Piece')).summary === 'Admin summary', 'admin edits beat the JSON');
  await call('PATCH', `/api/series/${op.id}`, { summary: '' });
  ok((await work('One Piece')).summary === 'Pirates!', 'clearing the edit shows the JSON again');

  // ---- second source, by name ----
  const B = (await call('POST', '/api/metadata/sources', { name: 'Flat folder', folder: SRC_B, match: 'name' })).data.source;
  const nb = await until(async () => { const w = await work('Naruto'); return w.localSources.length && w; });
  const n11 = (await books(nb.id))[0];
  ok(n11.title === 'Eleven by name' && n11.number === '11' && nb.summary === 'Ninjas' && nb.readingDirection === 'rtl', 'name mode: 11.json → Naruto/11.cbz; Naruto.json → the work (reading direction)');
  ok((await books(op.id)).find(b => b.fileName === '11.cbz').title === 'The Eleventh', 'One Piece/11 keeps source A’s title (A is earlier in the order)');
  const chk = (await call('GET', `/api/metadata/sources/${B.id}/check`)).data;
  const cl = chk.libraries[0];
  ok(chk.files === 4 && cl.books === 2 && cl.works === 1 && cl.enabled, `check: 4 JSON files; matches 2 books (both "11") and 1 work`);
  ok(chk.errors.some(e => e.file === 'bad.json' && /invalid JSON/.test(e.error)) && chk.unused.includes('unused-thing.json'), 'check reports unreadable and unused files');
  const chkA = (await call('GET', `/api/metadata/sources/${A.id}/check`)).data;
  ok(chkA.libraries[0].works === 2 && chkA.libraries[0].books === 2 && chkA.unusedCount === 0 && chkA.errors.length === 0, 'check of source A: 2 works, 2 books, nothing unused');

  // ---- editing JSON / new chapters ----
  write(path.join(SRC_A, 'One Piece', '11.json'), { title: 'Renamed Eleventh' });
  ok((await call('POST', `/api/metadata/sources/${A.id}/apply`)).status === 200 && (await books(op.id)).find(b => b.fileName === '11.cbz').title === 'Renamed Eleventh', '"Apply now" re-reads changed JSON files');
  write(path.join(MEDIA, 'One Piece', '13.cbz'), cbz(5));
  write(path.join(SRC_A, 'One Piece', '13.json'), { title: 'Brand new 13' });
  await call('POST', `/api/libraries/${L.id}/scan`, {});
  const b13 = await until(async () => (await books(op.id)).find(b => b.fileName === '13.cbz' && b.localSource));
  ok(b13.title === 'Brand new 13', 'a scan picks up a new chapter and its JSON');

  // ---- per library on/off, edit, delete ----
  const list = (await call('GET', '/api/libraries')).data.libraries[0].metadata.providers.map(p => ({ id: p.id, enabled: p.id === A.id ? false : p.enabled }));
  await call('PATCH', `/api/libraries/${L.id}`, { metadata: { providers: list } });
  await until(async () => !(await work('One Piece')).localSources.length);
  ok((await work('One Piece')).summary === 'CI summary' || (await work('One Piece')).summary === '', 'turned off for the library: its work data goes away');
  ok((await books(op.id)).find(b => b.fileName === '11.cbz').title === 'Eleven by name', '…and the next source in the order (B, by name) now describes One Piece/11.cbz');
  list.find(p => p.id === A.id).enabled = true;
  await call('PATCH', `/api/libraries/${L.id}`, { metadata: { providers: list } });
  await until(async () => (await work('One Piece')).localSources.length);
  const ren = (await call('PATCH', `/api/metadata/sources/${B.id}`, { name: 'Flat (renamed)' })).data.source;
  ok(ren.name === 'Flat (renamed)' && (await call('PATCH', `/api/metadata/sources/${B.id}`, { folder: path.join(TMP, 'gone') })).data.error === 'folderNotFound', 'rename; moving to a missing folder is refused');
  ok((await call('DELETE', `/api/metadata/sources/${B.id}`)).status === 200, 'delete');
  ok(!(await work('Naruto')).localSources.length && (await books(naruto.id))[0].title === '11'
    && !(await call('GET', '/api/libraries')).data.libraries[0].metadata.providers.some(p => p.id === B.id), 'deleted: its data and its place in the library order are gone');

  // ---- lists, filters, permissions ----
  const srcs = (await call('GET', '/api/metadata/sources')).data;
  ok(srcs.folder.length === 1 && srcs.online.length === 8 && srcs.online.every(o => Array.isArray(o.usedBy)) && srcs.matchModes.join() === 'path,name', 'sources list: folder sources + 8 online sites with the libraries using them');
  ok((await works('&metadata=matched')).map(s => s.title).sort().join() === 'One Piece,Short', 'metadata filter counts folder matches as matched');
  ok((await call('POST', `/api/series/${op.id}/metadata/identify`, { provider: A.id, id: 'x' })).status === 400, 'Identify only uses online sites');
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  ok((await call('GET', '/api/metadata/sources', null, bob)).status === 403 && (await call('POST', '/api/metadata/sources', { name: 'x', folder: SRC_A }, bob)).status === 403
    && (await call('GET', `/api/metadata/sources/${A.id}/check`, null, bob)).status === 403, 'only admins manage sources');
  const bobBook = (await call('GET', `/api/series/${op.id}`, null, bob)).data.books.find(b => b.fileName === '11.cbz');
  ok(bobBook.title === 'Renamed Eleventh' && bobBook.localFile === undefined, 'users see the data, not the file paths');

  // ---- survives a restart ----
  srv.removeAllListeners('exit');
  const pid = (await call('GET', '/api/processes')).data.server.pid;
  await new Promise(r => { srv.on('exit', r); srv.kill(); });
  await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
  log = '';
  await start();
  ok((await call('GET', '/api/metadata/sources')).data.folder[0].id === A.id && (await work('One Piece')).summary === 'Pirates!', 'sources and their data survive a restart');

  console.log(`\nALL ${passed} FOLDER SOURCE CHECKS PASSED`);
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2000)); try { srv.kill(); } catch {} process.exit(1); });
