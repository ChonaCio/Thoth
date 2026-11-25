// Pages and covers for the browser, from two cache processes of their own (cache/pages.js, cache/covers.js;
// see cache/client.js): the server only forwards requests, the reading and keeping happen there.
//   pages:  chapter pages in memory, the next ones read ahead
//   covers: covers in memory and on disk (data/cache/thumbs/), read ahead for every work after scans
const path = require('path');
const store = require('./db');
const { cacheService } = require('./cache/client');

// (pages kept on disk too: their keys carry the book and its file's date, so no fingerprint is needed)
const pages = cacheService('pages', { label: 'Pages', idleMs: 10 * 60 * 1000, persist: { save: () => ({}), restore: () => ({}) } });
const covers = cacheService('covers', { label: 'Covers', idleMs: 10 * 60 * 1000 });
const THUMB_DIR = path.join(store.DATA_DIR, 'cache', 'thumbs');

// Page n of a CBZ book: { buf, type, etag }
function page(book, file, n, { pageCount } = {}) {
  return pages.call('page', { bookId: book.id, file, n, pageCount });
}
// A book's cover (its first page): { buf, type, etag }
function bookCover(book, file) {
  return covers.call('bookCover', { bookId: book.id, file });
}
// A cover image file (downloaded/custom): { buf, type, etag } or null
async function imageFile(file, version, etag) {
  const v = await covers.call('imageFile', { file, version });
  return v ? Object.assign({ etag }, v) : null;
}

// Covers of every work that shows a page of its own (first page of its first CBZ), read ahead by the covers
// process after scans (and once after startup); works whose cover is a downloaded/custom image are skipped
function coverBookOf(s) {
  if (s.hidden || store.coverFromMetadata(s)) return null;
  return store.booksOf(s.id).find(b => b.format === 'cbz' && b.pageCount) || null;
}
function warmCovers() {
  const items = [];
  for (const s of Object.values(store.db.series)) {
    const b = coverBookOf(s);
    const lib = b && store.db.libraries[b.libraryId];
    if (lib) items.push({ bookId: b.id, file: path.join(lib.root, b.relPath) });
  }
  return covers.call('warm', { items });
}
let warmTimer = null;
function scheduleWarm(ms = 3000) {
  if (process.env.THOTH_NO_WARM === '1') return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => warmCovers().catch(e => console.error('[covers] reading ahead:', e.message)), ms);
  warmTimer.unref();
}

function info() { return { pages: pages.info(), covers: covers.info() }; }
function clear() { return Promise.all([pages.call('clear'), covers.call('clear')]); }

module.exports = { page, bookCover, imageFile, info, clear, warmCovers, scheduleWarm, THUMB_DIR };
