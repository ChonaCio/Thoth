// Downloads: jobs that download works of the external catalog into a library as CBZ files, on a schedule.
//   A job: a library, its works (picked one by one, or every work of some sites), the sites it may download from
//   in order (or the one with the best copy), the versions (Regular, Colored, Raw…), a chapter range, a blacklist
//   and a schedule. Every chapter is downloaded once; a premium/locked copy is never unlocked: the chapter waits
//   until a site has it for free; a broken copy (error page, cut-off or unreadable images) is replaced by
//   another site's.
//   Each run is its own detached process (runner.js) like a catalog crawl: it keeps going through server restarts
//   and talks to the server through files in data/downloads/<job>/ (run.json, state.json, progress.json, stop).
//   After a run the library is scanned (quick), so the new chapters appear.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('../db');
const tasks = require('../tasks');
const catalog = require('../catalog');
const terms = require('../metadata/terms');
const { EDITION_ORDER } = require('../titles');

const { db } = store;
if (!db.downloadJobs) db.downloadJobs = {};
const DIR = path.join(store.DATA_DIR, 'downloads');
const ALLOW_LOCAL = process.env.THOTH_CATALOG_ALLOW_LOCAL === '1'; // tests only
const MAX_RUNS = () => Math.max(1, Number(process.env.THOTH_MAX_DOWNLOADS) || 2);
const jobDir = id => path.join(DIR, id);
const err = (status, code, message) => Object.assign(new Error(message || code), { status, code });
const VERSIONS = ['base'].concat(EDITION_ORDER); // base, colored, raw, uncensored, animated
const EDITION_NAME = { colored: 'Colored', raw: 'Raw', uncensored: 'Uncensored', animated: 'Animated' };
const MODES = ['priority', 'quality'];
const ORDERS = ['title', 'added', 'updated', 'manual'];
const FAILED_RETRY_MS = 24 * 3600000; // a failed chapter is tried again once a day (every run on a full pass)

/* ---------------- schedule ---------------- */
function cleanSchedule(s = {}) {
  const type = ['manual', 'interval', 'daily', 'weekly'].includes(s.type) ? s.type : 'manual';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time || '')) ? s.time : '03:00';
  const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
  return { type, hours: Math.max(1, Math.min(720, Math.round(Number(s.hours) || 24))), time, days: days.length ? days : [1] };
}
// The next time a schedule runs after `from` (server time), or null (manual)
function nextRun(s, from = Date.now()) {
  if (!s || s.type === 'manual') return null;
  if (s.type === 'interval') return new Date(from + s.hours * 3600000).toISOString();
  const [h, m] = s.time.split(':').map(Number);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) continue;
    if (s.type === 'daily' || s.days.includes(d.getDay())) return d.toISOString();
  }
  return null;
}

