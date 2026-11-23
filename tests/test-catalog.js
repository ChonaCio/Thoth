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
let extraSitemap = false;
// Slow work pages (to see several read at once): requests in flight, and when each work page was asked for
let slowWorks = false, inFlight = 0, maxInFlight = 0; const workHits = [];
const listed = () => Object.keys(madaraWorks).filter(s => !madaraWorks[s].extra);
const madaraItem = slug => `<div class="page-item-detail"><div class="item-thumb"><a href="${SITE}/madara/manga/${slug}/"><img data-src="${SITE}/img/${slug}.png" src="x.gif"></a></div><div class="post-title"><h3><a href="${SITE}/madara/manga/${slug}/">${madaraWorks[slug].title}</a></h3></div></div>`;
function madaraWork(slug) {
  const w = madaraWorks[slug];
  const chs = w.chapters.concat(extraChapter && slug === 'blue-moon' ? [5] : []);
  const list = `<ul class="main version-chap">${chs.slice().reverse().map(n => `<li class="wp-manga-chapter"><a href="${SITE}/madara/manga/${slug}/chapter-${n}/">Chapter ${n}</a><span class="chapter-release-date"><i>Jan ${n}, 2025</i></span></li>`).join('')}</ul>`;
  return `<html><head><meta property="og:title" content="${w.title}"></head><body><div class="post-title"><h1>${w.title}</h1></div>
    <div class="summary_image"><img data-src="${SITE}/img/${slug}.png"></div>
    <div class="post-content_item"><div class="summary-heading"><h5>Alternative</h5></div><div class="summary-content">${w.alt}</div></div>
    <div class="post-content_item"><div class="summary-heading"><h5>Author(s)</h5></div><div class="summary-content"><div class="author-content"><a href="#">Ana Author</a></div></div></div>
    <div class="genres-content">${w.genres.map(g => `<a href="#">${g}</a>`).join(', ')}</div>
    <div class="post-status"><div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div><div class="summary-content">OnGoing</div></div></div>
    <div class="summary__content"><p>About ${w.title}.</p></div>
    <div id="manga-chapters-holder" data-id="${slug}">${w.ajax ? '' : list}</div></body></html>`;
}
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  hits.push(req.method + ' ' + u.pathname + u.search);
  const send = (status, body, type = 'text/html') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  if (u.pathname === '/robots.txt') return send(200, `User-agent: *\nDisallow: /custom/private/\nSitemap: ${SITE}/sitemap_index.xml\n`, 'text/plain');
  // Sitemaps: an index → the works sitemap (works and their chapters), and one that lists tags (skipped)
  if (u.pathname === '/sitemap_index.xml') return send(200, `<?xml version="1.0"?><sitemapindex><sitemap><loc>${SITE}/manga-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/tag-sitemap.xml</loc></sitemap></sitemapindex>`, 'application/xml');
  if (u.pathname === '/manga-sitemap.xml') return send(200, `<?xml version="1.0"?><urlset>${listed().map(s => `<url><loc>${SITE}/madara/manga/${s}/</loc><lastmod>2025-01-0${s.length % 9 + 1}</lastmod></url>` + madaraWorks[s].chapters.map(n => `<url><loc>${SITE}/madara/manga/${s}/chapter-${n}/</loc></url>`).join('')).join('')}</urlset>`, 'application/xml');
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
    setTimeout(() => { inFlight--; send(200, madaraWork(m[1])); }, 700); return;
  }
  // Custom site: one list page; one work's page is not allowed by robots.txt
  if (u.pathname === '/custom/list') {
    if (u.searchParams.get('p') !== '1') return send(200, '<div class="list"></div>');
    return send(200, `<div class="list"><div class="item"><a href="/custom/w/blue-moon">Blue Moon</a></div><div class="item"><a href="/custom/private/secret">Secret</a></div></div>`);
  }
  if (u.pathname === '/custom/w/blue-moon') return send(200, `<h1 class="t">Blue Moon</h1><div class="genres"><span>Fantasy</span><span>Science Fiction</span></div><ol class="chs"><li><a href="/custom/w/blue-moon/6">Ep. 6</a></li><li><a href="/custom/w/blue-moon/5">Ep. 5</a></li></ol>`);
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
  // Several works at once (the source's setting), still one request to the site per gapMs
  await call('PATCH', `/api/catalog/sources/${madara.id}`, { concurrency: 3 });
  slowWorks = true;
  await call('POST', `/api/catalog/sources/${madara.id}/crawl`, { mode: 'full' });
  s1 = await crawled(madara.id);
  slowWorks = false;
  const gaps = workHits.slice(1).map((t, i) => t - workHits[i]);
  ok(s1.works === 3 && s1.lastStats.errors === 0 && s1.lastStats.concurrency === 3 && maxInFlight >= 2 && gaps.every(g => g >= 150),
    `several works read at once (${maxInFlight} pages in flight, ${s1.lastStats.concurrency} lanes) while requests still start one per pause (gaps ${gaps.join(', ')} ms)`);
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
  const mg = (await call('POST', '/api/catalog/merge', { keys: g.works.map(w => w.key), primary: blue.key })).data;
  cat = (await call('GET', '/api/catalog?q=blue%20moon')).data;
  ok(cat.total === 1 && cat.items[0].sources.length === 2 && cat.items[0].chapters === 4, 'merged: one catalog entry with both sources');
  det = (await call('GET', `/api/catalog/work?key=${encodeURIComponent(cat.items[0].key)}`)).data.work;
  ok(det.sources.length === 2 && det.missing.chapters.map(c => c.n).join() === '3,4,5,6', 'its chapters come from both sites (missing: 3–6)');
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
