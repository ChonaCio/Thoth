// Batch renaming of book files to a consistent naming:
//   chapter-0.cbz              → Chapter 0.cbz
//   chapter-1.1.cbz            → Chapter 1.1.cbz
//   chapter-1x1.cbz            → Chapter 1x1.cbz
//   chapter-1-chapter name.cbz → Chapter 1 - Chapter Name.cbz
//   ch_12_the_end.cbz          → Chapter 12 - The End.cbz
//   vol.3.cbz                  → Volume 3.cbz
// The preview lists proposals (and conflicts); nothing changes until an administrator applies the ones they
// pick. Applying renames the files on disk and moves everything attached to the book to its new name
// (book ids come from the file path): reading progress, read lists. Matching JSON files of folder sources can
// be renamed along (otherwise 11.json would stop matching once 11.cbz is renamed).
const fs = require('fs');
const path = require('path');
const store = require('./db');
const local = require('./metadata/local');

const { db } = store;
const KINDS = [
  { re: /^(?:chapter|chap|ch|c)$/i, word: 'Chapter' },
  { re: /^(?:volume|vol|v)$/i, word: 'Volume' },
  { re: /^(?:episode|ep)$/i, word: 'Episode' },
  { re: /^(?:issue|iss)$/i, word: 'Issue' }
];
// "chapter-1-chapter name" → { word: 'Chapter', number: '1', name: 'chapter name' }, or null
function parse(base) {
  const m = /^([a-z]+)[\s._-]*(\d+(?:[.x]\d+)*)(?:[\s._-]+(.*\S))?\s*$/i.exec(base);
  if (!m) return null;
  const kind = KINDS.find(k => k.re.test(m[1]));
  if (!kind) return null;
  // A separator between the word and the number is optional ("chapter1", "ch.1"), but "c" alone needs a number right after
  return { word: kind.word, number: m[2], name: m[3] ? m[3].replace(/[_]+/g, ' ').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim() : '' };
}
// Capitalize each word's first letter; the rest of the word is kept (acronyms, "McGee")
function titleCase(s) {
  return s.split(' ').map(w => (w ? w[0].toLocaleUpperCase() + w.slice(1) : w)).join(' ');
}
// The name a file should have, or null when it already does / doesn't follow a known pattern
function proposedName(fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const p = parse(base);
  if (!p) return null;
  const name = p.name ? ' - ' + titleCase(p.name.replace(/^-\s*/, '')) : '';
  const next = `${p.word} ${p.number}${name}${ext}`;
  return next === fileName ? null : next;
}

const sep = rel => rel.split(/[\\/]/);
function relWithName(relPath, name) {
  const parts = sep(relPath);
  parts[parts.length - 1] = name;
  return parts.join(path.sep);
}

// Proposals for a library ('all' = every library). Each: { bookId, seriesId, libraryId, library, work, from,
// to, fromName, toName, status: 'ok' | 'conflict' | 'exists', with: … } — conflicts are never applied.
function preview(libraryId) {
  const libs = Object.values(db.libraries).filter(l => !libraryId || libraryId === 'all' || l.id === libraryId);
  const items = [];
  let checked = 0;
  for (const lib of libs) {
    const books = Object.values(db.books).filter(b => b.libraryId === lib.id);
    const taken = new Map(); // folder\0lowercase name → relPath (existing files and proposals)
    const key = (rel, name) => sep(rel).slice(0, -1).join('/') + '\0' + name.toLowerCase();
    for (const b of books) taken.set(key(b.relPath, b.fileName), b.relPath);
    const props = [];
    for (const b of books) {
      checked++;
      const toName = proposedName(b.fileName);
      if (!toName) continue;
      const s = db.series[b.seriesId];
      props.push({ b, toName, work: s ? store.seriesMeta(s).title : '' });
    }
    // Conflicts: the new name is another existing file, or two files would get the same name
    const wanted = new Map();
    for (const x of props) { const k = key(x.b.relPath, x.toName); wanted.set(k, (wanted.get(k) || 0) + 1); }
    for (const x of props) {
      const k = key(x.b.relPath, x.toName);
      const other = taken.get(k);
      const status = other && other !== x.b.relPath ? 'exists' : wanted.get(k) > 1 ? 'conflict' : 'ok';
      items.push({
        bookId: x.b.id, seriesId: x.b.seriesId, libraryId: lib.id, library: lib.name, work: x.work,
        from: sep(x.b.relPath).join('/'), to: sep(relWithName(x.b.relPath, x.toName)).join('/'), fromName: x.b.fileName, toName: x.toName,
        status, with: status === 'exists' ? sep(other).join('/') : undefined
      });
    }
  }
  items.sort((a, b) => store.collator.compare(a.library + '\0' + a.work, b.library + '\0' + b.work) || store.collator.compare(a.fromName, b.fromName));
  return { checked, items };
}

