// Library scanner: walks a library's folder and keeps series/books in sync with the files on disk.
//   Series = a folder that directly contains book files.  Book = a .cbz/.zip/.pdf file.
//   Only new or changed files (size/modified time) are analyzed again; removed files are dropped.
//   ComicInfo.xml inside CBZ files provides titles, numbers, summaries, authors and reading direction.
const fs = require('fs');
const path = require('path');
const zip = require('./zip');
const store = require('./db');

const BOOK_EXT = { '.cbz': 'cbz', '.zip': 'cbz', '.pdf': 'pdf' };
const UNSUPPORTED_EXT = new Set(['.cbr', '.rar', '.cb7', '.7z', '.cbt', '.epub']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.jxl']);
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.jxl': 'image/jxl'
};

const scanning = new Map(); // libraryId -> { startedAt, filesSeen, analyzed }

/* ---------------- archive helpers (shared with the page API) ---------------- */
const entryCache = new Map(); // `${file}|${mtime}` -> sorted image entries
async function imageEntries(file, mtimeMs) {
  const key = `${file}|${mtimeMs}`;
  if (entryCache.has(key)) {
    const v = entryCache.get(key);
    entryCache.delete(key); entryCache.set(key, v); // LRU bump
    return v;
  }
  const all = await zip.listEntries(file);
  const images = all
    .filter(e => IMAGE_EXT.has(path.extname(e.name).toLowerCase()) && !/(^|\/)(__MACOSX|\.)/.test(e.name))
    .sort((a, b) => store.collator.compare(a.name, b.name));
  images.comicInfo = all.find(e => /(^|\/)comicinfo\.xml$/i.test(e.name)) || null;
  entryCache.set(key, images);
  if (entryCache.size > 64) entryCache.delete(entryCache.keys().next().value);
  return images;
}

/* ---------------- ComicInfo.xml ---------------- */
function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&').trim();
}
function parseComicInfo(xml) {
  const list = v => v.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const authors = [];
  for (const role of ['Writer', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor']) {
    for (const name of list(xmlText(xml, role))) authors.push({ name, role: role.toLowerCase() });
  }
  const y = xmlText(xml, 'Year'), mo = xmlText(xml, 'Month'), d = xmlText(xml, 'Day');
  const manga = xmlText(xml, 'Manga').toLowerCase();
  return {
    title: xmlText(xml, 'Title') || undefined,
    series: xmlText(xml, 'Series') || undefined,
    number: xmlText(xml, 'Number') || undefined,
    summary: xmlText(xml, 'Summary') || undefined,
    publisher: xmlText(xml, 'Publisher') || undefined,
    releaseDate: /^\d{4}$/.test(y) ? `${y}-${String(mo || 1).padStart(2, '0')}-${String(d || 1).padStart(2, '0')}` : undefined,
    authors: authors.length ? authors : undefined,
    tags: [...list(xmlText(xml, 'Genre')), ...list(xmlText(xml, 'Tags'))],
    ageRating: xmlText(xml, 'AgeRating') || undefined,
    readingDirection: manga === 'yesandrighttoleft' ? 'rtl' : (/webtoon/i.test(xmlText(xml, 'Format')) ? 'vertical' : undefined)
  };
}

/* ---------------- PDF page count (best effort; the reader corrects it) ---------------- */
async function pdfPageCount(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const CHUNK = 4 * 1024 * 1024;
    let best = 0, carry = '';
    for (let pos = 0; pos < size; pos += CHUNK) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      await fh.read(buf, 0, buf.length, pos);
      const text = carry + buf.toString('latin1');
      const re = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g;
      let m;
      while ((m = re.exec(text))) best = Math.max(best, Number(m[1] || m[2]));
      carry = text.slice(-200);
    }
    return best || null;
  } finally {
    await fh.close();
  }
}

/* ---------------- analysis of one book file ---------------- */
async function analyze(file, format, mtimeMs) {
  if (format === 'pdf') return { pageCount: await pdfPageCount(file), meta: {} };
  const images = await imageEntries(file, mtimeMs);
  let meta = {};
  if (images.comicInfo) {
    try { meta = parseComicInfo((await zip.readEntry(file, images.comicInfo)).toString('utf8')); } catch { /* ignore bad xml */ }
  }
  if (!images.length) throw new Error('No images found in archive');
  return { pageCount: images.length, meta };
}

/* ---------------- walking the folder ---------------- */
async function walk(root, rel, out) {
  let entries;
  try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch (e) {
    if (!rel) throw e; // the library folder itself must be readable
    out.errors.push(`${rel}: ${e.code || e.message}`);
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === '@eaDir' || ent.name === '#recycle') continue;
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    if (ent.isDirectory()) await walk(root, childRel, out);
    else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (BOOK_EXT[ext]) out.books.push(childRel);
      else if (UNSUPPORTED_EXT.has(ext)) out.unsupported.push(childRel);
    }
  }
}

