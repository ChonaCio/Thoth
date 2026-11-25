// Writes a chapter as a CBZ: a ZIP of its pages (stored, not compressed again: they're JPEG/PNG/WebP already) and
// a ComicInfo.xml. Written to a temporary file next to the target and renamed into place, so a library scan
// never reads half a file.
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// DOS date and time of now
function dosTime(d = new Date()) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
// entries: [{ name, data: Buffer }] → the ZIP as one Buffer (UTF-8 names; no ZIP64: a chapter stays far under 4 GB)
function zip(entries) {
  const { time, date } = dosTime();
  const locals = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), crc = crc32(e.data), size = e.data.length;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    locals.push(h, name, e.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat(central, [end]));
}

const xmlText = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// ComicInfo.xml: what the library scan reads (series, number, title, site, people, genres, language, page count)
function comicInfo(m) {
  const f = (tag, v) => (v != null && v !== '' ? `  <${tag}>${xmlText(v)}</${tag}>\n` : '');
  return '<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n' +
    f('Title', m.title) + f('Series', m.series) + f('Number', m.number) + f('Volume', m.volume) + f('Summary', m.summary) +
    f('Writer', (m.authors || []).join(', ')) + f('Genre', (m.genres || []).join(', ')) + f('Web', m.web) + f('LanguageISO', m.language) +
    f('PageCount', m.pages) + f('Notes', m.notes) + '</ComicInfo>\n';
}

// pages: [{ buf, ext }] in reading order → writes the CBZ (001.jpg, 002.png… and ComicInfo.xml) → its size
function writeCbz(file, pages, meta) {
  const width = Math.max(3, String(pages.length).length);
  const entries = pages.map((p, i) => ({ name: String(i + 1).padStart(width, '0') + '.' + p.ext, data: p.buf }));
  entries.push({ name: 'ComicInfo.xml', data: Buffer.from(comicInfo(Object.assign({}, meta, { pages: pages.length })), 'utf8') });
  const data = zip(entries);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.part';
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return data.length;
}

module.exports = { zip, crc32, comicInfo, writeCbz };