// Folder-source JSON files that describe this book (same name next to it in path mode, or by name)
function jsonFilesFor(b, metadata) {
  const out = [];
  const lib = db.libraries[b.libraryId];
  const indexCache = metadata.indexCache;
  const settings = metadata.librarySettings(lib).providers.filter(p => p.enabled && db.metadataSources[p.id]);
  for (const p of settings) {
    const src = db.metadataSources[p.id];
    const index = indexCache.get(src.id);
    if (!index) continue;
    const { pathKeys, nameKey } = local.bookKeys(b);
    const k = local.findKey(index, src.match, pathKeys, nameKey);
    if (k && index.files.get(k).json) out.push(index.files.get(k).json);
  }
  return out;
}

// Renames the picked books. Only proposals that are still valid (same file, same proposed name, no
// conflict) are applied. Returns { renamed, json, failed: [{ from, error }] }.
async function apply(picks, { renameJson = true, metadata } = {}) {
  const current = new Map(preview('all').items.map(x => [x.bookId, x]));
  const failed = [];
  let renamed = 0, json = 0;
  const touched = new Set();
  if (renameJson && metadata) await metadata.warmIndexes(); // the folder sources' indexes, to find JSON files
  for (const pick of picks) {
    const x = current.get(pick.bookId);
    if (!x || x.toName !== pick.toName) { failed.push({ from: pick.from || pick.bookId, error: 'changed' }); continue; }
    if (x.status !== 'ok') { failed.push({ from: x.from, error: x.status }); continue; }
    const b = db.books[x.bookId];
    const lib = db.libraries[b.libraryId];
    const root = path.resolve(lib.root);
    const fromAbs = path.resolve(root, b.relPath);
    const newRel = relWithName(b.relPath, x.toName);
    const toAbs = path.resolve(root, newRel);
    if (!fromAbs.startsWith(root + path.sep) || !toAbs.startsWith(root + path.sep)) { failed.push({ from: x.from, error: 'outside the library folder' }); continue; }
    // A case-only change ("chapter 1" → "Chapter 1") is fine; otherwise never overwrite
    if (fs.existsSync(toAbs) && fromAbs.toLowerCase() !== toAbs.toLowerCase()) { failed.push({ from: x.from, error: 'exists' }); continue; }
    const jsonFiles = renameJson && metadata ? jsonFilesFor(b, metadata) : [];
    try { await fs.promises.rename(fromAbs, toAbs); } catch (e) {
      failed.push({ from: x.from, error: e.code === 'EROFS' ? 'read-only' : e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission' : e.code || e.message });
      continue;
    }
    moveBook(b, newRel);
    renamed++;
    touched.add(lib.id);
    // The JSON files that described it get the same new name (".json" kept)
    for (const jf of jsonFiles) {
      const target = path.join(path.dirname(jf), path.basename(x.toName, path.extname(x.toName)) + '.json');
      if (target === jf || fs.existsSync(target)) continue;
      try { await fs.promises.rename(jf, target); json++; } catch (e) { failed.push({ from: jf, error: 'JSON: ' + (e.code || e.message) }); }
    }
  }
  store.reindex();
  store.saveLibrary();
  store.saveProgress();
  return { renamed, json, failed, libraries: [...touched] };
}

// A renamed file's book gets the id of its new path; progress and read lists follow it
function moveBook(b, newRel) {
  const oldId = b.id;
  const newId = store.stableId(b.libraryId, 'book', newRel);
  delete db.books[oldId];
  b.id = newId;
  b.relPath = newRel;
  b.fileName = path.basename(newRel);
  db.books[newId] = b;
  for (const user of Object.keys(store.progress)) {
    const p = store.progress[user];
    if (p[oldId]) { p[newId] = p[oldId]; delete p[oldId]; }
  }
  for (const r of Object.values(db.readlists)) r.bookIds = r.bookIds.map(id => (id === oldId ? newId : id));
}

module.exports = { preview, apply, proposedName, parse };
