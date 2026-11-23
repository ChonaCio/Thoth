// External catalog: sites added as sources are crawled (by a separate process, catalog/worker.js) for every
// work they list, with metadata and chapter list. Here: the sources and their settings, the crawl queue and
// schedule, reading the catalog back, matching it against the library, merging the same work found on several
// sites (and suggesting merges), and covers (fetched by the server and cached, so browsers never call the sites).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const store = require('../db');
const cstore = require('./store');
const { ADAPTERS, TYPES } = require('./adapters');
const { publicUrl, UA } = require('./fetcher');
const { normTitle, fromUrl } = require('../metadata/providers');
const terms = require('../metadata/terms');

const { db } = store;
if (!db.catalogSources) db.catalogSources = {};
if (!db.catalogMerges) db.catalogMerges = { groups: {}, dismissed: [] };
const DIR = path.join(store.DATA_DIR, 'catalog');
const COVER_DIR = path.join(store.DATA_DIR, 'cache', 'catalog-covers');
const ALLOW_LOCAL = process.env.THOTH_CATALOG_ALLOW_LOCAL === '1'; // tests only
const IDLE_MS = Math.max(0, Number(process.env.THOTH_WORKER_IDLE_MS) || 10000);
const SCHEDULES = { manual: 0, daily: 86400000, weekly: 7 * 86400000 };
const sourceDir = id => path.join(DIR, id);
const err = (status, code) => Object.assign(new Error(code), { status, code });

/* ---------------- sources ---------------- */
// Settings from a form/API body (validated); `current` when editing
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
  if ('schedule' in b || !current) s.schedule = Object.keys(SCHEDULES).includes(b.schedule) ? b.schedule : 'manual';
  if ('gapMs' in b) s.gapMs = Math.max(200, Math.min(60000, Math.round(Number(b.gapMs) || 0))) || adapter.defaults.gapMs;
  else if (!current) s.gapMs = adapter.defaults.gapMs || 1000;
  if ('listPath' in b) s.listPath = String(b.listPath || '').trim().replace(/[^\w\-/]/g, '').slice(0, 80);
  if ('selectors' in b && b.selectors && typeof b.selectors === 'object') {
    const keys = ['listUrl', 'firstPage', 'item', 'link', 'title', 'cover', 'workTitle', 'workCover', 'summary', 'genres', 'authors', 'altTitles', 'status', 'chapter', 'chapterLink', 'chapterTitle', 'chapterDate'];
    s.selectors = {};
    for (const k of keys) if (b.selectors[k] != null && String(b.selectors[k]).trim()) s.selectors[k] = String(b.selectors[k]).trim().slice(0, 400);
  }
  if ('enabled' in b) s.enabled = b.enabled !== false;
  return s;
}
function listSources() {
  return Object.values(db.catalogSources).sort((a, b) => String(a.created).localeCompare(String(b.created))).map(sourceView);
}
function sourceView(s) {
  const st = cstore.readState(sourceDir(s.id));
  const job = jobs.find(j => j.sourceId === s.id && (j.status === 'queued' || j.status === 'running'));
  return Object.assign({}, s, {
    works: st.total != null ? st.total : (loaded.get(s.id) || { list: [] }).list.length,
    lastCrawlAt: st.lastCrawlAt || null, lastCompleteAt: st.lastCompleteAt || null, lastError: st.lastError || null, lastStats: st.stats || null,
    interrupted: Boolean(st.running && !job), job: job ? jobView(job) : null, label: ADAPTERS[s.type].label
  });
}
function createSource(body) {
  const s = parseSource(body);
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
  stopCrawl(id);
  delete db.catalogSources[id];
  // Its works leave the merge groups
  for (const [gid, g] of Object.entries(db.catalogMerges.groups)) {
    g.keys = g.keys.filter(k => !k.startsWith(id + ':'));
    if (g.keys.length < 2) delete db.catalogMerges.groups[gid];
  }
  store.saveLibrary();
  fs.rmSync(sourceDir(id), { recursive: true, force: true });
  loaded.delete(id);
  catalogVersion++;
}

