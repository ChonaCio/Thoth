// Chapter naming rules, shared by the file renamer (rename.js) and the external catalog's crawls (catalog/).
// No dependencies: the crawler processes load it without the library database.
//   chapter-1-chapter name.cbz → Chapter 1 - Chapter Name.cbz      (proposedName, for files)
//   "Ch. 044 - Ch. 44  Jan 4, 2025  1.2k views" → Chapter 44           (chapterTitle, for names read on sites)
const path = require('path');

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
  return { word: kind.word, number: cleanNumber(m[2]), name: m[3] ? cleanName(m[3], /\s/.test(base)) : '' };
}
// "001" → "1", "1x1" → "1.1", "01.50" → "1.50" (decimals kept as written)
function cleanNumber(n) {
  const parts = String(n).split(/[.x,]/i);
  parts[0] = String(parseInt(parts[0], 10));
  return parts.join('.');
}
// "the-end" → "the end"; "chapter name" stays. A file name without any space uses dashes (or underscores)
// as spaces; one that has spaces keeps its dashes ("Chapter 5 - Spider-Man", "Part 1 - Intro").
function cleanName(s, spaced) {
  s = s.replace(/^[\s._-]+/, '').replace(/_+/g, ' ');
  if (!spaced) return s.replace(/-+/g, ' ').trim();
  return s.replace(/\s+-\s+/g, ' - ').replace(/\s+/g, ' ').trim();
}
// Capitalize each word's first letter; the rest of the word is kept (acronyms, "McGee")
function titleCase(s) {
  return s.split(' ').map(w => (w ? w[0].toLocaleUpperCase() + w.slice(1) : w)).join(' ');
}
// The name a file should have, or null when it already does (capitalization aside: a change of case only is
// not proposed) or doesn't follow a known pattern
function proposedName(fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const p = parse(base);
  if (!p) return null;
  const name = p.name ? ' - ' + titleCase(p.name.replace(/^-\s*/, '')) : '';
  const next = `${p.word} ${p.number}${name}${ext}`;
  return next.toLowerCase() === fileName.toLowerCase() ? null : next;
}
// The name with another chapter number (the rest as proposedName would make it)
function nameWithNumber(fileName, number) {
  const ext = path.extname(fileName);
  const p = parse(fileName.slice(0, fileName.length - ext.length));
  if (!p) return null;
  return `${p.word} ${number}${p.name ? ' - ' + titleCase(p.name.replace(/^-\s*/, '')) : ''}${ext}`;
}

