// External catalog: sites added as sources are crawled (by a separate process, catalog/worker.js) for every
// work they list, with metadata and chapter list. Here: the sources and their settings, the crawl queue and
// schedule, reading the catalog back, matching it against the library, merging the same work found on several
// sites (and suggesting merges), and covers (fetched by the server and cached, so browsers never call the sites).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork, spawn } = require('child_process');
const store = require('../db');
const cstore = require('./store');
const tasks = require('../tasks');
const { preferEnglish, parseTitle, EDITION_ORDER } = require('../titles');
const { chapterTitle } = require('../naming');
const { ADAPTERS, TYPES } = require('./adapters');
const { publicUrl, UA } = require('./fetcher');
const { normTitle, fromUrl } = require('../metadata/providers');
const terms = require('../metadata/terms');
const names = require('./names');
// A work's metadata-site entries ("anilist:123", "mangadex:…") from its links (read from its page)
const siteIds = w => Object.entries(w.links || {}).filter(([, id]) => id).map(([p, id]) => p + ':' + id);

const { db } = store;
if (!db.catalogSources) db.catalogSources = {};
if (!db.catalogMerges) db.catalogMerges = { groups: {}, dismissed: [] };
// Catalog-wide settings: titleRemove = text that's never part of a title (removed from every title, for merging)
if (!db.catalogSettings) db.catalogSettings = { titleRemove: [] };
const DIR = path.join(store.DATA_DIR, 'catalog');
const COVER_DIR = path.join(store.DATA_DIR, 'cache', 'catalog-covers');
const ALLOW_LOCAL = process.env.THOTH_CATALOG_ALLOW_LOCAL === '1'; // tests only
const IDLE_MS = Math.max(0, Number(process.env.THOTH_WORKER_IDLE_MS) || 10000);
const SCHEDULES = { manual: 0, daily: 86400000, weekly: 7 * 86400000 };
const sourceDir = id => path.join(DIR, id);
const err = (status, code) => Object.assign(new Error(code), { status, code });

/* ---------------- sources ---------------- */
// Settings from a form/API body (validated); `current` when editing
function cleanActions(a) {
  const out = {};
  for (const k of ['list', 'work', 'chapters']) {
    // kind 'click' (default) or 'scroll' (loads: the requests the page makes when that list is scrolled)
    const list = (Array.isArray(a && a[k]) ? a[k] : []).map(x => {
      const kind = x && x.kind === 'scroll' ? 'scroll' : 'click';
      const out = { kind, selector: String((x && x.selector) || '').trim().slice(0, 300), mode: x && x.mode === 'open' ? 'open' : 'add' };
      if (kind === 'scroll') out.loads = [].concat((x && x.loads) || []).map(u => String(u || '').trim().slice(0, 1000)).filter(u => publicUrl(u, ALLOW_LOCAL)).slice(0, 2);
      return out;
    }).filter(x => x.selector || (x.kind === 'scroll' && x.loads.length)).slice(0, 5);
    if (list.length) out[k] = list;
  }
  return out;
}
function parseSource(body, current) {
  const b = body || {};
  const s = Object.assign({}, current || {});
  if ('type' in b || !current) {
    if (!TYPES.includes(b.type)) throw err(400, 'invalid');
    s.type = b.type;
  }
  const adapter = ADAPTERS[s.type];
  if ('name' in b || !current) { s.name = String(b.name || '').trim().slice(0, 80); if (!s.name) throw err(400, 'nameRequired'); }
  if ('baseUrl' in b || !current) {
    const url = String(b.baseUrl || adapter.defaults.baseUrl || '').trim().replace(/\/+$/, '');
    if (!publicUrl(url, ALLOW_LOCAL)) throw err(400, 'invalidUrl');
    s.baseUrl = url;
  }
  if ('languages' in b) s.languages = String(b.languages || '').toLowerCase().split(/[\s,]+/).filter(x => /^[a-z]{2}(-[a-z]{2,4})?$/.test(x)).slice(0, 10).join(',');
  else if (!current) s.languages = adapter.defaults.languages || '';
  if ('contentRating' in b) s.contentRating = String(b.contentRating || '').split(/[\s,]+/).filter(x => ['safe', 'suggestive', 'erotica', 'pornographic'].includes(x)).join(',') || 'safe,suggestive';
  if ('includeChapters' in b || !current) s.includeChapters = b.includeChapters !== false;
  if ('maxWorks' in b) s.maxWorks = Math.max(0, Math.min(1000000, Math.round(Number(b.maxWorks) || 0)));
  if ('schedule' in b || !current) s.schedule = Object.keys(SCHEDULES).includes(b.schedule) || b.schedule === 'hours' ? b.schedule : 'manual';
  if ('gapMs' in b) s.gapMs = Math.max(200, Math.min(60000, Math.round(Number(b.gapMs) || 0))) || adapter.defaults.gapMs;
  else if (!current) s.gapMs = adapter.defaults.gapMs || 1000;
  // Works read at the same time in a crawl (0: the server's setting)
  if ('concurrency' in b) { const n = Math.round(Number(b.concurrency) || 0); if (n) s.concurrency = Math.max(1, Math.min(8, n)); else delete s.concurrency; }
  if ('listPath' in b) s.listPath = String(b.listPath || '').trim().replace(/[^\w\-/]/g, '').slice(0, 80);
  if ('selectors' in b && b.selectors && typeof b.selectors === 'object') {
    const keys = ['listUrl', 'firstPage', 'maxPages', 'extraListUrls', 'linkPattern', 'item', 'link', 'title', 'cover', 'workTitle', 'workCover', 'summary', 'genres', 'tags', 'authors', 'altTitles', 'altSeparator', 'status', 'type', 'year', 'chapter', 'chapterLink', 'chapterTitle', 'chapterDate'];
    s.selectors = {};
    for (const k of keys) if (b.selectors[k] != null && String(b.selectors[k]).trim()) s.selectors[k] = String(b.selectors[k]).trim().slice(0, 400);
  }
  // Clean-up rules per field: { field: { counts, label, own, remove (a regular expression) } }
  if ('clean' in b) {
    const out = {};
    for (const [k, r] of Object.entries((b.clean && typeof b.clean === 'object') ? b.clean : {})) {
      if (!/^(workTitle|altTitles|summary|genres|tags|authors|status|type|year|title)$/.test(k) || !r || typeof r !== 'object') continue;
      const one = {};
      for (const x of ['counts', 'label', 'own']) if (r[x] === true) one[x] = true;
      const re = String(r.remove || '').slice(0, 200);
      if (re) { try { new RegExp(re, 'giu'); one.remove = re; } catch { throw err(400, 'invalidRegex'); } }
      if (Object.keys(one).length) out[k] = one;
    }
    if (Object.keys(out).length) s.clean = out; else delete s.clean;
  }
  // Clicks to make before collecting (other sites): { list, work, chapters: [{ selector, mode: 'open' | 'add' }] }
  if ('actions' in b) s.actions = cleanActions(b.actions);
  // Pages built in a headless browser on the server (sites that build their pages with scripts), and how long
  // their scripts get (ms)
  if ('render' in b) { if (b.render) s.render = true; else { delete s.render; delete s.renderWaitMs; } }
  if ('renderWaitMs' in b && s.render) s.renderWaitMs = Math.max(1000, Math.min(60000, Math.round(Number(b.renderWaitMs) || 8000)));
  // Blacklist: works with any of these genres/categories, tags or authors are left out of this source's entries
  if ('blacklist' in b) {
    const listOf = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/)).map(x => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))].slice(0, 300);
    const bl = { genres: listOf(b.blacklist && b.blacklist.genres), tags: listOf(b.blacklist && b.blacklist.tags), authors: listOf(b.blacklist && b.blacklist.authors) };
    if (bl.genres.length || bl.tags.length || bl.authors.length) s.blacklist = bl; else delete s.blacklist;
  }
  // "Every N hours" schedule
  if ('scheduleHours' in b) { const h = Math.round(Number(b.scheduleHours) || 0); if (h >= 1) s.scheduleHours = Math.min(24 * 30, h); else delete s.scheduleHours; }
  // Updates also re-read ongoing works when they're due (on by default)
  if ('checkOngoing' in b) { if (b.checkOngoing === false) s.checkOngoing = false; else delete s.checkOngoing; }
  // Complete chapter lists: the "Full chapter list URL" ({url} {slug} {id} {page} {skip} {take} {cursor}) and whether
  // to look for the rest at all (on by default)
  if ('chaptersUrl' in b) { const u = String(b.chaptersUrl || '').trim().slice(0, 400); if (u) s.chaptersUrl = u; else delete s.chaptersUrl; }
  if ('fullChapters' in b) { if (b.fullChapters === false) s.fullChapters = false; else delete s.fullChapters; }
  // Access for sites that answer 403: mode 'auto' | 'plain'; cookies / headers are write-only (kept unless new ones
  // are given or removeCookies / removeHeaders is set)
  if ('access' in b && b.access && typeof b.access === 'object') {
    const a = Object.assign({}, s.access || {});
    if (b.access.mode) a.mode = b.access.mode === 'plain' ? 'plain' : 'auto';
    const { cookiePairs, headerLines } = require('./fetcher');
    if (b.access.removeCookies) delete a.cookies; else if (String(b.access.cookies || '').trim()) a.cookies = cookiePairs(b.access.cookies).join('; ').slice(0, 4000);
    if (b.access.removeHeaders) delete a.headers; else if (String(b.access.headers || '').trim()) a.headers = headerLines(b.access.headers);
    if (!a.cookies) delete a.cookies;
    if (a.headers && !Object.keys(a.headers).length) delete a.headers;
    if (a.mode === 'auto' && !a.cookies && !a.headers) delete s.access; else s.access = a;
  }
  if ('enabled' in b) s.enabled = b.enabled !== false;
  if ('autoDetect' in b) s.autoDetect = b.autoDetect !== false;
  if ('siteUrl' in b) { const u = String(b.siteUrl || '').trim().replace(/\/+$/, ''); if (u && !publicUrl(u, ALLOW_LOCAL)) throw err(400, 'invalidUrl'); if (u) s.siteUrl = u; }
  // Found by "Detect" (or set by hand): list the works from the sitemaps, by the address pattern of work pages
  if ('listing' in b) s.listing = b.listing === 'sitemap' ? 'sitemap' : 'pages';
  if ('sitemaps' in b) s.sitemaps = (Array.isArray(b.sitemaps) ? b.sitemaps : String(b.sitemaps || '').split(/\s+/)).map(x => String(x).trim()).filter(u => publicUrl(u, ALLOW_LOCAL)).slice(0, 20);
  if ('workPattern' in b) s.workPattern = String(b.workPattern || '').trim().slice(0, 200);
  if ('chapterPattern' in b) s.chapterPattern = String(b.chapterPattern || '').trim().slice(0, 200);
  if ('iconUrl' in b) s.iconUrl = publicUrl(String(b.iconUrl || ''), ALLOW_LOCAL) ? String(b.iconUrl) : null;
  if (s.listing === 'sitemap' && !s.workPattern) throw err(400, 'workPatternRequired');
  return s;
}
function listSources() {
  return Object.values(db.catalogSources).sort((a, b) => String(a.created).localeCompare(String(b.created))).map(sourceView);
}
// (the administrator's cookies and headers never leave the server: only their names)
const accessView = a => (a ? { mode: a.mode || 'auto', cookieNames: String(a.cookies || '').split(/;\s*/).filter(Boolean).map(x => x.split('=')[0]), headerNames: Object.keys(a.headers || {}) } : { mode: 'auto', cookieNames: [], headerNames: [] });
function sourceView(s) {
  if (!liveCrawl(s.id)) adoptDetected(s.id); // (a finished crawl's detection, kept)
  const st = cstore.readState(sourceDir(s.id));
  const job = sourceJob(s.id);
  return Object.assign({}, s, {
    works: st.total != null ? st.total : (loaded.get(s.id) || { list: [] }).list.length,
    lastCrawlAt: st.lastCrawlAt || null, lastCompleteAt: st.lastCompleteAt || null, lastError: st.lastError || null, lastStats: st.stats || null,
    interrupted: Boolean(st.running && !job), job, label: ADAPTERS[s.type].label, icon: Boolean(s.iconUrl),
    hidden: s.blacklist ? (catalogItems(), hiddenBySource.get(s.id) || 0) : 0,
    access: accessView(s.access)
  });
}
// A new source needs only a name and its address: the rest is detected now (robots.txt, every sitemap, the
// address patterns, the theme, the icon) and again at every crawl (autoDetect). Settings given in full (type
// included) are kept as given.
async function createSource(body) {
  body = body || {};
  let s;
  if (!body.type) {
    const url = String(body.baseUrl || body.url || '').trim();
    if (!publicUrl(url, ALLOW_LOCAL)) throw err(400, 'invalidUrl');
    let d = null;
    try { d = await detectSource(url); } catch (e) { d = { error: e.message, notes: ['failed'] }; }
    const found = (d && d.settings) || {};
    s = parseSource(Object.assign({ type: 'custom', includeChapters: true }, found, { name: String(body.name || '').trim() || found.name || new URL(url).hostname, baseUrl: found.baseUrl || url }));
    s.siteUrl = url;
    s.autoDetect = true;
    s.detected = d ? { at: new Date().toISOString(), notes: d.notes || [], blocked: Boolean(d.blocked), error: d.error || null, found: d.found ? Object.assign({}, d.found, { patterns: undefined }) : null } : null;
  } else {
    s = parseSource(body);
    s.autoDetect = false;
  }
  s.id = 'src-' + crypto.randomBytes(5).toString('hex');
  s.created = new Date().toISOString();
  s.enabled = true;
  db.catalogSources[s.id] = s;
  store.saveLibrary();
  return sourceView(s);
}
function updateSource(id, body) {
  const cur = db.catalogSources[id];
  if (!cur) throw err(404, 'notFound');
  const s = parseSource(body, cur);
  s.updated = new Date().toISOString();
  db.catalogSources[id] = s;
  store.saveLibrary();
  return sourceView(s);
}
function removeSource(id) {
  if (!db.catalogSources[id]) throw err(404, 'notFound');
  // A crawl of it runs in its own process: it has to end first (it would write its folder again)
  if (liveCrawl(id)) throw err(409, 'catalogCrawling');
  stopCrawl(id);
  delete db.catalogSources[id];
  // Its works leave the merge groups
  for (const [gid, g] of Object.entries(db.catalogMerges.groups)) {
    g.keys = g.keys.filter(k => !k.startsWith(id + ':'));
    if (g.keys.length < 2) delete db.catalogMerges.groups[gid];
  }
  if (db.catalogMerges.apart) db.catalogMerges.apart = db.catalogMerges.apart.filter(p => !p.split('|').some(k => k.startsWith(id + ':')));
  store.saveLibrary();
  fs.rmSync(sourceDir(id), { recursive: true, force: true });
  loaded.delete(id);
  catalogVersion++;
}

