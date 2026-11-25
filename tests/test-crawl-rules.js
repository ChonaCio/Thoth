// External catalog rules (in process, a local fake site on port 3995):
//   - title keys: numbers either way, a leading article, bracketed extras; near-identical names
//   - text: pages decoded in their charset; garbled UTF-8 repaired
//   - robots.txt answering a server error: the site is off-limits (RFC 9309)
//   - 429: the site is asked half as many requests at once for a while
//   - a series page's links to metadata sites (AniList, MyAnimeList…) kept as the work's entries there
// node tests/test-crawl-rules.js
const http = require('http');
const path = require('path');
const APP = path.resolve(__dirname, '..');
const names = require(path.join(APP, 'library/catalog/names'));
const text = require(path.join(APP, 'library/catalog/text'));
const { createFetcher } = require(path.join(APP, 'library/catalog/fetcher'));
const { parse } = require(path.join(APP, 'library/catalog/html'));

let failed = 0, passed = 0;
const check = (ok, name, extra) => { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); } };
const same = (a, b) => names.matchKeys(a).some(k => names.matchKeys(b).includes(k));
const PORT = 3995, BASE = `http://127.0.0.1:${PORT}`;

let tooMany = 0;
const thumbHits = {};
const site = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  if (u.pathname === '/robots.txt') {
    if (req.headers.host.startsWith('localhost')) { res.writeHead(503); return res.end('down'); }
    res.writeHead(404); return res.end();
  }
  // A big sitemap (≈ 10 MB: more than a page may be, less than a sitemap may be) and one too big even for that
  if (u.pathname === '/big/sitemap.xml' || u.pathname === '/huge/sitemap.xml') {
    const n = u.pathname.startsWith('/big') ? 85000 : 650000; // (≈ 112 bytes each: ≈ 9 MB, ≈ 70 MB)
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.write('<?xml version="1.0"?><urlset>');
    for (let i = 0; i < n; i += 1000) res.write(Array.from({ length: Math.min(1000, n - i) }, (_, k) => `<url><loc>${BASE}/manga/work-${i + k}/chapter-1</loc><lastmod>2026-01-01T00:00:00+00:00</lastmod></url>`).join('') + '\n');
    return res.end('</urlset>');
  }
  // Chapter rows that are links themselves
  if (u.pathname === '/series/linkrows') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<h1>Link rows</h1><div class="chs">${[3, 2, 1].map(n => `<a class="ch" href="/series/linkrows/chapter-${n}">Chapter ${n} <span class="date">2026-01-0${n}</span></a>`).join('')}</div>`); }
  // Thumbnails: every request counted; /thumb/missing.png answers 404
  if (u.pathname.startsWith('/thumb/')) {
    thumbHits[u.pathname] = (thumbHits[u.pathname] || 0) + 1;
    if (u.pathname === '/thumb/missing.png') { res.writeHead(404); return res.end('no'); }
    // (like MangaNato's image server: only the referer a browser sends — the page's origin and "/" — and the image
    // sent as octet-stream)
    if (u.pathname === '/thumb/guarded.webp') {
      if (req.headers.referer !== 'http://site.example/') { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end('<!DOCTYPE html>forbidden'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.alloc(200, 1)]));
    }
    if (u.pathname === '/thumb/page.png') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>not an image</html>'); }
    res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.alloc(300, u.pathname.length));
  }
  if (u.pathname === '/series/priced') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>Priced</h1><p class="au">Ana One, Bo Two; Cy Three</p><ul>' + [3, 2, 1].map(n => `<li class="cl"><a href="/series/priced/chapter-${n}"><span class="num">Chapter ${n}</span>${n === 3 ? '<span class="price">50</span>' : '<span class="free">Now Free</span>'}</a></li>`).join('') + '</ul>'); }
  if (u.pathname === '/en/series/time-mage') {
    const ep = (id, ord, o) => Object.assign({ id, ord, openAt: '2026-01-0' + ord + 'T04:00:00Z', data: {}, lockData: { buyOption: { price: 374 }, state: 30 } }, o);
    const data = { props: { pageProps: { initialSeries: { id: 7, type: 60, openAt: '2025-03-01T00:00:00Z', image: { '1280x1840_720': { downloadUrl: 'https://img.example/c.jpg' } },
      data: { title: { en: 'Time Mage' }, description: { long: 'About it.' }, isCompleted: true, tags: [{ name: { en: 'Fantasy', es: 'Fantasía' } }], creators: [{ name: 'Ana Author', role: 'Author' }, { name: 'Pub', role: 'Publisher' }] },
      episodes: [ep(101, 1, { data: { isFree: true }, lockData: { buyOption: { price: 0 }, state: 110 } }), ep(102, 2), ep(103, 3, { openAt: '2999-01-01T00:00:00Z', lockData: { buyOption: { price: 0 }, state: 110 } })] } } } };
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<title>Time Mage - Manga</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`);
  }
  if (u.pathname === '/latin1') { res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' }); return res.end(Buffer.from([0x3c, 0x70, 0x3e, 0x43, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])); }
  // Work pages that show only the newest chapters; the rest where the page's script would get it
  const recent = n => Array.from({ length: 3 }, (_, i) => `<li><a href="/series/${n}/chapter-${30 - i}">Chapter ${30 - i}</a></li>`).join('');
  if (u.pathname === '/series/tpl') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<h1>Tpl</h1><div id="chapters" data-api-url="/api/manga/__SLUG__/chapters?skip=0&take=10" data-comic-slug="tpl-slug"><ul class="ch">${recent('tpl')}</ul></div>`); }
  if (u.pathname === '/api/manga/tpl-slug/chapters') {
    const skip = Number(u.searchParams.get('skip')) || 0, take = 10;
    const items = Array.from({ length: 30 }, (_, i) => ({ number: 30 - i, slug: `chapter-${30 - i}`, title: `Chapter ${30 - i}`, created_at: '2026-01-' + String(1 + (i % 28)).padStart(2, '0'), isLocked: i === 0 })).slice(skip, skip + take);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: items, skip, take, total: 30 }));
  }
  if (u.pathname === '/series/next') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<h1>Next</h1><ul class="ch">${recent('next')}</ul><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { series: { chapters: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, chapter_number: i + 1, chapter_slug: 'chapter-' + (i + 1), chapter_name: '' })) } } } })}</script>`); }
  if (u.pathname === '/series/own') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<h1>Own</h1><ul class="ch">${recent('own')}</ul>`); }
  if (u.pathname === '/full/own') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(Array.from({ length: 30 }, (_, i) => `<a href="/series/own/chapter-${i + 1}">Chapter ${i + 1}</a>`).join('')); }
  if (u.pathname === '/series/commas') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>Love, Chunibyo &amp; Other Delusions</h1><p class="alt">Chuunibyou demo Koi ga Shitai!, Love, Chunibyo &amp; Other Delusions, Yes, My Lord, Kaguya-sama (Love, War), Fate/stay night</p>'); }
  if (u.pathname === '/series/fields') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>Fields</h1><p class="alt">Uno • Dos • Tres</p><p class="st">Status: Ongoing</p><p class="ty">Type: Manhwa</p><p class="yr">Released 2019</p>' +
    '<ul class="g"><li><a>Adventure <span>999</span></a></li><li><a>Action (12)</a></li></ul><ul class="t"><li>Regression</li><li>System · 1.2k</li></ul>'); }
  // A listing per letter; links to works and other links mixed (a link pattern picks the works)
  const az = /^\/az\/([a-z]|0-9)$/.exec(u.pathname);
  if (az) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(az[1] === 'b' || az[1] === 'q' ? `<a href="/manga/${az[1]}-one">One</a><a href="/manga/${az[1]}-one/chapter-1">Ch</a><a href="/genre/action">Action</a>` : '<p>none</p>'); }
  // Access: the home page sets a visitor cookie (and a bot-check cookie that must never be sent back)
  if (u.pathname === '/') { res.writeHead(200, { 'Set-Cookie': ['visitor=1; Path=/', 'cf_clearance=x; Path=/'] }); return res.end('home'); }
  if (u.pathname === '/needs-cookie') { const ck = req.headers.cookie || ''; if (/cf_clearance/.test(ck)) { res.writeHead(500); return res.end('bot cookie sent'); } res.writeHead(/visitor=1/.test(ck) ? 200 : 403); return res.end(/visitor=1/.test(ck) ? 'welcome' : 'forbidden'); }
  if (u.pathname === '/needs-referer') { res.writeHead(req.headers.referer === BASE + '/' ? 200 : 403); return res.end('ref'); }
  if (u.pathname === '/needs-key') { res.writeHead(req.headers['x-api-key'] === 'k1' && /mine=2/.test(req.headers.cookie || '') ? 200 : 403); return res.end('key'); }
  // A site whose sitemap index lists 6 monthly chapter sitemaps before its list of works (/manga/… and /manhwa/…)
  const xml = (tag, locs) => `<?xml version="1.0"?><${tag === 'sitemap' ? 'sitemapindex' : 'urlset'} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map(l => `<${tag}><loc>${BASE}${l}</loc></${tag}>`).join('')}</${tag === 'sitemap' ? 'sitemapindex' : 'urlset'}>`;
  if (u.pathname === '/sm/index.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(xml('sitemap', ['/sm/chapters-2026-01.xml', '/sm/chapters-2026-02.xml', '/sm/chapters-2026-03.xml', '/sm/chapters-2026-04.xml', '/sm/chapters-2026-05.xml', '/sm/chapters-2026-06.xml', '/sm/series.xml'])); }
  if (u.pathname === '/sm/series.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(xml('url', ['/manga/alpha', '/manga/beta', '/manhwa/gamma', '/manhwa/delta', '/genre/action', '/manga/page'])); }
  const cm = /^\/sm\/chapters-2026-0(\d)\.xml$/.exec(u.pathname);
  if (cm) { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(xml('url', ['alpha', 'beta', 'gamma'].map((w, i) => `/${i === 2 ? 'manhwa' : 'manga'}/${w}/chapter-${cm[1]}`))); }
  // Nested sitemaps in every form: a <urlset> listing other sitemaps (one by a relative address), an index under
  // it, a text sitemap, and chapter sitemaps two levels down
  const urlset = locs => `<?xml version="1.0"?><urlset>${locs.map(l => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
  if (u.pathname === '/nest/sitemap.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(urlset([BASE + '/nest/chapters-01.xml', 'level2.xml', BASE + '/manga/root-work'])); }
  if (u.pathname === '/nest/level2.xml') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${BASE}/nest/works-sitemap.txt</loc></sitemap><sitemap><loc>${BASE}/nest/chapters-02.xml</loc></sitemap></sitemapindex>`); }
  if (u.pathname === '/nest/works-sitemap.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(`${BASE}/manga/nested-one\n${BASE}/manga/nested-two\n`); }
  const nc = /^\/nest\/chapters-0(\d)\.xml$/.exec(u.pathname);
  if (nc) { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(urlset([`${BASE}/manga/nested-one/chapter-${nc[1]}`, `${BASE}/manga/nested-two/chapter-${nc[1]}`])); }
  if (u.pathname === '/busy') { if (tooMany++ < 1) { res.writeHead(429, { 'Retry-After': '0' }); return res.end('slow down'); } res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>hi</p>');
});

(async () => {
  console.log('Title keys');
  check(same('Three Title', '3-title'), '"3-title" = "Three Title"');
  check(same('Twenty-One Days', '21 Days'), '"Twenty-One Days" = "21 Days"');
  check(same('The First Prince', 'The 1st Prince'), '"The First Prince" = "The 1st Prince"');
  check(same('Room 007', 'Room 7'), '"Room 007" = "Room 7"');
  check(same('The Beginning After the End', 'Beginning After the End'), 'a leading "The" doesn\'t matter (long names)');
  check(!same('The One', 'One'), '…but short names keep it ("The One" ≠ "One")');
  check(same('Solo Leveling (Official)', 'Solo Leveling') && same('Tower [Manhwa]', 'Tower') && same('Hero (2019)', 'Hero'), 'bracketed extras: (Official), [Manhwa], (2019)');
  check(!same('Ten Count', 'One Count'), 'different numbers stay different works');
  check(!same('someone special', '1 special'), 'words that only contain a number are left alone');
  check(names.nearNames(names.nameKey("The Swordmaster's Revenge"), names.nameKey('The Swordmasters Revange')), 'near-identical names: a letter apart');
  check(!names.nearNames(names.nameKey('Return of the Hero 2'), names.nameKey('Return of the Hero 3')), '…never when the numbers differ');
  check(!names.nearNames(names.nameKey('Short Nam'), names.nameKey('Short Nem')), '…nor for short names');

  console.log('Chapters');
  const ch = require(path.join(APP, 'library/catalog/chapters'));
  const now = new Date('2026-11-24T12:00:00Z');
  const dates = { 'Jan 4, 2025': '2025-01-04', '4 January 2025': '2025-01-04', 'May 9': '2026-05-09', 'Dec 30': '2025-12-30', '5d ago': '2026-11-19', 'about 1 month ago': '2026-10-25', 'yesterday': '2026-11-23', 'hace 3 días': '2026-11-21', 'Chapter 5': '' };
  const wrongDates = Object.entries(dates).filter(([t, d]) => ch.chapterDate(t, now) !== d).map(([t]) => t + '→' + ch.chapterDate(t, now));
  check(!wrongDates.length, 'release dates from what sites show ("5d ago", "May 9", "hace 3 días"…)', wrongDates.join(', '));
  const run = []; for (let i = 70; i >= 1; i--) run.push({ n: String(i), t: 'Chapter ' + i });
  run.splice(10, 0, { n: '605', t: 'Chapter 605' });
  const fixed = ch.fixMisreadNumbers(run);
  check(fixed.length === 1 && fixed[0].to === 60.5 && run[10].n === '60.5' && run[10].t === 'Chapter 60.5', 'a lone 605 in a list running 1…70 (between 61 and 60) is chapter 60.5');
  const cut = []; for (let i = 50; i >= 1; i--) cut.push({ n: String(i) });
  cut.unshift({ n: '505' });
  check(!ch.fixMisreadNumbers(cut).length && cut[0].n === '505', 'a real chapter 505 above a list cut short at 50 is left alone');
  const bulk = Array.from({ length: 30 }, (_, i) => ({ d: i < 15 ? '2026-02-22' : `2026-01-${String(i).padStart(2, '0')}` }));
  check(ch.bulkDates(bulk).has('2026-02-22') && ch.bulkDates(bulk).size === 1, 'a day half the chapters carry is a bulk update (its dates are ignored)');

  console.log('Text');
  check(text.fixMojibake('CafÃ© Itâ€™s') === 'Café It’s', 'garbled UTF-8 repaired ("CafÃ©" → "Café")');
  check(text.fixMojibake('Normal — text, café') === 'Normal — text, café', 'proper text left alone');

  await new Promise(r => site.listen(PORT, '127.0.0.1', r));
  const f = createFetcher({ gapMs: 50, allowLocal: true, parallel: 4 });
  const latin = await f.get(BASE + '/latin1');
  check(latin.text.includes('Café'), 'a page is read in the charset it declares (ISO-8859-1)');

  console.log('robots.txt and slowing down');
  let e1 = null; try { await f.get(`http://localhost:${PORT}/page`); } catch (e) { e1 = e; }
  check(e1 && e1.code === 'robots' && /RFC 9309/.test(e1.message), 'robots.txt answering 503: the whole site is off-limits', e1 && e1.message);
  const ok = await f.get(BASE + '/busy');
  check(ok.text === 'ok' && f.stats.slowedDown === 1 && f.stats.retries === 1, 'a 429 is retried after Retry-After, and the site is slowed down');

  console.log('Metadata-site links on a series page');
  const adapters = require(path.join(APP, 'library/catalog/adapters'));
  const doc = parse(`<html><body><h1>Title</h1><a href="https://anilist.co/manga/12345/x">AniList</a><a href="https://myanimelist.net/manga/678/x">MAL</a>
    <div class="recs"><a href="https://www.mangaupdates.com/series.html?id=1">a</a><a href="https://www.mangaupdates.com/series.html?id=2">b</a></div>
    <a href="https://www.anime-planet.com/manga/the-title">AP</a></body></html>`);
  const w = { title: 'Title' };
  adapters.enrich(doc, w, BASE);
  check(w.links && w.links.anilist === '12345' && w.links.myanimelist === '678' && w.links.animeplanet === 'the-title', 'AniList, MyAnimeList and Anime-Planet entries kept', JSON.stringify(w.links));
  check(!w.links.mangaupdates, 'a site linked to twice (a recommendations list) says nothing');

  console.log('Complete chapter lists');
  const fw = createFetcher({ gapMs: 20, allowLocal: true });
  const readWork = async (slug, extra) => adapters.ADAPTERS.custom.fetchWork({ src: Object.assign({ type: 'custom', baseUrl: BASE, includeChapters: true, selectors: { chapter: 'ul.ch li' } }, extra || {}), get: fw.get },
    { sid: '/series/' + slug, url: `${BASE}/series/${slug}`, title: slug });
  const tpl = await readWork('tpl');
  check(tpl.chapters.length === 30 && tpl.chaptersVia === 'script address' && tpl.chapters.find(c => c.n === '30').pr, 'an address template in the page (data-api-url + data-comic-slug), paged with skip/take, premium flags kept', tpl.chapters.length + ' ' + tpl.chaptersVia);
  const nx = await readWork('next');
  check(nx.chapters.length === 30 && nx.chaptersVia === 'page data' && nx.chapters.some(c => c.u === BASE + '/series/next/chapter-1'), 'chapters in the page\'s Next.js data (addresses learned from the links shown)', nx.chapters.length + ' ' + nx.chaptersVia);
  const own = await readWork('own', { chaptersUrl: BASE + '/full/{slug}' });
  check(own.chapters.length === 30 && own.chaptersVia === 'setting', 'the source\'s "Full chapter list URL" ({slug})');
  const off = await readWork('tpl', { fullChapters: false });
  check(off.chapters.length === 3, 'turned off: only what the page shows');

  console.log('More fields and clean-up rules');
  const fields = await adapters.ADAPTERS.custom.fetchWork({ src: { type: 'custom', baseUrl: BASE, includeChapters: false,
    selectors: { altTitles: '.alt', altSeparator: '•', status: '.st', type: '.ty', year: '.yr', genres: '.g a', tags: '.t li' },
    clean: { genres: { own: true, counts: true }, tags: { counts: true }, type: { label: true }, status: { label: true } } }, get: fw.get }, { sid: '/series/fields', url: BASE + '/series/fields', title: 'x' });
  check(fields.altTitles.join('|') === 'Uno|Dos|Tres', 'alternative titles split by the source\'s separator', fields.altTitles.join('|'));
  const commas = await adapters.ADAPTERS.custom.fetchWork({ src: { type: 'custom', baseUrl: BASE, includeChapters: false, selectors: { workTitle: 'h1', altTitles: '.alt' } }, get: fw.get }, { sid: '/series/commas', url: BASE + '/series/commas', title: 'x' });
  check(commas.title === 'Love, Chunibyo & Other Delusions' && commas.altTitles.join('|') === 'Chuunibyou demo Koi ga Shitai!|Love, Chunibyo & Other Delusions|Yes, My Lord|Kaguya-sama (Love, War)|Fate/stay night',
    'titles with commas and slashes in them kept whole (the work\'s own title, brackets, "Yes, …", "Fate/stay night")', commas.altTitles.join('|'));
  check(fields.genres.join('|') === 'Adventure|Action' && fields.tags.join('|') === 'Regression|System', 'counts removed; only the element\'s own text', fields.genres.join('|') + ' / ' + fields.tags.join('|'));
  check(fields.type === 'Manhwa' && fields.status === 'ongoing' && fields.year === 2019, 'type, status and year (labels removed)', [fields.type, fields.status, fields.year].join(' '));

  console.log('Listings and templates');
  check(adapters.expandListing('/az/{letter}?page={page}').length === 27 && adapters.expandListing('/list/{manhwa|manhua}').join() === '/list/manhwa,/list/manhua', 'listing addresses per letter ({letter}: 0-9, a … z) and per named value ({a|b})');
  const listed = [];
  for await (const pg of adapters.ADAPTERS.custom.listWorks({ src: { type: 'custom', baseUrl: BASE, selectors: { listUrl: '/az/{letter}', linkPattern: '^/manga/[^/]+$' } }, get: fw.get })) listed.push(...pg.map(x => x.sid));
  check(listed.join() === '/manga/b-one,/manga/q-one', 'every letter read; only links matching the work pattern are works', listed.join());
  const tpls = require(path.join(APP, 'library/catalog/templates'));
  const ranked = tpls.rankTemplates('<div class="c-page__content"><script>var manga_get_chapters</script>');
  check(ranked[0].id === 'madara' && ranked[0].likely && tpls.TEMPLATES.length >= 20 && tpls.TEMPLATES.every(t => t.selectors.listUrl || t.sitemaps), 'templates: the ones whose markers are on the home page come first (' + tpls.TEMPLATES.length + ' templates)');

  console.log('Access (403)');
  const fa = createFetcher({ gapMs: 20, allowLocal: true, access: { mode: 'auto', home: BASE } });
  const c1 = await fa.get(BASE + '/needs-cookie');
  check(c1.text === 'welcome' && c1.access === 'cookies', 'a 403 retried with the cookies the site sets for every visitor (bot-check cookies never sent back)', c1.access);
  const c2 = await fa.get(BASE + '/needs-cookie');
  check(c2.text === 'welcome' && !c2.access, 'what worked is remembered for the host and used from the start');
  const r1 = await createFetcher({ gapMs: 20, allowLocal: true, access: { mode: 'auto', home: BASE } }).get(BASE + '/needs-referer');
  check(r1.access === 'referer-site', 'Referer variants (here the site\'s address)', r1.access);
  const fk = createFetcher({ gapMs: 20, allowLocal: true, access: { mode: 'auto', home: BASE, cookies: 'mine=2; cf_clearance=bad', headers: 'X-Api-Key: k1\nUser-Agent: Fake\nX-Forwarded-For: 1.2.3.4' } });
  const k1 = await fk.get(BASE + '/needs-key');
  const fetcherMod = require(path.join(APP, 'library/catalog/fetcher'));
  check(k1.access === 'user' && Object.keys(fetcherMod.headerLines('X-Api-Key: k1\nUser-Agent: Fake\nX-Forwarded-For: 1.2.3.4')).join() === 'X-Api-Key' && fetcherMod.cookiePairs('mine=2; cf_clearance=bad').join() === 'mine=2',
    'your cookies and headers (identity headers and bot-check cookies refused)');
  const fo = createFetcher({ gapMs: 20, allowLocal: true, access: { mode: 'auto', home: 'https://another.example', cookies: 'mine=2', headers: 'X-Api-Key: k1' } });
  let e3 = null; try { await fo.get(BASE + '/needs-key'); } catch (e) { e3 = e; }
  check(e3 && e3.status === 403, 'your cookies and headers are never sent to another site');
  let e4 = null; try { await createFetcher({ gapMs: 20, allowLocal: true, access: { mode: 'plain' } }).get(BASE + '/needs-cookie'); } catch (e) { e4 = e; }
  check(e4 && e4.status === 403 && /Automatic/.test(e4.message), 'plain requests only: the 403 is reported as is', e4 && e4.message);

  console.log('Sitemaps (Folio\'s way)');
  const smod = require(path.join(APP, 'library/catalog/sitemap'));
  const fs2 = createFetcher({ gapMs: 10, allowLocal: true });
  const urls2 = [], log2 = [];
  for await (const x of smod.walk(fs2.get, [BASE + '/sm/index.xml'], { maxFiles: 4, maxChapterFiles: 2, onFile: r => log2.push(r) })) urls2.push(...x.urls.map(u => u.loc));
  check(log2.some(r => r.url.endsWith('/sm/series.xml') && r.status === 'read' && r.parent === BASE + '/sm/index.xml') && log2.filter(r => /chapters-/.test(r.url)).length === 2,
    'the list of works is read before the chapter sitemaps (6 monthly ones listed first); a limit keeps it', log2.map(r => r.url.replace(BASE, '') + ':' + r.status).join(' '));
  const dp = smod.defaultPatterns(urls2);
  check(dp && dp.workPattern === '/manga/* /manhwa/*' && dp.works === 4 && dp.chapterPattern, 'works at /manga/… and /manhwa/… both found (a pattern per work word; /genre/… and /manga/page left out)', dp && dp.workPattern + ' ' + dp.works);
  const src2 = { autoDetect: true, workPattern: dp.workPattern, chapterPattern: dp.chapterPattern, sitemaps: [BASE + '/sm/index.xml'], baseUrl: BASE, includeChapters: true };
  const ctx2 = { src: src2, get: fs2.get };
  const listed2 = []; for await (const pg of smod.sitemapWorks(ctx2)) listed2.push(...pg.map(w => w.sid));
  check(listed2.sort().join() === '/manga/alpha,/manga/beta,/manhwa/delta,/manhwa/gamma' && ctx2.sitemapChapters.get('/manga/alpha').length === 6 && ctx2.sitemapChapters.get('/manhwa/gamma').length === 6,
    'a crawl lists every work and gets each one\'s chapters from the chapter sitemaps', listed2.join());
  check(Object.values(ctx2.discovery).find(r => r.url.endsWith('/sm/series.xml')).found === 4 && Object.values(ctx2.discovery).find(r => /chapters-2026-01/.test(r.url)).kind === 'chapters',
    'each sitemap is recorded: kind, what it gave');

  console.log('Nested sitemaps');
  const nlog = [], nurls = [];
  for await (const x of smod.walk(fs2.get, [BASE + '/nest/sitemap.xml'], { onFile: r => nlog.push(r) })) nurls.push(...x.urls.map(u => u.loc.replace(BASE, '')));
  const st = p => (nlog.find(r => r.url === BASE + p) || {});
  check(st('/nest/sitemap.xml').kind === undefined || st('/nest/sitemap.xml').status === 'read', 'the top sitemap read');
  check(st('/nest/chapters-01.xml').parent === BASE + '/nest/sitemap.xml' && st('/nest/level2.xml').parent === BASE + '/nest/sitemap.xml' && st('/nest/works-sitemap.txt').parent === BASE + '/nest/level2.xml' && st('/nest/chapters-02.xml').parent === BASE + '/nest/level2.xml',
    'sitemaps listed as ordinary entries (one by a relative address), an index under them and a text sitemap are all followed, each with its parent', nlog.map(r => r.url.replace(BASE, '') + '<' + String(r.parent || '').replace(BASE, '') + ':' + r.status).join(' '));
  check(['/manga/root-work', '/manga/nested-one', '/manga/nested-two', '/manga/nested-one/chapter-1', '/manga/nested-two/chapter-2'].every(p => nurls.includes(p)) && !nurls.some(p => /\.xml|\.txt/.test(p)),
    'their addresses: works and chapters from every level, no sitemap taken for a page', nurls.join(' '));
  const nctx = { src: { autoDetect: true, workPattern: '/manga/*', sitemaps: [BASE + '/nest/sitemap.xml'], baseUrl: BASE, includeChapters: true }, get: fs2.get };
  const nworks = []; for await (const pg of smod.sitemapWorks(nctx)) nworks.push(...pg.map(w => w.sid));
  check(nworks.sort().join() === '/manga/nested-one,/manga/nested-two,/manga/root-work' && nctx.sitemapChapters.get('/manga/nested-one').length === 2, 'a crawl gets the works and the chapters from every level', nworks.join());

  console.log('Big sitemaps');
  const fbig = createFetcher({ gapMs: 0, allowLocal: true });
  let big = null, bigErr = null; try { big = await smod.readSitemap(fbig.get, BASE + '/big/sitemap.xml'); } catch (e) { bigErr = e; }
  check(big && big.urls.length === 85000 && big.bytes > 8 * 1024 * 1024, 'a sitemap over the 8 MB page limit is read whole', bigErr ? bigErr.message : big && big.bytes);
  let pageErr = null; try { await fbig.get(BASE + '/big/sitemap.xml'); } catch (e) { pageErr = e; }
  check(pageErr && pageErr.code === 'tooLarge', 'an ordinary page that size is still refused');
  let hugeErr = null; try { await smod.readSitemap(fbig.get, BASE + '/huge/sitemap.xml'); } catch (e) { hugeErr = e; }
  check(hugeErr && hugeErr.code === 'tooLarge' && /64 MB/.test(hugeErr.message), 'one over 64 MB is refused, saying so', hugeErr && hugeErr.message);

  console.log('Chapter rows that are links');
  const flr = createFetcher({ gapMs: 0, allowLocal: true });
  const lrSrc = { type: 'custom', baseUrl: BASE, includeChapters: true, fullChapters: false, selectors: { workTitle: 'h1', chapter: 'div.chs a.ch', chapterDate: 'span.date' } };
  const lr = await adapters.ADAPTERS.custom.fetchWork({ src: lrSrc, get: flr.get, incremental: false, known: new Set() }, { sid: '/series/linkrows', url: BASE + '/series/linkrows', title: 'x' });
  check(lr.chapters.length === 3 && lr.chapters[0].u === BASE + '/series/linkrows/chapter-3' && lr.chapters[0].n === '3' && /2026-01-03/.test(lr.chapters[0].d),
    'each row is its own link (its address, number and date read)', JSON.stringify(lr.chapters.slice(0, 1)));

  console.log('Site template readers');
  // A premium marker named by the source (a price in the row), authors given on one line
  const pr = await adapters.ADAPTERS.custom.fetchWork({ src: { type: 'custom', baseUrl: BASE, includeChapters: true, fullChapters: false, selectors: { workTitle: 'h1', authors: 'p.au', chapter: 'li.cl', chapterLink: 'a@href', chapterTitle: '.num', chapterPremium: '.price' } }, get: flr.get, incremental: false, known: new Set() },
    { sid: '/series/priced', url: BASE + '/series/priced', title: 'x' });
  check(pr.chapters.length === 3 && pr.chapters.filter(c => c.pr).length === 1 && pr.chapters[0].pr === true && pr.authors.join('|') === 'Ana One|Bo Two|Cy Three', 'a chapter with the source\'s premium marker is premium; "A, B; C" is three authors', JSON.stringify({ a: pr.authors, p: pr.chapters.map(c => c.pr) }));
  // Manta: the series page's data (__NEXT_DATA__) → fields and the whole episode list, free ones not premium
  const mt = await adapters.ADAPTERS.manta.fetchWork({ src: { type: 'manta', baseUrl: BASE, languages: 'en', includeChapters: true }, get: flr.get }, { sid: '/en/series/time-mage', url: BASE + '/en/series/time-mage?seriesId=7', title: 'x' });
  check(mt.title === 'Time Mage' && mt.authors.join('|') === 'Ana Author' && mt.genres.join('|') === 'Fantasy' && mt.status === 'ended' && mt.type === 'manga' && mt.cover === 'https://img.example/c.jpg' && mt.chaptersComplete === true &&
    mt.chapters.length === 3 && !mt.chapters[0].pr && mt.chapters[1].pr && mt.chapters[2].pr && mt.chapters[1].u === BASE + '/en/series/time-mage/episodes/episode-2?episodeId=102' && mt.chapters[0].d === '2026-01-01',
    'Manta: fields and episodes from the page data (free / paid / not out yet)', JSON.stringify(mt).slice(0, 400));

  console.log('Catalog thumbnails cache');
  {
    const fs = require('fs'), os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-thumbs-'));
    process.env.THOTH_DATA_DIR = tmp; process.env.THOTH_CATALOG_ALLOW_LOCAL = '1';
    const th = require(path.join(APP, 'library/cache/catthumbs.js'));
    const H = th.handlers, T = p => BASE + '/thumb/' + p;
    const cfg = { memMb: 8, diskMb: 100, perMin: 600 };
    const a = await H.image({ url: T('ok-1.png'), cfg }), b = await H.image({ url: T('ok-1.png'), cfg });
    check(a.fetched && !b.fetched && b.buf.length === 300 && a.etag === b.etag && thumbHits['/thumb/ok-1.png'] === 1 && fs.readdirSync(th.DIR).length === 2, 'an image is fetched from the site once, then served from memory (and kept on disk)');
    await H.clear({});
    const c = await H.image({ url: T('ok-1.png'), cfg });
    check(!c.fetched && c.type === 'image/png' && thumbHits['/thumb/ok-1.png'] === 1 && th.info().diskHits === 1, 'memory emptied (a restart): served from disk, not the site');
    let e1 = null, e2 = null;
    try { await H.image({ url: T('missing.png'), cfg }); } catch (e) { e1 = e; }
    try { await H.image({ url: T('missing.png'), cfg }); } catch (e) { e2 = e; }
    check(e1 && e2 && e2.code === 'noCover' && thumbHits['/thumb/missing.png'] === 1 && th.info().skippedFailed === 1, 'an image that failed isn\'t asked for again for a while');
    let e3 = null; try { await H.image({ url: 'file:///etc/passwd', cfg }); } catch (e) { e3 = e; }
    check(e3 && e3.code === 'noCover', 'only web addresses');
    const gd = await H.image({ url: T('guarded.webp'), referer: 'http://site.example/manga/some-work', cfg });
    check(gd.fetched && gd.type === 'image/webp' && thumbHits['/thumb/guarded.webp'] === 1,
      'an image server that wants the browser\'s referer (the page\'s origin and "/") and sends the image as octet-stream: kept as a WebP');
    let e4 = null; try { await H.image({ url: T('page.png'), cfg }); } catch (e) { e4 = e; }
    check(e4 && e4.code === 'noCover', 'a page where an image was expected isn\'t kept');
    const t0 = Date.now();
    const w = await H.warm({ items: [1, 2, 3, 4, 5].map(n => ({ url: T(`ok-${n}.png`), referer: BASE })).concat([{ url: T('ok-2.png') }]), cfg });
    const wi = th.info().warm;
    check(w.added === 5 && wi.added === 4 && [2, 3, 4, 5].every(n => thumbHits[`/thumb/ok-${n}.png`] === 1) && thumbHits['/thumb/ok-1.png'] === 1 && Date.now() - t0 >= 300 && !wi.running,
      `covers fetched ahead: only the missing ones, once each, paced per site (${Date.now() - t0} ms for 4 at 600 a minute)`, JSON.stringify(wi));
    check((await H.warm({ items: [{ url: T('ok-9.png') }], cfg: Object.assign({}, cfg, { perMin: 0 }) })).off === true && !thumbHits['/thumb/ok-9.png'], 'reading ahead off (0 a minute): nothing fetched');
    H.configure({ cfg: Object.assign({}, cfg, { diskMb: 0.0008 }) }); // (≈ 840 bytes: two images and a bit)
    await new Promise(r => setTimeout(r, 300));
    const left = fs.readdirSync(th.DIR).filter(n => !n.endsWith('.type')).length;
    check(left === 2 && th.info().disk.files === 2, `past the disk limit the oldest go (${left} of 5 kept)`);
    await H.clear({ disk: true });
    check(!fs.existsSync(th.DIR), 'emptied with its disk folder');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  site.close();
  console.log(failed ? `\n${failed} CRAWL RULE CHECK(S) FAILED` : `\nALL ${passed} CRAWL RULE CHECKS PASSED`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
