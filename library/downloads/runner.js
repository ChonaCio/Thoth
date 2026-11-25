// One run of a download job: `node runner.js <job folder>`, started detached by downloads/index.js. Like a catalog
// crawl, it doesn't depend on the server (it keeps going through restarts) and talks to it only through files in
// the job's folder (data/downloads/<job>/):
//   run.json       what to do (written by the server): the chapters, each with its sites' links in the job's
//                  order, the target file, and the sources' settings
//   state.json     every chapter's state: done (file, site, pages, size, width) | failed | locked (merged in)
//   progress.json  { runId, pid, status, startedAt, heartbeatAt, finishedAt, total, done, ok, failed, locked,
//                    current: [what is downloading now], bytes, error } (every second)
//   stop           present → no new chapter is started; the run ends after the ones in progress
// Each chapter is downloaded once, from the first site (or with "best quality" the site with the widest pages)
// that has a whole, readable copy; locked/premium copies are never unlocked or worked around.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFetcher, refererFor } = require('../catalog/fetcher');
const { replaceFile } = require('../catalog/store');
const { chapterImages } = require('./pages');
const images = require('./images');
const { writeCbz } = require('./cbz');

const dir = path.resolve(process.argv[2] || '');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const writeJson = (f, data) => { const file = path.join(dir, f), tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data)); replaceFile(tmp, file); };

