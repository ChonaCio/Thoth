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
// The best of several untagged titles: English-looking first, then the order given (the first is the default)
function preferEnglish(titles) {
  const list = (titles || []).filter(t => t && String(t).trim());
  if (!list.length) return '';
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

module.exports = { englishScore, isEnglishTag, taggedEnglish, preferEnglish, parseTitle, EDITION_ORDER };
