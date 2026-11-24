// node tests/test-catalog.js <app dir> — External catalog against fake sites served here (no network):
// a Madara-theme site, a site read with custom selectors and a site behind bot protection. Crawling (robots.txt,
// chapter lists, updates), the crawler process, the catalog (search, filters, "in library", missing chapters),
// merging the same work across sources (suggestions), covers, and the HTML/robots helpers.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const APP = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-cat-'));
const DATA = path.join(TMP, 'data'), MEDIA = path.join(TMP, 'media');
const { makeZip, png } = (() => { const src = fs.readFileSync(path.join(__dirname, 'make-comics.js'), 'utf8').replace(/const root = [\s\S]*$/, 'module.exports = { png, makeZip };'); const mod = { exports: {} }; new Function('module', 'require', '__dirname', src)(mod, require, __dirname); return mod.exports; })();
const book = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, makeZip([['p.png', png(10, 15, [90, 60, 30], 1)]])); };
// The library already has "Blue Moon" chapters 1 and 2
book(path.join(MEDIA, 'Blue Moon', 'Chapter 1.cbz')); book(path.join(MEDIA, 'Blue Moon', 'Chapter 2.cbz'));

/* ---------------- the fake sites ---------------- */
const SITE_PORT = 3998, SITE = `http://127.0.0.1:${SITE_PORT}`;
const hits = [];
let extraChapter = false;
const madaraWorks = {
  'blue-moon': { title: 'Blue Moon', alt: 'Luna Azul, 青い月', genres: ['Fantasy', 'Sci Fi'], chapters: [1, 2, 3, 4], ajax: false },
  'red-sun': { title: 'Red Sun', alt: '', genres: ['Action'], chapters: [1, 2], ajax: true },
  'green-field': { title: 'Green Field', alt: '', genres: ['Drama'], chapters: [1], ajax: false },
  'yellow-star': { title: 'Yellow Star', alt: '', genres: ['Comedy'], chapters: [1, 2], ajax: false, extra: true } // only in /wp-sitemap.xml, once extraSitemap is on
};
let extraSitemap = false, sitemapChange = false; // sitemapChange: the works sitemap lists a new chapter of Blue Moon
// Slow work pages (to see several read at once): requests in flight, and when each work page was asked for
let slowWorks = false, inFlight = 0, maxInFlight = 0; const workHits = [];
const listed = () => Object.keys(madaraWorks).filter(s => !madaraWorks[s].extra);
const madaraItem = slug => `<div class="page-item-detail"><div class="item-thumb"><a href="${SITE}/madara/manga/${slug}/"><img data-src="${SITE}/img/${slug}.png" src="x.gif"></a></div><div class="post-title"><h3><a href="${SITE}/madara/manga/${slug}/">${madaraWorks[slug].title}</a></h3></div></div>`;
function madaraWork(slug) {
  const w = madaraWorks[slug];
  const chs = w.chapters.concat(extraChapter && slug === 'blue-moon' ? [5] : []);
  // (Green Field's chapters are named the messy way: the number twice and the views inside the link)
  const name = n => (slug === 'green-field' ? `Ch. 00${n} - Ch. ${n} <i>1.2k views</i>` : `Chapter ${n}`);
  const list = `<ul class="main version-chap">${chs.slice().reverse().map(n => `<li class="wp-manga-chapter"><a href="${SITE}/madara/manga/${slug}/chapter-${n}/">${name(n)}</a><span class="chapter-release-date"><i>Jan ${n}, 2025</i></span>${slug === 'blue-moon' && n === 4 ? '<i class="fas fa-lock"></i>' : ''}</li>`).join('')}</ul>`; // (Blue Moon's chapter 4: locked)
  return `<html><head><meta property="og:title" content="${w.title}"></head><body><div class="post-title"><h1>${w.title}</h1></div>
    <div class="summary_image"><img data-src="${SITE}/img/${slug}.png"></div>
    <div class="post-content_item"><div class="summary-heading"><h5>Alternative</h5></div><div class="summary-content">${w.alt}</div></div>
    <div class="post-content_item"><div class="summary-heading"><h5>Author(s)</h5></div><div class="summary-content"><div class="author-content"><a href="#">Ana Author</a></div></div></div>
    <div class="genres-content">${w.genres.map(g => `<a href="#">${g}</a>`).join(', ')}</div>
    <div class="post-status"><div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div><div class="summary-content">OnGoing</div></div></div>
    <div class="summary__content"><p>About ${w.title}.</p></div>
    <div id="manga-chapters-holder" data-id="${slug}">${w.ajax ? '' : list}</div></body></html>`;
}
let m0;
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  hits.push(req.method + ' ' + u.pathname + u.search);
  const send = (status, body, type = 'text/html') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  if (u.pathname === '/robots.txt') return send(200, `User-agent: *\nDisallow: /custom/private/\nSitemap: ${SITE}/sitemap_index.xml\n`, 'text/plain');
  // Sitemaps: an index → the works sitemap (works and their chapters), and one that lists tags (skipped)
  if (u.pathname === '/sitemap_index.xml') return send(200, `<?xml version="1.0"?><sitemapindex><sitemap><loc>${SITE}/manga-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/tag-sitemap.xml</loc></sitemap></sitemapindex>`, 'application/xml');
  if (u.pathname === '/manga-sitemap.xml') return send(200, `<?xml version="1.0"?><urlset>${listed().map(s => `<url><loc>${SITE}/madara/manga/${s}/</loc><lastmod>2025-01-0${s.length % 9 + 1}</lastmod></url>` + madaraWorks[s].chapters.concat(sitemapChange && s === 'blue-moon' ? [9] : []).map(n => `<url><loc>${SITE}/madara/manga/${s}/chapter-${n}/</loc></url>`).join('')).join('')}</urlset>`, 'application/xml');
  // A sitemap robots.txt doesn't name (found by looking in the usual places)
  if (u.pathname === '/wp-sitemap.xml' && extraSitemap) return send(200, `<?xml version="1.0"?><urlset><url><loc>${SITE}/madara/manga/yellow-star/</loc></url></urlset>`, 'application/xml');
  if (u.pathname === '/tag-sitemap.xml') return send(200, `<urlset><url><loc>${SITE}/tag/action/</loc></url></urlset>`, 'application/xml');
  if (u.pathname === '/') return send(200, `<html><head><title>Fake Scans - Read manga</title><meta property="og:site_name" content="Fake Scans"><link rel="icon" href="/favicon.png"></head><body class="wp-manga-template">${madaraItem('blue-moon')}</body></html>`);
  if (u.pathname === '/favicon.png') return send(200, png(16, 16, [10, 200, 10], 4), 'image/png');
  // A slow copy of the list (the crawl lasts long enough to restart the server meanwhile); its works are the Madara ones
  if (u.pathname.startsWith('/slow/')) { setTimeout(() => send(200, u.pathname === '/slow/manga/' ? `<div>${listed().map(madaraItem).join('')}</div>` : '<div></div>'), 400); return; }
  if (u.pathname.startsWith('/img/')) return send(200, png(20, 30, [200, 20, 20], 3), 'image/png');
  // Madara: two list pages, then the last page repeats (as such sites do)
  if (u.pathname === '/madara/manga/' && u.searchParams.get('m_orderby')) return send(200, `<div class="c-page">${madaraItem('blue-moon')}${madaraItem('red-sun')}</div>`);
  if (/^\/madara\/manga\/page\/\d+\/$/.test(u.pathname)) return send(200, `<div class="c-page">${madaraItem('green-field')}</div>`);
  let m;
  if ((m = /^\/madara\/manga\/([\w-]+)\/ajax\/chapters\/$/.exec(u.pathname)) && req.method === 'POST') {
    const w = madaraWorks[m[1]];
    return send(200, `<ul>${w.chapters.map(n => `<li class="wp-manga-chapter"><a href="${SITE}/madara/manga/${m[1]}/chapter-${n}/">Chapter ${n}</a></li>`).join('')}</ul>`);
  }
  if ((m = /^\/madara\/manga\/([\w-]+)\/$/.exec(u.pathname)) && madaraWorks[m[1]]) {
    if (!slowWorks) return send(200, madaraWork(m[1]));
    workHits.push(Date.now()); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => { inFlight--; send(200, madaraWork(m[1])); }, 200); return; // (faster than the pause)
  }
  // Custom site: one list page; one work's page is not allowed by robots.txt
  if (u.pathname === '/custom/list') {
    if (u.searchParams.get('p') !== '1') return send(200, '<div class="list"></div>');
    return send(200, `<div class="list"><div class="item"><a href="/custom/w/blue-moon">Blue Moon</a></div><div class="item"><a href="/custom/private/secret">Secret</a></div></div>`);
  }
  if (u.pathname === '/custom/w/blue-moon') return send(200, `<h1 class="t">Blue Moon</h1><div class="genres"><span>Fantasy</span><span>Science Fiction</span></div><ol class="chs"><li><a href="/custom/w/blue-moon/6">Ep. 6</a></li><li><a href="/custom/w/blue-moon/5">Ep. 5</a></li></ol>`);
  // Chapters behind a tab that loads them; genres in a tab that's only hidden
  if (u.pathname === '/tabs/list') return send(200, '<div class="w"><a href="/tabs/work">Tabbed Work</a></div>');
  if (u.pathname === '/tabs-sitemap.xml') return send(200, `<?xml version="1.0"?><urlset><url><loc>${SITE}/tabs/work</loc><lastmod>2025-01-01</lastmod></url></urlset>`, 'application/xml');
  if (u.pathname === '/tabs/work') return send(200, '<h1 class="t">Tabbed Work</h1><nav><button class="info-tab">Info</button><button class="ch-tab" data-url="/tabs/work/chapters">Chapters</button></nav><div class="info" style="display:none"><span class="g">Mystery</span></div><div id="tab-body"></div>');
  if (u.pathname === '/tabs/work/chapters') return send(200, '<ul><li class="c"><a href="/tabs/c2">Chapter 2</a></li><li class="c"><a href="/tabs/c1">Chapter 1</a></li></ul>');
  // Titles with noise and version markers: one work in three versions
  const VER = { a: 'Night Sky (Official) - engsub', b: 'Night Sky [AI ANIMATION]', c: 'Night Sky (Raw) Uncensored - Version Site' };
  if (u.pathname === '/ver/list') return send(200, Object.keys(VER).map(k => `<div class="v"><a href="/ver/w/${k}">${VER[k]}</a></div>`).join(''));
  if ((m0 = /^\/ver\/w\/(\w)$/.exec(u.pathname)) && VER[m0[1]]) return send(200, `<h1>${VER[m0[1]]}</h1><ul><li class="c"><a href="/ver/w/${m0[1]}/1">Chapter 1</a></li></ul>`);
  // A chapter list that loads more as it's scrolled: 2 in the page, the rest from a JSON API with a cursor
  if (u.pathname === '/scroll/list') return send(200, '<div class="w"><a href="/scroll/series/blade">Blade</a></div>');
  if (u.pathname === '/scroll/series/blade') return send(200, '<h1>Blade</h1><div class="cl-scroll"><ul><li class="c"><a href="/scroll/series/blade/chapter-6">Chapter 6</a></li><li class="c"><a href="/scroll/series/blade/chapter-5">Chapter 5</a></li></ul></div>');
  if (u.pathname === '/api/scroll/blade/chapters') {
    const all = [6, 5, 4, 3, 2, 1], at = u.searchParams.get('cursor') ? all.indexOf(Number(Buffer.from(u.searchParams.get('cursor'), 'base64').toString())) : 0;
    const part = all.slice(at, at + 2);
    const next = all[at + 2] ? Buffer.from(String(all[at + 2])).toString('base64') : null;
    return send(200, JSON.stringify({ data: part.map(n => ({ number: n, title: 'Chapter ' + n, isLocked: n === 6, createdAt: '2025-01-0' + n + 'T00:00:00Z' })), nextCursor: next }), 'application/json');
  }
  // Sitemaps: an index with a works sitemap and a chapters sitemap (all 6 chapters; the page shows 2)
  if (u.pathname === '/scroll-sitemap.xml') return send(200, `<?xml version="1.0"?><sitemapindex><sitemap><loc>${SITE}/scroll-works-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/scroll-chapter-sitemap.xml</loc></sitemap></sitemapindex>`, 'application/xml');
  if (u.pathname === '/scroll-works-sitemap.xml') return send(200, `<?xml version="1.0"?><urlset><url><loc>${SITE}/scroll/series/blade</loc></url></urlset>`, 'application/xml');
  if (u.pathname === '/scroll-chapter-sitemap.xml') return send(200, `<?xml version="1.0"?><urlset>${[1, 2, 3, 4, 5, 6].map(n => `<url><loc>${SITE}/scroll/series/blade/chapter-${n}</loc><lastmod>2025-02-0${n}</lastmod></url>`).join('')}</urlset>`, 'application/xml');
  // A site behind bot protection
  if (u.pathname.startsWith('/guarded')) return send(403, '<html><title>Just a moment...</title><div id="cf-chl-widget"></div></html>');
  send(404, 'not found');
});

