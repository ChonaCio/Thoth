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
function standardChapter(c, src) {
  // MangaDex gives the number apart from the title
  const raw = src.type === 'mangadex' && c.n ? `Chapter ${c.n} ${c.t || ''}` : c.t;
  const std = chapterTitle(raw, c.n);
  const out = Object.assign({}, c, { t: std.name, n: std.n != null ? std.n : c.n });
  if (std.v && !out.v) out.v = std.v;
  if (c.t && c.t !== std.name) out.raw = c.t;
  return out;
}

// What decides how a source's works are read (not its name, schedule or pause)
function settingsKey(src) {
  const pick = { type: src.type, listing: src.listing, workPattern: src.workPattern, chapterPattern: src.chapterPattern, listPath: src.listPath, languages: src.languages,
    contentRating: src.contentRating, includeChapters: src.includeChapters !== false, selectors: src.selectors || {}, actions: src.actions || {} };
  return require('crypto').createHash('sha1').update(JSON.stringify(pick)).digest('hex').slice(0, 16);
}

// The chapters the sitemaps list for a work, added to what its page showed (once each; the page's own keep their names)
const { chapterNum } = require('./adapters');
function withSitemapChapters(list, fromSitemaps) {
  if (!fromSitemaps || !fromSitemaps.length) return list;
  const byId = new Map(list.map(c => [String(c.id), c]));
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
  const fetcher = createFetcher({ gapMs, parallel, allowLocal: msg.allowLocal });
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
  const flush = () => { store.writeWorks(dir, { sourceId: src.id, works }); chapters.flush(); lastFlush = Date.now(); send({ type: 'flushed', reqId: msg.reqId }); };
  const ctx = { src, get: (u, o) => { if (run.stop) throw Object.assign(new Error('Stopped'), { code: 'stopped' }); return fetcher.get(u, o); }, incremental,
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
      } catch (e) {
        if (e.code === 'stopped') return;
        if (e.code === 'blocked' || e.code === 'notPublic') { if (!aborted) aborted = e; return; } // the whole site
        stats.errors++;
        failed.add(sid);
        w.error = errText(e).slice(0, 200);
        say(`"${w.title || sid}": ${w.error}`);
      }
    };
    const lane = async () => {
      while (!run.stop && !aborted && next < queue.length) {
        const sid = queue[next++];
        const w = works[sid];
        const skipped = resume && w.detailAt && w.detailAt >= resume; // (read before an interruption)
        if (!skipped) await readWork(sid);
        if (run.stop || aborted) return;
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

// "Test" in the Sources page: what the settings find on the site, without saving anything
async function test(msg) {
  const src = Object.assign({}, msg.source, { includeChapters: true });
  const adapter = ADAPTERS[src.type];
  const fetcher = createFetcher({ gapMs: 300, allowLocal: msg.allowLocal });
  const ctx = { src, get: fetcher.get, incremental: false, known: new Set() };
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
      siteFile: () => require('./sitefiles').readSiteFile(msg), preview: () => require('./sitefiles').previewPage(msg) }[msg.type];
    try { send({ type: 'result', reqId: msg.reqId, result: await run() }); }
    catch (e) { send({ type: 'error', reqId: msg.reqId, code: e.code || null, message: e.message, stats: e.stats || null }); }
  });
  send({ type: 'ready' });
}

// Stops the crawl in progress (it saves what it has and ends)
function stop() { if (current) { current.stop = true; current.fetcher.stop(); return true; } return false; }

module.exports = { crawl, test, stop };
