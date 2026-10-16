// Xưởng kịch bản: ý tưởng → truyện → bảng shot → blueprint JSON, có QC tự sửa.
//
// Khác với Trợ lý đạo diễn (một lượt LLM cho mỗi bước), xưởng chạy nhiều trạm nối tiếp rồi
// KIỂM bằng chính validator của tool — buildGraph dựng thử, cộng các luật của phân cảnh ghép
// (trần ảnh/nhịp, identity_label, người nói, hướng mặt, nhịp thoại tính bằng đúng hàm chia 8
// giây). Lỗi bắt được đẩy ngược lại cho LLM sửa, tối đa MAX_FIX vòng.
import { buildGraph, parseBlueprint } from '../director.mjs';
import { rulesText } from './prompt-doctor.mjs';
import {
  CLIP_SECONDS,
  FRAMINGS,
  MAX_BEATS,
  MAX_FRAMES,
  WORDS_PER_SECOND,
  beatSeconds,
} from './merged.mjs';
// Bước "điền khung" của MV có file nhạc dùng LẠI nguyên bộ của nút ✨ Tạo storyboard tự động —
// cùng prompt điền, cùng bộ kiểm, cùng bảng CSV — nên đầu ra nhập thẳng vào bộ dựng hai luồng.
import {
  extractCsv,
  CAST_SPEC,
  fillPrompt as mvFillPrompt,
  fixPrompt as mvFixPrompt,
  rowsToCsv,
  parseCast,
  validateFilled,
} from './music-auto.mjs';

export const MAX_FIX = 2; // số vòng tự sửa sau khi QC bắt lỗi
export const MODES = ['fast', 'full'];

const CONTRACT = `HỢP ĐỒNG JSON (Drama Tool importer) — bám đúng, không tự chế field:
{ "project": {"title","theme":"film","logline","beat_sheet":{setup,tension_rising,confrontation,reveal,aftermath}},
  "styles":[{key,name,prompt}], "audio":[{key,name,prompt}], "cameras":[{key,name,config}],
  "assets":[...], "shots":[...] }
- Nhân vật: {key,role:"character",name,code:"NV1",identity_label,back_view,physical_anchors[],voice_profile{gender,age_sound,timbre,accent,pacing,emotional_baseline},prompt}
  · identity_label = nhãn 2–5 chữ TIẾNG ANH tả đặc điểm NHÌN THẤY ("the auburn-haired woman"), KHÔNG tên riêng.
  · back_view = tả lưng tiếng Anh (tóc sau + vai bộ đang mặc). Bắt buộc nếu nhân vật vào cụm thoại có ots_a/ots_b.
- Bối cảnh: {key,role:"scene",name,prompt,conversation:{place,two_shot,left:{anchor,background,light},right:{...}}}
- Cụm thoại (một clip 8 giây, 2–${MAX_BEATS} nhịp cắt): shot KHÔNG có camera/videoPrompt; thay bằng
  {name,start,duration:8,uses[],style,audio,place,sides:{left,right},setups:[{framing:"ots_a"|"ots_b"|"two_shot",dialogue,audio_delivery,action}]}
  · Chỉ có 3 cỡ cảnh, nên từ nhịp thứ 4 PHẢI dùng lại cỡ cảnh đã có (A/B/A/B/two-shot) — tool dựng 1 ảnh cho mỗi
    cỡ cảnh khác nhau (≤${MAX_FRAMES} ảnh) rồi cắt qua lại.
  · dialogue mở đầu 'Tên: "lời"' với ĐÚNG name nhân vật (hoặc code). Trong ots_a người nói là người bên PHẢI,
    trong ots_b là người bên TRÁI.
  · Nhịp thoại: tool chia 8 giây theo số từ rồi làm tròn giây nguyên. 4 nhịp → lời ≤5–6 chữ; 5 nhịp → ≤4–5 chữ;
    ${MAX_BEATS} nhịp → phần lớn nhịp chỉ 1 giây nên lời PHẢI ≤3 chữ. Nhịp im lặng viết '[Không thoại; …]'.
- Shot thường: {name,start,duration,uses[],camera,style,audio,dialogue,audio_delivery,videoPrompt}
  · videoPrompt PHẢI lặp lời thoại kèm 'mouth articulates ... in perfect lip-sync: "<lời>"'.
  · Tên riêng CHỈ được nằm trong dấu nháy của lời thoại; ngoài đó gọi bằng @NV1/@NV2.
  · KHÔNG mô tả hành vi bạo lực (model video sẽ từ chối dựng): tả thứ máy quay thấy sau đó, đừng tả cú đánh.`;

