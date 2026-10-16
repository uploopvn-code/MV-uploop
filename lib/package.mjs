// Đóng gói cả project thành MỘT file zip để giao cho người dựng hoặc lưu trữ:
// video đã render (đặt tên theo đúng tên shot trên UI) + đủ 7 bước kịch bản + prompt/Bible/manifest.
//
// Vì sao gộp làm một: video rời thì không ai biết cảnh nào trước cảnh nào, còn kịch bản rời thì
// không biết nó đẻ ra clip nào. Trong một gói, tên file clip (`01_S01 — …_v1.mp4`) khớp đúng cột
// ClipFile của manifest và đúng thứ tự shot của bảng kịch bản.
import fs from 'node:fs';
import path from 'node:path';
import { buildBible } from './bible.mjs';
import { buildManifest } from './manifest.mjs';
import { imageFileName, videoFileName } from './media.mjs';
import { assetRefs, getNode } from './nodes.mjs';
import { prompts } from './prompts.mjs';
import { stages } from './script-studio.mjs';
import { studioKind } from './studio-kind.mjs';

// Trần dung lượng: zip dựng hết trong RAM nên phải có chặn, giống /api/videos/zip.
export const MAX_BYTES = 3 * 1024 * 1024 * 1024;

const slug = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'buoc';

const safeFolder = s =>
  String(s || 'project')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'project';

// Bảy bước của xưởng kịch bản. Sáu trạm đầu lấy thẳng từ stages() — KHÔNG chép cứng danh sách,
// để thêm/bớt trạm là gói đổi theo — rồi QC là bước cuối.
export function scriptFiles(scriptNode) {
  if (!scriptNode) return [];
  const mode = scriptNode.mode === 'full' ? 'full' : 'fast';
  // Trước đây đọc scriptNode.kind === 'mv' — kind của node Kịch bản luôn là 'script', nên project
  // MV luôn bị xuất tên bước của drama.
  const kind = studioKind(scriptNode);
  const list = stages(mode, kind);
  const saved = scriptNode.stages || {};
  const out = [];
  let i = 0;
  for (const st of list) {
    const text = String(saved[st.key] ?? '').trim();
    i++;
    const n2 = String(i).padStart(2, '0');
    const ext = st.key === 'blueprint' ? 'json' : 'md';
    out.push({
      name: `kich-ban/${n2}-${slug(st.label)}.${ext}`,
      // Trạm chưa chạy vẫn xuất file, ghi rõ là trống: người nhận thấy ngay thiếu bước nào,
      // thay vì đoán xem file biến đâu mất.
      text: text || `# ${st.label}\n\n(Trạm này chưa chạy — chưa có nội dung.)\n`,
    });
  }
  const qc = scriptNode.qc;
  out.push({
    name: `kich-ban/${String(i + 1).padStart(2, '0')}-qc-validator.md`,
    text: qc
      ? [
          '# ⑦ QC & Validator',
          '',
          `Kết quả: ${qc.ok ? 'ĐẠT' : 'CHƯA ĐẠT'}${qc.rounds ? ` (sau ${qc.rounds} vòng tự sửa)` : ''}`,
          '',
          '## Lỗi',
          ...(qc.errors?.length ? qc.errors.map(e => `- ${e}`) : ['(không có)']),
          '',
          '## Cảnh báo',
          ...(qc.warnings?.length ? qc.warnings.map(w => `- ${w}`) : ['(không có)']),
          '',
        ].join('\n')
      : '# ⑦ QC & Validator\n\n(Chưa chạy kiểm.)\n',
  });
  return out;
}

