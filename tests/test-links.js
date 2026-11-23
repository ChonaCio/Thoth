// node tests/test-links.js <app dir> — a work's links (from JSON files, edits, matches), unreadable JSON
// ignored, "Update metadata" re-matching JSON, matching by link, several hand-picked matches, covers from
// links. The online parts use fake sites and a fake web page (no network).
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-links-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media'), META = path.join(TMP, 'meta');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' || Buffer.isBuffer(d) ? d : JSON.stringify(d)); };
for (const w of ['Saga', 'Broken', 'Twice']) write(path.join(MEDIA, w, '1.cbz'), makeZip([['p.png', png(10, 15, [w.length * 40, 60, 90], 1)]]));
write(path.join(META, 'Saga.json'), { summary: 'Space opera', url: 'https://anilist.co/manga/30013', links: ['https://example.org/saga', 'not a link'] });
write(path.join(META, 'Broken.json'), '{ "summary": "missing quote }');            // unreadable: ignored
write(path.join(META, 'a', 'Twice.json'), '[1, 2, 3]');                              // not an object: ignored…
write(path.join(META, 'b', 'Twice.json'), { summary: 'The good one' });              // …so this one matches (by name)

const PORT = 3994, BASE = `http://127.0.0.1:${PORT}`;
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
  return { status: r.status, data: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] || null };
};
const ok = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const work = async t => (await call('GET', '/api/series?limit=50')).data.items.find(s => s.title === t);

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library.id;
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  const src = (await call('POST', '/api/metadata/sources', { name: 'JSON', folder: META, match: 'name' })).data.source;
  const saga = await until(async () => { const w = await work('Saga'); return w && w.localSources.length && w; });

  // ---- links from JSON ----
  ok(saga.links.length === 2 && saga.links[0].url === 'https://anilist.co/manga/30013' && saga.links[0].site === 'anilist' && saga.links[0].from === 'folder'
    && saga.links[1].url === 'https://example.org/saga' && saga.links[1].site === null, 'JSON url/links become the work’s links (site recognized; non-addresses dropped)');
  ok((await call('GET', `/api/series/${saga.id}`)).data.series.fieldSources.links.kind === 'folder', 'the Edit dialog knows where the links come from');

  // ---- unreadable JSON ignored ----
  ok(!(await work('Broken')).localSources.length, 'an unreadable JSON file is ignored (no data, nothing breaks)');
  const twice = await work('Twice');
  ok(twice.localSources.length && twice.summary === 'The good one', 'with two files of the same name, the unreadable one is skipped and the readable one matches');
  const chk = (await call('GET', `/api/metadata/sources/${src.id}/check`)).data;
  ok(chk.errors.length === 2 && !chk.unused.some(f => /Broken|a\/Twice/.test(f)), 'check report: unreadable files listed as such, not as unused');

  // ---- "Update metadata" matches JSON again right away ----
  write(path.join(META, 'Broken.json'), { summary: 'Fixed now' });
  const up = (await call('POST', `/api/libraries/${L}/metadata`, { mode: 'stale' })).data;
  ok(up.folder && up.folder.works === 3 && (await work('Broken')).summary === 'Fixed now', '“Update metadata” re-matches the JSON files of the whole library first (fixed file picked up)');

  // ---- links edited by hand ----
  ok((await call('PATCH', `/api/series/${saga.id}`, { links: 'ftp://nope' })).data.error === 'invalidLink', 'links must be web addresses');
  await call('PATCH', `/api/series/${saga.id}`, { links: 'https://mangadex.org/title/a1c7c817-4e59-43b7-9365-09675a149a6f\nhttps://example.net/x' });
  let s = (await call('GET', `/api/series/${saga.id}`)).data.series;
  ok(s.links.map(l => l.site + ' ' + l.from).join() === 'mangadex edit,null edit', 'edited links replace the others (one per line)');
  await call('PATCH', `/api/series/${saga.id}`, { links: '' });
  ok((await call('GET', `/api/series/${saga.id}`)).data.series.links.length === 2, 'clearing them brings back the JSON links');
  ok((await call('POST', `/api/series/${saga.id}/metadata/identify`, { matches: [{ provider: 'nope', id: '1' }] })).status === 400, 'Identify: unknown sites refused');
  srv.kill();

  // ---- in process: matching by link, several matches, covers from links (fake sites, fake web) ----
  process.env.THOTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-links2-'));
  const store = require(path.join(APP, 'library', 'db.js'));
  const meta = require(path.join(APP, 'library', 'metadata', 'index.js'));
  const { BY_ID } = require(path.join(APP, 'library', 'metadata', 'providers.js'));
  const calls = [];
  for (const id of Object.keys(BY_ID)) {
    BY_ID[id].search = async q => { calls.push(id + ':search:' + q); return []; };
    BY_ID[id].fetch = async x => { calls.push(id + ':fetch:' + x); return { id: x, title: 'T ' + id, url: `https://${id}.example/${x}`, summary: id === 'anilist' ? 'from anilist' : undefined, cover: `https://img.example/${id}-${x}.jpg` }; };
  }
  store.db.libraries.lib = { id: 'lib', name: 'L', root: TMP, metadata: { cover: 'never', providers: Object.keys(BY_ID).map(id => ({ id, enabled: id === 'anilist' || id === 'mangadex' || id === 'kitsu' })) } };
  const x = { id: 'w1', libraryId: 'lib', name: 'Saga', relPath: 'Saga', meta: {}, overrides: { links: ['https://anilist.co/manga/30013', 'https://pages.example/saga'] } };
  store.db.series.w1 = x;
  await meta.refreshSeries('w1');
  ok(calls.includes('anilist:fetch:30013') && !calls.some(c => c.startsWith('anilist:search')), 'a link to a site is used as an exact match (fetched by id, no search)');
  ok(calls.includes('mangadex:search:Saga') && calls.includes('kitsu:search:Saga'), 'other enabled sites are still searched');
  ok(x.provider.matches.find(m => m.provider === 'anilist').via === 'link', 'the match says it came from a link');
  calls.length = 0;
  await meta.identify('w1', [{ provider: 'mangadex', id: 'md-1' }, { provider: 'kitsu', id: 'k-9' }, { provider: 'kitsu', id: 'k-10' }]);
  ok(x.provider.locked.length === 2 && x.provider.locked.find(l => l.provider === 'kitsu').id === 'k-10', 'Identify with several matches: one per site (the last pick for a site wins)');
  ok(calls.includes('mangadex:fetch:md-1') && calls.includes('kitsu:fetch:k-10') && calls.includes('anilist:fetch:30013'), 'all of them are read, even after the main fields were filled');
  ok(x.provider.matches.length === 3 && x.provider.links.length === 3, 'every match is kept, with its address');
  delete x.overrides.links;
  store.touch(); // (a direct change in a test: say so, as a save would)
  ok(store.seriesView(x, { role: 'admin', username: 'a' }, { admin: true }).links.length === 3, 'without edited links, the work’s links are its matches’ addresses');

  // Covers: the site link gives that entry's cover; another page gives the image it offers for sharing
  x.overrides.links = ['https://comicvine.gamespot.com/saga/4050-12345/', 'https://pages.example/saga'];
  store.touch();
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url) === 'https://pages.example/saga') return new Response('<html><head><meta content="/img/saga-cover.jpg" property="og:image"></head><body>…</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return realFetch(url);
  };
  const cfg = require(path.join(APP, 'config.js'));
  cfg.update({ comicVineApiKey: 'testkey' });
  const cands = (await meta.coverCandidates(x, { search: true })).candidates.filter(c => c.kind === 'online');
  global.fetch = realFetch;
  ok(cands.some(c => c.provider === 'comicvine' && c.url === 'https://img.example/comicvine-12345.jpg' && c.page.includes('4050-12345')), 'a link to a site → that entry’s cover is a choice (even if the site is off in the library)');
  ok(cands.some(c => c.provider === 'web:pages.example' && c.url === 'https://pages.example/img/saga-cover.jpg'), 'any other page → the image it offers for sharing (og:image, made absolute)');
  ok(!meta.publicUrl('http://localhost/x') && !meta.publicUrl('http://192.168.1.5/x') && !meta.publicUrl('file:///etc/passwd') && !meta.publicUrl('http://10.0.0.1/') && meta.publicUrl('https://example.org/a'),
    'pages on this machine or the local network are never fetched');
  ok(await meta.pageImage('http://127.0.0.1:1/') === null, '…so they give no image');

  console.log(`\nALL ${passed} LINK CHECKS PASSED`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2000)); try { srv.kill(); } catch {} process.exit(1); });
