// Update checker/installer backed by GitHub tags and releases. No dependencies.
//
//  Channel "release": GitHub releases (not drafts) whose tag AND name match vX.Y.Z
//  Channel "push":    any tag matching pN (released or not), N = incrementing integer
//
// Installing downloads the tag's source tarball, backs up the current files to
// .updates/backup-<timestamp>/, then copies the new files over the app folder.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REPO = process.env.THOTH_UPDATE_REPO || (PKG.thoth && PKG.thoth.updateRepo) || 'ChonaCio/Thoth';
const STATE_FILE = path.join(ROOT, '.update-state.json');
const WORK_DIR = path.join(ROOT, '.updates');
// Never overwritten by an update (local config, data, history)
const PROTECTED = new Set(['.git', 'node_modules', '.updates', '.update-state.json', '.claude', '.env']);

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

function currentVersion() {
  const shipped = readJson(path.join(ROOT, 'version.json'), {});
  const state = readJson(STATE_FILE, {});
  return {
    release: state.release || shipped.release || null,
    push: state.push != null ? state.push : (shipped.push != null ? shipped.push : null),
    commit: state.commit || null,
    channel: state.channel || null,
    installedAt: state.installedAt || null,
    repo: REPO
  };
}

/* ---------------- GitHub ---------------- */
async function gh(apiPath) {
  const headers = { 'User-Agent': 'thoth-updater', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${apiPath}`, { headers });
  if (res.status === 403 || res.status === 429) {
    throw httpError(503, 'rateLimited', 'GitHub rate limit reached. Try again later or set GITHUB_TOKEN.');
  }
  if (res.status === 404) throw httpError(502, 'repoNotFound', `Repository ${REPO} not found.`);
  if (!res.ok) throw httpError(502, 'githubError', `GitHub responded ${res.status}.`);
  return res.json();
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
  const releases = await ghAll(`/repos/${REPO}/releases`);
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
  const [tags, releases] = await Promise.all([
    ghAll(`/repos/${REPO}/tags`),
    ghAll(`/repos/${REPO}/releases`).catch(() => [])
  ]);
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
  const current = currentVersion();
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

async function install(channel, tag) {
  if (installing) throw httpError(409, 'busy', 'An update is already being installed.');
  installing = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = path.join(WORK_DIR, `staging-${stamp}`);
  try {
    // Only install tags the channel actually offers
    const items = channel === 'release' ? await listReleases() : channel === 'push' ? await listPushes() : null;
    if (!items) throw httpError(400, 'badChannel', 'Unknown channel.');
    const item = items.find(i => i.tag === tag);
    if (!item) throw httpError(404, 'tagNotFound', `${tag} is not a valid ${channel}.`);

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

    // Back up every file the update will replace
    const backup = path.join(WORK_DIR, `backup-${stamp}`);
    let serverChanged = false;
    for (const rel of incoming) {
      const dst = path.join(ROOT, rel);
      const src = path.join(staging, rel);
      if (fs.existsSync(dst)) {
        const before = fs.readFileSync(dst);
        const after = fs.readFileSync(src);
        if (before.equals(after)) continue;
        if (rel === 'server.js' || rel === 'updater.js' || rel === 'package.json') serverChanged = true;
        fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
        fs.writeFileSync(path.join(backup, rel), before);
      } else if (rel === 'server.js' || rel === 'updater.js') {
        serverChanged = true;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }

    // Record what is installed. Fill in the other channel's version if a tag shares this commit.
    const prev = currentVersion();
    const next = { release: prev.release, push: prev.push, channel, tag, installedAt: new Date().toISOString() };
    if (channel === 'release') {
      next.release = tag;
      const pushes = await listPushes().catch(() => []);
      const commit = (await gh(`/repos/${REPO}/commits/${encodeURIComponent(tag)}`).catch(() => ({}))).sha;
      next.commit = commit || null;
      const same = pushes.find(p => p.commit && p.commit === commit);
      if (same) next.push = same.number;
    } else {
      next.push = item.number;
      next.commit = item.commit || null;
      const rel = (await listReleases().catch(() => [])).find(r => r.tag === tag);
      if (rel) next.release = rel.tag;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));

    return { installed: tag, channel, files: incoming.length, backup: path.relative(ROOT, backup), restartRequired: serverChanged, current: currentVersion() };
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

module.exports = { currentVersion, check, install, extractTarGz, compareRelease, parsePush, REPO };
