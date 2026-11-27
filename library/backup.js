// Server backup: every setting the server has, as one JSON file, and putting such a file back.
// What's in it ("only configs" — nothing a scan, a crawl or a download builds again):
//   config          Server settings (not the metadata API keys: secrets never leave the server)
//   libraries       name, folder, settings (not their scan state)
//   settings        library-wide settings (scan interval, merge corrections: "not the same", kept apart)
//   metadataSources folder metadata sources
//   collections, readlists  (with their owners and whether they're public)
//   workEdits       what was edited by hand on works and books (fields, hidden, merged titles, Identify picks)
//   catalog         sources (their Access cookies/headers left out), merges, title clean-up, site templates
//   downloads       download jobs
// Not in it: users and passwords, reading progress, the works and books found by scans, crawled catalog data,
// covers and caches, download history.
// Import: { mode: 'merge' } adds and updates by id (what's here and not in the file stays); { mode: 'replace' }
// makes each section in the file the only one. Edits of works not scanned yet are kept and applied when the scan
// finds them (db.pendingEdits).
const store = require('./db');
const config = require('../config');

const { db } = store;
const FORMAT = 'thoth-backup', VERSION = 1;
const SECTIONS = ['config', 'libraries', 'settings', 'metadataSources', 'collections', 'readlists', 'workEdits', 'catalog', 'downloads'];
const err = (status, code, message) => Object.assign(new Error(message || code), { status, code });
const clone = v => JSON.parse(JSON.stringify(v === undefined ? null : v));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function nonSecretConfig() {
  const d = config.describe();
  return Object.assign({}, d.values); // (describe() leaves the secrets out)
}
// A catalog source without the administrator's own cookies and headers (kept: that there were some)
function sourceForBackup(s) {
  const o = clone(s);
  if (o.access) o.access = { mode: o.access.mode || 'auto', home: o.access.home || '' };
  return o;
}
function workEdits() {
  const series = {}, books = {};
  for (const s of Object.values(db.series)) {
    const e = {};
    if (s.overrides && Object.keys(s.overrides).length) e.overrides = clone(s.overrides);
    if (s.hidden) e.hidden = clone(s.hidden);
    if (s.mergedTitles && s.mergedTitles.length) e.mergedTitles = clone(s.mergedTitles);
    if (s.provider && s.provider.locked) e.locked = clone(s.provider.locked);
    if (Object.keys(e).length) series[s.id] = e;
  }
  for (const b of Object.values(db.books)) if (b.overrides && Object.keys(b.overrides).length) books[b.id] = { overrides: clone(b.overrides) };
  // (edits waiting for works not scanned yet stay in the backup too)
  const pending = db.pendingEdits || {};
  // (works set aside by a scan: their own edits and Identify picks — not the fetched metadata, fetched again)
  for (const [id, e] of Object.entries(pending.series || {})) {
    if (series[id]) continue;
    const o = clone(e);
    if (o.provider) { if (o.provider.locked) o.locked = o.provider.locked; delete o.provider; }
    delete o.setAsideAt; delete o.customCover; delete o.created;
    if (Object.keys(o).length) series[id] = o;
  }
  for (const [id, e] of Object.entries(pending.books || {})) if (!books[id]) books[id] = clone(e);
  return { series, books };
}

function exportAll() {
  const libraries = {};
  for (const [id, l] of Object.entries(db.libraries)) { const o = clone(l); delete o.lastScan; delete o.scanError; libraries[id] = o; }
  let app = null; try { app = require('../package.json').version; } catch { /* none */ }
  return {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), app,
    config: nonSecretConfig(),
    libraries,
    settings: clone(db.settings || {}),
    metadataSources: clone(db.metadataSources || {}),
    collections: clone(db.collections || {}),
    readlists: clone(db.readlists || {}),
    workEdits: workEdits(),
    catalog: {
      sources: Object.fromEntries(Object.entries(db.catalogSources || {}).map(([id, s]) => [id, sourceForBackup(s)])),
      merges: clone(db.catalogMerges || { groups: {}, dismissed: [], apart: [] }),
      settings: clone(db.catalogSettings || {}),
      templates: clone(db.catalogTemplates || {})
    },
    downloads: { jobs: clone(db.downloadJobs || {}) }
  };
}

