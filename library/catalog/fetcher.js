// A polite fetcher for crawling sites:
//   - identifies itself with Thoth's generic user agent (nothing about the server or its users)
//   - follows robots.txt (Allow/Disallow with * and $, the longest rule wins; a site without one allows all)
//   - at most `parallel` requests to a site at once (lanes); each lane waits gapMs between its requests, and
//     starts are staggered (staggerMs, or the site's robots.txt Crawl-delay, which then also means one at a time)
//   - backs off when told to (429/503 + Retry-After): the whole site waits
//   - only public addresses: never this machine or the local network, also not through a redirect
//   - stops at bot challenges (Cloudflare and the like): the site doesn't want automated visitors, so the
//     source reports "blocked" instead of trying to get around it
const UA = 'Thoth-Library-Server/1.0';
const UA_TOKEN = 'thoth-library-server';
const MAX_BYTES = 8 * 1024 * 1024;
// Sitemaps may be up to 50 MB uncompressed (sitemaps.org): get(url, { maxBytes: SITEMAP_BYTES })
const SITEMAP_BYTES = 64 * 1024 * 1024;

function publicUrl(url, allowLocal) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (allowLocal) return true; // (tests only: THOTH_CATALOG_ALLOW_LOCAL=1)
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (/^(::1?|f[cd][0-9a-f]{2}:|fe80:)/.test(h)) return false;
  return true;
}
// A real bot check (not Cloudflare's ordinary background script on normal pages)
const CHALLENGE = /cf-chl|challenge-platform\/[^"']*\/orchestrate|Just a moment\.\.\.|Attention Required|Bot challenge|captcha|datadome|_Incapsula_Resource|px-captcha|Sorry, you have been blocked/i;
const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});

/* ---------------- robots.txt ---------------- */
// → [{ allow, pattern (RegExp), length }] for our user agent (its own group, else the * group)
function parseRobots(text) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (cur && key === 'crawl-delay') { const d = parseFloat(val); if (Number.isFinite(d) && d >= 0) cur.crawlDelay = Math.min(d, 60); continue; }
    if (!cur || (key !== 'allow' && key !== 'disallow')) continue;
    if (key === 'disallow' && !val) continue; // "Disallow:" (empty) allows everything
    const pattern = new RegExp('^' + val.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$'));
    cur.rules.push({ allow: key === 'allow', pattern, length: val.length });
  }
  const mine = groups.find(g => g.agents.some(a => a !== '*' && UA_TOKEN.startsWith(a)));
  const any = groups.filter(g => g.agents.includes('*'));
  const rules = mine ? mine.rules : any.flatMap(g => g.rules);
  // (the seconds the site asks between requests, if it says: rules.crawlDelay)
  const delay = mine ? mine.crawlDelay : any.map(g => g.crawlDelay).find(d => d != null);
  if (delay != null) rules.crawlDelay = delay;
  return rules;
}
// The sitemaps a robots.txt names ("Sitemap: https://…")
function sitemapsIn(text) {
  return [...new Set(String(text || '').split(/\r?\n/).map(l => /^\s*sitemap\s*:\s*(\S+)/i.exec(l)).filter(Boolean).map(m => m[1]))];
}
function robotsAllows(rules, url) {
  const u = new URL(url);
  const target = u.pathname + u.search;
  let best = null;
  for (const r of rules) if (r.pattern.test(target) && (!best || r.length > best.length || (r.length === best.length && r.allow))) best = r;
  return !best || best.allow;
}

/* ---------------- access: sites that answer 403 to plain requests ----------------
 * access.mode 'auto' (default): a 403 that isn't bot protection is retried with what a visitor's browser sends anyway,
 * each variant once: the site's own cookies (its home page visited once an hour, when robots.txt allows it; the
 * cookies it sets for every visitor), Referer variants (the page, the site, the source's home page), and the
 * administrator's own cookies and headers (access.cookies / access.headers; never sent to other sites). What worked is
 * remembered per host and used first. A host where nothing worked is left alone for 30 minutes. 'plain': never.
 * Never: bot checks solved or worked around, bot-check cookies kept or sent, the user agent changed, identity or
 * proxy headers added; robots.txt, the pace and the slow-down still apply to every retry.
 */
