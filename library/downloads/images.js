// Page images as downloaded, checked without an image codec (Thoth has no dependencies): what the first bytes say
// the file is, its size in pixels from its header, and whether it arrived whole (JPEG end marker, PNG IEND, the
// size RIFF/WebP declares). A page that isn't an image (an error page, a bot check), is cut off, or is a tiny
// placeholder is refused, and another site's copy is used instead.

// → { type, ext } or null
function kindOf(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return { type: 'image/png', ext: 'png' };
  if (buf.toString('latin1', 0, 4) === 'GIF8') return { type: 'image/gif', ext: 'gif' };
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(buf.toString('latin1', 8, 12))) return { type: 'image/avif', ext: 'avif' };
  return null;
}

// → { width, height } or null (unreadable header)
function sizeOf(buf, kind) {
  try {
    if (kind.ext === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (kind.ext === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (kind.ext === 'webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      return null;
    }
    if (kind.ext === 'jpg') {
      // The frame header (SOF0…SOF15 but DHT/JPG/DAC) carries the size
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
      return null;
    }
    if (kind.ext === 'avif') {
      const at = buf.indexOf('ispe', 0, 'latin1');
      return at > 0 && at + 16 <= buf.length ? { width: buf.readUInt32BE(at + 8), height: buf.readUInt32BE(at + 12) } : null;
    }
  } catch { /* a header cut short */ }
  return null;
}

// Arrived whole: the format's end is there
function complete(buf, kind) {
  if (kind.ext === 'jpg') { const tail = buf.slice(Math.max(0, buf.length - 1024)); for (let i = tail.length - 2; i >= 0; i--) if (tail[i] === 0xff && tail[i + 1] === 0xd9) return true; return false; }
  if (kind.ext === 'png') return buf.slice(Math.max(0, buf.length - 64)).includes(Buffer.from('IEND', 'latin1'));
  if (kind.ext === 'webp') return buf.readUInt32LE(4) + 8 <= buf.length;
  if (kind.ext === 'gif') return buf[buf.length - 1] === 0x3b || buf.slice(Math.max(0, buf.length - 16)).includes(0x3b);
  return true;
}

// One page: { ok: true, ext, type, width, height, bytes } or { ok: false, reason }
function checkPage(buf, contentType = '') {
  if (!buf || !buf.length) return { ok: false, reason: 'empty answer' };
  const kind = kindOf(buf);
  if (!kind) return { ok: false, reason: /html|text|json/i.test(contentType) ? 'a page or a message instead of an image' : 'not an image' };
  const size = sizeOf(buf, kind);
  if (!size || !size.width || !size.height) return { ok: false, reason: 'unreadable image' };
  if (!complete(buf, kind)) return { ok: false, reason: 'image cut off (incomplete download)' };
  // (placeholders: "image not found", a 1-pixel tracker; the short last slice of a vertical strip is fine)
  if (size.width < 50 || (size.width < 100 && size.height < 100)) return { ok: false, reason: `image too small (${size.width}×${size.height}): a placeholder` };
  return { ok: true, ext: kind.ext, type: kind.type, width: size.width, height: size.height, bytes: buf.length };
}

// A chapter's pages together: every page the same placeholder (the same bytes everywhere) is no chapter
function checkChapter(pages) {
  if (pages.length >= 3) {
    const first = pages[0].buf;
    if (pages.every(p => p.buf.length === first.length && p.buf.equals(first))) return 'every page is the same image (a placeholder)';
  }
  return null;
}
// A copy's quality: the width most of its pages have (what the reader shows)
function qualityOf(pages) {
  const ws = pages.map(p => p.width).filter(Boolean).sort((a, b) => a - b);
  return ws.length ? ws[Math.floor(ws.length / 2)] : 0;
}

module.exports = { kindOf, sizeOf, complete, checkPage, checkChapter, qualityOf };
