// Catalog work: crawling a source (crawl, used by the independent crawler process crawler.js), and the quick
// jobs of the helper process started by catalog/index.js (test, detect).
// It never touches the library database: it writes the source's catalog folder (store.js) and reports
// progress. One crawl at a time:
//   { type: 'crawl', reqId, source, dir, mode: 'full' | 'update', allowLocal }
//     → progress { reqId, phase, listed, done, total, errors } … → result { reqId, result: stats } | error
//   { type: 'stop' } → the crawl in progress saves what it has and ends (resumed by the next full crawl)
//   { type: 'test', reqId, source, allowLocal } → a few works and the first one's details, nothing saved
const store = require('./store');
const { createFetcher } = require('./fetcher');
const { ADAPTERS } = require('./adapters');
const { sitemapWorks } = require('./sitemap');
// How a source lists its works: its sitemaps (when detected/set) or the site's own list pages
const lister = (src, adapter) => (src.listing === 'sitemap' && src.workPattern && src.type !== 'mangadex' && src.type !== 'webtoons' ? sitemapWorks : adapter.listWorks.bind(adapter));

// Chapter names the same way the file renamer names files ("Chapter 44 - The End"): dates, views and the
// number said twice dropped (the name as the site shows it kept in `raw`, the volume in `v`)
const { chapterTitle } = require('../naming');
const { preferEnglish } = require('../titles');
const { chapterDate, fixMisreadNumbers, bulkDates } = require('./chapters');
function standardChapter(c, src) {
  // MangaDex gives the number apart from the title
  const raw = src.type === 'mangadex' && c.n ? `Chapter ${c.n} ${c.t || ''}` : c.t;
  const std = chapterTitle(raw, c.n);
  const out = Object.assign({}, c, { t: std.name, n: std.n != null ? std.n : c.n });
  if (std.v && !out.v) out.v = std.v;
  if (c.t && c.t !== std.name) out.raw = c.t;
  // Dates as YYYY-MM-DD, also when the site shows "5d ago" or "May 9"
  if (out.d && !/^\d{4}-\d{2}-\d{2}$/.test(out.d)) out.d = chapterDate(out.d);
  return out;
}

// What decides how a source's works are read (not its name, schedule or pause)
function settingsKey(src) {
  const pick = { type: src.type, listing: src.listing, workPattern: src.workPattern, chapterPattern: src.chapterPattern, listPath: src.listPath, languages: src.languages,
    contentRating: src.contentRating, includeChapters: src.includeChapters !== false, selectors: src.selectors || {}, actions: src.actions || {} };
  if (src.clean) pick.clean = src.clean;
  if (src.render) pick.render = src.renderWaitMs || true;
  if (src.chaptersUrl) pick.chaptersUrl = src.chaptersUrl;
  if (src.fullChapters === false) pick.fullChapters = false; // (only when on: other sources keep their key)
  return require('crypto').createHash('sha1').update(JSON.stringify(pick)).digest('hex').slice(0, 16);
}

// The chapters the sitemaps list for a work, added to what its page showed (once each; the page's own keep their names)
const { chapterNum } = require('./adapters');
function withSitemapChapters(list, fromSitemaps) {
  if (!fromSitemaps || !fromSitemaps.length) return list;
  const byId = new Map(list.map(c => [String(c.id), c]));
  // (a day that a large share of the chapters carry: the site bulk-updated them; that date says nothing)
  const bulk = bulkDates(fromSitemaps);
  fromSitemaps = fromSitemaps.map(x => (x.d && bulk.has(String(x.d).slice(0, 10)) ? Object.assign({}, x, { d: '' }) : x));
  for (const x of fromSitemaps) {
    let p; try { p = decodeURI(new URL(x.u).pathname); } catch { continue; }
    const id = p.replace(/\/+$/, '');
    const have = byId.get(id) || list.find(c => c.u && c.u.replace(/\/+$/, '') === x.u.replace(/\/+$/, ''));
    if (have) { if (!have.d && x.d) have.d = String(x.d).slice(0, 10); continue; }
    const last = p.split('/').filter(Boolean).pop() || '';
    const n = chapterNum(last.replace(/[-_]+/g, ' '));
    const c = { id, n: n || null, t: n ? 'Chapter ' + n : last.replace(/[-_]+/g, ' '), u: x.u, d: x.d ? String(x.d).slice(0, 10) : '', l: null, fromSitemap: true };
    byId.set(id, c); list.push(c);
  }
  return list;
}