const STORY = `Bạn là Biên kịch. Từ brief, viết STORY BIBLE dạng văn xuôi tiếng Việt:
1) logline (ai muốn gì — ai cản — hậu quả nếu thua) và thematic_core.
2) dramatic_question trả lời được bằng có/không.
3) beat_sheet 5 nhịp: setup → tension_rising → confrontation → reveal → aftermath, mỗi nhịp một câu.
4) Nhân vật: tên + vai xã hội, mục tiêu, thế lực, cung thay đổi. Kèm gợi ý giọng nói.
5) Bối cảnh chính và vì sao kịch chọn chỗ đó.
6) Thoại từng nhịp, MỖI câu kèm internal_subtext (miệng một đằng, lòng một nẻo).
Bản địa hoá đúng quốc gia trong brief (tên, chỗ ở, phong thái). Thoại phải ngắn và có subtext,
tránh khẩu hiệu. CHỈ trả về văn xuôi, không JSON.`;

const SHOTS = `Bạn là Đạo diễn Hình ảnh kiêm Trục/Blocking kiêm Biểu cảm kiêm Nhịp phim.
Từ story bible, lập BẢNG SHOT (văn xuôi có đánh số), mỗi lượt render = MỘT clip 8 giây:
- Cỡ cảnh + chuyển máy + ánh sáng, kèm LÝ DO tâm lý cho từng lượt.
- axis_180 và blocking: ai đứng đâu, ai nắm quyền trong nhịp đó, hướng nhìn ngược nhau khớp.
- Biểu cảm bám internal_subtext (cơ mặt, ánh mắt, nhịp thở, tay) — tiếng Anh, KHÔNG tả ngoại hình.
- beat + emotional_value (1–10) + số nhịp cắt của lượt đó. Đường cảm xúc phải leo rồi đổ.
- Đoạn đối đáp nhanh thì dùng cụm thoại nhiều nhịp (tối đa ${MAX_BEATS}) tái dùng cỡ cảnh;
  đoạn lặng / thú nhận / sụp đổ thì để một take đơn 8 giây.
CHỈ trả về bảng shot, không JSON.`;

const ASSEMBLE = `Bạn là kỹ thuật viên Đồng bộ. Ráp story bible + bảng shot thành MỘT khối JSON blueprint.
${CONTRACT}
Chỉ trả về đúng một khối JSON, không thêm chữ nào ngoài khối JSON.`;

// --- Chế độ MV: brief có một bài hát (node Nhạc nối vào) ------------------------------------
const MV_STORY = `Bạn là Đạo diễn MV. Brief có SẴN một bài hát kèm phân tích (cấu trúc theo giây, lời,
bpm, mood). KHÔNG bịa lại bài hát — bám đúng mốc giây và lời đã cho.
Viết TREATMENT MV dạng văn xuôi tiếng Việt:
1) concept một câu: MV này kể/gợi điều gì, và vì sao nó hợp với mood + lời bài này.
2) Nhân vật xuất hiện (ca sĩ và/hoặc diễn viên): ngoại hình để dựng model sheet, vai trò trong MV.
3) Bối cảnh chính (1–3 chỗ) và vì sao chọn.
4) Mạch hình theo TỪNG ĐOẠN của bài (Intro / Verse / Chorus / Bridge / Outro…): đoạn đó thấy gì,
   năng lượng hình ảnh lên hay xuống, bám đường năng lượng đã cho.
5) Quy ước hát nhép: đoạn nào thấy mặt ca sĩ hát (lip-sync), đoạn nào là hình phủ cảnh.
CHỈ trả về văn xuôi, không JSON.`;

