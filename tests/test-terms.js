// node tests/test-terms.js <app dir> â€” one name per genre/tag across sources ("Sci Fi" = "Science Fiction"),
// genres/tags of several sources combined, people as filters (like tags), sorting by score, the work page
// data behind them. The online part uses fake sites (no network).
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-terms-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media'), META = path.join(TMP, 'meta');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const write = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' || Buffer.isBuffer(d) ? d : JSON.stringify(d)); };
const comicInfo = g => Buffer.from(`<ComicInfo><Genre>${g}</Genre></ComicInfo>`);
// Alpha: its file says "Science Fiction", its JSON "Sci Fi" + "Humor" â†’ one Sci-Fi, Comedy
write(path.join(MEDIA, 'Alpha', '1.cbz'), makeZip([['ComicInfo.xml', comicInfo('Science Fiction, Drama')], ['p.png', png(10, 15, [200, 60, 90], 1)]]));
write(path.join(META, 'Alpha.json'), { genres: ['Sci Fi', 'Humor'], tags: ['time-travel', 'Comedy'], writers: ['Ann Writer'], artists: ['Bo Artist'], rating: 70 });
write(path.join(MEDIA, 'Beta', '1.cbz'), makeZip([['p.png', png(10, 15, [20, 160, 90], 1)]]));
write(path.join(META, 'Beta.json'), { genres: ['SciFi'], writers: ['Ann Writer'], rating: 92 });
write(path.join(MEDIA, 'Gamma', '1.cbz'), makeZip([['p.png', png(10, 15, [20, 60, 190], 1)]]));
write(path.join(META, 'Gamma.json'), { genres: ['Romance'], artists: ['Bo Artist'] });

const PORT = 3995, BASE = `http://127.0.0.1:${PORT}`;
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
const ok = (c, m) => { assert(c, m); passed++; console.log('  âœ“', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(100); } throw new Error('timeout waiting'); }
const titles = async qs => (await call('GET', '/api/series?limit=50&' + qs)).data.items.map(s => s.title).join(',');

