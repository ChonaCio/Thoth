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
// Content fingerprint: the XML without comments (generators stamp the time they ran in one) and with whitespace
// collapsed — the same hash means the same addresses and dates as last time
const contentHash = text => hashOf(String(text).replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim());
async function readSitemap(get, url) {
  const t0 = Date.now();
  // (sitemaps may be far bigger than pages: up to 50 MB uncompressed)
  const { SITEMAP_BYTES } = require('./fetcher');
  const res = await get(url, { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5', maxBytes: SITEMAP_BYTES });
  let text = res.text;
  if (res.buf && res.buf[0] === 0x1f && res.buf[1] === 0x8b) { // .xml.gz
    try { text = zlib.gunzipSync(res.buf, { maxOutputLength: SITEMAP_BYTES }).toString('utf8'); }
    catch (e) { throw Object.assign(new Error(/RangeError|maxOutputLength|buffer/i.test(e.name + e.message) ? `Too large once unpacked (over ${SITEMAP_BYTES / 1048576} MB)` : 'Not a readable .gz file'), { code: 'tooLarge' }); }
  }
  let isSitemap = /<(?:\w+:)?(urlset|sitemapindex)[\s>]/i.test(text);
  let parsed = parseSitemap(text);
  // A text sitemap: one address per line
  if (!isSitemap && !/<[a-z!?]/i.test(text.slice(0, 2000))) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length && lines.every(l => /^https?:\/\/\S+$/i.test(l))) { isSitemap = true; parsed = { sitemaps: [], urls: lines.map(loc => ({ loc, lastmod: null })) }; }
  }
  // Nested sitemaps, however they're listed: relative addresses made absolute, and other sitemaps listed as
  // ordinary <url> entries (sitemap.xml listing chapters-01.xml…) followed like an index's
  const absUrl = loc => { try { return new URL(loc, res.url || url).href; } catch { return null; } };
  const sitemaps = parsed.sitemaps.map(x => Object.assign({}, x, { loc: absUrl(x.loc) })).filter(x => x.loc);
  const urls = [];
  for (const x of parsed.urls) {
    const loc = absUrl(x.loc);
    if (!loc) continue;
    if (looksLikeSitemap(loc, url)) sitemaps.push({ loc, lastmod: x.lastmod }); else urls.push(Object.assign({}, x, { loc }));
  }
  return { sitemaps, urls, hash: contentHash(text), http: res.status || 200, ms: Date.now() - t0, bytes: Buffer.byteLength(text), isSitemap };
}
// An address that's another sitemap: an .xml / .xml.gz / .txt file of the same site (named like a sitemap for .txt)
function looksLikeSitemap(loc, from) {
  let u, f; try { u = new URL(loc); f = new URL(from); } catch { return false; }
  const host = h => h.replace(/^www\./, '');
  if (host(u.hostname) !== host(f.hostname)) return false;
  return /\.xml(\.gz)?$/i.test(u.pathname) || (/\.txt$/i.test(u.pathname) && /sitemap/i.test(u.pathname)) || /sitemap[^/]*\.(xml|txt)/i.test(u.pathname + u.search);
}
// A sitemap file's kind: an index (of other sitemaps), a chapter sitemap, or a list of works (or other pages)
const CHAPTER_FILE = /chapter|episode|capitulo/i;
const kindOf = (url, sm) => (sm && sm.sitemaps.length && !sm.urls.length ? 'index' : CHAPTER_FILE.test(String(url).replace(/^https?:\/\/[^/]+/, '')) ? 'chapters' : 'works');
// Every URL listed, following sitemap indexes (at most maxFiles files): { file, urls, hash (of its content),
// lastmod (its date in the index that named it), parent }. skip(url, lastmod): true = don't read that file at all.
// onFile(record): what happened to each sitemap (for the Site files tab): { url, parent, kind, status ('read',
// 'skipped', 'failed', 'refused', 'not-sitemap', 'disallowed'), note, http, items, hash, lastmod, bytes, ms }
// (a file that was read is reported again by the caller with 'found' and 'unchanged' when it knows them).
// Chapter sitemaps come after the others (order), so a limit on files keeps the lists of works.
async function* walk(get, roots, { maxFiles = 2000, filter, skip, onFile, maxChapterFiles = Infinity } = {}) {
  const todo = roots.map(loc => ({ loc, lastmod: null, parent: null })), later = [], seen = new Set();
  let files = 0, chapterFiles = 0;
  const parents = new Map(); // a sitemap → the index that lists it (also when it was given as a starting point too)
  const rec = r => { if (!r.parent && parents.has(r.url)) r.parent = parents.get(r.url); if (onFile) try { onFile(r); } catch { /* informative only */ } };
  while ((todo.length || later.length) && files < maxFiles) {
    const next = todo.length ? todo.shift() : later.shift();
    const { loc: url, lastmod, parent } = next;
    if (seen.has(url)) continue;
    seen.add(url);
    const isChapterFile = CHAPTER_FILE.test(String(url).replace(/^https?:\/\/[^/]+/, ''));
    if (isChapterFile && chapterFiles >= maxChapterFiles) continue;
    if (skip && skip(url, lastmod)) { rec({ url, parent, kind: isChapterFile ? 'chapters' : 'works', status: 'skipped', lastmod, note: 'lastmod' }); continue; }
    files++; if (isChapterFile) chapterFiles++;
    let sm;
    try { sm = await readSitemap(get, url); } catch (e) {
      if (e.code === 'blocked') { rec({ url, parent, status: 'refused', note: 'bot', lastmod }); throw e; }
      if (e.code === 'stopped') throw e;
      rec({ url, parent, lastmod, http: e.status || null, status: e.code === 'robots' ? 'disallowed' : e.code === 'http' && [401, 403, 429].includes(e.status) ? 'refused' : 'failed', note: e.code === 'http' ? 'http' : String(e.message || e).slice(0, 160) });
      continue;
    }
    const kind = kindOf(url, sm);
    if (!sm.isSitemap) { rec({ url, parent, lastmod, http: sm.http, ms: sm.ms, bytes: sm.bytes, status: 'not-sitemap' }); continue; }
    rec({ url, parent, kind, lastmod, http: sm.http, ms: sm.ms, bytes: sm.bytes, hash: sm.hash, items: kind === 'index' ? sm.sitemaps.length : sm.urls.length, status: 'read', read: true });
    for (const s of sm.sitemaps) {
      if (!parents.has(s.loc)) parents.set(s.loc, url);
      if (filter && !filter(s.loc)) continue;
      const child = Object.assign({}, s, { parent: url });
      (CHAPTER_FILE.test(String(s.loc).replace(/^https?:\/\/[^/]+/, '')) ? later : todo).push(child);
    }
    if (sm.urls.length) yield { file: url, urls: sm.urls, hash: sm.hash, lastmod, parent, kind };
  }
}

