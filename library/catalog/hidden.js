// Complete chapter lists for work pages that show only part of them (after Folio's crawler). Crawls don't run a
// site's scripts, so the same data the page's script would load is read directly, in this order:
//   1. the source's "Full chapter list URL" (src.chaptersUrl): {url} {slug} {id} {page} {skip} {take} {cursor}
//   2. chapter arrays already in the page: Next.js (__NEXT_DATA__), Angular state (ng-state), Inertia (data-page),
//      JSON scripts
//   3. where the page's script loads the list from: an attribute holding an address template
//      (data-api-url="…/api/manga/__SLUG__/chapters" with data-comic-slug="…"), or an address built in an inline
//      script ("/ajax/series/" + id + "/episodes")
//   4. the site's chapter API, from the API address and the work's id in the page ({api}/api/chapters?postId=…)
// Paging is followed the way such answers say it: a next link, offset/limit (skip/take) with a total or has_more,
// page/last_page, or a cursor. Every request goes through ctx.get (robots.txt of each host, the site's pace).
// complete(ctx, { doc, html, url, have }) → { chapters: [{ id, n, t, u, d, pr }], via } or null
const MAX_REQUESTS = 30;

const abs = (u, base) => { try { return new URL(String(u).replace(/\\\//g, '/'), base).href; } catch { return ''; } };
const uniq = list => [...new Set(list.filter(Boolean))];
const normKey = k => String(k).toLowerCase().replace(/^data-/, '').replace(/[^a-z0-9]/g, '');

/* ---------------- chapters from JSON ---------------- */
const NUM_KEYS = ['number', 'chapterNumber', 'chapter_number', 'chapterNum', 'chapter_num', 'chapter', 'chap', 'num', 'chapterNo', 'chapter_no', 'episodeNumber', 'episode_number', 'episodeNo', 'episode_no'];
const ORDER_KEYS = ['ord', 'order', 'sequence', 'seq'];
const DATE_KEYS = ['publishedAt', 'published_at', 'releasedAt', 'released_at', 'releaseDate', 'release_date', 'createdAt', 'created_at', 'uploadedAt', 'uploaded_at', 'postedAt', 'posted_at', 'date', 'created', 'published', 'updatedAt', 'updated_at'];
const CHAPTER_PATH = /(?:^|[/_-])(?:chapter|chap|ch|episode|ep)[-_/.]?(\d+(?:\.\d+|-\d(?!\d))?)(?:[/_.-]|$)/i;
const CHAPTER_TEXT = /(?:chapter|chap\.?|ch\.?|episode|ep\.?)\s*#?\s*(\d+(?:\.\d+)?)/i;
const jsonTitle = o => [o.title, o.name, o.chapter_name, o.chapterName, o.chapter_title, o.chapterTitle, o.data && o.data.title, o.attributes && o.attributes.title].find(v => typeof v === 'string') || '';
const slugOf = o => { for (const k of ['slug', 'chapter_slug', 'chapterSlug', 'chap_slug', 'episode_slug', 'episodeSlug', 'slug_name']) if (typeof o[k] === 'string' && o[k]) return o[k]; return ''; };
const numOf = v => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? parseFloat(v) : NaN);
function chapterNumber(o) {
  for (const k of NUM_KEYS) { const n = numOf(o[k]); if (!Number.isNaN(n)) return n; }
  for (const k of ORDER_KEYS) { const n = numOf(o[k]); if (!Number.isNaN(n) && n >= 0 && (jsonTitle(o) || o.id !== undefined)) return n; }
  const s = String(slugOf(o) || jsonTitle(o) || '');
  const m = s.match(CHAPTER_PATH) || s.match(CHAPTER_TEXT);
  return m ? parseFloat(m[1].replace('-', '.')) : NaN;
}
// The largest array of chapter-like objects anywhere in a JSON value
function findChapterArray(root) {
  let best = null;
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 12 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      const objs = v.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length) {
        const good = objs.filter(o => !Number.isNaN(chapterNumber(o)) && (slugOf(o) || o.url || o.link || o.href || o.permalink || o.id !== undefined || o.chapter_id !== undefined));
        if (good.length >= Math.max(1, objs.length * 0.6) && (!best || good.length > best.length)) best = good;
      }
      v.forEach(x => walk(x, depth + 1));
    } else Object.values(v).forEach(x => walk(x, depth + 1));
  };
  walk(root, 0);
  return best || [];
}
const lockedJson = o => {
  if (o.isAccessible === true || o.is_accessible === true || o.isFree === true || o.is_free === true || o.free === true) return false;
  const price = Number(o.price || o.coins || o.coin || o.cost || 0);
  return o.isLocked === true || o.is_locked === true || o.locked === true || o.isPremium === true || o.is_premium === true || o.premium === true ||
    o.isPaid === true || o.is_paid === true || o.paid === true || o.isAccessible === false || (price > 0 && o.isLocked !== false && o.locked !== false);
};
// Chapter objects → chapters. Addresses from url/link fields, a template, or learned from the chapter links the page
// shows (`sample`: prefix + slug, or the number's place in the address)
function chaptersFromJson(data, { seriesUrl, sample = [], urlTemplate = '' }) {
  const items = Array.isArray(data) && data.length && data.every(x => x && typeof x === 'object' && !Number.isNaN(chapterNumber(x))) ? data : findChapterArray(data);
  if (!items.length) return [];
  const base = seriesUrl.replace(/[?#].*$/, '').replace(/\/$/, '');
  let prefix = base + '/', numTemplate = '';
  const byNum = new Map(items.map(o => [chapterNumber(o), o]));
  for (const c of sample) {
    const o = byNum.get(parseFloat(c.n)), os = o && slugOf(o);
    if (os && c.u && c.u.replace(/\/$/, '').endsWith('/' + os)) { prefix = c.u.replace(/\/$/, '').slice(0, -String(os).length); break; }
    if (!numTemplate && c.u && c.n != null) { const n = String(c.n), i = c.u.lastIndexOf(n); if (i > 0) numTemplate = c.u.slice(0, i) + '{n}' + c.u.slice(i + n.length); }
  }
  const out = [];
  for (const o of items) {
    const number = chapterNumber(o), os = slugOf(o);
    let url = '';
    const direct = o.url || o.link || o.href || o.permalink;
    if (typeof direct === 'string' && direct) url = abs(direct, base + '/');
    else if (urlTemplate) url = abs(urlTemplate.replace(/\{chapter\}/g, os || String(o.id != null ? o.id : number)).replace(/\{series\}/g, base).replace(/\{id\}/g, String(o.id != null ? o.id : number)).replace(/\{n\}/g, String(number)), base + '/');
    else if (os) url = /^https?:/i.test(os) ? os : prefix + os.replace(/^\//, '');
    else if (numTemplate) url = numTemplate.replace('{n}', String(number));
    if (!url) continue;
    let d = '';
    for (const k of DATE_KEYS) { const v = o[k]; if (v == null || v === '') continue; const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v); if (Number.isFinite(t)) { d = new Date(t).toISOString().slice(0, 10); break; } }
    let id; try { id = decodeURI(new URL(url).pathname).replace(/\/+$/, ''); } catch { id = url; }
    out.push({ id, n: Number.isNaN(number) ? null : String(number), t: jsonTitle(o) || (Number.isNaN(number) ? '' : 'Chapter ' + number), u: url, d, l: null, pr: lockedJson(o) || undefined });
  }
  return out;
}
// Paging info of a JSON answer: { cursor, hasMore, next, total, offset, limit, page, lastPage }
function jsonPaging(data) {
  const out = { cursor: null, hasMore: false, next: '', total: null, offset: null, limit: null, page: null, lastPage: null };
  const int = v => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
  const set = (k, v) => { if (out[k] == null && v != null) out[k] = v; };
  const visit = (o, depth) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3) return;
    set('offset', int(o.offset != null ? o.offset : o.skip != null ? o.skip : o.start));
    set('limit', int(o.limit != null ? o.limit : o.per_page != null ? o.per_page : o.perPage != null ? o.perPage : o.pageSize != null ? o.pageSize : o.take));
    set('page', int(o.current_page != null ? o.current_page : o.currentPage != null ? o.currentPage : o.page));
    set('lastPage', int(o.last_page != null ? o.last_page : o.lastPage != null ? o.lastPage : o.total_pages != null ? o.total_pages : o.totalPages));
    set('cursor', o.nextCursor || o.next_cursor || (typeof o.cursor === 'string' ? o.cursor : o.cursor && o.cursor.next) || null);
    if (o.hasMore || o.has_more || o.hasNextPage || o.has_next_page) out.hasMore = true;
    const next = o.next_page_url || o.nextPageUrl || (typeof o.next === 'string' ? o.next : '') || (o.links && typeof o.links.next === 'string' ? o.links.next : '');
    if (next && !out.next) out.next = next;
    for (const k of ['totalItems', 'total', 'totalCount', 'total_count', 'totalChapters', 'total_chapters']) if (out.total == null && typeof o[k] === 'number') out.total = o[k];
    Object.values(o).forEach(v => visit(v, depth + 1));
  };
  visit(data, 0);
  return out;
}

