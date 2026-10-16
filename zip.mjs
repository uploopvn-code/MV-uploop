// Minimal ZIP writer (STORE method, no compression — video files are already compressed).
// No dependencies. Handles UTF-8 filenames (Vietnamese) via the language-encoding flag.
// Standard zip (no zip64): keep the total archive under 4 GB.
import fs from 'node:fs';
import { once } from 'node:events';
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Streaming STORE writer for project backups. It uses data descriptors so media is read
// once, and ZIP64 only when an entry/offset/entry-count exceeds classic ZIP limits.
// files: [{ name, path? , data? }] where data is a Buffer for generated metadata.
export async function writeZipStream(res, files) {
  let offset = 0n;
  const central = [];
  const write = async chunk => {
    if (res.destroyed) throw new Error('Tải ZIP đã bị ngắt.');
    if (!res.write(chunk)) await once(res, 'drain');
    offset += BigInt(chunk.length);
  };
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    if (name.length > 65535) throw new Error('Tên file ZIP quá dài.');
    const size = f.path ? BigInt(fs.statSync(f.path).size) : BigInt(f.data.length);
    const large = size >= 0xffffffffn;
    const start = offset;
    const extra = large ? Buffer.alloc(20) : Buffer.alloc(0);
    if (large) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(size, 4);
      extra.writeBigUInt64LE(size, 12);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(large ? 45 : 20, 4);
    local.writeUInt16LE(0x0808, 6); // UTF-8 + data descriptor
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(large ? 0xffffffff : 0, 18);
    local.writeUInt32LE(large ? 0xffffffff : 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    await write(local);
    await write(name);
    if (extra.length) await write(extra);
    let crc = 0xffffffff;
    let actualSize = 0n;
    const chunks = f.path ? fs.createReadStream(f.path) : [f.data];
    for await (const chunk of chunks) {
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      actualSize += BigInt(chunk.length);
      await write(chunk);
    }
    if (actualSize !== size) throw new Error('File thay đổi trong lúc đóng gói: ' + f.name);
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(large ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (large) {
      descriptor.writeBigUInt64LE(size, 8);
      descriptor.writeBigUInt64LE(size, 16);
    } else {
      descriptor.writeUInt32LE(Number(size), 8);
      descriptor.writeUInt32LE(Number(size), 12);
    }
    await write(descriptor);
    central.push({ name, size, start, crc, large });
  }
  const centralStart = offset;
  for (const f of central) {
    const largeOffset = f.start >= 0xffffffffn;
    const extra = Buffer.alloc((f.large || largeOffset) ? 4 + (f.large ? 16 : 0) + (largeOffset ? 8 : 0) : 0);
    if (extra.length) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(extra.length - 4, 2);
      let at = 4;
      if (f.large) {
        extra.writeBigUInt64LE(f.size, at);
        extra.writeBigUInt64LE(f.size, at + 8);
        at += 16;
      }
      if (largeOffset) extra.writeBigUInt64LE(f.start, at);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(f.large || largeOffset ? 45 : 20, 6);
    cd.writeUInt16LE(0x0808, 8);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(f.crc, 16);
    cd.writeUInt32LE(f.large ? 0xffffffff : Number(f.size), 20);
    cd.writeUInt32LE(f.large ? 0xffffffff : Number(f.size), 24);
    cd.writeUInt16LE(f.name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE(largeOffset ? 0xffffffff : Number(f.start), 42);
    await write(cd);
    await write(f.name);
    if (extra.length) await write(extra);
  }
  const centralSize = offset - centralStart;
  const zip64 = central.length >= 65535 || centralStart >= 0xffffffffn || centralSize >= 0xffffffffn || central.some(f => f.large || f.start >= 0xffffffffn);
  if (zip64) {
    const end64Start = offset;
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(central.length), 24);
    end64.writeBigUInt64LE(BigInt(central.length), 32);
    end64.writeBigUInt64LE(centralSize, 40);
    end64.writeBigUInt64LE(centralStart, 48);
    await write(end64);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(end64Start, 8);
    locator.writeUInt32LE(1, 16);
    await write(locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(central.length, 65535), 8);
  end.writeUInt16LE(Math.min(central.length, 65535), 10);
  end.writeUInt32LE(Number(centralSize > 0xffffffffn ? 0xffffffffn : centralSize), 12);
  end.writeUInt32LE(Number(centralStart > 0xffffffffn ? 0xffffffffn : centralStart), 16);
  await write(end);
  res.end();
}

// files: [{ name: string, data: Buffer }] → Buffer of a .zip archive.
export function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const FLAG_UTF8 = 0x0800;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6); // general purpose flag (UTF-8 name)
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central dir header signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0x21, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12); // central dir size
  end.writeUInt32LE(offset, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...chunks, centralBuf, end]);
}
