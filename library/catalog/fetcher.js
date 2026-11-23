// A polite fetcher for crawling sites:
//   - identifies itself with Thoth's generic user agent (nothing about the server or its users)
//   - follows robots.txt (Allow/Disallow with * and $, the longest rule wins; a site without one allows all)
//   - waits between requests to the same host (gapMs) and backs off when told to (429/503 + Retry-After)
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
    if (!cur || (key !== 'allow' && key !== 'disallow')) continue;
    if (key === 'disallow' && !val) continue; // "Disallow:" (empty) allows everything
    const pattern = new RegExp('^' + val.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$'));
    cur.rules.push({ allow: key === 'allow', pattern, length: val.length });
  }
  const mine = groups.find(g => g.agents.some(a => a !== '*' && UA_TOKEN.startsWith(a)));
  const any = groups.filter(g => g.agents.includes('*'));
  return mine ? mine.rules : any.flatMap(g => g.rules);
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

function createFetcher({ gapMs = 1000, allowLocal = false, timeoutMs = 25000, onRequest } = {}) {
  const robots = new Map(); // origin → Promise<rules>
  const robotsText = new Map(); // origin → the file itself
  const nextAt = new Map(); // host → time of the next allowed request
  const stats = { requests: 0, bytes: 0, retries: 0 };
  let stopped = false;

  async function slot(host) {
    for (;;) {
      if (stopped) throw err('stopped', 'Stopped');
      const now = Date.now(), at = nextAt.get(host) || 0;
      if (now >= at) { nextAt.set(host, now + gapMs); return; }
      await new Promise(r => setTimeout(r, Math.min(at - now, 1000)));
    }
  }
  async function raw(url, opts = {}) {
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      if (!publicUrl(current, allowLocal)) throw err('notPublic', `Not a public address: ${current}`);
      const u = new URL(current);
      await slot(u.host);
      stats.requests++;
      if (onRequest) onRequest(current);
      const res = await fetch(current, {
        method: opts.method || 'GET', body: opts.body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: Object.assign({ 'User-Agent': UA, Accept: opts.accept || 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en' }, opts.headers || {})
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).href; // checked again at the top
        if (opts.method && opts.method !== 'GET' && res.status !== 307 && res.status !== 308) { opts = Object.assign({}, opts, { method: 'GET', body: undefined }); }
        continue;
      }
      return { res, url: current };
    }
    throw err('redirects', 'Too many redirects');
  }
  async function readBody(res) {
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
          if (res.status >= 400) { try { await res.body.cancel(); } catch {} return []; } // none: everything allowed
          const text = (await readBody(res)).toString('utf8');
          robotsText.set(origin, text);
          return parseRobots(text);
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
        nextAt.set(u.host, Date.now() + wait);
        continue;
      }
      if (res.status >= 400) throw err('http', `${res.status} from ${finalUrl}`, { status: res.status });
      return { status: res.status, url: finalUrl, text, buf: body, json: () => JSON.parse(text), type: res.headers.get('content-type') || '' };
    }
  }
  return { get, stats, stop: () => { stopped = true; }, robotsAllowed: async url => robotsAllows(await rulesFor(new URL(url).origin), url),
    robotsFile: async origin => { await rulesFor(origin); return robotsText.get(origin) || null; } };
}

module.exports = { createFetcher, parseRobots, robotsAllows, sitemapsIn, publicUrl, UA };