/* ---------------- address patterns ---------------- */
// "/manga/*/" → a RegExp for paths: * = one path segment, ** = anything. Several patterns separated by spaces or
// commas ("/manga/*/ /manhwa/*/") match any of them.
function patternRegex(pattern) {
  if (!pattern) return null;
  const one = p => p.trim().replace(/\/+$/, '').split('/').map(seg => (seg === '**' ? '.*' : seg.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+'))).join('/');
  const parts = String(pattern).split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp('^(?:' + parts.map(one).join('|') + ')/?$', 'i');
}
// Folio's shape of a work's address: a work word, then the work's own segment (/manga/one-piece/, /series/x).
// Not a chapter, and not a generic word that every work shares (/series/view.php)
const DEFAULT_WORK_RE = /^\/(manga|series|serie|comic|comics|manhwa|manhua|webtoon|webtoons|title|titles|novel|novels|read|work|works|obra|obras|mangas)\/([^/]+)\/?$/i;
const GENERIC_SLUG = /^(?:series|manga|manhwa|manhua|comics?|webtoons?|titles?|works?|books?|view|details?|info|read|gallery|g|story|novel|item|post|index|list|page|all|latest|popular|genres?|tags?)$/i;
// Pages that list works rather than being one, whatever the pattern
const LISTING_SLUG = /^(?:page|pages|list|lists|all|latest|popular|new|newest|genres?|tags?|categor(?:y|ies)|search|index|feed|rss|sitemap|az|a-z|browse|directory|random|trending|ranking)$/i;
// "chapter-12", "chapter-12.5", "chapter-12-5" (= 12.5), "ep-3", "12" — the last segment of a chapter's address
const CHAPTER_SEGMENT = /^(?:(?:chapter|chap|ch|episode|ep|capitulo|cap)[-_.]?\d+(?:[.-]\d+)?(?:[-_.].*)?|\d+(?:\.\d+)?)$/i;
const isChapterSegment = seg => CHAPTER_SEGMENT.test(seg) || /chapter|episode|capitulo/i.test(seg);
// Is this path a work's page? The source's own patterns, plus Folio's default shape for sources set up
// automatically (or with no pattern at all)
function workMatcher(src) {
  const own = patternRegex(src.workPattern);
  const useDefault = !own || src.autoDetect === true;
  return p => {
    const last = p.split('/').filter(Boolean).pop() || '';
    if (LISTING_SLUG.test(last)) return false; // (/manga/page, /series/list: a list, not a work)
    if (own && own.test(p)) return true;
    if (!useDefault) return false;
    const m = DEFAULT_WORK_RE.exec(p);
    return Boolean(m && !GENERIC_SLUG.test(m[2]) && !isChapterSegment(m[2]));
  };
}
// From a site's sitemap addresses, Folio's way: the work words its works' addresses start with (/manga/, /series/…,
// each counted), as patterns ("/manga/*/ /manhwa/*/"); the chapters one level under them. null when no address
// has that shape (inferPatterns then guesses from the most common shapes)
function defaultPatterns(urls) {
  const byWord = new Map(), works = new Set();
  for (const u of urls) {
    const p = pathOf(u); const m = DEFAULT_WORK_RE.exec(p);
    if (m && !GENERIC_SLUG.test(m[2]) && !isChapterSegment(m[2])) { const w = m[1].toLowerCase(); byWord.set(w, (byWord.get(w) || 0) + 1); works.add(p.replace(/\/+$/, '')); }
  }
  const words = [...byWord].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  if (!words.length) return null;
  const slash = urls.some(u => { const p = pathOf(u); return DEFAULT_WORK_RE.test(p) && p.endsWith('/'); }) ? '/' : '';
  const workPattern = words.map(([w]) => `/${w}/*${slash}`).join(' ');
  // Chapters: addresses under a work whose last segment is a chapter's
  let chapters = 0; const chapterShapes = new Map();
  for (const u of urls) {
    const segs = pathOf(u).split('/').filter(Boolean);
    if (segs.length < 3 || !isChapterSegment(segs[segs.length - 1])) continue;
    if (!works.has('/' + segs.slice(0, 2).join('/')) && !byWord.has(segs[0].toLowerCase())) continue;
    chapters++;
    const shape = `/${segs[0].toLowerCase()}/${segs.slice(1).map(() => '*').join('/')}/`;
    chapterShapes.set(shape, (chapterShapes.get(shape) || 0) + 1);
  }
  const chapterPattern = [...chapterShapes].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 2).map(([t]) => t).join(' ');
  return { workPattern, works: works.size, chapterPattern: chapterPattern || null, chapters, words: words.map(([w, n]) => ({ word: w, count: n })) };
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
// Chapter sitemaps are read too (when chapters are wanted): every chapter address is matched to its work (the
// longest start of its path that is a work's address) and kept in ctx.sitemapChapters (sid → [{ u, d }]), so a
// crawl has every chapter even when a work's page shows only some (a list that loads more as it's scrolled…).
// A work listed only through its chapters is read when it's known already (ctx.knownSids) or was listed before.
async function* sitemapWorks(ctx) {
  const { src, get } = ctx;
  const isWork = workMatcher(src);
  const re = { test: isWork };
  if (!src.workPattern && src.autoDetect !== true && !ctx.defaultWorks) throw Object.assign(new Error('No address pattern for the works'), { code: 'config' });
  const chRe = patternRegex(src.chapterPattern);
  const since = ctx.incremental && src.lastCrawlAt ? Date.parse(src.lastCrawlAt) - 86400000 : 0;
  const roots = (src.sitemaps && src.sitemaps.length ? src.sitemaps : [new URL('/sitemap.xml', src.baseUrl).href]);
  // Child sitemaps that obviously list other things (tags, authors, images…) are skipped; chapter sitemaps only
  // when chapters aren't wanted
  const wantChapters = src.includeChapters !== false;
  const other = wantChapters ? 'tag|categor|author|artist|genre|image|video|news|page|post' : 'tag|categor|author|artist|genre|image|video|news|page|post|chapter|episode';
  const otherRe = new RegExp(`(${other})s?[-_]?sitemap|sitemap[-_]?(${other})`, 'i');
  const filter = loc => !otherRe.test(loc);
  const chapters = ctx.sitemapChapters = new Map();
  const known = ctx.knownSids || new Set();
  // A chapter's address: by the chapter pattern when there is one, else anything under a work that looks like a chapter
  const isChapter = p => (chRe && chRe.test(p)) || isChapterSegment(p.split('/').filter(Boolean).pop() || '');
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
  const slash = /\/(\s|$)/.test(src.workPattern || '') ? '/' : '';
  const seen = new Set();
  // What happened to each sitemap (the Site files tab): ctx.discovery = { url: record }
  const log = ctx.discovery = ctx.discovery || {};
  const onFile = r => { log[r.url] = Object.assign(log[r.url] || {}, r, { at: new Date().toISOString() }); };
  for await (const { file, urls, hash, lastmod } of walk(get, roots, { filter, skip, onFile })) {
    counts.files++;
    const entries = new Map(); // sid → { url, lastmod, parts }
    const entry = sid => { if (!entries.has(sid)) entries.set(sid, { url: null, lastmod: null, parts: [] }); return entries.get(sid); };
    for (const u of urls) {
      const p = pathOf(u.loc);
      if (re.test(p)) { const e = entry(p.replace(/\/+$/, '')); e.url = u.loc; e.lastmod = u.lastmod || null; e.parts.push('=' + (u.lastmod || '')); continue; }
      const sid = wantChapters && isChapter(p) ? workOf(p) : null;
      if (sid) {
        entry(sid).parts.push(p + ' ' + (u.lastmod || ''));
        if (!chapters.has(sid)) chapters.set(sid, []);
        chapters.get(sid).push({ u: u.loc, d: u.lastmod || '' });
        counts.chapters = (counts.chapters || 0) + 1;
      }
    }
    const works = {};
    for (const [sid, e] of entries) works[sid] = hashOf(e.parts.sort().join('\n')).slice(0, 16);
    next.files[file] = { hash, lastmod: lastmod || null, works };
    const old = prev && prev.files[file];
    const nWorks = [...entries.values()].filter(e => e.url).length;
    const kind = /chapter|episode|capitulo/i.test(file.replace(/^https?:\/\/[^/]+/, '')) || (!nWorks && entries.size) ? 'chapters' : 'works';
    Object.assign(log[file] || (log[file] = {}), { kind, found: kind === 'chapters' ? urls.length - nWorks : nWorks, changed: !(old && old.hash === hash), firstRead: !old });
    if (delta && old && old.hash === hash) { counts.unchanged++; log[file].status = 'unchanged'; continue; }
    const page = [];
    for (const [sid, e] of entries) {
      // (a work seen only through its chapters is read only when it was listed before)
      if (seen.has(sid) || (!e.url && !(old && old.works && sid in old.works) && !known.has(sid))) continue;
      seen.add(sid);
      if (delta && old) { if (old.works && old.works[sid] === works[sid]) continue; }
      else if (since && e.lastmod && Date.parse(e.lastmod) < since) continue;
      const url = e.url || new URL(sid + slash, file).href; // (only its chapters are listed here)
      page.push({ sid, url, title: titleFromSlug(url), lastmod: e.lastmod });
    }
    for (let i = 0; i < page.length; i += 100) yield page.slice(i, i + 100);
  }
}

module.exports = { looksLikeSitemap, parseSitemap, readSitemap, walk, patternRegex, inferPatterns, defaultPatterns, workMatcher, isChapterSegment, DEFAULT_WORK_RE, templateOf, titleFromSlug, sitemapWorks, pathOf, contentHash };