const MV_SHOTS = `Bạn là Đạo diễn Hình ảnh của MV. Từ treatment + cấu trúc bài hát, lập BẢNG SHOT
PHỦ KÍN cả bài, theo đúng mốc giây đã cho:
- Mỗi lượt render là MỘT clip 8 giây (lượt cuối có thể ngắn hơn để khớp tổng thời lượng).
- Các lượt phải nối liền: lượt sau bắt đầu đúng chỗ lượt trước kết thúc, bắt đầu từ 0, phủ hết bài.
- Mỗi lượt ghi: mốc giây, thuộc đoạn nào, CÓ hát nhép hay không, đoạn LỜI hát đúng trong khoảng đó
  (chép nguyên văn từ phân tích, không bịa), cỡ cảnh + chuyển máy + ánh sáng kèm lý do.
- Chorus / cao trào cắt nhanh hơn (nhiều lượt ngắn hơn), Verse thong thả hơn.
- Biểu cảm tả bằng TIẾNG ANH (cơ mặt, ánh mắt, nhịp thở, tay), KHÔNG tả ngoại hình.
CHỈ trả về bảng shot, không JSON.`;

const MV_ASSEMBLE = `Bạn là kỹ thuật viên Đồng bộ MV. Ráp treatment + bảng shot thành MỘT khối JSON blueprint.
${CONTRACT}
RIÊNG CHO MV:
- Mỗi shot là shot thường (có camera + videoPrompt), KHÔNG dùng cụm "setups" trừ khi thật sự có đối thoại.
- "start" và "duration" tính bằng giây, nối liền nhau, bắt đầu 0, phủ HẾT thời lượng bài hát.
- Shot có hát nhép: đặt đoạn lời đúng của khoảng đó vào trường "dialogue", và videoPrompt phải có
  'mouth articulates ... in perfect lip-sync: "<đoạn lời>"'. Shot phủ cảnh (không thấy miệng hát) để
  "dialogue" trống và KHÔNG viết động từ nói trong videoPrompt.
Chỉ trả về đúng một khối JSON, không thêm chữ nào ngoài khối JSON.`;

