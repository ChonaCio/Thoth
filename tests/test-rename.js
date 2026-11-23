// node tests/test-rename.js <app dir> — batch renaming (rules, conflicts, applying: files, progress, read
// lists, folder-source JSON) and metadata matching with alternative titles (a fake site, no network). Offline.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-ren-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media'), META = path.join(TMP, 'meta');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
let n = 0;
const book = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, makeZip([['p.png', png(10, 15, [n * 30 % 255, 50, 90], n++)]])); };
const A = ['chapter-0.cbz', 'chapter-1.cbz', 'chapter-1.1.cbz', 'chapter-1x1.cbz', 'chapter-1-chapter name.cbz', 'Chapter 2.cbz'];
A.forEach(f => book(path.join(MEDIA, 'Work A', f)));
book(path.join(MEDIA, 'Work B', 'chapter-3.cbz')); book(path.join(MEDIA, 'Work B', 'Chapter 3.cbz'));   // target exists
book(path.join(MEDIA, 'Work C', 'ch-5.cbz')); book(path.join(MEDIA, 'Work C', 'chapter-5.cbz'));        // both → Chapter 5
fs.mkdirSync(path.join(META, 'Work A'), { recursive: true });
fs.writeFileSync(path.join(META, 'Work A', 'chapter-1.json'), JSON.stringify({ title: 'The First One' }));

const PORT = 3993, BASE = `http://127.0.0.1:${PORT}`;
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
const ok = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }

