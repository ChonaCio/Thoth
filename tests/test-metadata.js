// node test-metadata.js <app dir> — online metadata end to end, against the real metadata sites
// (AniList, MangaDex, Kitsu, Open Library). Runs on a copy of the app with its own data folder.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const SRC = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-meta-'));
const APP = path.join(TMP, 'app');
fs.cpSync(SRC, APP, { recursive: true, filter: p => !/[\\/](\.git|\.updates|data|node_modules|media)([\\/]|$)/.test(p.slice(SRC.length)) });
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const cbz = n => makeZip(Array.from({ length: 3 }, (_, i) => [`p${i}.png`, png(30, 45, [n * 40 % 255, 90, 160], i)]));
for (const [dir, file] of [['One Piece', 'Vol 01.cbz'], ['One Piece (Colored)', 'Vol 01.cbz'], ['Solo Leveling', 'Ch 001.cbz'], ['Zzqx Qwvb Nothing 4471', 'Ch 1.cbz']]) {
  fs.mkdirSync(path.join(MEDIA, dir), { recursive: true });
  fs.writeFileSync(path.join(MEDIA, dir, file), cbz(dir.length));
}
// A one-shot PDF: no cover page in the files, so the downloaded cover is used
fs.writeFileSync(path.join(MEDIA, 'The Hobbit.pdf'), '%PDF-1.4\n1 0 obj << /Type /Pages /Count 3 >> endobj\n');

const PORT = 3986, BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'cvkey' + Math.random().toString(36).slice(2) + 'zz';
let srv, passed = 0, cookie, log = '';
function start() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA } });
    srv.stdout.on('data', d => { log += d; if (log.includes('Libraries:')) resolve(); }); srv.stderr.on('data', d => log += d);
    srv.on('exit', c => reject(new Error('exit ' + c + log)));
  });
}
const call = async (m, u, b, c = cookie) => {
  const r = await fetch(BASE + u, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, c ? { Cookie: c } : {}), body: m === 'GET' || m === 'DELETE' && !b ? undefined : JSON.stringify(b || {}) });
  const sc = r.headers.get('set-cookie');
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text, cookie: sc ? sc.split(';')[0] : null, type: r.headers.get('content-type') };
};
const ok = (c, n) => { assert(c, n); passed++; console.log('  ✓', n); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 60000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(250); } throw new Error('timeout waiting'); }
const all = async (q = '') => (await call('GET', '/api/series?limit=200' + q)).data.items;
const byTitle = (items, t) => items.find(s => s.workTitle === t || s.title === t);

