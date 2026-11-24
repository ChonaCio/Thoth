// Text as sites send it (after Folio's titles.js):
//   decodeText(buf, contentType)  bytes → text in the charset the page declares (a byte-order mark first, then the
//                                 Content-Type header or <meta charset>/<?xml encoding?>), else UTF-8; bytes that
//                                 aren't valid UTF-8 and declare nothing are read as Windows-1252 (old Western sites)
//   fixMojibake(s)                repairs UTF-8 text that was read as Windows-1252/Latin-1 before it reached us
//                                 ("CafÃ©" → "Café", "Itâ€™s" → "It’s"); anything else is returned unchanged
function declaredCharset(buf, contentType = '') {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType || ''));
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head) || /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head);
  return meta ? meta[1].toLowerCase() : '';
}
const decoder = label => { try { return new TextDecoder(label); } catch { return null; } };
function decodeText(buf, contentType = '') {
  if (!buf || !buf.length) return '';
  if (typeof buf === 'string') return buf;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const label = declaredCharset(buf, contentType);
  if (label && !/^utf-?8$/.test(label)) {
    // An "ISO-8859-1" page is in practice Windows-1252 (the browsers' rule)
    const d = decoder(/^(iso-?8859-?1|latin-?1|us-ascii|ascii)$/.test(label) ? 'windows-1252' : label);
    if (d) return d.decode(buf);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {
    return label ? buf.toString('utf8') : new TextDecoder('windows-1252').decode(buf);
  }
}

const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const toByte = new Map([...CP1252].map((c, i) => [c, 0x80 + i]));
const MOJIBAKE = /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-‚“-„†-•…‰‹›€™]/;
function fixMojibake(s) {
  if (typeof s !== 'string' || !MOJIBAKE.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x100) bytes.push(c);
    else if (toByte.has(ch)) bytes.push(toByte.get(ch));
    else return s; // a character that can't come from one byte: not mojibake
  }
  let out;
  try { out = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes)); } catch { return s; }
  return out.length < s.length && !out.includes('�') ? out : s;
}
const fixDeep = v => (typeof v === 'string' ? fixMojibake(v) : Array.isArray(v) ? v.map(fixDeep) : v);

module.exports = { decodeText, declaredCharset, fixMojibake, fixDeep };
