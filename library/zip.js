// Minimal read-only ZIP reader (CBZ/ZIP comics). No dependencies.
// Reads only the central directory to list entries, then reads single entries on demand,
// so opening a 500 MB archive to show one page costs one small read plus that page.
// Supports stored and deflate entries, ZIP64 archives, UTF-8 and legacy file names.
const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const inflateRaw = promisify(zlib.inflateRaw);

const MAX_ENTRY = 256 * 1024 * 1024; // refuse to inflate a single entry larger than this

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, pos + off);
    if (!bytesRead) break;
    off += bytesRead;
  }
  return off === len ? buf : buf.subarray(0, off);
}

async function listEntries(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557); // EOCD (22) + max comment (65535)
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20; // ZIP64 end of central directory locator
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64 = await readAt(fh, Number(tail.readBigUInt64LE(loc + 8)), 56);
        if (z64.readUInt32LE(0) === 0x06064b50) {
          count = Number(z64.readBigUInt64LE(32));
          cdSize = Number(z64.readBigUInt64LE(40));
          cdOffset = Number(z64.readBigUInt64LE(48));
        }
      }
    }
    if (cdOffset + cdSize > size) throw new Error('Damaged ZIP archive');

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
      if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
        let x = p + 46 + nlen;
        const end = x + xlen;
        while (x + 4 <= end) {
          const id = cd.readUInt16LE(x), sz = cd.readUInt16LE(x + 2);
          if (id === 0x0001) {
            let q = x + 4;
            if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); }
            break;
          }
          x += 4 + sz;
        }
      }
      if (!name.endsWith('/')) {
        entries.push({ name, method, csize, usize, offset, encrypted: Boolean(flags & 1) });
      }
      p += 46 + nlen + xlen + clen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

async function readEntry(file, entry) {
  if (entry.encrypted) throw new Error('Encrypted entry');
  if (entry.usize > MAX_ENTRY || entry.csize > MAX_ENTRY) throw new Error('Entry too large');
  const fh = await fs.promises.open(file, 'r');
  try {
    const lh = await readAt(fh, entry.offset, 30);
    if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Damaged ZIP entry');
    const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const data = await readAt(fh, start, entry.csize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data, { maxOutputLength: MAX_ENTRY });
    throw new Error(`Unsupported compression method ${entry.method}`);
  } finally {
    await fh.close();
  }
}

module.exports = { listEntries, readEntry };