/* ---------------- Thoth ---------------- */
const PORT = 3997, BASE = `http://127.0.0.1:${PORT}`;
let srv, passed = 0, cookie, log = '';
async function stopServer() {
  // The server and its child (not the independent crawls). On Windows killing it is abrupt: changes of the
  // last moments (saved every 300 ms) would be lost, so wait a little first, as a real restart would.
  await wait(1000);
  let child = null;
  try { child = (await call('GET', '/api/processes')).data.server.pid; } catch {}
  await new Promise(r => { srv.removeAllListeners('exit'); srv.on('exit', r); srv.kill(); });
  if (child && child !== srv.pid) await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, 30000);
  log = '';
}
function start() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT, HOST: '127.0.0.1', THOTH_DATA_DIR: DATA, THOTH_CATALOG_ALLOW_LOCAL: '1', THOTH_WORKER_IDLE_MS: '1500', THOTH_NO_WARM: '1' } });
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
const crawled = async id => until(async () => { const s = (await call('GET', '/api/catalog/sources')).data.sources.find(x => x.id === id); return s && !s.job && (s.lastCrawlAt || s.lastError) && s; }, 60000);

(async () => {
  // ---- helpers (in process) ----
  const { parse } = require(path.join(APP, 'library', 'catalog', 'html.js'));
  const d = parse('<ul class="a b"><li><a href="/x" title="T">One &amp; Two</a></li><li class="z"><a href=/y>Three</a></li></ul><p>x<p>y');
  ok(d.select('ul.a > li a').length === 2 && d.first('li.z a').attr('href') === '/y' && d.first('a[title=T]').text() === 'One & Two' && d.select('p').length === 2,
    'HTML reader: selectors (classes, child, attributes), entities, unclosed tags');
  const { parseRobots, robotsAllows } = require(path.join(APP, 'library', 'catalog', 'fetcher.js'));
  const rules = parseRobots('User-agent: *\nDisallow: /*/search\nDisallow: /*/*/*/list?title_no=*&page=1\nAllow: /wp-admin/admin-ajax.php\nDisallow: /wp-admin/');
  const can = p => robotsAllows(rules, 'https://s.example' + p);
  ok(can('/en/genres') && !can('/en/search?q=a') && can('/en/a/b/list?title_no=1') && !can('/en/a/b/list?title_no=1&page=1') && can('/en/a/b/list?title_no=1&page=2') && can('/wp-admin/admin-ajax.php') && !can('/wp-admin/x'),
    'robots.txt: wildcards, prefixes, the longest rule wins');
  {
    const { createFetcher } = require(path.join(APP, 'library', 'catalog', 'fetcher.js'));
    let delay = null, now = 0, most = 0; const starts = [];
    const srv2 = http.createServer((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(delay == null ? 'User-agent: *\nDisallow:' : `User-agent: *\nCrawl-delay: ${delay}`); }
      starts.push(Date.now()); now++; most = Math.max(most, now);
      setTimeout(() => { now--; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>ok</p>'); }, 400); // (faster than the 600 ms pause)
    });
    await new Promise(r => srv2.listen(3982, '127.0.0.1', r));
    const f1 = createFetcher({ gapMs: 600, parallel: 4, allowLocal: true });
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(i => f1.get(`http://127.0.0.1:3982/p${i}`)));
    const took = Date.now() - t0;
    ok(most >= 3 && most <= 4 && took < 2600 && f1.stats.active === 0 && f1.stats.waiting === 0, `fetcher: up to 4 requests to a site at once, each lane pausing between its requests (${most} at once; 8 pages in ${took} ms; one at a time, one per pause, would take ≥ 4600 ms)`);
    delay = 0.4; now = 0; most = 0; starts.length = 0;
    const f2 = createFetcher({ gapMs: 200, parallel: 4, allowLocal: true });
    await Promise.all([1, 2, 3].map(i => f2.get(`http://127.0.0.1:3982/q${i}`)));
    const apart = starts.slice(1).map((t, i) => t - starts[i]);
    ok(most === 1 && apart.every(g => g >= 380) && f2.limits().crawlDelay === 0.4, `robots.txt Crawl-delay: one request at a time, that far apart (${apart.join(', ')} ms)`);
    srv2.close();
  }

  await new Promise(r => site.listen(SITE_PORT, '127.0.0.1', r));
  await start();
  cookie = (await call('POST', '/api/setup', { username: 'admin', password: 'adminpass1' })).cookie;
  const L = (await call('POST', '/api/libraries', { name: 'Comics', root: MEDIA, metadata: { autoFetch: false } })).data.library.id;
  await until(async () => { const l = (await call('GET', '/api/libraries')).data.libraries[0]; return !l.scanning && l.lastScan; });
  await call('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  const bob = (await call('POST', '/api/login', { username: 'bob', password: 'bobpass12' }, null)).cookie;

  // ---- sources ----
  ok((await call('POST', '/api/catalog/sources', { name: 'Bad', type: 'madara', baseUrl: 'ftp://x' })).status === 400, 'a source needs a web address');
  ok((await call('POST', '/api/catalog/sources', { name: 'X', type: 'madara', baseUrl: SITE + '/madara' }, bob)).status === 403, 'only admins add sources');
  const madara = (await call('POST', '/api/catalog/sources', { name: 'Madara site', type: 'madara', baseUrl: SITE + '/madara', languages: 'en', gapMs: 200 })).data.source;
  const custom = (await call('POST', '/api/catalog/sources', { name: 'Custom site', type: 'custom', baseUrl: SITE, gapMs: 200,
    selectors: { listUrl: '/custom/list?p={page}', item: '.list .item', workTitle: 'h1.t', genres: '.genres span', chapter: 'ol.chs li', chapterLink: 'a@href' } })).data.source;
  const guarded = (await call('POST', '/api/catalog/sources', { name: 'Guarded', type: 'madara', baseUrl: SITE + '/guarded', gapMs: 200 })).data.source;
  const test = (await call('POST', '/api/catalog/sources/test', madara)).data.test;
  ok(test.firstPageCount === 2 && test.work && test.work.title === 'Blue Moon' && test.work.chapterCount === 4, `“Test” shows what the settings find (${test.firstPageCount} works, first: ${test.work && test.work.title}, ${test.work && test.work.chapterCount} chapters)`);

  // ---- crawling ----
  await call('POST', `/api/catalog/sources/${madara.id}/crawl`, { mode: 'full' });
  const running = await until(async () => { const p = (await call('GET', '/api/processes')).data; return p.catalog.crawls.length && p.catalog.crawls[0].pid && p; });
  ok(running.catalog.crawls[0].pid !== running.server.pid, `each crawl is its own process (pid ${running.catalog.crawls[0].pid})`);
  let s1 = await crawled(madara.id);
  ok(s1.works === 3 && s1.lastStats.listed === 3 && s1.lastStats.errors === 0 && s1.lastStats.chapters === 7, `Madara site: every list page read, 3 works, 7 chapters (${JSON.stringify(s1.lastStats)})`);
  ok(hits.includes('GET /robots.txt') && hits.some(h => h.startsWith('POST /madara/manga/red-sun/ajax/chapters/')), 'robots.txt read first; chapters loaded the theme’s other way when the page has none');
  const greenKey = (await call('GET', '/api/catalog?q=green')).data.items[0].key;
  const greenCh = (await call('GET', `/api/catalog/work?key=${encodeURIComponent(greenKey)}`)).data.work.sources[0].chapterList[0];
  ok(greenCh.t === 'Chapter 1' && greenCh.n === '1' && /views/.test(greenCh.raw || ''), `chapter names standardized like the renamer's ("${greenCh.raw}" → "${greenCh.t}")`);
  const blueSrc = (await call('GET', `/api/catalog/work?key=${encodeURIComponent((await call('GET', '/api/catalog?q=blue')).data.items.find(i => i.sources[0].sourceId === madara.id).key)}`)).data.work.sources[0];
  ok(blueSrc.chapterList.find(c => c.n === '4').pr === true && blueSrc.chapterList.filter(c => c.pr).length === 1 && blueSrc.premium === 1 && s1.lastStats.premium === 1, 'a locked (premium) chapter is marked as not available now');
  // The crawl as a task, with its own log file
  const crawlTask = await until(async () => (await call('GET', '/api/tasks')).data.recent.find(x => x.kind === 'crawl' && x.title.includes('Madara site')));
  ok(crawlTask.status === 'done' && /listed/.test(crawlTask.summary), `the crawl is listed as a task (${crawlTask.title}: ${crawlTask.summary})`);
  const logs = (await call('GET', '/api/logs?kind=crawl')).data.logs;
  const logText = (await call('GET', `/api/logs/${crawlTask.log}`)).data.lines.join('\n');
  ok(logs.some(l => l.name === crawlTask.log) && /work\(s\) listed/.test(logText) && /works read/.test(logText), 'its log file is on the Logs page, written by the crawler (works listed, works read)');
  const dl = await fetch(`${BASE}/api/logs/${crawlTask.log}?download=1`, { headers: { Cookie: cookie } });
  ok(dl.status === 200 && /attachment/.test(dl.headers.get('content-disposition') || '') && (await dl.text()).startsWith('# Crawl of'), 'a log can be downloaded');
  ok((await call('GET', '/api/logs/..%2Fconfig.json')).status === 404 && (await call('GET', '/api/logs', null, bob)).status === 403, 'only log files can be read, and only by administrators');
  // ---- site files (robots.txt, sitemaps) and pages for the wizard's picker ----
  const sf = (await call('GET', `/api/catalog/sources/${madara.id}/files`)).data;
  ok(sf.robots === SITE + '/robots.txt', 'a source’s site files: its robots.txt address');
  const rb = (await call('GET', `/api/catalog/sources/${madara.id}/file?url=${encodeURIComponent(SITE + '/robots.txt')}`)).data.file;
  ok(rb.found && /Disallow: \/custom\/private\//.test(rb.text) && rb.sitemaps.some(x => x.loc === SITE + '/sitemap_index.xml') && rb.hash, 'robots.txt read now: its text and the sitemaps it names');
  const smx = (await call('GET', `/api/catalog/sources/${madara.id}/file?url=${encodeURIComponent(SITE + '/sitemap_index.xml')}`)).data.file;
  const smw = (await call('GET', `/api/catalog/sources/${madara.id}/file?url=${encodeURIComponent(SITE + '/manga-sitemap.xml')}`)).data.file;
  ok(smx.sitemaps.length === 2 && smw.urlCount >= 10 && smw.urls[0].loc.startsWith(SITE + '/madara/manga/'), `a sitemap read now: the sitemaps it lists (${smx.sitemaps.length}) and its addresses (${smw.urlCount})`);
  ok((await call('GET', `/api/catalog/sources/${madara.id}/file?url=${encodeURIComponent('https://example.org/sitemap.xml')}`)).status === 400 && (await call('GET', `/api/catalog/sources/${madara.id}/files`, null, bob)).status === 403,
    'only the source’s own site, and only for administrators');
  const live = (await call('GET', `/api/catalog/preview?url=${encodeURIComponent(SITE + '/madara/manga/blue-moon/')}`)).data.page;
  ok(live && /Blue Moon/.test(live.source) && !live.html && live.url === SITE + '/madara/manga/blue-moon/', 'a page for the picker: as the site sends it (the wizard shows it with its images and styles)');
  const pv = (await call('GET', `/api/catalog/preview?url=${encodeURIComponent(SITE + '/madara/manga/blue-moon/')}&inert=1`)).data.page;
  ok(pv && /Blue Moon/.test(pv.html) && !/<script/i.test(pv.html) && /Content-Security-Policy/.test(pv.html) && /data-src="http:\/\/127\.0\.0\.1:3998\/img\/blue-moon\.png"/.test(pv.html) && !/ src="http:/.test(pv.html),
    'a page for the picker is made inert: no scripts, nothing the browser would load from the site (images become placeholders)');
  ok((await call('GET', `/api/catalog/preview?url=${encodeURIComponent('ftp://x')}`)).status === 400, 'the preview takes only web addresses');
  // ---- clicks to make before collecting ----
  const tabbed = { name: 'Tabbed', type: 'custom', baseUrl: SITE, includeChapters: true, selectors: { listUrl: '/tabs/list', item: 'div.w', workTitle: 'h1.t', genres: 'span.g', chapter: 'li.c' } };
  const noClick = (await call('POST', '/api/catalog/sources/test', tabbed)).data.test;
  const withClick = (await call('POST', '/api/catalog/sources/test', Object.assign({}, tabbed, { actions: { work: [{ selector: 'button.info-tab', mode: 'add' }], chapters: [{ selector: 'button.ch-tab', mode: 'add' }] } }))).data.test;
  ok(noClick.work.chapterCount === 0 && withClick.work.chapterCount === 2 && withClick.work.genres.join() === 'Mystery',
    `a click before collecting: the chapters behind a tab are read (${noClick.work.chapterCount} → ${withClick.work.chapterCount}); a tab that only hides content needs nothing loaded`);
  const pvClick = (await call('GET', `/api/catalog/preview?url=${encodeURIComponent(SITE + '/tabs/work')}&actions=${encodeURIComponent(JSON.stringify([{ selector: 'button.info-tab', mode: 'add' }, { selector: 'button.ch-tab', mode: 'open' }, { selector: '#nope', mode: 'add' }]))}`)).data.page;
  ok(pvClick.actions.map(a => a.result).join() === 'inPage,opened,notFound' && pvClick.url === SITE + '/tabs/work/chapters' && /Chapter 2/.test(pvClick.source),
    `the wizard's preview makes the clicks the same way and says what each did (${pvClick.actions.map(a => a.result).join(', ')})`);
  const saved = (await call('POST', '/api/catalog/sources', Object.assign({}, tabbed, { actions: { chapters: [{ selector: 'button.ch-tab', mode: 'sideways' }, { selector: '' }] } }))).data.source;
  ok(saved.actions.chapters.length === 1 && saved.actions.chapters[0].mode === 'add' && !saved.actions.work, 'a source keeps its clicks (cleaned: empty ones dropped, unknown modes made "add")');
  await call('DELETE', `/api/catalog/sources/${saved.id}`);
  // The clicks in real crawls, also when they're added after a first crawl and the next one is an update
  const tsrc = (await call('POST', '/api/catalog/sources', Object.assign({}, tabbed, { listing: 'sitemap', sitemaps: [SITE + '/tabs-sitemap.xml'], workPattern: '/tabs/*/' }))).data.source;
  await call('POST', `/api/catalog/sources/${tsrc.id}/crawl`, { mode: 'full' });
  let tc = await crawled(tsrc.id);
  const chOf = async () => (await call('GET', `/api/catalog/work?key=${encodeURIComponent((await call('GET', `/api/catalog?source=${tsrc.id}`)).data.items[0].key)}`)).data.work.sources[0].chapterList.length;
  ok(tc.works === 1 && await chOf() === 0, 'without the click, a crawl finds no chapters on that site');
  await call('PATCH', `/api/catalog/sources/${tsrc.id}`, { actions: { chapters: [{ selector: 'button.ch-tab', mode: 'add' }] } });
  await call('POST', `/api/catalog/sources/${tsrc.id}/crawl`, { mode: 'update' });
  tc = await crawled(tsrc.id);
  ok(await chOf() === 2 && tc.lastStats.read === 1, `after adding the click, the next update reads the work again with it (${await chOf()} chapters; its sitemap hadn't changed)`);
  await call('DELETE', `/api/catalog/sources/${tsrc.id}`);
  // ---- scrolling to load more: the requests the page makes, followed from the first page on ----
  const scrolled = { name: 'Scroller', type: 'custom', baseUrl: SITE, includeChapters: true, selectors: { listUrl: '/scroll/list', item: 'div.w', workTitle: 'h1', chapter: 'li.c' },
    actions: { chapters: [{ kind: 'scroll', selector: 'div.cl-scroll', loads: [SITE + '/api/scroll/blade/chapters?limit=2&sort=desc&cursor=' + Buffer.from('4').toString('base64')] }] } };
  const noScroll = (await call('POST', '/api/catalog/sources/test', Object.assign({}, scrolled, { actions: {} }))).data.test;
  const withScroll = (await call('POST', '/api/catalog/sources/test', scrolled)).data.test;
  ok(noScroll.work.chapterCount === 2 && withScroll.work.chapterCount === 6 && withScroll.work.firstChapters.some(c => String(c.n) === '4'),
    `scrolling a list to load more: the page's requests are followed from the first page (${noScroll.work.chapterCount} → ${withScroll.work.chapterCount} chapters)`);
  const ss = (await call('POST', '/api/catalog/sources', scrolled)).data.source;
  ok(ss.actions.chapters[0].kind === 'scroll' && ss.actions.chapters[0].loads.length === 1, 'a source keeps its scrolls (and the request they make)');
  await call('POST', `/api/catalog/sources/${ss.id}/crawl`, { mode: 'full' });
  await crawled(ss.id);
  const blade = (await call('GET', `/api/catalog/work?key=${encodeURIComponent((await call('GET', `/api/catalog?source=${ss.id}`)).data.items[0].key)}`)).data.work.sources[0].chapterList;
  ok(blade.length === 6 && blade.find(c => c.n === '6').pr === true && blade.find(c => c.n === '1').u === SITE + '/scroll/series/blade/chapter-1',
    'a crawl reads them too: chapters from the answers, linked like the page’s own links, locked ones marked');
  await call('DELETE', `/api/catalog/sources/${ss.id}`);
  // ---- chapter sitemaps: every chapter, also the ones the page doesn't show ----
  const smsrc = (await call('POST', '/api/catalog/sources', { name: 'Chapter sitemaps', type: 'custom', baseUrl: SITE, includeChapters: true, listing: 'sitemap', sitemaps: [SITE + '/scroll-sitemap.xml'], workPattern: '/scroll/series/*', selectors: { workTitle: 'h1', chapter: 'li.c' } })).data.source;
  await call('POST', `/api/catalog/sources/${smsrc.id}/crawl`, { mode: 'full' });
  const smDone = await crawled(smsrc.id);
  const smCh = (await call('GET', `/api/catalog/work?key=${encodeURIComponent((await call('GET', `/api/catalog?source=${smsrc.id}`)).data.items[0].key)}`)).data.work.sources[0].chapterList;
  ok(smCh.length === 6 && smCh.find(c => c.n === '1').t === 'Chapter 1' && smCh.find(c => c.n === '1').d === '2025-02-01' && smDone.lastStats.sitemaps.chapters === 6,
    `the chapters sitemap gives every chapter, also those the work's page doesn't show (page 2 → ${smCh.length}; ${smDone.lastStats.sitemaps.chapters} chapter addresses)`);
  await call('DELETE', `/api/catalog/sources/${smsrc.id}`);
  // ---- titles: noise taken out, versions recognized and grouped like a library's ----
  const vsrc = (await call('POST', '/api/catalog/sources', { name: 'Version Site', type: 'custom', baseUrl: SITE, includeChapters: true, selectors: { listUrl: '/ver/list', item: 'div.v', workTitle: 'h1', chapter: 'li.c' } })).data.source;
  await call('POST', `/api/catalog/sources/${vsrc.id}/crawl`, { mode: 'full' });
  await crawled(vsrc.id);
  const vlist = (await call('GET', `/api/catalog?source=${vsrc.id}`)).data;
  const night = vlist.items[0];
  ok(vlist.total === 1 && night.title === 'Night Sky' && night.versions.length === 3 && night.versions.map(v => v.edition).join() === 'base,animated,raw+uncensored',
    `one work in three versions, titles without their noise ("${night.title}": ${night.versions.map(v => v.edition).join(', ')})`);
  const anim = (await call('GET', `/api/catalog/work?key=${encodeURIComponent(night.versions[1].key)}`)).data.work;
  ok(anim.title === 'Night Sky' && anim.editions.join() === 'animated' && anim.versions.length === 3 && anim.sources[0].chapterList.length === 1, 'a version’s page: its own chapters, the work’s versions as tabs');
  await call('DELETE', `/api/catalog/sources/${vsrc.id}`);
  // Several works at once (the source's setting) with as many requests to the site in progress, even when its
  // pages answer faster than the pause (each lane pauses between its own requests; starts staggered)
  await call('PATCH', `/api/catalog/sources/${madara.id}`, { concurrency: 3 });
  slowWorks = true;
  await call('POST', `/api/catalog/sources/${madara.id}/crawl`, { mode: 'full' });
  s1 = await crawled(madara.id);
  slowWorks = false;
  const gaps = workHits.slice(1).map((t, i) => t - workHits[i]);
  ok(s1.lastStats.maxActiveRequests >= 2, `the crawl says how many requests it had in progress at once (up to ${s1.lastStats.maxActiveRequests})`);
  ok(s1.works === 3 && s1.lastStats.errors === 0 && s1.lastStats.concurrency === 3 && maxInFlight >= 2 && maxInFlight <= 3 && gaps.every(g => g >= 100),
    `several requests to the site in progress at once although its pages answer faster than the pause (${maxInFlight} in flight, at most ${s1.lastStats.concurrency}; starts ${gaps.join(', ')} ms apart)`);
  await call('POST', `/api/catalog/sources/${custom.id}/crawl`, { mode: 'full' });
  const s2 = await crawled(custom.id);
  ok(s2.works === 2 && s2.lastStats.errors === 1 && !hits.some(h => h.includes('/custom/private/')), 'custom selectors: works found; a page robots.txt forbids is never fetched (counted as an error)');
  await call('POST', `/api/catalog/sources/${guarded.id}/crawl`, { mode: 'full' });
  const s3 = await crawled(guarded.id);
  ok(/blocked/.test(s3.lastError || '') && s3.works === 0, 'a site behind bot protection is reported as blocked (not worked around)');
  const crawlPid = running.catalog.crawls[0].pid;
  await until(async () => { try { process.kill(crawlPid, 0); return false; } catch { return true; } }, 15000);
  ok(!(await call('GET', '/api/processes')).data.catalog.crawls.length, 'a finished crawl’s process is gone');

  // ---- detecting a source's settings from robots.txt and sitemaps ----
  const found = (await call('POST', '/api/catalog/sources/detect', { url: SITE + '/anything' })).data.detect;
  ok(found.settings.type === 'madara' && found.settings.name === 'Fake Scans' && found.settings.listing === 'sitemap' && found.settings.sitemaps[0] === SITE + '/sitemap_index.xml',
    `Detect: the theme, the site’s name and the sitemaps robots.txt names (${found.settings.type}, ${found.settings.name})`);
  ok(found.settings.workPattern === '/madara/*/*/' && found.settings.chapterPattern === '/madara/*/*/*/' && found.found.works === 3 && found.found.sampleWork && found.found.sampleWork.chapterLinks >= 1 && /favicon\.png$/.test(found.settings.iconUrl),
    `…the address patterns of works and chapters from the sitemaps (${found.settings.workPattern}, ${found.settings.chapterPattern}), a sample work and the site’s icon`);
  const viaSitemap = (await call('POST', '/api/catalog/sources', Object.assign({}, found.settings, { name: 'Via sitemaps', gapMs: 200 }))).data.source;
  hits.length = 0;
  await call('POST', `/api/catalog/sources/${viaSitemap.id}/crawl`, { mode: 'full' });
  const sv = await crawled(viaSitemap.id);
  ok(sv.works === 3 && sv.lastStats.chapters === 7 && hits.includes('GET /manga-sitemap.xml') && !hits.includes('GET /tag-sitemap.xml') && !hits.some(h => h.includes('m_orderby')),
    'a source set up by Detect lists its works from the sitemaps (the tags sitemap skipped, no list pages)');
  // The same works on two sources, with the same title and author: merged without asking
  // (the server notices a finished crawl within 2 seconds, then merges)
  const merged = await until(async () => { const gs = (await call('GET', '/api/catalog/merged')).data.groups; return gs.filter(gr => gr.auto).length >= 3 && gs; }, 15000).catch(async () => (await call('GET', '/api/catalog/merged')).data.groups);
  const autoBlue = merged.find(gr => gr.auto && gr.works.some(w => w.title === 'Blue Moon' && w.sourceId === madara.id) && gr.works.some(w => w.sourceId === viaSitemap.id));
  ok(autoBlue && autoBlue.auto.reason === 'titleAuthor' && merged.filter(gr => gr.auto).length === 3, `certain matches merged automatically (${merged.filter(gr => gr.auto).length} groups; Blue Moon: ${autoBlue && autoBlue.auto.reason})`);
  const viaKey = autoBlue.works.find(w => w.sourceId === viaSitemap.id).key;
  const split = (await call('POST', `/api/catalog/merge/${autoBlue.id}/split`, { key: viaKey })).data;
  ok(split.groupId === null && (await call('POST', '/api/catalog/merge/auto')).data.merged === 0 && !(await call('GET', '/api/catalog/merged')).data.groups.some(gr => gr.works.some(w => w.key === viaKey)),
    'a merged work can be split off, and isn’t merged automatically again');
  ok((await call('GET', `/api/catalog/merged?source=${custom.id}`)).data.groups.length === 0 && (await call('GET', `/api/catalog/merged?source=${madara.id}`)).data.groups.length === 2, 'merged works can be filtered by source');
  const icon = await fetch(`${BASE}/api/catalog/sources/${viaSitemap.id}/icon`, { headers: { Cookie: cookie } });
  ok(icon.status === 200 && icon.headers.get('content-type') === 'image/png', 'the source’s icon is the site’s own (served through the server)');
  await call('DELETE', `/api/catalog/sources/${viaSitemap.id}`);

  // ---- a source from just its name and address: everything detected, again at every crawl ----
  const autoSrc = (await call('POST', '/api/catalog/sources', { name: 'Just a name', baseUrl: SITE + '/' })).data.source;
  ok(autoSrc.autoDetect === true && autoSrc.type === 'madara' && autoSrc.listing === 'sitemap' && autoSrc.workPattern === '/madara/*/*/' && autoSrc.sitemaps.includes(SITE + '/sitemap_index.xml') && autoSrc.detected && autoSrc.detected.found.sitemaps.length >= 1,
    `only a name and an address: the rest detected (${autoSrc.type}, ${autoSrc.sitemaps.length} sitemap(s), works at ${autoSrc.workPattern})`);
  extraSitemap = true; // the site adds a sitemap robots.txt doesn't name
  await call('POST', `/api/catalog/sources/${autoSrc.id}/crawl`, { mode: 'full' });
  const autoDone = await crawled(autoSrc.id);
  const autoNow = (await call('GET', '/api/catalog/sources')).data.sources.find(x => x.id === autoSrc.id);
  ok(autoDone.works === 4 && autoNow.sitemaps.includes(SITE + '/wp-sitemap.xml'), `the crawl looked for every sitemap again: the new one was found and read (${autoDone.works} works; sitemaps: ${autoNow.sitemaps.map(s => s.replace(SITE, '')).join(', ')})`);
  // Updates read only what changed in the sitemaps (their content hashes are kept)
  await call('POST', `/api/catalog/sources/${autoSrc.id}/crawl`, { mode: 'update' });
  const same = await crawled(autoSrc.id);
  ok(same.lastStats.read === 0 && same.lastStats.sitemaps && same.lastStats.sitemaps.unchanged >= 1, `an update with no sitemap changes reads no work (${JSON.stringify(same.lastStats.sitemaps)})`);
  sitemapChange = true; hits.length = 0;
  await call('POST', `/api/catalog/sources/${autoSrc.id}/crawl`, { mode: 'update' });
  const changed = await crawled(autoSrc.id);
  ok(changed.lastStats.read === 1 && hits.includes('GET /madara/manga/blue-moon/') && !hits.includes('GET /madara/manga/red-sun/'), `a changed sitemap: only the work whose entries changed is read (${changed.lastStats.read} read)`);
  sitemapChange = false;
  ok((await call('PATCH', `/api/catalog/sources/${autoSrc.id}`, { autoDetect: false })).data.source.autoDetect === false, 'automatic settings can be turned off (then set by hand)');
  extraSitemap = false;
  await call('DELETE', `/api/catalog/sources/${autoSrc.id}`);

  // ---- a crawl keeps going while the server restarts ----
  const slow = (await call('POST', '/api/catalog/sources', { name: 'Slow', type: 'madara', baseUrl: SITE + '/slow', listing: 'pages', gapMs: 600 })).data.source;
  await call('POST', `/api/catalog/sources/${slow.id}/crawl`, { mode: 'full' });
  const sp = await until(async () => { const s = (await call('GET', '/api/catalog/sources')).data.sources.find(x => x.id === slow.id); return s.job && s.job.pid && s; });
  ok((await call('DELETE', `/api/catalog/sources/${slow.id}`)).status === 409, 'a source being crawled can’t be removed (stop it first)');
  await stopServer();
  ok((() => { try { process.kill(sp.job.pid, 0); return true; } catch { return false; } })(), `the server stopped; the crawl process (pid ${sp.job.pid}) is still running`);
  await start();
  const afterRestart = await until(async () => { const s = (await call('GET', '/api/catalog/sources')).data.sources.find(x => x.id === slow.id); return s && !s.job && s.lastCrawlAt && s; }, 60000);
  ok(afterRestart.works === 3 && afterRestart.lastStats.read === 3 && !afterRestart.lastError, 'after the restart the server sees the crawl it didn’t start finish completely');
  await call('DELETE', `/api/catalog/sources/${slow.id}`);

  // ---- the catalog ----
  ok((await call('GET', '/api/catalog', null, bob)).status === 403 && (await call('GET', '/api/catalog/facets', null, bob)).status === 403, 'only administrators see the catalog');
  let cat = (await call('GET', '/api/catalog?limit=50')).data;
  ok(cat.total === 5 && cat.items.some(it => it.title === 'Blue Moon') && cat.items.find(it => it.title === 'Secret').chapters === 0, `the catalog lists every work found (a work whose page robots.txt forbids is listed, without details) (${cat.total} works: ${cat.items.map(i => i.title).join(', ')})`);
  const blue = cat.items.find(it => it.title === 'Blue Moon' && it.sources[0].sourceId === madara.id);
  ok(blue.inLibrary && blue.inLibrary.title === 'Blue Moon' && cat.items.filter(it => it.inLibrary).length === 2, 'works the library already has are marked (by title, on every source)');
  ok(blue.genres.join('|') === 'Fantasy|Sci-Fi' && blue.chapters === 4 && blue.lastChapter === '4', 'metadata read (genres with one name each, chapters, last chapter)');
  ok((await call('GET', '/api/catalog?inLibrary=no')).data.items.every(it => !it.inLibrary) && (await call('GET', `/api/catalog?source=${custom.id}`)).data.total === 2 && (await call('GET', '/api/catalog?q=luna')).data.items[0].title === 'Blue Moon',
    'filters: not in library, by source, search (alternative titles too)');
  let det = (await call('GET', `/api/catalog/work?key=${encodeURIComponent(blue.key)}`)).data.work;
  ok(det.sources[0].chapterList.length === 4 && det.sources[0].chapterList[0].u.endsWith('/chapter-4/') && det.missing.have === 2 && det.missing.chapters.map(c => c.n).join() === '3,4',
    'a work’s page: chapter list with links; the chapters the library lacks (3, 4)');
  const cover = await fetch(`${BASE}/api/catalog/cover?key=${encodeURIComponent(blue.key)}`, { headers: { Cookie: cookie } });
  ok(cover.status === 200 && cover.headers.get('content-type') === 'image/png' && fs.readdirSync(path.join(DATA, 'cache', 'catalog-covers')).length >= 1, 'covers come through the server (cached), never straight from the site to the browser');

  // ---- merging the same work found on two sites ----
  const sug = (await call('GET', '/api/catalog/merge-suggestions')).data;
  const g = sug.groups.find(x => x.works.some(w => w.title === 'Blue Moon'));
  ok(g && g.works.length === 2 && g.reason === 'title' && g.inLibrary, 'suggested: “Blue Moon” on both sites (and the library has it)');
  ok(g.works.every(w => 'cover' in w && 'authors' in w) && (await call('GET', `/api/catalog/merge-suggestions?source=${custom.id}`)).data.groups.some(x => x.key === g.key) && !(await call('GET', `/api/catalog/merge-suggestions?source=${guarded.id}`)).data.groups.length,
    'suggestions carry what helps to compare (cover, authors) and can be filtered by source');
  const mg = (await call('POST', '/api/catalog/merge', { keys: g.works.map(w => w.key), primary: blue.key })).data;
  cat = (await call('GET', '/api/catalog?q=blue%20moon')).data;
  ok(cat.total === 1 && cat.items[0].sources.length === 2 && cat.items[0].chapters === 4, 'merged: one catalog entry with both sources');
  det = (await call('GET', `/api/catalog/work?key=${encodeURIComponent(cat.items[0].key)}`)).data.work;
  ok(det.sources.length === 2 && det.missing.chapters.map(c => c.n).join() === '3,4,5,6', 'its chapters come from both sites (missing: 3–6)');
  ok(det.allChapters.length === 6 && det.allChapters[0].n === '6' && det.allChapters.every(c => c.links.length === 1 && c.links[0].u) && det.allChapters.find(c => c.n === '4').links[0].name === 'Madara site',
    `one chapter list for every source, each with its source's link (${det.allChapters.map(c => c.n + ':' + c.links.map(l => l.name).join('+')).join(' ')})`);
  ok(!(await call('GET', '/api/catalog/merge-suggestions')).data.groups.some(x => x.key === g.key), 'a merged group is no longer suggested');
  await call('DELETE', `/api/catalog/merge/${mg.groupId}`);
  ok((await call('GET', '/api/catalog?q=blue%20moon')).data.total === 2, 'separating them again');

  // ---- updating ----
  extraChapter = true;
  hits.length = 0;
  await call('POST', `/api/catalog/sources/${madara.id}/crawl`, { mode: 'update' });
  s1 = await crawled(madara.id);
  det = (await call('GET', `/api/catalog/work?key=${encodeURIComponent(blue.key)}`)).data.work;
  ok(det.sources[0].chapterList.length === 5 && det.sources[0].chapterList[0].n === '5' && hits.some(h => h.includes('m_orderby=latest')), 'an update reads the recently updated works first and adds the new chapter');

  // ---- removing a source ----
  await call('DELETE', `/api/catalog/sources/${custom.id}`);
  ok((await call('GET', '/api/catalog')).data.total === 3 && !fs.existsSync(path.join(DATA, 'catalog', custom.id)), 'removing a source removes its works');

  console.log(`\nALL ${passed} CATALOG CHECKS PASSED`);
  srv.kill(); site.close();
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message, '\n' + log.slice(-3000)); try { srv.kill(); } catch {} site.close(); process.exit(1); });
