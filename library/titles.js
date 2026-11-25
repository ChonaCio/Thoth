// Which title to show when there are several: English first.
//   - Titles tagged with their language (MangaDex, Kitsu…): an English one ("en", "en-us", "en_jp" is romaji, not English).
//   - Untagged titles (crawled sites, merged works): the one that reads most like English — Latin letters,
//     common English words — over romanized Japanese ("… no …", "Shingeki no Kyojin") and other scripts.
// No dependencies (the crawler processes load it).
const NON_LATIN = /[Ͱ-ϿЀ-ӿ֐-ۿऀ-෿฀-๿ᄀ-ᇿ぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
const ENGLISH_WORDS = /\b(the|of|and|a|an|to|in|my|is|are|was|with|for|on|from|your|you|i|me|who|how|what|when|after|before|world|love|life|king|queen|girl|boy|hero|story|tale|days|life|lord|son|daughter|god|dragon|death|night|time|return|reborn|level|tower|academy|villain|duke|princess|prince)\b/i;
const ROMAJI = /\b(no|wa|ga|wo|ni|de|mo|desu|shi|kun|san|chan|sama|sensei|senpai|tachi|naru|suru|kara|made|ore|boku|watashi|kimi|sekai|tensei|isekai|monogatari|seikatsu|yuusha|maou|kyojin|shingeki)\b|[āēīōū]|ou\b|uu/i;

// How much a title reads like English (higher is better)
function englishScore(t) {
  t = String(t || '').trim();
  if (!t) return -10;
  if (NON_LATIN.test(t)) return -5;
  let s = 0;
  if (/^[\x20-\x7e‘’“”–—…]+$/.test(t)) s += 2;
  if (ENGLISH_WORDS.test(t)) s += 2;
  if (ROMAJI.test(t)) s -= 3;
  return s;
}
const isEnglishTag = lang => /^en([-_](?!jp)[a-z]+)?$/i.test(String(lang || ''));

// From titles tagged by language — [{ lang, title }] or MangaDex-style [{ en: '…' }, { 'ja-ro': '…' }] — the English
// one, else null
function taggedEnglish(list) {
  for (const x of list || []) {
    if (!x) continue;
    if (x.lang && x.title) { if (isEnglishTag(x.lang)) return x.title; continue; }
    for (const [lang, title] of Object.entries(x)) if (isEnglishTag(lang) && title) return title;
  }
  return null;
}
// Words of other Latin-script languages that English titles don't use ("El Rey Demonio", "Le Roi des Démons")
const FOREIGN_WORDS = /\b(el|los|las|del|una?|une|les|du|des|aux|der|das|und|ein|eine|mit|dos|das|uma|com|nas|nos|il|della|dei)\b/i;
// A title that already reads as English: Latin letters only, no romanized Japanese, no other language's words
const looksEnglish = t => englishScore(t) >= 2 && !ROMAJI.test(String(t)) && !FOREIGN_WORDS.test(String(t));
// The best of several untagged titles: English-looking first, then the order given (the first is the default).
// A first title that is already English stays, even when another one scores higher ("Jujutsu Kaisen" isn't
// replaced by "Sorcery Fight")
function preferEnglish(titles) {
  const list = (titles || []).filter(t => t && String(t).trim());
  if (!list.length) return '';
  if (looksEnglish(list[0])) return list[0];
  let best = list[0], bestScore = englishScore(best);
  for (const t of list.slice(1)) { const s = englishScore(t); if (s > bestScore + 1) { best = t; bestScore = s; } } // (clearly better only)
  return best;
}

/* ---------------- what isn't part of a title: noise and version markers ----------------
 * "Solo Leveling (Official) - engsub"            → Solo Leveling
 * "Tower of God - Fake Scans"  (the source's name) → Tower of God
 * "One Piece [AI ANIMATION]"                       → One Piece, version animated
 * "Berserk (Raw) Uncensored", "Berserk - Full Colored" → Berserk, versions raw + uncensored / colored
 * Versions: colored, raw, uncensored, animated (as the library's: "Work (Colored)"). */
const EDITION_ORDER = ['colored', 'raw', 'uncensored', 'animated'];
const MARKERS = [
  [/^(?:ai[\s_-]*animation|ai[\s_-]*cc|ai[\s_-]*anime|motion(?:[\s_-]*comics?)?|animated|animation|anime[\s_-]*version)$/i, 'animated'],
  [/^(?:full[\s_-]*colou?r(?:ed)?|colou?r(?:ed)?(?:[\s_-]*version)?|digital[\s_-]*colou?r(?:ed)?)$/i, 'colored'],
  [/^(?:raws?|raw[\s_-]*(?:scans?|version))$/i, 'raw'],
  [/^(?:uncensored|uncen(?:sored)?)$/i, 'uncensored'],
  [/^(?:regular|normal|original(?:[\s_-]*version)?|base)$/i, 'base']
];
// Bare words at the end that are versions ("Solo Leveling Raw"): only these, never "base" words (a title may end in "Original")
const BARE_END = /(?:^|[\s\-–—|:,])((?:full[\s_-]*)?colou?r(?:ed)?|raws?|uncensored|uncen|ai[\s_-]*animation|ai[\s_-]*cc|motion(?:[\s_-]*comics?)?)\s*$/i;
// Not part of a title: "(Official)", "[Eng Sub]", " - engsub"…
const NOISE = /^(?:official(?:[\s_-]*(?:translation|release|english))?|eng(?:lish)?[\s_-]*sub(?:bed|s)?|engsub|eng|english|en|scans?|scanlations?|webtoon|manhwa|manga|manhua|webcomic|novel|hd|new|completed?|ongoing|free)$/i;
const markerOf = s => { const x = String(s).trim(); for (const [re, e] of MARKERS) if (re.test(x)) return e; return null; };
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// → { title, editions: ['raw', 'uncensored'], edition: the main one (animated > colored > uncensored > raw) or null }
// opts.sourceNames: names to drop as a tail (" - Fake Scans"); opts.bare: also bare version words at the end
// opts.noise: false keeps noise words (only versions are taken out; the library's folder names)
// opts.remove: text an administrator listed as never part of a title (removed wherever it is, any case)
function parseTitle(raw, { sourceNames = [], bare = true, noise = true, remove = [] } = {}) {
  const isNoise = p => noise && NOISE.test(String(p).trim());
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  for (const r of remove) { const x = String(r || '').trim(); if (x) t = t.replace(new RegExp(escapeRe(x), 'gi'), ' '); }
  if (remove.length) t = t.replace(/[\[(]\s*[\])]/g, ' ').replace(/\s+/g, ' ').trim(); // (brackets left empty)
  const editions = new Set();
  // "Read Solo Leveling Manga Online - Site" → Solo Leveling
  const read = noise && /^read\s+(.+?)\s+(?:manga|manhwa|manhua|webtoon|comics?|novel)?\s*(?:online|for free)\b/i.exec(t);
  if (read) t = read[1];
  // A source's name as a tail or in brackets
  for (const name of sourceNames.filter(n => n && String(n).trim().length > 1)) {
    const n = escapeRe(String(name).trim());
    t = t.replace(new RegExp(`\\s*[\\[(]\\s*${n}\\s*[\\])]`, 'gi'), ' ').replace(new RegExp(`\\s*[-–—|:]\\s*${n}\\s*$`, 'i'), '').trim();
  }
  // Bracketed parts: versions and noise go, anything else stays ("(2019)", "(Novel)" is noise)
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(/\s*[\[(]\s*([^\])[(]{1,40}?)\s*[\])]/g, (whole, inner) => {
      const parts = inner.split(/\s*[,/+&]\s*|\s+-\s+/);
      const kinds = parts.map(p => markerOf(p) || (isNoise(p) ? 'noise' : null));
      if (kinds.every(Boolean)) { kinds.forEach(k => { if (k !== 'noise' && k !== 'base') editions.add(k); }); return ' '; }
      return whole;
    }).replace(/\s+/g, ' ').trim();
    // Tails after a separator: " - engsub", " | Official", " - Raw"
    const tail = /\s*[-–—|:]\s*([^-–—|:]{1,30})$/.exec(t);
    if (tail) {
      const k = markerOf(tail[1]) || (isNoise(tail[1]) ? 'noise' : null);
      if (k) { if (k !== 'noise' && k !== 'base') editions.add(k); t = t.slice(0, tail.index).trim(); }
    }
    if (bare) {
      const m = BARE_END.exec(t);
      // (only with enough title left: "Eat Raw" stays a title)
      if (m && m.index > 0 && t.slice(0, m.index).replace(/[\s\-–—|:,]+$/, '').length >= 5) { const k = markerOf(m[1]); if (k) { editions.add(k); t = t.slice(0, m.index).trim(); } }
    }
    t = t.replace(/[\s\-–—|:,]+$/, '').trim();
    if (t === before) break;
  }
  const list = EDITION_ORDER.filter(e => editions.has(e));
  const main = ['animated', 'colored', 'uncensored', 'raw'].find(e => editions.has(e)) || null;
  return { title: t || String(raw || '').trim(), editions: list, edition: main };
}