/* ---------------- where the page's own script would load the list from ---------------- */
const PLACEHOLDER = /__([A-Za-z][A-Za-z0-9_]*?)__|\$\{\s*([A-Za-z_][\w.]*)\s*\}|\{\{?\s*([A-Za-z_][\w.]*)\s*\}?\}|:([A-Za-z_][A-Za-z0-9_]*)(?=[/?&]|$)|%([A-Za-z_]+)%/g;
const CHAPTER_VAR = /^(?:chap(?:ter)?s?|episodes?|ep|chapter_?(?:slug|id|num(?:ber)?)|chapterslug)$/i;
const LIST_URL = /(?:^|[/_.?=&-])(?:chapters?|episodes?|chapter[-_]?list|chapterlist)(?:$|[/_.?=&-])/i;
function fillTemplate(tpl, vars, { keepChapter = false } = {}) {
  let ok = true;
  const out = String(tpl).replace(PLACEHOLDER, (m, a, b, c, d, e) => {
    const name = a || b || c || d || e, last = name.split('.').pop();
    if (CHAPTER_VAR.test(last)) { if (keepChapter) return '{chapter}'; ok = false; return m; }
    const k = normKey(last);
    // (the page's own data-* values first, the slug of the page's address last)
    let val = k === 'urlslug' ? undefined : vars[k];
    if (val == null) { const hit = Object.entries(vars).find(([vk]) => vk !== 'urlslug' && (vk.endsWith(k) || k.endsWith(vk))); if (hit) val = hit[1]; }
    if (val == null && /^(slug|manga|comic|series|title|story|book|work|name|mangaslug|comicslug|seriesslug)$/.test(k)) val = vars.urlslug;
    if (val == null && /id$/.test(k)) { const hit = Object.entries(vars).find(([vk]) => vk.endsWith('id')); if (hit) val = hit[1]; }
    if (val == null || val === '') { ok = false; return m; }
    return encodeURIComponent(String(val));
  });
  return ok && !/__[A-Za-z]+__/.test(out) ? out : '';
}
function urlsInScript(text, base, vars) {
  const found = [];
  const push = raw => {
    const filled = fillTemplate(raw, vars);
    const u0 = filled && abs(filled, base);
    if (!u0) return;
    let u; try { u = new URL(u0); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || !LIST_URL.test(u.pathname + u.search)) return;
    // a data address, not a link to a chapter page: /api/, ajax, .json, or ending in /chapters
    if (!/\/api\/|ajax|\.json|\/(?:chapters?|episodes?|chapter-?list)\/?$|[?&](?:action|chapters?)=/i.test(u.pathname + u.search)) return;
    found.push(u.href);
  };
  for (const m of text.matchAll(/(["'])((?:https?:\/\/[^"'\s]+)?\/[^"'\s]*)\1\s*\+\s*([A-Za-z_$][\w.$]*)\s*\+\s*(["'])([^"'\s]*(?:chapter|episode)[^"'\s]*)\4/gi)) push(`${m[2]}{${m[3]}}${m[5]}`);
  for (const m of text.matchAll(/(["'`])((?:https?:\/\/[^"'`\s<>]+)?\/[^"'`\s<>]*?(?:chapter|episode)[^"'`\s<>]*)\1/gi)) {
    if (/\+\s*$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    push(m[2]);
  }
  return uniq(found).slice(0, 5);
}
// What the page says about where its chapter list comes from
function hints(doc, html, url) {
  const out = { templates: [], guesses: [], embedded: [], api: null, vars: {} };
  let page; try { page = new URL(url); } catch { return out; }
  const slug = page.pathname.replace(/\/$/, '').split('/').pop();
  const vars = { urlslug: slug };
  const els = doc.select('[data-api-url], [data-url], [data-endpoint], [data-api], [data-ajax-url], [data-load], [data-source], [data-chapters-url], [data-list-url], [data-id], [data-slug], [data-manga-id], [data-comic-id], [data-series-id], [data-post-id], [data-comic-slug], [data-manga-slug]');
  for (const el of els) for (const [k, v] of Object.entries(el.el.attrs || {})) {
    if (!/^data-/i.test(k) || !v || v.length > 300 || /^https?:|^\//.test(v)) continue;
    const nk = normKey(k);
    if (/(?:id|slug|name|key|code|series|manga|comic|post|book)$/.test(nk) && !(nk in vars)) vars[nk] = v;
  }
  out.vars = vars;
  for (const el of els) {
    const attrs = Object.entries(el.el.attrs || {});
    const local = Object.assign({}, vars);
    for (const [k, v] of attrs) if (/^data-/i.test(k) && v && !/^https?:|^\//.test(v)) local[normKey(k)] = v;
    let chapterUrl = '';
    const lists = [];
    for (const [k, v] of attrs) {
      if (!v || !/^(?:https?:\/\/|\/)/.test(v.trim()) || !/^(?:data-|hx-get)/i.test(k)) continue;
      if (/template|pattern|format/i.test(k) || /__(?:chap|chapter|episode)\w*__|\{(?:chap|chapter|episode)\w*\}/i.test(v)) {
        if (/chap|episode/i.test(k + v)) { const t = fillTemplate(v.trim(), local, { keepChapter: true }); if (t.includes('{chapter}')) chapterUrl = abs(t, url).replace(/%7Bchapter%7D/g, '{chapter}'); }
        continue;
      }
      if (!/api|ajax|endpoint|url|source|list|load|chapters/i.test(k) || !LIST_URL.test(v)) continue;
      const filled = fillTemplate(v.trim(), local), a = filled && abs(filled, url);
      if (a && a.replace(/\/$/, '') !== page.href.replace(/\/$/, '')) lists.push(a);
    }
    for (const u of uniq(lists)) out.templates.push({ url: u, chapterUrl });
  }
  for (const s of doc.select('script')) {
    if (s.attr('src')) continue;
    const t = s.textBlock();
    if (t.length > 300000 || /^\s*[{[]/.test(t)) continue;
    for (const u of urlsInScript(t, url, vars)) if (!out.templates.some(x => x.url === u)) out.guesses.push(u);
  }
  out.guesses = uniq(out.guesses).slice(0, 5);
  // Embedded data
  for (const s of doc.select('script#__NEXT_DATA__, script#ng-state, script[type="application/json"]')) { try { out.embedded.push(JSON.parse(s.textBlock())); } catch { /* not JSON */ } }
  for (const el of doc.select('[data-page]')) { try { out.embedded.push(JSON.parse(el.attr('data-page'))); } catch { /* not JSON */ } }
  // A site API + the work's id (Iken-style sites: {api}/api/chapters?postId=…&skip=…&take=…)
  const apiBase = (html.match(/\b(?:apiBaseUrl|NEXT_PUBLIC_API_URL|PUBLIC_API_URL|apiUrl|API_URL)\\?"?\s*[:=]\s*\\?"(https?:\/\/[^"\\]+)\\?"/) || [])[1];
  if (apiBase && slug) {
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const id = (html.match(new RegExp(`\\bid\\\\?"?\\s*:\\s*\\\\?"?(\\d+)\\\\?"?\\s*,\\s*\\\\?"?slug\\\\?"?\\s*:\\s*\\\\?"${esc}`)) || [])[1]
      || (html.match(/\b(?:postId|post_id|mangaId|manga_id|seriesId|series_id|comicId|comic_id)\\?"?\s*:\s*\\?"?(\d+)/) || [])[1];
    if (id) out.api = { base: apiBase.replace(/\/$/, ''), id };
  }
  return out;
}

/* ---------------- reading a list address, page after page ---------------- */
async function readList(ctx, first, { seriesUrl, sample, chapterUrl = '', budget }) {
  const all = new Map();
  let url = first;
  const seen = new Set();
  while (url && budget.left-- > 0 && !seen.has(url)) {
    seen.add(url);
    let res; try { res = await ctx.get(url, { accept: 'application/json,text/html;q=0.8,*/*;q=0.5', headers: { 'X-Requested-With': 'XMLHttpRequest' } }); } catch (e) { if (e.code === 'stopped') throw e; break; }
    let data = null; try { data = JSON.parse(res.text); } catch { /* HTML */ }
    let got = [];
    if (data) got = chaptersFromJson(data, { seriesUrl, sample, urlTemplate: chapterUrl });
    else {
      // An HTML fragment: its chapter links
      const { parse } = require('./html');
      const d = parse(res.text);
      got = d.select('a[href]').map(a => { const u = abs(a.attr('href'), res.url); const m = (u.match(CHAPTER_PATH) || a.text().match(CHAPTER_TEXT)); if (!u || !m) return null; let id; try { id = decodeURI(new URL(u).pathname).replace(/\/+$/, ''); } catch { id = u; } return { id, n: m[1].replace('-', '.'), t: a.text(), u, d: '', l: null }; }).filter(Boolean);
    }
    const before = all.size;
    for (const c of got) if (!all.has(c.id)) all.set(c.id, c);
    if (all.size === before) break; // (nothing new: the end)
    url = '';
    if (!data) break;
    const p = jsonPaging(data);
    const u = new URL(res.url);
    if (p.next) url = abs(p.next, res.url);
    else if (p.cursor && (p.hasMore || p.cursor)) { u.searchParams.set('cursor', p.cursor); url = u.href; }
    else if (p.page != null && p.lastPage != null && p.page < p.lastPage) { u.searchParams.set('page', String(p.page + 1)); url = u.href; }
    else if (p.offset != null && p.limit && (p.hasMore || (p.total != null && p.offset + p.limit < p.total))) {
      const key = ['skip', 'offset', 'start'].find(k => u.searchParams.has(k)) || 'skip';
      u.searchParams.set(key, String(p.offset + p.limit)); url = u.href;
    } else if (p.hasMore || (p.total != null && all.size < p.total)) {
      for (const k of ['page', 'p']) if (u.searchParams.has(k)) { u.searchParams.set(k, String(Number(u.searchParams.get(k)) + 1)); url = u.href; break; }
    }
  }
  return [...all.values()];
}
const fillCustom = (tpl, vars) => tpl.replace(/\{url\}/g, vars.url.replace(/\/$/, '')).replace(/\{slug\}/g, encodeURIComponent(vars.slug || '')).replace(/\{id\}/g, encodeURIComponent(vars.id || ''))
  .replace(/\{page\}/g, '1').replace(/\{skip\}/g, '0').replace(/\{take\}/g, '100').replace(/\{cursor\}/g, '');

async function complete(ctx, { doc, html, url, have = [] }) {
  const src = ctx.src || {};
  const sample = have.slice(0, 40);
  const budget = { left: MAX_REQUESTS };
  const better = list => list.length > have.length;
  const h = hints(doc, html, url);
  // 1. the source's own setting
  if (src.chaptersUrl) {
    const id = h.vars && (Object.entries(h.vars).find(([k]) => /id$/.test(k)) || [])[1];
    const first = abs(fillCustom(src.chaptersUrl, { url, slug: h.vars.slug || h.vars.urlslug, id }), url);
    const list = first ? await readList(ctx, first, { seriesUrl: url, sample, budget }) : [];
    if (better(list)) return { chapters: list, via: 'setting' };
  }
  // 2. data already in the page
  for (const data of h.embedded) {
    const list = chaptersFromJson(data, { seriesUrl: url, sample });
    if (list.length >= 2 && better(list)) return { chapters: list, via: 'page data' };
  }
  // 3. where the page's script loads it from
  for (const t of h.templates.concat(h.guesses.map(u => ({ url: u, chapterUrl: '' })))) {
    if (budget.left <= 0) break;
    const list = await readList(ctx, t.url, { seriesUrl: url, sample, chapterUrl: t.chapterUrl, budget });
    if (list.length >= 2 && better(list)) return { chapters: list, via: 'script address' };
  }
  // 4. the site's chapter API
  if (h.api && budget.left > 0) {
    const list = await readList(ctx, `${h.api.base}/api/chapters?postId=${encodeURIComponent(h.api.id)}&skip=0&take=500`, { seriesUrl: url, sample, budget });
    if (list.length >= 2 && better(list)) return { chapters: list, via: 'site API' };
  }
  return null;
}
// A list that looks incomplete: nothing, or it doesn't reach down to chapter 1, or it has big gaps
function looksIncomplete(list) {
  const nums = list.map(c => parseFloat(c.n)).filter(Number.isFinite);
  if (!nums.length) return true;
  const min = Math.min(...nums), max = Math.max(...nums);
  return min > 1.5 || (max >= 5 && new Set(nums.map(Math.floor)).size < 0.85 * Math.floor(max));
}

module.exports = { complete, looksIncomplete, hints, chaptersFromJson, jsonPaging, fillTemplate, urlsInScript };