(async () => {
  // ---- the names themselves ----
  const terms = require(path.join(APP, 'library', 'metadata', 'terms.js'));
  ok(['Sci Fi', 'science-fiction', 'SciFi', 'Science Fiction', 'sci-fi', 'SF'].every(x => terms.canonical(x) === 'Sci-Fi'), 'Sci Fi / Science Fiction / SciFi / SF â†’ Sci-Fi');
  ok(terms.canonical('Shonen') === 'Shounen' && terms.canonical('Humour') === 'Comedy' && terms.canonical('Slice-of-Life') === 'Slice of Life' && terms.canonical('Yaoi') === "Boys' Love", 'other spellings and synonyms (Shonen, Humour, Slice-of-Life, Yaoi)');
  ok(terms.unify(['Action', 'action ', 'ACTION', 'Spider stuff', 'spider-stuff']).join('|') === 'Action|Spider stuff', 'unknown names: repeats dropped, first spelling kept');
  ok(terms.unify(['Pirate', 'Pirates', 'Ships', 'Ship', 'Chess', 'Ches']).join('|') === 'Pirate|Ships|Chess|Ches', 'singular and plural are one name ("Pirate" = "Pirates"); "ss" endings left alone');
  const gt = terms.unifyGenresTags([['Comedy'], ['Humor', 'Drama']], [['comedy', 'Time-Travel', 'Time Travel']]);
  ok(gt.genres.join('|') === 'Comedy|Drama' && gt.tags.join('|') === 'Time Travel', 'genres and tags combined; a genre isnâ€™t repeated as a tag');

  // ---- through the server: every source combined ----
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } });
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  await call('POST', '/api/metadata/sources', { name: 'JSON', folder: META, match: 'name' });
  const items = await until(async () => { const x = (await call('GET', '/api/series?limit=50')).data.items; return x.every(s => s.localSources.length) && x; });
  const alpha = items.find(s => s.title === 'Alpha');
  ok(alpha.genres.join('|') === 'Sci-Fi|Comedy|Drama', `genres of the JSON file and of the file's ComicInfo combined, one name each (${alpha.genres.join(', ')})`);
  ok(alpha.tags.join('|') === 'Time Travel', 'tags tidied; "Comedy" isnâ€™t repeated as a tag');
  const facets = (await call('GET', '/api/series/facets')).data;
  ok(facets.genres.find(g => g.name === 'Sci-Fi').count === 2 && !facets.genres.some(g => /^sci ?fi$|science/i.test(g.name)), 'filters offer one Sci-Fi (2 works), not three spellings');
  ok(await titles('genre=Science%20Fiction') === 'Alpha,Beta', 'filtering by another spelling finds the same works');

  // ---- people like tags ----
  const ann = facets.people.find(p => p.name === 'Ann Writer'), bo = facets.people.find(p => p.name === 'Bo Artist');
  ok(ann && ann.count === 2 && ann.roles.includes('writer') && bo && bo.count === 2, 'filters offer the people, with how many works and their roles');
  ok(await titles('person=Ann%20Writer') === 'Alpha,Beta' && await titles('person=Bo%20Artist') === 'Alpha,Gamma', 'filter by a person (any role)');
  ok(await titles('person=Ann%20Writer&person=Bo%20Artist') === 'Alpha' && await titles('person=Bo%20Artist&xperson=Ann%20Writer') === 'Gamma', 'people combine like tags: all included, none excluded');

  // ---- sorting by score ----
  ok(await titles('sort=rating') === 'Beta,Alpha,Gamma', 'sort by score: best first, works without a score last');
  const L = (await call('GET', '/api/libraries')).data.libraries[0].id;
  ok((await call('PATCH', `/api/libraries/${L}`, { defaults: { sort: 'rating' } })).status === 200 && (await call('GET', '/api/libraries')).data.libraries[0].defaultSort === 'rating', 'score can be a libraryâ€™s default order');

  // ---- an administrator's list replaces the combined one ----
  await call('PATCH', `/api/series/${alpha.id}`, { genres: 'science fiction, Mystery' });
  const a2 = (await call('GET', `/api/series/${alpha.id}`)).data.series;
  ok(a2.genres.join('|') === 'Sci-Fi|Mystery' && a2.tags.join('|') === 'Time Travel|Comedy', `edited genres replace the combined ones (standard names); tags still combined (${a2.genres} / ${a2.tags})`);
  srv.kill();

  // ---- online: several sites complement each other ----
  process.env.THOTH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-terms2-'));
  const store = require(path.join(APP, 'library', 'db.js'));
  const meta = require(path.join(APP, 'library', 'metadata', 'index.js'));
  const { BY_ID } = require(path.join(APP, 'library', 'metadata', 'providers.js'));
  const sites = {
    anilist: { genres: ['Sci-Fi', 'Action'], tags: ['Time Travel'], summary: 'from anilist', altTitles: ['Saga X'] },
    mangadex: { genres: ['Science Fiction', 'Drama'], tags: ['time-travel', 'Aliens'], summary: 'from mangadex', altTitles: ['saga x', 'Saga Y'] },
    kitsu: { genres: ['Comedy'], tags: ['Humor'] }
  };
  const asked = [];
  for (const id of Object.keys(BY_ID)) {
    BY_ID[id].search = async q => (sites[id] ? [{ id: id + '-1', title: q }] : []);
    BY_ID[id].fetch = async x => { asked.push(id); return Object.assign({ id: x, title: 'Saga', url: `https://${id}.example/${x}` }, sites[id]); };
  }
  store.db.libraries.lib = { id: 'lib', name: 'L', root: TMP, metadata: { cover: 'never', providers: Object.keys(BY_ID).map(id => ({ id, enabled: Boolean(sites[id]) })) } };
  const w = store.db.series.w1 = { id: 'w1', libraryId: 'lib', name: 'Saga', relPath: 'Saga', meta: {}, overrides: {} };
  await meta.refreshSeries('w1');
  ok(['anilist', 'mangadex', 'kitsu'].every(id => asked.includes(id)), 'every enabled site is asked (not only until the main fields are filled)');
  const pm = w.provider.merged;
  ok(pm.genres.join('|') === 'Sci-Fi|Action|Drama|Comedy', `genres complemented across sites, one name each (${pm.genres.join(', ')})`);
  ok(pm.tags.join('|') === 'Time Travel|Aliens', 'tags complemented; a tag that is a genre elsewhere ("Humor" = Comedy) isnâ€™t repeated');
  ok(pm.summary === 'from anilist' && pm.altTitles.join('|') === 'Saga X|Saga Y', 'other fields: the first site wins; alternative titles combined without repeats');
  ok(w.provider.sources.genres === 'anilist,mangadex,kitsu', 'the work knows which sites gave its genres');

  console.log(`\nALL ${passed} TERM/PEOPLE/SORT CHECKS PASSED`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-2000)); try { srv.kill(); } catch {} process.exit(1); });