// Chế độ nhanh gộp ②–⑤ vào một lượt; chế độ kỹ tách để sửa có địa chỉ.
const FAST = [
  { key: 'story', label: '① Biên kịch', system: STORY, from: b => b },
  {
    key: 'shots',
    label: '②–⑤ Hình ảnh · trục · biểu cảm · nhịp',
    system: SHOTS,
    from: (b, s) => s.story,
  },
  {
    key: 'blueprint',
    label: '⑥ Ráp JSON',
    system: ASSEMBLE,
    from: (b, s) => `BRIEF:\n${b}\n\nSTORY BIBLE:\n${s.story}\n\nBẢNG SHOT:\n${s.shots}`,
  },
];
const FULL = [
  { key: 'story', label: '① Biên kịch', system: STORY, from: b => b },
  {
    key: 'look',
    label: '② Đạo diễn hình ảnh',
    system:
      'Bạn là Đạo diễn Hình ảnh. Từ story bible, chọn cỡ cảnh + chuyển máy + ánh sáng cho từng lượt render 8 giây, mỗi lựa chọn kèm LÝ DO tâm lý. Không viết thoại, không chọn blocking. Chỉ trả về bảng.',
    from: (b, s) => s.story,
  },
  {
    key: 'blocking',
    label: '③ Trục & blocking',
    system:
      'Bạn là người lo Trục 180 và Blocking. Thêm axis_180 + vị trí/thế quyền lực/hướng nhìn cho từng lượt. Hướng nhìn hai chiều phải khớp; máy chỉ ở một bên trục. Giữ nguyên cỡ cảnh đã chọn. Chỉ trả về bảng.',
    from: (b, s) => `${s.story}\n\nBẢNG CỠ CẢNH:\n${s.look}`,
  },
  {
    key: 'faces',
    label: '④ Biểu cảm',
    system:
      'Bạn lo Biểu cảm. Với mỗi lượt, viết câu tả cơ mặt / ánh mắt / nhịp thở / tay bằng TIẾNG ANH, bám internal_subtext chứ không bám bề mặt thoại. KHÔNG tả ngoại hình (tóc, tuổi, quần áo). Giữ nguyên cỡ cảnh và blocking. Chỉ trả về bảng.',
    from: (b, s) => `${s.story}\n\nBẢNG:\n${s.blocking}`,
  },
  {
    key: 'shots',
    label: '⑤ Nhịp phim',
    system: `Bạn lo Nhịp phim. Gán beat + emotional_value (1–10) + số nhịp cắt cho từng lượt render 8 giây. Đối đáp nhanh dùng cụm thoại tối đa ${MAX_BEATS} nhịp tái dùng cỡ cảnh; đoạn lặng để take đơn. Đường cảm xúc leo rồi đổ, không đi ngang. Chỉ trả về bảng shot hoàn chỉnh.`,
    from: (b, s) => `${s.story}\n\nBẢNG:\n${s.faces}`,
  },
  {
    key: 'blueprint',
    label: '⑥ Ráp JSON',
    system: ASSEMBLE,
    from: (b, s) => `BRIEF:\n${b}\n\nSTORY BIBLE:\n${s.story}\n\nBẢNG SHOT:\n${s.shots}`,
  },
];
// Có bài hát nối vào thì xưởng chạy chế độ MV: phủ kín bài theo mốc giây thay vì dựng truyện.
const MV_FAST = [
  { key: 'story', label: '① Treatment MV', system: MV_STORY, from: b => b },
  {
    key: 'shots',
    label: '②–⑤ Bảng shot theo bài',
    system: MV_SHOTS,
    from: (b, s) => `${b}\n\nTREATMENT:\n${s.story}`,
  },
  {
    key: 'blueprint',
    label: '⑥ Ráp JSON',
    system: MV_ASSEMBLE,
    from: (b, s) => `BRIEF + BÀI HÁT:\n${b}\n\nTREATMENT:\n${s.story}\n\nBẢNG SHOT:\n${s.shots}`,
  },
];
const MV_FULL = [
  MV_FAST[0],
  {
    key: 'look',
    label: '② Đạo diễn hình ảnh',
    system:
      'Bạn là Đạo diễn Hình ảnh MV. Từ treatment, chọn cỡ cảnh + chuyển máy + ánh sáng cho từng đoạn bài hát, kèm lý do. Chưa chia mốc giây. Chỉ trả về bảng.',
    from: (b, s) => `${b}\n\nTREATMENT:\n${s.story}`,
  },
  {
    key: 'faces',
    label: '④ Biểu cảm',
    system:
      'Bạn lo Biểu cảm cho MV. Với mỗi đoạn, viết câu tả cơ mặt / ánh mắt / nhịp thở / tay bằng TIẾNG ANH, bám mood và lời. KHÔNG tả ngoại hình. Chỉ trả về bảng.',
    from: (b, s) => `${b}\n\nBẢNG:\n${s.look}`,
  },
  {
    key: 'shots',
    label: '⑤ Chia mốc giây',
    system: MV_SHOTS,
    from: (b, s) => `${b}\n\nBẢNG:\n${s.faces}`,
  },
  {
    key: 'blueprint',
    label: '⑥ Ráp JSON',
    system: MV_ASSEMBLE,
    from: (b, s) => `BRIEF + BÀI HÁT:\n${b}\n\nTREATMENT:\n${s.story}\n\nBẢNG SHOT:\n${s.shots}`,
  },
];
// MV có FILE NHẠC: máy đo bài thật trước (tách vocal, đường năng lượng, căn lời theo giây) và
// dựng sẵn một KHUNG đã khoá giây. Các trạm sáng tạo giữ nguyên — treatment, hình ảnh, biểu cảm
// — còn bước cuối không còn "chia mốc giây" + "ráp JSON" nữa: LLM chỉ ĐIỀN cột sáng tạo vào khung
// đó. Mốc giây không còn là thứ LLM đoán (từng lệch tới 25 giây), và đầu ra là đúng bảng CSV mà bộ
// dựng HAI LUỒNG (phủ cảnh + hát nhép) đã dùng và đã chạy thật.
const FILL = {
  key: 'shots',
  label: '⑤ Điền khung bài hát (đã đo)',
  fill: true, // runStudio xử lý riêng: fillPrompt + validateFilled, không có system/from thường
};
// Treatment của MV có file nhạc kết bằng khối ```cast (ai hát, ai xuất hiện, ở đâu): bước điền,
// bộ kiểm và bước dựng đều theo nó — MV kể chuyện không bị ép thành ban nhạc trên sân khấu.
const MVAUDIO_STORY = {
  ...MV_FAST[0],
  system:
    MV_STORY.replace('CHỈ trả về văn xuôi, không JSON.', 'Văn xuôi, không JSON — trừ khối cast ở cuối.') +
    '\n\n' +
    CAST_SPEC,
};
const MVAUDIO_FAST = [MVAUDIO_STORY, FILL];
const MVAUDIO_FULL = [MVAUDIO_STORY, MV_FULL[1], MV_FULL[2], FILL];
// Treatment không có (hoặc hỏng) khối cast — vd viết trước khi có quy ước này: hỏi riêng khối đó.
const CAST_ONLY =
  'Đọc treatment MV dưới đây và chỉ trả về khối cast mô tả đúng nhân vật, bối cảnh của treatment ' +
  '(không viết lại treatment, không thêm chữ nào ngoài khối).\n\n' +
  CAST_SPEC;