/* ---------------- several titles in one line ("Other names: A; B, C") ----------------
 * Strong separators always split: a line break, ";", "|", "•", "·", a slash with spaces around it (" / ", never
 * "Fate/stay night") and their full-width forms. Commas ("," "、" "，") split only when there's no strong one, and
 * never:
 *   - inside brackets or quotes                       "Kaguya-sama (Love, War)"
 *   - inside a title already known (the work's own)   "Love, Chunibyo & Other Delusions"
 *   - before a word in lowercase                      "Wait, what?"
 *   - after an interjection or a form of address      "Yes, My Lord", "Sorry, Hero"
 *   - around a piece that is only a number            "1, 2, 3 Go"
 * sep: the separator a site template gives (a comma one keeps the comma rules). known: titles never cut. */
const OPEN = '([{「『【〈《“', CLOSE = ')]}」』】〉》”';
const WEAK_SEP = ',、，';
const INTERJECTION = /^(?:yes|no|oh|ah|aah|hey|hi|hello|goodbye|bye|sorry|please|thanks|thank you|well|wait|okay|ok|so|but|now|dear|oops|wow|yo|alas|look|listen|hmm|um|uh|ugh|sir|madam|miss|mister|darling|honey|baby|master|my lord|my lady|then|still|again|however|yet|and|or|oi|ara|eh)[!?.…~]*$/i;
function splitTitles(text, opts = {}) {
  let s = String(text || '');
  if (!s.trim()) return [];
  // (known titles with a separator in them: kept whole)
  const keep = [];
  const known = [...new Set((opts.known || []).map(k => String(k || '').trim()).filter(k => k.length > 2 && /[,、，;；|｜•·\/／\n]/.test(k)))].sort((a, b) => b.length - a.length);
  for (const k of known) {
    s = s.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => { keep.push(m); return '\u0000' + (keep.length - 1) + '\u0000'; });
  }
  const sep = opts.sep ? String(opts.sep) : null;
  const sepWeak = sep && sep.trim().length === 1 && WEAK_SEP.includes(sep.trim());
  // Where it could split: { at, len, strong }, outside brackets and quotes
  const cuts = [];
  let depth = 0, quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (OPEN.includes(c)) { depth++; continue; }
    if (CLOSE.includes(c)) { if (depth) depth--; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (depth || quoted) continue;
    if (sep) {
      if (s.startsWith(sep, i)) { cuts.push({ at: i, len: sep.length, strong: !sepWeak, c: sep }); i += sep.length - 1; }
      else if (c === '\n') cuts.push({ at: i, len: 1, strong: true, c });
      continue;
    }
    if (c === '\n' || ';；|｜•·'.includes(c)) cuts.push({ at: i, len: 1, strong: true, c });
    else if ((c === '/' || c === '／') && /\s/.test(s[i - 1] || '') && /\s/.test(s[i + 1] || '')) cuts.push({ at: i, len: 1, strong: true, c });
    else if (WEAK_SEP.includes(c)) cuts.push({ at: i, len: 1, strong: false, c });
  }
  const strong = cuts.some(x => x.strong);
  const use = sep ? cuts : cuts.filter(x => x.strong === strong);
  // Pieces, each with the separator before it
  const pieces = [];
  let from = 0, before = null;
  for (const x of use) { pieces.push({ t: s.slice(from, x.at), before }); before = x.c; from = x.at + x.len; }
  pieces.push({ t: s.slice(from), before });
  const out = [];
  for (const p of pieces) {
    const t = p.t.trim();
    if (!t) continue;
    const prev = out.length ? out[out.length - 1] : null;
    const weakJoin = prev != null && p.before && WEAK_SEP.includes(p.before) &&
      (/^[a-z]/.test(t) || INTERJECTION.test(prev.trim()) || /^[\d\s.]+$/.test(prev) || /^[\d\s.]+[!?]*$/.test(t));
    if (weakJoin) out[out.length - 1] = prev + (p.before === ',' ? ', ' : p.before) + t;
    else out.push(t);
  }
  const back = t => t.replace(/\u0000(\d+)\u0000/g, (m, n) => keep[Number(n)]);
  return [...new Set(out.map(t => back(t).replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

module.exports = { englishScore, isEnglishTag, taggedEnglish, preferEnglish, looksEnglish, splitTitles, parseTitle, EDITION_ORDER };
