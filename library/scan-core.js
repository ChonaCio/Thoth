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

/*
 * Scan a library folder.
 *   known: { [relPath]: [size, modifiedISO] } for books already in the database
 * Returns every book file found; only new or changed ones are analyzed (changed: true, pageCount, meta, error).
 */
async function collect(root, known, onProgress) {
  const found = { books: [], unsupported: [], errors: [] };
  await walk(root, '', found);
  let analyzed = 0;
  const report = () => onProgress && onProgress({ filesSeen: found.books.length, analyzed });
  report();
  const files = [];
  for (const rel of found.books) {
    const abs = path.join(root, rel);
    let st;
    try { st = await fs.promises.stat(abs); } catch { continue; }
    const entry = { rel, size: st.size, fileModified: st.mtime.toISOString() };
    const k = known[rel];
    if (!k || k[0] !== entry.size || k[1] !== entry.fileModified) {
      entry.changed = true;
      try {
        const r = await analyze(abs, BOOK_EXT[path.extname(rel).toLowerCase()]);
        entry.pageCount = r.pageCount;
        entry.meta = r.meta;
      } catch (e) {
        entry.pageCount = 0;
        entry.meta = {};
        entry.error = e.message;
      }
      analyzed++;
      if (analyzed % 10 === 0) report();
    }
    files.push(entry);
  }
  report();
  return { files, unsupported: found.unsupported, errors: found.errors };
}

module.exports = { collect, listImages, parseComicInfo, BOOK_EXT, IMAGE_TYPES };
