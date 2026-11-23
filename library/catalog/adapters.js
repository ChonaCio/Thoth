// Source types: how to list a site's works and read one work (metadata + chapter list).
//   listWorks(ctx)       async generator of pages: [{ sid, url, title?, cover? }]
//   fetchWork(ctx, stub) → { sid, url, title, altTitles, cover, summary, authors, genres, tags, status, type, year,
//                            chapters: [{ id, n, t, u, d, l, v }] | null, partial? }  (n number, t title, u url,
//                            d date, l language, v volume)
// ctx: { src (the source's settings), get (the polite fetcher), known (chapter ids already stored), incremental }
const { parse } = require('./html');

const abs = (u, base) => { try { return u ? new URL(u, base).href : null; } catch { return null; } };
const num = s => { const m = /(\d+(?:\.\d+)?)/.exec(String(s || '')); return m ? m[1].replace(/^0+(?=\d)/, '') : null; };
const chapterNum = s => { const m = /(?:ch(?:apter|ap)?\.?|ep(?:isode)?\.?|#)\s*(\d+(?:\.\d+)?)/i.exec(String(s || '')); return m ? m[1].replace(/^0+(?=\d)/, '') : num(s); };
const list = v => [...new Set((v || []).map(x => String(x).trim()).filter(Boolean))];
const splitAlt = s => list(String(s || '').split(/\s*(?:[,;\/|]|\n)\s*/));
const STATUS = s => { s = String(s || '').toLowerCase(); return /complete|finished|ended|end\b/.test(s) ? 'ended' : /hiatus|on hold/.test(s) ? 'hiatus' : /cancel|dropped|abandon/.test(s) ? 'abandoned' : /ongoing|publishing|releasing|updat|every/.test(s) ? 'ongoing' : 'unknown'; };
const imgOf = el => el && (el.attr('data-src') || el.attr('data-lazy-src') || el.attr('data-original') || (el.attr('srcset') || '').split(/\s+/)[0] || el.attr('src'));
// "selector" → text, "selector@attr" → that attribute; several selectors tried in order (||)
function pick(doc, spec, base, all = false) {
  if (!spec) return all ? [] : null;
  for (const one of String(spec).split('||').map(s => s.trim()).filter(Boolean)) {
    const at = one.lastIndexOf('@');
    const sel = at > 0 && !/[\]\)]$/.test(one.slice(at)) ? one.slice(0, at) : one;
    const attr = at > 0 && sel !== one ? one.slice(at + 1) : null;
    const els = doc.select(sel);
    const vals = els.map(e => (attr ? (attr === 'src' ? imgOf(e) : e.attr(attr)) : e.text())).filter(v => v != null && String(v).trim() !== '').map(v => (attr === 'href' || attr === 'src' ? abs(v, base) : String(v).trim()));
    if (vals.length) return all ? list(vals) : vals[0];
  }
  return all ? [] : null;
}
// What most work pages carry besides the theme's own markup: the cover (Open Graph / Twitter / schema.org image)
// and other titles (schema.org alternateName, a row labeled "Alternative", "Also known as", "Other names"…).
// Fills only what the adapter didn't find.
const ALT_LABEL = /^\s*(?:alternative(?: titles?| names?)?|alt(?:ernate)?\.? ?(?:titles?|names?)|other names?|also known as|aka|associated names?|synonyms?|nombres? alternativos?|t[ií]tulos? alternativos?|autres? (?:titres?|noms?)|alternativtitel|t[ií]tulos? alternativos?)\s*:?\s*/i;
function enrich(doc, work, base) {
  const meta = p => (doc.first(`meta[property="${p}"]`) || doc.first(`meta[name="${p}"]`) || { attr: () => null }).attr('content');
  let ld = [];
  for (const s of doc.select('script[type="application/ld+json"]')) {
    try { const j = JSON.parse(s.textBlock()); ld = ld.concat(Array.isArray(j) ? j : j['@graph'] || [j]); } catch { /* not JSON */ }
  }
  const book = ld.find(x => x && /Book|Comic|Series|CreativeWork/i.test([].concat(x['@type'] || []).join())) || {};
  if (!work.cover) {
    const img = [].concat(book.image || [])[0];
    work.cover = abs((img && (img.url || img)) || meta('og:image') || meta('twitter:image') || pick(doc, '[itemprop=image]@src || [itemprop=image]@content', base), base) || work.cover || null;
  }
  if (!work.altTitles || !work.altTitles.length) {
    let alt = [].concat(book.alternateName || book.alternativeHeadline || []);
    if (!alt.length) {
      // A labeled row: "<b>Alternative:</b> A, B" or "<dt>Other names</dt><dd>A; B</dd>"
      const row = doc.select('li, tr, p, div.info-item, .post-content_item, dl, .imptdt, span.alt, div').find(el => el.el.children.length < 12 && ALT_LABEL.test(el.text()) && el.text().length < 600);
      if (row) alt = splitAlt(row.text().replace(ALT_LABEL, ''));
    }
    work.altTitles = list(alt).filter(t => t !== work.title).slice(0, 30);
  }
  return work;
}