(async () => {
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;

  // ---- providers & library settings ----
  const prov = (await call('GET', '/api/metadata/providers')).data;
  ok(prov.providers.length === 8 && prov.providers.find(p => p.id === 'comicvine').needsKey && !prov.providers.find(p => p.id === 'comicvine').defaultOn, '8 providers; Comic Vine needs a key and is off by default');
  const order = [{ id: 'anilist', enabled: true }, { id: 'mangadex', enabled: true }, { id: 'kitsu', enabled: true }, { id: 'openlibrary', enabled: true },
    { id: 'mangaupdates', enabled: false }, { id: 'myanimelist', enabled: false }];
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { providers: order, cover: 'missing' } })).data.library;
  ok(L.metadata.providers.map(p => p.id).slice(0, 4).join() === 'anilist,mangadex,kitsu,openlibrary' && L.metadata.providers.length === 8
    && L.metadata.providers.find(p => p.id === 'googlebooks').enabled === false && L.metadata.autoFetch === true, 'library keeps the chosen order; providers not sent are appended with their defaults');
  ok((await call('PATCH', `/api/libraries/${L.id}`, { metadata: { cover: 'sometimes' } })).status === 400, 'invalid cover setting rejected');

  // ---- automatic lookup after the first scan ----
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  const t0 = Date.now();
  let maxAtOnce = 0, sawProgress = null;
  await until(async () => {
    const m = (await call('GET', '/api/processes')).data.metadata;
    maxAtOnce = Math.max(maxAtOnce, m.current.length);
    if (m.progress && m.progress.total === 5) sawProgress = m.progress;
    return m.done >= 5 && m.queue === 0 && !m.current.length;
  }, 240000);
  console.log(`    looked up 5 works in ${((Date.now() - t0) / 1000).toFixed(1)} s (up to ${maxAtOnce} at once)`);
  ok(maxAtOnce > 1 && maxAtOnce <= 3, `several works looked up at once (default 3; saw ${maxAtOnce})`);
  ok(sawProgress && sawProgress.percent >= 0 && sawProgress.percent <= 100, `batch progress reported (${sawProgress && sawProgress.done}/5, ${sawProgress && sawProgress.percent}%)`);
  const after = (await call('GET', '/api/processes')).data.metadata;
  ok(after.progress === null && after.covers >= 3, `idle afterwards; ${after.covers} covers downloaded as part of the checks`);
  let items = await all();
  const op = byTitle(items, 'One Piece'), sl = byTitle(items, 'Solo Leveling'), hb = byTitle(items, 'The Hobbit'), zz = byTitle(items, 'Zzqx Qwvb Nothing 4471');
  ok(op && op.editions.length === 2, 'versions still group into one work ("One Piece" + Colored)');
  ok(op.type === 'manga' && op.year === 1997 && op.status === 'ongoing' && op.summary.length > 50 && op.readingDirection === 'rtl', `One Piece: manga, 1997, ongoing, summary, right-to-left (${op.type}, ${op.year}, ${op.status})`);
  ok(op.authors.some(a => /oda/i.test(a.name)) && op.tags.length > 0 && op.rating > 0, `One Piece: authors (${op.authors.map(a => a.name).slice(0, 2).join(', ')}), tags, rating ${op.rating}`);
  ok(op.genres.includes('Adventure') && !op.tags.includes('Adventure') && op.tags.length <= 8, `genres kept apart from tags (${op.genres.join(', ')} | ${op.tags.join(', ')})`);
  ok(op.metadata.cover && op.metadata.coverProvider === 'anilist', 'the matched cover was downloaded (from the first source)');
  ok((await all('&metadata=matched')).length === 3 && (await all('&metadata=unmatched')).length === 1 && (await all('&genre=adventure')).some(s => s.workTitle === 'One Piece'), 'filter by metadata state and by online genre');
  ok(op.metadata.matched && op.metadata.sources.summary === 'anilist' && op.metadata.links.some(l => /anilist\.co/.test(l.url)), 'first source in the order (AniList) filled the summary; link to it');
  ok(op.title === 'One Piece', 'title stays the library’s');
  ok(op.coverSource === 'file', 'cover setting "missing": a CBZ keeps its first page as cover');
  ok(sl && sl.type === 'manhwa', `Solo Leveling: manhwa (${sl && sl.type})`);
  ok(hb && hb.oneshot && ['novel', 'book'].includes(hb.type) && hb.metadata.matched && hb.metadata.sources.summary !== 'anilist', `The Hobbit (PDF one-shot): ${hb.type} from ${hb.metadata.links.map(l => l.provider).join(', ')}`);
  ok(Object.values(op.metadata.sources).concat(Object.values(sl.metadata.sources), Object.values(hb.metadata.sources)).every(p => ['anilist', 'mangadex', 'kitsu', 'openlibrary'].includes(p)), 'only the enabled sources were used');
  ok(zz && zz.metadata && !zz.metadata.matched && zz.type === null, 'a title no site knows: looked up, no match, nothing invented');
  if (hb.coverSource === 'metadata') {
    const th = await fetch(`${BASE}/api/series/${hb.id}/thumbnail?v=${hb.coverV}`, { headers: { Cookie: cookie } });
    ok(th.ok && /^image\//.test(th.headers.get('content-type')) && (await th.arrayBuffer()).byteLength > 1000, 'PDF one-shot uses the downloaded cover');
    ok(fs.readdirSync(path.join(DATA, 'covers')).some(f => f.startsWith(hb.id + '.')), 'cover stored in data/covers/');
  } else console.log('    (no cover found for The Hobbit; cover checks skipped)');

  // ---- filters & search ----
  const manga = await all('&type=manga');
  ok(manga.some(s => s.workTitle === 'One Piece') && !manga.some(s => s.workTitle === 'Solo Leveling'), 'filter by type');
  ok((await all('&q=oda')).some(s => s.workTitle === 'One Piece'), 'library filter finds works by author name');

  // ---- precedence: admin edits > files > online ----
  await call('PATCH', `/api/series/${op.id}`, { summary: 'My own summary', type: 'comic' });
  let s1 = (await call('GET', `/api/series/${op.id}`)).data.series;
  ok(s1.summary === 'My own summary' && s1.type === 'comic', 'admin edits win over online metadata');
  await call('PATCH', `/api/series/${op.id}`, { summary: '', type: '' });
  s1 = (await call('GET', `/api/series/${op.id}`)).data.series;
  ok(s1.summary.length > 50 && s1.type === 'manga', 'clearing the edit shows the online value again');

  // ---- Identify ----
  const found = (await call('GET', `/api/series/${zz.id}/metadata/search?q=${encodeURIComponent('Solo Leveling')}&provider=anilist`)).data;
  ok(found.results.length && found.results.every(r => r.provider === 'anilist') && found.results[0].score >= found.results[found.results.length - 1].score, `search one source: ${found.results.length} results, best first ("${found.results[0].title}")`);
  const pick = found.results[0];
  const idn = (await call('POST', `/api/series/${zz.id}/metadata/identify`, { provider: 'anilist', id: pick.id })).data.series;
  ok(idn.metadata.matched && idn.metadata.locked.provider === 'anilist' && idn.type === 'manhwa' && idn.title === 'Zzqx Qwvb Nothing 4471', 'identify: uses the picked match (title unchanged), locked');
  const ref = (await call('POST', `/api/series/${zz.id}/metadata/refresh`)).data.series;
  ok(ref.metadata.locked && ref.metadata.matched && ref.type === 'manhwa', 'refresh keeps the identified match');
  ok((await call('POST', `/api/series/${zz.id}/metadata/identify`, { provider: 'nope', id: '1' })).status === 400, 'unknown provider rejected');

  // ---- Clear ----
  if (hb.coverSource === 'metadata') {
    const cl = (await call('DELETE', `/api/series/${hb.id}/metadata`)).data.series;
    ok(cl.metadata === null && cl.type === null && cl.coverSource === null && !fs.readdirSync(path.join(DATA, 'covers')).some(f => f.startsWith(hb.id + '.')), 'clear: metadata and cover file removed');
  }

  // ---- library actions ----
  let q = (await call('POST', `/api/libraries/${L.id}/metadata`, { mode: 'missing' })).data;
  ok(q.queued === (hb.coverSource === 'metadata' ? 1 : 0), `"fetch metadata" queues only works never looked up (${q.queued})`);
  await until(async () => { const m = (await call('GET', '/api/processes')).data.metadata; return m.queue === 0 && !m.current.length; }, 120000);
  const lib = (await call('GET', '/api/libraries')).data.libraries[0];
  ok(lib.metadataCount >= 4 && lib.seriesCount === 5, `library card: ${lib.metadataCount} of ${lib.seriesCount} works matched`);

  // ---- permissions ----
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  ok((await call('POST', `/api/series/${op.id}/metadata/refresh`, {}, bob)).status === 403 && (await call('GET', '/api/metadata/providers', null, bob)).status === 403
    && (await call('POST', `/api/libraries/${L.id}/metadata`, {}, bob)).status === 403, 'only admins can fetch, identify or clear metadata');
  const bobView = (await call('GET', `/api/series/${op.id}`, null, bob)).data.series;
  ok(bobView.type === 'manga' && bobView.metadata.links.length && bobView.metadata.errors === undefined, 'users see the metadata and links (not the error details)');

  // ---- API keys stay secret ----
  let cfg = (await call('PATCH', '/api/config', { comicVineApiKey: SECRET }));
  ok(cfg.status === 200 && cfg.data.secretsSet.comicVineApiKey === true && !cfg.text.includes(SECRET), 'API key saved; the answer only says it is set');
  ok(!(await call('GET', '/api/config')).text.includes(SECRET) && (await call('GET', '/api/metadata/providers')).data.providers.find(p => p.id === 'comicvine').keySet, 'key never sent back to the browser; provider shows "key set"');
  ok((await call('PATCH', '/api/config', { comicVineApiKey: 'has space' })).status === 400, 'malformed key rejected');
  ok((await call('PATCH', '/api/config', { comicVineApiKey: '' })).data.secretsSet.comicVineApiKey === true, 'empty value keeps the saved key');
  ok((await call('PATCH', '/api/config', { comicVineApiKey: null })).data.secretsSet.comicVineApiKey === false, 'null removes it');
  ok(!log.includes(SECRET) && /comicVineApiKey set/.test(log), 'the server log never contains the key');
  const provSrc = fs.readFileSync(path.join(APP, 'library', 'metadata', 'providers.js'), 'utf8');
  ok(/Thoth-Library-Server\/1\.0/.test(provSrc) && !/mailto:|User-Agent[^\n]*@/i.test(provSrc), 'requests use a generic user agent with no contact details');

  console.log(`\nALL ${passed} METADATA CHECKS PASSED`);
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n--- server log tail ---\n' + log.slice(-2500)); try { srv.kill(); } catch {} process.exit(1); });