// How a source's requests are made for sites that answer 403 (fetcher.js: access)
const accessOf = src => Object.assign({ mode: 'auto', home: src.siteUrl || src.baseUrl || '' }, src.access || {});
let current = null;
const FIELDS = ['title', 'altTitles', 'cover', 'summary', 'authors', 'genres', 'tags', 'status', 'type', 'year', 'url', 'languages', 'links'];
const filled = v => v != null && v !== '' && !(Array.isArray(v) && !v.length) && v !== 'unknown';
const errText = e => (e && e.code ? `${e.code}: ` : '') + (e && e.message || String(e));

// The settings Detect finds are what a crawl uses for sources set up automatically (only a name and an
// address): found again at the start of every crawl (new sitemaps, changed addresses), and left in
// detected.json for the server to keep in the source's settings
const AUTO_FIELDS = ['type', 'baseUrl', 'listing', 'sitemaps', 'workPattern', 'chapterPattern', 'listPath', 'iconUrl', 'languages'];
async function redetect(msg) {
  const src = msg.source;
  if (src.autoDetect !== true) return src; // (sources set up before automatic detection keep their settings)
  try {
    const d = await require('./detect').detect({ url: src.siteUrl || src.baseUrl, allowLocal: msg.allowLocal });
    const found = { at: new Date().toISOString(), notes: d.notes, found: Object.assign({}, d.found, { patterns: undefined }), blocked: d.blocked, error: d.error || null, settings: d.settings || null };
    try { require('fs').writeFileSync(require('path').join(msg.dir, 'detected.json'), JSON.stringify(found)); } catch { /* best effort */ }
    if (!d.settings) return src;
    const next = Object.assign({}, src);
    for (const k of AUTO_FIELDS) if (d.settings[k] != null && d.settings[k] !== '' && !(k === 'languages' && src.languages)) next[k] = d.settings[k];
    return next;
  } catch (e) {
    if (e.code === 'blocked') throw e;
    return src; // the settings it has
  }
}

