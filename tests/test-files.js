// node tests/test-files.js <app dir> — File management: deleting one of two files competing for a name,
// merging works (suggestions from metadata, moving files, progress following), and works in the cache
// (cached answers, covers read ahead). Offline.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-files-'));
const DATA = path.join(TMP, 'data'), A = path.join(TMP, 'lib-a'), B = path.join(TMP, 'lib-b');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
let n = 0;
const book = (f, pages = 1) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, makeZip(Array.from({ length: pages }, (_, i) => [`p${i}.png`, png(10, 15, [n * 30 % 255, 50, 90], n++)]))); };
// Library A: duplicates by name, and "Saga"
book(path.join(A, 'Dup', 'chapter-1.cbz'), 3); book(path.join(A, 'Dup', 'Chapter 1.cbz'), 1);   // keep the bigger one
book(path.join(A, 'Dup', 'chapter-2.cbz'), 1); book(path.join(A, 'Dup', 'Chapter 2.cbz'), 2);   // delete this one
book(path.join(A, 'Dup2', 'ch-3.cbz')); book(path.join(A, 'Dup2', 'Chapter 3.cbz'));
book(path.join(A, 'Dup2', 'ch-4.cbz')); book(path.join(A, 'Dup2', 'Chapter 4.cbz'));
book(path.join(A, 'Saga', 'Chapter 1.cbz')); book(path.join(A, 'Saga', 'Chapter 2.cbz'));
book(path.join(A, 'Saga (Colored)', 'Chapter 1.cbz'));                                            // a version: never suggested
// Library B: the same "Saga" again (one name clashes), and something else
book(path.join(B, 'Saga', 'Chapter 2.cbz')); book(path.join(B, 'Saga', 'Chapter 3.cbz')); book(path.join(B, 'Saga', 'Chapter 4.cbz'));
book(path.join(B, 'Other', 'Chapter 1.cbz'));

