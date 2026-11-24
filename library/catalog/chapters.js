// Chapter lists as sites show them (after Folio's crawler rules):
//   chapterDate(text, now)     a release date as YYYY-MM-DD from what the site shows: "2025-01-04", "Jan 4, 2025",
//                              "4 January 2025", "May 9" (this year, or last year when that would be in the future),
//                              "5d ago", "6 hours ago", "about 1 month ago", "a week ago", "yesterday", "hace 3 días";
//                              '' when it isn't a date
//   fixMisreadNumbers(list)    numbers that lost their decimal point: in a list running 1…70, a lone "605" is 60.5
//                              ("6005" would be 60.05) — only with evidence (see below); → [{ from, to }] changed
//   bulkDates(list)            sitemap dates to ignore: when a large share of all chapters carry the same day, the
//                              site bulk-updated them (that day says nothing about each chapter)
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 7 * 86400000, mo: 30 * 86400000, y: 365 * 86400000 };
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
function unitOf(u) {
  u = u.toLowerCase();
  if (/^(s|secs?|seconds?|segundos?)$/.test(u)) return 's';
  if (/^(m|mins?|minutes?|minutos?)$/.test(u)) return 'm';
  if (/^(h|hrs?|hours?|horas?|heures?|stunden?)$/.test(u)) return 'h';
  if (/^(d|days?|d[ií]as?|jours?|tagen?|dias?)$/.test(u)) return 'd';
  if (/^(w|wks?|weeks?|semanas?|semaines?|wochen?)$/.test(u)) return 'w';
  if (/^(mo|mos|months?|mes(es)?|mois|monaten?|m[eê]s(es)?)$/.test(u)) return 'mo';
  if (/^(y|yrs?|years?|a[ñn]os?|ans?|jahren?)$/.test(u)) return 'y';
  return null;
}
function monthOf(m) {
  m = m.toLowerCase().slice(0, 3);
  const i = MONTHS.indexOf(m); if (i !== -1) return i;
  const j = MONTHS_ES.indexOf(m); return j;
}
function chapterDate(text, now = new Date()) {
  const s = String(text || '').trim();
  if (!s) return '';
  let m;
  if ((m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  const t = s.toLowerCase();
  if (/\b(today|just now|hoy|aujourd|heute|hoje)\b/.test(t) || /\b(\d+|an?|one)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b\s*ago/.test(t) && !/\b(mo|mos|months?)\b/.test(t)) {
    const r = /(\d+|an?|one)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/.exec(t);
    if (r) { const n = /^\d+$/.test(r[1]) ? Number(r[1]) : 1; return ymd(new Date(now.getTime() - n * UNIT_MS[unitOf(r[2])])); }
    return ymd(now);
  }
  if (/\b(yesterday|ayer|hier|gestern|ontem)\b/.test(t)) return ymd(new Date(now.getTime() - UNIT_MS.d));
  // "5d ago", "about 1 month ago", "a week ago", "hace 3 días", "il y a 2 jours", "vor 3 Tagen", "2 days"
  if ((m = /(?:about|around|over|almost|hace|il y a|vor|h[aá])?\s*(\d+|an?|one|un[ae]?|einem?)\s*([a-zíêñ]+)\.?\s*(?:ago)?/i.exec(t))) {
    const unit = unitOf(m[2]);
    if (unit && (/ago|hace|il y a|vor|^h[aá]\s/.test(t) || /^\s*(about|around)?\s*\d+\s*[a-z]+\s*$/.test(t))) {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
      return ymd(new Date(now.getTime() - n * UNIT_MS[unit]));
    }
  }
  // "Jan 4, 2025", "January 4 2025", "May 9" — and "4 Jan 2025", "9 de mayo de 2025"
  if ((m = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?\b/i.exec(s)) && monthOf(m[1]) !== -1) return withYear(Number(m[3]) || null, monthOf(m[1]), Number(m[2]), now);
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+)?([a-z]{3,9})\.?,?(?:\s+(?:de\s+)?(\d{4}))?\b/i.exec(s)) && monthOf(m[2]) !== -1) return withYear(Number(m[3]) || null, monthOf(m[2]), Number(m[1]), now);
  if ((m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/.exec(s))) { // day/month/year unless the first can't be a day... (US month/day when the second is > 12)
    let a = Number(m[1]), b = Number(m[2]), y = Number(m[3]); if (y < 100) y += 2000;
    const [day, month] = b > 12 ? [b, a] : [a, b];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${y}-${pad(month)}-${pad(day)}`;
  }
  return '';
}
function withYear(year, month, day, now) {
  if (!(day >= 1 && day <= 31)) return '';
  let y = year || now.getUTCFullYear();
  if (!year && Date.UTC(y, month, day) > now.getTime() + UNIT_MS.d) y--; // "Dec 30" seen in January: last year
  return `${y}-${pad(month + 1)}-${pad(day)}`;
}

// Numbers read without their decimal point. A chapter n is corrected when:
//   - it's one of the few numbers far above the rest (more than double the chapter below it, and 100 or more)
//   - the rest is a dense run from chapter 1 (at least 80% of 1…its top)
//   - the corrected number isn't in the list yet and falls within the run
//   - the evidence agrees: its two neighbours in the site's list bracket the corrected number; else its date falls
//     between those of the chapters around the corrected number; with neither, the corrected number is below the
//     list's highest chapter
function fixMisreadNumbers(list) {
  const nums = list.map(c => parseFloat(c.n)).filter(Number.isFinite);
  if (nums.length < 8) return [];
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const changed = [];
  for (let k = sorted.length - 1; k > 0 && sorted.length - k <= 3; k--) {
    const n = sorted[k], below = sorted[k - 1];
    if (!(n >= 100 && n > below * 2 && Number.isInteger(n))) break;
    const rest = sorted.slice(0, k).filter(x => x >= 1);
    const top = Math.max(...rest);
    const ints = new Set(rest.filter(Number.isInteger));
    if (!rest.length || ints.size < 0.8 * Math.floor(top)) continue;
    // Where the decimal point goes: the longest whole part that still falls within the run
    const str = String(n);
    let to = null;
    for (let i = str.length - 1; i >= 1; i--) { const x = parseFloat(str.slice(0, i) + '.' + str.slice(i)); if (x >= 1 && x <= top && !Number.isInteger(x)) { to = x; break; } }
    // (a recent chapter: in the upper half of the run — "505" after a list cut short at 50 isn't 5.05)
    if (to == null || nums.includes(to) || to < top / 2) continue;
    const at = list.findIndex(c => parseFloat(c.n) === n);
    const nb = [list[at - 1], list[at + 1]].map(c => (c ? parseFloat(c.n) : NaN)).filter(Number.isFinite);
    let ok;
    if (nb.length === 2) ok = Math.min(...nb) < to && to < Math.max(...nb);
    else {
      const d = list[at] && list[at].d;
      const lower = list.filter(c => parseFloat(c.n) < to && c.d).sort((a, b) => parseFloat(b.n) - parseFloat(a.n))[0];
      const upper = list.filter(c => parseFloat(c.n) > to && parseFloat(c.n) !== n && c.d).sort((a, b) => parseFloat(a.n) - parseFloat(b.n))[0];
      if (d && lower && upper) ok = lower.d <= d && d <= upper.d;
      else ok = to < top;
    }
    if (!ok) continue;
    for (const c of list) if (parseFloat(c.n) === n) { c.n = String(to); c.t = String(c.t || '').replace(new RegExp(`\\b${n}\\b`), String(to)); }
    changed.push({ from: n, to });
  }
  return changed;
}

// The day most chapters of a sitemap carry, when it's a bulk update (20+ chapters, 40%+ of them that day)
function bulkDates(entries) {
  const days = entries.map(x => String(x.d || '').slice(0, 10)).filter(Boolean);
  if (days.length < 20) return new Set();
  const count = new Map(); for (const d of days) count.set(d, (count.get(d) || 0) + 1);
  return new Set([...count].filter(([, c]) => c >= 0.4 * days.length).map(([d]) => d));
}

module.exports = { chapterDate, fixMisreadNumbers, bulkDates };
