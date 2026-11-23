// What the Catalog's "Site files" tab and the source wizard show of a site, read by the helper process with the
// same polite fetcher as crawls (generic user agent, robots.txt followed, public addresses only):
//   readSiteFile({ url })  robots.txt or a sitemap: its text and what it lists
//   previewPage({ url })   a page to look at and pick elements in: made inert (no scripts, nothing loaded from
//                          the site by the browser: its stylesheets are inlined here, images become placeholders)
const zlib = require('zlib');
const crypto = require('crypto');
const { createFetcher } = require('./fetcher');
const { parseSitemap } = require('./sitemap');

const MAX_TEXT = 300 * 1024, MAX_URLS = 2000, MAX_CSS = 4, MAX_CSS_BYTES = 400 * 1024;

async function readSiteFile({ url, allowLocal }) {
  const fetcher = createFetcher({ gapMs: 300, allowLocal });
  const u = new URL(url);
  if (/\/robots\.txt$/i.test(u.pathname)) {
    const text = await fetcher.robotsFile(u.origin);
    if (text == null) return { url, kind: 'robots', found: false };
    const sitemaps = require('./fetcher').sitemapsIn(text);
    return { url, kind: 'robots', found: true, size: Buffer.byteLength(text), hash: hash(text), text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, sitemaps: sitemaps.map(loc => ({ loc })) };
  }
  const res = await fetcher.get(url, { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' });
  let text = res.text;
  if (res.buf && res.buf[0] === 0x1f && res.buf[1] === 0x8b) text = zlib.gunzipSync(res.buf).toString('utf8'); // .xml.gz
  const sm = parseSitemap(text);
  return { url: res.url, kind: 'sitemap', found: true, size: Buffer.byteLength(text), hash: hash(text), text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT,
    sitemaps: sm.sitemaps, urls: sm.urls.slice(0, MAX_URLS), urlCount: sm.urls.length };
}
const hash = t => crypto.createHash('sha1').update(String(t)).digest('hex');

// A page made inert for the element picker
async function previewPage({ url, allowLocal }) {
  const fetcher = createFetcher({ gapMs: 300, allowLocal });
  const res = await fetcher.get(url);
  const base = res.url;
  let html = res.text;
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  // The site's stylesheets, inlined (only from the same site; what robots.txt allows; a few)
  const css = [];
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).filter(tag => /rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag));
  for (const tag of links.slice(0, MAX_CSS)) {
    const href = (/href\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    let abs; try { abs = new URL(href, base); } catch { continue; }
    if (abs.host !== new URL(base).host) continue;
    try { const r = await fetcher.get(abs.href, { accept: 'text/css,*/*;q=0.1' }); if (r.text.length <= MAX_CSS_BYTES) css.push(r.text.replace(/<\/style/gi, '')); } catch { /* skipped */ }
  }
  html = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<(iframe|object|embed|frame|frameset|applet|base|meta\s+http-equiv)\b[\s\S]*?(<\/\1\s*>|>)/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|formaction)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"')
    // Images: placeholders (the browser must not load anything from the site); the address kept for the picker
    .replace(/<img\b([^>]*?)\s(src)\s*=\s*(["'])([^"']*)\3/gi, '<img$1 data-thoth-src=$3$4$3 src="data:image/gif;base64,R0lGODlhAQABAAAAACw="')
    .replace(/\s(srcset)\s*=\s*("[^"]*"|'[^']*')/gi, ' data-thoth-srcset=$2')
    .replace(/url\(\s*(['"]?)(?!data:)[^)'"]+\1\s*\)/gi, 'none');
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">` +
    `<base href="${base.replace(/"/g, '&quot;')}">` +
    css.map(c => `<style>${c.replace(/url\(\s*(['"]?)(?!data:)[^)'"]+\1\s*\)/gi, 'none').replace(/@import[^;]+;/gi, '')}</style>`).join('') +
    `<style>img{background:repeating-linear-gradient(45deg,#ddd 0 6px,#eee 6px 12px);min-width:24px;min-height:24px}</style>`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + head) : head + html;
  return { url: base, title: title.trim().slice(0, 200), html, requests: fetcher.stats.requests };
}

module.exports = { readSiteFile, previewPage };