/* ---------------- jobs ---------------- */
const listOf = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map(x => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))].slice(0, 200);
const num = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
function cleanJob(b, prev = {}) {
  const j = Object.assign({}, prev);
  if ('name' in b || !prev.name) j.name = String(b.name || '').trim().slice(0, 120) || 'Downloads';
  if ('libraryId' in b || !prev.libraryId) {
    if (!db.libraries[b.libraryId]) throw err(400, 'badLibrary', 'Pick the library the chapters are saved into');
    j.libraryId = b.libraryId;
  }
  if ('enabled' in b || !('enabled' in prev)) j.enabled = b.enabled !== false;
  if ('sourceOrder' in b || !prev.sourceOrder) {
    j.sourceOrder = [...new Set((Array.isArray(b.sourceOrder) ? b.sourceOrder : []).map(String).filter(id => db.catalogSources[id]))];
    if (!j.sourceOrder.length) throw err(400, 'noSources', 'Pick at least one site to download from');
  }
  if ('listSources' in b || !prev.listSources) j.listSources = [...new Set((Array.isArray(b.listSources) ? b.listSources : []).map(String).filter(id => db.catalogSources[id]))];
  if ('autoAll' in b || !('autoAll' in prev)) j.autoAll = Boolean(b.autoAll);
  if (j.autoAll && !j.listSources.length) throw err(400, 'noListSources', 'Pick the sites whose works are all downloaded');
  if ('mode' in b || !prev.mode) j.mode = MODES.includes(b.mode) ? b.mode : 'priority';
  if ('versions' in b || !prev.versions) {
    j.versions = [...new Set((Array.isArray(b.versions) ? b.versions : ['base']).filter(v => VERSIONS.includes(v)))];
    if (!j.versions.length) throw err(400, 'noVersions', 'Pick at least one version to download');
  }
  if ('concurrency' in b || !prev.concurrency) j.concurrency = Math.max(1, Math.min(6, Math.round(Number(b.concurrency) || 2)));
  if ('minChapter' in b) j.minChapter = num(b.minChapter);
  if ('maxChapter' in b) j.maxChapter = num(b.maxChapter);
  if ('maxPerRun' in b || !('maxPerRun' in prev)) j.maxPerRun = Math.max(0, Math.min(100000, Math.round(Number(b.maxPerRun) || 0)));
  if ('workOrder' in b || !prev.workOrder) j.workOrder = ORDERS.includes(b.workOrder) ? b.workOrder : 'title';
  if ('blacklist' in b) {
    const bl = { genres: listOf(b.blacklist && b.blacklist.genres), tags: listOf(b.blacklist && b.blacklist.tags) };
    if (bl.genres.length || bl.tags.length) j.blacklist = bl; else delete j.blacklist;
  }
  if ('schedule' in b || !prev.schedule) j.schedule = cleanSchedule(b.schedule || {});
  j.nextRunAt = j.enabled ? (prev.schedule && JSON.stringify(prev.schedule) === JSON.stringify(j.schedule) && prev.nextRunAt ? prev.nextRunAt : nextRun(j.schedule)) : null;
  return j;
}
// The catalog item a job's work is now (merges and splits regroup the sites' entries): by its key, else by one of
// the site entries it had
function itemOf(w) {
  const all = [w.key].concat(w.entries || []);
  for (const k of all) { const it = catalog.itemByKey(k); if (it) return it; }
  return null;
}
const entriesOf = it => it.sources.map(s => s.key);
function addWorks(id, keys) {
  const j = mustJob(id);
  const have = new Set(j.works.map(w => w.key));
  let added = 0;
  for (const k of (Array.isArray(keys) ? keys : []).map(String).slice(0, 5000)) {
    const it = catalog.itemByKey(k);
    if (!it || have.has(it.key)) continue;
    have.add(it.key);
    j.works.push({ key: it.key, title: it.title, entries: entriesOf(it), addedAt: new Date().toISOString(), position: j.works.length });
    j.excluded = (j.excluded || []).filter(x => x !== it.key);
    added++;
  }
  store.saveLibrary();
  return { added };
}
function removeWork(id, key) {
  const j = mustJob(id);
  const before = j.works.length;
  j.works = j.works.filter(w => w.key !== key);
  // (a work of "every work from these sites" stays out until brought back)
  if (j.autoAll && !(j.excluded || []).includes(key)) j.excluded = (j.excluded || []).concat(key);
  store.saveLibrary();
  return { removed: before - j.works.length };
}
function restoreExcluded(id) { const j = mustJob(id); const n = (j.excluded || []).length; j.excluded = []; store.saveLibrary(); return { restored: n }; }
function setPositions(id, keys) {
  const j = mustJob(id);
  const pos = new Map((Array.isArray(keys) ? keys : []).map((k, i) => [String(k), i]));
  for (const w of j.works) w.position = pos.has(w.key) ? pos.get(w.key) : pos.size + (w.position || 0);
  store.saveLibrary();
}
const mustJob = id => { const j = db.downloadJobs[id]; if (!j) throw err(404, 'notFound', 'No such download job'); return j; };
function createJob(body) {
  const id = 'dj' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const j = Object.assign(cleanJob(body), { id, works: [], excluded: [], createdAt: new Date().toISOString() });
  db.downloadJobs[id] = j;
  if (Array.isArray(body.works)) addWorks(id, body.works);
  store.saveLibrary();
  return view(j, { details: true });
}
function updateJob(id, body) {
  const j = mustJob(id);
  db.downloadJobs[id] = Object.assign(cleanJob(body, j), { id, works: j.works, excluded: j.excluded || [] });
  if (Array.isArray(body.works) && body.works.length) addWorks(id, body.works);
  if (Array.isArray(body.positions)) setPositions(id, body.positions);
  store.saveLibrary();
  return view(db.downloadJobs[id], { details: true });
}
function removeJob(id) {
  mustJob(id);
  stop(id);
  const qi = queue.findIndex(q => q.jobId === id); if (qi !== -1) queue.splice(qi, 1);
  delete db.downloadJobs[id];
  store.saveLibrary();
  // (its history; the downloaded files stay in the library). A run still ending removes its folder when it can.
  try { if (!liveRun(id)) fs.rmSync(jobDir(id), { recursive: true, force: true }); } catch { /* in use */ }
  return true;
}

