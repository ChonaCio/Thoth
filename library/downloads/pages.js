// A chapter's page images on one site: their addresses, in reading order, read from the chapter page the catalog
// links to (or, for MangaDex, from its documented API). Nothing is unlocked or worked around: a chapter the site
// shows only to paying readers, or only as a preview, is "locked" and waits until it's free somewhere.
//   chapterImages({ link, source, get }) → { images: [url], referer } | { locked: reason } | { missing: reason } | { error: reason }
const { parse } = require('../catalog/html');

const abs = (u, base) => { try { return new URL(String(u).trim(), base).href; } catch { return null; } };
// Where the theme keeps a page image's address (lazy-loading attributes first)
const ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-cfsrc', 'data-srcset', 'src'];
function imgUrl(el, base) {
  for (const a of ATTRS) {
    let v = el.attr(a);
    if (!v) continue;
    v = String(v).trim();
    if (a === 'data-srcset') v = v.split(/\s+/)[0];
    if (!v || /^data:|^blob:|^javascript:/i.test(v)) continue;
    const u = abs(v, base);
    if (u && /^https?:/i.test(u) && !/\.svg(\?|$)/i.test(u)) return u;
  }
  return null;
}
// The reader areas of the usual themes: Manganato/MangaNato family, Madara, MangaReader (Themesia), WEBTOON, and
// readers that mark their pages
const READERS = [
  '.container-chapter-reader img', '.reading-content img', '#readerarea img', '#_imageList img', '.chapter-content img',
  '.chapter-images img', '.reader-area img', '#chapter_imgs img', '.page-chapter img', '.vung-doc img', 'div.reader img',
  'img.wp-manga-chapter-img', 'img[data-page]', 'img.page-image', '.read-container img', '#chapter-images img'
];
// Image lists in the page's scripts: ts_reader.run({"sources":[{"images":[…]}]}), chapter_preloaded_images = […],
// "images": […]
function scriptImages(html, base) {
  const out = [];
  const pull = list => { for (const m of String(list).matchAll(/"((?:https?:)?\\?\/\\?\/[^"]+?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^"]*)?)"/gi)) { const u = abs(m[1].replace(/\\\//g, '/'), base); if (u) out.push(u); } };
  const ts = /ts_reader\.run\((\{[\s\S]*?\})\);/.exec(html);
  if (ts) { const m = /"images"\s*:\s*(\[[^\]]*\])/.exec(ts[1]); if (m) pull(m[1]); }
  if (!out.length) { const m = /chapter_preloaded_images\s*=\s*(\[[^\]]*\])/.exec(html); if (m) pull(m[1]); }
  if (!out.length) { const m = /"(?:images|pages|imageList)"\s*:\s*(\[[^\]]{20,}\])/.exec(html); if (m) pull(m[1]); }
  return [...new Set(out)];
}
// No known reader: the largest set of images on the page kept in one folder (a chapter's pages: 001.jpg, 002.jpg…)
function guessImages(doc, base) {
  const groups = new Map();
  for (const el of doc.select('img')) {
    const u = imgUrl(el, base);
    if (!u) continue;
    const dir = u.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
    if (!groups.has(dir)) groups.set(dir, []);
    if (!groups.get(dir).includes(u)) groups.get(dir).push(u);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
  return best.length >= 3 ? best : [];
}
const LOCKED = /\b(this chapter is locked|unlock (this|the) chapter|buy (this|the) chapter|purchase (this|the) chapter|coins? to (read|unlock)|premium chapter|available for (members|subscribers)|log ?in to read|sign ?in to read)\b/i;

async function chapterImages({ link, source, get }) {
  const url = link.u;
  if (!url) return { missing: 'no address for this chapter' };
  // MangaDex: its API names the image server for a chapter (MangaDex@Home); external chapters (the publisher's own
  // site) aren't on MangaDex
  if (source.type === 'mangadex') {
    const id = (/mangadex\.org\/chapter\/([0-9a-f-]{36})/i.exec(url) || [])[1];
    if (!id) return { locked: 'published on another site (the publisher\'s own reader): not on MangaDex' };
    let r;
    try { r = (await get(`${String(source.baseUrl || 'https://api.mangadex.org').replace(/\/+$/, '')}/at-home/server/${id}`, { accept: 'application/json' })).json(); } catch (e) { return { error: e.message }; }
    const ch = r && r.chapter;
    if (!r || !r.baseUrl || !ch || !Array.isArray(ch.data) || !ch.data.length) return { missing: 'MangaDex has no pages for this chapter' };
    return { images: ch.data.map(f => `${r.baseUrl}/data/${ch.hash}/${f}`), referer: 'https://mangadex.org/' };
  }
  let res;
  try { res = await get(url, { accept: 'text/html' }); } catch (e) {
    if (e.status === 404 || e.status === 410) return { missing: `the chapter page is gone (${e.status})` };
    if (e.status === 401 || e.status === 402) return { locked: `the site wants an account or a payment (${e.status})` };
    return { error: e.message };
  }
  const html = res.text || '';
  const doc = parse(html);
  const own = (source.selectors || {}).pageImages;
  let images = [];
  for (const sel of (own ? [own] : []).concat(READERS)) {
    try { images = doc.select(sel).map(el => imgUrl(el, res.url)).filter(Boolean); } catch { images = []; }
    if (images.length) break;
  }
  if (!images.length) images = scriptImages(html, res.url);
  if (!images.length) images = guessImages(doc, res.url);
  images = [...new Set(images)];
  // A preview for visitors without an account (Manta: "previewCutImages") is not the chapter
  if (/"preview(Cut)?Images"\s*:/i.test(html) && images.length < 4) return { locked: 'only a preview without an account' };
  if (!images.length) return LOCKED.test(html.replace(/<[^>]+>/g, ' ')) ? { locked: 'the site shows this chapter only to paying readers' } : { error: 'no page images found on the chapter page' };
  return { images, referer: res.url };
}

module.exports = { chapterImages, imgUrl, scriptImages, guessImages, READERS };
