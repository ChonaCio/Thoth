// Cache snapshots on disk (data/cache/snapshots/<kind>.snap): what a cache keeps in memory, saved so it comes back
// at once when its process starts again (after a restart of the server, or after it closed when idle) instead of
// being built again request by request.
//   File: "THCS" + version (1 byte) + header length (u32) + header JSON + entries, each:
//         key length (u32) + key (UTF-8) + meta length (u32) + meta JSON + data length (u32) + data
//   Written to a temporary file and renamed into place, so a crash never leaves half a snapshot.
// A cache that depends on the library's data saves with its header a fingerprint of the data files (dataSig, by
// the server); its entries are only taken back while that fingerprint is the same.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.THOTH_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
const DIR = path.join(DATA_DIR, 'cache', 'snapshots');
const MAGIC = 'THCS', VERSION = 1;
const fileOf = kind => path.join(DIR, `${String(kind).replace(/[^a-z]/g, '')}.snap`);
const off = () => process.env.THOTH_CACHE_SNAPSHOTS === '0';

// entries: iterable of { key, meta, data (Buffer | string) } → { bytes, entries }
async function write(kind, header, entries) {
  if (off()) return null;
  await fs.promises.mkdir(DIR, { recursive: true });
  const file = fileOf(kind), tmp = `${file}.${process.pid}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  let bytes = 0, count = 0;
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  try {
    const h = Buffer.from(JSON.stringify(Object.assign({ kind, savedAt: new Date().toISOString() }, header || {})), 'utf8');
    let chunk = [Buffer.from(MAGIC, 'latin1'), Buffer.from([VERSION]), u32(h.length), h], size = 0;
    const flush = async () => { if (!chunk.length) return; const b = Buffer.concat(chunk); await fh.write(b); bytes += b.length; chunk = []; size = 0; };
    for (const e of entries) {
      const k = Buffer.from(String(e.key), 'utf8'), m = Buffer.from(JSON.stringify(e.meta || {}), 'utf8');
      const d = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8');
      chunk.push(u32(k.length), k, u32(m.length), m, u32(d.length), d);
      size += 12 + k.length + m.length + d.length;
      count++;
      if (size > 4 * 1024 * 1024) await flush(); // (written in pieces: a large cache isn't copied whole into memory again)
    }
    await flush();
  } finally { await fh.close(); }
  await fs.promises.rename(tmp, file).catch(async e => { await fs.promises.rm(tmp, { force: true }); throw e; });
  return { bytes, entries: count };
}

// → { header, entries: [{ key, meta, data: Buffer }] } or null (none, unreadable, another format)
async function read(kind) {
  if (off()) return null;
  const buf = await fs.promises.readFile(fileOf(kind)).catch(() => null);
  if (!buf || buf.length < 9 || buf.toString('latin1', 0, 4) !== MAGIC || buf[4] !== VERSION) return null;
  try {
    let p = 5;
    const take = () => { const n = buf.readUInt32LE(p); p += 4; if (p + n > buf.length) throw new Error('cut off'); const b = buf.subarray(p, p + n); p += n; return b; };
    const header = JSON.parse(take().toString('utf8'));
    const entries = [];
    while (p < buf.length) {
      const key = take().toString('utf8'), meta = JSON.parse(take().toString('utf8'));
      entries.push({ key, meta, data: Buffer.from(take()) });
    }
    return { header, entries, bytes: buf.length };
  } catch { return null; } // (a damaged snapshot: the cache starts empty)
}
const remove = kind => fs.promises.rm(fileOf(kind), { force: true });
const stat = kind => { try { const s = fs.statSync(fileOf(kind)); return { bytes: s.size, savedAt: s.mtime.toISOString() }; } catch { return null; } };

module.exports = { write, read, remove, stat, fileOf, DIR };