/* ---------------- which works and chapters ---------------- */
const keyOfTerm = x => terms.keyOf(terms.canonical(x));
function blacklistHit(job, it) {
  const bl = job.blacklist;
  if (!bl) return null;
  const have = new Map((it.genres || []).map(g => [keyOfTerm(g), g]));
  for (const x of bl.genres.concat(bl.tags)) { const k = keyOfTerm(x); if (have.has(k)) return have.get(k); }
  return null;
}
// The job's works now: picked ones, plus (every work from these sites) the catalog's works on them, without the
// ones removed by hand → [{ key, title, item, auto, addedAt, position, blacklisted }]
function jobWorks(job) {
  const out = [], seen = new Set();
  for (const w of job.works) {
    const it = itemOf(w);
    const key = it ? it.key : w.key;
    if (seen.has(key)) continue; // (two works of the job merged into one in the catalog: downloaded once)
    seen.add(key);
    out.push({ key: w.key, title: it ? it.title : w.title, item: it, auto: false, addedAt: w.addedAt, position: w.position, blacklisted: it ? blacklistHit(job, it) : null });
  }
  if (job.autoAll && job.listSources.length) {
    const excluded = new Set(job.excluded || []);
    const want = new Set(job.listSources);
    for (const it of catalog.items()) {
      if (seen.has(it.key) || excluded.has(it.key)) continue;
      if (!(it._allSources || it.sources.map(s => s.sourceId)).some(id => want.has(id))) continue;
      seen.add(it.key);
      out.push({ key: it.key, title: it.title, item: it, auto: true, addedAt: job.createdAt, position: null, blacklisted: blacklistHit(job, it) });
    }
  }
  const byTitle = (a, b) => store.collator.compare(a.title || '', b.title || '');
  const sorts = {
    title: byTitle,
    added: (a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')) || byTitle(a, b),
    updated: (a, b) => String((b.item && b.item.updatedAt) || '').localeCompare(String((a.item && a.item.updatedAt) || '')) || byTitle(a, b),
    manual: (a, b) => (a.position == null) - (b.position == null) || (a.position || 0) - (b.position || 0) || byTitle(a, b)
  };
  return out.sort(sorts[job.workOrder] || sorts.title);
}
// The versions of a work the job downloads: [{ edition, item (that version's catalog entry) }]
function versionsOf(job, it) {
  const vs = (it.versions && it.versions.length ? it.versions : [{ key: it.key, edition: it.edition || 'base' }]);
  const out = [];
  for (const v of vs) {
    const parts = String(v.edition || 'base').split('+');
    if (!job.versions.some(x => x === v.edition || (x !== 'base' && parts.includes(x)))) continue;
    const unit = catalog.itemByKey(v.key);
    if (unit) out.push({ edition: v.edition || 'base', item: unit });
  }
  return out;
}
const safeName = s => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 150) || 'Untitled';
const numText = n => { const x = parseFloat(n); return Number.isFinite(x) ? String(x) : null; };
// The file a chapter is saved as, Thoth's way: "Chapter 12.cbz", "Chapter 12 - The Name.cbz"
function chapterFileName(c) {
  const n = numText(c.n);
  const name = c.t && !/^(ch(apter|ap)?\.?|ep(isode)?\.?|#)?\s*[\d.]+$/i.test(c.t.trim()) && !(n && new RegExp('^(ch(apter)?\\.?\\s*)?0*' + n.replace('.', '\\.') + '\\b', 'i').test(c.t.trim())) ? c.t : '';
  if (!n) return safeName(c.t || 'Chapter') + '.cbz';
  return safeName(`Chapter ${n}${name ? ' - ' + name : ''}`).slice(0, 140) + '.cbz';
}
// Where a version of a work goes in the library: its series' folder when the library has it, else a new folder
// named after it ("Title", "Title (Colored)")
function targetOf(job, unit, edition) {
  const lib = db.libraries[job.libraryId];
  const s = unit.inLibrary && db.series[unit.inLibrary.seriesId];
  if (s && s.libraryId === job.libraryId && !s.oneshot && s.relPath != null) {
    const have = new Set(store.booksOf(s.id).map(b => numText(store.bookMeta(b).number)).filter(Boolean));
    return { folder: path.join(lib.root, s.relPath), have, seriesId: s.id };
  }
  const suffix = edition && edition !== 'base' ? ' (' + edition.split('+').map(e => EDITION_NAME[e] || e).join(', ') + ')' : '';
  return { folder: path.join(lib.root, safeName(unit.title) + suffix), have: new Set(), seriesId: null };
}
const readState = id => { try { return JSON.parse(fs.readFileSync(path.join(jobDir(id), 'state.json'), 'utf8')); } catch { return { chapters: {} }; } };
const chapterKey = (workKey, edition, c) => `${workKey}|${edition}|${numText(c.n) || 't:' + String(c.t || '').toLowerCase()}`;
// One version's chapters with what the job knows of them
function versionChapters(job, w, v, state) {
  const d = catalog.detail(v.item.key);
  const order = job.sourceOrder;
  const target = targetOf(job, v.item, v.edition);
  const out = [];
  for (const c of d.allChapters) {
    const x = parseFloat(c.n);
    if (job.minChapter != null && !(x >= job.minChapter)) continue;
    if (job.maxChapter != null && !(x <= job.maxChapter)) continue;
    const links = c.links.filter(l => order.includes(l.sourceId) && l.u).sort((a, b) => order.indexOf(a.sourceId) - order.indexOf(b.sourceId));
    const key = chapterKey(w.key, v.edition, c);
    const st = state.chapters[key] || null;
    const inLibrary = Boolean(numText(c.n) && target.have.has(numText(c.n)));
    out.push({ key, n: c.n, t: c.t, d: c.d, edition: v.edition, links, state: st, inLibrary, file: path.join(target.folder, chapterFileName(c)), meta: d });
  }
  return { target, chapters: out.sort((a, b) => (parseFloat(a.n) || 0) - (parseFloat(b.n) || 0)) };
}
const statusOf = c => (c.state && c.state.status === 'done') || c.inLibrary ? 'done' : c.state ? c.state.status : !c.links.length ? 'nosource' : c.links.every(l => l.pr) ? 'locked' : 'pending';
// What a run downloads: per work in the job's order, the chapters not downloaded yet (new ones; locked ones, which
// may be free now; failed ones once a day, or all on a full pass; on a full pass also downloaded ones whose file is
// gone), up to maxPerRun
function plan(job, { full = false } = {}) {
  const state = readState(job.id);
  const chapters = [];
  const now = Date.now();
  for (const w of jobWorks(job)) {
    if (!w.item || w.blacklisted) continue;
    for (const v of versionsOf(job, w.item)) {
      let vc;
      try { vc = versionChapters(job, w, v, state); } catch { continue; }
      for (const c of vc.chapters) {
        if (c.inLibrary || !c.links.length) continue;
        const st = c.state;
        if (st && st.status === 'done' && !(full && st.file && !fs.existsSync(st.file))) continue;
        if (st && st.status === 'failed' && !full && now - Date.parse(st.at || 0) < FAILED_RETRY_MS) continue;
        if (c.links.every(l => l.pr) && st && st.status === 'locked' && !full) continue; // (still premium everywhere: nothing to ask)
        const m = c.meta;
        chapters.push({ key: c.key, workKey: w.key, workTitle: w.title, edition: v.edition, n: c.n != null ? numText(c.n) || c.n : null, t: c.t || '', l: (c.links.find(l => l.l) || {}).l || null,
          file: c.file, links: c.links.map(l => ({ sourceId: l.sourceId, u: l.u, pr: Boolean(l.pr) })),
          meta: { series: path.basename(vc.target.folder), authors: (m.authors || []).slice(0, 8), genres: (m.genres || []).slice(0, 20), summary: String(m.summary || '').slice(0, 4000) } });
        if (job.maxPerRun && chapters.length >= job.maxPerRun) return chapters;
      }
    }
  }
  return chapters;
}

/* ---------------- runs: detached processes ---------------- */
const queue = []; // { jobId, full, reason }
const recent = new Map(); // jobId → runId of the last finished run noticed
const readProgress = id => { try { return JSON.parse(fs.readFileSync(path.join(jobDir(id), 'progress.json'), 'utf8')); } catch { return null; } };
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function liveRun(id) {
  const p = readProgress(id);
  if (!p || (p.status !== 'running' && p.status !== 'starting')) return null;
  const beat = Date.parse(p.heartbeatAt || p.startedAt || 0) || 0;
  if (p.status === 'starting' && Date.now() - beat < 20000) return p;
  if (alive(p.pid) && Date.now() - beat < 30000) return p;
  Object.assign(p, { status: 'failed', error: 'The download process stopped unexpectedly', finishedAt: new Date().toISOString() });
  try { fs.writeFileSync(path.join(jobDir(id), 'progress.json'), JSON.stringify(p)); } catch { /* gone */ }
  return null;
}
function run(id, { full = false, reason = 'manual' } = {}) {
  const j = mustJob(id);
  if (liveRun(id)) return { status: 'running' };
  const q = queue.find(x => x.jobId === id);
  if (q) { q.full = q.full || full; return { status: 'queued' }; }
  queue.push({ jobId: j.id, full: Boolean(full), reason });
  pump();
  return { status: liveRun(id) ? 'running' : 'queued' };
}
function stop(id) {
  const qi = queue.findIndex(q => q.jobId === id);
  if (qi !== -1) queue.splice(qi, 1);
  if (!liveRun(id)) return qi !== -1;
  fs.writeFileSync(path.join(jobDir(id), 'stop'), new Date().toISOString());
  return true;
}
const runTitle = (j, full) => `${full ? 'Full download pass' : 'Download'}: "${j.name}"`;
function startRun(q) {
  const j = db.downloadJobs[q.jobId];
  if (!j) return;
  const dir = jobDir(j.id);
  fs.mkdirSync(dir, { recursive: true });
  let chapters;
  try { chapters = plan(j, { full: q.full }); } catch (e) { j.lastRunAt = new Date().toISOString(); j.lastStatus = 'failed: ' + e.message; store.saveLibrary(); return; }
  const runId = 'd' + Date.now().toString(36);
  const startedAt = new Date();
  if (!chapters.length) {
    Object.assign(j, { lastRunAt: startedAt.toISOString(), lastStatus: 'nothing new to download', nextRunAt: j.enabled ? nextRun(j.schedule) : null });
    if (q.full) j.fullPassAt = startedAt.toISOString();
    store.saveLibrary();
    const t = tasks.start({ kind: 'download', title: runTitle(j, q.full) });
    t.end('done', 'nothing new to download');
    return;
  }
  const logFile = tasks.logPathFor('download', runId, startedAt);
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, `# ${runTitle(j, q.full)}\n`); } catch { /* best effort */ }
  const sources = {};
  for (const sid of j.sourceOrder) {
    const s = db.catalogSources[sid];
    if (s) sources[sid] = { id: sid, name: s.name, type: s.type, baseUrl: s.baseUrl, gapMs: s.gapMs, concurrency: s.concurrency, access: s.access || null, selectors: s.selectors ? { pageImages: s.selectors.pageImages || null } : null };
  }
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId, jobId: j.id, jobName: j.name, full: q.full, reason: q.reason, logFile, allowLocal: ALLOW_LOCAL,
    mode: j.mode, concurrency: j.concurrency, sources, chapters }));
  fs.rmSync(path.join(dir, 'stop'), { force: true });
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ runId, jobId: j.id, status: 'starting', full: q.full, startedAt: startedAt.toISOString(), total: chapters.length, done: 0 }));
  const out = fs.openSync(path.join(dir, 'run.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'runner.js'), dir], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env });
  fs.closeSync(out);
  child.unref();
  runTask(j.id, runId, q.full, logFile, startedAt);
  console.log(`[downloads] "${j.name}": ${chapters.length} chapter(s) to download, as its own process (pid ${child.pid})`);
}
function runTask(jobId, runId, full, logFile, startedAt) {
  if (tasks.find(runId)) return;
  const j = db.downloadJobs[jobId] || { name: jobId };
  tasks.start({ kind: 'download', id: runId, title: runTitle(j, full), logFile, startedAt, cancel: () => stop(jobId),
    progress: () => {
      const p = readProgress(jobId) || {};
      const started = Date.parse(p.startedAt || 0) || Date.now();
      const eta = p.done >= 2 && p.total ? Math.round((Date.now() - started) / p.done * (p.total - p.done)) : null;
      return { phase: 'downloading', done: p.done || 0, total: p.total || 0, percent: p.total ? Math.min(100, Math.floor((p.done || 0) / p.total * 100)) : null, etaMs: eta, current: p.current || [] };
    } });
}
let pumpTimer = null;
function pump() {
  // Runs still going from before a restart: their tasks again
  for (const id of Object.keys(db.downloadJobs)) {
    const p = liveRun(id);
    if (p && p.runId && !tasks.find(p.runId)) {
      let r = null; try { r = JSON.parse(fs.readFileSync(path.join(jobDir(id), 'run.json'), 'utf8')); } catch { /* none */ }
      if (r && r.runId === p.runId) runTask(id, p.runId, r.full, r.logFile, p.startedAt);
    }
  }
  let running = Object.keys(db.downloadJobs).filter(id => liveRun(id)).length;
  while (queue.length && running < MAX_RUNS()) {
    const q = queue.shift();
    if (liveRun(q.jobId)) continue;
    startRun(q);
    if (liveRun(q.jobId)) running++;
  }
  // Finished runs: noted once (the job's last run, the task, a library scan for the new files)
  for (const [id, j] of Object.entries(db.downloadJobs)) {
    const p = readProgress(id);
    if (!p || !p.finishedAt || recent.get(id) === p.runId) continue;
    const first = !recent.has(id) && !pumpTimer;
    recent.set(id, p.runId);
    if (first && j.lastRunId === p.runId) continue; // (noticed before a restart)
    const summary = p.error || `${p.ok || 0} downloaded, ${p.failed || 0} failed, ${p.locked || 0} locked` + (p.status === 'stopped' ? `, ${(p.total || 0) - (p.done || 0)} not started (stopped)` : '');
    tasks.endById(p.runId, p.status === 'done' ? 'done' : p.status === 'stopped' ? 'stopped' : 'failed', summary);
    let full = false; try { full = JSON.parse(fs.readFileSync(path.join(jobDir(id), 'run.json'), 'utf8')).full; } catch { /* gone */ }
    Object.assign(j, { lastRunId: p.runId, lastRunAt: p.finishedAt, lastStatus: summary, nextRunAt: j.enabled ? nextRun(j.schedule) : null });
    if (full && p.status === 'done') j.fullPassAt = p.finishedAt;
    store.saveLibrary();
    if (p.ok && db.libraries[j.libraryId]) require('../scanner').scanLibrary(j.libraryId, { mode: 'quick', reason: 'trigger' }).catch(() => {});
    console.log(`[downloads] "${j.name}" ${p.status}: ${summary}`);
  }
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(pump, queue.length || running ? 2000 : 30000);
  pumpTimer.unref();
}
// Scheduled runs (checked every minute)
let tickTimer = null;
function tick() {
  const now = Date.now();
  for (const j of Object.values(db.downloadJobs)) {
    if (!j.enabled || !j.nextRunAt || Date.parse(j.nextRunAt) > now) continue;
    j.nextRunAt = nextRun(j.schedule, now);
    store.saveLibrary();
    run(j.id, { reason: 'schedule' });
  }
}
function start() {
  pump();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 60000);
  tickTimer.unref();
}

