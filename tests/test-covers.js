// node tests/test-covers.js <app dir> — the work's Edit dialog data: where each value comes from, the new
// editable fields (year, alternative titles, authors), and choosing a cover (first page, folder-source
// images, uploads, automatic). Offline.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-covers-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media'), META = path.join(TMP, 'meta');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' || Buffer.isBuffer(d) ? d : JSON.stringify(d)); };
write(path.join(MEDIA, 'Saga', 'Saga 01.cbz'), makeZip([['ComicInfo.xml', Buffer.from('<ComicInfo><Writer>Brian K.</Writer><Year>2012</Year><Publisher>Image</Publisher></ComicInfo>')], ['p1.png', png(30, 45, [10, 20, 200], 1)]]));
write(path.join(MEDIA, 'Saga', 'Saga 02.cbz'), makeZip([['p1.png', png(30, 45, [10, 200, 20], 2)]]));
const RED = png(60, 90, [220, 20, 20], 1), GREEN = png(60, 90, [20, 220, 20], 2);
write(path.join(META, 'Saga.json'), { title: ['Saga', 'Saga (US)'], summary: 'Space opera', tags: ['Space'] });
write(path.join(META, 'Saga.png'), RED);              // named like the work → its cover
write(path.join(META, 'Saga', 'alt-cover.png'), GREEN); // inside the work's folder → a candidate too
write(path.join(META, 'Other.png'), GREEN);           // another work's image → not a candidate

const PORT = 3992, BASE = `http://127.0.0.1:${PORT}`;
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
const bytes = async u => { const r = await fetch(BASE + u, { headers: { Cookie: cookie } }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; };
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } });
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  await call('POST', '/api/metadata/sources', { name: 'JSON', folder: META });
  const saga = await until(async () => (await call('GET', '/api/series')).data.items.find(s => s.title === 'Saga' && s.localSources.length));
  const id = saga.id;

  // ---- where each value comes from ----
  let s = (await call('GET', `/api/series/${id}`)).data.series;
  const fsrc = s.fieldSources;
  ok(fsrc.summary.kind === 'folder' && fsrc.summary.name === 'JSON' && fsrc.publisher.kind === 'files' && fsrc.year.kind === 'books' && fsrc.authors.kind === 'books' && fsrc.altTitles.kind === 'folder',
    'each field says where its value comes from (folder source, files, books)');

  // ---- new editable fields ----
  ok((await call('PATCH', `/api/series/${id}`, { year: '20x1' })).status === 400, 'invalid year rejected');
  await call('PATCH', `/api/series/${id}`, { year: '2013', altTitles: 'Saga, the series\nサーガ', authors: 'Brian K., Fiona S.' });
  s = (await call('GET', `/api/series/${id}`)).data.series;
  ok(s.year === 2013 && s.altTitles.join('|') === 'Saga, the series|サーガ' && s.fieldSources.year.kind === 'edit', 'year and alternative titles (one per line; commas allowed) saved as edits');
  ok(s.authors.some(a => a.name === 'Brian K.' && a.role === 'writer') && s.authors.some(a => a.name === 'Fiona S.' && a.role === 'writer'), 'authors: known names keep their role, new ones are writers');
  await call('PATCH', `/api/series/${id}`, { year: '', altTitles: '', authors: '' });
  s = (await call('GET', `/api/series/${id}`)).data.series;
  ok(s.year === 2012 && s.altTitles.join() === 'Saga (US)', 'clearing them goes back to the automatic values');

  // ---- cover candidates ----
  let c = (await call('GET', `/api/series/${id}/covers`)).data;
  const ids = c.candidates.map(x => x.id);
  ok(c.current === 'auto' && ids[0] === 'auto' && ids.includes('file'), `candidates start with automatic and the first page (${ids.join(', ')})`);
  const locals = c.candidates.filter(x => x.kind === 'local').map(x => x.rel).sort();
  ok(locals.join() === 'Saga.png,Saga/alt-cover.png', 'folder-source images of this work are offered (not other works’ images)');
  const altId = c.candidates.find(x => x.rel === 'Saga/alt-cover.png').id;
  ok((await bytes(`/api/series/${id}/cover-candidate?id=${encodeURIComponent(altId)}`)).equals(GREEN), 'candidate images can be previewed');
  ok((await bytes(`/api/series/${id}/cover-candidate?id=${encodeURIComponent('local:' + c.candidates.find(x => x.kind === 'local').id.split(':')[1] + ':../outside.png')}`)) === null, 'paths outside the source folder are refused');

  // ---- choosing ----
  ok((await call('POST', `/api/series/${id}/cover`, { choice: altId })).status === 200, 'pick a folder-source image');
  s = (await call('GET', `/api/series/${id}`)).data.series;
  ok(s.coverSource === 'metadata' && s.customCover && s.customCover.from === altId, 'it becomes the work’s own cover');
  ok((await bytes(`/api/series/${id}/thumbnail?v=${s.coverV}`)).equals(GREEN), 'the work’s cover is that image');
  c = (await call('GET', `/api/series/${id}/covers`)).data;
  ok(c.current === 'custom' && c.candidates.some(x => x.id === 'custom'), 'the picker shows it as the current cover');
  await call('POST', `/api/series/${id}/cover`, { choice: 'file' });
  s = (await call('GET', `/api/series/${id}`)).data.series;
  ok(s.coverSource === 'file' && !s.customCover && !fs.readdirSync(path.join(DATA, 'covers')).some(f => f.startsWith('custom-')), 'first page: own cover removed (file deleted too)');

  // ---- upload ----
  const dataUrl = 'data:image/png;base64,' + RED.toString('base64');
  ok((await call('POST', `/api/series/${id}/cover`, { upload: 'data:text/plain;base64,aGk=' })).data.error === 'notAnImage', 'non-images refused');
  ok((await call('POST', `/api/series/${id}/cover`, { upload: dataUrl })).status === 200, 'upload an image');
  s = (await call('GET', `/api/series/${id}`)).data.series;
  ok(s.customCover.from === 'upload' && (await bytes(`/api/series/${id}/thumbnail?v=${s.coverV}`)).equals(RED), 'the uploaded image is the cover');
  const big = 'data:image/jpeg;base64,' + Buffer.alloc(9 * 1024 * 1024, 1).toString('base64');
  ok([413].includes((await call('POST', `/api/series/${id}/cover`, { upload: big })).status), 'images over 8 MB refused');
  ok((await call('POST', `/api/series/${id}/cover`, { choice: 'nonsense' })).status === 400, 'unknown choices refused');
  await call('POST', `/api/series/${id}/cover`, { choice: 'auto' });
  s = (await call('GET', `/api/series/${id}`)).data.series;
  ok(!s.customCover && s.coverChoice === null, 'automatic: back to the library setting');

  // ---- admins only ----
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  ok((await call('GET', `/api/series/${id}/covers`, null, bob)).status === 403 && (await call('POST', `/api/series/${id}/cover`, { choice: 'file' }, bob)).status === 403
    && (await call('GET', `/api/series/${id}`, null, bob)).data.series.fieldSources === undefined, 'only admins see sources and change covers');

  console.log(`\nALL ${passed} COVER/EDIT CHECKS PASSED`);
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2000)); try { srv.kill(); } catch {} process.exit(1); });
