// Image dimensions from file headers, and the closest model aspect ratio (edit image).
import { catalog as seedvisCatalog } from '../seedvis-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mediaDir } from './projects.mjs';

// The width/height of a stored PNG, JPEG or WebP image, read from its header (null if unknown).
export function imageSize(asset) {
  try {
    const b = fs.readFileSync(path.join(mediaDir, path.basename(String(asset?.id || ''))));
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const t = b.toString('ascii', 12, 16);
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (t === 'VP8L') {
        const v = b.readUInt32LE(21);
        return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 };
      }
      if (t === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      // JPEG: walk the segments to the frame header (SOF0-15, minus DHT/JPG/DAC).
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) {
          i++;
          continue;
        }
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m))
          return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {
    // unreadable: the caller keeps the node's own setting
  }
  return null;
}
// The model's aspect ratio closest to an image's own shape, so an edit keeps the framing
// instead of being cropped or padded to the node's default 16:9.
export function nearestAspect(size, model, fallback) {
  const options = (seedvisCatalog.image.find(m => m.id === model)?.aspect || []).filter(a =>
    /^\d+:\d+$/.test(a),
  );
  if (!size?.w || !size?.h || !options.length) return fallback;
  const want = Math.log(size.w / size.h);
  const off = a => {
    const [x, y] = a.split(':').map(Number);
    return Math.abs(Math.log(x / y) - want);
  };
  return options.reduce((best, a) => (off(a) < off(best) ? a : best));
}
