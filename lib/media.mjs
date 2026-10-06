// Stored media files and download names of produced videos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getNode } from './nodes.mjs';
import { mediaDir } from './projects.mjs';

// Download name for a video node: <STT>_<tên shot>[_vN].<ext> — mirrors the client's naming,
// so a shot's source sequence number and name make the file obvious inside the ZIP.
export function videoFileName(n) {
  const url = String(n.video?.url || '');
  const ext = url.match(/\.(mp4|webm)(?:\?|$)/i)?.[1] || 'mp4';
  const clean = s =>
    String(s || 'video')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'video';
  if (n.terminal) {
    const src = getNode(n.source);
    const seq = src?.seq ?? n.sourceSeq ?? 0;
    return (
      String(seq).padStart(2, '0') +
      '_' +
      clean(src?.name ?? n.sourceName) +
      '_v' +
      (n.version || 1) +
      '.' +
      ext
    );
  }
  return String(n.seq || 0).padStart(2, '0') + '_' + clean(n.name) + '.' + ext;
}
export function storeAsset(b) {
  const types = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
  };
  const ext = types[b.mime];
  if (!ext) throw new Error('Định dạng chưa hỗ trợ. Dùng PNG/JPG/WebP, MP4/WebM hoặc MP3/WAV/M4A.');
  const bytes = Buffer.from(b.base64 || '', 'base64');
  if (!bytes.length || bytes.length > 100 * 1024 * 1024)
    throw new Error('File trống hoặc lớn hơn 100 MB.');
  const id = crypto.randomUUID() + '.' + ext;
  fs.writeFileSync(path.join(mediaDir, id), bytes);
  return { id, url: '/media/' + id, mime: b.mime, name: String(b.name || id).slice(0, 200) };
}
