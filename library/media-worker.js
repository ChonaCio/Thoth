// Media worker: reads page images out of CBZ files for the media service (media.js), so the web server never
// opens archives itself. Started when pages or covers are needed, closed when idle. It never touches the
// database. Requests (answered by reqId):
//   { type: 'pages', reqId, file, mtimeMs, pages: [n, …] } → result: [{ n, buf, type } | { n, error }]
// It keeps the image list of recently opened archives (so the next pages of a chapter are quick).
const path = require('path');
const { listImages, IMAGE_TYPES } = require('./scan-core');
const zip = require('./zip');

const lists = new Map(); // `${file}|${mtime}` → sorted image entries (LRU)
async function entries(file, mtimeMs) {
  const key = `${file}|${mtimeMs}`;
  if (lists.has(key)) { const v = lists.get(key); lists.delete(key); lists.set(key, v); return v; }
  const images = await listImages(file);
  lists.set(key, images);
  if (lists.size > 128) lists.delete(lists.keys().next().value);
  return images;
}

async function pages(file, mtimeMs, wanted) {
  const images = await entries(file, mtimeMs);
  const out = [];
  for (const n of wanted) {
    const entry = images[n - 1];
    if (!entry) { out.push({ n, error: 'pageNotFound' }); continue; }
    try {
      const buf = await zip.readEntry(file, entry);
      out.push({ n, buf, type: IMAGE_TYPES[path.extname(entry.name).toLowerCase()] || 'application/octet-stream' });
    } catch (e) { out.push({ n, error: e.code || e.message }); }
  }
  return out;
}

if (require.main === module && process.send) {
  process.on('disconnect', () => process.exit(0));
  process.on('message', async msg => {
    if (!msg || msg.type !== 'pages') return;
    try { process.send({ type: 'result', reqId: msg.reqId, result: await pages(msg.file, msg.mtimeMs, msg.pages || []) }); }
    catch (e) { process.send({ type: 'error', reqId: msg.reqId, code: e.code || null, message: e.message }); }
  });
  process.send({ type: 'ready' });
}

module.exports = { pages };
