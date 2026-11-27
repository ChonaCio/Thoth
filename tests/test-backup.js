// node tests/test-backup.js <app dir> — Server backup (export/import of every setting) and private/public collections
// and read lists, which keep their works and books while a library folder is unavailable. Offline.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-bk-'));
const MEDIA = path.join(TMP, 'media');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
let n = 0;
const book = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, makeZip([['p.png', png(20, 30, [n * 40 % 255, 60, 90], n++)]])); };
for (const w of ['Alpha', 'Beta', 'Gamma']) { book(path.join(MEDIA, w, 'Chapter 1.cbz')); book(path.join(MEDIA, w, 'Chapter 2.cbz')); }

const PORT = 3991, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, log = '';
function start(dataDir) {
  log = '';
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: dataDir, THOTH_CACHE_SNAPSHOTS: '0' } });
    srv.stdout.on('data', d => { log += d; if (log.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => { log += d; });
    srv.on('exit', c => reject(new Error('exit ' + c + log)));
  });
}
async function stop() { await new Promise(r => { srv.removeAllListeners('exit'); srv.on('exit', r); srv.kill(); }); await wait(300); }
const call = async (m, u, b, c) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150); } throw new Error('timeout waiting'); }

(async () => {
  const DATA = path.join(TMP, 'data');
  await start(DATA);
  const admin = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } }, admin)).data.library.id;
  const scanned = async () => until(async () => { const l = (await call('GET', '/api/libraries', null, admin)).data.libraries[0]; return !l.scanning && l.lastScan && l; });
  await scanned();
  await call('POST', '/api/users', { username: 'ana', password: 'anapass12' }, admin);
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' }, admin);
  const ana = (await call('POST', '/api/login', { username: 'ana', password: 'anapass12' })).cookie;
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' })).cookie;
  const works = (await call('GET', '/api/series?limit=10', null, admin)).data.items;
  const id = t => works.find(w => w.title === t).id;

  // ---- private and public lists ----
  const mine = (await call('POST', '/api/collections', { name: 'Ana picks', seriesIds: [id('Alpha'), id('Beta')] }, ana));
  ok(mine.status === 201 && mine.data.collection.mine && !mine.data.collection.public, 'any user creates a collection: theirs, private');
  const cid = mine.data.collection.id;
  ok(!(await call('GET', '/api/collections', null, bob)).data.collections.some(c => c.id === cid) && (await call('GET', `/api/collections/${cid}`, null, bob)).status === 404,
    'someone else’s private collection: not listed, not found');
  ok(!(await call('GET', '/api/collections', null, admin)).data.collections.some(c => c.id === cid), '…not even for administrators');
  await call('PATCH', `/api/collections/${cid}`, { public: true }, ana);
  const pub = (await call('GET', '/api/collections?scope=public', null, bob)).data.collections;
  ok(pub.some(c => c.id === cid && c.owner === 'ana' && !c.mine) && !(await call('GET', '/api/collections?scope=mine', null, bob)).data.collections.some(c => c.id === cid),
    'made public: in everyone’s Public tab (with its owner), not in their own');
  ok((await call('PATCH', `/api/collections/${cid}`, { name: 'Hacked' }, bob)).status === 403, 'only its owner changes it');
  const rl = (await call('POST', '/api/readlists', { name: 'Bob reads' }, bob)).data.readlist;
  ok(rl.mine && !(await call('GET', '/api/readlists', null, ana)).data.readlists.some(r => r.id === rl.id), 'read lists too: private to their owner');
  const alphaBooks = (await call('GET', `/api/series/${id('Alpha')}`, null, bob)).data.books;
  await call('PATCH', `/api/readlists/${rl.id}`, { addBookIds: alphaBooks.map(b => b.id) }, bob);
  ok((await call('GET', `/api/books/${alphaBooks[0].id}`, null, ana)).data.readlists.length === 0 && (await call('GET', `/api/books/${alphaBooks[0].id}`, null, bob)).data.readlists.length === 1,
    'a book page lists only the read lists its viewer may see');

  // ---- a folder gone for a while: lists keep their works ----
  fs.renameSync(path.join(MEDIA, 'Alpha'), path.join(TMP, 'Alpha-away'));
  await call('POST', `/api/libraries/${L}/scan`, { full: true }, admin);
  await wait(400); await scanned();
  let c1 = (await call('GET', `/api/collections/${cid}`, null, ana)).data.collection;
  let r1 = (await call('GET', `/api/readlists/${rl.id}`, null, bob)).data.readlist;
  ok(c1.seriesCount === 1 && c1.missing === 1 && r1.booksCount === 0 && r1.missing === 2, `a work folder gone: shown as unavailable in the lists, not removed (collection ${c1.seriesCount} + ${c1.missing} missing; read list ${r1.missing} missing)`);
  await call('PATCH', `/api/collections/${cid}`, { seriesIds: [id('Beta'), id('Gamma')] }, ana); // (reordering/setting what's shown)
  fs.renameSync(path.join(TMP, 'Alpha-away'), path.join(MEDIA, 'Alpha'));
  await call('POST', `/api/libraries/${L}/scan`, { full: true }, admin);
  await wait(400); await scanned();
  c1 = (await call('GET', `/api/collections/${cid}`, null, ana)).data.collection;
  r1 = (await call('GET', `/api/readlists/${rl.id}`, null, bob)).data.readlist;
  ok(c1.seriesCount === 3 && !c1.missing && r1.booksCount === 2, 'back: the work is in the collection and its books in the read list again (also after the list was changed meanwhile)');
  // The whole library folder empty (an unmounted drive): nothing removed
  fs.renameSync(MEDIA, MEDIA + '-away'); fs.mkdirSync(MEDIA);
  await call('POST', `/api/libraries/${L}/scan`, { full: true }, admin);
  const lib = await until(async () => { const l = (await call('GET', '/api/libraries', null, admin)).data.libraries[0]; return !l.scanning && l.scanError && l; });
  ok(lib.scanError === 'folderEmpty' && (await call('GET', '/api/series?limit=10', null, admin)).data.total === 3, `an empty library folder: the scan stops (${lib.scanError}) and keeps every work`);
  fs.rmdirSync(MEDIA); fs.renameSync(MEDIA + '-away', MEDIA);
  await call('POST', `/api/libraries/${L}/scan`, { full: true }, admin);
  await wait(400); await scanned();

  // ---- the search box finds a work by any title it's known by ----
  await call('PATCH', `/api/series/${id('Alpha')}`, { title: 'Zeta Shown', altTitles: ['Alfa Otra'] }, admin);
  await wait(600); // (saved a moment after the change)
  await stop();
  // (as an Identify pick leaves it: a match picked by hand on a site, its title, and what was fetched)
  const libFile = path.join(DATA, 'library.json');
  const lj = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  lj.series[id('Alpha')].provider = { locked: [{ provider: 'anilist', id: '777' }], matches: [{ provider: 'anilist', id: '777', title: 'Alpha no Kiseki', locked: true }],
    merged: { summary: 'Fetched summary', altTitles: ['Alpha Kanji'] }, fetchedAt: new Date().toISOString() };
  fs.writeFileSync(libFile, JSON.stringify(lj));
  await start(DATA);
  const found = async (term, cookie = ana) => {
    const list = (await call('GET', `/api/series?limit=10&q=${encodeURIComponent(term)}`, null, cookie)).data.items.map(w => w.id);
    const box = (await call('GET', `/api/search?q=${encodeURIComponent(term)}`, null, cookie)).data.series.map(w => w.id);
    return list.includes(id('Alpha')) && box.includes(id('Alpha'));
  };
  ok(await found('alfa otra') && await found('alpha kanji') && await found('kiseki') && await found('alpha') && await found('zeta'),
    'library list and search box (Search cache): a work found by its alternative titles, a matched site\'s title, its folder name and the title shown');
  // ---- a work folder gone for a while: the Identify picks and the fetched metadata wait for it ----
  fs.renameSync(path.join(MEDIA, 'Alpha'), path.join(TMP, 'Alpha-away'));
  await call('POST', `/api/libraries/${L}/scan`, { full: true }, admin);
  await wait(400); await scanned();
  ok(!(await call('GET', '/api/series?limit=10', null, admin)).data.items.some(w => w.id === id('Alpha')), 'its folder gone: the work leaves the library');
  fs.renameSync(path.join(TMP, 'Alpha-away'), path.join(MEDIA, 'Alpha'));
  await call('POST', `/api/libraries/${L}/scan`, { full: true }, admin);
  await wait(400); await scanned();
  await wait(600);
  const back = JSON.parse(fs.readFileSync(libFile, 'utf8')).series[id('Alpha')];
  const backView = (await call('GET', `/api/series/${id('Alpha')}`, null, admin)).data.series;
  ok(back && back.provider && back.provider.locked[0].id === '777' && back.provider.merged.summary === 'Fetched summary' && backView.title === 'Zeta Shown' && backView.summary === 'Fetched summary',
    'back: its Identify picks, fetched metadata and edits are there again (nothing to look up again)');
  ok(await found('kiseki'), '…and it is found by those titles again');

  // ---- backup ----
  await call('PATCH', '/api/config', { scanWorkers: 2, comicVineApiKey: 'secretkey123' }, admin);
  await call('PATCH', `/api/series/${id('Gamma')}`, { summary: 'Edited by hand' }, admin);
  const exp = await fetch(BASE + '/api/backup', { headers: { Cookie: admin } });
  const text = await exp.text();
  const bk = JSON.parse(text);
  ok(exp.status === 200 && /attachment/.test(exp.headers.get('content-disposition')) && bk.format === 'thoth-backup' && bk.libraries[L].root === MEDIA && bk.collections[cid].owner === 'ana' && bk.readlists[rl.id],
    'export: one file with the libraries, collections and read lists (with their owners)…');
  ok(!text.includes('secretkey123') && !('comicVineApiKey' in bk.config) && bk.config.scanWorkers === 2 && bk.workEdits.series[id('Gamma')].overrides.summary === 'Edited by hand',
    '…server settings without the API keys, and the edits made by hand');
  ok((await call('GET', '/api/backup', null, bob)).status === 403, 'only administrators export');
  await stop();

  // A new server: put it all back
  const DATA2 = path.join(TMP, 'data2');
  await start(DATA2);
  const admin2 = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  ok((await call('POST', '/api/backup/check', { backup: { hello: 1 } }, admin2)).status === 400, 'a file that isn’t a backup is refused');
  const chk = (await call('POST', '/api/backup/check', { backup: bk }, admin2)).data.summary;
  ok(chk.libraries === 1 && chk.collections === 1 && chk.readlists === 1, `what a backup holds, before importing (${JSON.stringify(chk)})`);
  const imp = (await call('POST', '/api/backup/import', { backup: bk, mode: 'merge' }, admin2)).data;
  ok(imp.imported.libraries === 1 && imp.newLibraries.length === 1 && imp.pendingEdits >= 1, `imported: the library (scanned as new), and the edits wait for its works (${JSON.stringify(imp.imported)})`);
  await until(async () => { const l = (await call('GET', '/api/libraries', null, admin2)).data.libraries[0]; return l && !l.scanning && l.lastScan && l; });
  const gamma = (await call('GET', '/api/series?limit=10', null, admin2)).data.items.find(w => w.title === 'Gamma');
  ok(gamma && (await call('GET', `/api/series/${gamma.id}`, null, admin2)).data.series.summary === 'Edited by hand', 'after the scan, the edit is on the work again');
  ok((await call('GET', '/api/config', null, admin2)).data.values.scanWorkers === 2, 'server settings back');
  await wait(600); // (the library file is saved a moment after a change)
  const c2 = Object.values(JSON.parse(fs.readFileSync(path.join(DATA2, 'library.json'), 'utf8')).collections)[0];
  ok(c2 && c2.owner === 'ana' && c2.public === true && c2.seriesIds.length === 3, 'the collection back, with its owner and its works');
  // Replace: what isn't in the file goes
  await call('POST', '/api/collections', { name: 'Extra' }, admin2);
  await call('POST', '/api/backup/import', { backup: bk, mode: 'replace', sections: ['collections'] }, admin2);
  await wait(600);
  ok(Object.values(JSON.parse(fs.readFileSync(path.join(DATA2, 'library.json'), 'utf8')).collections).map(c => c.name).join() === 'Ana picks', 'replace: the section becomes what’s in the file');

  console.log(`\nALL ${passed} BACKUP AND LIST CHECKS PASSED`);
  srv.kill();
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); }, 500);
})().catch(e => { console.error('FAILED:', e.message); console.error(log.slice(-3000)); try { srv.kill(); } catch {} process.exit(1); });
