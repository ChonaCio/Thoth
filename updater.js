// Update checker/installer backed by GitHub tags and releases. No dependencies.
//
//  Channel "release": GitHub releases (not drafts) whose tag AND name match vX.Y.Z
//  Channel "push":    any tag matching pN (released or not), N = incrementing integer
//
// Installing is a delta when possible: only the files that differ between the running commit and the
// update are downloaded (and files the update deletes are removed). Otherwise the tag's whole source
// tarball is downloaded and only files that differ are copied. Replaced/removed files are backed up to
// .updates/backup-<timestamp>/.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REPO = process.env.THOTH_UPDATE_REPO || (PKG.thoth && PKG.thoth.updateRepo) || 'ChonaCio/Thoth';
const STATE_FILE = path.join(ROOT, '.update-state.json');
const WORK_DIR = path.join(ROOT, '.updates');
// Never overwritten by an update (local config, data, history)
const PROTECTED = new Set(['.git', 'node_modules', '.updates', '.update-state.json', '.build-info.json', '.claude', '.env', 'data']);

const RELEASE_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const PUSH_RE = /^p(\d+)$/;

let installing = false;

/* ---------------- versions ---------------- */
function parseRelease(s) {
  const m = RELEASE_RE.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareRelease(a, b) {
  const x = parseRelease(a), y = parseRelease(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function parsePush(s) {
  const m = PUSH_RE.exec(String(s || '').trim());
  return m ? Number(m[1]) : null;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/* ---------------- which commit is running? ----------------
 * Up to three sources; the most recently changed one wins:
 *   git    a .git folder: HEAD read directly (no git binary needed), dated by when the branch last moved
 *   update .update-state.json, written when an update is installed from the Updates page
 *   build  .build-info.json, written by scripts/stamp-build.js (Docker build, deploy/install.sh)
 * So `git pull` after an update makes git win again, and installing an update in a checkout wins over git.
 */
const SHA_RE = /^[0-9a-f]{40}$/;
const BUILD_FILE = path.join(ROOT, '.build-info.json');

function readGitHead(root = ROOT) {
  try {
    let dir = path.join(root, '.git');
    if (fs.statSync(dir).isFile()) { // worktree/submodule: ".git" file pointing elsewhere
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dir, 'utf8'));
      if (!m) return null;
      dir = path.resolve(root, m[1].trim());
    }
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    if (SHA_RE.test(head)) { // detached HEAD
      let at = null;
      try { at = fs.statSync(path.join(dir, 'HEAD')).mtime.toISOString(); } catch { /* ignore */ }
      return { commit: head, branch: null, at };
    }
    const ref = (/^ref:\s*(.+)$/.exec(head) || [])[1];
    if (!ref) return null;
    const branch = ref.replace(/^refs\/heads\//, '');
    // When the branch last moved (commit, pull, checkout): ref file or packed-refs modification time
    const movedAt = file => { try { return fs.statSync(file).mtime.toISOString(); } catch { return null; } };
    // Linked worktrees keep shared refs in the "commondir"
    let common = dir;
    try { common = path.resolve(dir, fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim()); } catch { /* not a worktree */ }
    for (const base of [dir, common]) {
      try {
        const sha = fs.readFileSync(path.join(base, ref), 'utf8').trim();
        if (SHA_RE.test(sha)) return { commit: sha, branch, at: movedAt(path.join(base, ref)) };
      } catch { /* not a loose ref */ }
      try {
        for (const line of fs.readFileSync(path.join(base, 'packed-refs'), 'utf8').split('\n')) {
          const [sha, name] = line.trim().split(' ');
          if (name === ref && SHA_RE.test(sha)) return { commit: sha, branch, at: movedAt(path.join(base, 'packed-refs')) };
        }
      } catch { /* no packed-refs */ }
    }
  } catch { /* no .git */ }
  return null;
}

function runningCommit() {
  const git = readGitHead();
  const state = readJson(STATE_FILE, {});
  const build = readJson(BUILD_FILE, {});
  const sources = [
    git && { commit: git.commit, branch: git.branch, origin: 'git', at: git.at },
    SHA_RE.test(state.commit || '') && { commit: state.commit, branch: null, origin: 'update', at: state.installedAt },
    SHA_RE.test(build.commit || '') && { commit: build.commit, branch: build.branch || null, origin: 'build', at: build.builtAt }
  ].filter(Boolean);
  if (!sources.length) return { commit: null, branch: null, origin: null, at: null };
  const time = s => Date.parse(s.at || 0) || 0;
  return sources.reduce((best, s) => (time(s) > time(best) ? s : best));
}

/* ---------------- GitHub ---------------- */
async function gh(apiPath, { allow404 = false } = {}) {
  const headers = { 'User-Agent': 'thoth-updater', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${apiPath}`, { headers });
  if (res.status === 403 || res.status === 429) {
    throw httpError(503, 'rateLimited', 'GitHub rate limit reached. Try again later or set GITHUB_TOKEN.');
  }
  if (res.status === 404) {
    if (allow404) return null;
    throw httpError(502, 'repoNotFound', `Repository ${REPO} not found.`);
  }
  if (!res.ok) throw httpError(502, 'githubError', `GitHub responded ${res.status}.`);
  return res.json();
}

// Tags + releases, fetched together and reused for 60 s (a check and a version lookup share one fetch)
let repoMemo = null;
async function repoInfo() {
  if (repoMemo && Date.now() - repoMemo.at < 60 * 1000) return repoMemo.data;
  const [tags, releases] = await Promise.all([ghAll(`/repos/${REPO}/tags`), ghAll(`/repos/${REPO}/releases`)]);
  repoMemo = { at: Date.now(), data: { tags, releases } };
  return repoMemo.data;
}

/* ---------------- naming the running commit ----------------
 * The running release = the highest vX.Y.Z release whose commit is the running commit or one of its
 * ancestors; same for pN tags. "ahead" = how many commits the running code is past that tag.
 */
const CACHE_FILE = path.join(WORK_DIR, 'version-cache.json');
const CACHE_TTL = 10 * 60 * 1000;
const MAX_COMPARES = 25;

// Is `tagSha` the running commit or an ancestor of it? Returns commits ahead, or -1 if not.
async function aheadOf(tagSha, headSha) {
  if (tagSha === headSha) return 0;
  const cmp = await gh(`/repos/${REPO}/compare/${tagSha}...${headSha}`, { allow404: true });
  if (!cmp) throw httpError(404, 'commitNotPublished', 'The running commit is not on GitHub.');
  if (cmp.status === 'identical') return 0;
  if (cmp.status === 'ahead') return cmp.ahead_by;
  return -1; // "behind" (tag is newer) or "diverged" (other branch)
}

async function nearestTag(candidates, headSha) {
  // candidates: [{ tag, commit }] sorted newest first
  const exact = candidates.find(c => c.commit === headSha);
  let compares = 0;
  for (const c of candidates) {
    if (exact && c === exact) return { tag: c.tag, ahead: 0 };
    if (!c.commit) continue;
    if (++compares > MAX_COMPARES) break;
    const ahead = await aheadOf(c.commit, headSha);
    if (ahead >= 0) return { tag: c.tag, ahead };
  }
  return exact ? { tag: exact.tag, ahead: 0 } : null;
}

async function resolveVersion({ force = false } = {}) {
  const run = runningCommit();
  const state = readJson(STATE_FILE, {});
  const base = {
    repo: REPO,
    commit: run.commit,
    branch: run.branch || null,
    origin: run.origin,            // 'git' | 'update' | 'build' | null
    installedAt: run.origin === 'update' ? state.installedAt || null : null,
    release: null, releaseAhead: null,
    push: null, pushAhead: null,
    published: null,               // false = running commit isn't on GitHub
    resolved: false
  };
  // Fallback when the commit is unknown or can't be looked up: what the last install recorded
  const fallback = extra => Object.assign(base, {
    release: run.origin === 'update' ? state.release || null : null,
    push: run.origin === 'update' && state.push != null ? state.push : null
  }, extra);

  if (!run.commit) return fallback({});

  const cache = readJson(CACHE_FILE, {});
  const hit = cache[run.commit];
  if (hit && !force && Date.now() - hit.resolvedAt < CACHE_TTL) return Object.assign(base, hit.version, { resolved: true });

  try {
    const { tags, releases } = await repoInfo();
    const tagSha = new Map(tags.map(t => [t.name, t.commit && t.commit.sha]));
    const releaseCands = releases
      .filter(r => !r.draft && parseRelease(r.tag_name) && r.tag_name.trim() === String(r.name || '').trim())
      .map(r => ({ tag: r.tag_name, commit: tagSha.get(r.tag_name) }))
      .sort((a, b) => compareRelease(b.tag, a.tag));
    const pushCands = tags
      .filter(t => parsePush(t.name) != null)
      .map(t => ({ tag: t.name, commit: t.commit && t.commit.sha }))
      .sort((a, b) => parsePush(b.tag) - parsePush(a.tag));

    const rel = await nearestTag(releaseCands, run.commit);
    const push = await nearestTag(pushCands, run.commit);
    const version = {
      release: rel ? rel.tag : null, releaseAhead: rel ? rel.ahead : null,
      push: push ? parsePush(push.tag) : null, pushAhead: push ? push.ahead : null,
      published: true
    };
    cache[run.commit] = { resolvedAt: Date.now(), version };
    try { fs.mkdirSync(WORK_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch { /* read-only is fine */ }
    return Object.assign(base, version, { resolved: true });
  } catch (e) {
    if (e.code === 'commitNotPublished') return fallback({ published: false });
    if (hit) return Object.assign(base, hit.version, { resolved: true, stale: true });
    return fallback({ error: e.code || 'githubError' });
  }
}

async function ghAll(apiPath) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const sep = apiPath.includes('?') ? '&' : '?';
    const batch = await gh(`${apiPath}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function listReleases() {
  const { releases } = await repoInfo();
  return releases
    .filter(r => !r.draft && parseRelease(r.tag_name) && parseRelease(r.name) && r.tag_name.trim() === r.name.trim())
    .map(r => ({
      tag: r.tag_name,
      name: r.name,
      date: r.published_at || r.created_at,
      prerelease: r.prerelease,
      notes: r.body || '',
      url: r.html_url
    }))
    .sort((a, b) => compareRelease(b.tag, a.tag));
}

async function listPushes() {
  const { tags, releases } = await repoInfo();
  const released = new Set(releases.filter(r => !r.draft).map(r => r.tag_name));
  return tags
    .filter(t => parsePush(t.name) != null)
    .map(t => ({
      tag: t.name,
      name: t.name,
      number: parsePush(t.name),
      commit: t.commit && t.commit.sha,
      released: released.has(t.name),
      url: `https://github.com/${REPO}/tree/${encodeURIComponent(t.name)}`
    }))
    .sort((a, b) => b.number - a.number);
}

async function check(channel) {
  if (channel !== 'release' && channel !== 'push') throw httpError(400, 'badChannel', 'Unknown channel.');
  repoMemo = null; // always look at the repository fresh when someone clicks "Check"
  const current = await resolveVersion({ force: true });
  let items, newer;
  if (channel === 'release') {
    items = await listReleases();
    newer = items.filter(r => compareRelease(r.tag, current.release) > 0);
  } else if (channel === 'push') {
    items = await listPushes();
    newer = items.filter(p => current.push == null || p.number > current.push);
  } else {
    throw httpError(400, 'badChannel', 'Unknown channel.');
  }
  return {
    channel,
    current,
    latest: items[0] || null,
    updateAvailable: newer.length > 0,
    newer: newer.slice(0, 20),
    checkedAt: new Date().toISOString()
  };
}

/* ---------------- tar.gz extraction ---------------- */
function cstr(buf, start, len) {
  const s = buf.toString('utf8', start, start + len);
  const nul = s.indexOf('\0');
  return nul === -1 ? s : s.slice(0, nul);
}
function parsePax(data) {
  const out = {};
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const len = parseInt(data.toString('utf8', off, sp), 10);
    if (!len) break;
    const rec = data.toString('utf8', sp + 1, off + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

// Extracts a tarball into `dest`, stripping the top-level folder GitHub adds.
function extractTarGz(gz, dest) {
  const buf = zlib.gunzipSync(gz);
  const root = path.resolve(dest);
  let off = 0, paxPath = null, longName = null, files = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const name = cstr(h, 0, 100);
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = h.toString('utf8', 257, 262) === 'ustar' ? cstr(h, 345, 155) : '';
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    if (type === 'x') { paxPath = parsePax(data).path || null; continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = cstr(data, 0, size); continue; }

    const full = paxPath || longName || (prefix ? `${prefix}/${name}` : name);
    paxPath = longName = null;
    const rel = full.split('/').slice(1).join('/');
    if (!rel) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error(`Unsafe path in archive: ${full}`);

    if (type === '5') fs.mkdirSync(target, { recursive: true });
    else if (type === '0' || type === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      files++;
    }
    // symlinks, hardlinks, devices: ignored on purpose
  }
  return files;
}

/* ---------------- install ---------------- */
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (PROTECTED.has(rel.split(path.sep)[0])) continue;
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Code the running server has loaded: changing it only takes effect after a restart.
// (index.html, css/ and js/ are sent to browsers fresh on every load; deploy/ and scripts/ aren't loaded.)
const BROWSER_OR_TOOLING = new Set(['js', 'css', 'deploy', 'scripts', 'tests']);
function isServerCode(rel) {
  const parts = rel.split(/[\\/]/);
  if (parts.length > 1 && BROWSER_OR_TOOLING.has(parts[0])) return false;
  return /\.(js|cjs|mjs|json)$/i.test(rel);
}

// Fingerprint of the server code on disk (names, sizes, modification times)
function serverCodeFingerprint() {
  const out = [];
  const visit = dir => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = dir ? path.join(dir, e.name) : e.name;
      if (e.isDirectory()) {
        if (!dir && (BROWSER_OR_TOOLING.has(e.name) || PROTECTED.has(e.name) || e.name.startsWith('.') || e.name === 'media')) continue;
        visit(rel);
      } else if (isServerCode(rel)) {
        try { const st = fs.statSync(path.join(ROOT, rel)); out.push(`${rel}:${st.size}:${st.mtimeMs}`); } catch { /* vanished */ }
      }
    }
  };
  visit('');
  return out.sort().join('|');
}

/* Delta install: ask GitHub which files differ between the running commit and the update, download only
 * those (raw files) and delete the ones the update removed. Returns null when it can't be done (unknown
 * running commit, too many changes for GitHub's list, a download fails before anything was changed) so the
 * caller falls back to the full tarball. Nothing is written until every file has been downloaded. */
const MAX_DELTA_FILES = 299; // GitHub's compare lists at most 300 files
function safeRel(rel) {
  if (!rel || path.isAbsolute(rel) || rel.split('/').some(p => p === '..' || p === '')) return false;
  const first = rel.split('/')[0];
  return !PROTECTED.has(first) && !first.startsWith('.git');
}
async function rawFile(commit, rel) {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { headers: Object.assign({ 'User-Agent': 'thoth-updater' }, process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) });
  if (!res.ok) throw new Error(`${rel}: download answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function installDelta(base, head, backup) {
  const cmp = await gh(`/repos/${REPO}/compare/${base}...${head}`, { allow404: true });
  if (!cmp || !Array.isArray(cmp.files) || cmp.files.length > MAX_DELTA_FILES) return null;
  const writes = [], removes = [];
  for (const f of cmp.files) {
    if (!safeRel(f.filename)) continue;
    if (f.status === 'removed') removes.push(f.filename);
    else {
      writes.push(f.filename);
      if (f.status === 'renamed' && safeRel(f.previous_filename || '')) removes.push(f.previous_filename);
    }
  }
  // Download everything first
  const contents = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, writes.length) }, async () => {
    while (next < writes.length) { const rel = writes[next++]; contents.set(rel, await rawFile(head, rel)); }
  }));
  // Then apply, backing up what's replaced or removed
  let changed = 0, removed = 0, serverChanged = false;
  const keep = (rel, buf) => { const b = path.join(backup, rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.writeFileSync(b, buf); };
  for (const rel of writes) {
    const dst = path.join(ROOT, rel), buf = contents.get(rel);
    if (fs.existsSync(dst)) {
      const before = fs.readFileSync(dst);
      if (before.equals(buf)) continue;
      keep(rel, before);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    changed++;
    if (isServerCode(rel)) serverChanged = true;
  }
  for (const rel of removes) {
    const dst = path.join(ROOT, rel);
    if (!fs.existsSync(dst) || writes.includes(rel)) continue;
    keep(rel, fs.readFileSync(dst));
    fs.rmSync(dst, { force: true });
    removed++;
    if (isServerCode(rel)) serverChanged = true;
  }
  return { mode: 'delta', changed, removed, downloaded: writes.length, serverChanged };
}

// The commit a tag points to
async function tagCommit(tag) {
  const { tags } = await repoInfo();
  const tagged = tags.find(t => t.name === tag);
  let commit = tagged && tagged.commit && tagged.commit.sha;
  if (!SHA_RE.test(commit || '')) commit = ((await gh(`/repos/${REPO}/commits/${encodeURIComponent(tag)}`).catch(() => null)) || {}).sha || null;
  return SHA_RE.test(commit || '') ? commit : null;
}

// full: download and compare every file (the whole tarball) even when a delta install is possible
async function install(channel, tag, { full = false } = {}) {
  if (installing) throw httpError(409, 'busy', 'An update is already being installed.');
  installing = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = path.join(WORK_DIR, `staging-${stamp}`);
  const backup = path.join(WORK_DIR, `backup-${stamp}`);
  try {
    // Only install tags the channel actually offers
    const items = channel === 'release' ? await listReleases() : channel === 'push' ? await listPushes() : null;
    if (!items) throw httpError(400, 'badChannel', 'Unknown channel.');
    const item = items.find(i => i.tag === tag);
    if (!item) throw httpError(404, 'tagNotFound', `${tag} is not a valid ${channel}.`);
    const commit = await tagCommit(tag);

    // Delta first, when the running commit is known
    const running = runningCommit().commit;
    let delta = null;
    if (!full && running && commit) {
      try { delta = await installDelta(running, commit, backup); } catch (e) { console.warn(`[updates] delta install not possible (${e.message}); downloading the whole version`); delta = null; }
    }
    if (delta) {
      const next = { channel, tag, commit, release: channel === 'release' ? tag : null, push: channel === 'push' ? parsePush(tag) : null, installedAt: new Date().toISOString(), mode: 'delta' };
      fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
      console.log(`[updates] installed ${tag} as a delta: ${delta.changed} files changed, ${delta.removed} removed (${delta.downloaded} downloaded)`);
      return { installed: tag, channel, mode: 'delta', files: delta.changed, removed: delta.removed, downloaded: delta.downloaded,
        backup: fs.existsSync(backup) ? path.relative(ROOT, backup) : null, restartRequired: delta.serverChanged, current: await resolveVersion() };
    }

    const res = await fetch(`https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(tag)}`, {
      headers: Object.assign({ 'User-Agent': 'thoth-updater' },
        process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    });
    if (!res.ok) throw httpError(502, 'downloadFailed', `Download failed (${res.status}).`);
    const gz = Buffer.from(await res.arrayBuffer());

    fs.mkdirSync(staging, { recursive: true });
    const count = extractTarGz(gz, staging);
    const incoming = walk(staging);
    if (!count || !incoming.includes('index.html')) {
      throw httpError(422, 'invalidPackage', 'The downloaded version does not look like a Thoth app (no index.html).');
    }

    // Back up every file the update will replace (identical files are left alone)
    let serverChanged = false, changed = 0;
    for (const rel of incoming) {
      const dst = path.join(ROOT, rel);
      const src = path.join(staging, rel);
      if (fs.existsSync(dst)) {
        const before = fs.readFileSync(dst);
        const after = fs.readFileSync(src);
        if (before.equals(after)) continue;
        if (isServerCode(rel)) serverChanged = true;
        fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
        fs.writeFileSync(path.join(backup, rel), before);
      } else if (isServerCode(rel)) {
        serverChanged = true;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      changed++;
    }

    // Record the installed commit; the release/push names are worked out from it (see resolveVersion)
    const next = {
      mode: 'full',
      channel, tag, commit,
      // Hints used only if GitHub can't be reached later
      release: channel === 'release' ? tag : null,
      push: channel === 'push' ? parsePush(tag) : null,
      installedAt: new Date().toISOString()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));

    return { installed: tag, channel, mode: 'full', files: changed, total: incoming.length, removed: 0,
      backup: fs.existsSync(backup) ? path.relative(ROOT, backup) : null, restartRequired: serverChanged, current: await resolveVersion() };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    installing = false;
  }
}

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

module.exports = { resolveVersion, runningCommit, readGitHead, check, install, extractTarGz, compareRelease, parsePush, isServerCode, serverCodeFingerprint, REPO };
