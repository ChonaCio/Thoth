// Folder metadata sources: a folder of JSON files that an administrator keeps, matched to books and works
// by name. No network: they're read again after every scan, so editing a JSON file and rescanning (or
// "Apply now") is enough.
//
// Matching (per source, `match`):
//   'path' (same structure as the library) — keys are paths relative to the library folder:
//       <folder>/One Piece/11.json    → <library>/One Piece/11.cbz   (a book)
//       <folder>/One Piece.json       → the work in <library>/One Piece/
//       <folder>/One Piece/series.json → same work (alternative)
//     Pointing the source at the library folder itself = JSON files next to the comics ("sidecars").
//   'name' (by file name anywhere in the folder):
//       <folder>/**/11.json  → every book whose file is named 11.<ext>
//       <folder>/**/One Piece.json → the work whose folder is named "One Piece"
//     Simple for flat folders, but a name used by several books matches all of them (the check report says so).
// An image with the same name as a work's JSON (One Piece.jpg/.png/.webp) is that work's cover.
// A one-shot (a book file directly in the library) is both a book and a work: its JSON fills both.
const fs = require('fs');
const path = require('path');

const MATCH_MODES = ['path', 'name'];
const MAX_FILES = 200000;
const MAX_JSON = 2 * 1024 * 1024;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const TYPES = ['manga', 'manhwa', 'manhua', 'webcomic', 'comic', 'novel', 'book', 'other'];

const slash = p => p.split(path.sep).join('/');
const keyOf = rel => slash(rel).replace(/\.[^./]+$/, '').toLowerCase(); // "One Piece/11.cbz" → "one piece/11"

/* ---------------- reading a source folder ---------------- */
// { files: Map(key → { json, image }), byName: Map(base → [key]), count, truncated }
async function buildIndex(folder) {
  const files = new Map(), byName = new Map();
  let count = 0, truncated = false;
  async function walk(dir, rel, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (depth < 8) await walk(path.join(dir, e.name), r, depth + 1); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      const kind = ext === '.json' ? 'json' : IMAGE_EXT.has(ext) ? 'image' : null;
      if (!kind) continue;
      if (++count > MAX_FILES) { truncated = true; return; }
      const key = keyOf(r);
      if (!files.has(key)) files.set(key, {});
      const entry = files.get(key);
      if (!entry[kind]) entry[kind] = path.join(dir, e.name);
      if (kind === 'json') {
        const base = key.split('/').pop();
        if (!byName.has(base)) byName.set(base, []);
        byName.get(base).push(key);
      }
    }
  }
  await walk(folder, '', 0);
  return { files, byName, count, truncated };
}

// Parsed JSON files, reused while unchanged
const parsed = new Map(); // file → { mtimeMs, data, error }
async function readJson(file) {
  let st;
  try { st = await fs.promises.stat(file); } catch { return { error: 'missing' }; }
  const hit = parsed.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  let out;
  if (st.size > MAX_JSON) out = { mtimeMs: st.mtimeMs, error: 'file is too large (over 2 MB)' };
  else {
    try {
      const text = (await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, '');
      const data = JSON.parse(text);
      out = data && typeof data === 'object' && !Array.isArray(data) ? { mtimeMs: st.mtimeMs, data } : { mtimeMs: st.mtimeMs, error: 'not a JSON object' };
    } catch (e) { out = { mtimeMs: st.mtimeMs, error: 'invalid JSON: ' + e.message }; }
  }
  parsed.set(file, out);
  return out;
}

/* ---------------- JSON → metadata ---------------- */
// Keys are matched without case, so ComicInfo-style names ("Summary", "Genre", "Writer") work too
function lower(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[k.toLowerCase().replace(/[\s_-]/g, '')] = v; return r; }
const pick = (o, ...names) => { for (const n of names) if (o[n] != null && o[n] !== '') return o[n]; return undefined; };
const text = (v, max = 5000) => (v == null || typeof v === 'object' ? undefined : String(v).trim().slice(0, max) || undefined);
function list(v, max = 50) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;]/) : [];
  const out = [...new Set(arr.map(x => (typeof x === 'object' && x ? x.name : x)).map(x => text(x, 80)).filter(Boolean))].slice(0, max);
  return out.length ? out : undefined;
}
const STATUS = [[/^(ongoing|releasing|publishing|current|running)$/i, 'ongoing'], [/^(ended|completed?|finished|complete)$/i, 'ended'],
  [/^(hiatus|on hiatus|paused)$/i, 'hiatus'], [/^(abandoned|cancell?ed|discontinued|dropped)$/i, 'abandoned']];
const DIRECTION = [[/^(rtl|right ?to ?left|yesandrighttoleft|manga)$/i, 'rtl'], [/^(ltr|left ?to ?right|no|western)$/i, 'ltr'],
  [/^(vertical|continuous|webtoon|scroll|long ?strip)$/i, 'vertical']];
