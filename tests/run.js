// Test runner: node tests/run.js [quick|all|<suite> ...]
//   quick (default): offline suites, about a minute
//   all: also the slow or online ones (processes ≈ 3 min and ~1 GB of temporary files; metadata, providers
//        and updater talk to the real metadata sites / GitHub)
// Every suite runs the server from this checkout with its own temporary data folder; suites that change
// app files (updater, processes) work on a temporary copy. Nothing in data/ is touched.
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const APP = path.resolve(__dirname, '..');
const SUITES = {
  i18n: { file: 'check-i18n.js', quick: true },        // every translation key exists in all languages
  auth: { file: 'test-auth.js', quick: true },         // first user, sign-in, sessions, roles, users API
  version: { file: 'test-version.js', quick: true },   // version from git / build info / installed update
  library: { file: 'test-library.js', quick: true },   // scanning, browsing, progress, collections, read lists
  versions: { file: 'test-versions.js', quick: true }, // "Work (Colored)" grouping, scan worker
  oneshots: { file: 'test-oneshots.js', quick: true }, // one-shot works
  supervisor: { file: 'test-supervisor.js', quick: true }, // built-in supervisor: restart, crash restart
  display: { file: 'test-display.js', quick: true },   // library/work defaults, filters & facets, scan progress
  folders: { file: 'test-folder-sources.js', quick: true }, // folder metadata sources (JSON files matched to books/works)
  scans: { file: 'test-scans.js', quick: true },       // quick/changes/full scans, saved scan index, default order
  works: { file: 'test-works.js', quick: true },       // chapter order, advanced search, hiding/deleting works
  processes: { file: 'test-processes.js' },            // scan pool, server settings, restarts (slow, big temp files)
  metadata: { file: 'test-metadata.js' },              // online metadata end to end (network)
  providers: { file: 'test-providers-live.js' },       // each metadata site answers (network)
  updater: { file: 'test-updater.js', copy: true }     // installing an update (downloads from GitHub)
};

const args = process.argv.slice(2);
// "quick" and "all" expand to their suites; names can be combined ("quick metadata")
const names = [...new Set((args.length ? args : ['quick']).flatMap(a =>
  a === 'quick' ? Object.keys(SUITES).filter(n => SUITES[n].quick) : a === 'all' ? Object.keys(SUITES) : [a]))];
for (const n of names) if (!SUITES[n]) { console.error(`Unknown suite "${n}". Suites: ${Object.keys(SUITES).join(', ')}`); process.exit(2); }

// A copy of the app without data, git, media or installed-update records
function appCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-app-'));
  fs.cpSync(APP, dir, { recursive: true, filter: p => !/[\\/](\.git|\.updates|data|node_modules|media|\.claude|\.update-state\.json|\.build-info\.json)([\\/]|$)/.test(p.slice(APP.length)) });
  return dir;
}

const results = [];
for (const n of names) {
  const s = SUITES[n];
  const target = s.copy ? appCopy() : APP;
  console.log(`\n=== ${n} (${s.file}) ===`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, s.file), target], { stdio: 'inherit' });
  results.push({ n, ok: r.status === 0, s: ((Date.now() - t0) / 1000).toFixed(0) });
}
console.log('\n' + results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.n} (${r.s} s)`).join('\n'));
process.exit(results.every(r => r.ok) ? 0 : 1);
