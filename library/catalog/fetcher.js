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

function createFetcher({ gapMs = 1000, parallel = 1, staggerMs = 150, allowLocal = false, timeoutMs = 25000, onRequest } = {}) {
  parallel = Math.max(1, Math.min(16, Math.round(Number(parallel) || 1)));
  const robots = new Map(); // origin → Promise<rules>
  const robotsText = new Map(); // origin → the file itself
  // Per site: requests in progress, each lane's next allowed start, the last start, a pause the site asked for
  // (Retry-After), and the spacing between any two starts (staggerMs, or robots.txt Crawl-delay)
  const hosts = new Map();
  const hostState = host => {
    if (!hosts.has(host)) hosts.set(host, { inFlight: 0, lanes: new Array(parallel).fill(0), lastStart: 0, pauseUntil: 0, spacing: Math.min(staggerMs, gapMs), crawlDelay: null });
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
      // Crawl-delay: the site wants one request at a time, that many seconds apart
      const lanes = h.crawlDelay != null ? 1 : parallel;
      const notBefore = Math.max(h.pauseUntil, h.lastStart + h.spacing);
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
  async function readBody(res) {
    try { return await readAll(res); } finally { done(res); }
  }
  async function readAll(res) {
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { try { await reader.cancel(); } catch {} throw err('tooLarge', 'Page too large'); }
      chunks.push(value);
    }
    stats.bytes += size;
    return Buffer.concat(chunks.map(c => Buffer.from(c)));
  }
  async function rulesFor(origin) {
    if (!robots.has(origin)) {
      robots.set(origin, (async () => {
        try {
          const { res } = await raw(origin + '/robots.txt', { accept: 'text/plain' });
          if (res.status >= 400) { done(res); try { await res.body.cancel(); } catch {} return []; } // none: everything allowed
          const text = (await readBody(res)).toString('utf8');
          robotsText.set(origin, text);
          const rules = parseRobots(text);
          if (rules.crawlDelay != null) { const h = hostState(new URL(origin).host); h.crawlDelay = rules.crawlDelay; h.spacing = Math.max(h.spacing, rules.crawlDelay * 1000); }
          return rules;
        } catch (e) { if (e.code === 'stopped' || e.code === 'notPublic') throw e; return []; }
      })());
    }
    return robots.get(origin);
  }
  // GET (or POST) a page: { text, json(), url, status }. Throws { code: 'robots' | 'blocked' | 'http' | … }
  async function get(url, opts = {}) {
    if (!publicUrl(url, allowLocal)) throw err('notPublic', `Not a public address: ${url}`);
    const u = new URL(url);
    if (!opts.skipRobots && !robotsAllows(await rulesFor(u.origin), url)) throw err('robots', `robots.txt doesn't allow ${u.pathname}${u.search}`);
    for (let attempt = 0; ; attempt++) {
      const { res, url: finalUrl } = await raw(url, opts);
      const body = await readBody(res);
      const text = body.toString('utf8');
      // A bot challenge: stop (not worked around)
      if ((res.status === 403 || res.status === 503 || res.status === 429) && /cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required|Bot challenge|captcha/i.test(text.slice(0, 20000))) {
        throw err('blocked', `${u.host} asks to prove you're a person (bot protection): it can't be crawled`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        stats.retries++;
        const wait = Math.min(60000, (Number(res.headers.get('retry-after')) || 2 ** attempt * 2) * 1000);
        hostState(u.host).pauseUntil = Date.now() + wait; // (the whole site waits)
        continue;
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
    if (!robotsAllows(await rulesFor(u.origin), url)) throw err('robots', `robots.txt doesn't allow ${u.pathname}${u.search}`);
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
    robotsFile: async origin => { await rulesFor(origin); return robotsText.get(origin) || null; } };
}

module.exports = { createFetcher, parseRobots, robotsAllows, sitemapsIn, publicUrl, UA };
