// Đo bài hát THẬT cho node Kịch bản ở chế độ MV có file nhạc.
//
// Đây đúng là nửa đầu của nút ✨ Tạo storyboard tự động (/api/music/auto) — tách ra để node Kịch
// bản dùng chung, thay vì để LLM tự đoán cấu trúc bài. Trước đây, khi node Nhạc "Chưa phân tích",
// thứ duy nhất xưởng kịch bản biết về bài hát là câu "(node nhạc chưa phân tích — chỉ có file/lời)";
// còn khi đã bấm "Phân tích" thì đó là LLM đọc TÊN FILE + lời dạng chữ, không hề nghe audio.
//
// Ở đây máy nghe thật: một lượt Demucs tách vocal + đo đường năng lượng + nhận nhạc cụ, rồi dựng
// KHUNG shot đã khoá giây. Kết quả lưu trên node Nhạc theo đúng file nhạc, nên chạy lại xưởng
// không chạy Demucs lại (mất vài phút trên CPU); đổi file nhạc thì đo lại.
import fs from 'node:fs';
import path from 'node:path';
import { musicProfile } from './lipsync.mjs';
import { lyricSections, skeletonRows } from './music-auto.mjs';
import { mediaDir, save, vocalTasks } from './projects.mjs';

// Khung đã đo của node Nhạc, nếu còn đúng với file nhạc hiện tại.
export const measuredOf = m =>
  m?.measured && m.audio && m.measured.audioId === m.audio.id && m.measured.lyrics === lyricsOf(m)
    ? m.measured
    : null;

const lyricsOf = m => String(m?.lyrics || '').trim();

// Đo bài (hoặc trả bản đã đo). `onProgress(pct)` báo tiến độ Demucs.
// Đổi số này khi cách dựng khung đổi (vd đọc tên đoạn đa ngôn ngữ): bản đã đo được dựng lại khung
// từ hồ sơ đã lưu — không chạy Demucs lại.
const SKELETON_V = 2;
const frame = (lyrics, total, profile, location) =>
  skeletonRows(lyricSections(lyrics), {
    total,
    energyCurve: profile.energy_curve,
    lo: profile.lo_db,
    hi: profile.hi_db,
    location,
  });

export async function measureSong(m, { onProgress = () => {}, location } = {}) {
  const hit = measuredOf(m);
  if (hit) {
    if (hit.v !== SKELETON_V) {
      hit.rows = frame(hit.lyrics, hit.total, hit.profile, location);
      hit.v = SKELETON_V;
      save();
    }
    return hit;
  }
  if (!m?.audio) throw new Error('Node Nhạc chưa có file nhạc — tải file lên node Nhạc trước.');
  const audioFile = path.join(mediaDir, m.audio.id);
  if (!fs.existsSync(audioFile))
    throw new Error('Không tìm thấy file nhạc của node Nhạc trên đĩa.');
  const lyrics = lyricsOf(m);
  if (!lyrics)
    throw new Error(
      'Node Nhạc chưa có LỜI bài hát. Dán lời vào node Nhạc: khung shot được chia theo từng câu ' +
        'hát, và luồng hát nhép cần lời để căn khẩu hình.',
    );

  // Một bài chỉ chạy một tác vụ dài một lúc: đợi lượt tách vocal đang chạy (bắt đầu từ lúc tải
  // file lên) xong đã — cùng khoá vocalTasks với /api/music/auto, nên Demucs không chạy hai lần.
  if (vocalTasks.has(m.id)) await vocalTasks.get(m.id).catch(() => {});

  const audioId = m.audio.id;
  const { profile, vocals } = await musicProfile(audioFile, {
    lyricsText: lyrics,
    outDir: mediaDir,
    onProgress,
  });
  // File nhạc đổi trong lúc đang đo (vài phút) → kết quả này là của bài cũ, bỏ.
  if (m.audio?.id !== audioId) {
    if (vocals) fs.rmSync(path.join(mediaDir, vocals.id), { force: true });
    throw new Error('File nhạc vừa đổi trong lúc đang đo — chạy lại.');
  }
  if (vocals) {
    if (!m.vocals)
      m.vocals = vocals; // luồng hát nhép sẽ cắt từ đây
    else fs.rmSync(path.join(mediaDir, vocals.id), { force: true }); // đã có một bản
  }
  const total = Number(profile.total) || Number(m.audioDuration) || 0;
  if (!(total > 1))
    throw new Error('Bài quá ngắn hoặc chưa đo được thời lượng — kiểm tra file nhạc.');
  if (!Number.isFinite(m.audioDuration)) m.audioDuration = total;
  const rows = frame(lyrics, total, profile, location);
  if (!rows.length) throw new Error('Không dựng được khung từ lời bài hát.');
  m.measured = {
    v: SKELETON_V,
    audioId,
    lyrics,
    total,
    feel: profile.feel === 'nhanh' ? 'nhanh' : 'cham',
    profile,
    rows,
    at: new Date().toISOString(),
  };
  save();
  return m.measured;
}

// Tóm tắt khung đã đo thành vài dòng cho các trạm sáng tạo đọc (treatment cần biết bài dài bao
// nhiêu, có mấy chặng, năng lượng leo ở đâu — chứ không cần cả bảng).
export function measuredBrief(meas) {
  if (!meas) return '';
  const sections = [];
  for (const r of meas.rows) {
    const name = r.Section || r.section;
    const last = sections.at(-1);
    if (last && last.name === name) last.end = r.End ?? r.end;
    else sections.push({ name, start: r.Start ?? r.start, end: r.End ?? r.end, energy: r.Energy });
  }
  return (
    'BÀI HÁT — TOOL ĐÃ ĐO TỪ AUDIO THẬT (không phải đoán):\n' +
    `- Thời lượng: ${Math.round(meas.total)} giây\n` +
    `- Nhịp: ${meas.feel === 'nhanh' ? 'nhanh' : 'chậm'}\n` +
    `- Nhạc cụ nghe thấy: ${(meas.profile?.instruments || []).join(', ') || '(không rõ)'}\n` +
    `- Số ô shot của luồng phủ cảnh: ${meas.rows.length}\n` +
    '- Các chặng:\n' +
    sections
      .map(
        s =>
          `  · ${s.start} → ${s.end}  ${s.name}${s.energy ? ` (năng lượng ${s.energy}/10)` : ''}`,
      )
      .join('\n')
  );
}
