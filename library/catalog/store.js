// Catalog storage on disk, one folder per source (data/catalog/<sourceId>/):
//   works.json         { version, sourceId, updatedAt, works: { sid: work without chapters } }
//   chapters/<xx>.json { sid: { chapters: [...], partial } }  (256 shards by a hash of the work id)
//   state.json         { running, runStartedAt, phase, lastCrawlAt, lastError, stats }
// Written by the crawler process; read by the server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const shardOf = sid => crypto.createHash('sha1').update(String(sid)).digest('hex').slice(0, 2);
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
// Write, then swap in (a reader never sees half a file). On Windows the swap fails while another process (the
// server reading a crawler's files, or the other way round) has the file open for a moment: try again shortly.
function replaceFile(tmp, file) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 20) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + i * 10); // (a short, blocking wait)
    }
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  replaceFile(tmp, file);
}
const worksFile = dir => path.join(dir, 'works.json');
const stateFile = dir => path.join(dir, 'state.json');
const shardFile = (dir, shard) => path.join(dir, 'chapters', `${shard}.json`);

function readWorks(dir) { const d = readJson(worksFile(dir), null); return d && d.works ? d : { version: 1, works: {} }; }
function writeWorks(dir, data) { writeJson(worksFile(dir), Object.assign({ version: 1 }, data, { updatedAt: new Date().toISOString() })); }
function readState(dir) { return readJson(stateFile(dir), {}); }
function writeState(dir, state) { writeJson(stateFile(dir), state); }
// What each sitemap file held at the last crawl (its content hash, its date in the index, a fingerprint per work)
function readSitemapState(dir) { return readJson(path.join(dir, 'sitemaps.json'), null); }
function writeSitemapState(dir, data) { writeJson(path.join(dir, 'sitemaps.json'), data); }
function readShard(dir, shard) { return readJson(shardFile(dir, shard), {}); }
function writeShard(dir, shard, data) { writeJson(shardFile(dir, shard), data); }

// Chapter shards with a small write-back cache (the crawler touches them work by work)
function shardCache(dir, max = 32) {
  const loaded = new Map(), dirty = new Set();
  const load = shard => {
    if (loaded.has(shard)) { const v = loaded.get(shard); loaded.delete(shard); loaded.set(shard, v); return v; }
    const v = readShard(dir, shard);
    loaded.set(shard, v);
    while (loaded.size > max) {
      const [k, old] = loaded.entries().next().value;
      if (dirty.has(k)) { writeShard(dir, k, old); dirty.delete(k); }
      loaded.delete(k);
    }
    return v;
  };
  return {
    get: sid => load(shardOf(sid))[sid] || null,
    set: (sid, value) => { const s = shardOf(sid); const d = load(s); if (value) d[sid] = value; else delete d[sid]; dirty.add(s); },
    flush: () => { for (const s of dirty) writeShard(dir, s, loaded.get(s) || readShard(dir, s)); dirty.clear(); }
  };
}

module.exports = { readSitemapState, writeSitemapState, replaceFile, shardOf, readWorks, writeWorks, readState, writeState, readShard, writeShard, shardCache, worksFile, stateFile };