const BOT_COOKIE = /^(cf_clearance|__cf_bm|__cfduid|cf_chl|__cflb|datadome|_px|incap_ses_|visid_incap_|nlbi_|ak_bmsc|bm_sv|bm_sz|_abck|__ddg|__sucuri|sucuri_)/i;
const BAD_HEADER = /^(?:user-agent|forwarded|via|x-real-ip|true-client-ip|cf-connecting-ip|client-ip|host|cookie|connection|content-length|transfer-encoding|te|upgrade)$|^(?:sec-|proxy-|x-forwarded|x-originating|x-remote|x-client-ip)/i;
function cookiePairs(str) { return String(str || '').replace(/^cookie:\s*/i, '').split(/;\s*/).map(x => x.trim()).filter(x => /^[^=\s]+=/.test(x) && !BOT_COOKIE.test(x.split('=')[0])); }
function headerLines(v) {
  const out = {};
  const lines = Array.isArray(v) ? v : typeof v === 'object' && v ? Object.entries(v).map(([k, x]) => k + ': ' + x) : String(v || '').split(/\r?\n/);
  for (const l of lines) { const m = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(l); if (m && !BAD_HEADER.test(m[1]) && m[2]) out[m[1]] = m[2]; }
  return out;
}
const sameSite = (a, b) => { try { const x = new URL(a).hostname.split('.').slice(-2).join('.'), y = new URL(b).hostname.split('.').slice(-2).join('.'); return x === y; } catch { return false; } };