(async () => {
  // ---- the rules (in process) ----
  const rules = require(path.join(APP, 'library', 'rename.js'));
  const expect = { 'chapter-0.cbz': 'Chapter 0.cbz', 'chapter-1.cbz': 'Chapter 1.cbz', 'chapter-1.1.cbz': 'Chapter 1.1.cbz', 'chapter-1x1.cbz': 'Chapter 1x1.cbz',
    'chapter-1-chapter name.cbz': 'Chapter 1 - Chapter Name.cbz', 'ch_12_the_end.cbz': 'Chapter 12 - The End.cbz', 'vol.3.cbz': 'Volume 3.cbz',
    'Chapter 1.cbz': null, 'Chapter 1 - Chapter Name.cbz': null, 'Saga 001.cbz': null, 'EP-4.pdf': 'Episode 4.pdf' };
  ok(Object.entries(expect).every(([from, to]) => rules.proposedName(from) === to), 'naming rules: every example gives the expected name (and good names are left alone)');

  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library.id;
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  await call('POST', '/api/metadata/sources', { name: 'JSON', folder: META });
  const workA = await until(async () => (await call('GET', '/api/series')).data.items.find(s => s.title === 'Work A'));
  let booksA = (await call('GET', `/api/series/${workA.id}`)).data.books;
  const ch1 = await until(async () => { booksA = (await call('GET', `/api/series/${workA.id}`)).data.books; return booksA.find(b => b.fileName === 'chapter-1.cbz' && b.title === 'The First One'); });
  const ch0 = booksA.find(b => b.fileName === 'chapter-0.cbz');
  await call('PUT', `/api/books/${ch1.id}/progress`, { page: 1, completed: true });
  const rl = (await call('POST', '/api/readlists', { name: 'List', bookIds: [ch0.id] })).data.readlist;

  // ---- preview ----
  const pv = (await call('GET', `/api/rename/preview?library=${L}`)).data;
  const by = name => pv.items.find(x => x.fromName === name);
  ok(pv.checked === 10 && pv.items.filter(x => x.status === 'ok').length === 5, `preview: 10 files checked, 5 renames proposed (${pv.items.map(x => x.fromName + '→' + x.toName).join('; ')})`);
  ok(by('chapter-3.cbz').status === 'exists' && by('ch-5.cbz').status === 'conflict' && by('chapter-5.cbz').status === 'conflict', 'conflicts: the new name exists, or two files would get the same name');
  ok(!pv.items.some(x => x.fromName === 'Chapter 2.cbz'), 'well-named files aren’t listed');

  // ---- apply ----
  const picks = pv.items.filter(x => x.status === 'ok' && x.fromName !== 'chapter-1x1.cbz').map(x => ({ bookId: x.bookId, toName: x.toName }));
  picks.push({ bookId: by('chapter-3.cbz').bookId, toName: by('chapter-3.cbz').toName }); // a conflict: refused
  picks.push({ bookId: by('chapter-1x1.cbz').bookId, toName: 'Something else.cbz' });     // not what was proposed: refused
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  ok((await call('GET', '/api/rename/preview', null, bob)).status === 403 && (await call('POST', '/api/rename/apply', { items: picks }, bob)).status === 403, 'only admins rename');
  const r = (await call('POST', '/api/rename/apply', { items: picks, renameJson: true })).data;
  ok(r.renamed === 4 && r.json === 1 && r.failed.length === 2 && r.failed.some(f => f.error === 'exists') && r.failed.some(f => f.error === 'changed'), `applied: 4 renamed, 1 JSON renamed, 2 refused (${r.failed.map(f => f.error).join(', ')})`);
  const disk = fs.readdirSync(path.join(MEDIA, 'Work A')).sort();
  ok(['Chapter 0.cbz', 'Chapter 1 - Chapter Name.cbz', 'Chapter 1.1.cbz', 'Chapter 1.cbz', 'Chapter 2.cbz', 'chapter-1x1.cbz'].every(f => disk.includes(f)) && !disk.includes('chapter-0.cbz'), `files renamed on disk (${disk.join(', ')})`);
  ok(fs.existsSync(path.join(META, 'Work A', 'Chapter 1.json')) && !fs.existsSync(path.join(META, 'Work A', 'chapter-1.json')), 'its folder-source JSON was renamed along');
  ok(fs.existsSync(path.join(MEDIA, 'Work B', 'chapter-3.cbz')) && fs.existsSync(path.join(MEDIA, 'Work C', 'ch-5.cbz')), 'conflicting files untouched');

  // ---- what follows the file ----
  booksA = (await call('GET', `/api/series/${workA.id}`)).data.books;
  const new1 = booksA.find(b => b.fileName === 'Chapter 1.cbz');
  ok(new1 && new1.id !== ch1.id && new1.progress && new1.progress.completed, 'reading progress moved to the renamed book');
  ok((await call('GET', `/api/readlists/${rl.id}`)).data.readlist.books[0].fileName === 'Chapter 0.cbz', 'read lists point at the renamed book');
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan.reason === 'rename' && l; });
  const ls = (await call('GET', '/api/libraries')).data.libraries[0].lastScan;
  ok(ls.read === 0 && ls.books === 10 && ls.removed === 0 && ls.added === 0, 'the quick scan afterwards finds nothing new to read (no duplicates, nothing lost)');
  const after = (await call('GET', `/api/series/${workA.id}`)).data.books.find(b => b.fileName === 'Chapter 1.cbz');
  ok(after.title === 'The First One', 'its JSON still matches after the rename');
  ok(!(await call('GET', `/api/rename/preview?library=${L}`)).data.items.some(x => x.status === 'ok' && x.fromName !== 'chapter-1x1.cbz'), 'checking again: only what was skipped is left');
  srv.kill();

  // ---- matching with alternative titles (in process, a fake site) ----
  process.env.THOTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-alt-'));
  const store = require(path.join(APP, 'library', 'db.js'));
  const meta = require(path.join(APP, 'library', 'metadata', 'index.js'));
  const s = { id: 'x1', libraryId: 'lib', name: 'Shingeki no Kyojin', relPath: 'Shingeki no Kyojin', meta: {}, overrides: { altTitles: ['Attack on Titan', '進撃の巨人'] } };
  store.db.series.x1 = s;
  const searched = [];
  const site = { search: async q => { searched.push(q); return q === 'Attack on Titan' ? [{ id: '9', title: 'Attack on Titan', altTitles: [] }] : [{ id: '1', title: 'Something Else' }]; } };
  ok(meta.titlesFor(s).join('|') === 'Shingeki no Kyojin|Attack on Titan|進撃の巨人', 'a work’s titles: main title, then alternative titles');
  const best = await meta.bestMatch(site, meta.titlesFor(s), undefined);
  ok(best && best.id === '9' && best.via === 'Attack on Titan' && searched.join('|') === 'Shingeki no Kyojin|Attack on Titan', 'no match with the main title → searched with the alternative title and matched');
  const site2 = { search: async () => [{ id: '7', title: 'Attack on Titan' }] };
  const best2 = await meta.bestMatch(site2, meta.titlesFor(s), undefined);
  ok(best2 && best2.id === '7' && best2.via === 'Shingeki no Kyojin', 'a result is compared with every title: found by the first search');
  const site3 = { search: async () => [{ id: '5', title: 'Totally Different' }] };
  ok(await meta.bestMatch(site3, meta.titlesFor(s), undefined) === null, 'no title matches → no match (at most 3 searches)');

  console.log(`\nALL ${passed} RENAME/MATCHING CHECKS PASSED`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2000)); try { srv.kill(); } catch {} process.exit(1); });
