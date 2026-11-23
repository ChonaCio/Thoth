// The file work of a library scan: walking folders, reading ZIP directories, ComicInfo.xml and PDF
// page counts. Runs inside the scan worker process (scan-worker.js), so it must not touch the database.
const fs = require('fs');
const path = require('path');
const zip = require('./zip');

const BOOK_EXT = { '.cbz': 'cbz', '.zip': 'cbz', '.pdf': 'pdf' };
const UNSUPPORTED_EXT = new Set(['.cbr', '.rar', '.cb7', '.7z', '.cbt', '.epub']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.jxl']);
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.jxl': 'image/jxl'
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Image pages of a CBZ, in reading (natural name) order, plus its ComicInfo.xml entry if any
async function listImages(file) {
  const all = await zip.listEntries(file);
  const images = all
    .filter(e => IMAGE_EXT.has(path.extname(e.name).toLowerCase()) && !/(^|\/)(__MACOSX|\.)/.test(e.name))
    .sort((a, b) => collator.compare(a.name, b.name));
  images.comicInfo = all.find(e => /(^|\/)comicinfo\.xml$/i.test(e.name)) || null;
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
    genres: list(xmlText(xml, 'Genre')),
    tags: list(xmlText(xml, 'Tags')),
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

async function analyze(file, format) {
  if (format === 'pdf') return { pageCount: await pdfPageCount(file), meta: {} };
  const images = await listImages(file);
  let meta = {};
  if (images.comicInfo) {
    try { meta = parseComicInfo((await zip.readEntry(file, images.comicInfo)).toString('utf8')); } catch { /* ignore bad xml */ }
  }
  if (!images.length) throw new Error('No images found in archive');
  return { pageCount: images.length, meta };
}

// Run fn over items with at most `limit` running at the same time
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const runner = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return out;
}

/*
 * Step 1 of a scan: every book file in the library with its size and modification time.
 * Also returns a scan index ({ version, root, dirs: { relDir: { mtimeMs, files: [[name, size, modified]],
 * dirs: [names], unsupported: [names] } } }) that the scanner saves for the next scan.
 * opts.prev: the saved index; opts.quick: reuse a folder's saved listing when the folder's modification time
 * is unchanged (adding, removing or renaming files changes it), so only folders are checked, not every file.
 * onProgress(filesSeen)
 */
async function listFiles(root, onProgress, opts = {}) {
  const prev = opts.prev && opts.prev.version === 1 && opts.prev.root === root ? opts.prev.dirs : null;
  const quick = Boolean(opts.quick && prev);
  const dirs = {}, files = [], unsupported = [], errors = [];
  let seen = 0, dirsReused = 0, filesChecked = 0;
  const join = (rel, name) => (rel ? path.join(rel, name) : name);
  const tick = n => { const before = seen; seen += n; if (onProgress && Math.floor(seen / 200) !== Math.floor(before / 200)) onProgress(seen); };
  async function visit(rel) {
    const abs = rel ? path.join(root, rel) : root;
    let st;
    try { st = await fs.promises.stat(abs); } catch (e) {
      if (!rel) throw e; // the library folder itself must be readable
      errors.push(`${rel}: ${e.code || e.message}`);
      return;
    }
    const old = prev && prev[rel];
    if (quick && old && old.mtimeMs === st.mtimeMs) {
      // Unchanged folder: same files as last time
      dirs[rel] = old;
      dirsReused++;
      for (const [name, size, modified] of old.files) files.push({ rel: join(rel, name), size, fileModified: modified });
      for (const name of old.unsupported || []) unsupported.push(join(rel, name));
      tick(old.files.length);
      for (const d of old.dirs) await visit(join(rel, d));
      return;
    }
    let entries;
    try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (e) {
      if (!rel) throw e;
      errors.push(`${rel}: ${e.code || e.message}`);
      return;
    }
    const entry = { mtimeMs: st.mtimeMs, files: [], dirs: [], unsupported: [] };
    const books = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === '@eaDir' || ent.name === '#recycle') continue;
      if (ent.isDirectory()) entry.dirs.push(ent.name);
      else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (BOOK_EXT[ext]) books.push(ent.name);
        else if (UNSUPPORTED_EXT.has(ext)) entry.unsupported.push(ent.name);
      }
    }
    const stats = await mapLimit(books, 16, async name => {
      try { const f = await fs.promises.stat(path.join(abs, name)); return [name, f.size, f.mtime.toISOString()]; } catch { return null; }
    });
    entry.files = stats.filter(Boolean);
    entry.dirs.sort(); entry.unsupported.sort();
    filesChecked += entry.files.length;
    dirs[rel] = entry;
    for (const [name, size, modified] of entry.files) files.push({ rel: join(rel, name), size, fileModified: modified });
    for (const name of entry.unsupported) unsupported.push(join(rel, name));
    tick(entry.files.length);
    for (const d of entry.dirs) await visit(join(rel, d));
  }
  await visit('');
  if (onProgress) onProgress(files.length);
  return {
    files, unsupported, errors,
    index: { version: 1, root, dirs },
    stats: { quick, dirs: Object.keys(dirs).length, dirsReused, filesChecked }
  };
}

/*
 * Step 2: open new/changed files (page count, ComicInfo.xml), `concurrency` at a time.
 * Returns [{ rel, pageCount, meta, error? }] in the same order. onProgress(analyzedSoFar)
 */
async function analyzeFiles(root, rels, concurrency, onProgress) {
  let done = 0;
  return mapLimit(rels, concurrency || 1, async rel => {
    let r;
    try {
      const a = await analyze(path.join(root, rel), BOOK_EXT[path.extname(rel).toLowerCase()]);
      r = { rel, pageCount: a.pageCount, meta: a.meta };
    } catch (e) {
      r = { rel, pageCount: 0, meta: {}, error: e.message };
    }
    done++;
    if (onProgress && (done % 5 === 0 || done === rels.length)) onProgress(done);
    return r;
  });
}

module.exports = { listFiles, analyzeFiles, mapLimit, listImages, parseComicInfo, BOOK_EXT, IMAGE_TYPES };