async function scanLibrary(libraryId) {
  const lib = store.db.libraries[libraryId];
  if (!lib) throw Object.assign(new Error('Library not found'), { status: 404, code: 'notFound' });
  if (scanning.has(libraryId)) return { alreadyRunning: true };
  const status = { startedAt: new Date().toISOString(), filesSeen: 0, analyzed: 0 };
  scanning.set(libraryId, status);
  const started = Date.now();
  try {
    const found = { books: [], unsupported: [], errors: [] };
    await walk(lib.root, '', found);
    status.filesSeen = found.books.length;
    const now = new Date().toISOString();
    const seenBooks = new Set(), seenSeries = new Set();
    let added = 0, updated = 0;

    // group book files by folder → series
    const groups = new Map();
    for (const rel of found.books) {
      const dir = path.dirname(rel) === '.' ? '' : path.dirname(rel);
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(rel);
    }

    for (const [dir, files] of groups) {
      files.sort((a, b) => store.collator.compare(path.basename(a), path.basename(b)));
      const seriesId = store.stableId(libraryId, 'series', dir);
      seenSeries.add(seriesId);
      let series = store.db.series[seriesId];
      if (!series) {
        series = store.db.series[seriesId] = {
          id: seriesId, libraryId, relPath: dir, name: dir ? path.basename(dir) : lib.name,
          meta: {}, overrides: {}, created: now, updated: now
        };
        added++;
      }
      let seriesChanged = false;

      for (let i = 0; i < files.length; i++) {
        const rel = files[i];
        const abs = path.join(lib.root, rel);
        const bookId = store.stableId(libraryId, 'book', rel);
        seenBooks.add(bookId);
        let stat;
        try { stat = await fs.promises.stat(abs); } catch { continue; }
        const modified = stat.mtime.toISOString();
        let book = store.db.books[bookId];
        const isNew = !book;
        if (isNew) {
          book = store.db.books[bookId] = {
            id: bookId, seriesId, libraryId, relPath: rel, fileName: path.basename(rel),
            format: BOOK_EXT[path.extname(rel).toLowerCase()], overrides: {}, created: now
          };
        }
        if (book.index !== i) { book.index = i; seriesChanged = true; }
        if (isNew || book.size !== stat.size || book.fileModified !== modified) {
          try {
            const result = await analyze(abs, book.format, stat.mtimeMs);
            book.pageCount = result.pageCount;
            book.meta = result.meta;
            delete book.error;
          } catch (e) {
            book.pageCount = book.pageCount || 0;
            book.meta = {};
            book.error = e.message;
          }
          book.size = stat.size;
          book.fileModified = modified;
          book.analyzedAt = now;
          status.analyzed++;
          if (!isNew) updated++;
          seriesChanged = true;
        }
      }

      if (seriesChanged) {
        // Series-level metadata from the first book's ComicInfo (admin overrides still win)
        const first = files.map(f => store.db.books[store.stableId(libraryId, 'book', f)]).find(b => b && b.meta && Object.keys(b.meta).length);
        const fm = (first && first.meta) || {};
        series.meta = {
          title: fm.series || undefined, summary: fm.summary && files.length === 1 ? fm.summary : undefined,
          publisher: fm.publisher, readingDirection: fm.readingDirection, ageRating: fm.ageRating,
          tags: [...new Set(files.flatMap(f => ((store.db.books[store.stableId(libraryId, 'book', f)] || {}).meta || {}).tags || []))]
        };
        series.updated = now;
      }
    }

    // Remove books/series whose files are gone
    let removed = 0;
    for (const b of Object.values(store.db.books)) {
      if (b.libraryId === libraryId && !seenBooks.has(b.id)) { delete store.db.books[b.id]; removed++; }
    }
    for (const s of Object.values(store.db.series)) {
      if (s.libraryId === libraryId && !seenSeries.has(s.id)) delete store.db.series[s.id];
    }
    for (const c of Object.values(store.db.collections)) c.seriesIds = c.seriesIds.filter(id => store.db.series[id]);
    for (const r of Object.values(store.db.readlists)) r.bookIds = r.bookIds.filter(id => store.db.books[id]);

    store.reindex();
    lib.lastScan = {
      at: new Date().toISOString(), durationMs: Date.now() - started,
      series: seenSeries.size, books: seenBooks.size, added, updated, removed,
      unsupported: found.unsupported.length, unsupportedExamples: found.unsupported.slice(0, 5),
      errors: found.errors.slice(0, 20),
      failedBooks: Object.values(store.db.books).filter(b => b.libraryId === libraryId && b.error).length
    };
    delete lib.scanError;
    store.saveLibrary();
    console.log(`[library] scanned "${lib.name}": ${seenSeries.size} series, ${seenBooks.size} books (+${added} new, ${updated} changed, ${removed} removed) in ${Date.now() - started} ms`);
    return lib.lastScan;
  } catch (e) {
    lib.scanError = e.code === 'ENOENT' ? 'folderNotFound' : e.code === 'EACCES' ? 'folderNoAccess' : e.message;
    store.saveLibrary();
    console.error(`[library] scan of "${lib.name}" failed: ${e.message}`);
    throw e;
  } finally {
    scanning.delete(libraryId);
  }
}

// Scan every library now, and again every N minutes (settings.scanIntervalMinutes; 0 = never)
let timer = null;
function scanAll() {
  for (const id of Object.keys(store.db.libraries)) scanLibrary(id).catch(() => {});
}
function startSchedule() {
  clearInterval(timer);
  const minutes = Number(store.db.settings.scanIntervalMinutes) || 0;
  if (minutes > 0) timer = setInterval(scanAll, minutes * 60 * 1000).unref();
}

module.exports = { scanLibrary, scanAll, startSchedule, scanning, imageEntries, IMAGE_TYPES, BOOK_EXT, parseComicInfo };
