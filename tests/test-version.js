// node test-version.js <app dir> — version resolution against a fake GitHub with a known history
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { execFileSync } = require('child_process');
const APP = path.resolve(process.argv[2]);

// History (oldest → newest) on main: c1 ← c2 ← c3 ← c4 ← c5 ← c6 ;  side branch: c1 ← x1
const sha = n => (n.repeat(40)).slice(0, 40);
const C = { c1: sha('1'), c2: sha('2'), c3: sha('3'), c4: sha('4'), c5: sha('5'), c6: sha('6'), x1: sha('e'), local: sha('f') };
const order = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const idx = s => order.findIndex(k => C[k] === s);
const TAGS = [
  { name: 'v0.1.0', commit: { sha: C.c1 } },
  { name: 'p1', commit: { sha: C.c1 } },
  { name: 'p2', commit: { sha: C.c3 } },
  { name: 'v0.2.0', commit: { sha: C.c3 } },
  { name: 'p3', commit: { sha: C.c5 } },
  { name: 'p4', commit: { sha: C.x1 } },        // other branch: never an ancestor of main
  { name: 'v0.10.0', commit: { sha: C.c6 } }    // release whose title doesn't match → ignored
];
const RELEASES = [
  { tag_name: 'v0.1.0', name: 'v0.1.0', draft: false },
  { tag_name: 'v0.2.0', name: 'v0.2.0', draft: false },
  { tag_name: 'v0.10.0', name: 'Big one', draft: false }
];
let calls = 0, offline = false;
global.fetch = async url => {
  calls++;
  if (offline) throw new Error('network down');
  const u = String(url);
  const json = b => new Response(JSON.stringify(b), { status: 200 });
  if (u.includes('/tags')) return json(u.includes('page=1') ? TAGS : []);
  if (u.includes('/releases')) return json(u.includes('page=1') ? RELEASES : []);
  const m = /compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)/.exec(u);
  if (m) {
    const [base, head] = [m[1], m[2]];
    if (head === C.local) return new Response('{}', { status: 404 });
    if (base === C.x1 || head === C.x1) return json({ status: base === head ? 'identical' : 'diverged' });
    const d = idx(head) - idx(base);
    return json(d === 0 ? { status: 'identical' } : d > 0 ? { status: 'ahead', ahead_by: d } : { status: 'behind', behind_by: -d });
  }
  throw new Error('unexpected ' + u);
};

let passed = 0;
function ok(c, name) { assert(c, name); passed++; console.log('  ✓', name); }

