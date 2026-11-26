// node tests/test-downloads.js <app dir> — Downloads against fake sites served here (no network): two sites with
// the same work, merged in the catalog. A job downloads the chapters the library lacks as CBZ files (pages in
// order, ComicInfo.xml): each from the first site in the job's order with a whole copy (a broken copy — an error
// page instead of an image, a cut-off image — is replaced by the other site's), a premium chapter from a site
// where it's free, and one premium everywhere waits ("locked", nothing requested). Also: the image checks and
// CBZ writer in process, "best quality", the chapters view, retry, the job's own process and its task.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-dl-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
// The library already has "Moon Walk" chapter 1
fs.mkdirSync(path.join(MEDIA, 'Moon Walk'), { recursive: true });
fs.writeFileSync(path.join(MEDIA, 'Moon Walk', 'Chapter 1.cbz'), makeZip([['p.png', png(120, 160, [90, 60, 30], 1)]]));

/* ---------------- the fake sites ---------------- */
const SITE_PORT = 3994, SITE = `http://127.0.0.1:${SITE_PORT}`;
const hits = [];
// Site A: Moon Walk 1–4 (2: an error page instead of page 2; 3 and 4: premium), Star Road 1 (narrow pages)
// Site B: Moon Walk 1–3, Star Road 1 (wide pages); its images on another "host" path that wants the browser's referer
const WORKS = {
  a: { 'moon-walk': { title: 'Moon Walk', chapters: [1, 2, 3, 4], premium: [3, 4] }, 'star-road': { title: 'Star Road', chapters: [1], premium: [] } },
  b: { 'moon-walk': { title: 'Moon Walk', chapters: [1, 2, 3], premium: [] }, 'star-road': { title: 'Star Road', chapters: [1], premium: [] } }
};
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  hits.push(u.pathname);
  const send = (status, body, type = 'text/html') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  if (u.pathname === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /private/\n', 'text/plain');
  let m;
  if ((m = /^\/(a|b)\/list$/.exec(u.pathname))) return send(200, Object.keys(WORKS[m[1]]).map(s => `<div class="w"><a href="/${m[1]}/w/${s}">${WORKS[m[1]][s].title}</a></div>`).join(''));
  if ((m = /^\/(a|b)\/w\/([\w-]+)$/.exec(u.pathname)) && WORKS[m[1]][m[2]]) {
    const w = WORKS[m[1]][m[2]];
    return send(200, `<h1>${w.title}</h1><div class="au"><a>Ana Author</a></div><ul>${w.chapters.slice().reverse().map(n => `<li class="c"><a href="/${m[1]}/w/${m[2]}/${n}">Chapter ${n}</a>${w.premium.includes(n) ? '<span class="coin">50</span>' : ''}</li>`).join('')}</ul>`);
  }
  // Chapter pages: three page images in a reader area (lazy-loaded: data-src)
  if ((m = /^\/(a|b)\/w\/([\w-]+)\/(\d+)$/.exec(u.pathname))) {
    const [, s, slug, n] = m;
    const imgs = [1, 2, 3].map(p => s === 'a' ? `/a/img/${slug}/${n}/${p}.png` : `/cdn/${slug}/${n}/${p}.png`);
    return send(200, `<div class="reading-content">${imgs.map(x => `<img src="/loading.gif" data-src="${x}">`).join('')}</div>`);
  }
  if ((m = /^\/a\/img\/([\w-]+)\/(\d+)\/(\d)\.png$/.exec(u.pathname))) {
    if (m[1] === 'moon-walk' && m[2] === '2' && m[3] === '2') return send(200, '<html>Image not found</html>'); // (served as HTML)
    return send(200, png(120, 170, [200, 20 * Number(m[3]), 20], Number(m[2]) * 10 + Number(m[3])), 'image/png');
  }
  if ((m = /^\/cdn\/([\w-]+)\/(\d+)\/(\d)\.png$/.exec(u.pathname))) {
    if (req.headers.referer !== `${SITE}/b/w/${m[1]}/${m[2]}`) return send(403, 'no referer');
    return send(200, png(200, 280, [20, 20 * Number(m[3]), 200], Number(m[2]) * 10 + Number(m[3])), 'application/octet-stream');
  }
  send(404, 'not found');
});

/* ---------------- Thoth ---------------- */
const PORT = 3993, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, cookie, log = '';
function start() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA, THOTH_CATALOG_ALLOW_LOCAL: '1', THOTH_WORKER_IDLE_MS: '1500', THOTH_NO_WARM: '1', THOTH_CATALOG_WARM_DELAY_MS: '600000' } });
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
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150); } throw new Error('timeout waiting'); }
const crawled = async id => until(async () => { const s = (await call('GET', '/api/catalog/sources')).data.sources.find(x => x.id === id); return s && !s.job && (s.lastCrawlAt || s.lastError) && s; }, 60000);
const finished = async id => until(async () => { const j = (await call('GET', `/api/downloads/jobs/${id}`)).data.job; return !j.run && j.lastRunAt && j; }, 90000);

