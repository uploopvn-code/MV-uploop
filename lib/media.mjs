// Stored media files and download names of produced videos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getNode } from './nodes.mjs';
import { db, mediaDir } from './projects.mjs';

// Số cảnh dùng để sắp thứ tự file: lấy từ chính TÊN shot khi nó mở đầu bằng S<số>
// ("S11 — Evidence…" → S11), không lấy `seq`.
//
// Vì sao: `seq` do tool tự đánh và KHÔNG đáng tin cho thứ tự cảnh. Trên một project thật ở đây,
// hai shot cùng seq 1 (S01 và S02 → trùng tên file), seq 4 lại là S12 còn seq 5 là S03 (đảo thứ
// tự), và seq nhảy 6 → 9 → 10 → 13. Số S trong tên mới là thứ tự kịch bản.
//
// Trả về { tag, rest }: tag là tiền tố sắp xếp, rest là tên đã bỏ phần "S11 —" để khỏi lặp.
const SCENE_RE = /^\s*S\s*(\d{1,4})\b\s*[-–—:.]?\s*(.*)$/i;

// Độ rộng số phải ĐỒNG NHẤT trong cả project, nếu không "S100" sắp trước "S11". Phim 15 phút
// có hơn trăm shot nên chuyện này xảy ra thật — đếm số cảnh lớn nhất rồi đệm theo nó.
function sceneWidth() {
  let max = 0;
  for (const n of db.nodes || []) {
    if (n.terminal) continue;
    const m = SCENE_RE.exec(n.name || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(Math.max(max, 10)).length;
}

function sceneTag(name, seq) {
  const m = SCENE_RE.exec(String(name || ''));
  if (m) return { tag: 'S' + String(Number(m[1])).padStart(sceneWidth(), '0'), rest: m[2] || name };
  // Không có số S trong tên (hay gặp ở MV): giữ nguyên cách cũ, đánh theo seq.
  return { tag: String(seq || 0).padStart(2, '0'), rest: name };
}

// Download name for a video node: <S##>_<tên shot>[_vN].<ext> — đặt S lên đầu để sắp theo tên
// là ra đúng thứ tự cảnh, cả trong ZIP lẫn trong thư mục làm việc.
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
    const { tag, rest } = sceneTag(src?.name ?? n.sourceName, src?.seq ?? n.sourceSeq ?? 0);
    return tag + '_' + clean(rest) + '_v' + (n.version || 1) + '.' + ext;
  }
  const { tag, rest } = sceneTag(n.name, n.seq);
  return tag + '_' + clean(rest) + '.' + ext;
}
// Tên file ảnh của một node (đóng gói): đặt theo chính node. Shot có số S → "<S##>_<tên>.ext" để
// sắp đúng thứ tự cảnh; node khác (nhân vật, bối cảnh, nhóm…) lấy nguyên tên.
export function imageFileName(n) {
  const url = String(n.image?.url || '');
  const ext = url.match(/\.(png|jpg|jpeg|webp)(?:\?|$)/i)?.[1]?.toLowerCase() || 'png';
  const clean = s =>
    String(s || 'anh')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'anh';
  // Node sản xuất (có 'duration' hoặc seq và tên có số cảnh): giữ tiền tố S để sắp thứ tự.
  if ('duration' in n || SCENE_RE.test(String(n.name || ''))) {
    const { tag, rest } = sceneTag(n.name, n.seq);
    return tag + '_' + clean(rest) + '.' + ext;
  }
  return clean(n.name) + '.' + ext;
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