// What a file holds (shown before importing): counts per section
function summary(b) {
  const n = o => (isObj(o) ? Object.keys(o).length : Array.isArray(o) ? o.length : 0);
  return {
    exportedAt: b.exportedAt || null, app: b.app || null,
    config: n(b.config), libraries: n(b.libraries), metadataSources: n(b.metadataSources), collections: n(b.collections), readlists: n(b.readlists),
    workEdits: n(b.workEdits && b.workEdits.series) + n(b.workEdits && b.workEdits.books),
    catalogSources: n(b.catalog && b.catalog.sources), catalogMerges: n(b.catalog && b.catalog.merges && b.catalog.merges.groups), catalogTemplates: n(b.catalog && b.catalog.templates),
    downloadJobs: n(b.downloads && b.downloads.jobs)
  };
}
function check(b) {
  if (!isObj(b) || b.format !== FORMAT) throw err(400, 'notBackup', 'Not a Thoth backup file');
  if (Number(b.version) > VERSION) throw err(400, 'newerBackup', 'This backup comes from a newer Thoth: update this server first');
  for (const k of ['libraries', 'metadataSources', 'collections', 'readlists']) if (b[k] != null && !isObj(b[k])) throw err(400, 'invalid', `${k}: not a list by id`);
  for (const [id, l] of Object.entries(b.libraries || {})) if (!isObj(l) || typeof l.root !== 'string' || !l.name) throw err(400, 'invalid', `library ${id}: needs a name and a folder`);
}
const validId = id => typeof id === 'string' && /^[\w-]{1,80}$/.test(id);
// Puts entries by id into a table: replace = only the file's; merge = the file's over what's here
function putAll(table, from, replace, fix = x => x) {
  if (replace) for (const id of Object.keys(table)) delete table[id];
  let n = 0;
  for (const [id, v] of Object.entries(from || {})) { if (!validId(id) || !isObj(v)) continue; table[id] = fix(Object.assign(clone(v), { id: v.id || id })); n++; }
  return n;
}