function createFetcher({ gapMs = 1000, parallel = 1, staggerMs = 150, allowLocal = false, timeoutMs = 25000, onRequest, access = null } = {}) {
  access = Object.assign({ mode: 'auto', home: '', cookies: '', headers: '' }, access || {});
  parallel = Math.max(1, Math.min(16, Math.round(Number(parallel) || 1)));
  const robots = new Map(); // origin → Promise<rules>
  const robotsText = new Map(); // origin → the file itself
  const robotsDown = new Map(); // origin → the server error its robots.txt answered
  const robotsMeta = new Map(); // origin → what reading it gave
  // Per site: requests in progress, each lane's next allowed start, the last start, a pause the site asked for
  // (Retry-After), and the spacing between any two starts (staggerMs, or robots.txt Crawl-delay)
  const hosts = new Map();
  const hostState = host => {
    if (!hosts.has(host)) hosts.set(host, { inFlight: 0, lanes: new Array(parallel).fill(0), lastStart: 0, pauseUntil: 0, spacing: Math.min(staggerMs, gapMs), crawlDelay: null, slowUntil: 0, slowLanes: parallel });
    return hosts.get(host);
  };
  // active: requests in progress right now (sent, answer not read yet); waiting: requests waiting for their turn at a site
  const stats = { requests: 0, bytes: 0, retries: 0, active: 0, waiting: 0, maxActive: 0 };
  let stopped = false;

  // Waits for a free lane at this site; → release() (called when the answer has been read)
  async function slot(host) {
    const h = hostState(host);
    for (;;) {
      if (stopped) throw err('stopped', 'Stopped');
      const now = Date.now();
      // Crawl-delay: the site wants one request at a time, that many seconds apart. After a 429/503: half as
      // many at once, twice as far apart, for 10 minutes
      const slow = h.slowUntil > now;
      const lanes = h.crawlDelay != null ? 1 : slow ? h.slowLanes : parallel;
      const notBefore = Math.max(h.pauseUntil, h.lastStart + (slow ? Math.max(h.spacing * 2, gapMs / Math.max(1, lanes)) : h.spacing));
      const lane = h.inFlight < lanes && now >= notBefore ? h.lanes.slice(0, lanes).findIndex(at => at <= now) : -1;
      if (lane !== -1) {
        h.lanes[lane] = now + gapMs; h.lastStart = now; h.inFlight++;
        let released = false;
        return () => { if (!released) { released = true; h.inFlight--; } };
      }
      const wake = Math.max(notBefore, Math.min(...h.lanes.slice(0, lanes))) - now;
      await new Promise(r => setTimeout(r, Math.max(15, Math.min(wake > 0 ? wake : 50, 1000))));
    }
  }
  async function raw(url, opts = {}) {
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      if (!publicUrl(current, allowLocal)) throw err('notPublic', `Not a public address: ${current}`);
      const u = new URL(current);
      stats.waiting++;
      let release;
      try { release = await slot(u.host); } finally { stats.waiting--; }
      stats.requests++;
      if (onRequest) onRequest(current);
      stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
      let res;
      try {
        res = await fetch(current, {
        method: opts.method || 'GET', body: opts.body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: Object.assign({ 'User-Agent': UA, Accept: opts.accept || 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' }, opts.headers || {})
        });
      } catch (e) { stats.active--; release(); throw e; }
      res.counted = true; res.release = release; // (readBody or the redirect below ends it)
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        done(res); try { await res.body.cancel(); } catch {}
        current = new URL(res.headers.get('location'), current).href; // checked again at the top
        if (opts.method && opts.method !== 'GET' && res.status !== 307 && res.status !== 308) { opts = Object.assign({}, opts, { method: 'GET', body: undefined }); }
        continue;
      }
      return { res, url: current };
    }
    throw err('redirects', 'Too many redirects');
  }
  function done(res) { if (res && res.counted) { res.counted = false; stats.active--; if (res.release) res.release(); } }
  async function readBody(res, max) {
    try { return await readAll(res, max); } finally { done(res); }
  }
  async function readAll(res, max) {
    max = Math.max(MAX_BYTES, Math.min(SITEMAP_BYTES, Number(max) || MAX_BYTES));
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { try { await reader.cancel(); } catch {} throw err('tooLarge', `Too large (over ${Math.round(max / 1048576)} MB)`); }
      chunks.push(value);
    }
    stats.bytes += size;
    return Buffer.concat(chunks.map(c => Buffer.from(c)));
  }
  async function rulesFor(origin) {
    if (!robots.has(origin)) {
      robots.set(origin, (async () => {
        // (what was read, for the Site files tab: robotsInfo(origin))
        const t0 = Date.now();
        const meta = m => robotsMeta.set(origin, Object.assign({ origin, ms: Date.now() - t0, checkedAt: new Date().toISOString() }, m));
        try {
          const { res } = await raw(origin + '/robots.txt', { accept: 'text/plain' });
          // None (4xx): everything allowed. A server error: the whole site is off-limits until it answers (RFC 9309)
          if (res.status >= 500) { done(res); try { await res.body.cancel(); } catch {} robotsDown.set(origin, res.status); meta({ http: res.status, status: 'error' }); return [{ allow: false, pattern: /^\//, length: 1 }]; }
          if (res.status >= 400) { done(res); try { await res.body.cancel(); } catch {} meta({ http: res.status, status: 'none' }); return []; }
          const text = (await readBody(res)).toString('utf8');
          robotsText.set(origin, text);
          const rules = parseRobots(text);
          if (rules.crawlDelay != null) { const h = hostState(new URL(origin).host); h.crawlDelay = rules.crawlDelay; h.spacing = Math.max(h.spacing, rules.crawlDelay * 1000); }
          meta({ http: res.status, status: 'found', rules: rules.length, crawlDelay: rules.crawlDelay != null ? rules.crawlDelay : null, sitemaps: sitemapsIn(text), body: text.slice(0, 65536), bytes: Buffer.byteLength(text) });
          return rules;
        } catch (e) { if (e.code === 'stopped' || e.code === 'notPublic') throw e; meta({ http: null, status: 'unreachable', error: String(e.message || e).slice(0, 160) }); return []; }
      })());
    }
    return robots.get(origin);
  }
  // Access variants (see above): the site's cookies, Referer variants, the administrator's cookies and headers
  const siteCookies = new Map(); // origin → { at, pairs }
  async function visitorCookies(origin) {
    const c = siteCookies.get(origin);
    if (c && Date.now() - c.at < 3600000) return c.pairs;
    const home = origin + '/';
    let pairs = [];
    try {
      if (robotsAllows(await rulesFor(origin), home)) {
        const { res } = await raw(home, { accept: 'text/html' });
        const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        pairs = set.map(x => x.split(';')[0].trim()).filter(x => /^[^=\s]+=/.test(x) && !BOT_COOKIE.test(x.split('=')[0]));
        done(res); try { await res.body.cancel(); } catch {}
      }
    } catch (e) { if (e.code === 'stopped') throw e; }
    siteCookies.set(origin, { at: Date.now(), pairs });
    return pairs;
  }
  const VARIANTS = ['cookies', 'referer-page', 'referer-site', 'referer-home', 'user'];
  async function variantHeaders(v, url) {
    const u = new URL(url);
    const own = access.home ? sameSite(url, access.home) : true;
    if (v === 'cookies') { const p = await visitorCookies(u.origin); return p.length ? { Cookie: p.join('; ') } : null; }
    if (v === 'referer-page') return { Referer: url };
    if (v === 'referer-site') return { Referer: u.origin + '/' };
    if (v === 'referer-home') return access.home && access.home.replace(/\/$/, '') !== u.origin ? { Referer: access.home } : null;
    if (v === 'user') {
      if (!own) return null; // (never the administrator's cookies or headers to other sites)
      const pairs = cookiePairs(access.cookies), hs = headerLines(access.headers);
      if (!pairs.length && !Object.keys(hs).length) return null;
      const site = await visitorCookies(u.origin);
      return Object.assign({}, hs, pairs.length || site.length ? { Cookie: site.concat(pairs).join('; ') } : {});
    }
    return null;
  }
  // A 403 that isn't bot protection: each variant once, the one that worked first → the answer, or null
  async function alternate(url, opts) {
    const h = hostState(new URL(url).host);
    if (access.mode === 'plain' || h.altFailedUntil > Date.now()) return null;
    const order = h.altWorked ? [h.altWorked].concat(VARIANTS.filter(x => x !== h.altWorked)) : VARIANTS;
    const tried = new Set();
    for (const v of order) {
      const extra = await variantHeaders(v, url);
      if (!extra) continue;
      const sig = JSON.stringify(extra);
      if (tried.has(sig)) continue; // (a variant that would repeat a request already made)
      tried.add(sig);
      const { res, url: finalUrl } = await raw(url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, extra) }));
      const body = await readBody(res, opts.maxBytes);
      const text = require('./text').decodeText(body, res.headers.get('content-type') || '');
      if (CHALLENGE.test(text.slice(0, 20000)) && res.status >= 400) throw err('blocked', `${new URL(url).host} asks to prove you're a person (bot protection): it can't be crawled`);
      if (res.status < 400) {
        if (h.altWorked !== v) { h.altWorked = v; stats.access = Object.assign({}, stats.access, { [new URL(url).host]: v }); }
        return { status: res.status, url: finalUrl, text, buf: body, json: () => JSON.parse(text), type: res.headers.get('content-type') || '', access: v };
      }
    }
    h.altFailedUntil = Date.now() + 1800000;
    return null;
  }
  const robotsErr = u => robotsDown.has(u.origin)
    ? err('robots', `robots.txt answered ${robotsDown.get(u.origin)} (a server error): the site is treated as off-limits until it answers (RFC 9309)`)
    : err('robots', `robots.txt doesn't allow ${u.pathname}${u.search}`);
  // GET (or POST) a page: { text, json(), url, status }. Throws { code: 'robots' | 'blocked' | 'http' | … }
  async function get(url, opts = {}) {
    if (!publicUrl(url, allowLocal)) throw err('notPublic', `Not a public address: ${url}`);
    const u = new URL(url);
    if (!opts.skipRobots && !robotsAllows(await rulesFor(u.origin), url)) throw robotsErr(u);
    // (a host where a variant worked: it's used from the start)
    const learned = hostState(u.host).altWorked;
    if (learned && access.mode !== 'plain') { const extra = await variantHeaders(learned, url); if (extra) opts = Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, extra) }); }
    for (let attempt = 0; ; attempt++) {
      const { res, url: finalUrl } = await raw(url, opts);
      const body = await readBody(res, opts.maxBytes);
      // (in the charset the page declares: a site in Windows-1252, Shift_JIS, GBK, EUC-KR… isn't garbled)
      const text = require('./text').decodeText(body, res.headers.get('content-type') || '');
      // A bot challenge: stop (not worked around)
      if ((res.status === 403 || res.status === 503 || res.status === 429) && CHALLENGE.test(text.slice(0, 20000))) {
        throw err('blocked', `${u.host} asks to prove you're a person (bot protection): it can't be crawled`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        stats.retries++;
        const wait = Math.min(60000, (Number(res.headers.get('retry-after')) || 2 ** attempt * 2) * 1000);
        const hs = hostState(u.host);
        hs.pauseUntil = Date.now() + wait; // (the whole site waits)
        // …and slows down for 10 minutes: half the requests at once (one signal per pause, not one per request)
        if (res.status === 429 || res.status === 503) { if (hs.slowUntil < Date.now()) hs.slowLanes = Math.max(1, Math.floor((hs.slowUntil > 0 ? hs.slowLanes : parallel) / 2)); hs.slowUntil = Date.now() + 600000; stats.slowedDown = (stats.slowedDown || 0) + 1; }
        continue;
      }
      if (res.status === 403 && !opts.noAlternate) {
        const alt = await alternate(url, opts);
        if (alt) return alt;
        throw err('http', `403 from ${finalUrl}` + (access.mode === 'plain' ? ' (Access is set to plain requests: set it to Automatic to retry 403s the way a browser would)' : ' (also with the site\'s cookies and Referer variants)'), { status: 403 });
      }
      if (res.status >= 400) throw err('http', `${res.status} from ${finalUrl}`, { status: res.status });
      return { status: res.status, url: finalUrl, text, buf: body, json: () => JSON.parse(text), type: res.headers.get('content-type') || '' };
    }
  }
  // A page built in a headless browser (render.js): the same checks and pace as get(), the page's DOM once its
  // scripts ran → { text, url, status }
  async function render(url, opts = {}) {
    if (!publicUrl(url, allowLocal)) throw err('notPublic', `Not a public address: ${url}`);
    const u = new URL(url);
    if (!robotsAllows(await rulesFor(u.origin), url)) throw robotsErr(u);
    stats.waiting++;
    let release;
    try { release = await slot(u.host); } finally { stats.waiting--; }
    stats.requests++;
    if (onRequest) onRequest(url);
    stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      const r = await require('./render').renderPage(url, { allowLocal, waitMs: opts.waitMs });
      stats.bytes += Buffer.byteLength(r.text);
      if (/cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required|Bot challenge|captcha/i.test(r.text.slice(0, 20000)) && r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length < 3000) {
        throw err('blocked', `${u.host} asks to prove you're a person (bot protection): it can't be crawled`);
      }
      return { status: 200, url: r.url, text: r.text, json: () => JSON.parse(r.text), type: 'text/html', rendered: true };
    } finally { stats.active--; release(); }
  }
  // How it fetches from a site now: { parallel, crawlDelay } (crawlDelay: robots.txt asked for one at a time)
  const limits = host => { const h = host ? hosts.get(host) : [...hosts.values()][0]; return { parallel: h && h.crawlDelay != null ? 1 : parallel, crawlDelay: h ? h.crawlDelay : null }; };
  return { get, render, stats, limits, stop: () => { stopped = true; }, robotsAllowed: async url => robotsAllows(await rulesFor(new URL(url).origin), url),
    robotsFile: async origin => { await rulesFor(origin); return robotsText.get(origin) || null; },
    robotsInfo: origin => robotsMeta.get(origin) || null };
}

// The Referer a browser sends for an image shown on `page`: the page's origin with its "/" when the image is on
// another host (image servers that check it often want exactly that: "https://www.manganato.gg/" passes where
// "https://www.manganato.gg" is refused), the page itself on the same host
function refererFor(page, imageUrl) {
  if (!page) return '';
  try {
    const r = new URL(page), i = new URL(imageUrl);
    return r.origin === i.origin ? r.href : r.origin + '/';
  } catch { return ''; }
}

module.exports = { cookiePairs, headerLines, createFetcher, parseRobots, robotsAllows, sitemapsIn, publicUrl, refererFor, UA, MAX_BYTES, SITEMAP_BYTES };