// Clear the crawled catalog: every source's works, chapters and crawl state (the next crawl is a full one), the
// manual merges, splits and "not the same" marks, and the cached covers. Kept: the sources and their settings.
function clearCatalog() {
  if (Object.keys(db.catalogSources).some(liveCrawl)) throw err(409, 'catalogCrawling');
  let removed = 0;
  for (const id of Object.keys(db.catalogSources)) {
    removed += sourceWorks(id).length;
    const dir = sourceDir(id);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f !== 'detected.json') fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    loaded.delete(id);
  }
  db.catalogMerges = { groups: {}, dismissed: [], apart: [] };
  store.saveLibrary();
  fs.rmSync(COVER_DIR, { recursive: true, force: true });
  catalogVersion++;
  console.log(`[catalog] cleared: ${removed} works removed (sources kept)`);
  return { removed };
}

/* ---------------- crawling: independent crawler processes ----------------
 * Each crawl is its own detached process (crawler.js) that doesn't depend on the server: it keeps going through
 * server restarts and talks to the server only through files in the source's folder (job.json, progress.json
 * with a heartbeat, a "stop" file). Up to maxCrawls() run at once (different sites); others wait in line here.
 * The quick jobs (Test, Detect) use a small helper process (catalog/worker.js), started when needed. */
// (Server settings: catalogCrawls; THOTH_MAX_CRAWLS overrides it)
const maxCrawls = () => Math.max(1, Number(process.env.THOTH_MAX_CRAWLS) || Number(require('../../config').get().catalogCrawls) || 2);
// Works one crawl reads at the same time: the source's own setting, else the server's
const crawlConcurrency = s => Math.max(1, Math.min(8, Number(s.concurrency) || Number(require('../../config').get().catalogConcurrency) || 3));
const queue = []; // waiting crawls: { id, sourceId, mode, reason, createdAt }
let jobSeq = 0;
let autoMergedAtStart = false;
const recent = new Map(); // sourceId → last finished progress (for the list of crawls)
const proc = { child: null, pid: null, pending: new Map(), seq: 0, idleTimer: null };
const readProgress = id => { try { return JSON.parse(fs.readFileSync(path.join(sourceDir(id), 'progress.json'), 'utf8')); } catch { return null; } };
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A crawl in progress for this source (its process alive and beating), or null. A crawl whose process died
// without saying so is marked as failed.
function liveCrawl(id) {
  const p = readProgress(id);
  if (!p || (p.status !== 'running' && p.status !== 'starting')) return null;
  const beat = Date.parse(p.heartbeatAt || p.startedAt || 0) || 0;
  if (p.status === 'starting' && Date.now() - beat < 15000) return p;
  if (alive(p.pid) && Date.now() - beat < 30000) return p;
  p.status = 'failed'; p.error = 'The crawler process stopped unexpectedly'; p.finishedAt = new Date().toISOString();
  try { fs.writeFileSync(path.join(sourceDir(id), 'progress.json'), JSON.stringify(p)); } catch { /* the folder is gone */ }
  return null;
}
const jobView = (sourceId, p, queued) => queued
  ? { id: queued.id, sourceId, mode: queued.mode, status: 'queued', createdAt: queued.createdAt, progress: null, result: null, error: null }
  : p ? { id: p.jobId, sourceId, mode: p.mode, status: p.status === 'starting' ? 'running' : p.status, startedAt: p.startedAt || null, finishedAt: p.finishedAt || null,
    pid: p.pid || null, progress: liveProgress(p.progress), result: p.result || null, error: p.error || null } : null;