// → { imported: { section: count }, newLibraries: [id], pendingEdits }
function importAll(b, { mode = 'merge', sections = null } = {}) {
  check(b);
  const replace = mode === 'replace';
  const want = new Set((Array.isArray(sections) && sections.length ? sections : SECTIONS).filter(s => SECTIONS.includes(s)));
  const out = { imported: {}, newLibraries: [], pendingEdits: 0 };
  if (want.has('config') && isObj(b.config)) {
    const patch = {};
    const schema = config.describe().schema;
    for (const [k, v] of Object.entries(b.config)) if (schema[k]) patch[k] = v; // (unknown or secret keys skipped)
    out.imported.config = config.update(patch).length;
  }
  if (want.has('libraries') && b.libraries) {
    const before = new Set(Object.keys(db.libraries));
    // (replacing: libraries not in the file are only forgotten when their works go too — done by removing them below)
    if (replace) for (const id of Object.keys(db.libraries)) if (!b.libraries[id]) {
      for (const bk of Object.values(db.books)) if (bk.libraryId === id) delete db.books[bk.id];
      for (const s of Object.values(db.series)) if (s.libraryId === id) delete db.series[s.id];
      delete db.libraries[id];
    }
    let n = 0;
    for (const [id, l] of Object.entries(b.libraries)) {
      if (!validId(id)) continue;
      const cur = db.libraries[id] || {};
      db.libraries[id] = Object.assign(clone(l), { id, lastScan: cur.lastScan, scanError: cur.scanError });
      if (!before.has(id)) out.newLibraries.push(id);
      n++;
    }
    out.imported.libraries = n;
  }
  if (want.has('settings') && isObj(b.settings)) {
    db.settings = Object.assign(replace ? {} : db.settings || {}, clone(b.settings));
    out.imported.settings = Object.keys(b.settings).length;
  }
  if (want.has('metadataSources') && b.metadataSources) out.imported.metadataSources = putAll(db.metadataSources || (db.metadataSources = {}), b.metadataSources, replace);
  const list = (x, key) => { if (!Array.isArray(x[key])) x[key] = []; x[key] = x[key].filter(id => typeof id === 'string'); return x; };
  if (want.has('collections') && b.collections) out.imported.collections = putAll(db.collections, b.collections, replace, c => list(c, 'seriesIds'));
  if (want.has('readlists') && b.readlists) out.imported.readlists = putAll(db.readlists, b.readlists, replace, r => list(r, 'bookIds'));
  if (want.has('workEdits') && isObj(b.workEdits)) {
    const pending = replace ? { series: {}, books: {} } : Object.assign({ series: {}, books: {} }, db.pendingEdits || {});
    let n = 0;
    for (const [id, e] of Object.entries(b.workEdits.series || {})) {
      if (!validId(id) || !isObj(e)) continue;
      const s = db.series[id];
      if (s) applySeriesEdit(s, e); else { pending.series[id] = clone(e); out.pendingEdits++; }
      n++;
    }
    for (const [id, e] of Object.entries(b.workEdits.books || {})) {
      if (!validId(id) || !isObj(e)) continue;
      const bk = db.books[id];
      if (bk) { if (e.overrides) bk.overrides = clone(e.overrides); } else { pending.books[id] = clone(e); out.pendingEdits++; }
      n++;
    }
    db.pendingEdits = pending;
    out.imported.workEdits = n;
  }
  if (want.has('catalog') && isObj(b.catalog)) {
    const c = b.catalog;
    if (!db.catalogSources) db.catalogSources = {};
    // (a source's own cookies and headers aren't in backups: the ones here are kept for the same source — read
    // before replacing empties the list)
    const accessHere = Object.fromEntries(Object.entries(db.catalogSources).map(([id, s]) => [id, s.access]));
    out.imported.catalogSources = putAll(db.catalogSources, c.sources, replace, s => {
      const here = accessHere[s.id];
      if (here && s.access) s.access = Object.assign({}, here, { mode: s.access.mode || here.mode });
      return s;
    });
    if (isObj(c.merges)) {
      const m = db.catalogMerges || (db.catalogMerges = { groups: {}, dismissed: [], apart: [] });
      if (replace) db.catalogMerges = m2(c.merges);
      else {
        Object.assign(m.groups || (m.groups = {}), clone(c.merges.groups || {}));
        m.dismissed = [...new Set((m.dismissed || []).concat(c.merges.dismissed || []))];
        m.apart = [...new Set((m.apart || []).concat(c.merges.apart || []))];
      }
      out.imported.catalogMerges = Object.keys(c.merges.groups || {}).length;
    }
    if (isObj(c.settings)) db.catalogSettings = Object.assign(replace ? {} : db.catalogSettings || {}, clone(c.settings));
    if (isObj(c.templates)) out.imported.catalogTemplates = putAll(db.catalogTemplates || (db.catalogTemplates = {}), c.templates, replace);
  }
  if (want.has('downloads') && isObj(b.downloads) && isObj(b.downloads.jobs)) out.imported.downloadJobs = putAll(db.downloadJobs || (db.downloadJobs = {}), b.downloads.jobs, replace);
  store.reindex();
  store.saveLibrary();
  return out;
}
const m2 = m => ({ groups: clone(m.groups || {}), dismissed: clone(m.dismissed || []), apart: clone(m.apart || []) });
function applySeriesEdit(s, e) {
  if (e.overrides) s.overrides = clone(e.overrides);
  if (e.hidden) s.hidden = clone(e.hidden); else if ('hidden' in e && !e.hidden) delete s.hidden;
  if (e.mergedTitles) s.mergedTitles = clone(e.mergedTitles);
  if (e.customCover) s.customCover = clone(e.customCover);
  if (e.created) s.created = e.created;
  // (set aside by a scan: everything that was fetched — no new lookup — with the Identify picks)
  if (e.provider) s.provider = clone(e.provider);
  else if (e.locked) s.provider = Object.assign(s.provider || {}, { locked: clone(e.locked) });
}
// A scan didn't find a work's folder (gone for good, or a drive/share unavailable for now): what can't be read
// from the files again — the Identify picks, edits, hidden, titles from merges, and the metadata already fetched
// with its cover — is kept by its id (from its path), and given back when a scan finds the work again. Kept 180
// days at most (then its cover file goes too). → true when something was kept (its cover file stays).
const SET_ASIDE_DAYS = 180, SET_ASIDE_MAX = 20000;
function setAside(s) {
  const e = {};
  if (s.overrides && Object.keys(s.overrides).length) e.overrides = clone(s.overrides);
  if (s.hidden) e.hidden = clone(s.hidden);
  if (s.mergedTitles && s.mergedTitles.length) e.mergedTitles = clone(s.mergedTitles);
  if (s.customCover) e.customCover = clone(s.customCover);
  if (s.provider) e.provider = clone(s.provider);
  if (!Object.keys(e).length) return false;
  if (s.created) e.created = s.created; // (back with its first "added" date: not "recently added" again)
  e.setAsideAt = new Date().toISOString();
  const p = db.pendingEdits || (db.pendingEdits = { series: {}, books: {} });
  if (!p.series) p.series = {};
  p.series[s.id] = e;
  pruneSetAside();
  return true;
}
function pruneSetAside() {
  const p = db.pendingEdits && db.pendingEdits.series;
  if (!p) return;
  const limit = Date.now() - SET_ASIDE_DAYS * 86400000;
  const entries = Object.entries(p).filter(([, e]) => e.setAsideAt);
  const old = entries.filter(([, e]) => Date.parse(e.setAsideAt) < limit);
  const over = entries.length - old.length - SET_ASIDE_MAX;
  const drop = old.concat(over > 0 ? entries.filter(x => !old.includes(x)).sort((a, b) => String(a[1].setAsideAt).localeCompare(String(b[1].setAsideAt))).slice(0, over) : []);
  for (const [id, e] of drop) {
    if (e.provider && e.provider.coverFile) try { require('./metadata').forgetSeries({ id, provider: e.provider }); } catch { /* gone */ }
    delete p[id];
  }
}
// The scanner, when it adds a work or a book: edits a backup had for it
function applyPending(kind, item) {
  const p = db.pendingEdits && db.pendingEdits[kind];
  if (!p || !p[item.id]) return false;
  if (kind === 'series') applySeriesEdit(item, p[item.id]); else if (p[item.id].overrides) item.overrides = clone(p[item.id].overrides);
  delete p[item.id];
  return true;
}

module.exports = { exportAll, importAll, summary, check, applyPending, setAside, SECTIONS, FORMAT, VERSION };