/* ---------------- names of chapters read on sites ---------------- */
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ene(?:ro)?|abr(?:il)?|ago(?:sto)?|dic(?:iembre)?';
// What sites show next to a chapter's name that isn't its name: dates, "3 days ago", views, likes, badges
const NOISE = [
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),          // Jan 4, 2025
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:de\\s+)?(?:${MONTHS})\\.?,?\\s+(?:de\\s+)?\\d{4}\\b`, 'gi'), // 4 Jan 2025
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/g,                         // 2025-01-04
  /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,                                                       // 04/01/2025
  /\b(?:\d+|an?|one)\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)\s+ago\b/gi, // 3 days ago, 6h ago
  /\bhace\s+\d+\s+\w+/gi, /\bil y a\s+\d+\s+\w+/gi, /\bvor\s+\d+\s+\w+/gi, /\b(?:yesterday|today|just now)\b/gi,
  /\b\d+(?:[.,]\d+)*\s*[kmb]?\s*(?:views?|reads?|likes?|comments?|vistas|lecturas|vues|aufrufe)\b/gi, // 1.2k views
  /(?:👁|❤|♥|★)\s*\d+(?:[.,]\d+)*\s*[kmb]?/g,
  // Labels of reading buttons and links shown with (or glued to) a chapter's name: "Start ReadingChapter 1"
  /(?:start|continue|begin|keep)\s*reading|\bread\s*(?:first|last|latest|now|more|online)(?=\b|chapter|episode|ch\b|ep\b|[A-Z])|\b(?:first|latest|last|newest|new)\s+(?:chapter|episode)\b(?!\s*\.?\s*\d)|\bcoming\s+soon\b|\bnow\s+free\b|\bfree\s+now\b|\bearly\s+access\b/gi,
  /\b(?:new|hot|free|locked|coins?|premium|up|updated|nuevo|neu|nouveau)\b\s*$/gi                 // badges at the end
];
// At the end of a name, when the chapter's number comes before it: an age without "ago" ("9 Months", "2 wks",
// "a month") or a date without a year ("Jan 4") — what the site shows of when the chapter was posted
const TRAILING_AGE = new RegExp(`(?:^|[\\s\\-–—|·,])((?:\\d+|an?|one)\\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?)\\s*$`, 'i');
function dropTrailingAge(s) {
  for (let i = 0; i < 3; i++) {
    const m = TRAILING_AGE.exec(s);
    if (!m) break;
    const before = s.slice(0, m.index + (m[0].length - m[1].length - (m[0].match(/\s*$/) || [''])[0].length));
    if (!/\d/.test(before)) break; // (the number left must be the chapter's: "3 Days" alone is a name)
    s = before.replace(/[\s\-–—|·,]+$/, '').trim();
  }
  return s;
}
const WORD = /(?<![a-z])(?:chapter|chap|ch|c|episode|ep|e|issue|iss|cap(?:[ií]tulo)?|chapitre|kapitel|#)\.?\s*(\d+(?:[.,x]\d+)?)(?![\d])/i;
const SEP = /^[\s:.,;|\-–—~·•()[\]]+|[\s:.,;|\-–—~·•([]+$/g;
const wordFor = s => (/^(?:episode|ep|e)\b/i.test(s) ? 'Episode' : /^(?:issue|iss)\b/i.test(s) ? 'Issue' : 'Chapter');
// The number at the start of a name, alone or with a chapter word: "44", "Ch. 44", "Chapter 044: …"
const leadingNumber = (s, n) => new RegExp(`^(?:(?:chapter|chap|ch|c|episode|ep|e|cap(?:[ií]tulo)?|#)\\.?\\s*)?0*${String(n).replace('.', '[.,x]')}(?![\\d.])`, 'i');

// A chapter's name as read on a site → { name: "Chapter 44 - The End", n: "44", v: "2" | null }.
//   "Chapter 44 - 44", "Chapter 44 - Ch. 44"          → Chapter 44
//   "Vol.2 Ch.15 - Escape  3 days ago"                → Chapter 15 - Escape (volume 2)
//   "Episode 7 · 12.3k views"                          → Episode 7
//   "The Beginning" (the site gave number 1)           → Chapter 1 - The Beginning
// A name without any number (and none given) is only cleaned.
function chapterTitle(raw, givenNumber) {
  // (a label glued to the chapter word gets its space back: "ReadingChapter 1" → "Reading Chapter 1")
  let s = String(raw || '').replace(/([a-z])(?=(?:Chapter|Episode|Ch\.|Ep\.)\s*\d)/g, '$1 ').replace(/\s+/g, ' ').trim();
  for (const re of NOISE) s = s.replace(re, ' ');
  s = dropTrailingAge(s.replace(/\s+/g, ' ').replace(SEP, '').trim());
  s = s.replace(SEP, '').trim();
  let v = null;
  const vol = /\b(?:volume|vol|v)\.?\s*(\d+)\b/i.exec(s);
  if (vol) { v = cleanNumber(vol[1]); s = (s.slice(0, vol.index) + ' ' + s.slice(vol.index + vol[0].length)).replace(/\s+/g, ' ').replace(SEP, '').trim(); }
  let word = 'Chapter', number = null, rest = s;
  const m = WORD.exec(s);
  if (m) {
    word = wordFor(m[0]); number = cleanNumber(m[1]);
    rest = s.slice(m.index + m[0].length); // (what came before the number, e.g. the work's title, is dropped)
  } else {
    const bare = /^0*(\d+(?:[.,]\d+)?)(?![\d])/.exec(s);
    if (bare) { number = cleanNumber(bare[1]); rest = s.slice(bare[0].length); }
    else if (givenNumber != null && givenNumber !== '' && /^\d+(?:\.\d+)?$/.test(String(givenNumber))) { number = cleanNumber(givenNumber); rest = s; }
  }
  if (number == null) return { name: titleCase(s) || String(raw || '').trim(), n: givenNumber != null ? String(givenNumber) : null, v };
  // The number said again ("44 - 44", "44 - Ch. 44"), then separators
  for (let i = 0; i < 3; i++) {
    rest = rest.replace(SEP, '');
    const again = leadingNumber(rest, number).exec(rest);
    if (!again) break;
    rest = rest.slice(again[0].length);
  }
  rest = rest.replace(SEP, '').replace(/\s+/g, ' ').trim();
  return { name: `${word} ${number}${rest ? ' - ' + titleCase(rest) : ''}`, n: number, v };
}

module.exports = { KINDS, parse, cleanNumber, cleanName, titleCase, proposedName, nameWithNumber, chapterTitle };