function main() {
  const run = read('run.json', null);
  if (!run || !Array.isArray(run.chapters)) { console.error('[downloads] no run.json in', dir); process.exit(2); }
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed here */ }
  const state = read('state.json', { chapters: {} });
  if (!state.chapters) state.chapters = {};
  const prog = { runId: run.runId, jobId: run.jobId, pid: process.pid, status: 'running', startedAt: new Date().toISOString(), heartbeatAt: null, finishedAt: null,
    total: run.chapters.length, done: 0, ok: 0, failed: 0, locked: 0, bytes: 0, current: [], error: null };
  const save = () => { prog.heartbeatAt = new Date().toISOString(); try { writeJson('progress.json', prog); } catch (e) { console.error('[downloads] progress:', e.message); } };
  let stopping = false;
  save();
  const beat = setInterval(() => { save(); if (!stopping && fs.existsSync(path.join(dir, 'stop'))) { stopping = true; log('stop asked: finishing the chapters in progress'); } }, 1000);
  const log = (...a) => {
    const line = a.join(' ');
    console.log(new Date().toISOString(), line);
    if (run.logFile) try { fs.appendFileSync(run.logFile, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + line + '\n'); } catch { /* best effort */ }
  };
  // One polite fetcher per source (its pace, parallel requests and Access settings; robots.txt of every host asked)
  const fetchers = new Map();
  const fetcherOf = id => {
    if (!fetchers.has(id)) {
      const s = run.sources[id] || {};
      fetchers.set(id, createFetcher({ gapMs: Math.max(250, Number(s.gapMs) || 1000), parallel: Math.max(1, Math.min(4, Number(s.concurrency) || 2)), allowLocal: Boolean(run.allowLocal),
        access: Object.assign({ home: s.baseUrl || '' }, s.access || {}) }));
    }
    return fetchers.get(id);
  };
  const saveState = () => { try { writeJson('state.json', state); } catch (e) { log('could not save the state:', e.message); } };

  // The page list of one site's copy; `first`: its first page fetched too (best-quality comparison)
  async function copyOf(link, first) {
    const src = run.sources[link.sourceId];
    if (!src) return { ok: false, note: 'source removed' };
    const get = fetcherOf(link.sourceId).get;
    let r;
    try { r = await chapterImages({ link, source: src, get }); } catch (e) { return { ok: false, note: e.message, blocked: e.code === 'blocked' }; }
    if (r.locked) return { ok: false, locked: true, note: r.locked };
    if (!r.images) return { ok: false, note: r.missing || r.error || 'no pages' };
    const copy = { ok: true, link, src, images: r.images, referer: r.referer || link.u, pages: new Array(r.images.length) };
    if (first) {
      const p = await page(copy, 0);
      if (!p.ok) return { ok: false, note: `page 1: ${p.reason}` };
      copy.pages[0] = p; copy.width = p.width;
    }
    return copy;
  }
  // One page image (a cut-off download tried once more)
  async function page(copy, i) {
    const url = copy.images[i];
    let last = 'not fetched';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetcherOf(copy.link.sourceId).get(url, { accept: 'image/avif,image/webp,image/*,*/*;q=0.8', headers: { Referer: refererFor(copy.referer, url) || copy.referer } });
        const c = images.checkPage(r.buf, r.type);
        if (c.ok) return Object.assign(c, { ok: true, buf: r.buf });
        last = c.reason;
        if (!/cut off|empty/.test(c.reason)) break;
      } catch (e) { last = e.message; if (e.code === 'blocked' || e.code === 'robots' || (e.status && e.status < 500 && e.status !== 429)) break; }
    }
    return { ok: false, reason: last };
  }
  // Every page of a copy, the site's parallel requests at a time
  async function allPages(copy, label) {
    const n = copy.images.length, todo = [];
    for (let i = 0; i < n; i++) if (!copy.pages[i]) todo.push(i);
    let fail = null, got = n - todo.length;
    const lanes = Math.max(1, Math.min(4, Number(copy.src.concurrency) || 2));
    await Promise.all(Array.from({ length: Math.min(lanes, todo.length) }, async () => {
      while (todo.length && !fail) {
        const i = todo.shift();
        const p = await page(copy, i);
        if (!p.ok) { fail = `page ${i + 1} of ${n}: ${p.reason}`; return; }
        copy.pages[i] = p; got++;
        setLabel(label, `${label} · ${got}/${n} from ${copy.src.name}`);
      }
    }));
    if (fail) return { ok: false, note: fail };
    const dup = images.checkChapter(copy.pages);
    if (dup) return { ok: false, note: dup };
    return { ok: true };
  }
  const labels = new Map();
  const setLabel = (k, v) => { if (v) labels.set(k, v); else labels.delete(k); prog.current = [...labels.values()].slice(0, 8); };

  async function chapter(ch) {
    const label = `${ch.workTitle}${ch.edition && ch.edition !== 'base' ? ` (${ch.edition})` : ''} · ch. ${ch.n != null ? ch.n : ch.t || '?'}`;
    setLabel(label, label);
    const prev = state.chapters[ch.key] || {};
    const notes = [];
    let anyLocked = false;
    const open = [];
    for (const l of ch.links) {
      const name = (run.sources[l.sourceId] || {}).name || l.sourceId;
      if (l.pr) { anyLocked = true; notes.push(`${name}: premium`); continue; }
      open.push(l);
    }
    // Best quality: each site's copy looked at (its first page), the widest first; else the job's order
    let candidates = [];
    if (run.mode === 'quality' && open.length > 1) {
      for (const l of open) {
        const c = await copyOf(l, true);
        const name = (run.sources[l.sourceId] || {}).name || l.sourceId;
        if (c.ok) candidates.push(c); else { if (c.locked) anyLocked = true; notes.push(`${name}: ${c.note}`); }
      }
      candidates.sort((a, b) => (b.width || 0) - (a.width || 0));
    } else candidates = open;
    let done = null;
    for (const cand of candidates) {
      if (stopping) break;
      const copy = cand.images ? cand : await copyOf(cand, false);
      const name = (run.sources[(cand.link || cand).sourceId] || {}).name || (cand.link || cand).sourceId;
      if (!copy.ok) { if (copy.locked) anyLocked = true; notes.push(`${name}: ${copy.note}`); continue; }
      const r = await allPages(copy, label);
      if (!r.ok) { notes.push(`${name}: ${r.note}`); continue; }
      try {
        const bytes = writeCbz(ch.file, copy.pages, Object.assign({}, ch.meta || {}, { number: ch.n, title: ch.t, volume: ch.v, language: ch.l, web: copy.link.u, notes: `Downloaded by Thoth from ${name}` }));
        done = { status: 'done', source: copy.link.sourceId, sourceName: name, url: copy.link.u, file: ch.file, pages: copy.pages.length, bytes, width: images.qualityOf(copy.pages), at: new Date().toISOString() };
        prog.bytes += bytes;
      } catch (e) { notes.push(`saving: ${e.message}`); }
      break;
    }
    setLabel(label, null);
    if (stopping && !done) return; // (not tried to the end: left as it was)
    if (done) { state.chapters[ch.key] = done; prog.ok++; log(`${label}: ${done.pages} pages from ${done.sourceName} (${Math.round(done.bytes / 1024)} KB, ${done.width}px)`); }
    else if (anyLocked && !candidates.length) { state.chapters[ch.key] = { status: 'locked', error: notes.join(' · '), at: new Date().toISOString(), tries: (prev.tries || 0) + 1 }; prog.locked++; log(`${label}: locked (${notes.join(' · ')})`); }
    else { state.chapters[ch.key] = { status: anyLocked ? 'locked' : 'failed', error: notes.join(' · ') || 'no site has it', at: new Date().toISOString(), tries: (prev.tries || 0) + 1 }; if (anyLocked) prog.locked++; else prog.failed++; log(`${label}: ${anyLocked ? 'locked' : 'failed'} — ${notes.join(' · ') || 'no site has it'}`); }
    prog.done++;
    saveState();
  }

  log(`download run of "${run.jobName}": ${run.chapters.length} chapter(s), ${run.concurrency} at a time, ${run.mode === 'quality' ? 'best quality' : 'in the job\'s source order'} (pid ${process.pid})`);
  const queue = run.chapters.slice();
  const lanes = Math.max(1, Math.min(6, Number(run.concurrency) || 2));
  return Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, async () => {
    while (queue.length && !stopping) {
      const ch = queue.shift();
      try { await chapter(ch); } catch (e) { log(`${ch.workTitle} ch. ${ch.n}: ${e.message}`); prog.done++; prog.failed++; }
    }
  })).then(() => {
    prog.status = stopping ? 'stopped' : 'done';
    log(`${prog.status}: ${prog.ok} downloaded, ${prog.failed} failed, ${prog.locked} locked${stopping ? `, ${prog.total - prog.done} not started` : ''}`);
  }, e => { prog.status = 'failed'; prog.error = e.message; log('failed:', e.message); }).finally(() => {
    clearInterval(beat);
    for (const f of fetchers.values()) f.stop();
    prog.current = []; prog.finishedAt = new Date().toISOString();
    saveState(); save();
    fs.rmSync(path.join(dir, 'stop'), { force: true });
    process.exit(0);
  });
}

if (require.main === module) main();
module.exports = { main };
