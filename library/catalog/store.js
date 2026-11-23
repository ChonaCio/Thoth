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
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
const worksFile = dir => path.join(dir, 'works.json');
const stateFile = dir => path.join(dir, 'state.json');
const shardFile = (dir, shard) => path.join(dir, 'chapters', `${shard}.json`);

function readWorks(dir) { const d = readJson(worksFile(dir), null); return d && d.works ? d : { version: 1, works: {} }; }
function writeWorks(dir, data) { writeJson(worksFile(dir), Object.assign({ version: 1 }, data, { updatedAt: new Date().toISOString() })); }
function readState(dir) { return readJson(stateFile(dir), {}); }
function writeState(dir, state) { writeJson(stateFile(dir), state); }
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

module.exports = { shardOf, readWorks, writeWorks, readState, writeState, readShard, writeShard, shardCache, worksFile, stateFile };