export const stages = (mode, kind = 'drama') =>
  kind === 'mvaudio'
    ? mode === 'full'
      ? MVAUDIO_FULL
      : MVAUDIO_FAST
    : kind === 'mv'
      ? mode === 'full'
        ? MV_FULL
        : MV_FAST
      : mode === 'full'
        ? FULL
        : FAST;

// --- QC -----------------------------------------------------------------------------------
const shortName = s =>
  String(s || '')
    .split(/\s*[(—–]\s*/)[0]
    .trim()
    .toLowerCase();
const spokenWords = t => {
  const s = String(t || '');
  const q = s.match(/"([^"]*)"/);
  const body = q ? q[1] : s.split(':').slice(1).join(':');
  return (body.match(/\S+/g) || []).length;
};
const isSilent = d => {
  const t = String(d || '').trim();
  return !t || t.startsWith('[') || /^(không\s+thoại|no\s+dialogue|silent)/i.test(t);
};

// Kiểm một blueprint TRƯỚC khi dựng: trả { ok, errors[], warnings[], blueprint }.
export function qcBlueprint(input) {
  const errors = [];
  const warnings = [];
  let bp;
  try {
    bp = parseBlueprint(input);
  } catch (e) {
    return { ok: false, errors: ['JSON không đọc được: ' + e.message], warnings, blueprint: null };
  }
  // 1) Chính builder của tool dựng thử — bắt mọi lỗi key/dây nối.
  let graph = null;
  try {
    graph = buildGraph(JSON.stringify(bp));
    warnings.push(...(graph.warnings || []));
  } catch (e) {
    errors.push('buildGraph từ chối: ' + e.message);
    return { ok: false, errors, warnings, blueprint: bp };
  }
  // 2) Luật của phân cảnh ghép mà builder không tự kiểm.
  const chars = new Map();
  for (const a of bp.assets || []) if (a?.role === 'character' && a.key) chars.set(a.key, a);
  const wardrobeFor = new Map();
  for (const w of bp.wardrobe || []) if (w?.key && w.for) wardrobeFor.set(w.key, w.for);
  const charOf = k => chars.get(wardrobeFor.get(k) || k) || null;

  for (const sh of bp.shots || []) {
    const tag = sh?.name || 'shot';
    const setups = Array.isArray(sh?.setups) ? sh.setups : null;
    if (!setups) {
      const d = String(sh?.dialogue || '');
      if (d && !isSilent(d) && !/mouth articulat/i.test(String(sh?.videoPrompt || '')))
        warnings.push(`[${tag}] shot có thoại nhưng videoPrompt thiếu khẩu hình.`);
      continue;
    }
    if (setups.length < 2 || setups.length > MAX_BEATS)
      errors.push(`[${tag}] cụm thoại phải có 2–${MAX_BEATS} nhịp, đang ${setups.length}.`);
    const framings = setups.map(s => String(s?.framing || ''));
    for (const f of framings)
      if (!FRAMINGS.includes(f)) errors.push(`[${tag}] cỡ cảnh "${f}" không hợp lệ.`);
    const distinct = [...new Set(framings.filter(f => FRAMINGS.includes(f)))];
    if (distinct.length > MAX_FRAMES)
      errors.push(
        `[${tag}] dùng ${distinct.length} cỡ cảnh khác nhau; Veo nhận tối đa ${MAX_FRAMES} ảnh.`,
      );
    const sides = sh.sides || {};
    const left = charOf(sides.left);
    const right = charOf(sides.right);
    for (const [k, c] of [
      ['left', left],
      ['right', right],
    ]) {
      if (!c) {
        errors.push(`[${tag}] sides.${k} không trỏ tới một nhân vật.`);
        continue;
      }
      if (!String(c.identity_label || '').trim())
        errors.push(
          `[${tag}] nhân vật "${c.name || c.key}" thiếu identity_label (nhãn 2–5 chữ tiếng Anh).`,
        );
      if (framings.some(f => f === 'ots_a' || f === 'ots_b'))
        if (!String(c.back_view || '').trim())
          errors.push(
            `[${tag}] nhân vật "${c.name || c.key}" thiếu back_view (cụm có khung qua vai).`,
          );
    }
    // Người nói + hướng mặt + nhịp thoại
    const allow = [left, right]
      .filter(Boolean)
      .flatMap(c => [shortName(c.name), String(c.code || '').toLowerCase()].filter(Boolean));
    const counts = setups.map(s => (isSilent(s?.dialogue) ? 0 : spokenWords(s?.dialogue)));
    const secs = beatSeconds(counts);
    setups.forEach((s, i) => {
      const d = String(s?.dialogue || '');
      if (isSilent(d)) return;
      const m = d.match(/^\s*([^:[\]"]+?)\s*:/);
      if (!m) {
        errors.push(`[${tag}] nhịp ${i + 1}: thoại phải mở đầu 'Tên: "lời"'.`);
        return;
      }
      const prefix = m[1]
        .replace(/\(.*?\)/g, '')
        .trim()
        .toLowerCase();
      const hit = allow.some(
        nm => nm.startsWith(prefix) || prefix.startsWith(nm + ' ') || prefix === nm,
      );
      if (!hit)
        errors.push(
          `[${tag}] nhịp ${i + 1}: người nói "${m[1].trim()}" không khớp tên nhân vật trong sides (${[...new Set(allow)].join(', ')}).`,
        );
      else {
        const facing = s.framing === 'ots_a' ? right : s.framing === 'ots_b' ? left : null;
        if (facing) {
          const want = [shortName(facing.name), String(facing.code || '').toLowerCase()].filter(
            Boolean,
          );
          if (
            !want.some(nm => nm.startsWith(prefix) || prefix.startsWith(nm + ' ') || prefix === nm)
          )
            errors.push(
              `[${tag}] nhịp ${i + 1} (${s.framing}): người nói phải là người quay mặt về máy (${facing.name || facing.key}).`,
            );
        }
      }
      if (counts[i] > WORDS_PER_SECOND * secs[i])
        warnings.push(
          `[${tag}] nhịp ${i + 1}: ${counts[i]} từ cho ${secs[i]} giây (> ${WORDS_PER_SECOND} từ/giây) — rút ngắn.`,
        );
    });
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > WORDS_PER_SECOND * CLIP_SECONDS)
      warnings.push(`[${tag}] tổng ${total} từ trong ${CLIP_SECONDS} giây — quá nhanh, rút ngắn.`);
  }
  return { ok: errors.length === 0, errors, warnings, blueprint: bp, graph };
}

// Lời nhắc sửa: đưa nguyên JSON + danh sách lỗi, đòi trả lại JSON đã sửa.
export const fixPrompt = (json, errors) =>
  `Blueprint dưới đây bị validator của tool từ chối. Sửa ĐÚNG những lỗi được liệt kê, giữ nguyên mọi thứ khác.\n\nLỖI:\n${errors.map(e => '- ' + e).join('\n')}\n\nBLUEPRINT:\n${json}\n\nChỉ trả về đúng một khối JSON đã sửa.`;

// Chạy cả xưởng. `turn(system,user)` là một lượt LLM; `onStep(step,total,label,key)` báo tiến trình.
// Lỗi của một trạm, có kèm key trạm để gọi lại đúng chỗ đó.
// Người dùng bấm Dừng giữa chừng — không phải lỗi, nên route báo "Đã dừng" chứ không báo hỏng.
export class StudioStopped extends Error {
  constructor() {
    super('Đã dừng theo yêu cầu.');
    this.stopped = true;
  }
}
export class StageError extends Error {
  constructor(key, label, cause) {
    super(`${label}: ${cause}`);
    this.stageKey = key;
  }
}
// Trạm nào còn thiếu kết quả để chạy được từ `from` (các trạm TRƯỚC nó phải có sẵn).
export function missingBefore(mode, kind, from, have = {}) {
  const list = stages(mode, kind);
  const at = list.findIndex(s => s.key === from);
  if (at <= 0) return [];
  return list.slice(0, at).filter(s => !String(have[s.key] || '').trim());
}

// Chạy xưởng. `from` = key trạm bắt đầu (mặc định trạm đầu); `prior` = kết quả các trạm đã có
// (để chạy tiếp mà không làm lại). `onStage(key, text)` gọi NGAY sau mỗi trạm để caller lưu
// xuống đĩa — một trạm sau đó hỏng cũng không làm mất công sức các trạm trước.
export async function runStudio({
  brief,
  mode = 'fast',
  kind = 'drama',
  from = '',
  prior = {},
  turn,
  onStep = () => {},
  onStage = () => {},
  // Bấm Dừng chỉ đặt một cái cờ; vòng lặp phải TỰ kiểm giữa các trạm, nếu không nó cứ chạy hết
  // cả bảy trạm (mỗi trạm một lượt LLM) rồi mới biết là đã bị dừng.
  stopped = () => false,
  // Chế độ 'mvaudio': khung bài hát ĐÃ ĐO { profile, rows, feel } (lib/music-measure.mjs).
  skeleton = null,
}) {
  const list = stages(mode, kind);
  const assemble = kind === 'mv' ? MV_ASSEMBLE : ASSEMBLE;
  const out = { ...prior };
  const start = Math.max(0, from ? list.findIndex(s => s.key === from) : 0);
  const total = list.length + 1; // + vòng QC
  // Sổ học: mỗi lần bác sĩ prompt sửa được một shot bị model từ chối, luật rút ra được ghi lại
  // (lib/prompt-doctor.mjs) và từ đây mọi trạm viết kịch bản đều đọc — nên lỗi đã trả giá một
  // lần thì lần sau không viết lại nữa. Dùng chung cho mọi project.
  const learned = rulesText();
  let filled = null; // kết quả kiểm khung của bước điền (chế độ mvaudio)
  for (let i = start; i < list.length; i++) {
    if (stopped()) throw new StudioStopped();
    const st = list[i];
    onStep(i + 1, total, st.label, st.key);
    if (st.fill) {
      if (!skeleton?.rows?.length)
        throw new StageError(st.key, st.label, 'Chưa có khung bài hát đã đo — đo bài trước.');
      // Hướng sáng tạo lấy từ các trạm trước (treatment, hình ảnh, biểu cảm) và từ skill/brief:
      // đó là thứ quyết định NHÌN THẤY GÌ trong mỗi ô. Còn ô nằm ở giây nào thì khung đã khoá.
      const direction = [
        brief && `BRIEF + SKILL:\n${brief}`,
        out.story && `TREATMENT (trạm ①):\n${out.story}`,
        out.look && `ĐẠO DIỄN HÌNH ẢNH (trạm ②):\n${out.look}`,
        out.faces && `BIỂU CẢM (trạm ④):\n${out.faces}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      let cast = parseCast(out.story);
      if (!cast && out.story) {
        try {
          const block = String((await turn(CAST_ONLY, out.story)) || '').trim();
          if (stopped()) throw new StudioStopped();
          if (parseCast(block)) {
            out.story = out.story + '\n\n' + block;
            await onStage('story', out.story);
            cast = parseCast(out.story);
          }
        } catch (e) {
          if (e instanceof StudioStopped) throw e;
          throw new StageError(st.key, st.label, e.message);
        }
      }
      if (!cast)
        throw new StageError(
          st.key,
          st.label,
          'Treatment (trạm ①) chưa có khối cast (ca sĩ, nhân vật, bối cảnh) — chạy lại từ trạm ①.',
        );
      // Bối cảnh từng hàng do LLM chọn trong các bối cảnh của treatment (khung để trống cột này).
      const rows = skeleton.rows.map(r => ({ ...r, Location: '' }));
      const p = mvFillPrompt(skeleton.profile, rowsToCsv(rows), rows.length, cast);
      let reply;
      try {
        reply = await turn(
          p.system + learned,
          'HƯỚNG SÁNG TẠO — bám sát khi điền, nhưng TUYỆT ĐỐI không đổi Start/End/Section/Lyric ' +
            'hay thêm/bớt hàng:\n\n' +
            direction +
            '\n\n════════\n\n' +
            p.user,
        );
      } catch (e) {
        throw new StageError(st.key, st.label, e.message);
      }
      if (stopped()) throw new StudioStopped();
      filled = validateFilled(skeleton.rows, extractCsv(reply), skeleton.feel, cast);
      out.shots = filled.csv; // luôn là CSV nhập được: validateFilled tự khoá lại cột bị sửa
      await onStage('shots', out.shots);
      continue;
    }
    let text;
    try {
      text = String((await turn(st.system + learned, st.from(brief, out))) || '').trim();
    } catch (e) {
      throw new StageError(st.key, st.label, e.message);
    }
    if (stopped()) throw new StudioStopped(); // lượt vừa về rồi mới bấm Dừng: bỏ, đừng lưu
    if (!text) throw new StageError(st.key, st.label, 'LLM không trả về nội dung.');
    out[st.key] = text;
    await onStage(st.key, text); // lưu ngay, trước khi chạy trạm sau
  }
  onStep(total, total, '⑦ QC', 'qc');
  // MV có file nhạc: QC là kiểm KHUNG (cột bị khoá còn nguyên? cỡ cảnh có lặp? ca sĩ có bị quay
  // chính diện ở luồng phủ cảnh không?) — không có blueprint JSON nào ở chế độ này.
  if (kind === 'mvaudio') {
    const cast = parseCast(out.story);
    if (!filled && out.shots && skeleton?.rows?.length)
      filled = validateFilled(skeleton.rows, out.shots, skeleton.feel, cast); // chạy tiếp từ ⑦
    let best = filled;
    let rounds = 0;
    while (best && !best.ok && rounds < MAX_FIX) {
      if (stopped()) throw new StudioStopped();
      rounds++;
      onStep(total, total, `⑦ QC · sửa vòng ${rounds}`, 'qc');
      const fp = mvFixPrompt(best.errors, best.csv, skeleton.rows.length, cast);
      let r;
      try {
        r = validateFilled(
          skeleton.rows,
          extractCsv(await turn(fp.system + learned, fp.user)),
          skeleton.feel,
          cast,
        );
      } catch (e) {
        throw new StageError('shots', '⑦ QC · sửa', e.message);
      }
      // giữ bản ít lỗi nhất — một lượt sửa tệ hơn không được đè bản tốt hơn
      if (r.errors.length < best.errors.length) {
        best = r;
        out.shots = r.csv;
        await onStage('shots', out.shots);
      }
    }
    return {
      ...out,
      qc: {
        ok: !!best?.ok,
        // validateFilled trả { Shot, loi } — đọc thành một câu, đừng đổ JSON thô ra màn hình.
        errors: (best?.errors || []).map(e =>
          typeof e === 'string'
            ? e
            : e?.Shot
              ? `Shot ${e.Shot}: ${e.loi ?? ''}`
              : JSON.stringify(e),
        ),
        warnings: [],
        rounds,
      },
    };
  }
  let qc = qcBlueprint(out.blueprint);
  let rounds = 0;
  while (!qc.ok && rounds < MAX_FIX) {
    if (stopped()) throw new StudioStopped();
    rounds++;
    onStep(total, total, `⑦ QC · sửa vòng ${rounds}`, 'qc');
    const json = qc.blueprint ? JSON.stringify(qc.blueprint, null, 2) : out.blueprint;
    try {
      out.blueprint = String((await turn(assemble, fixPrompt(json, qc.errors))) || '').trim();
    } catch (e) {
      throw new StageError('blueprint', '⑦ QC · sửa', e.message);
    }
    await onStage('blueprint', out.blueprint);
    qc = qcBlueprint(out.blueprint);
  }
  if (qc.blueprint) out.blueprint = JSON.stringify(qc.blueprint, null, 2);
  return { ...out, qc: { ok: qc.ok, errors: qc.errors, warnings: qc.warnings, rounds } };
}