// The time left as of now (the crawler wrote it up to a second ago)
const liveProgress = pr => (pr && pr.etaMs != null && pr.at ? Object.assign({}, pr, { etaMs: Math.max(0, pr.etaMs - (Date.now() - pr.at)) }) : pr || null);
function sourceJob(id) {
  const q = queue.find(j => j.sourceId === id);
  if (q) return jobView(id, null, q);
  const p = liveCrawl(id);
  return p ? jobView(id, p) : null;
}
function crawl(sourceId, { mode = 'full', reason = 'manual' } = {}) {
  const s = db.catalogSources[sourceId];
  if (!s) throw err(404, 'notFound');
  const current = sourceJob(sourceId);
  if (current) return current;
  const job = { id: 'c' + Date.now().toString(36) + (++jobSeq), sourceId, mode: mode === 'update' ? 'update' : 'full', reason, createdAt: new Date().toISOString() };
  queue.push(job);
  pumpCrawls();
  return sourceJob(sourceId);
}
function runningCrawls() { return Object.keys(db.catalogSources).filter(id => liveCrawl(id)); }
function startCrawl(job) {
  const s = db.catalogSources[job.sourceId];
  if (!s) return;
  const dir = sourceDir(s.id);
  fs.mkdirSync(dir, { recursive: true });
  const st = cstore.readState(dir);
  // Its log (Processes → Tasks, Logs page): written by the crawler process itself
  const startedAt = new Date();
  const logFile = tasks.logPathFor('crawl', job.id, startedAt);
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, `# ${crawlTitle(s, job.mode)}\n`); } catch { /* best effort */ }
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ jobId: job.id, mode: job.mode, reason: job.reason, allowLocal: ALLOW_LOCAL, concurrency: crawlConcurrency(s), logFile,
    source: Object.assign({}, s, { lastCrawlAt: st.lastCrawlAt || null }) }));
  crawlTask(s.id, job.id, job.mode, logFile, startedAt);
  fs.rmSync(path.join(dir, 'stop'), { force: true });
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ jobId: job.id, sourceId: s.id, mode: job.mode, status: 'starting', startedAt: new Date().toISOString() }));
  const out = fs.openSync(path.join(dir, 'crawl.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'crawler.js'), dir], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env });
  fs.closeSync(out);
  child.unref();
  console.log(`[catalog] ${job.mode} crawl of "${s.name}" started as its own process (pid ${child.pid})`);
}
// A crawl as a task (Processes → Tasks): its progress read from its progress file, Stop through the stop file
const crawlTitle = (s, mode) => `${mode === 'update' ? 'Update' : 'Crawl'} of "${s.name}"`;
function crawlTask(sourceId, jobId, mode, logFile, startedAt) {
  if (tasks.find(jobId)) return;
  const s = db.catalogSources[sourceId] || { name: sourceId };
  tasks.start({ kind: 'crawl', id: jobId, title: crawlTitle(s, mode), logFile, startedAt, cancel: () => stopCrawl(sourceId),
    progress: () => {
      const j = sourceJob(sourceId), p = (j && j.progress) || {};
      const listing = !p.phase || p.phase === 'listing';
      return { phase: listing ? 'listing' : 'works', done: listing ? p.listed || 0 : p.done || 0, total: listing ? null : p.total || 0,
        percent: listing || !p.total ? null : Math.min(100, Math.floor((p.done || 0) / p.total * 100)), etaMs: listing ? null : p.etaMs != null ? p.etaMs : null, errors: p.errors || 0, requestsNow: p.requestsNow || null };
    } });
}
// Starts waiting crawls while there's room; notices finished ones (logged once)
let pumpTimer = null;
function pumpCrawls() {
  // Crawls still running from before a server restart: their tasks again
  for (const id of Object.keys(db.catalogSources)) {
    const p = liveCrawl(id);
    if (p && p.jobId && !tasks.find(p.jobId)) {
      let job = null; try { job = JSON.parse(fs.readFileSync(path.join(sourceDir(id), 'job.json'), 'utf8')); } catch { /* none */ }
      if (job && job.logFile && job.jobId === p.jobId) crawlTask(id, p.jobId, p.mode, job.logFile, p.startedAt);
    }
  }
  let running = runningCrawls().length;
  while (queue.length && running < maxCrawls()) { startCrawl(queue.shift()); running++; }
  for (const id of Object.keys(db.catalogSources)) {
    const p = readProgress(id);
    if (p && p.finishedAt && (!recent.has(id) || recent.get(id).jobId !== p.jobId)) {
      const first = recent.size === 0 && !pumpTimer; // (at startup, old results aren't news)
      recent.set(id, p);
      catalogVersion++;
      const r = p.result || {};
      tasks.endById(p.jobId, p.status === 'done' ? 'done' : p.status === 'stopped' ? 'stopped' : 'failed',
        p.error || `${r.listed || 0} listed, ${r.added || 0} new, ${r.read || 0} read, ${r.chapters || 0} chapters` + (r.premium ? ` (${r.premium} premium)` : '') + `, ${r.errors || 0} errors` + (r.maxActiveRequests ? `; up to ${r.maxActiveRequests} request(s) in progress at once` : ''));
      adoptDetected(id);
      if (!first) console.log(`[catalog] crawl of "${db.catalogSources[id].name}" ${p.status}${p.error ? `: ${p.error}` : ''}`);
      // New works may be the same as others: merge the certain ones (also once at startup)
      if (!first || !autoMergedAtStart) { autoMergedAtStart = true; try { autoMerge(); } catch (e) { console.error('[catalog] automatic merge:', e.message); } }
    }
  }
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(pumpCrawls, queue.length || running ? 2000 : 30000);
  pumpTimer.unref();
}
// What a crawl's detection found, kept in the source's settings (automatic sources only)
function adoptDetected(id) {
  const s = db.catalogSources[id];
  if (!s || s.autoDetect !== true) return;
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(sourceDir(id), 'detected.json'), 'utf8')); } catch { return; }
  if (s.detected && s.detected.at === d.at) return;
  s.detected = { at: d.at, notes: d.notes || [], blocked: Boolean(d.blocked), error: d.error || null, found: d.found || null };
  if (d.settings) for (const k of ['type', 'baseUrl', 'listing', 'sitemaps', 'workPattern', 'chapterPattern', 'listPath', 'iconUrl']) if (d.settings[k] != null && d.settings[k] !== '') s[k] = d.settings[k];
  store.saveLibrary();
}
function stopCrawl(sourceId) {
  const i = queue.findIndex(j => j.sourceId === sourceId);
  if (i !== -1) queue.splice(i, 1);
  if (!liveCrawl(sourceId)) return i !== -1;
  fs.writeFileSync(path.join(sourceDir(sourceId), 'stop'), new Date().toISOString());
  return true;
}
function jobs() {
  return Object.keys(db.catalogSources).map(id => sourceJob(id) || jobView(id, readProgress(id))).filter(Boolean);
}
// The helper process for quick jobs (Test, Detect)
function ensureProcess() {
  clearTimeout(proc.idleTimer); proc.idleTimer = null;
  if (proc.child) return proc;
  const child = fork(path.join(__dirname, 'worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed here */ }
  proc.child = child; proc.pid = child.pid;
  child.on('message', m => {
    const p = m && proc.pending.get(m.reqId);
    if (!p || m.type === 'progress') return;
    proc.pending.delete(m.reqId);
    if (m.type === 'result') p.resolve(m.result); else p.reject(Object.assign(new Error(m.message), { code: m.code }));
  });
  const gone = e => { if (proc.child !== child) return; proc.child = null; proc.pid = null; for (const p of proc.pending.values()) p.reject(e); proc.pending.clear(); };
  child.on('error', gone);
  child.on('exit', code => gone(new Error(`Helper process stopped (exit code ${code})`)));
  return proc;
}
function closeWhenIdle() {
  clearTimeout(proc.idleTimer);
  proc.idleTimer = setTimeout(() => {
    if (proc.pending.size || !proc.child) return;
    const c = proc.child; proc.child = null; proc.pid = null;
    c.removeAllListeners('exit'); try { c.kill(); } catch { /* gone */ }
  }, IDLE_MS);
  proc.idleTimer.unref();
}
function ask(msg) {
  ensureProcess();
  return new Promise((resolve, reject) => {
    const reqId = ++proc.seq;
    proc.pending.set(reqId, { resolve, reject });
    proc.child.send(Object.assign({ reqId }, msg));
  }).finally(() => { if (!proc.pending.size) closeWhenIdle(); });
}

// What a source's settings find on the site (nothing saved)
function testSource(body) {
  // (editing a source: its saved cookies and headers are used too, unless the form gives new ones)
  const saved = body && body.sourceId && db.catalogSources[body.sourceId];
  const s = Object.assign(parseSource(body, saved && saved.access ? { access: saved.access } : undefined), { id: 'test' });
  return ask({ type: 'test', source: s, allowLocal: ALLOW_LOCAL });
}
// What a site's robots.txt, sitemaps and pages say about it: proposed settings for a new source
function detectSource(url) {
  if (!publicUrl(String(url || ''), ALLOW_LOCAL)) throw err(400, 'invalidUrl');
  return ask({ type: 'detect', url, allowLocal: ALLOW_LOCAL });
}
/* ---------------- a source's site files (robots.txt, sitemaps) and pages (the wizard's picker) ---------------- */
// What's known of a source's robots.txt and sitemaps: the ones it uses, the ones detection found, and the ones its
// last crawl read (with their content hash, date and how many works each listed)
function siteFiles(id) {
  const s = db.catalogSources[id];
  if (!s) throw err(404, 'notFound');
  const origin = new URL(s.siteUrl || s.baseUrl).origin;
  const state = cstore.readSitemapState(sourceDir(id)) || { files: {} };
  const found = (s.detected && s.detected.found && s.detected.found.sitemaps) || [];
  const all = new Map();
  const add = (loc, from) => { if (!loc) return; const e = all.get(loc) || { loc, from: [] }; if (!e.from.includes(from)) e.from.push(from); all.set(loc, e); };
  (s.sitemaps || []).forEach(u => add(u, 'settings'));
  found.forEach(u => add(typeof u === 'string' ? u : u.loc || u.url, 'detected'));
  Object.keys(state.files || {}).forEach(u => add(u, 'crawl'));
  const sitemaps = [...all.values()].map(e => { const f = (state.files || {})[e.loc]; return Object.assign(e, f ? { hash: f.hash || null, lastmod: f.lastmod || null, works: Object.keys(f.works || {}).length } : {}); });
  return { id, name: s.name, origin, robots: origin + '/robots.txt', sitemaps, crawledAt: state.at || null };
}
// Reads one of them now (only addresses of the source's own site, or sitemaps it knows)
function readSiteFile(id, url) {
  const files = siteFiles(id);
  let u; try { u = new URL(String(url || '')); } catch { throw err(400, 'invalidUrl'); }
  const hosts = new Set([new URL(files.origin).host, new URL(db.catalogSources[id].baseUrl).host]);
  if (!publicUrl(u.href, ALLOW_LOCAL) || (!hosts.has(u.host) && !files.sitemaps.some(x => x.loc === u.href))) throw err(400, 'invalidUrl');
  return ask({ type: 'siteFile', url: u.href, allowLocal: ALLOW_LOCAL });
}
// A page of a site, made inert, for the source wizard's element picker (any public page: administrators only)
// actions: clicks to make first (as crawls make them), with a report of each
// render: the page built in a headless browser first (what a source with "Build pages in a browser" reads)
// Layout templates, and which fit a site (tried by the helper process: a few requests per template)
function templates() { return require('./templates').publicTemplates(); }
function findTemplate(url) {
  if (!publicUrl(String(url || ''), ALLOW_LOCAL)) throw err(400, 'invalidUrl');
  return ask({ type: 'findTemplate', url: String(url), allowLocal: ALLOW_LOCAL });
}
function previewPage(url, { inert = false, actions = null, render = false, waitMs = 0 } = {}) {
  if (!publicUrl(String(url || ''), ALLOW_LOCAL)) throw err(400, 'invalidUrl');
  const acts = actions ? cleanActions({ work: actions }).work || [] : [];
  return ask({ type: 'preview', url: String(url), allowLocal: ALLOW_LOCAL, inert: Boolean(inert), actions: acts, render: Boolean(render),
    waitMs: render ? Math.max(1000, Math.min(60000, Math.round(Number(waitMs) || 8000))) : 0 });
}

// Scheduled crawls: an update when the schedule says so (a full crawl the first time or after an interruption)
let scheduleTimer = null;
function startSchedule() {
  pumpCrawls(); // crawls still running from before a restart are picked up
  clearInterval(scheduleTimer);
  scheduleTimer = setInterval(checkSchedule, 10 * 60 * 1000);
  scheduleTimer.unref();
}
function checkSchedule() {
  for (const s of Object.values(db.catalogSources)) {
    const every = s.schedule === 'hours' ? (s.scheduleHours || 0) * 3600000 : SCHEDULES[s.schedule] || 0;
    if (!every || s.enabled === false) continue;
    const st = cstore.readState(sourceDir(s.id));
    const last = Date.parse(st.lastCrawlAt || 0) || 0;
    if (st.running) crawl(s.id, { mode: 'full', reason: 'schedule' });
    else if (Date.now() - last >= every) crawl(s.id, { mode: last ? 'update' : 'full', reason: 'schedule' });
  }
}

/* ---------------- reading the catalog ---------------- */
let catalogVersion = 0;
const loaded = new Map(); // sourceId → { mtime, list }
function sourceWorks(id) {
  const file = cstore.worksFile(sourceDir(id));
  const st = fs.statSync(file, { throwIfNoEntry: false });
  const mtime = st ? st.mtimeMs : 0;
  const c = loaded.get(id);
  if (c && c.mtime === mtime) return c.list;
  const data = st ? cstore.readWorks(sourceDir(id)) : { works: {} };
  // Titles as the site shows them can carry noise (" - engsub", "(Official)", the site's name) and the version
  // ("[AI ANIMATION]", "(Raw)", "Full Colored"): w.title is the clean title, w.rawTitle the site's, w.editions the version
  const src = db.catalogSources[id] || {};
  const names = [src.name, src.detected && src.detected.found && src.detected.found.name].filter(Boolean);
  const { fixMojibake, fixDeep } = require('./text');
  const list = Object.values(data.works).map(w => {
    // (text a site sent already garbled — "CafÃ©" — repaired)
    for (const k of ['title', 'rawTitle', 'summary']) if (typeof w[k] === 'string') w[k] = fixMojibake(w[k]);
    for (const k of ['altTitles', 'rawAltTitles', 'authors', 'genres']) if (Array.isArray(w[k])) w[k] = fixDeep(w[k]);
    const remove = db.catalogSettings.titleRemove || [];
    const p = parseTitle(w.rawTitle || w.title, { sourceNames: names, remove });
    const alt = [...new Set((w.rawAltTitles || w.altTitles || []).map(a => parseTitle(a, { sourceNames: names, remove }).title).filter(a => a && a !== p.title))];
    return Object.assign(w, { key: id + ':' + w.sid, sourceId: id, rawTitle: w.rawTitle || w.title, title: p.title, editions: p.editions, rawAltTitles: w.rawAltTitles || w.altTitles || [], altTitles: alt });
  });
  loaded.set(id, { mtime, list });
  catalogVersion++;
  return list;
}
// The text removed from titles: { remove, affected (titles it changes) }; saving it reads every source's titles again
// and merges what's now certainly the same work
function titleCleanup() {
  const remove = db.catalogSettings.titleRemove || [];
  const res = remove.map(r => new RegExp(String(r).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const affected = allWorks().filter(w => res.some(re => re.test(w.rawTitle || w.title))).length;
  return { remove, affected };
}
function setTitleCleanup(list) {
  const remove = [...new Set((Array.isArray(list) ? list : String(list || '').split(/\r?\n/)).map(x => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 100)).filter(x => x.length >= 2))].slice(0, 200);
  db.catalogSettings.titleRemove = remove;
  store.saveLibrary();
  loaded.clear(); catalogVersion++; // (titles worked out again)
  let merged = 0;
  try { merged = autoMerge(); } catch (e) { console.error('[catalog] automatic merge:', e.message); }
  return Object.assign(titleCleanup(), { merged });
}
function allWorks() { return Object.keys(db.catalogSources).flatMap(id => sourceWorks(id)); }
const workByKey = key => { const i = key.indexOf(':'); return i > 0 ? sourceWorks(key.slice(0, i)).find(w => w.key === key) || null : null; };
function chaptersOf(key) {
  const i = key.indexOf(':');
  const id = key.slice(0, i), sid = key.slice(i + 1);
  return cstore.readShard(sourceDir(id), cstore.shardOf(sid))[sid] || { chapters: [], partial: false };
}

// Library: which works it already has (by site link, else by title). Memoized per library/catalog change.
let libIndexMemo = { ver: null, idx: null };
function libraryIndex() {
  const ver = store.generation();
  if (libIndexMemo.ver === ver) return libIndexMemo.idx;
  const byTitle = new Map(), byLink = new Map(), bySite = new Map();
  for (const s of Object.values(db.series)) {
    if (s.hidden) continue;
    const m = store.seriesMeta(s);
    for (const t of [m.title, s.name].concat(m.altTitles || [])) { const k = normTitle(t); if (k && k.length > 1 && !byTitle.has(k)) byTitle.set(k, s.id); }
    for (const u of m.links || []) { byLink.set(String(u).replace(/\/+$/, '').toLowerCase(), s.id); const x = fromUrl(u); if (x) bySite.set(x.provider + ':' + x.id, s.id); }
    for (const x of (s.provider && s.provider.matches) || []) bySite.set(x.provider + ':' + x.id, s.id);
  }
  libIndexMemo = { ver, idx: { byTitle, byLink, bySite } };
  return libIndexMemo.idx;
}
function libraryMatch(w) {
  const idx = libraryIndex();
  const ids = siteIds(w).concat(fromUrl(w.url || '') ? [(x => x.provider + ':' + x.id)(fromUrl(w.url))] : []);
  const site = ids.find(x => idx.bySite.has(x));
  if (site) return { seriesId: idx.bySite.get(site), by: 'link' };
  const link = String(w.url || '').replace(/\/+$/, '').toLowerCase();
  if (link && idx.byLink.has(link)) return { seriesId: idx.byLink.get(link), by: 'link' };
  for (const t of [w.title].concat(w.altTitles || [])) { const k = normTitle(t); if (k && idx.byTitle.has(k)) return { seriesId: idx.byTitle.get(k), by: 'title' }; }
  return null;
}

// Works as shown: merged groups count once (the primary's metadata, every source's chapters)
let itemsMemo = { ver: null, items: null };
// A version's key: 'base', 'colored', 'raw+uncensored'…; its rank (Regular first, then as the library orders them)
const editionKey = list => (list && list.length ? list.slice().sort((a, b) => EDITION_ORDER.indexOf(a) - EDITION_ORDER.indexOf(b)).join('+') : 'base');
const editionRank = key => (key === 'base' ? 0 : key.includes('+') ? 10 + key.split('+').length : 1 + EDITION_ORDER.indexOf(key));
function catalogItems() {
  const ver = catalogVersion + ':' + store.generation() + ':' + Object.keys(db.catalogSources).join(',') + ':' + JSON.stringify(Object.values(db.catalogSources).map(x => x.blacklist || 0)) + ':' + JSON.stringify(Object.keys(db.catalogMerges.groups).length) + ':' + catalogVersion;
  const works = allWorks();
  const v2 = ver + ':' + works.length + ':' + catalogVersion;
  if (itemsMemo.ver === v2) return itemsMemo.items;
  hiddenBySource.clear();
  const units = unitItems(works);
  // Versions: units with the same clean title and different versions are one work (like a library's "Work" and
  // "Work (Colored)"); a second unit of a version already taken stays its own work
  const byTitle = new Map();
  for (const u of units) { const k = normTitle(u.title) || u.key; if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(u); }
  const items = [], byKey = new Map();
  for (const group of byTitle.values()) {
    group.sort((a, b) => editionRank(a.edition) - editionRank(b.edition) || b.chapters - a.chapters);
    const taken = new Map(), rest = [];
    for (const u of group) { if (taken.has(u.edition)) rest.push([u]); else taken.set(u.edition, u); }
    for (const list of [[...taken.values()], ...rest]) {
      const versions = list.map(u => ({ key: u.key, edition: u.edition, editions: u.editions, chapters: u.chapters, sources: u.sources.map(x => x.name) }));
      for (const u of list) { u.versions = versions; byKey.set(u.key, u); }
      const main = list[0];
      // The work as listed: its main version, found by any version's titles and sources
      main._text = null;
      main._allTitles = [...new Set(list.flatMap(u => [u.title].concat(u.altTitles)))];
      main._allSources = [...new Set(list.flatMap(u => u.sources.map(x => x.sourceId)))];
      main.inLibrary = main.inLibrary || (list.find(u => u.inLibrary) || {}).inLibrary || null;
      items.push(main);
    }
    for (const u of group) for (const x of u.sources) byKey.set(x.key, u);
  }
  itemsMemo = { ver: v2, items, byKey };
  return items;
}
// One entry per work of one version: a merged group (the same work on several sites) or a single work
function unitItems(works) {
  const byKey = new Map(works.map(w => [w.key, w]));
  const inGroup = new Map();
  for (const [gid, g] of Object.entries(db.catalogMerges.groups)) for (const k of g.keys) if (byKey.has(k)) inGroup.set(k, gid);
  const items = [], doneGroups = new Set();
  for (const w of works) {
    const gid = inGroup.get(w.key);
    if (gid) {
      if (doneGroups.has(gid)) continue;
      doneGroups.add(gid);
      const g = db.catalogMerges.groups[gid];
      const members = allowed(g.keys.map(k => byKey.get(k)).filter(Boolean));
      if (!members.length) continue;
      const primary = members.includes(byKey.get(g.primary)) ? byKey.get(g.primary) : members[0];
      items.push(makeItem(primary, members, gid));
    } else if (allowed([w]).length) items.push(makeItem(w, [w], null));
  }
  return items;
}
// Blacklists: an entry is left out when its source's blacklist names a genre, tag or author that any entry of the
// same work has (what all its sites say); the work stays through the other sites unless they block it too
let blacklistMemo = { ver: null, map: null };
function blacklists() {
  const ver = JSON.stringify(Object.values(db.catalogSources).map(x => x.blacklist || null));
  if (blacklistMemo.ver === ver) return blacklistMemo.map;
  const map = new Map();
  for (const x of Object.values(db.catalogSources)) {
    const bl = x.blacklist; if (!bl) continue;
    map.set(x.id, { terms: new Set(bl.genres.concat(bl.tags).map(g => terms.keyOf(terms.canonical(g)))), people: new Set(bl.authors.map(personKey).filter(Boolean)) });
  }
  blacklistMemo = { ver, map };
  return map;
}
const hiddenBySource = new Map();
function allowed(members) {
  const bls = blacklists();
  if (!bls.size || !members.some(m => bls.has(m.sourceId))) return members;
  const g = new Set(members.flatMap(m => m.genres || []).map(x => terms.keyOf(terms.canonical(x))));
  const p = new Set(members.flatMap(m => m.authors || []).map(personKey));
  return members.filter(m => {
    const bl = bls.get(m.sourceId);
    const out = bl && ([...bl.terms].some(k => g.has(k)) || [...bl.people].some(k => p.has(k)));
    if (out) hiddenBySource.set(m.sourceId, (hiddenBySource.get(m.sourceId) || 0) + 1);
    return !out;
  });
}
function makeItem(primary, members, groupId) {
  const lib = members.map(libraryMatch).find(Boolean) || null;
  // The title shown: English first (the main entry's, another source's, or one of the other titles)
  const title = preferEnglish([primary.title].concat(members.map(m => m.title), primary.altTitles || [], ...members.map(m => m.altTitles || []))) || primary.title || '';
  const genres = terms.unify(...members.map(m => (m.genres || []).concat(m.tags || [])));
  return {
    key: groupId ? 'g:' + groupId : primary.key, groupId, title, altTitles: [...new Set(members.flatMap(m => [m.title].concat(m.altTitles || [])).filter(t => t && t !== title))].slice(0, 20),
    editions: primary.editions || [], edition: editionKey(primary.editions),
    cover: Boolean(members.find(m => m.cover)), coverKey: (members.find(m => m.key === primary.key && m.cover) || members.find(m => m.cover) || primary).key,
    summary: primary.summary || (members.find(m => m.summary) || {}).summary || '', authors: [...new Set(members.flatMap(m => m.authors || []))].slice(0, 12), genres,
    status: primary.status || 'unknown', type: primary.type || null, year: primary.year || null,
    sources: members.map(m => ({ key: m.key, sourceId: m.sourceId, name: (db.catalogSources[m.sourceId] || {}).name || m.sourceId, url: m.url, chapters: m.chapterCount || 0, premium: m.premiumChapters || 0, lastChapter: m.lastChapter || null, partial: Boolean(m.partial) })),
    chapters: Math.max(0, ...members.map(m => m.chapterCount || 0)), lastChapter: members.map(m => m.lastChapter).filter(Boolean).sort((a, b) => parseFloat(b) - parseFloat(a))[0] || null,
    updatedAt: members.map(m => m.lastChapterAt || m.detailAt || m.addedAt || '').sort().pop() || null,
    inLibrary: lib ? { seriesId: lib.seriesId, by: lib.by, title: db.series[lib.seriesId] ? store.seriesMeta(db.series[lib.seriesId]).title : '' } : null,
    _text: null
  };
}
const searchable = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// Filters (all optional): q (words in titles/authors), source, lacks (a source that doesn't have it), inLibrary
// (yes|no), genre, merged, type, status, sites ('1' | '2' | '3' = at least 3), updated ('day' | 'week' | 'month':
// a chapter or change within), with/without (genres or tags it must have / must not have, comma separated),
// author (part of an author's name)
function filtered(q) {
  let items = catalogItems();
  const term = searchable(q.q);
  if (term) items = items.filter(it => (it._text || (it._text = searchable((it._allTitles || [it.title].concat(it.altTitles)).concat(it.authors).join('\n')))).includes(term));
  if (q.source) items = items.filter(it => (it._allSources || it.sources.map(s => s.sourceId)).includes(q.source));
  if (q.inLibrary === 'yes') items = items.filter(it => it.inLibrary); else if (q.inLibrary === 'no') items = items.filter(it => !it.inLibrary);
  if (q.genre) { const k = terms.keyOf(terms.canonical(q.genre)); items = items.filter(it => it.genres.some(g => terms.keyOf(g) === k)); }
  if (q.merged === 'yes') items = items.filter(it => it.groupId);
  if (q.lacks) items = items.filter(it => !(it._allSources || it.sources.map(s => s.sourceId)).includes(q.lacks));
  if (q.type) items = items.filter(it => String(it.type || '').toLowerCase() === String(q.type).toLowerCase());
  if (q.status) items = items.filter(it => (it.status || 'unknown') === q.status);
  if (q.sites) { const n = Number(q.sites) || 1; items = items.filter(it => { const c = (it._allSources || it.sources).length; return n >= 3 ? c >= 3 : c === n; }); }
  if (q.updated) {
    const ms = { day: 86400000, week: 7 * 86400000, month: 31 * 86400000 }[q.updated];
    if (ms) { const since = new Date(Date.now() - ms).toISOString(); items = items.filter(it => it.updatedAt && it.updatedAt >= since); }
  }
  const keysOf = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean).map(x => terms.keyOf(terms.canonical(x)));
  const want = keysOf(q.with), avoid = keysOf(q.without);
  if (want.length || avoid.length) items = items.filter(it => { const have = new Set(it.genres.map(g => terms.keyOf(g))); return want.every(k => have.has(k)) && !avoid.some(k => have.has(k)); });
  if (q.author) { const a = searchable(q.author); items = items.filter(it => it.authors.some(x => searchable(x).includes(a))); }
  return items;
}
function sortItems(items, sort) {
  const sorters = {
    title: (a, b) => store.collator.compare(a.title, b.title),
    updated: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    chapters: (a, b) => b.chapters - a.chapters,
    sites: (a, b) => (b._allSources || b.sources).length - (a._allSources || a.sources).length || store.collator.compare(a.title, b.title)
  };
  return items.slice().sort(sorters[sort] || sorters.title);
}
function list(q) {
  const items = sortItems(filtered(q), q.sort);
  const offset = Math.max(0, Number(q.offset) || 0), limit = Math.min(200, Math.max(1, Number(q.limit) || 60));
  return { total: items.length, offset, items: items.slice(offset, offset + limit).map(publicItem) };
}
const publicItem = it => { const o = Object.assign({}, it); delete o._text; delete o._allTitles; delete o._allSources; return o; };
const countBy = (items, fn) => { const m = new Map(); for (const it of items) { const v = fn(it); if (v) m.set(v, (m.get(v) || 0) + 1); } return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count); };
// The filtered list as a file: CSV (one link column per source) or JSON (everything, with each source's latest chapter)
function exportList(q, format) {
  const items = sortItems(filtered(q), q.sort).slice(0, 50000);
  const srcs = Object.values(db.catalogSources);
  if (format === 'json') return JSON.stringify({ exportedAt: new Date().toISOString(), total: items.length, works: items.map(it => {
    const o = publicItem(it); delete o.coverKey; delete o.cover; return o;
  }) }, null, 1);
  const head = ['title', 'alternative titles', 'type', 'status', 'year', 'authors', 'genres', 'chapters', 'latest chapter', 'updated', 'in library', 'sites'].concat(srcs.map(x => x.name));
  const rows = items.map(it => [it.title, it.altTitles.join(' | '), it.type || '', it.status || '', it.year || '', it.authors.join(' | '), it.genres.join(' | '), it.chapters, it.lastChapter || '', it.updatedAt || '',
    it.inLibrary ? it.inLibrary.title || 'yes' : '', it.sources.length].concat(srcs.map(x => (it.sources.find(y => y.sourceId === x.id) || {}).url || '')));
  return csv([head].concat(rows));
}
const csv = rows => '\ufeff' + rows.map(r => r.map(v => { const t = String(v == null ? '' : v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }).join(',')).join('\r\n') + '\r\n';
// One work's combined chapter list as a file: CSV (one link column per source) or JSON
function exportChapters(key, format) {
  const d = detail(key);
  if (format === 'json') return JSON.stringify({ title: d.title, key: d.key, sources: d.sources.map(x => ({ name: x.name, url: x.url, chapters: x.chapterList.length })), chapters: d.allChapters }, null, 1);
  const names = d.sources.map(x => x.name);
  return csv([['number', 'title', 'date', 'premium'].concat(names)].concat(d.allChapters.slice().reverse().map(c => [c.n == null ? '' : c.n, c.t || '', c.d || '', c.pr ? 'yes' : '']
    .concat(names.map(n => ((c.links || []).find(l => l.name === n) || {}).u || '')))));
}
function facets() {
  const items = catalogItems();
  const genres = new Map();
  for (const it of items) for (const g of it.genres) genres.set(g, (genres.get(g) || 0) + 1);
  return {
    total: items.length, inLibrary: items.filter(it => it.inLibrary).length,
    sources: Object.values(db.catalogSources).map(s => ({ id: s.id, name: s.name, works: sourceWorks(s.id).length })),
    genres: [...genres].map(([name, count]) => ({ name, count })).sort((a, b) => store.collator.compare(a.name, b.name)).slice(0, 200),
    types: countBy(items, it => it.type), statuses: countBy(items, it => it.status || 'unknown')
  };
}
// One work in full: every source's metadata and chapters; for a work the library has, which chapters it lacks
function detail(key) {
  catalogItems();
  const it = itemsMemo.byKey.get(key);
  if (!it) throw err(404, 'notFound');
  const sources = it.sources.map(s => {
    const w = workByKey(s.key) || {};
    const ch = chaptersOf(s.key);
    // (names cleaned again as shown: chapters crawled before the cleaning rules improved get them too)
    const chapters = (ch.chapters || []).map(c => { const std = chapterTitle(c.raw || c.t, c.n); return Object.assign({}, c, { t: std.name, n: std.n != null ? std.n : c.n }); })
      .sort((a, b) => (parseFloat(b.n) || 0) - (parseFloat(a.n) || 0));
    return Object.assign({}, s, { title: w.title, altTitles: w.altTitles || [], summary: w.summary || '', authors: w.authors || [], genres: w.genres || [], status: w.status || 'unknown',
      error: w.error || null, detailAt: w.detailAt || null, chapterList: chapters, partial: Boolean(ch.partial) });
  });
  let missing = null;
  if (it.inLibrary && db.series[it.inLibrary.seriesId]) {
    const have = new Set(store.booksOf(it.inLibrary.seriesId).map(b => String(parseFloat(store.bookMeta(b).number))).filter(x => x !== 'NaN'));
    const nums = new Map();
    // (a chapter premium on one site and free on another: the free one)
    for (const s of sources) for (const c of s.chapterList) { const n = parseFloat(c.n); if (Number.isFinite(n) && !have.has(String(n)) && (!nums.has(String(n)) || (nums.get(String(n)).pr && !c.pr))) nums.set(String(n), { n: c.n, t: c.t, u: c.u, source: s.name, pr: Boolean(c.pr) }); }
    missing = { have: have.size, chapters: [...nums.values()].sort((a, b) => parseFloat(a.n) - parseFloat(b.n)) };
  }
  return Object.assign(publicItem(it), { sources, missing, allChapters: unifiedChapters(sources) });
}
// Every chapter on any of the work's sources, once per number (or name, without one), with each source's link:
// [{ n, t, d, pr (premium on every source that has it), links: [{ name, sourceId, u, pr }] }], newest first
function unifiedChapters(sources) {
  const byN = new Map();
  for (const s of sources) for (const c of s.chapterList) {
    const num = parseFloat(c.n);
    const k = Number.isFinite(num) ? 'n' + num : 't' + String(c.t || c.id).toLowerCase();
    let e = byN.get(k);
    if (!e) byN.set(k, (e = { n: c.n != null ? String(Number.isFinite(num) ? num : c.n) : null, t: c.t || '', d: c.d || '', pr: true, links: [], sort: Number.isFinite(num) ? num : -1 }));
    if (!e.t && c.t) e.t = c.t;
    if (c.d && (!e.d || c.d < e.d)) e.d = c.d;
    if (!c.pr) e.pr = false;
    if (!e.links.some(l => l.sourceId === s.sourceId && l.u === c.u)) e.links.push({ name: s.name, sourceId: s.sourceId, u: c.u || null, pr: Boolean(c.pr), l: c.l || null });
  }
  return [...byN.values()].sort((a, b) => b.sort - a.sort).map(e => { delete e.sort; return e; });
}

/* ---------------- merging the same work found on several sites ---------------- */
function mergeSuggestions({ limit = 200, source = null } = {}) {
  const works = allWorks();
  const dismissed = new Set(db.catalogMerges.dismissed || []);
  const apart = apartSet();
  const grouped = new Set(Object.values(db.catalogMerges.groups).flatMap(g => g.keys));
  const parent = new Map(works.map(w => [w.key, w.key]));
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const why = new Map();
  const keys = new Map();
  const add = (reason, key, wkey, detail) => { const k = reason + '\0' + key; if (!keys.has(k)) keys.set(k, { keys: [], detail }); const e = keys.get(k); if (!e.keys.includes(wkey)) e.keys.push(wkey); };
  for (const w of works) {
    for (const id of siteIds(w)) add('link', id, w.key, { url: w.url });
    for (const t of [w.title].concat(w.altTitles || [])) for (const n of names.matchKeys(t)) if (n.length > 2) add('title', n + '|' + editionKey(w.editions), w.key, { title: t });
  }
  // Near-identical main titles (a typo or a letter apart), compared within buckets of the same start or end
  const near = new Map();
  for (const w of works) {
    const k = names.nameKey(w.title);
    if (k.length < 10) continue;
    for (const b of ['^' + k.slice(0, 5), '$' + k.slice(-5)]) { if (!near.has(b)) near.set(b, []); near.get(b).push([k, w]); }
  }
  for (const list of near.values()) {
    if (list.length < 2 || list.length > 400) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [ka, a] = list[i], [kb, b] = list[j];
      if (a.key === b.key || editionKey(a.editions) !== editionKey(b.editions) || !names.nearNames(ka, kb)) continue;
      add('similar', [ka, kb].sort().join('~'), a.key, { title: a.title, other: b.title }); add('similar', [ka, kb].sort().join('~'), b.key, { title: a.title, other: b.title });
    }
  }
  for (const [k, e] of keys) {
    if (e.keys.length < 2 || e.keys.length > 12) continue;
    const reason = k.split('\0')[0];
    for (let i = 1; i < e.keys.length; i++) {
      const ra = find(e.keys[0]), rb = find(e.keys[i]);
      if (ra !== rb) parent.set(rb, ra);
      const r = find(e.keys[0]);
      const rank = x => ({ link: 0, title: 1, similar: 2 })[x];
      if (!why.has(r) || rank(reason) < rank(why.get(r).reason)) why.set(r, { reason, detail: e.detail });
    }
  }
  const groups = new Map();
  for (const w of works) { const r = find(w.key); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(w); }
  const out = [];
  for (const [root, members] of groups) {
    // Only works not merged yet, from at least two different entries
    const open = members.filter(m => !grouped.has(m.key));
    if (members.length < 2 || open.length < 1 || members.every(m => grouped.has(m.key))) continue;
    const key = members.map(m => m.key).sort().join(',');
    if (dismissed.has(key)) continue;
    if (source && !members.some(m => m.sourceId === source)) continue;
    // Works an administrator separated aren't suggested together again
    if (members.every((m, i) => members.every((o, j) => i === j || apart.has(pairKey(m.key, o.key)) || (grouped.has(m.key) && grouped.has(o.key))))) continue;
    const lib = members.map(libraryMatch).find(Boolean);
    out.push(Object.assign({ key, primary: members.slice().sort((a, b) => (b.chapterCount || 0) - (a.chapterCount || 0))[0].key,
      inLibrary: lib ? { seriesId: lib.seriesId, title: db.series[lib.seriesId] ? store.seriesMeta(db.series[lib.seriesId]).title : '' } : null,
      works: members.map(m => Object.assign(workSummary(m), { merged: grouped.has(m.key) })) },
    why.get(root) || { reason: 'title', detail: {} }));
  }
  const order = { link: 0, title: 1, similar: 2 };
  out.sort((a, b) => (order[a.reason] || 0) - (order[b.reason] || 0) || store.collator.compare(a.works[0].title || '', b.works[0].title || ''));
  return { total: out.length, groups: out.slice(0, limit) };
}
// Works an administrator separated ("a|b", keys sorted): never merged again automatically
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
function apartSet() { return new Set(db.catalogMerges.apart || []); }
function keepApart(keys) {
  const s = apartSet();
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) s.add(pairKey(keys[i], keys[j]));
  db.catalogMerges.apart = [...s].slice(-20000);
}
function merge(keys, primary, { auto = null } = {}) {
  keys = [...new Set((keys || []).filter(k => typeof k === 'string'))];
  const all = new Set(allWorks().map(w => w.key));
  if (keys.length < 2 || keys.some(k => !all.has(k))) throw err(400, 'invalid');
  // Joining a work that's already in a group: the groups become one
  const groups = db.catalogMerges.groups;
  const touched = Object.entries(groups).filter(([, g]) => g.keys.some(k => keys.includes(k)));
  const merged = new Set(keys.concat(touched.flatMap(([, g]) => g.keys)));
  for (const [gid] of touched) delete groups[gid];
  const id = 'm' + crypto.randomBytes(5).toString('hex');
  groups[id] = { keys: [...merged], primary: merged.has(primary) ? primary : keys[0], at: new Date().toISOString() };
  if (auto) groups[id].auto = auto; // { reason, detail }: merged without asking
  // Merged by hand: works that were separated before may be merged again
  if (!auto && db.catalogMerges.apart) { const ks = [...merged]; db.catalogMerges.apart = db.catalogMerges.apart.filter(p => { const [a, b] = p.split('|'); return !(ks.includes(a) && ks.includes(b)); }); }
  store.saveLibrary();
  catalogVersion++;
  return { groupId: id, keys: groups[id].keys };
}
// Separating a whole group, or taking one work out of it ("split"); either way they stay apart from then on
function unmerge(groupId) {
  const g = db.catalogMerges.groups[groupId];
  if (!g) throw err(404, 'notFound');
  keepApart(g.keys);
  delete db.catalogMerges.groups[groupId];
  store.saveLibrary();
  catalogVersion++;
}
function splitOff(groupId, key) {
  const g = db.catalogMerges.groups[groupId];
  if (!g || !g.keys.includes(key)) throw err(404, 'notFound');
  const rest = g.keys.filter(k => k !== key);
  const s = apartSet();
  for (const k of rest) s.add(pairKey(key, k));
  db.catalogMerges.apart = [...s].slice(-20000);
  if (rest.length < 2) delete db.catalogMerges.groups[groupId];
  else { g.keys = rest; if (g.primary === key) g.primary = rest[0]; }
  store.saveLibrary();
  catalogVersion++;
  return { groupId: rest.length < 2 ? null : groupId, keys: rest };
}