(async () => {
  // ---- in process: image checks, the CBZ writer, file names, schedules ----
  const images = require(path.join(APP, 'library', 'downloads', 'images.js'));
  const p = png(300, 400, [1, 2, 3], 7);
  const c1 = images.checkPage(p, 'image/png');
  ok(c1.ok && c1.width === 300 && c1.height === 400 && c1.ext === 'png', 'a page image: its kind and size read from its header (no image library)');
  ok(!images.checkPage(Buffer.from('<html>Not found</html>'), 'text/html').ok && !images.checkPage(p.slice(0, p.length - 20), 'image/png').ok && !images.checkPage(png(10, 10, [1, 1, 1], 1), 'image/png').ok,
    'refused: a page instead of an image, a cut-off image, a tiny placeholder');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0x58, 0x03, 0x20, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(200), Buffer.from([0xff, 0xd9])]);
  const cj = images.checkPage(jpeg, 'image/jpeg');
  ok(cj.ok && cj.width === 800 && cj.height === 600, `a JPEG's size from its frame header (${cj.width}×${cj.height})`);
  const { writeCbz } = require(path.join(APP, 'library', 'downloads', 'cbz.js'));
  const cbz = path.join(TMP, 'out', 'Chapter 1.cbz');
  writeCbz(cbz, [{ buf: p, ext: 'png' }, { buf: png(300, 400, [9, 9, 9], 2), ext: 'png' }], { series: 'X & Y', number: '1', title: 'Start' });
  const { listEntries, readEntry } = require(path.join(APP, 'library', 'zip.js'));
  const zipped = listEntries ? await listEntries(cbz) : null;
  ok(zipped && zipped.map(e => e.name).join() === '001.png,002.png,ComicInfo.xml', 'CBZ: pages 001, 002… in order and a ComicInfo.xml (read back by Thoth\'s own ZIP reader)');
  const info = (await readEntry(cbz, zipped.find(e => e.name === 'ComicInfo.xml'))).toString();
  ok(/<Series>X &amp; Y<\/Series>/.test(info) && /<PageCount>2<\/PageCount>/.test(info), 'ComicInfo.xml: series (escaped), page count');
  const dl = require(path.join(APP, 'library', 'downloads', 'index.js'));
  ok(dl.chapterFileName({ n: '12', t: 'Chapter 12' }) === 'Chapter 12.cbz' && dl.chapterFileName({ n: '3.5', t: 'The: End?' }) === 'Chapter 3.5 - The End.cbz', 'file names the library way ("Chapter 12.cbz", "Chapter 3.5 - The End.cbz")');
  const at = new Date(2026, 0, 5, 10, 0).getTime(); // (a Monday)
  const nx = dl.nextRun(dl.cleanSchedule({ type: 'weekly', time: '03:00', days: [3] }), at);
  ok(new Date(nx).getDay() === 3 && new Date(nx).getHours() === 3 && dl.nextRun(dl.cleanSchedule({ type: 'manual' })) === null, 'schedules: the next run on the chosen day and time; manual never');

  // ---- a server, a library, two sources crawled and merged ----
  await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r));
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library.id;
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  const sel = { item: '.w', workTitle: 'h1', authors: '.au a', chapter: 'ul li.c', chapterLink: 'a@href' };
  const A = (await call('POST', '/api/catalog/sources', { name: 'Site A', type: 'custom', baseUrl: SITE + '/a', gapMs: 100, includeChapters: true, selectors: Object.assign({ listUrl: '/a/list' }, sel) })).data.source;
  const B = (await call('POST', '/api/catalog/sources', { name: 'Site B', type: 'custom', baseUrl: SITE + '/b', gapMs: 100, includeChapters: true, selectors: Object.assign({ listUrl: '/b/list' }, sel) })).data.source;
  await call('POST', `/api/catalog/sources/${A.id}/crawl`, { mode: 'full' }); await crawled(A.id);
  await call('POST', `/api/catalog/sources/${B.id}/crawl`, { mode: 'full' }); await crawled(B.id);
  let moon = (await call('GET', '/api/catalog?q=moon%20walk')).data.items;
  if (moon.length > 1) await call('POST', '/api/catalog/merge', { keys: moon.map(i => i.sources[0].key), primary: moon.find(i => i.sources[0].sourceId === A.id).sources[0].key });
  moon = (await call('GET', '/api/catalog?q=moon%20walk')).data.items;
  ok(moon.length === 1 && moon[0].sources.length === 2, 'the same work on both sites is one catalog entry');

  // ---- a job ----
  ok((await call('POST', '/api/downloads/jobs', { name: 'X', libraryId: L, sourceOrder: [] })).status === 400, 'a job needs a site to download from');
  const job = (await call('POST', '/api/downloads/jobs', { name: 'Moon', libraryId: L, sourceOrder: [A.id, B.id], works: [moon[0].key], schedule: { type: 'daily', time: '04:00' } })).data.job;
  ok(job.worksCount === 1 && job.nextRunAt && job.works[0].chapters === 4 && job.works[0].done === 1, `a job with the work: 4 chapters, 1 already in the library (${JSON.stringify(job.works[0])})`);
  ok((await call('GET', `/api/downloads/for-work?key=${encodeURIComponent(moon[0].sources[1].key)}`)).data.jobs[0].id === job.id, 'a catalog work knows the jobs it is in (by any of its sites)');
  hits.length = 0;
  const r1 = (await call('POST', `/api/downloads/jobs/${job.id}/run`, {})).data;
  ok(r1.status === 'running' || r1.status === 'queued', 'run now');
  const pr = await until(async () => { const x = (await call('GET', '/api/processes')).data; return x.downloads.running && x; }, 10000).catch(() => null);
  const done1 = await finished(job.id);
  const folder = path.join(MEDIA, 'Moon Walk');
  const files = fs.readdirSync(folder).sort();
  ok(files.join() === 'Chapter 1.cbz,Chapter 2.cbz,Chapter 3.cbz', `chapters 2 and 3 saved into the work's folder in the library (${files.join(', ')}); chapter 1 was there already`);
  ok(!hits.some(h => /\/a\/w\/moon-walk\/(3|4)$/.test(h)) && !hits.some(h => /^\/a\/w\/moon-walk\/1$/.test(h)), 'premium chapters and chapters the library has: never requested');
  const ch = (await call('GET', `/api/downloads/jobs/${job.id}/work?key=${encodeURIComponent(moon[0].key)}`)).data.work.versions[0].chapters;
  const byN = n => ch.find(c => String(c.n) === String(n));
  ok(byN(2).status === 'done' && byN(2).source === 'Site B' && byN(3).source === 'Site B' && byN(1).inLibrary, `chapter 2: site A's copy is broken (an error page for an image), so site B's; chapter 3: premium on A, free on B (${byN(2).source}, ${byN(3).source})`);
  ok(byN(4).status === 'locked' && done1.counts.done === 2 && done1.counts.locked === 1, `chapter 4: premium on the only site that has it → waits (locked) (${JSON.stringify(done1.counts)})`);
  const z2 = await listEntries(path.join(folder, 'Chapter 2.cbz'));
  ok(z2.map(e => e.name).join() === '001.png,002.png,003.png,ComicInfo.xml', 'a downloaded chapter: its 3 pages in order and ComicInfo.xml');
  ok(pr && pr.downloads.running === 1, 'the run is its own process (shown on the Processes page)');
  const tasksNow = (await call('GET', '/api/tasks')).data;
  const tk = tasksNow && (tasksNow.recent || []).find(x => x.kind === 'download');
  ok(tk && tk.status === 'done' && /2 downloaded/.test(tk.summary), `a task with its log (${tk && tk.summary})`);
  await until(async () => (await call('GET', '/api/catalog?q=moon%20walk')).data.items[0], 5000);
  let seen = null;
  const lib = await until(async () => { const s = (await call('GET', `/api/series?library=${L}&q=moon`)).data; seen = s; const x = s && (s.items || []).find(y => /Moon Walk/.test(y.title || y.workTitle || '')); return x && x.booksCount === 3 && x; }, 20000).catch(() => null);
  ok(lib, 'the library is scanned afterwards: the work has 3 chapters' + (lib ? '' : ' — ' + JSON.stringify(seen && seen.items && seen.items.map(i => [i.title, i.booksCount]))));

  // ---- again: nothing new; retry ----
  hits.length = 0;
  await call('POST', `/api/downloads/jobs/${job.id}/run`, {});
  const done2 = await until(async () => { const j = (await call('GET', `/api/downloads/jobs/${job.id}`)).data.job; return !j.run && j.lastRunAt !== done1.lastRunAt && j; });
  ok(/nothing new/.test(done2.lastStatus) && !hits.some(h => /\/(img|cdn)\//.test(h)), `a second run: nothing new to download, no image requested (${done2.lastStatus})`);
  ok((await call('POST', `/api/downloads/jobs/${job.id}/retry`, { key: moon[0].key })).data.retried === 1, 'retry: the locked chapter is tried again on the next run');

  // ---- best quality ----
  const star = (await call('GET', '/api/catalog?q=star%20road')).data.items;
  if (star.length > 1) await call('POST', '/api/catalog/merge', { keys: star.map(i => i.sources[0].key), primary: star.find(i => i.sources[0].sourceId === A.id).sources[0].key });
  const starKey = (await call('GET', '/api/catalog?q=star%20road')).data.items[0].key;
  const q = (await call('POST', '/api/downloads/jobs', { name: 'Best', libraryId: L, mode: 'quality', sourceOrder: [A.id, B.id], works: [starKey] })).data.job;
  await call('POST', `/api/downloads/jobs/${q.id}/run`, {});
  await finished(q.id);
  const sch = (await call('GET', `/api/downloads/jobs/${q.id}/work?key=${encodeURIComponent(starKey)}`)).data.work.versions[0].chapters[0];
  ok(sch.status === 'done' && sch.source === 'Site B' && sch.width === 200, `best quality: the wider copy (site B, 200 px) over the first site in the order (${sch.source}, ${sch.width}px)`);

  // ---- what's on disk already isn't downloaded again (another job put it there) ----
  hits.length = 0;
  const other = (await call('POST', '/api/downloads/jobs', { name: 'Other', libraryId: L, sourceOrder: [B.id], works: [starKey] })).data.job;
  const otherCh = (await call('GET', `/api/downloads/jobs/${other.id}/work?key=${encodeURIComponent(starKey)}`)).data.work.versions[0].chapters[0];
  ok(otherCh.status === 'done', `a chapter whose file is in the folder already counts as there for another job (${otherCh.status})`);
  await call('POST', `/api/downloads/jobs/${other.id}/run`, {});
  const od = await finished(other.id);
  ok(/nothing new/.test(od.lastStatus) && !hits.some(h => /\/cdn\//.test(h)), `…so its run downloads nothing (${od.lastStatus})`);

  // ---- the catalog knows the jobs; works of several sites listed ----
  const marked = (await call('GET', '/api/catalog?q=star%20road')).data.items[0];
  ok(marked.inJobs && marked.inJobs.map(j => j.name).sort().join() === 'Best,Other', `catalog works carry the jobs they are in (${marked.inJobs && marked.inJobs.map(j => j.name).join(', ')})`);
  const both = (await call('GET', `/api/catalog?sources=${A.id},${B.id}&limit=50`)).data, onlyB = (await call('GET', `/api/catalog?sources=${B.id}&limit=50`)).data;
  ok(both.total === 2 && onlyB.total === 2 && onlyB.items.every(it => it.sources.some(s => s.sourceId === B.id)), 'the works of several sites at once (sources=a,b)');
  // (planning happens in the run's own process: its phase is reported)
  const prog = JSON.parse(fs.readFileSync(path.join(DATA, 'downloads', other.id, 'progress.json'), 'utf8'));
  ok(prog.phase === 'downloading' && prog.total === 0 && prog.status === 'done', 'the run worked out what to download in its own process (nothing, here)');

  // ---- editing, removing ----
  const ed = (await call('PATCH', `/api/downloads/jobs/${job.id}`, { name: 'Moon (edited)', versions: ['base', 'colored'], minChapter: 2 })).data.job;
  ok(ed.name === 'Moon (edited)' && ed.versions.join() === 'base,colored' && ed.minChapter === 2 && ed.worksCount === 1, 'a job edited (name, versions, chapter range)');
  await call('DELETE', `/api/downloads/jobs/${job.id}/work?key=${encodeURIComponent(moon[0].key)}`);
  ok((await call('GET', `/api/downloads/jobs/${job.id}`)).data.job.worksCount === 0, 'a work taken out of a job (its files stay)');
  ok(fs.existsSync(path.join(folder, 'Chapter 2.cbz')), '…its files are still in the library');
  ok((await call('DELETE', `/api/downloads/jobs/${job.id}`)).status === 200 && (await call('GET', `/api/downloads/jobs/${job.id}`)).status === 404, 'a job deleted');
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;
  ok((await call('GET', '/api/downloads/jobs', null, bob)).status === 403, 'only administrators see and run downloads');

  console.log(`\nALL ${passed} DOWNLOAD CHECKS PASSED`);
  srv.kill(); site.close();
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); }, 500);
})().catch(e => { console.error('FAILED:', e.message); console.error(log.slice(-3000)); try { srv.kill(); } catch {} site.close(); process.exit(1); });