/* ---------------- views ---------------- */
function counts(job, state) {
  const c = { done: 0, failed: 0, locked: 0, bytes: 0 };
  for (const s of Object.values(state.chapters || {})) { if (c[s.status] != null) c[s.status]++; if (s.status === 'done') c.bytes += s.bytes || 0; }
  return c;
}
function runView(id) {
  const q = queue.find(x => x.jobId === id);
  if (q) return { status: 'queued', full: q.full };
  const p = liveRun(id);
  if (!p) return null;
  const started = Date.parse(p.startedAt || 0) || Date.now();
  return { status: 'running', full: Boolean(p.full), startedAt: p.startedAt, total: p.total || 0, done: p.done || 0, ok: p.ok || 0, failed: p.failed || 0, locked: p.locked || 0,
    bytes: p.bytes || 0, current: p.current || [], etaMs: p.done >= 2 && p.total ? Math.round((Date.now() - started) / p.done * (p.total - p.done)) : null };
}
function view(j, { details = false } = {}) {
  const state = readState(j.id);
  const works = jobWorks(j);
  const v = {
    id: j.id, name: j.name, enabled: j.enabled, libraryId: j.libraryId, libraryName: (db.libraries[j.libraryId] || {}).name || null,
    sourceOrder: j.sourceOrder, listSources: j.listSources, autoAll: j.autoAll, mode: j.mode, versions: j.versions, concurrency: j.concurrency,
    minChapter: j.minChapter != null ? j.minChapter : null, maxChapter: j.maxChapter != null ? j.maxChapter : null, maxPerRun: j.maxPerRun || 0, workOrder: j.workOrder,
    blacklist: j.blacklist || null, schedule: j.schedule, nextRunAt: j.enabled ? j.nextRunAt || null : null, lastRunAt: j.lastRunAt || null, lastStatus: j.lastStatus || null,
    fullPassAt: j.fullPassAt || null, excluded: (j.excluded || []).length, worksCount: works.length, someWorks: works.slice(0, 4).map(w => w.title),
    blacklisted: works.filter(w => w.blacklisted).length, counts: counts(j, state), run: runView(j.id)
  };
  if (details) v.works = works.map(w => workRow(j, w, state));
  return v;
}
// A work of the job with its chapters counted (every version the job downloads)
function workRow(job, w, state) {
  const row = { key: w.key, title: w.title, auto: w.auto, blacklisted: w.blacklisted, position: w.position, addedAt: w.addedAt, inCatalog: Boolean(w.item),
    cover: w.item ? w.item.cover && w.item.coverKey : null, chapters: 0, done: 0, pending: 0, locked: 0, failed: 0, folders: [] };
  if (!w.item) return row;
  for (const v of versionsOf(job, w.item)) {
    let vc; try { vc = versionChapters(job, w, v, state); } catch { continue; }
    row.folders.push(path.relative(db.libraries[job.libraryId].root, vc.target.folder));
    for (const c of vc.chapters) {
      row.chapters++;
      const s = statusOf(c);
      if (s === 'done') row.done++; else if (s === 'locked') row.locked++; else if (s === 'failed') row.failed++; else if (s === 'pending') row.pending++;
    }
  }
  return row;
}
function list() { return { jobs: Object.values(db.downloadJobs).map(j => view(j)).sort((a, b) => store.collator.compare(a.name, b.name)), versions: VERSIONS }; }
function get(id) { return view(mustJob(id), { details: true }); }
// One work's chapters in a job: per version, each chapter's state, its sites' links, the file
function workChapters(id, key) {
  const j = mustJob(id);
  const w = jobWorks(j).find(x => x.key === key);
  if (!w) throw err(404, 'notFound', 'That work is not in this job');
  if (!w.item) return { key, title: w.title, versions: [] };
  const state = readState(j.id);
  const names = id2 => (db.catalogSources[id2] || {}).name || id2;
  return {
    key, title: w.title, blacklisted: w.blacklisted,
    versions: versionsOf(j, w.item).map(v => {
      const vc = versionChapters(j, w, v, state);
      return { edition: v.edition, folder: path.relative(db.libraries[j.libraryId].root, vc.target.folder), chapters: vc.chapters.map(c => ({
        n: c.n, t: c.t, d: c.d, status: statusOf(c), inLibrary: c.inLibrary, file: path.basename(c.file),
        source: c.state && c.state.sourceName || null, pages: c.state && c.state.pages || null, bytes: c.state && c.state.bytes || null, width: c.state && c.state.width || null,
        error: c.state && c.state.status !== 'done' ? c.state.error || null : null, at: c.state ? c.state.at || null : null,
        links: c.links.map(l => ({ source: names(l.sourceId), u: l.u, pr: Boolean(l.pr) }))
      })) };
    })
  };
}
// Failed and locked chapters (of one work, or all) tried again on the next run
function retry(id, key = null) {
  const j = mustJob(id);
  if (liveRun(id)) throw err(409, 'running', 'The job is downloading now: try again when it ends');
  const state = readState(j.id);
  let n = 0;
  for (const [k, s] of Object.entries(state.chapters)) if (s.status !== 'done' && (!key || k.startsWith(key + '|'))) { delete state.chapters[k]; n++; }
  fs.mkdirSync(jobDir(j.id), { recursive: true });
  fs.writeFileSync(path.join(jobDir(j.id), 'state.json'), JSON.stringify(state));
  return { retried: n };
}
// The jobs a catalog work is in (for its page's Download button)
function jobsOfWork(key) {
  const it = catalog.itemByKey(key);
  if (!it) return [];
  return Object.values(db.downloadJobs).filter(j => jobWorks(j).some(w => w.item && w.item.key === it.key)).map(j => ({ id: j.id, name: j.name }));
}
function info() { return { jobs: Object.keys(db.downloadJobs).length, running: Object.keys(db.downloadJobs).filter(id => liveRun(id)).length, queued: queue.length }; }

module.exports = { list, get, createJob, updateJob, removeJob, addWorks, removeWork, restoreExcluded, workChapters, retry, run, stop, start, pump, plan, jobsOfWork, info,
  nextRun, cleanSchedule, chapterFileName, VERSIONS };