// Chapter lists that show only the last chapters until "Show more" / "Load all" is pressed, or that come in
// pages: the links or buttons that lead to the rest (an address in href, data-url or data-href), followed up to
// maxPages times. readPage(doc, url) → chapters of that page. Returns the chapters of every page, once each.
const MORE_TEXT = /show (?:all|more)|load (?:all|more)|view all|see all|all chapters|more chapters|ver (?:todos|m[aá]s)|cargar m[aá]s|voir (?:tout|plus)|alle anzeigen|mehr laden/i;
const MORE_CLASS = /load-?more|show-?more|view-?all|see-?all|readmore|chapter-?more|btn-more/i;
async function withHiddenChapters(ctx, doc, url, readPage, { maxPages = 20 } = {}) {
  const seen = new Set(), out = [];
  const add = list => { for (const c of list) if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); } };
  add(readPage(doc, url));
  const visited = new Set([url.replace(/#.*$/, '')]);
  const moreLinks = (d, base) => d.select('a[href], button, [data-url], [data-href], [data-load]').map(el => {
    const text = el.text(), cls = (el.attr('class') || '') + ' ' + (el.attr('id') || '');
    const rel = (el.attr('rel') || '').toLowerCase();
    if (!(MORE_TEXT.test(text) || MORE_CLASS.test(cls) || (rel === 'next' && el.el.tag === 'a'))) return null;
    const href = el.attr('data-url') || el.attr('data-href') || el.attr('data-load') || el.attr('href');
    if (!href || /^(?:#|javascript:)/i.test(href)) return null;
    const u = abs(href, base);
    try { return new URL(u).origin === new URL(url).origin ? u.replace(/#.*$/, '') : null; } catch { return null; }
  }).filter(Boolean);
  let todo = moreLinks(doc, url);
  for (let n = 0; todo.length && n < maxPages; n++) {
    const next = todo.shift();
    if (visited.has(next)) continue;
    visited.add(next);
    let res;
    try { res = await ctx.get(next, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }); } catch (e) { if (e.code === 'blocked' || e.code === 'stopped') throw e; continue; }
    const d = parse(res.text);
    const before = out.length;
    add(readPage(d, res.url));
    if (out.length > before) todo = todo.concat(moreLinks(d, res.url)); // (a page that brought nothing new ends that path)
  }
  return out;
}

// Stop listing a site once a page brings nothing new (sites repeat their last page past the end)
function freshOnly(seen, items) { const out = items.filter(x => x.sid && !seen.has(x.sid)); out.forEach(x => seen.add(x.sid)); return out; }

/* ---------------- MangaDex (official API) ---------------- */
const mangadex = {
  type: 'mangadex', label: 'MangaDex (API)', defaults: { baseUrl: 'https://api.mangadex.org', gapMs: 250, languages: 'en' },
  site: 'https://mangadex.org',
  params(src) {
    const p = new URLSearchParams({ limit: '100', 'order[createdAt]': 'asc' });
    for (const r of (src.contentRating || 'safe,suggestive,erotica').split(',').map(s => s.trim()).filter(Boolean)) p.append('contentRating[]', r);
    for (const l of langs(src)) p.append('availableTranslatedLanguage[]', l);
    ['cover_art', 'author', 'artist'].forEach(x => p.append('includes[]', x));
    return p;
  },
  async *listWorks(ctx) {
    const { src, get } = ctx;
    // The API stops at 10 000 results per query: walk by creation date instead of by offset
    let since = (ctx.incremental && src.lastCrawlAt) ? null : '2000-01-01T00:00:00';
    const seen = new Set();
    for (;;) {
      const p = mangadex.params(src);
      if (ctx.incremental && src.lastCrawlAt) { p.delete('order[createdAt]'); p.set('order[updatedAt]', 'asc'); p.set('updatedAtSince', (since || src.lastCrawlAt).replace(/\.\d+Z?$|Z$|\+.*$/, '').slice(0, 19)); }
      else p.set('createdAtSince', since);
      const r = (await get(`${src.baseUrl}/manga?${p}`, { accept: 'application/json' })).json();
      const items = (r.data || []).map(m => mangadex.work(m));
      const fresh = freshOnly(seen, items);
      if (fresh.length) yield fresh;
      if ((r.data || []).length < 100 || !fresh.length) return;
      const last = r.data[r.data.length - 1].attributes;
      since = String(ctx.incremental && src.lastCrawlAt ? last.updatedAt : last.createdAt).replace(/\+.*$/, '').slice(0, 19);
    }
  },
  work(m) {
    const a = m.attributes || {};
    const rel = t => (m.relationships || []).filter(r => r.type === t && r.attributes);
    const cover = rel('cover_art')[0];
    const titles = Object.values(a.title || {});
    const alt = (a.altTitles || []).flatMap(o => Object.values(o));
    return {
      sid: m.id, url: `https://mangadex.org/title/${m.id}`, title: a.title && (a.title.en || titles[0]) || '',
      altTitles: list(titles.concat(alt)).filter(t => t !== (a.title && (a.title.en || titles[0]))).slice(0, 30),
      cover: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes.fileName}.256.jpg` : null,
      summary: (a.description && (a.description.en || Object.values(a.description)[0])) || '',
      authors: list(rel('author').map(r => r.attributes.name).concat(rel('artist').map(r => r.attributes.name))),
      genres: list((a.tags || []).filter(t => t.attributes && t.attributes.group === 'genre').map(t => t.attributes.name.en)),
      tags: list((a.tags || []).filter(t => t.attributes && t.attributes.group !== 'genre').map(t => t.attributes.name.en)),
      status: { ongoing: 'ongoing', completed: 'ended', hiatus: 'hiatus', cancelled: 'abandoned' }[a.status] || 'unknown',
      type: { ja: 'manga', ko: 'manhwa', zh: 'manhua', 'zh-hk': 'manhua' }[a.originalLanguage] || null,
      year: a.year || null, languages: a.availableTranslatedLanguages || [], links: { mangadex: m.id }, full: true
    };
  },
  async fetchWork(ctx, stub) {
    const { src, get } = ctx;
    const work = Object.assign({}, stub);
    if (!src.includeChapters) return work;
    const want = langs(src);
    if (want.length && stub.languages && !stub.languages.some(l => want.includes(l))) { work.chapters = []; return work; }
    const chapters = [];
    for (let offset = 0; offset < 10000; offset += 500) {
      const p = new URLSearchParams({ limit: '500', offset: String(offset), 'order[chapter]': 'asc', includeExternalUrl: '1' });
      want.forEach(l => p.append('translatedLanguage[]', l));
      for (const r of (src.contentRating || 'safe,suggestive,erotica').split(',').map(s => s.trim()).filter(Boolean)) p.append('contentRating[]', r);
      const r = (await get(`${src.baseUrl}/manga/${stub.sid}/feed?${p}`, { accept: 'application/json' })).json();
      for (const c of r.data || []) {
        const a = c.attributes || {};
        chapters.push({ id: c.id, n: a.chapter || null, t: a.title || '', u: a.externalUrl || `https://mangadex.org/chapter/${c.id}`, d: (a.publishAt || '').slice(0, 10), l: a.translatedLanguage, v: a.volume || null });
      }
      if ((r.data || []).length < 500 || offset + 500 >= (r.total || 0)) break;
    }
    work.chapters = chapters;
    return work;
  }
};
function langs(src) { return String(src.languages || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }

/* ---------------- WEBTOON (Originals) ---------------- */
const webtoons = {
  type: 'webtoons', label: 'WEBTOON (Originals)', defaults: { baseUrl: 'https://www.webtoons.com', gapMs: 1500, languages: 'en' },
  async *listWorks(ctx) {
    const { src, get } = ctx;
    const lang = langs(src)[0] || 'en';
    const page = await get(`${src.baseUrl}/${lang}/genres`);
    const doc = parse(page.text);
    const seen = new Set();
    const items = doc.select('a[href*="/list?title_no="]').map(a => {
      const href = abs(a.attr('href'), page.url);
      const id = /title_no=(\d+)/.exec(href || '');
      return id ? { sid: id[1], url: href.replace(/&page=\d+/, ''), title: (a.first('.title') || a.first('.subj') || a).text(), cover: imgOf(a.first('img')), authors: splitAlt((a.first('.author') || { text: () => '' }).text()) } : null;
    }).filter(Boolean);
    const fresh = freshOnly(seen, items);
    for (let i = 0; i < fresh.length; i += 50) yield fresh.slice(i, i + 50);
  },
  async fetchWork(ctx, stub) {
    const { src, get } = ctx;
    const first = await get(stub.url);
    const doc = parse(first.text);
    const meta = p => (doc.first(`meta[property="${p}"]`) || { attr: () => null }).attr('content');
    const day = (doc.first('.day_info') || { text: () => '' }).text();
    const author = doc.first('.author_area');
    const work = Object.assign({}, stub, {
      title: meta('og:title') || stub.title, cover: meta('og:image') || stub.cover,
      summary: (doc.first('p.summary') || { text: () => meta('og:description') || '' }).text(),
      genres: list(doc.select('h2.genre, .genre').map(g => g.text())).slice(0, 3),
      authors: author ? splitAlt(author.text().replace(/author info/i, '')) : stub.authors || [],
      status: /complete/i.test(day) ? 'ended' : /every|up/i.test(day) ? 'ongoing' : 'unknown', type: 'webcomic'
    });
    if (!src.includeChapters) return work;
    // Episode list: 10 per page, newest first. Pages robots.txt doesn't allow are skipped (the list is then partial).
    const chapters = [], ids = new Set();
    let partial = false;
    const take = d => {
      let added = 0, knownHit = false;
      for (const li of d.select('li._episodeItem')) {
        const id = li.attr('data-episode-no');
        if (!id || ids.has(id)) continue;
        if (ctx.known && ctx.known.has(id)) knownHit = true;
        ids.add(id);
        const a = li.first('a');
        const title = (li.first('.subj span') || li.first('.subj') || { text: () => '' }).text();
        chapters.push({ id, n: chapterNum(title) || id, t: title, u: a ? abs(a.attr('href'), stub.url) : null, d: (li.first('.date') || { text: () => '' }).text(), l: langs(src)[0] || 'en' });
        added++;
      }
      return { added, knownHit };
    };
    let r = take(doc);
    const maxPage = Math.max(1, ...[...first.text.matchAll(/[?&](?:amp;)?page=(\d+)/g)].map(m => Number(m[1])));
    const lastEp = Number((doc.first('li._episodeItem') || { attr: () => 0 }).attr('data-episode-no')) || 0;
    const pages = Math.max(maxPage, Math.ceil(lastEp / 10) + 1);
    for (let p = 2; p <= pages && p <= 500; p++) {
      if (ctx.incremental && r.knownHit) break; // the rest is already stored
      const url = `${stub.url}${stub.url.includes('?') ? '&' : '?'}page=${p}`;
      try { const d = parse((await get(url)).text); r = take(d); if (!r.added) break; }
      catch (e) { if (e.code === 'robots') { partial = true; continue; } throw e; }
    }
    work.chapters = chapters;
    if (partial) work.partial = true;
    return work;
  }
};

/* ---------------- WordPress "Madara" theme (many manga/scanlation sites) ---------------- */
const madara = {
  type: 'madara', label: 'Madara theme (WordPress)', defaults: { gapMs: 1500 },
  async *listWorks(ctx) {
    const { src, get } = ctx;
    const base = src.baseUrl.replace(/\/+$/, '');
    const dir = (src.listPath || 'manga').replace(/^\/|\/$/g, '');
    const seen = new Set();
    for (let page = 1; page <= 5000; page++) {
      const order = ctx.incremental ? 'latest' : 'new-manga';
      const url = page === 1 ? `${base}/${dir}/?m_orderby=${order}` : `${base}/${dir}/page/${page}/?m_orderby=${order}`;
      let res;
      try { res = await get(url); } catch (e) { if (e.code === 'http' && e.status === 404) return; throw e; }
      const doc = parse(res.text);
      const items = doc.select('.page-item-detail, .c-tabs-item__content, .manga-item, .badge-pos-1').map(it => {
        const a = it.first('.post-title a') || it.first('h3 a') || it.first('h5 a') || it.first('a[href]');
        const href = a && abs(a.attr('href'), res.url);
        return href ? { sid: href.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, ''), url: href, title: a.text() || a.attr('title'), cover: abs(imgOf(it.first('img')), res.url) } : null;
      }).filter(Boolean);
      const fresh = freshOnly(seen, items);
      if (!fresh.length) return;
      yield fresh;
    }
  },
  async fetchWork(ctx, stub) {
    const { src, get } = ctx;
    const res = await get(stub.url);
    const doc = parse(res.text);
    const item = label => {
      const row = doc.select('.post-content_item, .post-status .post-content_item').find(r => new RegExp(label, 'i').test((r.first('.summary-heading') || { text: () => '' }).text()));
      return row ? (row.first('.summary-content') || row).text() : '';
    };
    const work = Object.assign({}, stub, {
      title: pick(doc, '.post-title h1 || .post-title h3 || h1', res.url) || stub.title,
      cover: pick(doc, '.summary_image img@src', res.url) || stub.cover,
      summary: (doc.first('.summary__content') || doc.first('.description-summary') || doc.first('.manga-excerpt') || { textBlock: () => '' }).textBlock(),
      authors: list(pick(doc, '.author-content a', res.url, true).concat(pick(doc, '.artist-content a', res.url, true))),
      genres: pick(doc, '.genres-content a', res.url, true), altTitles: splitAlt(item('Alternative')),
      status: STATUS(item('Status')), type: (/(manhwa|manhua|manga|webtoon|comic)/i.exec(item('Type')) || [])[1] ? item('Type').toLowerCase().replace('webtoon', 'webcomic') : null
    });
    enrich(doc, work, res.url);
    if (!src.includeChapters) return work;
    let rows = doc.select('li.wp-manga-chapter');
    const fromPage = rows.length > 0;
    if (!rows.length) {
      // Newer Madara: chapters come from {work}/ajax/chapters/; older: admin-ajax.php with the manga id
      try { rows = parse((await get(stub.url.replace(/\/?$/, '/') + 'ajax/chapters/', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } })).text).select('li.wp-manga-chapter'); } catch (e) { if (e.code === 'blocked') throw e; }
      if (!rows.length) {
        const holder = doc.first('#manga-chapters-holder[data-id]') || doc.first('[data-post-id]');
        const id = holder && (holder.attr('data-id') || holder.attr('data-post-id'));
        if (id) {
          try {
            rows = parse((await get(`${src.baseUrl.replace(/\/+$/, '')}/wp-admin/admin-ajax.php`, { method: 'POST', body: `action=manga_get_chapters&manga=${encodeURIComponent(id)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } })).text).select('li.wp-manga-chapter');
          } catch (e) { if (e.code === 'blocked') throw e; }
        }
      }
    }
    const madaraRows = (list, base) => list.map(li => {
      const a = li.first('a');
      const u = a && abs(a.attr('href'), base);
      const t = a ? a.text() : '';
      return u ? { id: u.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, ''), n: chapterNum(t), t, u, d: (li.first('.chapter-release-date') || { text: () => '' }).text(), l: langs(src)[0] || null } : null;
    }).filter(Boolean);
    // (a list on the page itself may go on in other pages or behind "show more")
    work.chapters = fromPage ? await withHiddenChapters(ctx, doc, res.url, (d, base) => madaraRows(d.select('li.wp-manga-chapter'), base)) : madaraRows(rows, res.url);
    return work;
  }
};

/* ---------------- WordPress "MangaReader" (Themesia) theme ---------------- */
const mangareader = {
  type: 'mangareader', label: 'MangaReader theme (WordPress)', defaults: { gapMs: 1500 },
  async *listWorks(ctx) {
    const { src, get } = ctx;
    const base = src.baseUrl.replace(/\/+$/, '');
    const dir = (src.listPath || 'manga').replace(/^\/|\/$/g, '');
    const seen = new Set();
    for (let page = 1; page <= 5000; page++) {
      const url = `${base}/${dir}/?page=${page}&order=${ctx.incremental ? 'update' : 'latest'}`;
      let res;
      try { res = await get(url); } catch (e) { if (e.code === 'http' && e.status === 404) return; throw e; }
      const doc = parse(res.text);
      const items = doc.select('.listupd .bs .bsx a, .listupd .bsx > a').map(a => {
        const href = abs(a.attr('href'), res.url);
        return href ? { sid: href.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, ''), url: href, title: a.attr('title') || (a.first('.tt') || a).text(), cover: abs(imgOf(a.first('img')), res.url) } : null;
      }).filter(Boolean);
      const fresh = freshOnly(seen, items);
      if (!fresh.length) return;
      yield fresh;
    }
  },
  async fetchWork(ctx, stub) {
    const { src, get } = ctx;
    const res = await get(stub.url);
    const doc = parse(res.text);
    const info = label => {
      const row = doc.select('.imptdt, .tsinfo .imptdt, .infotable tr, .fmed').find(r => new RegExp(label, 'i').test(r.text()));
      if (!row) return '';
      return (row.first('i') || row.first('a') || row.first('td:last-child') || row.first('span') || row).text().replace(new RegExp('^' + label + '\\s*:?', 'i'), '').trim();
    };
    const work = Object.assign({}, stub, {
      title: pick(doc, 'h1.entry-title || h1', res.url) || stub.title,
      cover: pick(doc, '.thumb img@src || .thumbook img@src', res.url) || stub.cover,
      summary: (doc.first('[itemprop=description]') || doc.first('.entry-content-single') || doc.first('.synp .entry-content') || { textBlock: () => '' }).textBlock(),
      genres: pick(doc, '.mgen a || .seriestugenre a || .genxed a', res.url, true),
      altTitles: splitAlt((doc.first('.alternative') || doc.first('.seriestualt') || { text: () => '' }).text()),
      authors: splitAlt(info('Author') + ',' + info('Artist')), status: STATUS(info('Status')),
      type: (/(manhwa|manhua|manga|comic)/i.exec(info('Type')) || [])[1] ? info('Type').toLowerCase() : null
    });
    enrich(doc, work, res.url);
    if (!src.includeChapters) return work;
    work.chapters = doc.select('#chapterlist li, .eplister li').map(li => {
      const a = li.first('a');
      const u = a && abs(a.attr('href'), res.url);
      const t = (li.first('.chapternum') || a || li).text();
      return u ? { id: u.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, ''), n: li.attr('data-num') || chapterNum(t), t, u, d: (li.first('.chapterdate') || { text: () => '' }).text(), l: langs(src)[0] || null } : null;
    }).filter(Boolean);
    return work;
  }
};

/* ---------------- Any other site: selectors given in the source settings ---------------- */
// src.selectors: { listUrl ("…{page}…"), firstPage, item, link, title, cover, workTitle, workCover, summary, genres,
//   authors, altTitles, status, chapter, chapterLink, chapterTitle, chapterDate }  ("sel@attr", "a || b")
const custom = {
  type: 'custom', label: 'Other site (selectors)', defaults: { gapMs: 2000 },
  async *listWorks(ctx) {
    const { src, get } = ctx;
    const s = src.selectors || {};
    if (!s.listUrl || !s.item) throw Object.assign(new Error('The list address and the work selector are needed'), { code: 'config' });
    const seen = new Set();
    const start = Number(s.firstPage) || 1;
    for (let page = start; page < start + 5000; page++) {
      const url = abs(s.listUrl.replace('{page}', page), src.baseUrl);
      let res;
      try { res = await get(url); } catch (e) { if (e.code === 'http' && e.status === 404 && page > start) return; throw e; }
      const doc = parse(res.text);
      const items = doc.select(s.item).map(it => {
        const a = s.link ? it.first(s.link.split('@')[0]) : (it.el.tag === 'a' ? it : it.first('a[href]'));
        const href = a && abs(a.attr(s.link && s.link.includes('@') ? s.link.split('@')[1] : 'href'), res.url);
        return href ? { sid: href.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, ''), url: href, title: s.title ? pick(it, s.title, res.url) : (a.attr('title') || a.text()), cover: s.cover ? pick(it, s.cover, res.url) : abs(imgOf(it.first('img')), res.url) } : null;
      }).filter(Boolean);
      const fresh = freshOnly(seen, items);
      if (!fresh.length) return;
      yield fresh;
      if (!s.listUrl.includes('{page}')) return;
    }
  },
  async fetchWork(ctx, stub) {
    const { src, get } = ctx;
    const s = src.selectors || {};
    const res = await get(stub.url);
    const doc = parse(res.text);
    const meta = p => (doc.first(`meta[property="${p}"]`) || { attr: () => null }).attr('content');
    const work = Object.assign({}, stub, {
      title: pick(doc, s.workTitle, res.url) || meta('og:title') || pick(doc, 'h1', res.url) || stub.title,
      cover: pick(doc, s.workCover, res.url) || abs(meta('og:image'), res.url) || stub.cover,
      summary: s.summary ? (doc.first(s.summary) || { textBlock: () => '' }).textBlock() : (meta('og:description') || ''),
      genres: pick(doc, s.genres, res.url, true), authors: pick(doc, s.authors, res.url, true),
      altTitles: s.altTitles ? splitAlt(pick(doc, s.altTitles, res.url)) : [], status: STATUS(pick(doc, s.status, res.url))
    });
    enrich(doc, work, res.url);
    if (!src.includeChapters) return work;
    if (!s.chapter) {
      // No chapter selector: every link on the page whose address matches the chapters' pattern
      const re = src.chapterPattern ? require('./sitemap').patternRegex(src.chapterPattern) : null;
      if (!re) return work;
      const seen = new Set();
      work.chapters = await withHiddenChapters(ctx, doc, res.url, (d, base) => d.select('a[href]').map(a => {
        const u = abs(a.attr('href'), base);
        let p; try { p = decodeURI(new URL(u).pathname); } catch { return null; }
        if (!u || !re.test(p) || seen.has(p)) return null;
        seen.add(p);
        const t = a.text() || p.split('/').filter(Boolean).pop().replace(/[-_]+/g, ' ');
        return { id: p.replace(/\/+$/, ''), n: chapterNum(t) || chapterNum(p.split('/').filter(Boolean).pop()), t, u, d: '', l: langs(src)[0] || null };
      }).filter(Boolean));
      return work;
    }
    work.chapters = await withHiddenChapters(ctx, doc, res.url, (d, base) => d.select(s.chapter).map(li => {
      const link = s.chapterLink || 'a@href';
      const [lsel, lat] = link.includes('@') ? link.split('@') : [link, 'href'];
      const a = lsel ? li.first(lsel) : li;
      const u = a && abs(a.attr(lat || 'href'), base);
      const t = s.chapterTitle ? pick(li, s.chapterTitle, base) : (a ? a.text() : li.text());
      return u ? { id: u.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, ''), n: chapterNum(t), t, u, d: s.chapterDate ? pick(li, s.chapterDate, base) || '' : '', l: langs(src)[0] || null } : null;
    }).filter(Boolean));
    return work;
  }
};

const ADAPTERS = { mangadex, webtoons, madara, mangareader, custom };
const TYPES = Object.keys(ADAPTERS);
module.exports = { ADAPTERS, TYPES, pick, chapterNum, STATUS };
