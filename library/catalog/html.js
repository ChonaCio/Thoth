// A small, forgiving HTML parser with CSS selectors, enough to read listing and work pages of sites (no
// dependencies, like the rest of Thoth). parse(html) → document; doc.select('ul.list > li a[href*="title"]');
// text(el), attr(el, name). Selectors: tag, #id, .class, [attr], [attr=v], [attr~=v], [attr*=v], [attr^=v],
// [attr$=v], descendant and child (>) combinators, comma lists, :first-child, :last-child, :nth-child(n).
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// Tags that close an open sibling of the same kind (<li> without </li>, <p> without </p>, …)
const AUTO_CLOSE = { li: ['li'], p: ['p'], option: ['option'], tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'], dt: ['dt', 'dd'], dd: ['dt', 'dd'] };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×' };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    const v = ENTITIES[e.toLowerCase()];
    return v != null ? v : m;
  });
}

function node(tag, attrs, parent) { return { tag, attrs, children: [], parent, text: null }; }
function parse(html) {
  html = String(html || '');
  const doc = node('#document', {}, null);
  let cur = doc, i = 0;
  const n = html.length;
  const pushText = t => { if (t) cur.children.push({ tag: '#text', text: decode(t), parent: cur }); };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { const e = html.indexOf('>', lt); i = e === -1 ? n : e + 1; continue; }
    if (html[lt + 1] === '/') {
      const e = html.indexOf('>', lt);
      const name = html.slice(lt + 2, e === -1 ? n : e).trim().toLowerCase();
      i = e === -1 ? n : e + 1;
      // Close up to the matching open tag (if there is one); stray closing tags are ignored
      let x = cur;
      while (x && x.tag !== name && x.tag !== '#document') x = x.parent;
      if (x && x.tag === name) cur = x.parent;
      continue;
    }
    const m = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(lt, lt + 64));
    if (!m) { pushText('<'); i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    // Attributes up to the closing ">" (quotes respected)
    let j = lt + m[0].length;
    const attrs = {};
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(html[j])) j++;
      if (j >= n) break;
      if (html[j] === '>') { j++; break; }
      if (html[j] === '/' && html[j + 1] === '>') { selfClose = true; j += 2; break; }
      const am = /^[^\s=>\/]+/.exec(html.slice(j, j + 256));
      if (!am) { j++; continue; }
      const name = am[0].toLowerCase();
      j += am[0].length;
      while (j < n && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") { const e = html.indexOf(q, j + 1); value = html.slice(j + 1, e === -1 ? n : e); j = e === -1 ? n : e + 1; }
        else { const vm = /^[^\s>]*/.exec(html.slice(j, j + 2048)); value = vm[0]; j += value.length; }
      }
      if (!(name in attrs)) attrs[name] = decode(value);
    }
    i = j;
    if (AUTO_CLOSE[tag] && AUTO_CLOSE[tag].includes(cur.tag)) cur = cur.parent;
    const el = node(tag, attrs, cur);
    cur.children.push(el);
    if (VOID.has(tag) || selfClose) continue;
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf('</' + tag, i);
      const body = html.slice(i, close === -1 ? n : close);
      if (body) el.children.push({ tag: '#text', text: tag === 'script' || tag === 'style' ? body : decode(body), parent: el });
      const e = close === -1 ? n : html.indexOf('>', close);
      i = e === -1 ? n : e + 1;
      continue;
    }
    cur = el;
  }
  return wrap(doc);
}

/* ---------------- selectors ---------------- */
function parseSelector(sel) {
  // → [[{ comb, tag, id, classes, attrs, pseudo }]] (a list of complex selectors)
  const out = [];
  for (const part of splitTop(sel, ',')) {
    const steps = [];
    const re = /\s*(>)?\s*([^\s>]+)/g;
    let m;
    while ((m = re.exec(part.trim()))) steps.push(Object.assign({ comb: m[1] ? '>' : ' ' }, compound(m[2])));
    if (steps.length) out.push(steps);
  }
  return out;
}
// Split on a character that isn't inside [] or ()
function splitTop(s, ch) {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[' || c === '(') depth++; else if (c === ']' || c === ')') depth--;
    else if (c === ch && !depth) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim()).filter(Boolean);
}
function compound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:([~*^$|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]|:([\w-]+)(?:\(([^)]*)\))?/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (m[1]) c.tag = m[1] === '*' ? null : m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), op: m[5] || null, value: m[6] != null ? m[6] : m[7] != null ? m[7] : m[8] });
    else if (m[9]) c.pseudo.push({ name: m[9], arg: m[10] });
  }
  return c;
}
const elementChildren = el => el.children.filter(x => x.tag[0] !== '#');
function matches(el, c) {
  if (!el || el.tag[0] === '#') return false;
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) { const cl = (el.attrs.class || '').split(/\s+/); if (!c.classes.every(x => cl.includes(x))) return false; }
  for (const a of c.attrs) {
    const v = el.attrs[a.name];
    if (v == null) return false;
    if (!a.op) continue;
    const want = a.value || '';
    if (a.op === '=' && v !== want) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(want)) return false;
    if (a.op === '*=' && !v.includes(want)) return false;
    if (a.op === '^=' && !v.startsWith(want)) return false;
    if (a.op === '$=' && !v.endsWith(want)) return false;
    if (a.op === '|=' && v !== want && !v.startsWith(want + '-')) return false;
  }
  for (const p of c.pseudo) {
    const sib = el.parent ? elementChildren(el.parent) : [el];
    const idx = sib.indexOf(el) + 1;
    if (p.name === 'first-child' && idx !== 1) return false;
    if (p.name === 'last-child' && idx !== sib.length) return false;
    if (p.name === 'nth-child' && idx !== Number(p.arg)) return false;
  }
  return true;
}
// Does el match the steps (right to left)?
function matchesSteps(el, steps, k = steps.length - 1) {
  if (!matches(el, steps[k])) return false;
  if (k === 0) return true;
  const comb = steps[k].comb;
  if (comb === '>') return matchesSteps(el.parent, steps, k - 1);
  for (let p = el.parent; p && p.tag !== '#document'; p = p.parent) if (matchesSteps(p, steps, k - 1)) return true;
  return false;
}
function selectAll(root, sel) {
  const lists = parseSelector(sel);
  const out = [];
  const walk = el => {
    for (const ch of el.children) {
      if (ch.tag[0] === '#') continue;
      if (lists.some(steps => matchesSteps(ch, steps))) out.push(ch);
      walk(ch);
    }
  };
  walk(root);
  return out;
}
function textOf(el) {
  if (!el) return '';
  if (el.tag === '#text') return el.text;
  let s = '';
  for (const ch of el.children) s += ch.tag === 'br' ? '\n' : textOf(ch) + (/^(p|div|li|h\d|tr)$/.test(ch.tag) ? '\n' : '');
  return s;
}
const clean = s => String(s || '').replace(/[ \t\f\v ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
function wrap(doc) {
  const api = el => ({
    el,
    select: sel => selectAll(el, sel).map(api),
    first: sel => { const r = selectAll(el, sel)[0]; return r ? api(r) : null; },
    text: () => clean(textOf(el)).replace(/\n+/g, ' '),
    textBlock: () => clean(textOf(el)),
    attr: name => (el.attrs && el.attrs[name] != null ? el.attrs[name] : null)
  });
  return api(doc);
}

module.exports = { parse, decode, parseSelector };
