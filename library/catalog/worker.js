// Catalog crawler process: started by catalog/index.js when a crawl begins, closed when the queue is empty.
// It never touches the library database: it writes the source's catalog folder (store.js) and reports
// progress. One crawl at a time:
//   { type: 'crawl', reqId, source, dir, mode: 'full' | 'update', allowLocal }
//     → progress { reqId, phase, listed, done, total, errors } … → result { reqId, result: stats } | error
//   { type: 'stop' } → the crawl in progress saves what it has and ends (resumed by the next full crawl)
//   { type: 'test', reqId, source, allowLocal } → a few works and the first one's details, nothing saved
const store = require('./store');
const { createFetcher } = require('./fetcher');
const { ADAPTERS } = require('./adapters');

let current = null;
const FIELDS = ['title', 'altTitles', 'cover', 'summary', 'authors', 'genres', 'tags', 'status', 'type', 'year', 'url', 'languages', 'links'];
const filled = v => v != null && v !== '' && !(Array.isArray(v) && !v.length) && v !== 'unknown';
const errText = e => (e && e.code ? `${e.code}: ` : '') + (e && e.message || String(e));

async function crawl(msg, send) {
  const { source: src, dir, mode } = msg;
  const adapter = ADAPTERS[src.type];
  if (!adapter) throw new Error(`Unknown source type ${src.type}`);
  const fetcher = createFetcher({ gapMs: Math.max(Number(src.gapMs) || adapter.defaults.gapMs || 1000, src.type === 'mangadex' ? 200 : 500), allowLocal: msg.allowLocal });
  const run = current = { stop: false, fetcher };
  const incremental = mode === 'update';
  const data = store.readWorks(dir);
  const works = data.works;
  const chapters = store.shardCache(dir);
  const prevState = store.readState(dir);
  // An interrupted full crawl continues where it was (works already read in that run are skipped)
  const resume = !incremental && prevState.running && prevState.mode === 'full' ? prevState.runStartedAt : null;
  const runStartedAt = resume || new Date().toISOString();
  const state = Object.assign({}, prevState, { running: true, mode, runStartedAt, phase: 'listing', lastError: null });
  store.writeState(dir, state);
  const stats = { listed: 0, added: 0, updated: 0, read: 0, errors: 0, chapters: 0, removed: 0, partial: 0, requests: 0, mode, resumed: Boolean(resume) };
  const report = extra => send(Object.assign({ type: 'progress', reqId: msg.reqId }, stats, extra));
  let lastFlush = Date.now();
  const flush = () => { store.writeWorks(dir, { sourceId: src.id, works }); chapters.flush(); lastFlush = Date.now(); send({ type: 'flushed', reqId: msg.reqId }); };
  const ctx = { src, get: (u, o) => { if (run.stop) throw Object.assign(new Error('Stopped'), { code: 'stopped' }); return fetcher.get(u, o); }, incremental };
  const queue = [];
  let listingComplete = false, aborted = null;
  try {
    // 1. Every work the site lists (or, updating, the recently updated ones)
    for await (const page of adapter.listWorks(ctx)) {
      for (const stub of page) {
        const w = works[stub.sid];
        if (!w) { works[stub.sid] = Object.assign({ sid: stub.sid, addedAt: new Date().toISOString() }, stub); stats.added++; }
        else for (const f of FIELDS) if (filled(stub[f])) w[f] = stub[f];
        works[stub.sid].seenAt = runStartedAt;
        queue.push(stub.sid);
        stats.listed++;
        if (src.maxWorks && stats.listed >= src.maxWorks) break;
      }
      report({ phase: 'listing', total: stats.listed });
      if (src.maxWorks && stats.listed >= src.maxWorks) break;
      if (Date.now() - lastFlush > 30000) flush();
    }
    listingComplete = !src.maxWorks || stats.listed < src.maxWorks;
    // 2. Each work's details and chapter list
    state.phase = 'works'; store.writeState(dir, state);
    let done = 0;
    for (const sid of queue) {
      if (run.stop) break;
      const w = works[sid];
      done++;
      if (resume && w.detailAt && w.detailAt >= resume) continue;
      try {
        const old = chapters.get(sid);
        const known = new Set(((old && old.chapters) || []).map(c => String(c.id)));
        const full = await adapter.fetchWork(Object.assign({}, ctx, { known }), Object.assign({}, w));
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
          if (full.partial) stats.partial++;
          stats.chapters += list.length;
        }
        w.detailAt = new Date().toISOString();
        stats.read++; stats.updated++;
      } catch (e) {
        if (e.code === 'stopped') break;
        if (e.code === 'blocked' || e.code === 'notPublic') { aborted = e; break; } // the whole site
        stats.errors++;
        w.error = errText(e).slice(0, 200);
      }
      if (done % 10 === 0 || done === queue.length) report({ phase: 'works', done, total: queue.length });
      if (Date.now() - lastFlush > 30000) flush();
    }
    // 3. A complete full crawl: works the site no longer lists are dropped
    if (!incremental && listingComplete && !run.stop && !aborted) {
      for (const [sid, w] of Object.entries(works)) if (w.seenAt !== runStartedAt) { delete works[sid]; chapters.set(sid, null); stats.removed++; }
    }
  } catch (e) {
    if (e.code !== 'stopped') aborted = e;
  }
  stats.requests = fetcher.stats.requests;
  flush();
  const finished = !run.stop && !aborted;
  Object.assign(state, { running: !finished && !incremental, phase: finished ? 'done' : 'stopped', lastError: aborted ? errText(aborted) : null, stats, total: Object.keys(works).length });
  if (finished) { state.lastCrawlAt = runStartedAt; state.lastCompleteAt = new Date().toISOString(); }
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
    for await (const page of adapter.listWorks(ctx)) { out.firstPageCount = page.length; out.works = page.slice(0, 8); break; }
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
    if (msg.type === 'stop') { if (current) { current.stop = true; current.fetcher.stop(); } return; }
    if (msg.type !== 'crawl' && msg.type !== 'test') return;
    try { send({ type: 'result', reqId: msg.reqId, result: await (msg.type === 'crawl' ? crawl(msg, send) : test(msg)) }); }
    catch (e) { send({ type: 'error', reqId: msg.reqId, code: e.code || null, message: e.message, stats: e.stats || null }); }
  });
  send({ type: 'ready' });
}

module.exports = { crawl, test };