// Merging without asking, only when it's certain the works are the same:
//   - the same MangaDex id, or
//   - the same main title AND an author or another title in common (and not of different kinds: a novel and
//     its manga share a title and an author).
// Works separated by an administrator stay apart; titles shared by more than 6 works are too common to tell.
const personKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(' ');
function sameWork(a, b) {
  if (a.type && b.type && a.type !== b.type) return null;
  const authorsA = new Set((a.authors || []).map(personKey).filter(Boolean));
  const author = (b.authors || []).map(personKey).find(k => k && authorsA.has(k));
  if (author) return { reason: 'titleAuthor', detail: { title: a.title, author: (b.authors || []).find(x => personKey(x) === author) } };
  const mainA = new Set(names.matchKeys(a.title));
  const altA = new Set((a.altTitles || []).flatMap(names.matchKeys).filter(k => k.length > 2 && !mainA.has(k)));
  const alt = (b.altTitles || []).find(t => names.matchKeys(t).some(k => altA.has(k)));
  if (alt) return { reason: 'titleAlt', detail: { title: a.title, alt } };
  return null;
}
function autoMerge() {
  const works = allWorks();
  if (works.length < 2) return 0;
  const groups = db.catalogMerges.groups;
  const groupOf = new Map();
  for (const [gid, g] of Object.entries(groups)) for (const k of g.keys) groupOf.set(k, gid);
  const apart = apartSet();
  const dismissed = new Set(db.catalogMerges.dismissed || []);
  const membersOf = w => (groupOf.has(w.key) ? groups[groupOf.get(w.key)].keys : [w.key]);
  const byLink = new Map(), byTitle = new Map();
  const push = (m, k, w) => { if (!m.has(k)) m.set(k, []); m.get(k).push(w); };
  for (const w of works) {
    for (const id of siteIds(w)) push(byLink, id, w);
    for (const t of names.matchKeys(w.title)) if (t.length > 2) push(byTitle, t + '|' + editionKey(w.editions), w);
  }
  const pairs = [], seenPair = new Set();
  for (const list of byLink.values()) if (list.length >= 2 && list.length <= 6) for (let i = 1; i < list.length; i++) pairs.push([list[0], list[i], { reason: 'link', detail: { title: list[0].title } }]);
  for (const list of byTitle.values()) {
    if (list.length < 2 || list.length > 6) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const pk = pairKey(list[i].key, list[j].key); if (list[i].key === list[j].key || seenPair.has(pk)) continue; seenPair.add(pk);
      const why = sameWork(list[i], list[j]); if (why) pairs.push([list[i], list[j], why]);
    }
  }
  let merged = 0;
  for (const [a, b, why] of pairs) {
    if (groupOf.has(a.key) && groupOf.get(a.key) === groupOf.get(b.key)) continue;
    const A = membersOf(a), B = membersOf(b);
    if (A.some(x => B.some(y => apart.has(pairKey(x, y))))) continue;
    if ([...dismissed].some(d => d.includes(a.key) && d.includes(b.key))) continue; // ("not the same" on a suggestion)
    const keys = [...new Set(A.concat(B))];
    const primary = groupOf.has(a.key) ? groups[groupOf.get(a.key)].primary : groupOf.has(b.key) ? groups[groupOf.get(b.key)].primary
      : (b.chapterCount || 0) > (a.chapterCount || 0) ? b.key : a.key;
    const r = merge(keys, primary, { auto: why });
    for (const k of r.keys) groupOf.set(k, r.groupId);
    merged++;
  }
  if (merged) console.log(`[catalog] ${merged} work(s) merged automatically (certain matches)`);
  return merged;
}
// Merged works (automatically or by hand), for the Merge tab: { groups: [{ id, auto, at, primary, works }] }
function mergedGroups({ source } = {}) {
  const byKey = new Map(allWorks().map(w => [w.key, w]));
  const out = [];
  for (const [id, g] of Object.entries(db.catalogMerges.groups)) {
    const members = g.keys.map(k => byKey.get(k)).filter(Boolean);
    if (members.length < 2 || (source && !members.some(m => m.sourceId === source))) continue;
    out.push({ id, auto: g.auto || null, at: g.at || null, primary: g.primary, works: members.map(workSummary) });
  }
  out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { total: out.length, groups: out.slice(0, 300) };
}
// What the Merge tab shows of a work to compare it: its cover, title, other titles, authors, source, chapters
const workSummary = m => ({ key: m.key, title: m.title, altTitles: (m.altTitles || []).slice(0, 4), authors: (m.authors || []).slice(0, 3), type: m.type || null, year: m.year || null,
  source: (db.catalogSources[m.sourceId] || {}).name || m.sourceId, sourceId: m.sourceId, url: m.url, chapters: m.chapterCount || 0, lastChapter: m.lastChapter || null, cover: Boolean(m.cover) });