async function crawl(msg, send) {
  msg = Object.assign({}, msg, { source: await redetect(msg) });
  const { source: src, dir } = msg;
  let mode = msg.mode;
  const adapter = ADAPTERS[src.type];
  if (!adapter) throw new Error(`Unknown source type ${src.type}`);
  const gapMs = Math.max(Number(src.gapMs) || adapter.defaults.gapMs || 1000, src.type === 'mangadex' ? 200 : 500);
  // Several requests to the site at once (one per work read at once), each lane pausing gapMs between its own
  // requests; a robots.txt Crawl-delay brings it back to one at a time
  const parallel = Math.max(1, Math.min(8, Number(msg.concurrency) || 1));
  const fetcher = createFetcher({ gapMs, parallel, allowLocal: msg.allowLocal, access: accessOf(src) });
  // How it's crawling right now: works read at once, requests in progress / waiting for their turn, the pause
  const concurrencyNow = () => { const l = fetcher.limits(); return { lanes: stats.concurrency || 1, parallel: l.parallel, crawlDelay: l.crawlDelay, active: fetcher.stats.active, waiting: fetcher.stats.waiting, gapMs }; };
  const run = current = { stop: false, fetcher };
  const data = store.readWorks(dir);
  const works = data.works;
  const chapters = store.shardCache(dir);
  const prevState = store.readState(dir);
  // How works are read (kind of site, selectors, clicks, patterns…): when it changed since the last crawl, an update
  // reads every work again — the ones the site didn't change too — or they'd keep what the old settings found
  const readingKey = settingsKey(src);
  const settingsChanged = Boolean(prevState.readingKey && prevState.readingKey !== readingKey);
  if (mode === 'update' && settingsChanged) mode = 'full';
  const incremental = mode === 'update';
  // An interrupted full crawl continues where it was (works already read in that run are skipped)
  const resume = !incremental && prevState.running && prevState.mode === 'full' ? prevState.runStartedAt : null;
  const runStartedAt = resume || new Date().toISOString();
  const state = Object.assign({}, prevState, { running: true, mode, runStartedAt, phase: 'listing', lastError: null });
  store.writeState(dir, state);
  const stats = { listed: 0, added: 0, updated: 0, read: 0, errors: 0, chapters: 0, removed: 0, partial: 0, requests: 0, mode, resumed: Boolean(resume) };
  const report = extra => send(Object.assign({ type: 'progress', reqId: msg.reqId }, stats, extra));
  const say = line => send({ type: 'log', reqId: msg.reqId, line }); // (a line in the task's log)
  if (settingsChanged) say('the reading settings changed since the last crawl: every work is read again');
  say(`listing the works (${src.listing === 'sitemap' ? 'from ' + ((src.sitemaps || []).length || 1) + ' sitemap(s)' : 'from the list pages'}${incremental ? ', recent changes only' : ''})`);
  let lastFlush = Date.now();
  const flush = () => { store.writeWorks(dir, { sourceId: src.id, works }); chapters.flush(); saveDiscovery(); lastFlush = Date.now(); send({ type: 'flushed', reqId: msg.reqId }); };
  // What this crawl read (the Site files tab): every sitemap with what happened to it, and the robots.txt —
  // merged into discovery.json (when each was last checked, read, and seen changed)
  const saveDiscovery = () => {
    try {
      const file = require('path').join(dir, 'discovery.json');
      let prev = {}; try { prev = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch { /* first crawl */ }
      const now = new Date().toISOString();
      const sitemaps = Object.assign({}, prev.sitemaps || {});
      for (const [url, r] of Object.entries(ctx.discovery || {})) {
        const old = sitemaps[url] || {};
        const rec = Object.assign({}, old, r, { checkedAt: r.at || now });
        delete rec.at; delete rec.read; delete rec.changed; delete rec.firstRead;
        if (r.read) rec.readAt = rec.checkedAt;
        if (r.hash && (!old.hash || old.hash !== r.hash)) rec.changedAt = rec.checkedAt;
        sitemaps[url] = rec;
      }
      let origin = null; try { origin = new URL(src.siteUrl || src.baseUrl).origin; } catch { /* no address */ }
      const robots = Object.assign({}, prev.robots || {});
      for (const o of new Set([origin, (() => { try { return new URL(src.baseUrl).origin; } catch { return null; } })()].filter(Boolean))) { const info = fetcher.robotsInfo(o); if (info) robots[o] = info; }
      // (a sitemap no index listed: named by robots.txt, or by the source's settings / detection)
      const declared = new Set(Object.values(robots).flatMap(r => r.sitemaps || []));
      for (const r of Object.values(sitemaps)) if (!r.parent) r.parent = declared.has(r.url) ? 'robots.txt' : 'settings';
      require('fs').writeFileSync(file, JSON.stringify({ at: now, mode, sitemaps, robots }));
    } catch (e) { say('could not save what the crawl read: ' + e.message); }
  };
  const ctx = { src, get: (u, o) => { if (run.stop) throw Object.assign(new Error('Stopped'), { code: 'stopped' }); return fetcher.get(u, o); }, incremental,
    // (list and work pages, built in a browser when the source asks: sites that build their pages with scripts)
    page: src.render ? u => { if (run.stop) throw Object.assign(new Error('Stopped'), { code: 'stopped' }); return fetcher.render(u, { waitMs: src.renderWaitMs }); } : null,
    sitemapState: store.readSitemapState(dir), knownSids: new Set(Object.keys(works)) }; // (what the sitemaps held at the last crawl: an update reads only what changed)
  const failed = new Set(); // works whose page couldn't be read: looked at again next time
  const queue = [];
  let listingComplete = false, aborted = null;
  try {
    // 1. Every work the site lists (or, updating, the recently updated ones)
    for await (const page of lister(src, adapter)(ctx)) {
      for (const stub of page) {
        const w = works[stub.sid];
        if (!w) { works[stub.sid] = Object.assign({ sid: stub.sid, addedAt: new Date().toISOString() }, stub); stats.added++; }
        else for (const f of FIELDS) if (filled(stub[f])) w[f] = stub[f];
        works[stub.sid].seenAt = runStartedAt;
        queue.push(stub.sid);
        stats.listed++;
        if (src.maxWorks && stats.listed >= src.maxWorks) break;
      }
      report({ phase: 'listing', total: stats.listed, requestsNow: concurrencyNow() });
      if (src.maxWorks && stats.listed >= src.maxWorks) break;
      if (Date.now() - lastFlush > 30000) flush();
    }
    listingComplete = !src.maxWorks || stats.listed < src.maxWorks;
    const sc = ctx.sitemapCounts;
    say(`${stats.listed} work(s) listed (${stats.added} new)` + (sc ? `; sitemaps: ${sc.files} read, ${sc.unchanged} unchanged, ${sc.notRead} not downloaded (same date)` + (sc.chapters ? `; ${sc.chapters} chapter addresses in them` : '') : ''));
    // An update also reads ongoing works that are due for a check (a site's sitemap seldom changes when a chapter
    // is added): about half their usual gap between chapters, at least every 7 days and at most every 12 hours
    if (incremental && listingComplete && src.checkOngoing !== false && src.includeChapters !== false) {
      const inQueue = new Set(queue), now = Date.now();
      let due = 0;
      for (const [sid, w] of Object.entries(works)) {
        if (inQueue.has(sid) || w.status !== 'ongoing') continue;
        const dates = (((chapters.get(sid) || {}).chapters) || []).map(c => Date.parse(c.d)).filter(Number.isFinite).sort((a, b) => b - a).slice(0, 12);
        const gaps = dates.slice(1).map((d, i) => dates[i] - d).filter(g => g > 0).sort((a, b) => a - b);
        const usual = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
        const every = Math.min(7 * 86400000, Math.max(12 * 3600000, usual ? usual / 2 : 7 * 86400000));
        if (!w.detailAt || now - Date.parse(w.detailAt) >= every) { queue.push(sid); due++; }
      }
      if (due) { stats.ongoingChecked = due; say(`${due} ongoing work(s) due for a check of new chapters`); }
    }
    // 2. Each work's details and chapter list: several works at once (msg.concurrency lanes taking the next
    // work from the list). The fetcher still spaces the requests to one site by gapMs, so more lanes only
    // help while pages are slow to answer; they never make the crawl hit the site faster than that.
    state.phase = 'works'; store.writeState(dir, state);
    const lanes = Math.max(1, Math.min(8, Number(msg.concurrency) || 1, queue.length || 1));
    stats.concurrency = lanes;
    let done = 0, next = 0, readCount = 0, lastReport = 0;
    // Time left: from the speed of the works read in this run (once a few are done), for the ones still to read
    const worksStartedAt = Date.now();
    const worksProgress = () => {
      const elapsed = Date.now() - worksStartedAt, left = queue.length - done;
      const etaMs = readCount >= 3 && elapsed >= 3000 ? Math.round(elapsed / readCount * left) : null;
      return { phase: 'works', done, total: queue.length, concurrency: lanes, requestsNow: concurrencyNow(), etaMs, at: Date.now() };
    };
    const lim = fetcher.limits();
    say(`reading the works: ${lanes} at once; up to ${lim.parallel} request(s) to the site at once, each waiting ${gapMs} ms after its previous one` + (lim.crawlDelay != null ? ` (robots.txt asks for ${lim.crawlDelay} s between requests: one at a time)` : ''));
    report(worksProgress());
    // Series pages the site refuses (401/403, a bot check) while its listing worked: after 3 refusals in a row no
    // more are requested and the works keep what the listing gave (titles, links); never worked around
    let refusals = 0, pagesRefused = null;
    const readWork = async sid => {
      const w = works[sid];
      try {
        const old = chapters.get(sid);
        const known = new Set(((old && old.chapters) || []).map(c => String(c.id)));
        const full = await adapter.fetchWork(Object.assign({}, ctx, { known }), Object.assign({}, w));
        if (full.chapters) full.chapters = withSitemapChapters(full.chapters, ctx.sitemapChapters && ctx.sitemapChapters.get(sid)).map(c => standardChapter(c, src));
        // The English title when the page gives several (the site's main one kept among the other titles)
        const best = preferEnglish([full.title].concat(full.altTitles || []));
        if (best && best !== full.title) { full.altTitles = [full.title].concat((full.altTitles || []).filter(t => t !== best)); full.title = best; }
        for (const f of FIELDS) if (filled(full[f])) w[f] = full[f];
        if (full.chapters) {
          // Updating: what the site shows now + what was stored (an incremental read stops at known chapters)
          const byId = new Map(((incremental && old && old.chapters) || []).map(c => [String(c.id), c]));
          for (const c of full.chapters) byId.set(String(c.id), c);
          const list = [...byId.values()];
          // Numbers that lost their decimal point ("605" in a list running 1…70 is 60.5)
          for (const x of fixMisreadNumbers(list)) say(`"${w.title || sid}": chapter ${x.from} read as ${x.to}`);
          chapters.set(sid, { chapters: list, partial: Boolean(full.partial) });
          w.chapterCount = list.length;
          const nums = list.map(c => parseFloat(c.n)).filter(Number.isFinite);
          w.lastChapter = nums.length ? String(Math.max(...nums)) : null;
          w.lastChapterAt = list.map(c => c.d).filter(Boolean).sort().pop() || null;
          w.partial = Boolean(full.partial) || undefined;
          // Chapters that can't be read for free right now (premium, locked)
          const premium = list.filter(c => c.pr).length;
          w.premiumChapters = premium || undefined;
          stats.premium = (stats.premium || 0) + premium;
          if (full.partial) stats.partial++;
          stats.chapters += list.length;
        }
        w.detailAt = new Date().toISOString();
        stats.read++; stats.updated++;
        refusals = 0;
      } catch (e) {
        if (e.code === 'stopped') return;
        if (e.code === 'notPublic') { if (!aborted) aborted = e; return; } // the whole site
        if (e.code === 'blocked' || (e.code === 'http' && (e.status === 401 || e.status === 403))) {
          if (++refusals >= 3 && !pagesRefused) {
            pagesRefused = e; stats.pagesRefused = true;
            say(`the site refused 3 series pages in a row (${errText(e)}): no more series pages are requested; the works keep what the listing gave`);
          }
          stats.errors++; failed.add(sid); w.error = errText(e).slice(0, 200);
          return;
        }
        stats.errors++;
        failed.add(sid);
        w.error = errText(e).slice(0, 200);
        say(`"${w.title || sid}": ${w.error}`);
      }
    };
    const lane = async () => {
      while (!run.stop && !aborted && !pagesRefused && next < queue.length) {
        const sid = queue[next++];
        const w = works[sid];
        const skipped = resume && w.detailAt && w.detailAt >= resume; // (read before an interruption)
        if (!skipped) await readWork(sid);
        if (run.stop || aborted || pagesRefused) return;
        done++;
        if (!skipped) readCount++;
        if (done % 25 === 0 || done === queue.length) say(`${done} of ${queue.length} works read (${stats.chapters} chapters, ${stats.errors} errors)`);
        // At most once a second (the crawler saves its progress every second anyway)
        if (Date.now() - lastReport >= 1000 || done === queue.length) { lastReport = Date.now(); report(worksProgress()); }
        if (Date.now() - lastFlush > 30000) flush();
      }
    };
    // (reported every second too, so the requests in progress shown are current even while works are slow)
    const ticker = setInterval(() => report(worksProgress()), 1000);
    try { await Promise.all(Array.from({ length: lanes }, lane)); } finally { clearInterval(ticker); }
    // 3. A complete full crawl: works the site no longer lists are dropped
    if (!incremental && listingComplete && !run.stop && !aborted) {
      for (const [sid, w] of Object.entries(works)) if (w.seenAt !== runStartedAt) { delete works[sid]; chapters.set(sid, null); stats.removed++; }
    }
  } catch (e) {
    if (e.code !== 'stopped') aborted = e;
  }
  stats.requests = fetcher.stats.requests;
  stats.maxActiveRequests = fetcher.stats.maxActive; // (the most requests that were in progress at once)
  flush();
  const finished = !run.stop && !aborted;
  if (aborted) say('stopped: ' + errText(aborted)); else if (run.stop) say('stop asked: what was read is saved');
  // The sitemaps as they are now, for the next update (only after a crawl that read everything it listed)
  if (ctx.sitemapNext) {
    stats.sitemaps = ctx.sitemapCounts;
    if (finished) {
      for (const f of Object.values(ctx.sitemapNext.files)) for (const sid of failed) if (f.works && sid in f.works) { delete f.works[sid]; f.hash = f.lastmod = null; } // (its file is looked at again)
      store.writeSitemapState(dir, ctx.sitemapNext);
    }
  }
  Object.assign(state, { running: !finished && !incremental, phase: finished ? 'done' : 'stopped', lastError: aborted ? errText(aborted) : null, stats, total: Object.keys(works).length });
  if (finished) { state.lastCrawlAt = runStartedAt; state.lastCompleteAt = new Date().toISOString(); state.readingKey = readingKey; }
  store.writeState(dir, state);
  current = null;
  if (aborted) throw Object.assign(new Error(errText(aborted)), { code: aborted.code || 'error', stats });
  return Object.assign({ stopped: run.stop, total: Object.keys(works).length }, stats);
}

// "Find a matching template": the templates likely for the site (its home page's markers) first, each tried with
// a few requests (its first listing page and one work page), ranked by works found and work fields read
async function findTemplate(msg) {
  const { rankTemplates } = require('./templates');
  const fetcher = createFetcher({ gapMs: 300, allowLocal: msg.allowLocal });
  const origin = new URL(msg.url).origin;
  let home = '';
  try { home = (await fetcher.get(origin + '/')).text; } catch (e) { if (e.code === 'blocked' || e.code === 'robots' || e.code === 'notPublic') throw e; }
  const ranked = rankTemplates(home);
  const tryList = ranked.filter(t => t.likely).concat(ranked.filter(t => !t.likely)).slice(0, Math.max(6, ranked.filter(t => t.likely).length));
  const out = [];
  for (const t of tryList) {
    const src = { type: 'custom', baseUrl: origin, includeChapters: true, selectors: Object.assign({}, t.selectors) };
    if (!src.selectors.listUrl) continue;
    const ctx = { src, get: fetcher.get, incremental: false, known: new Set() };
    const r = { id: t.id, name: t.name, likely: t.likely, works: 0, fields: [], sample: null, error: null };
    try {
      for await (const page of ADAPTERS.custom.listWorks(ctx)) { r.works = page.length; r.sample = page[0] && (page[0].title || page[0].sid); if (page[0]) r.first = page[0]; break; }
      if (r.first) {
        const w = await ADAPTERS.custom.fetchWork(ctx, Object.assign({}, r.first));
        r.fields = ['title', 'cover', 'summary', 'genres', 'authors', 'altTitles', 'status', 'chapters'].filter(k => (k === 'chapters' ? (w.chapters || []).length : k === 'status' ? w.status && w.status !== 'unknown' : Array.isArray(w[k]) ? w[k].length : w[k]));
        r.chapters = (w.chapters || []).length;
      }
    } catch (e) { if (e.code === 'blocked') throw e; r.error = errText(e).slice(0, 160); }
    delete r.first;
    out.push(r);
  }
  out.sort((a, b) => (b.works > 0) - (a.works > 0) || b.fields.length - a.fields.length || (b.likely ? 1 : 0) - (a.likely ? 1 : 0));
  return { results: out, requests: fetcher.stats.requests };
}

// "Test" in the Sources page: what the settings find on the site, without saving anything
async function test(msg) {
  const src = Object.assign({}, msg.source, { includeChapters: true });
  const adapter = ADAPTERS[src.type];
  const fetcher = createFetcher({ gapMs: 300, allowLocal: msg.allowLocal, access: accessOf(src) });
  const ctx = { src, get: fetcher.get, page: src.render ? u => fetcher.render(u, { waitMs: src.renderWaitMs }) : null, incremental: false, known: new Set() };
  const out = { works: [], firstPageCount: 0, work: null, errors: [] };
  try {
    for await (const page of lister(src, adapter)(ctx)) { out.firstPageCount = page.length; out.works = page.slice(0, 8); break; }
  } catch (e) { out.errors.push(errText(e)); }
  if (out.works[0]) {
    try {
      const w = await adapter.fetchWork(ctx, Object.assign({}, out.works[0]));
      out.work = Object.assign({}, w, { chapters: undefined, chapterCount: w.chapters ? w.chapters.length : null, firstChapters: (w.chapters || []).slice(0, 5) });
    } catch (e) { out.errors.push(errText(e)); }
  }
  out.requests = fetcher.stats.requests;
  return out;
}

if (require.main === module && process.send) {
  process.on('disconnect', () => process.exit(0));
  const send = m => { try { process.send(m); } catch { /* the server is gone */ } };
  process.on('message', async msg => {
    if (!msg) return;
    if (msg.type === 'stop') { stop(); return; }
    if (!['crawl', 'test', 'detect', 'siteFile', 'preview'].includes(msg.type)) return;
    const run = { crawl: () => crawl(msg, send), detect: () => require('./detect').detect(msg), test: () => test(msg),
      siteFile: () => require('./sitefiles').readSiteFile(msg), preview: () => require('./sitefiles').previewPage(msg), findTemplate: () => findTemplate(msg) }[msg.type];
    try { send({ type: 'result', reqId: msg.reqId, result: await run() }); }
    catch (e) { send({ type: 'error', reqId: msg.reqId, code: e.code || null, message: e.message, stats: e.stats || null }); }
  });
  send({ type: 'ready' });
}

// Stops the crawl in progress (it saves what it has and ends)
function stop() { if (current) { current.stop = true; current.fetcher.stop(); return true; } return false; }

module.exports = { crawl, test, stop };
