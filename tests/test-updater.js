// Usage: node test-updater.js <path-to-scratch-copy-of-app>
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = path.resolve(process.argv[2]);

// Real tarball of main, fake release/tag listings
const realFetch = global.fetch;
const SHA = 'a'.repeat(40);
// The fake delta between v0.2.0 and p10
const DELTA_FILES = [
  { filename: 'js/app.js', status: 'modified' },
  { filename: 'library/new-thing.js', status: 'added' },
  { filename: 'old-file.txt', status: 'removed' },
  { filename: 'docs/renamed.md', status: 'renamed', previous_filename: 'docs/before.md' },
  { filename: 'data/users.json', status: 'modified' },   // protected: never touched
  { filename: '../outside.js', status: 'added' }          // unsafe path: ignored
];
const RAW = { 'js/app.js': '/* app from p10 */', 'library/new-thing.js': 'module.exports = 1;', 'docs/renamed.md': '# renamed' };
const RAW_FETCHES = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('/tarball/')) return realFetch(u.replace(/tarball\/[^/?]+/, 'tarball/main'), opts);
  if (u.includes('/releases')) return json(u.includes('page=1') ? [
    { tag_name: 'v0.2.0', name: 'v0.2.0', draft: false, prerelease: false, published_at: '2026-11-20T10:00:00Z', html_url: 'x' },
    { tag_name: 'v0.10.0', name: 'Big release', draft: false, html_url: 'x' },        // name doesn't match → excluded
    { tag_name: 'v0.0.9', name: 'v0.0.9', draft: false, html_url: 'x' },             // older than v0.1.0
    { tag_name: 'v9.9.9', name: 'v9.9.9', draft: true, html_url: 'x' }               // draft → excluded
  ] : []);
  if (u.includes('/tags')) return json(u.includes('page=1') ? [
    { name: 'p3', commit: { sha: SHA } }, { name: 'p10', commit: { sha: 'b'.repeat(40) } }, { name: 'v0.2.0', commit: { sha: SHA } },
    { name: 'p2', commit: { sha: 'c'.repeat(40) } }, { name: 'px', commit: { sha: 'd'.repeat(40) } }
  ] : []);
  if (u.includes('/commits/')) return json({ sha: SHA });
  if (u.includes('/compare/')) {
    // From v0.2.0 (aaa…) to p10 (bbb…): the files a delta install needs
    if (u.includes(`/compare/${SHA}...${'b'.repeat(40)}`)) return json({ status: 'ahead', ahead_by: 3, files: DELTA_FILES });
    return json({ status: 'behind', behind_by: 1 }); // other tags are newer/elsewhere
  }
  if (u.startsWith('https://raw.githubusercontent.com/')) {
    RAW_FETCHES.push(u);
    const rel = decodeURIComponent(u.split('/').slice(6).join('/'));
    return new Response(RAW[rel] || 'missing', { status: RAW[rel] ? 200 : 404 });
  }
  throw new Error('unexpected ' + u);
};

(async () => {
  const up = require(path.join(app, 'updater.js'));

  // version ordering: leftmost most important, numeric not lexical
  assert(up.compareRelease('v0.10.0', 'v0.9.9') > 0);
  assert(up.compareRelease('v1.0.0', 'v0.99.99') > 0);
  assert(up.compareRelease('v1.2.3', 'v1.2.3') === 0);
  assert(up.parsePush('p10') === 10 && up.parsePush('px') === null);

  const rel = await up.check('release');
  // Copy has no .git/build info → version unknown → every valid release is offered (draft + mis-titled excluded)
  assert.strictEqual(rel.current.commit, null, 'version unknown before first install');
  assert.deepStrictEqual(rel.newer.map(r => r.tag), ['v0.2.0', 'v0.0.9'], 'release filtering');
  const push = await up.check('push');
  assert.deepStrictEqual(push.newer.map(p => p.tag), ['p10', 'p3', 'p2'], 'push ordering');
  assert(push.newer.find(p => p.tag === 'p3').released === false);
  await assert.rejects(up.install('push', 'p99'), /not a valid/);
  await assert.rejects(up.check('nope'), /Unknown channel/);

  fs.writeFileSync(path.join(app, 'css', 'styles.css'), '/* locally modified */');
  const res = await up.install('release', 'v0.2.0');
  console.log('install result:', res);
  assert.strictEqual(res.current.release, 'v0.2.0');
  assert.strictEqual(res.current.push, 3, 'push filled from tag on same commit');
  assert(fs.readFileSync(path.join(app, 'css', 'styles.css'), 'utf8').length > 100, 'file replaced');
  assert(fs.readFileSync(path.join(app, res.backup, 'css', 'styles.css'), 'utf8').includes('locally modified'), 'backup kept');
  assert(!fs.readdirSync(path.join(app, '.updates')).some(d => d.startsWith('staging')), 'staging cleaned');

  const after = await up.check('release');
  assert.strictEqual(after.updateAvailable, false);
  const afterPush = await up.check('push');
  assert.deepStrictEqual(afterPush.newer.map(p => p.tag), ['p10']);
  assert.strictEqual(res.mode, 'full', 'first install (running commit unknown): whole version');
  console.log('  ✓ full install when the running commit is unknown');

  // ---- delta install: only what changed between the running commit (v0.2.0) and p10 ----
  fs.writeFileSync(path.join(app, 'old-file.txt'), 'removed by the update');
  fs.mkdirSync(path.join(app, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(app, 'docs', 'before.md'), '# before');
  const usersBefore = fs.existsSync(path.join(app, 'data', 'users.json'));
  const d = await up.install('push', 'p10');
  console.log('delta result:', Object.assign({}, d, { current: undefined }));
  assert.strictEqual(d.mode, 'delta');
  assert.strictEqual(RAW_FETCHES.length, 3, 'only the 3 changed files were downloaded (no tarball)');
  assert.strictEqual(fs.readFileSync(path.join(app, 'js', 'app.js'), 'utf8'), '/* app from p10 */', 'modified file written');
  assert(fs.existsSync(path.join(app, 'library', 'new-thing.js')), 'added file written');
  assert(!fs.existsSync(path.join(app, 'old-file.txt')) && fs.readFileSync(path.join(app, d.backup, 'old-file.txt'), 'utf8') === 'removed by the update', 'removed file deleted, kept in the backup');
  assert(!fs.existsSync(path.join(app, 'docs', 'before.md')) && fs.existsSync(path.join(app, 'docs', 'renamed.md')), 'renamed file moved');
  assert.strictEqual(fs.existsSync(path.join(app, 'data', 'users.json')), usersBefore, 'protected data/ untouched');
  assert(!fs.existsSync(path.join(app, '..', 'outside.js')), 'paths outside the app ignored');
  assert.strictEqual(d.restartRequired, true, 'a server file changed → restart');
  assert.strictEqual(d.files, 3); assert.strictEqual(d.removed, 2);
  assert.strictEqual(up.runningCommit().commit, 'b'.repeat(40), 'running commit recorded');
  console.log('  ✓ delta install: 3 files downloaded, removals and renames applied, protected paths untouched');

  // ---- forcing the whole version ----
  RAW_FETCHES.length = 0;
  const f = await up.install('push', 'p10', { full: true });
  assert.strictEqual(f.mode, 'full'); assert.strictEqual(RAW_FETCHES.length, 0);
  console.log('  ✓ { full: true } downloads the whole version');
  console.log('ALL TESTS PASSED');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