const PORT = 3996, BASE = `http://127.0.0.1:${PORT}`;
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
  return { status: r.status, data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null, cache: r.headers.get('x-thoth-cache') };
};
const ok = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const job = async id => until(async () => { const j = (await call('GET', `/api/files/jobs/${id}`)).data.job; return (j.status === 'done' || j.status === 'failed') && j; }, 60000);
const scanned = async id => until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries.find(x => x.id === id); return !l.scanning && l.lastScan && l; }, 60000);

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const LA = (await call('POST', '/api/libraries', { name: 'A', root: A, metadata: { autoFetch: false } })).data.library.id;
  const LB = (await call('POST', '/api/libraries', { name: 'B', root: B, metadata: { autoFetch: false } })).data.library.id;
  await scanned(LA); await scanned(LB);

  // ---- works in the cache ----
  const r1 = await call('GET', '/api/series?limit=50'), r2 = await call('GET', '/api/series?limit=50');
  ok(r1.cache === 'miss' && r2.cache === 'hit' && JSON.stringify(r1.data) === JSON.stringify(r2.data), 'a works list is answered from the cache the second time (same answer)');
  const saga = r1.data.items.find(s => s.title === 'Saga' && s.libraryId === LA);
  const sagaPage = await call('GET', `/api/series/${saga.id}`);
  const b1 = sagaPage.data.books[0];
  await call('PUT', `/api/books/${b1.id}/progress`, { page: 1, completed: true });
  const r3 = await call('GET', '/api/series?limit=50');
  ok(r3.cache === 'miss' && r3.data.items.find(s => s.id === saga.id).booksRead === 1, 'reading progress changes it: rebuilt, with the new progress');
  await call('PATCH', `/api/series/${saga.id}`, { summary: 'Edited' });
  const r4 = await call('GET', `/api/series/${saga.id}`);
  ok(r4.cache === 'miss' && r4.data.series.summary === 'Edited', 'an edit changes it: the work page shows the edit');
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12', libraries: [LB] });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  const rb = await call('GET', '/api/series?limit=50', null, bob);
  ok(rb.data.items.every(s => s.libraryId === LB), 'cached answers are per user (another user sees only their libraries)');
  // Covers of every work are read ahead into the cover cache after the scans
  const procs = await until(async () => { const p = (await call('GET', '/api/processes')).data; return p.media.warm.finishedAt && !p.media.warm.running && p; }, 30000);
  const thumbs = fs.readdirSync(path.join(DATA, 'cache', 'thumbs'));
  ok(procs.media.warm.total === 6 && thumbs.length >= 6, `covers of every work cached ahead (${thumbs.length} on disk, ${procs.media.warm.total} works)`);
  ok(procs.media.responses.hits >= 1, 'the Processes page reports the works cache');

  // ---- deleting files whose new name is taken ----
  let pv = (await call('GET', `/api/rename/preview?library=${LA}`)).data;
  const by = name => pv.items.find(x => x.fromName === name);
  ok(pv.exists === 4 && by('chapter-1.cbz').status === 'exists' && by('chapter-1.cbz').other.fileName === 'Chapter 1.cbz' && by('chapter-1.cbz').pageCount === 3 && by('chapter-1.cbz').other.pageCount === 1,
    'a proposal whose name is taken says which file has it, with both files’ pages and sizes');
  const keepId = by('chapter-1.cbz').bookId;
  await call('PUT', `/api/books/${keepId}/progress`, { page: 2 });
  let j = await job((await call('POST', '/api/files/delete', { items: [{ bookId: keepId, replace: true }, { bookId: by('chapter-2.cbz').bookId }] })).data.job.id);
  let dup = fs.readdirSync(path.join(A, 'Dup')).sort();
  ok(j.deleted === 2 && j.renamed === 1 && dup.join('|') === 'Chapter 1.cbz|Chapter 2.cbz', `“keep this one” deleted the other and renamed it; “delete this file” deleted it (${dup.join(', ')})`);
  const dupWork = (await call('GET', '/api/series?q=dup&limit=10')).data.items.find(s => s.title === 'Dup');
  const dupBooks = (await call('GET', `/api/series/${dupWork.id}`)).data.books;
  ok(dupBooks.length === 2 && dupBooks.find(b => b.fileName === 'Chapter 1.cbz').pageCount === 3 && dupBooks.find(b => b.fileName === 'Chapter 1.cbz').progress.page === 2, 'the kept file is the bigger one, its progress followed it');
  await scanned(LA);
  pv = (await call('GET', `/api/rename/preview?library=${LA}`)).data;
  ok(pv.exists === 2, 'the other pairs are still offered');
  j = await job((await call('POST', '/api/files/delete', { allExists: true, library: LA, keep: 'existing' })).data.job.id);
  ok(j.deleted === 2 && fs.readdirSync(path.join(A, 'Dup2')).sort().join('|') === 'Chapter 3.cbz|Chapter 4.cbz', 'all at once (keep the existing ones): the duplicates are gone');
  ok((await call('POST', '/api/files/delete', { items: [{ bookId: keepId }] }, bob)).status === 403, 'only admins delete files');

  // ---- merging works ----
  await scanned(LA);
  let sg = (await call('GET', '/api/files/merge-suggestions')).data;
  const group = sg.groups.find(g => g.works.some(w => w.path === 'Saga'));
  ok(group && group.reason === 'title' && group.works.length === 2 && group.works.every(w => w.title === 'Saga' && w.edition === 'base'), 'two “Saga” works (in two libraries) are suggested; the Colored version is not');
  const target = group.works.find(w => w.libraryId === LA), source = group.works.find(w => w.libraryId === LB);
  ok(group.target === source.id || group.target === target.id, 'a folder work is suggested to keep');
  const srcBooks = (await call('GET', `/api/series/${source.id}`)).data.books;
  await call('PUT', `/api/books/${srcBooks.find(b => b.fileName === 'Chapter 3.cbz').id}/progress`, { page: 1, completed: true });
  ok((await call('POST', '/api/files/merge', { target: (await call('GET', '/api/series?q=saga&limit=10')).data.items.find(s => s.oneshot) ? 'x' : target.id, sources: [] })).status === 400, 'a merge needs works to move');
  j = await job((await call('POST', '/api/files/merge', { target: target.id, sources: [source.id] })).data.job.id);
  const sagaA = fs.readdirSync(path.join(A, 'Saga')).sort();
  ok(j.moved === 2 && j.skipped === 1 && !j.failed.length && j.repeats[0] === 'Saga/Chapter 2.cbz' && sagaA.join('|') === 'Chapter 1.cbz|Chapter 2.cbz|Chapter 3.cbz|Chapter 4.cbz',
    `only the missing chapters moved into the kept work’s folder; the repeat stayed (${sagaA.join(', ')})`);
  const left = await call('GET', `/api/series/${source.id}`);
  ok(left.status === 200 && left.data.books.length === 1 && fs.existsSync(path.join(B, 'Saga', 'Chapter 2.cbz')), 'without “delete”, the other work keeps its repeat');
  const merged = (await call('GET', `/api/series/${target.id}`)).data.books;
  ok(merged.length === 4 && merged.find(b => b.fileName === 'Chapter 3.cbz').progress.completed, 'the kept work has the moved chapters, with their reading progress');
  await scanned(LA); await scanned(LB);
  const ls = (await call('GET', '/api/libraries')).data.libraries.find(l => l.id === LA).lastScan;
  ok(ls.reason === 'files' && ls.read === 0 && ls.books === 9, 'the quick scan afterwards finds nothing to read again (ids already follow the files)');

  // A source whose files all moved disappears with its folder
  book(path.join(B, 'Saga 2', 'Chapter 9.cbz'));
  await call('POST', `/api/libraries/${LB}/scan`, {});
  await until(async () => (await call('GET', '/api/files/works?q=saga%202')).data.works.length === 1);
  const s2 = (await call('GET', '/api/files/works?q=saga%202')).data.works[0];
  j = await job((await call('POST', '/api/files/merge', { target: target.id, sources: [s2.id] })).data.job.id);
  ok(j.moved === 1 && !fs.existsSync(path.join(B, 'Saga 2')) && (await call('GET', `/api/series/${s2.id}`)).status === 404, 'a work whose files all moved is gone, and so is its empty folder');

  // Repeats by chapter (not by name), and deleting the other folder when done
  book(path.join(B, 'Saga Again', 'chapter-001.cbz'));                 // = Chapter 1 (a repeat by number)
  book(path.join(B, 'Saga Again', 'Chapter 5 - The End.cbz'));         // missing: moves
  fs.writeFileSync(path.join(B, 'Saga Again', 'cover.jpg'), 'not a book');
  await call('POST', `/api/libraries/${LB}/scan`, {});
  const again = await until(async () => (await call('GET', '/api/files/works?q=saga%20again')).data.works[0]);
  const keptBefore = (await call('GET', `/api/series/${target.id}`)).data.books.length;
  j = await job((await call('POST', '/api/files/merge', { target: target.id, sources: [again.id, source.id], deleteSources: true })).data.job.id);
  ok(j.moved === 1 && j.skipped === 2 && fs.existsSync(path.join(A, 'Saga', 'Chapter 5 - The End.cbz')) && !fs.existsSync(path.join(A, 'Saga', 'chapter-001.cbz')),
    '“chapter-001” is the kept work’s Chapter 1 (same number): a repeat; the missing chapter moved');
  ok(!fs.existsSync(path.join(B, 'Saga Again')) && !fs.existsSync(path.join(B, 'Saga')) && j.foldersDeleted.length === 2 && j.deleted === 2,
    `with “delete the other folders”, they’re gone with the repeats and other files in them (${j.foldersDeleted.join(', ')})`);
  ok((await call('GET', `/api/series/${again.id}`)).status === 404 && (await call('GET', `/api/series/${source.id}`)).status === 404
    && (await call('GET', `/api/series/${target.id}`)).data.books.length === keptBefore + 1, 'the other works are gone; the kept one gained the missing chapter');

  // ---- the list of files behind the disk (a scan that trusted an unchanged folder date) ----
  const D = path.join(A, 'Stale');
  book(path.join(D, 'chapter-1.cbz')); book(path.join(D, 'chapter-2.cbz'));
  await call('POST', `/api/libraries/${LA}/scan`, {});
  await until(async () => (await call('GET', `/api/rename/preview?library=${LA}`)).data.items.some(x => x.from === 'Stale/chapter-1.cbz'));
  // Renamed behind Thoth's back on a disk that doesn't update the folder's date: the saved scan index still
  // matches the folder's date, so a quick scan reuses the old listing
  await until(async () => !(await call('GET', '/api/libraries')).data.libraries.find(x => x.id === LA).scanning);
  fs.renameSync(path.join(D, 'chapter-1.cbz'), path.join(D, 'Chapter 1.cbz'));
  const idxFile = path.join(DATA, 'scan-index', `${LA}.json`);
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  idx.dirs.Stale.mtimeMs = fs.statSync(D).mtimeMs;
  fs.writeFileSync(idxFile, JSON.stringify(idx));
  const lastAt = (await call('GET', '/api/libraries')).data.libraries.find(l => l.id === LA).lastScan.at;
  await call('POST', `/api/libraries/${LA}/scan`, { mode: 'quick' });
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries.find(x => x.id === LA); return !l.scanning && l.lastScan.at !== lastAt; });
  const stalePv = (await call('GET', `/api/rename/preview?library=${LA}`)).data;
  ok(!stalePv.items.some(x => x.from === 'Stale/chapter-1.cbz') && stalePv.stale.count === 1 && stalePv.items.some(x => x.from === 'Stale/chapter-2.cbz'),
    'a file already renamed on disk isn’t proposed again (the list was behind); the others still are');
  const fixed = await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries.find(x => x.id === LA); return !l.scanning && l.lastScan.scanMode === 'changes' && l; });
  const staleWork = (await call('GET', '/api/files/works?q=stale')).data.works[0];
  const staleBooks = (await call('GET', `/api/series/${staleWork.id}`)).data.books.map(b => b.fileName).sort();
  ok(fixed.lastScan.reason === 'files' && staleBooks.join('|') === 'Chapter 1.cbz|chapter-2.cbz', `…and a full check of the files brought the list up to date (${staleBooks.join(', ')})`);
  j = await job((await call('POST', '/api/rename/apply', { all: true, library: LA })).data.job.id);
  ok(j.renamed >= 1 && !j.failed.length && fs.readdirSync(D).sort().join('|') === 'Chapter 1.cbz|Chapter 2.cbz', 'renaming then works normally');
  const after = await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries.find(x => x.id === LA); return !l.scanning && l.lastScan.reason === 'rename' && l; });
  ok(after.lastScan.scanMode === 'changes', 'after renaming, every file is checked (not a quick scan that could trust a stale folder date)');

  // Not the same: dismissed suggestions don't come back
  book(path.join(B, 'Dup', 'Chapter 7.cbz'));
  await call('POST', `/api/libraries/${LB}/scan`, {});
  const dg = await until(async () => (await call('GET', '/api/files/merge-suggestions')).data.groups.find(g => g.works.some(w => w.path === 'Dup' && w.libraryId === LB)));
  await call('POST', '/api/files/merge-suggestions/dismiss', { key: dg.key });
  ok(!(await call('GET', '/api/files/merge-suggestions')).data.groups.some(g => g.key === dg.key), '“not the same” hides that suggestion');

  console.log(`\nALL ${passed} FILE MANAGEMENT CHECKS PASSED`);
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2500)); try { srv.kill(); } catch {} process.exit(1); });