/* ---------------- crawling: a queue, one crawl at a time, in the crawler process ---------------- */
const jobs = [];
let jobSeq = 0, pumping = false;
const proc = { child: null, pid: null, pending: new Map(), seq: 0, idleTimer: null };
const jobView = j => ({ id: j.id, sourceId: j.sourceId, mode: j.mode, status: j.status, createdAt: j.createdAt, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null,
  progress: j.progress || null, result: j.result || null, error: j.error || null });
function ensureProcess() {
  clearTimeout(proc.idleTimer); proc.idleTimer = null;
  if (proc.child) return proc;
  const child = fork(path.join(__dirname, 'worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed here */ }
  proc.child = child; proc.pid = child.pid;
  child.on('message', m => {
    if (!m) return;
    const p = proc.pending.get(m.reqId);
    if (m.type === 'flushed') { catalogVersion++; return; }
    if (!p) return;
    if (m.type === 'progress') { if (p.onProgress) p.onProgress(m); return; }
    proc.pending.delete(m.reqId);
    if (m.type === 'result') p.resolve(m.result); else p.reject(Object.assign(new Error(m.message), { code: m.code, stats: m.stats }));
  });
  const gone = e => { if (proc.child !== child) return; proc.child = null; proc.pid = null; for (const p of proc.pending.values()) p.reject(e); proc.pending.clear(); };
  child.on('error', gone);
  child.on('exit', code => gone(new Error(`Crawler process stopped (exit code ${code})`)));
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
function ask(msg, onProgress) {
  ensureProcess();
  return new Promise((resolve, reject) => {
    const reqId = ++proc.seq;
    proc.pending.set(reqId, { resolve, reject, onProgress });
    proc.child.send(Object.assign({ reqId }, msg));
  }).finally(() => { if (!proc.pending.size) closeWhenIdle(); });
}
function crawl(sourceId, { mode = 'full', reason = 'manual' } = {}) {
  const s = db.catalogSources[sourceId];
  if (!s) throw err(404, 'notFound');
  const waiting = jobs.find(j => j.sourceId === sourceId && (j.status === 'queued' || j.status === 'running'));
  if (waiting) return jobView(waiting);
  const job = { id: 'c' + (++jobSeq), sourceId, mode: mode === 'update' ? 'update' : 'full', reason, status: 'queued', createdAt: new Date().toISOString() };
  jobs.push(job);
  setImmediate(pump);
  return jobView(job);
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let job;
    while ((job = jobs.find(j => j.status === 'queued'))) {
      const s = db.catalogSources[job.sourceId];
      if (!s) { job.status = 'failed'; job.error = 'notFound'; continue; }
      job.status = 'running'; job.startedAt = new Date().toISOString();
      const st = cstore.readState(sourceDir(s.id));
      try {
        job.result = await ask({ type: 'crawl', source: Object.assign({}, s, { lastCrawlAt: st.lastCrawlAt || null }), dir: sourceDir(s.id), mode: job.mode, allowLocal: ALLOW_LOCAL }, p => { job.progress = p; });
        job.status = 'done';
        console.log(`[catalog] ${job.mode} crawl of "${s.name}": ${job.result.listed} listed, ${job.result.added} new, ${job.result.read} read, ${job.result.errors} errors${job.result.stopped ? ' (stopped)' : ''}`);
      } catch (e) {
        job.status = 'failed'; job.error = e.message; job.result = e.stats || null;
        console.error(`[catalog] crawl of "${s.name}" failed: ${e.message}`);
      }
      job.finishedAt = new Date().toISOString();
      catalogVersion++;
      const done = jobs.filter(j => j.status === 'done' || j.status === 'failed');
      for (const old of done.slice(0, Math.max(0, done.length - 20))) jobs.splice(jobs.indexOf(old), 1);
    }
  } finally { pumping = false; }
}
function stopCrawl(sourceId) {
  for (const j of jobs) if (j.sourceId === sourceId && j.status === 'queued') { j.status = 'failed'; j.error = 'stopped'; j.finishedAt = new Date().toISOString(); }
  const running = jobs.find(j => j.sourceId === sourceId && j.status === 'running');
  if (running && proc.child) proc.child.send({ type: 'stop' });
  return Boolean(running);
}
// What a source's settings find on the site (nothing saved)
function testSource(body) {
  const s = Object.assign(parseSource(body), { id: 'test' });
  return ask({ type: 'test', source: s, allowLocal: ALLOW_LOCAL });
}
// Scheduled crawls: an update when the schedule says so (a full crawl the first time or after an interruption)
let scheduleTimer = null;
function startSchedule() {
  clearInterval(scheduleTimer);
  scheduleTimer = setInterval(checkSchedule, 10 * 60 * 1000);
  scheduleTimer.unref();
}
function checkSchedule() {
  for (const s of Object.values(db.catalogSources)) {
    const every = SCHEDULES[s.schedule] || 0;
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
  const list = Object.values(data.works).map(w => Object.assign(w, { key: id + ':' + w.sid, sourceId: id }));
  loaded.set(id, { mtime, list });
  catalogVersion++;
  return list;
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
  const site = w.links && w.links.mangadex ? 'mangadex:' + w.links.mangadex : (fromUrl(w.url || '') ? (x => x.provider + ':' + x.id)(fromUrl(w.url)) : null);
  if (site && idx.bySite.has(site)) return { seriesId: idx.bySite.get(site), by: 'link' };
  const link = String(w.url || '').replace(/\/+$/, '').toLowerCase();
  if (link && idx.byLink.has(link)) return { seriesId: idx.byLink.get(link), by: 'link' };
  for (const t of [w.title].concat(w.altTitles || [])) { const k = normTitle(t); if (k && idx.byTitle.has(k)) return { seriesId: idx.byTitle.get(k), by: 'title' }; }
  return null;
}

// Works as shown: merged groups count once (the primary's metadata, every source's chapters)
let itemsMemo = { ver: null, items: null };
function catalogItems() {
  const ver = catalogVersion + ':' + store.generation() + ':' + Object.keys(db.catalogSources).join(',') + ':' + JSON.stringify(Object.keys(db.catalogMerges.groups).length);
  const works = allWorks();
  const v2 = ver + ':' + works.length + ':' + catalogVersion;
  if (itemsMemo.ver === v2) return itemsMemo.items;
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
      const members = g.keys.map(k => byKey.get(k)).filter(Boolean);
      const primary = byKey.get(g.primary) || members[0];
      items.push(makeItem(primary, members, gid));
    } else items.push(makeItem(w, [w], null));
  }
  itemsMemo = { ver: v2, items };
  return items;
}
function makeItem(primary, members, groupId) {
  const lib = members.map(libraryMatch).find(Boolean) || null;
  const genres = terms.unify(...members.map(m => m.genres || []));
  return {
    key: groupId ? 'g:' + groupId : primary.key, groupId, title: primary.title || '', altTitles: [...new Set(members.flatMap(m => [m.title].concat(m.altTitles || [])).filter(t => t && t !== primary.title))].slice(0, 20),
    cover: Boolean(members.find(m => m.cover)), coverKey: (members.find(m => m.key === primary.key && m.cover) || members.find(m => m.cover) || primary).key,
    summary: primary.summary || (members.find(m => m.summary) || {}).summary || '', authors: [...new Set(members.flatMap(m => m.authors || []))].slice(0, 12), genres,
    status: primary.status || 'unknown', type: primary.type || null, year: primary.year || null,
    sources: members.map(m => ({ key: m.key, sourceId: m.sourceId, name: (db.catalogSources[m.sourceId] || {}).name || m.sourceId, url: m.url, chapters: m.chapterCount || 0, lastChapter: m.lastChapter || null, partial: Boolean(m.partial) })),
    chapters: Math.max(0, ...members.map(m => m.chapterCount || 0)), lastChapter: members.map(m => m.lastChapter).filter(Boolean).sort((a, b) => parseFloat(b) - parseFloat(a))[0] || null,
    updatedAt: members.map(m => m.lastChapterAt || m.detailAt || m.addedAt || '').sort().pop() || null,
    inLibrary: lib ? { seriesId: lib.seriesId, by: lib.by, title: db.series[lib.seriesId] ? store.seriesMeta(db.series[lib.seriesId]).title : '' } : null,
    _text: null
  };
}
const searchable = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function list(q) {
  let items = catalogItems();
  const term = searchable(q.q);
  if (term) items = items.filter(it => (it._text || (it._text = searchable([it.title].concat(it.altTitles, it.authors).join('\n')))).includes(term));
  if (q.source) items = items.filter(it => it.sources.some(s => s.sourceId === q.source));
  if (q.inLibrary === 'yes') items = items.filter(it => it.inLibrary); else if (q.inLibrary === 'no') items = items.filter(it => !it.inLibrary);
  if (q.genre) { const k = terms.keyOf(terms.canonical(q.genre)); items = items.filter(it => it.genres.some(g => terms.keyOf(g) === k)); }
  if (q.merged === 'yes') items = items.filter(it => it.groupId);
  const sorters = {
    title: (a, b) => store.collator.compare(a.title, b.title),
    updated: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    chapters: (a, b) => b.chapters - a.chapters
  };
  items = items.slice().sort(sorters[q.sort] || sorters.title);
  const offset = Math.max(0, Number(q.offset) || 0), limit = Math.min(200, Math.max(1, Number(q.limit) || 60));
  return { total: items.length, offset, items: items.slice(offset, offset + limit).map(publicItem) };
}
const publicItem = it => { const o = Object.assign({}, it); delete o._text; return o; };
function facets() {
  const items = catalogItems();
  const genres = new Map();
  for (const it of items) for (const g of it.genres) genres.set(g, (genres.get(g) || 0) + 1);
  return {
    total: items.length, inLibrary: items.filter(it => it.inLibrary).length,
    sources: Object.values(db.catalogSources).map(s => ({ id: s.id, name: s.name, works: sourceWorks(s.id).length })),
    genres: [...genres].map(([name, count]) => ({ name, count })).sort((a, b) => store.collator.compare(a.name, b.name)).slice(0, 200)
  };
}
// One work in full: every source's metadata and chapters; for a work the library has, which chapters it lacks
function detail(key) {
  const it = catalogItems().find(x => x.key === key || x.sources.some(s => s.key === key));
  if (!it) throw err(404, 'notFound');
  const sources = it.sources.map(s => {
    const w = workByKey(s.key) || {};
    const ch = chaptersOf(s.key);
    const chapters = (ch.chapters || []).slice().sort((a, b) => (parseFloat(b.n) || 0) - (parseFloat(a.n) || 0));
    return Object.assign({}, s, { title: w.title, altTitles: w.altTitles || [], summary: w.summary || '', authors: w.authors || [], genres: w.genres || [], status: w.status || 'unknown',
      error: w.error || null, detailAt: w.detailAt || null, chapterList: chapters, partial: Boolean(ch.partial) });
  });
  let missing = null;
  if (it.inLibrary && db.series[it.inLibrary.seriesId]) {
    const have = new Set(store.booksOf(it.inLibrary.seriesId).map(b => String(parseFloat(store.bookMeta(b).number))).filter(x => x !== 'NaN'));
    const nums = new Map();
    for (const s of sources) for (const c of s.chapterList) { const n = parseFloat(c.n); if (Number.isFinite(n) && !have.has(String(n)) && !nums.has(String(n))) nums.set(String(n), { n: c.n, t: c.t, u: c.u, source: s.name }); }
    missing = { have: have.size, chapters: [...nums.values()].sort((a, b) => parseFloat(a.n) - parseFloat(b.n)) };
  }
  return Object.assign(publicItem(it), { sources, missing });
}

/* ---------------- merging the same work found on several sites ---------------- */
function mergeSuggestions({ limit = 200 } = {}) {
  const works = allWorks();
  const dismissed = new Set(db.catalogMerges.dismissed || []);
  const grouped = new Set(Object.values(db.catalogMerges.groups).flatMap(g => g.keys));
  const parent = new Map(works.map(w => [w.key, w.key]));
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const why = new Map();
  const keys = new Map();
  const add = (reason, key, wkey, detail) => { const k = reason + '\0' + key; if (!keys.has(k)) keys.set(k, { keys: [], detail }); const e = keys.get(k); if (!e.keys.includes(wkey)) e.keys.push(wkey); };
  for (const w of works) {
    if (w.links && w.links.mangadex) add('link', 'mangadex:' + w.links.mangadex, w.key, { url: w.url });
    for (const t of [w.title].concat(w.altTitles || [])) { const n = normTitle(t); if (n && n.length > 2) add('title', n, w.key, { title: t }); }
  }
  for (const [k, e] of keys) {
    if (e.keys.length < 2 || e.keys.length > 12) continue;
    const reason = k.split('\0')[0];
    for (let i = 1; i < e.keys.length; i++) {
      const ra = find(e.keys[0]), rb = find(e.keys[i]);
      if (ra !== rb) parent.set(rb, ra);
      const r = find(e.keys[0]);
      if (!why.has(r) || (why.get(r).reason === 'title' && reason === 'link')) why.set(r, { reason, detail: e.detail });
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
    const lib = members.map(libraryMatch).find(Boolean);
    out.push(Object.assign({ key, primary: members.slice().sort((a, b) => (b.chapterCount || 0) - (a.chapterCount || 0))[0].key,
      inLibrary: lib ? { seriesId: lib.seriesId, title: db.series[lib.seriesId] ? store.seriesMeta(db.series[lib.seriesId]).title : '' } : null,
      works: members.map(m => ({ key: m.key, title: m.title, source: (db.catalogSources[m.sourceId] || {}).name || m.sourceId, url: m.url, chapters: m.chapterCount || 0, merged: grouped.has(m.key) })) },
    why.get(root) || { reason: 'title', detail: {} }));
  }
  out.sort((a, b) => (a.reason === 'link' ? 0 : 1) - (b.reason === 'link' ? 0 : 1) || store.collator.compare(a.works[0].title || '', b.works[0].title || ''));
  return { total: out.length, groups: out.slice(0, limit) };
}
function merge(keys, primary) {
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
  store.saveLibrary();
  catalogVersion++;
  return { groupId: id, keys: groups[id].keys };
}
function unmerge(groupId) {
  if (!db.catalogMerges.groups[groupId]) throw err(404, 'notFound');
  delete db.catalogMerges.groups[groupId];
  store.saveLibrary();
  catalogVersion++;
}
function dismiss(key) {
  db.catalogMerges.dismissed = [...new Set((db.catalogMerges.dismissed || []).concat(String(key)))].slice(-5000);
  store.saveLibrary();
}

/* ---------------- covers: fetched once by the server, cached on disk ---------------- */
const coverInflight = new Map();
async function cover(key) {
  const w = workByKey(key);
  if (!w || !w.cover || !publicUrl(w.cover, ALLOW_LOCAL)) throw err(404, 'noCover');
  const name = crypto.createHash('sha1').update(w.cover).digest('hex');
  const file = path.join(COVER_DIR, name);
  const hit = await fs.promises.readFile(file).catch(() => null);
  if (hit) { const meta = await fs.promises.readFile(file + '.type', 'utf8').catch(() => 'image/jpeg'); return { buf: hit, type: meta, etag: `"cc-${name.slice(0, 16)}"` }; }
  if (coverInflight.has(name)) return coverInflight.get(name);
  const job = (async () => {
    let url = w.cover;
    for (let hop = 0; hop < 4; hop++) {
      if (!publicUrl(url, ALLOW_LOCAL)) throw err(404, 'noCover');
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*', Referer: (db.catalogSources[w.sourceId] || {}).baseUrl || '' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
      const type = res.headers.get('content-type') || '';
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
  const running = jobs.find(j => j.status === 'running');
  return { pid: proc.pid, running: running ? jobView(running) : null, queued: jobs.filter(j => j.status === 'queued').length, jobs: jobs.slice(-10).map(jobView),
    sources: Object.keys(db.catalogSources).length };
}
function types() { return TYPES.map(t => ({ type: t, label: ADAPTERS[t].label, defaults: ADAPTERS[t].defaults })); }

module.exports = { listSources, createSource, updateSource, removeSource, crawl, stopCrawl, testSource, startSchedule, checkSchedule,
  list, facets, detail, mergeSuggestions, merge, unmerge, dismiss, cover, info, types, jobs: () => jobs.map(jobView), libraryMatch };