// Manual corrections that aren't merges: works kept apart (separated or split off) and suggestions marked "not the
// same" — each can be undone (then they may be suggested, or merged automatically, again)
function corrections() {
  const byKey = new Map(allWorks().map(w => [w.key, w]));
  const sum = k => (byKey.has(k) ? workSummary(byKey.get(k)) : { key: k, title: k, source: (db.catalogSources[k.split(':')[0]] || {}).name || '', gone: true });
  const apart = (db.catalogMerges.apart || []).slice(-500).reverse().map(p => ({ pair: p, works: p.split('|').map(sum) })).filter(x => x.works.some(w => !w.gone));
  const dismissed = (db.catalogMerges.dismissed || []).slice(-500).reverse().map(k => ({ key: k, works: String(k).split(',').map(sum) })).filter(x => x.works.some(w => !w.gone));
  return { apart, dismissed };
}
function undoApart(pair) {
  const before = (db.catalogMerges.apart || []).length;
  db.catalogMerges.apart = (db.catalogMerges.apart || []).filter(p => p !== pair);
  if (db.catalogMerges.apart.length === before) throw err(404, 'notFound');
  store.saveLibrary(); catalogVersion++;
}
function undoDismiss(key) {
  const before = (db.catalogMerges.dismissed || []).length;
  db.catalogMerges.dismissed = (db.catalogMerges.dismissed || []).filter(k => k !== key);
  if (db.catalogMerges.dismissed.length === before) throw err(404, 'notFound');
  store.saveLibrary(); catalogVersion++;
}
function dismiss(key) {
  db.catalogMerges.dismissed = [...new Set((db.catalogMerges.dismissed || []).concat(String(key)))].slice(-5000);
  store.saveLibrary();
}