const mapped = (v, table) => { const s = text(v, 40); if (!s) return undefined; for (const [re, out] of table) if (re.test(s)) return out; return undefined; };
function date(v) {
  const s = text(v, 30);
  if (!s) return undefined;
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(s);
  if (!m) return undefined;
  return [m[1], m[2] && m[2].padStart(2, '0'), m[3] && m[3].padStart(2, '0')].filter(Boolean).join('-');
}
function authorsOf(o) {
  const out = [];
  const add = (name, role) => { const n = text(name, 120); if (n && !out.some(a => a.name === n && a.role === role)) out.push({ name: n, role }); };
  const raw = pick(o, 'authors', 'creators', 'people');
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (typeof a === 'string') add(a, 'writer');
      else if (a && typeof a === 'object') add(a.name, ['writer', 'penciller', 'inker', 'colorist', 'letterer', 'coverartist', 'editor', 'creator'].includes(String(a.role || '').toLowerCase()) ? String(a.role).toLowerCase() : 'writer');
    }
  } else if (typeof raw === 'string') for (const n of raw.split(/[,;]/)) add(n, 'writer');
  for (const [k, role] of [['writer', 'writer'], ['author', 'writer'], ['penciller', 'penciller'], ['artist', 'penciller'], ['inker', 'inker'],
    ['colorist', 'colorist'], ['letterer', 'letterer'], ['coverartist', 'coverartist'], ['editor', 'editor']]) {
    const v = o[k];
    if (typeof v === 'string') for (const n of v.split(/[,;]/)) add(n, role);
    else if (Array.isArray(v)) for (const n of v) add(n, role);
  }
  return out.length ? out.slice(0, 30) : undefined;
}
function ratingOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n <= 5 && String(v).includes('/5') ? n * 20 : n <= 10 ? n * 10 : Math.min(100, n));
}
// For a work
function seriesRecord(data) {
  const o = lower(data);
  const type = text(pick(o, 'type', 'format', 'kind'), 30);
  const rec = {
    summary: text(pick(o, 'summary', 'description', 'synopsis', 'plot')),
    status: mapped(pick(o, 'status', 'publicationstatus'), STATUS),
    year: (() => { const y = Number(String(pick(o, 'year', 'startyear', 'released') || '').slice(0, 4)); return y >= 1000 && y <= 9999 ? y : undefined; })(),
    type: type && TYPES.includes(type.toLowerCase()) ? type.toLowerCase() : undefined,
    publisher: text(pick(o, 'publisher', 'imprint'), 200),
    authors: authorsOf(o),
    genres: list(pick(o, 'genres', 'genre')),
    tags: list(pick(o, 'tags', 'tag', 'keywords')),
    rating: ratingOf(pick(o, 'rating', 'score', 'communityrating')),
    ageRating: text(pick(o, 'agerating', 'contentrating'), 40),
    readingDirection: mapped(pick(o, 'readingdirection', 'direction', 'manga', 'readingmode'), DIRECTION),
    altTitles: list(pick(o, 'alttitles', 'alternativetitles', 'alternatetitles', 'synonyms', 'aliases'), 20),
    sortTitle: text(pick(o, 'sorttitle', 'sortname'), 200),
    coverRel: text(pick(o, 'cover', 'image', 'thumbnail', 'poster'), 500)
  };
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined));
}
// For a book (chapter/volume/issue)
function bookRecord(data) {
  const o = lower(data);
  const rec = {
    title: text(pick(o, 'title', 'name', 'chaptertitle'), 200),
    number: text(pick(o, 'number', 'chapter', 'issue', 'volume', 'episode'), 20),
    summary: text(pick(o, 'summary', 'description', 'synopsis', 'plot')),
    releaseDate: date(pick(o, 'releasedate', 'date', 'published', 'publishdate', 'year')),
    authors: authorsOf(o)
  };
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined));
}

/* ---------------- matching ---------------- */
// The index key to use for a book / work in a source, or null. `note` collects names used more than once.
function findKey(index, mode, pathKeys, nameKey, note) {
  for (const k of pathKeys) if (index.files.has(k) && index.files.get(k).json) return k;
  if (mode === 'name' && nameKey) {
    const hits = index.byName.get(nameKey);
    if (hits && hits.length) {
      if (hits.length > 1 && note) note.add(nameKey);
      return hits[0];
    }
  }
  return null;
}
function bookKeys(book) {
  const k = keyOf(book.relPath);
  return { pathKeys: [k], nameKey: k.split('/').pop() };
}
function seriesKeys(s) {
  if (s.oneshot) { const k = keyOf(s.relPath); return { pathKeys: [k], nameKey: k.split('/').pop() }; }
  const k = slash(s.relPath).toLowerCase();
  return { pathKeys: [k, k + '/series'], nameKey: k.split('/').pop() };
}
// A cover: the JSON's "cover" (a path next to/under the JSON file; no web addresses), else an image named like it
function coverFor(index, key, rec, jsonFile, folder) {
  if (rec.coverRel && !/^[a-z]+:/i.test(rec.coverRel)) {
    // Relative to the JSON file, and it must stay inside the source folder
    const p = path.resolve(path.dirname(jsonFile), rec.coverRel);
    const root = path.resolve(folder);
    if (p.startsWith(root + path.sep) && IMAGE_EXT.has(path.extname(p).toLowerCase()) && fs.existsSync(p)) return p;
  }
  const e = index.files.get(key);
  if (e && e.image) return e.image;
  if (key.endsWith('/series')) { const up = index.files.get(key.slice(0, -'/series'.length)); if (up && up.image) return up.image; }
  return null;
}

module.exports = {
  MATCH_MODES, buildIndex, readJson, seriesRecord, bookRecord, findKey, bookKeys, seriesKeys, coverFor, keyOf
};