// Toàn bộ gói. `mediaDir` là thư mục media của project.
export function buildPackage(db, mediaDir) {
  const files = [];
  const add = (name, text) => files.push({ name, data: Buffer.from(text, 'utf8') });

  let bytes = 0;
  // Đặt một file media (tên theo node) vào thư mục, chống trùng tên.
  const used = new Map();
  const addMedia = (dir, base, data) => {
    const key = dir + '/' + base;
    if (used.has(key)) {
      const c = used.get(key) + 1;
      used.set(key, c);
      base = base.replace(/(\.\w+)$/, '_' + c + '$1');
    } else used.set(key, 1);
    bytes += data.length;
    if (bytes > MAX_BYTES)
      throw new Error('Tổng dung lượng media quá lớn (>3GB). Xoá bớt phiên bản cũ rồi đóng gói lại.');
    files.push({ name: dir + '/' + base, data });
  };
  // Clip / shot của NHÓM (Seedance gom nhiều shot thành một clip, hoặc phân cảnh ghép) tách riêng
  // thư mục con "nhom/". getNode theo source của clip, hoặc chính node nếu là node nhóm.
  const isGroupNode = n => n?.role === 'seedance' || n?.role === 'merged';
  const inGroupFolder = n =>
    n.terminal ? isGroupNode(getNode(n.source)) : isGroupNode(n) || n.role === 'frame';

  // --- video đã render, tên theo đúng shot/nhóm; clip của nhóm vào video/nhom/ ----------------
  const clips = db.nodes.filter(n => n.terminal && n.video);
  let skipped = 0;
  let clipCount = 0;
  for (const n of clips) {
    const fileId = String(n.video.url || '').replace(/^\/media\//, '');
    if (!/^[a-f0-9-]+\.(mp4|webm)$/.test(fileId)) continue;
    const file = path.join(mediaDir, fileId);
    if (!fs.existsSync(file)) {
      skipped++;
      continue;
    }
    addMedia(inGroupFolder(n) ? 'video/nhom' : 'video', videoFileName(n), fs.readFileSync(file));
    clipCount++;
  }

  // --- ảnh của từng node, tên theo node; ảnh của nhóm (storyboard, khung ghép) vào anh/nhom/ --
  let imageCount = 0;
  let imageSkipped = 0;
  for (const n of db.nodes) {
    if (n.terminal || !n.image) continue;
    const fileId = String(n.image.url || '').replace(/^\/media\//, '');
    if (!/^[a-f0-9-]+\.(png|jpg|jpeg|webp)$/i.test(fileId)) continue;
    const file = path.join(mediaDir, fileId);
    if (!fs.existsSync(file)) {
      imageSkipped++;
      continue;
    }
    addMedia(inGroupFolder(n) ? 'anh/nhom' : 'anh', imageFileName(n), fs.readFileSync(file));
    imageCount++;
  }

  // --- 7 bước kịch bản -----------------------------------------------------------------------
  const scriptNode = db.nodes.find(n => n.kind === 'script');
  const steps = scriptFiles(scriptNode);
  for (const s of steps) add(s.name, s.text);

  // --- prompt + Bible + manifest (giống /api/export, nhưng nằm trong gói) --------------------
  add(
    'prompts.json',
    JSON.stringify(
      {
        project: db.name,
        version: 2,
        edges: db.edges,
        audio: db.audio,
        shots: db.nodes.map(n => ({
          shotId: n.id,
          name: n.name,
          start: n.start,
          duration: n.duration,
          lyric: n.lyric,
          prompts: prompts(n),
          references: assetRefs(n),
          image: n.image,
          video: n.video,
          stale: !!n.stale,
        })),
      },
      null,
      2,
    ),
  );
  add('bible.json', JSON.stringify(buildBible(db), null, 2));
  // buildManifest trả { rows, csv } — chỉ đóng gói làn nào thật sự có shot, để người nhận không
  // mở ra hai file CSV rỗng rồi tưởng hỏng.
  for (const [stream, label] of [
    ['A', 'manifest-luong-A.csv'],
    ['B', 'manifest-luong-B.csv'],
  ]) {
    const { rows, csv } = buildManifest(db.nodes, stream);
    if (rows.length) add(label, csv);
  }

  // --- tờ khai: mở zip ra là biết trong đó có gì và thiếu gì ---------------------------------
  add(
    'DOC-TRUOC.txt',
    [
      `Gói dự án: ${db.name || '(không tên)'}`,
      `Đóng gói lúc: ${new Date().toISOString()}`,
      '',
      `video/        ${files.filter(f => f.name.startsWith('video/') && !f.name.startsWith('video/nhom/')).length} clip shot lẻ` +
        (skipped ? ` (bỏ qua ${skipped} clip thiếu file trên đĩa)` : ''),
      `video/nhom/   ${files.filter(f => f.name.startsWith('video/nhom/')).length} clip của nhóm (Seedance / phân cảnh ghép)`,
      `anh/          ${files.filter(f => f.name.startsWith('anh/') && !f.name.startsWith('anh/nhom/')).length} ảnh node (nhân vật, bối cảnh, khung shot…)` +
        (imageSkipped ? ` (bỏ qua ${imageSkipped} ảnh thiếu file trên đĩa)` : ''),
      `anh/nhom/     ${files.filter(f => f.name.startsWith('anh/nhom/')).length} ảnh của nhóm (storyboard, khung ghép)`,
      `kich-ban/     ${steps.length} bước của xưởng kịch bản` +
        (scriptNode ? '' : ' — project này chưa có node Kịch bản nên các bước đều trống'),
      'prompts.json  prompt ảnh/video đã giải của từng shot + tham chiếu',
      'bible.json    nhân vật, bối cảnh, trang phục, máy quay, phong cách (dùng lại cho tập sau)',
      'manifest-*.csv  bảng dựng theo mốc giây; cột ClipFile khớp đúng tên file trong video/',
      '',
      'Tên file đặt theo node: video clip = <số cảnh>_<tên shot>_v<phiên bản>; ảnh = <số cảnh>_<tên> hoặc <tên node>.',
      'Clip và ảnh của NHÓM (một clip gom nhiều shot) nằm trong thư mục con nhom/.',
    ].join('\n'),
  );

  return {
    files,
    bytes,
    clips: clipCount,
    images: imageCount,
    skipped,
    imageSkipped,
    steps: steps.length,
  };
}

export const packageName = db =>
  safeFolder(db.name) + '-' + new Date().toISOString().slice(0, 10) + '.zip';