function makeApp({ git, gitPacked, detached, build, state }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-ver-'));
  fs.copyFileSync(path.join(APP, 'updater.js'), path.join(dir, 'updater.js'));
  fs.copyFileSync(path.join(APP, 'package.json'), path.join(dir, 'package.json'));
  if (git || gitPacked || detached) {
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    if (detached) fs.writeFileSync(path.join(dir, '.git', 'HEAD'), detached + '\n');
    else fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    if (git) fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), git + '\n');
    if (gitPacked) fs.writeFileSync(path.join(dir, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${gitPacked} refs/heads/main\n`);
  }
  if (build) fs.writeFileSync(path.join(dir, '.build-info.json'), JSON.stringify(build));
  if (state) fs.writeFileSync(path.join(dir, '.update-state.json'), JSON.stringify(state));
  return dir;
}
function load(dir) { delete require.cache[path.join(dir, 'updater.js')]; return require(path.join(dir, 'updater.js')); }
const label = v => `${v.release || '-'}${v.releaseAhead ? '+' + v.releaseAhead : ''} / ${v.push != null ? 'p' + v.push : '-'}${v.pushAhead ? '+' + v.pushAhead : ''}`;

(async () => {
  let u, v, d;

  d = makeApp({ git: C.c5 }); u = load(d); v = await u.resolveVersion();
  ok(label(v) === 'v0.2.0+2 / p3' && v.origin === 'git', `exactly on p3, 2 past v0.2.0 → ${label(v)}`);

  d = makeApp({ git: C.c6 }); u = load(d); v = await u.resolveVersion();
  ok(label(v) === 'v0.2.0+3 / p3+1', `1 commit past p3; v0.10.0 (bad title) ignored; p4 (other branch) skipped → ${label(v)}`);

  d = makeApp({ git: C.c2 }); u = load(d); v = await u.resolveVersion();
  ok(label(v) === 'v0.1.0+1 / p1+1', `older checkout picks older tags → ${label(v)}`);
  let r = await u.check('push');
  ok(r.newer.map(x => x.tag).join(',') === 'p4,p3,p2', 'check(push) offers the newer pushes');
  r = await u.check('release');
  ok(r.newer.map(x => x.tag).join(',') === 'v0.2.0', 'check(release) offers v0.2.0 (not the mis-titled v0.10.0)');

  d = makeApp({ gitPacked: C.c3 }); u = load(d); v = await u.resolveVersion();
  ok(label(v) === 'v0.2.0 / p2', `branch only in packed-refs → ${label(v)}`);

  d = makeApp({ detached: C.c1 }); u = load(d); v = await u.resolveVersion();
  ok(label(v) === 'v0.1.0 / p1' && v.branch === null, `detached HEAD → ${label(v)}`);

  d = makeApp({ build: { commit: C.c3, builtAt: '2026-11-01T00:00:00Z' } }); u = load(d); v = await u.resolveVersion();
  ok(label(v) === 'v0.2.0 / p2' && v.origin === 'build', 'container/server install uses .build-info.json');

  d = makeApp({ build: { commit: C.c3, builtAt: '2026-11-01T00:00:00Z' }, state: { commit: C.c5, tag: 'p3', push: 3, installedAt: '2026-11-10T00:00:00Z' } });
  u = load(d); v = await u.resolveVersion();
  ok(label(v) === 'v0.2.0+2 / p3' && v.origin === 'update', 'an update installed after the build wins');

  d = makeApp({ git: C.c3, state: { commit: C.c5, tag: 'p3', push: 3, installedAt: new Date(Date.now() + 60000).toISOString() } });
  u = load(d); v = await u.resolveVersion();
  ok(v.origin === 'update' && v.push === 3, 'update installed into a git checkout wins over the older git HEAD');
  const ref = path.join(d, '.git', 'refs', 'heads', 'main');
  fs.writeFileSync(ref, C.c6 + '\n');
  const later = new Date(Date.now() + 120000); fs.utimesSync(ref, later, later);
  v = await u.resolveVersion();
  ok(v.origin === 'git' && label(v) === 'v0.2.0+3 / p3+1', 'a later git pull wins again');

  d = makeApp({ git: C.local, state: { commit: C.c3, tag: 'p2', push: 2, installedAt: '2020-01-01T00:00:00Z' } });
  u = load(d); v = await u.resolveVersion();
  ok(v.published === false && v.commit === C.local, 'local commit not on GitHub is reported as unpublished');

  d = makeApp({}); u = load(d); v = await u.resolveVersion();
  ok(v.commit === null && v.release === null && v.push === null, 'no git, no build info → unknown (no fake v0.1.0)');

  d = makeApp({ git: C.c5 }); u = load(d);
  await u.resolveVersion();
  const before = calls;
  v = await u.resolveVersion();
  ok(calls === before && v.push === 3, 'second lookup is served from cache (no GitHub calls)');

  d = makeApp({ git: C.c6 }); u = load(d); offline = true;
  v = await u.resolveVersion();
  ok(v.error && v.commit === C.c6, 'GitHub unreachable → commit still shown, error flagged');
  offline = false;

  // stamp-build.js writes the commit from a checkout
  d = makeApp({ git: C.c4 });
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.copyFileSync(path.join(APP, 'scripts', 'stamp-build.js'), path.join(d, 'scripts', 'stamp-build.js'));
  execFileSync(process.execPath, [path.join(d, 'scripts', 'stamp-build.js')], { cwd: d });
  const info = JSON.parse(fs.readFileSync(path.join(d, '.build-info.json'), 'utf8'));
  ok(info.commit === C.c4 && info.branch === 'main', 'stamp-build.js records commit and branch');
  fs.rmSync(path.join(d, '.git'), { recursive: true });
  u = load(d); v = await u.resolveVersion();
  ok(v.origin === 'build' && label(v) === 'v0.2.0+1 / p2+1', `after .git is removed (as in Docker) → ${label(v)}`);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-nogit-'));
  fs.mkdirSync(path.join(empty, 'scripts'));
  fs.copyFileSync(path.join(APP, 'scripts', 'stamp-build.js'), path.join(empty, 'scripts', 'stamp-build.js'));
  fs.copyFileSync(path.join(APP, 'updater.js'), path.join(empty, 'updater.js'));
  fs.copyFileSync(path.join(APP, 'package.json'), path.join(empty, 'package.json'));
  execFileSync(process.execPath, [path.join(empty, 'scripts', 'stamp-build.js')], { cwd: empty });
  ok(!fs.existsSync(path.join(empty, '.build-info.json')), 'stamp-build.js without git exits cleanly (build never fails)');

  console.log(`\nALL ${passed} VERSION CHECKS PASSED`);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
