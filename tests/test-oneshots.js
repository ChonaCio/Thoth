// node test-oneshots.js <app dir> — loose files are individual works; optional extra one-shots folder
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-one-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media');
execFileSync(process.execPath, [path.join(__dirname, 'make-comics.js'), MEDIA]);
fs.copyFileSync(path.join(MEDIA, 'loose.cbz'), path.join(MEDIA, 'Another loose.cbz'));
fs.mkdirSync(path.join(MEDIA, 'One-shots'));
fs.copyFileSync(path.join(MEDIA, 'Alpha Series', 'Alpha v01.cbz'), path.join(MEDIA, 'One-shots', 'Special.cbz')); // ComicInfo Title
fs.copyFileSync(path.join(MEDIA, 'loose.cbz'), path.join(MEDIA, 'One-shots', 'Extra.cbz'));
const PORT = 3989, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0;
const start = () => new Promise((resolve, reject) => {
  srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA } });
  let out = ''; srv.stdout.on('data', d => { out += d; if (out.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => out += d);
  srv.on('exit', c => reject(new Error('exit ' + c + out)));
});
const call = async (m, u, b, c) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json(), cookie: sc ? sc.split(';')[0] : null };
};
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function scanned(c, id) {
  await wait(150);
  for (let i = 0; i < 100; i++) { const l = (await call('GET', '/api/libraries', null, c)).data.libraries.find(x => x.id === id); if (!l.scanning && l.lastScan) return l; await wait(100); }
  throw new Error('scan timeout');
}
const seriesList = async (c, id) => (await call('GET', `/api/series?library=${id}`, null, c)).data.items;
const summary = list => list.map(s => s.title + (s.oneshot ? '*' : '') + '(' + s.booksCount + ')').join(', ');

(async () => {
  await start();
  const c = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const lib = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA }, c)).data.library;
  ok(lib.oneshots.folder === '', 'new library: no extra one-shots folder');
  await scanned(c, lib.id);
  let list = await seriesList(c, lib.id);
  const loose = list.find(s => s.title === 'loose');
  ok(loose && loose.oneshot && loose.booksCount === 1, `loose file in the library folder is its own work: ${summary(list)}`);
  ok(list.find(s => s.title === 'Another loose').oneshot, 'each loose file is its own work');
  ok(!list.some(s => s.title === 'Comics'), 'nothing grouped under the library name');
  ok(list.some(s => s.title === 'Alpha!' && !s.oneshot && s.booksCount === 2), 'subfolder "One-shots" is a normal series until configured');

  const looseBook = (await call('GET', `/api/series/${loose.id}`, null, c)).data.books[0];
  await call('PUT', `/api/books/${looseBook.id}/progress`, { page: 2 }, c);

  // extra one-shots folder
  let r = await call('PATCH', `/api/libraries/${lib.id}`, { oneshotsFolder: '/One-shots/' }, c);
  ok(r.data.library.oneshots.folder === 'One-shots', `folder normalized: "${r.data.library.oneshots.folder}"`);
  await scanned(c, lib.id);
  list = await seriesList(c, lib.id);
  ok(list.find(s => s.title === 'The First & Best' && s.oneshot) && list.find(s => s.title === 'Extra' && s.oneshot), `files in the extra folder are individual works: ${summary(list)}`);
  ok(list.find(s => s.title === 'loose' && s.oneshot) && !list.some(s => s.title === 'Comics'), 'library folder files stay individual works');
  r = await call('GET', `/api/books/${looseBook.id}`, null, c);
  ok(r.data.book.progress.page === 2, 'progress kept');

  // old-style "off" (oneshotsEnabled: false) only removes the extra folder; loose files are never grouped
  await call('PATCH', `/api/libraries/${lib.id}`, { oneshotsEnabled: false }, c);
  await scanned(c, lib.id);
  list = await seriesList(c, lib.id);
  ok(list.find(s => s.title === 'loose' && s.oneshot) && !list.some(s => s.title === 'Comics') && list.some(s => s.title === 'Alpha!' && s.booksCount === 2 && !s.oneshot),
    `"off" no longer groups loose files under the library name (${summary(list)})`);

  // a library saved with the old setting (enabled: false) from before this change
  fs.mkdirSync(path.join(TMP, 'media2'));
  fs.copyFileSync(path.join(MEDIA, 'loose.cbz'), path.join(TMP, 'media2', 'Solo.cbz'));
  const lib2 = (await call('POST', '/api/libraries', { name: 'Second', root: path.join(TMP, 'media2'), oneshotsEnabled: false }, c)).data.library;
  await scanned(c, lib2.id);
  ok(summary(await seriesList(c, lib2.id)) === 'Solo*(1)', 'old "off" setting: the loose file is still its own work, not "Second"');

  for (const bad of ['../outside', 'a/../../b', 'C:\\Windows']) {
    r = await call('PATCH', `/api/libraries/${lib.id}`, { oneshotsFolder: bad }, c);
    ok(r.status === 400 && r.data.error === 'oneshotsFolderInvalid', `rejects folder "${bad}"`);
  }
  srv.kill();
  console.log(`\nALL ${passed} ONE-SHOT CHECKS PASSED`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message); try { srv.kill(); } catch {} process.exit(1); });
