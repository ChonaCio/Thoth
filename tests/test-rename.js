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
const A = ['chapter-0.cbz', 'chapter-1.cbz', 'chapter-1.1.cbz', 'chapter-2x5.cbz', 'chapter-1-chapter name.cbz', 'Chapter 2.cbz'];
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
  const expect = { 'chapter-0.cbz': 'Chapter 0.cbz', 'chapter-1.cbz': 'Chapter 1.cbz', 'chapter-1.1.cbz': 'Chapter 1.1.cbz', 'chapter-1x1.cbz': 'Chapter 1.1.cbz', 'chapter-2x5.cbz': 'Chapter 2.5.cbz', 'Chapter 001.cbz': 'Chapter 1.cbz', 'ch.007.5.cbz': 'Chapter 7.5.cbz',
    'chapter-83-the-end.cbz': 'Chapter 83 - The End.cbz', 'chapter-010-re-zero.cbz': 'Chapter 10 - Re Zero.cbz', 'Chapter 5 - Spider-Man.cbz': null, 'chapter 0.cbz': null, 'CHAPTER 7.CBZ': null,
    'chapter-1-chapter name.cbz': 'Chapter 1 - Chapter Name.cbz', 'ch_12_the_end.cbz': 'Chapter 12 - The End.cbz', 'vol.3.cbz': 'Volume 3.cbz',
    'Chapter 1.cbz': null, 'Chapter 1 - Chapter Name.cbz': null, 'Saga 001.cbz': null, 'EP-4.pdf': 'Episode 4.pdf' };
  ok(Object.entries(expect).every(([from, to]) => rules.proposedName(from) === to), 'naming rules: every example gives the expected name (and good names are left alone)');
  // English titles first
  const { preferEnglish, taggedEnglish } = require(path.join(APP, 'library', 'titles.js'));
  ok(preferEnglish(['Shingeki no Kyojin', 'Attack on Titan', '進撃の巨人']) === 'Attack on Titan' && preferEnglish(['나 혼자만 레벨업', 'Solo Leveling']) === 'Solo Leveling' && preferEnglish(['One Piece', 'ワンピース']) === 'One Piece' &&
    taggedEnglish([{ 'ja-ro': 'Kimetsu no Yaiba' }, { en: 'Demon Slayer' }]) === 'Demon Slayer' && taggedEnglish([{ en_jp: 'Romaji' }]) === null, 'titles: the English one is preferred (tagged or by how it reads)');
  ok(preferEnglish(['Jujutsu Kaisen', 'Sorcery Fight: The Story of the World']) === 'Jujutsu Kaisen' && preferEnglish(['Solo Leveling', 'The Lord of the Night']) === 'Solo Leveling' &&
    preferEnglish(['El Rey Demonio', 'The Demon King']) === 'The Demon King', 'titles: a main title already in English is kept over an alternative one');
  const { splitTitles } = require(path.join(APP, 'library', 'titles.js'));
  const splitCases = [
    ['俺だけレベルアップな件, Na Honjaman Level Up, Solo Leveling', {}, '俺だけレベルアップな件|Na Honjaman Level Up|Solo Leveling'],
    ['Love, Chunibyo & Other Delusions, Chuunibyou demo Koi ga Shitai!', { known: ['Love, Chunibyo & Other Delusions'] }, 'Love, Chunibyo & Other Delusions|Chuunibyou demo Koi ga Shitai!'],
    ['Kaguya-sama (Love, War), かぐや様', {}, 'Kaguya-sama (Love, War)|かぐや様'],
    ['Yes, My Lord, Hai Shujin-sama', {}, 'Yes, My Lord|Hai Shujin-sama'],
    ['Wait, what? / Matte, nani?', {}, 'Wait, what?|Matte, nani?'],
    ['Fate/stay night, Fate Stay Night', {}, 'Fate/stay night|Fate Stay Night'],
    ['A; B, with a comma; C', {}, 'A|B, with a comma|C'],
    ['転生したらスライムだった件、That Time I Got Reincarnated as a Slime', {}, '転生したらスライムだった件|That Time I Got Reincarnated as a Slime'],
    ['Sorry, Hero, Gomen Yuusha', { sep: ',' }, 'Sorry, Hero|Gomen Yuusha'],
    ['A • B, C • D', { sep: '•' }, 'A|B, C|D']];
  const badSplits = splitCases.filter(([x, o, want]) => splitTitles(x, o).join('|') !== want).map(([x, o]) => x + ' → ' + splitTitles(x, o).join('|'));
  ok(!badSplits.length, 'titles: several in one line split without cutting titles that have commas or slashes in them' + (badSplits.length ? ' (' + badSplits.join('; ') + ')' : ''));
  // What isn't part of a title, and version markers (catalog titles; the library uses the bracketed markers)
  const { parseTitle } = require(path.join(APP, 'library', 'titles.js'));
  const pt = (x, o) => { const p = parseTitle(x, o); return p.title + (p.editions.length ? ' [' + p.editions.join('+') + ']' : ''); };
  const titleCases = [['Solo Leveling (Official) - engsub', 'Solo Leveling'], ['One Piece [AI ANIMATION]', 'One Piece [animated]'], ['Tomb Raider King [AI CC]', 'Tomb Raider King [animated]'],
    ['Berserk (Raw) Uncensored', 'Berserk [raw+uncensored]'], ['Berserk - Full Colored', 'Berserk [colored]'], ['Kingdom Uncen', 'Kingdom [uncensored]'], ['Eat Raw', 'Eat Raw'], ['Lookism (2019)', 'Lookism (2019)']];
  const badTitles = titleCases.filter(([x, want]) => pt(x) !== want).map(([x]) => x + ' → ' + pt(x));
  ok(!badTitles.length && pt('Tower of God - Fake Scans', { sourceNames: ['Fake Scans'] }) === 'Tower of God' && pt('Work (Manga) [MOTION]', { bare: false, noise: false }) === 'Work (Manga) [animated]',
    `titles: noise taken out, versions found (several, with or without brackets)${badTitles.length ? ' (' + badTitles.join('; ') + ')' : ''}`);
  // The same rules for chapter names read on sites (external catalog)
  const { chapterTitle } = require(path.join(APP, 'library', 'naming.js'));
  const siteNames = [['Chapter 44 - 44', 'Chapter 44'], ['Chapter 44 - Ch. 44', 'Chapter 44'], ['Ch. 044 - Ch. 44  Jan 4, 2025  1.2k views', 'Chapter 44'], ['Vol.2 Ch.15 - Escape 3 days ago', 'Chapter 15 - Escape'],
    ['Episode 7 · 12.3k views', 'Episode 7'], ['Solo Leveling Chapter 12', 'Chapter 12'], ['12 - the end', 'Chapter 12 - The End'], ['Chapter 10.5 NEW', 'Chapter 10.5'], ['Chapter 44: Chapter 44 The End', 'Chapter 44 - The End'], ['Prologue', 'Prologue'],
    // when it was posted, without "ago", and reading-button labels glued to the name
    ['Chapter 18 - 9 Months', 'Chapter 18'], ['Chapter 18 9 Months', 'Chapter 18'], ['Start ReadingChapter 1', 'Chapter 1'], ['Read FirstChapter 1', 'Chapter 1'], ['Chapter 164 6h ago Now Free', 'Chapter 164'],
    ['Chapter 7 a month', 'Chapter 7'], ['Chapter 12 Jan 4', 'Chapter 12'], ['Chapter 10 - 100 Years Later', 'Chapter 10 - 100 Years Later'], ['Latest Chapter 9', 'Chapter 9']];
  const bad = siteNames.filter(([raw, want]) => chapterTitle(raw).name !== want).map(([raw]) => `${raw} → ${chapterTitle(raw).name}`);
  ok(!bad.length && chapterTitle('The Beginning', '1').name === 'Chapter 1 - The Beginning' && chapterTitle('Vol.2 Ch.15').v === '2', `chapter names from sites: dates, views and repeated numbers dropped${bad.length ? ' (' + bad.join('; ') + ')' : ''}`);

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
  const inv = by('ch-5.cbz').involved, invE = by('chapter-3.cbz').involved;
  ok(inv.length === 2 && inv.map(f => f.role).join() === 'this,wants' && inv.every(f => f.pageCount === 1 && f.size > 0 && f.modified && f.bookId) && inv[1].fileName === 'chapter-5.cbz' && inv[1].same === true,
    'a name two files would get: both listed with pages, size, date (and marked as the same chapter twice when they match)');
  ok(invE.map(f => f.role + ':' + f.fileName).join() === 'this:chapter-3.cbz,has:Chapter 3.cbz', 'a name another file has: both listed');
  ok(!pv.items.some(x => x.fromName === 'Chapter 2.cbz'), 'well-named files aren’t listed');

  // ---- apply ----
  const picks = pv.items.filter(x => x.status === 'ok' && x.fromName !== 'chapter-2x5.cbz').map(x => ({ bookId: x.bookId, toName: x.toName }));
  picks.push({ bookId: by('chapter-3.cbz').bookId, toName: by('chapter-3.cbz').toName }); // a conflict: refused
  picks.push({ bookId: by('chapter-2x5.cbz').bookId, toName: 'Something else.cbz' });     // not what was proposed: refused
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  ok((await call('GET', '/api/rename/preview', null, bob)).status === 403 && (await call('POST', '/api/rename/apply', { items: picks }, bob)).status === 403, 'only admins rename');
  const queued = await call('POST', '/api/rename/apply', { items: picks, renameJson: true });
  ok(queued.status === 202 && queued.data.job && ['queued', 'running', 'done'].includes(queued.data.job.status), 'applying queues a rename job (answered at once)');
  const r = await until(async () => { const j = (await call('GET', `/api/rename/jobs/${queued.data.job.id}`)).data.job; return j.status === 'done' && j; });
  ok(r.renamed === 4 && r.json === 1 && r.failedCount === 2 && r.total === 6 && r.done === 6 && r.failed.some(f => f.error === 'exists') && r.failed.some(f => f.error === 'changed'), `applied: 4 renamed, 1 JSON renamed, 2 refused (${r.failed.map(f => f.error).join(', ')})`);
  const procs = (await call('GET', '/api/processes')).data;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  ok(r.process && r.process.mode === 'process' && r.process.pid && r.process.pid !== procs.server.pid, `the files were renamed by a separate process (pid ${r.process && r.process.pid})`);
  for (let i = 0; i < 50 && alive(r.process.pid); i++) await new Promise(res => setTimeout(res, 100));
  ok(!procs.rename.running && procs.rename.last.renamed === 4 && !alive(r.process.pid),'that process is closed once the batch is done (shown on the Processes page)');
  const disk = fs.readdirSync(path.join(MEDIA, 'Work A')).sort();
  ok(['Chapter 0.cbz', 'Chapter 1 - Chapter Name.cbz', 'Chapter 1.1.cbz', 'Chapter 1.cbz', 'Chapter 2.cbz', 'chapter-2x5.cbz'].every(f => disk.includes(f)) && !disk.includes('chapter-0.cbz'), `files renamed on disk (${disk.join(', ')})`);
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
  const again = (await call('GET', `/api/rename/preview?library=${L}`)).data;
  ok(!again.items.some(x => x.status === 'ok' && x.fromName !== 'chapter-2x5.cbz') && again.ok === 1 && again.conflicts === 3 && again.truncated === false, 'checking again: only what was skipped is left (with counts)');

  // ---- rules shown on the page come from the rules themselves ----
  const ex = (await call('GET', '/api/rename/rules')).data.examples;
  ok(ex.length >= 8 && ex.every(x => x.to === rules.proposedName(x.from)) && ex.find(x => x.from === 'chapter-1x1.cbz').to === 'Chapter 1.1.cbz', 'the naming-rule examples are worked out by the current rules');

  // ---- a big batch: "all" (but the excluded), queued behind another job, in chunks ----
  const BIG = path.join(MEDIA, 'Big');
  for (let i = 0; i < 450; i++) book(path.join(BIG, `chapter-${String(i).padStart(3, '0')}-part-${i}.cbz`));
  await call('POST', `/api/libraries/${L}/scan`, {});
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan.books === 460 && l; }, 60000);
  const bigPv = (await call('GET', `/api/rename/preview?library=${L}`)).data;
  ok(bigPv.ok === 451 && bigPv.items.length === bigPv.total, `preview counts every proposal (${bigPv.ok} to rename)`);
  const skip = bigPv.items.find(x => x.fromName === 'chapter-007-part-7.cbz');
  const j1 = (await call('POST', '/api/rename/apply', { all: true, library: L, exclude: [skip.bookId, again.items.find(x => x.status === 'ok').bookId] })).data.job;
  const j2 = (await call('POST', '/api/rename/apply', { all: true, library: L, exclude: [again.items.find(x => x.status === 'ok').bookId] })).data.job; // waits for the first
  const jobs = (await call('GET', '/api/rename/jobs')).data.jobs;
  ok(['queued', 'done'].includes(jobs.find(j => j.id === j2.id).status) && jobs.findIndex(j => j.id === j1.id) < jobs.findIndex(j => j.id === j2.id), 'a second job waits in line behind the first');
  const d1 = await until(async () => { const j = (await call('GET', `/api/rename/jobs/${j1.id}`)).data.job; return j.status === 'done' && j; }, 60000);
  ok(d1.total === 449 && d1.renamed === 449, `"rename all" without the excluded files: ${d1.renamed} renamed in chunks`);
  const d2 = await until(async () => { const j = (await call('GET', `/api/rename/jobs/${j2.id}`)).data.job; return j.status === 'done' && j; }, 60000);
  const bigDisk = fs.readdirSync(BIG);
  ok(d2.renamed === 1 && bigDisk.includes('Chapter 7 - Part 7.cbz') && bigDisk.includes('Chapter 449 - Part 449.cbz') && !bigDisk.some(f => /^chapter-/.test(f)), 'the next job renamed what the first left out; no padding, dashes as spaces');
  ok(!(await call('GET', '/api/processes')).data.rename.running, 'queue empty: no rename process left');

  // ---- a chapter number that lost its decimal point; capitalization alone isn't proposed ----
  const SEQ = path.join(MEDIA, 'Seq');
  for (let i = 1; i <= 12; i++) book(path.join(SEQ, `Chapter ${i}.cbz`));
  book(path.join(SEQ, 'Chapter 115.cbz'));   // 11.5 with its point missing
  book(path.join(SEQ, 'chapter 13.cbz'));    // only the capital differs: left alone
  await call('POST', `/api/libraries/${L}/scan`, {});
  const seqPv = await until(async () => { const r = (await call('GET', `/api/rename/preview?library=${L}`)).data; return r.items.some(x => x.from.startsWith('Seq/')) && r; }, 30000);
  const g = seqPv.items.find(x => x.fromName === 'Chapter 115.cbz');
  ok(g && g.status === 'guess' && g.toName === 'Chapter 11.5.cbz' && g.guess.first === 1 && g.guess.last === 13 && seqPv.guesses === 1, `chapter 115 in a work with 1–13: suggested as 11.5 (${g && g.toName})`);
  ok(!seqPv.items.some(x => x.fromName === 'chapter 13.cbz'), 'a change of capitalization alone isn’t proposed');
  const doneJob = async body => { const id = (await call('POST', '/api/rename/apply', body)).data.job.id; return until(async () => { const j = (await call('GET', `/api/rename/jobs/${id}`)).data.job; return j.status === 'done' && j; }, 60000); };
  let gj = await doneJob({ all: true, library: L });
  ok(fs.existsSync(path.join(SEQ, 'Chapter 115.cbz')), '“rename all” leaves the guess alone (it isn’t selected)');
  gj = await doneJob({ all: true, library: L, include: [g.bookId] });
  ok(gj.renamed === 1 && fs.existsSync(path.join(SEQ, 'Chapter 11.5.cbz')), 'ticked, it’s renamed to 11.5');

  // ---- pages and covers: media service ----
  const anyBook = (await call('GET', `/api/series/${workA.id}`)).data.books[0];
  const p1 = await fetch(`${BASE}/api/books/${anyBook.id}/pages/1`, { headers: { Cookie: cookie } });
  const img = Buffer.from(await p1.arrayBuffer());
  ok(p1.status === 200 && p1.headers.get('content-type') === 'image/png' && img.slice(1, 4).toString() === 'PNG', 'a page is served (through the media service)');
  const p1b = await fetch(`${BASE}/api/books/${anyBook.id}/pages/1`, { headers: { Cookie: cookie } });
  // (the cache processes report every 2 s)
  const med = await until(async () => { const c = (await call('GET', '/api/processes')).data.caches.find(x => x.kind === 'pages'); return c && c.stats && c.stats.hits >= 1 && c; }, 10000);
  ok(p1b.status === 200 && Buffer.from(await p1b.arrayBuffer()).equals(img) && med.stats.entries >= 1, `asked again: answered from the Pages cache (${med.stats.hits} hits, ${med.stats.entries} kept)`);
  ok(med.mode === 'process' && med.pid && med.pid !== procs.server.pid, `the Pages cache is its own process (pid ${med.pid})`);
  const th = await fetch(`${BASE}/api/series/${workA.id}/thumbnail`, { headers: { Cookie: cookie } });
  await until(async () => fs.existsSync(path.join(DATA, 'cache', 'thumbs')) && fs.readdirSync(path.join(DATA, 'cache', 'thumbs')).length >= 1, 5000); // written just after answering
  ok(th.status === 200 && fs.readdirSync(path.join(DATA, 'cache', 'thumbs')).length >= 1, 'a work’s cover is served and kept on disk (key-value)');
  const caches = await until(async () => { const c = (await call('GET', '/api/processes')).data.caches; return c.find(x => x.kind === 'covers' && x.pid) && c; }, 10000);
  const pids = caches.filter(c => c.pid).map(c => c.pid);
  ok(new Set(pids).size === pids.length && !pids.includes(procs.server.pid) && caches.find(c => c.kind === 'covers').pid !== med.pid, `Pages and Covers are separate processes (${caches.filter(c => c.pid).map(c => c.kind + ' ' + c.pid).join(', ')})`);
  ok((await fetch(`${BASE}/api/books/${anyBook.id}/pages/99`, { headers: { Cookie: cookie } })).status === 404, 'a missing page is a 404');
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
