// Generates sample comics for testing: node make-comics.js <dir> [--big]
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function png(w, h, [r, g, b], label = 0) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      // a band whose position encodes the page number, so pages look different
      const band = Math.abs(y - ((label * 37) % h)) < h / 12;
      raw[o] = band ? 255 - r : r; raw[o + 1] = band ? 255 - g : g; raw[o + 2] = band ? 255 - b : b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function makeZip(files, { deflate = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function pdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    const s = `BT /F1 36 Tf 60 200 Td (${text}) Tj ET`;
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const colors = [[200, 60, 60], [60, 120, 200], [60, 170, 90], [200, 150, 40], [140, 70, 190], [40, 160, 170]];
const pages = (n, c, w = 400, h = 600) => Array.from({ length: n }, (_, i) => [`page${String(i + 1).padStart(3, '0')}.png`, png(w, h, colors[(c + i) % colors.length], i)]);

const root = path.resolve(process.argv[2]);
const big = process.argv.includes('--big');
fs.mkdirSync(path.join(root, 'Alpha Series'), { recursive: true });
fs.mkdirSync(path.join(root, 'Beta'), { recursive: true });
fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
fs.mkdirSync(path.join(root, 'Webtoon Tale'), { recursive: true });

const comicInfo = `<?xml version="1.0"?><ComicInfo><Title>The First &amp; Best</Title><Series>Alpha!</Series><Number>1</Number>
<Summary>Alpha begins.</Summary><Writer>Ann Writer</Writer><Penciller>Pat Pen</Penciller><Publisher>Thoth Press</Publisher>
<Year>2024</Year><Month>3</Month><Genre>Action, Comedy</Genre><Manga>YesAndRightToLeft</Manga></ComicInfo>`;
fs.writeFileSync(path.join(root, 'Alpha Series', 'Alpha v01.cbz'), makeZip([['ComicInfo.xml', Buffer.from(comicInfo)], ...pages(big ? 12 : 3, 0).reverse()], { deflate: true }));
fs.writeFileSync(path.join(root, 'Alpha Series', 'Alpha v02.cbz'), makeZip(pages(big ? 8 : 2, 2)));
fs.writeFileSync(path.join(root, 'Alpha Series', 'Alpha v10.cbz'), makeZip(pages(big ? 5 : 1, 4)));
fs.writeFileSync(path.join(root, 'Beta', 'Beta 1.pdf'), pdf(['Beta page one', 'Beta page two']));
fs.writeFileSync(path.join(root, 'Beta', 'broken.cbz'), Buffer.from('this is not a zip file'));
fs.writeFileSync(path.join(root, 'Beta', 'skip.cbr'), Buffer.from('rar'));
fs.writeFileSync(path.join(root, 'loose.cbz'), makeZip(pages(2, 3)));
fs.writeFileSync(path.join(root, '.hidden', 'secret.cbz'), makeZip(pages(1, 1)));
fs.writeFileSync(path.join(root, 'Webtoon Tale', 'Episode 1.cbz'), makeZip([['ComicInfo.xml', Buffer.from('<ComicInfo><Format>Webtoon</Format></ComicInfo>')], ...pages(big ? 6 : 3, 1, 400, 1200)]));
console.log('sample comics written to', root);
module.exports = { png, makeZip };
