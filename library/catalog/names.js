// Keys for telling that two catalog titles name the same work, however the sites write them:
//   - case, accents, punctuation and spacing ignored ("Emperor's Path" = "emperors-path"); a type word at the end
//     ("… Manhwa") too
//   - numbers written either way: "3-title" = "Three Title", "Twenty-One Days" = "21 Days", "The First Prince" =
//     "The 1st Prince", "Room 007" = "Room 7" (an extra key: names that matched before still match, different
//     numbers stay different)
//   - a leading article ("The Beginning After the End" = "Beginning After the End"; only names of 8+ characters)
//     and bracketed extras ("(Official)", "[Manhwa]", "(Webtoon)", "(English)", "(HD)", "(2019)")
//   - near-identical names: editDistance() (a typo or a letter apart)
// (After Folio's catalog grouping.)
const TYPE_SUFFIX = /\s+(manga|manhwa|manhua|webtoon|comics?|novel)$/i;

function nameKey(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(TYPE_SUFFIX, '').replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');
}

const UNIT_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS_WORDS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE_WORDS = { hundred: 100, thousand: 1000, million: 1000000 };
const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90,
  hundredth: 100, thousandth: 1000, millionth: 1000000 };
const WORDS = [...Object.keys(UNIT_WORDS), ...Object.keys(TENS_WORDS), ...Object.keys(SCALE_WORDS), ...Object.keys(ORDINAL_WORDS)].sort((a, b) => b.length - a.length).join('|');
const NUMBER_WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${WORDS})(?:(?:[\\s-]+(?:and[\\s-]+)?)(?:${WORDS}))*(?![\\p{L}\\p{N}])`, 'giu');
const ordinalSuffix = n => { const t = n % 100; if (t >= 11 && t <= 13) return 'th'; return ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; };

// One run of number words as digits ("twenty one" → 21, "twenty-first" → 21st); separate numbers stay separate
function wordsToDigits(run) {
  const tokens = run.toLowerCase().split(/[\s-]+/).filter(t => t && t !== 'and');
  const out = [];
  let total = 0, current = 0, prev = '', open = false;
  const flush = () => { if (open) out.push(String(total + current)); total = 0; current = 0; prev = ''; open = false; };
  for (const t of tokens) {
    const ord = ORDINAL_WORDS[t];
    const kind = t in UNIT_WORDS ? (UNIT_WORDS[t] >= 10 ? 'teen' : 'unit') : t in TENS_WORDS ? 'tens' : t in SCALE_WORDS ? 'scale' : ord >= 100 ? 'scale' : ord >= 20 && ord % 10 === 0 ? 'tens' : ord >= 10 ? 'teen' : 'unit';
    const continues = open && ((prev === 'tens' && kind === 'unit') || (prev === 'scale' && kind !== 'scale') || (prev !== 'scale' && kind === 'scale'));
    if (!continues) flush();
    const value = ord != null ? ord : UNIT_WORDS[t] != null ? UNIT_WORDS[t] : TENS_WORDS[t] != null ? TENS_WORDS[t] : SCALE_WORDS[t];
    if (kind === 'scale') { if (value >= 1000) { total += (current || 1) * value; current = 0; } else current = (current || 1) * value; } else current += value;
    prev = kind; open = true;
    if (ord != null) { const n = total + current; out.push(`${n}${ordinalSuffix(n)}`); total = 0; current = 0; prev = ''; open = false; }
  }
  flush();
  return out.join(' ');
}
// Spelled-out numbers as digits, leading zeros dropped ("Three Title" → "3 Title", "007" → "7")
const spellNumbers = s => String(s || '').replace(NUMBER_WORD_RE, m => wordsToDigits(m)).replace(/(?<![\d.])0+(?=\d)/g, '');
const numberKey = s => nameKey(spellNumbers(s));
function nameKeys(s) { const a = nameKey(s), b = numberKey(s); return a === b ? [a] : [a, b]; }

const NOISE_BRACKETS = /\s*[([{]\s*(?:official|manhwa|manga|manhua|webtoons?|comics?|english|eng|en|hd|full colou?r|digital|(?:19|20)\d{2})\s*[)\]}]\s*/gi;
// Every key a title can be matched by
function matchKeys(s) {
  const out = new Set(nameKeys(s));
  const cleaned = String(s || '').replace(NOISE_BRACKETS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned && cleaned !== String(s || '').trim()) for (const k of nameKeys(cleaned)) out.add(k);
  const noArticle = cleaned.replace(/^(?:the|a|an)[\s_-]+/i, '');
  if (noArticle !== cleaned) for (const k of nameKeys(noArticle)) if (k.length >= 8) out.add(k);
  out.delete('');
  return [...out];
}

// Edit distance, or max + 1 as soon as it's certainly larger than max
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Two names a typo apart (10+ characters: 1 letter; 18+: 2), never when their numbers differ ("… 2" / "… 3")
function nearNames(a, b) {
  if (a === b || a.length < 10 || b.length < 10) return false;
  const digits = s => (s.match(/\d+/g) || []).join(',');
  if (digits(a) !== digits(b)) return false;
  const max = Math.min(a.length, b.length) >= 18 ? 2 : 1;
  return editDistance(a, b, max) <= max;
}

module.exports = { nameKey, nameKeys, matchKeys, spellNumbers, editDistance, nearNames };
