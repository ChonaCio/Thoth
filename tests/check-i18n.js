// node check-i18n.js <app dir> — keys used in code but missing from translations, and per-language gaps
const fs = require('fs'), path = require('path');
const APP = path.resolve(process.argv[2]);
global.window = {};
require(path.join(APP, 'js/i18n.js'));
if (fs.existsSync(path.join(APP, 'js/i18n-library.js'))) require(path.join(APP, 'js/i18n-library.js'));
const T = window.TRANSLATIONS;
const have = new Set(Object.keys(T.en));
const keys = new Set();
for (const f of ['js/library.js', 'js/reader.js', 'js/app.js', 'index.html']) {
  const src = fs.readFileSync(path.join(APP, f), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-title|-placeholder)?="([a-zA-Z0-9_.]+)"/g)) keys.add(m[1]);
  for (const m of src.matchAll(/'((?:lib|home|series|book|coll|rl|manage|reader|edit|search|author|nav|users|err|common)\.[a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
}
// keys built dynamically
['ongoing', 'ended', 'hiatus', 'abandoned', 'unknown'].forEach(s => keys.add('series.status.' + s));
['ltr', 'rtl', 'vertical'].forEach(s => keys.add('series.direction.' + s));
['writer', 'penciller', 'inker', 'colorist', 'letterer', 'coverartist', 'editor'].forEach(s => keys.add('author.' + s));
['folderNotFound', 'folderNoAccess', 'folderInUse', 'folderNotAllowed', 'folderRequired', 'nameRequired', 'invalidDate', 'fileMissing', 'notAnImageBook', 'pageNotFound', 'invalid'].forEach(s => keys.add('err.' + s));
const missing = [...keys].filter(k => !have.has(k) && !/\.$/.test(k)).sort();
console.log(`${keys.size} keys used; ${missing.length} missing in en${missing.length ? ':\n  ' + missing.join('\n  ') : ''}`);
for (const l of Object.keys(T)) {
  const gap = Object.keys(T.en).filter(k => !(k in T[l]));
  console.log(`${l}: ${Object.keys(T[l]).length} keys${gap.length ? ', MISSING ' + gap.length + ': ' + gap.slice(0, 15).join(', ') : ', complete'}`);
}
process.exit(missing.length ? 1 : 0);
