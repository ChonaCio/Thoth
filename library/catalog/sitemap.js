// Sitemaps: what a site lists in its sitemap files (robots.txt names them). Used to find a site's works (and to
// learn its address patterns when a source is added), and as a source's way of listing works: polite (a few
// files instead of every list page) and, with lastmod dates, updates only read what changed.
const zlib = require('zlib');
const crypto = require('crypto');

const decodeXml = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
// → { sitemaps: [{ loc, lastmod }], urls: [{ loc, lastmod }] }
function parseSitemap(text) {
  const pick = (block, tag) => { const m = new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(block); return m ? decodeXml(m[1]) : null; };
  const out = { sitemaps: [], urls: [] };
  for (const m of String(text).matchAll(/<(?:\w+:)?sitemap>([\s\S]*?)<\/(?:\w+:)?sitemap>/gi)) { const loc = pick(m[1], 'loc'); if (loc) out.sitemaps.push({ loc, lastmod: pick(m[1], 'lastmod') }); }
  for (const m of String(text).matchAll(/<(?:\w+:)?url>([\s\S]*?)<\/(?:\w+:)?url>/gi)) { const loc = pick(m[1], 'loc'); if (loc) out.urls.push({ loc, lastmod: pick(m[1], 'lastmod') }); }
  return out;
}
const hashOf = text => crypto.createHash('sha1').update(String(text)).digest('hex');
async function readSitemap(get, url) {
  const res = await get(url, { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' });
  let text = res.text;
  if (res.buf && res.buf[0] === 0x1f && res.buf[1] === 0x8b) text = zlib.gunzipSync(res.buf).toString('utf8'); // .xml.gz
  return Object.assign(parseSitemap(text), { hash: hashOf(text) });
}
// Every URL listed, following sitemap indexes (at most maxFiles files): { file, urls, hash (of its content),
// lastmod (its date in the index that named it) }. skip(url, lastmod): true = don't read that file at all.
async function* walk(get, roots, { maxFiles = 2000, filter, skip } = {}) {
  const todo = roots.map(loc => ({ loc, lastmod: null })), seen = new Set();
  let files = 0;
  while (todo.length && files < maxFiles) {
    const { loc: url, lastmod } = todo.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    if (skip && skip(url, lastmod)) continue;
    files++;
    let sm;
    try { sm = await readSitemap(get, url); } catch (e) { if (e.code === 'blocked' || e.code === 'stopped') throw e; continue; }
    for (const s of sm.sitemaps) if (!filter || filter(s.loc)) todo.push(s);
    if (sm.urls.length) yield { file: url, urls: sm.urls, hash: sm.hash, lastmod };
  }
}

/* ---------------- address patterns ---------------- */
// "/manga/*/" → a RegExp for paths: * = one path segment, ** = anything
function patternRegex(pattern) {
  if (!pattern) return null;
  const p = String(pattern).trim().replace(/\/+$/, '');
  const re = p.split('/').map(seg => (seg === '**' ? '.*' : seg.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+'))).join('/');
  return new RegExp('^' + re + '/?$', 'i');
}
const pathOf = url => { try { return decodeURI(new URL(url).pathname); } catch { return ''; } };
const WORK_WORDS = /^(manga|manhwa|manhua|comic|comics|series|serie|title|titles|webtoon|webtoons|novel|novels|read|book|books|obra|obras|manga-list|mangas)$/i;
const OTHER_WORDS = /chapter|episode|capitulo|tag|genre|category|categories|author|artist|page|blog|news|post|user|profile|login|search|wp-|feed|type|status/i;
// The pattern of a path: the first segment kept when it's a fixed word, the rest as *
function templateOf(p, keepFirst = true) {
  const segs = p.split('/').filter(Boolean);
  if (!segs.length) return '/';
  return '/' + segs.map((s, i) => (i === 0 && keepFirst && !/\d/.test(s) && s.length <= 20 ? s : '*')).join('/') + '/';
}
// From the URLs a site lists: the pattern of its works' pages and of its chapters' pages.
// hints: URL → the sitemap file it came from (a file named like "manga-sitemap" lists works, "chapter-…" chapters)
function inferPatterns(urls, hints = new Map()) {
  const paths = urls.map(u => ({ url: u, p: pathOf(u), file: String(hints.get(u) || '').toLowerCase() })).filter(x => x.p && x.p !== '/');
  const count = (keepFirst, from) => {
    const m = new Map();
    for (const x of from) { const t = templateOf(x.p, keepFirst); m.set(t, (m.get(t) || 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  // Works: from a "works" sitemap if there is one, else the most common pattern that looks like a work
  const fromWorkFiles = paths.filter(x => /manga|manhwa|series|comic|webtoon|title|novel|obra/.test(x.file) && !/chapter|episode|capitulo/.test(x.file));
  let pool = fromWorkFiles.length >= 3 ? fromWorkFiles : paths;
  let ranked = count(true, pool), rootMode = false;
  // No fixed first segment shared by many pages: the works are right under the root ("/one-piece/")
  if (!ranked.length || ranked[0][1] < Math.max(3, pool.length * 0.05)) { ranked = count(false, pool); rootMode = true; }
  const depth = t => t.split('/').filter(Boolean).length;
  // Works sit above their chapters: the shallowest pattern that covers a fair share of the pages
  const shallowest = list => { if (!list.length) return null; const max = Math.max(...list.map(x => x[1])); return list.filter(x => x[1] >= max * 0.2).sort((a, b) => depth(a[0]) - depth(b[0]) || b[1] - a[1])[0]; };
  const looksLikeWork = t => { const first = t.split('/')[1]; return depth(t) <= 3 && !OTHER_WORDS.test(t.split('/').slice(1, -2).join('/')) && (first === '*' || WORK_WORDS.test(first) || !OTHER_WORDS.test(first)); };
  const work = rootMode
    ? (ranked.filter(([t, n]) => n >= 2).sort((a, b) => depth(a[0]) - depth(b[0]) || b[1] - a[1])[0] || [null, 0]) // the shallowest one
    : shallowest(ranked.filter(([t, n]) => n >= 2 && looksLikeWork(t) && (pool !== paths || WORK_WORDS.test(t.split('/')[1])))) || shallowest(ranked.filter(([t, n]) => n >= 2 && looksLikeWork(t))) || [null, 0];
  // Chapters: one level under a work page, or a pattern whose pages are named like chapters
  let chapter = null;
  if (work[0]) {
    const deeper = work[0].replace(/\/$/, '') + '/*/';
    const all = count(!rootMode, paths);
    const hit = all.find(([t]) => t === deeper) || all.find(([t]) => t.startsWith(work[0].replace(/\*\/$/, '')) && t.split('/').length > work[0].split('/').length);
    if (hit) chapter = hit[0];
  }
  if (!chapter) {
    const named = paths.filter(x => /chapter|episode|capitulo|ch-\d|ep-\d/i.test(x.p) || /chapter|episode/.test(x.file));
    if (named.length) chapter = count(true, named)[0][0];
  }
  return { workPattern: work[0], works: work[1], chapterPattern: chapter, patterns: count(true, paths).slice(0, 8).map(([t, n]) => ({ pattern: t, count: n })) };
}
// "one-piece-colored" → "One Piece Colored" (a stand-in title until the work's page is read)
const titleFromSlug = url => { const seg = pathOf(url).split('/').filter(Boolean).pop() || ''; return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim(); };

// A source's works from its sitemaps: [{ sid, url, title, lastmod }] pages.
// Every crawl leaves in ctx.sitemapNext what each sitemap file held: { files: { url: { hash, lastmod, works:
// { sid: fingerprint } } } } (a work's fingerprint: its own date plus the chapter addresses listed under it).
// An update given the last crawl's (ctx.sitemapState) only looks at what changed:
//   - a file whose date in its index is the same isn't even downloaded;
//   - a file whose content hash is the same is skipped;
//   - in a changed file, only works that are new or whose fingerprint changed are read.
// Without a saved state, an update yields the works dated after the last crawl (undated ones always).
async function* sitemapWorks(ctx) {
  const { src, get } = ctx;
  const re = patternRegex(src.workPattern);
  if (!re) throw Object.assign(new Error('No address pattern for the works'), { code: 'config' });
  const chRe = patternRegex(src.chapterPattern);
  const since = ctx.incremental && src.lastCrawlAt ? Date.parse(src.lastCrawlAt) - 86400000 : 0;
  const roots = (src.sitemaps && src.sitemaps.length ? src.sitemaps : [new URL('/sitemap.xml', src.baseUrl).href]);
  // Child sitemaps that obviously list other things (tags, authors, chapters, images) are skipped
  const filter = loc => !/(tag|categor|author|artist|genre|image|video|news|page|post|chapter|episode)s?[-_]?sitemap|sitemap[-_]?(tag|categor|author|artist|genre|image|video|news|page|post|chapter|episode)/i.test(loc);
  const prev = ctx.sitemapState && ctx.sitemapState.files ? ctx.sitemapState : null;
  const delta = Boolean(ctx.incremental && prev);
  const next = ctx.sitemapNext = { at: new Date().toISOString(), files: {} };
  const counts = ctx.sitemapCounts = { files: 0, unchanged: 0, notRead: 0 };
  const skip = delta ? (loc, lastmod) => {
    const old = prev.files[loc];
    if (!old || !lastmod || old.lastmod !== lastmod) return false;
    next.files[loc] = old; counts.notRead++; return true;
  } : null;
  // The work a chapter address belongs to: the longest start of its path that is a work's address
  const workOf = p => { const segs = p.split('/').filter(Boolean); for (let k = segs.length - 1; k > 0; k--) { const c = '/' + segs.slice(0, k).join('/'); if (re.test(c)) return c; } return null; };
  const slash = /\/$/.test(src.workPattern) ? '/' : '';
  const seen = new Set();
  for await (const { file, urls, hash, lastmod } of walk(get, roots, { filter, skip })) {
    counts.files++;
    const entries = new Map(); // sid → { url, lastmod, parts }
    const entry = sid => { if (!entries.has(sid)) entries.set(sid, { url: null, lastmod: null, parts: [] }); return entries.get(sid); };
    for (const u of urls) {
      const p = pathOf(u.loc);
      if (re.test(p)) { const e = entry(p.replace(/\/+$/, '')); e.url = u.loc; e.lastmod = u.lastmod || null; e.parts.push('=' + (u.lastmod || '')); continue; }
      const sid = chRe && chRe.test(p) ? workOf(p) : null;
      if (sid) entry(sid).parts.push(p + ' ' + (u.lastmod || ''));
    }
    const works = {};
    for (const [sid, e] of entries) works[sid] = hashOf(e.parts.sort().join('\n')).slice(0, 16);
    next.files[file] = { hash, lastmod: lastmod || null, works };
    const old = prev && prev.files[file];
    if (delta && old && old.hash === hash) { counts.unchanged++; continue; }
    const page = [];
    for (const [sid, e] of entries) {
      // (a work seen only through its chapters is read only when it was listed before)
      if (seen.has(sid) || (!e.url && !(old && old.works && sid in old.works))) continue;
      seen.add(sid);
      if (delta && old) { if (old.works && old.works[sid] === works[sid]) continue; }
      else if (since && e.lastmod && Date.parse(e.lastmod) < since) continue;
      const url = e.url || new URL(sid + slash, file).href; // (only its chapters are listed here)
      page.push({ sid, url, title: titleFromSlug(url), lastmod: e.lastmod });
    }
    for (let i = 0; i < page.length; i += 100) yield page.slice(i, i + 100);
  }
}

module.exports = { parseSitemap, readSitemap, walk, patternRegex, inferPatterns, templateOf, titleFromSlug, sitemapWorks, pathOf };
