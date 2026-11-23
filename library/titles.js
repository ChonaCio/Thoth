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

module.exports = { englishScore, isEnglishTag, taggedEnglish, preferEnglish };
