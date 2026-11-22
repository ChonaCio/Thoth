#!/usr/bin/env node
// Records which commit this copy of the app was built from, so the version still shows after the
// .git folder is left behind (Docker image, /opt/thoth install).
//   node scripts/stamp-build.js [--out <file>]     (default: .build-info.json next to server.js)
// Run it from a git checkout. Without one it does nothing (and exits 0) so builds never fail on it.
const fs = require('fs');
const path = require('path');
const { readGitHead } = require('../updater');

const root = path.resolve(__dirname, '..');
const outArg = process.argv.indexOf('--out');
const out = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(root, '.build-info.json');

const head = readGitHead(root);
if (!head) {
  console.log('stamp-build: no git checkout found; version will be unknown until an update is installed.');
  process.exit(0);
}
const info = { commit: head.commit, branch: head.branch, builtAt: new Date().toISOString() };
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
console.log(`stamp-build: ${head.commit.slice(0, 7)}${head.branch ? ` (${head.branch})` : ''} -> ${path.relative(process.cwd(), out) || out}`);