/* ---------------- covers: fetched once by the server, cached on disk ---------------- */
const coverInflight = new Map();
async function cover(key) {
  const w = workByKey(key);
  if (!w || !w.cover) throw err(404, 'noCover');
  return cachedImage(w.cover, (db.catalogSources[w.sourceId] || {}).baseUrl || '');
}
// A source's icon: the site's own (found by Detect, else its /favicon.ico)
async function sourceIcon(id) {
  const s = db.catalogSources[id];
  if (!s) throw err(404, 'notFound');
  const site = s.type === 'mangadex' ? 'https://mangadex.org' : new URL(s.baseUrl).origin;
  if (!s.iconUrl) {
    // Not known yet: the icon the site's home page declares (often not at /favicon.ico), remembered
    s.iconUrl = await declaredIcon(s.type === 'webtoons' ? site + '/en/' : site + '/').catch(() => null) || site + '/favicon.ico';
    store.saveLibrary();
  }
  return cachedImage(s.iconUrl, site);
}
async function declaredIcon(page) {
  let url = page;
  for (let hop = 0; hop < 4; hop++) {
    if (!publicUrl(url, ALLOW_LOCAL)) return null;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200000);
    const m = /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i.exec(html) || /<link[^>]+rel=["']apple-touch-icon["'][^>]*>/i.exec(html);
    const href = m && /href=["']([^"']+)["']/i.exec(m[0]);
    return href ? new URL(href[1].replace(/&amp;/g, '&'), url).href : null;
  }
  return null;
}
async function cachedImage(imageUrl, referer) {
  if (!publicUrl(imageUrl, ALLOW_LOCAL)) throw err(404, 'noCover');
  const w = { cover: imageUrl };
  const name = crypto.createHash('sha1').update(w.cover).digest('hex');
  const file = path.join(COVER_DIR, name);
  const hit = await fs.promises.readFile(file).catch(() => null);
  if (hit) { const meta = await fs.promises.readFile(file + '.type', 'utf8').catch(() => 'image/jpeg'); return { buf: hit, type: meta, etag: `"cc-${name.slice(0, 16)}"` }; }
  if (coverInflight.has(name)) return coverInflight.get(name);
  const job = (async () => {
    let url = w.cover;
    for (let hop = 0; hop < 4; hop++) {
      if (!publicUrl(url, ALLOW_LOCAL)) throw err(404, 'noCover');
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*', Referer: referer || '' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
      let type = res.headers.get('content-type') || '';
      if (/\.ico(\?|$)/i.test(url) && !/^image\//.test(type)) type = 'image/x-icon'; // (some servers send icons as octet-stream)
      if (!res.ok || !/^image\//.test(type)) throw err(404, 'noCover');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5 * 1024 * 1024) throw err(404, 'noCover');
      await fs.promises.mkdir(COVER_DIR, { recursive: true });
      await fs.promises.writeFile(file, buf);
      await fs.promises.writeFile(file + '.type', type.split(';')[0]);
      return { buf, type: type.split(';')[0], etag: `"cc-${name.slice(0, 16)}"` };
    }
    throw err(404, 'noCover');
  })();
  coverInflight.set(name, job);
  job.then(() => coverInflight.delete(name), () => coverInflight.delete(name));
  return job;
}

function info() {
  const crawls = runningCrawls().map(id => Object.assign({ name: db.catalogSources[id].name }, sourceJob(id)));
  return { pid: proc.pid, crawls, running: crawls[0] || null, queued: queue.length, maxCrawls: maxCrawls(), concurrency: Number(require('../../config').get().catalogConcurrency) || 3, sources: Object.keys(db.catalogSources).length };
}
function types() { return TYPES.map(t => ({ type: t, label: ADAPTERS[t].label, defaults: ADAPTERS[t].defaults })); }

// More crawls allowed at once: start the waiting ones now
require('../../config').onChange(changed => { if (changed.includes('catalogCrawls')) pumpCrawls(); });

module.exports = { corrections, undoApart, undoDismiss, templates, findTemplate, clearCatalog, exportList, exportChapters, titleCleanup, setTitleCleanup, siteFiles, readSiteFile, previewPage, listSources, createSource, updateSource, removeSource, crawl, stopCrawl, testSource, detectSource, sourceIcon, startSchedule, checkSchedule,
  list, facets, detail, mergeSuggestions, merge, unmerge, splitOff, autoMerge, mergedGroups, dismiss, cover, info, types, jobs, libraryMatch, pumpCrawls };
