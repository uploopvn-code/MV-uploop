// Tự sửa prompt khi model video TỪ CHỐI dựng, và ghi lại bài học cho agent viết kịch bản.
//
// Hai thứ làm một shot bị từ chối hoặc dựng ra sai, cả hai đều thấy được ngay trong prompt:
//
//  1. AN TOÀN — shot chạy từ ảnh keyframe thì prompts.mjs chèn khối "In it: NV2 — Vietnamese
//     woman, 30 years old, Oval face and dark-brown almond-shaped eyes…" (anchors trong Bible).
//     Mô tả chi tiết mặt/tuổi/dáng của người thật, gắn vào một ảnh photoreal, KHÔNG kèm câu
//     "nhân vật hư cấu" → đúng kiểu bộ lọc an toàn chặn. director.mjs đã bắt buộc câu disclaimer
//     cho ẢNH nhân vật, nhưng đường VIDEO thì chưa có câu nào.
//
//  2. LOGIC — một shot trong tool chỉ có MỘT người nói (trường `lyric`), nên nó tự sinh câu
//     "The line is spoken by NV2 only; everyone else stays silent and listens." Nếu blueprint
//     nhét thêm thoại của người thứ hai vào văn xuôi `videoPrompt` thì prompt tự mâu thuẫn, và
//     người thứ hai cũng không có Voice lock.
//
// Bản sửa KHÔNG đụng nội dung cảnh, thoại hay nhịp — chỉ gỡ hai thứ trên.
import fs from 'node:fs';
import path from 'node:path';
import { data } from './config.mjs';

export const FICTION_LINE =
  'The people in this shot are original fictional AI-generated characters, not real people and ' +
  'not resembling any celebrity, public figure or existing person; any resemblance is purely ' +
  'coincidental.';

// Thang leo khi model video từ chối. `n.rejects` là số lần bị từ chối LIÊN TIẾP đã xảy ra;
// bảng này nói lượt gửi lại NGAY SAU lần thứ đó làm gì. Leo dần từ rẻ và an toàn tới đắt và
// can thiệp sâu — một lần chạy được là xoá bộ đếm và thang về đầu.
//
//   lượt 1  gửi nguyên văn                 (lần đầu, chưa có bước nào)
//   lượt 2  gửi lại nguyên văn             ← sau lần từ chối thứ 1
//   lượt 3  tool sửa prompt rồi gửi        ← sau lần thứ 2
//   lượt 4  AI viết lại prompt rồi gửi     ← sau lần thứ 3
//   lượt 5  gộp ảnh thành lưới rồi gửi     ← sau lần thứ 4
//   dừng                                   ← sau lần thứ 5
export const STEPS = [
  {
    after: 1,
    kind: 'retry',
    label: 'gửi lại nguyên văn',
    why: 'Bộ lọc đôi khi trả lời khác nhau cho cùng một prompt; thử lại một lần trước khi đụng vào nội dung.',
  },
  { after: 2, kind: 'fix', label: 'tool sửa prompt rồi gửi lại' },
  { after: 3, kind: 'ai', label: 'AI viết lại prompt rồi gửi lại' },
  { after: 4, kind: 'grid', label: 'gộp ảnh tham chiếu thành một lưới rồi gửi lại' },
];
export const MAX_ATTEMPTS = STEPS.length + 1; // lượt đầu + mỗi bước một lượt
export const nextStep = rejects => STEPS.find(s => s.after === rejects) || null;

// Lỗi "bị từ chối" (bộ lọc nội dung) khác hẳn lỗi mạng/hết quota: chỉ loại đầu mới sửa được
// bằng cách sửa prompt. Chuỗi thật đã gặp trên Seedvis: "bộ lọc an toàn từ chối".
const REJECT_WORDS = [
  // Mã THẬT Seedvis trả về khi Omni Flash / Veo không dựng (kiểm chứng trên API thật, 2026-10-12):
  //   {"code":"generation_failed","message":"Yêu cầu tạo nội dung thất bại."}
  // Mã này chung chung — Seedvis không tách "bị kiểm duyệt" với lỗi khác. Nhưng cùng một đầu
  // vào hỏng 20+/20 lần, hỏng ngay tức thì: đó là đầu vào bị từ chối, không phải máy chủ trục
  // trặc. Và bước đầu của thang leo là GỬI LẠI NGUYÊN VĂN, nên nếu chỉ là lỗi tạm thì lượt đó
  // qua và không có gì bị sửa.
  /generation_failed/i,
  /tạo nội dung thất bại/i,
  /bộ lọc an toàn/i,
  /từ chối/i, // chuỗi Seedvis thật: "bộ lọc an toàn từ chối", "Prompt bị từ chối"
  /safety/i,
  /moderat/i,
  /content[_\s-]?polic/i, // "content policy" và mã lỗi "content_policy"
  /violat/i,
  /reject/i,
  /refus/i,
  /blocked/i,
  /prohibited/i,
  /not allowed/i,
  /inappropriate/i,
  /sensitive content/i,
  /nsfw/i,
];
export const isRejection = text => {
  const t = String(text || '');
  return !!t && REJECT_WORDS.some(re => re.test(t));
};

// Ai nói trong prompt này: với MỖI câu thoại trong ngoặc kép, lấy mã nhân vật được nhắc gần
// nhất ngay trước nó. Chính xác hơn tách câu, vì thoại tiếng Việt có dấu chấm bên trong.
export function speakersIn(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(/["“]([^"”]{2,300})["”]/g)) {
    const before = t.slice(Math.max(0, m.index - 140), m.index);
    const codes = [...before.matchAll(/\b(NV\d+)\b/g)];
    if (codes.length) out.push(codes.at(-1)[1]);
  }
  return [...new Set(out)];
}

// Câu độc quyền do prompts.mjs sinh, kèm mã người nói ĐƯỢC KHAI (trường `lyric` của shot).
// Thoại của người đó thường KHÔNG nằm trong ngoặc kép ở prompt video — nó chỉ được nhắc tới —
// nên không thể chỉ đếm số câu trong ngoặc kép, phải so với người được khai.
const EXCLUSIVE =
  /is spoken by\s+(\S+?)(?:\s*\(reference image \d+\))?\s+only; everyone else stays silent/i;
const HAS_ANCHORS = / In it: /;

// Soi prompt ĐÃ SINH RA (chính cái bị từ chối) và nói ra từng thứ sửa được.
// `fix` là n.promptFix hiện có: thứ đã sửa rồi thì không báo lại.
export function diagnose(text, fix = {}) {
  const t = String(text || '');
  const found = [];
  if (!fix.noAnchors && HAS_ANCHORS.test(t))
    found.push({
      key: 'noAnchors',
      what: 'bỏ mô tả ngoại hình nhân vật (ảnh đã là ngoại hình)',
      rule:
        'Shot chạy từ ảnh keyframe: KHÔNG tả lại tuổi, khuôn mặt, mắt, tóc, dáng người trong ' +
        'prompt video. Ảnh tham chiếu đã mang ngoại hình; chữ tả thêm chỉ làm bộ lọc an toàn ' +
        'coi đó là người thật và từ chối.',
    });
  if (!fix.fiction && !/fictional/i.test(t))
    found.push({
      key: 'fiction',
      what: 'thêm câu nhân vật hư cấu',
      rule:
        'Mọi prompt VIDEO có người phải kết thúc bằng câu nhân vật hư cấu, giống như prompt ảnh ' +
        'model sheet đã làm.',
    });
  const quoted = speakersIn(t);
  const ex = t.match(EXCLUSIVE);
  const declared = ex?.[1] || '';
  // Mâu thuẫn khi prompt vừa nói "chỉ X nói" vừa cho người khác một câu thoại trong ngoặc kép.
  const others = quoted.filter(c => c !== declared);
  const speakers = [...new Set([declared, ...quoted].filter(Boolean))];
  if (!fix.dropExclusive && ex && others.length)
    found.push({
      key: 'dropExclusive',
      speakers,
      what: `bỏ câu "chỉ một người nói" (shot này có ${speakers.length} người nói: ${speakers.join(', ')})`,
      rule:
        'Một shot thường chỉ được có MỘT người nói. Cần hai người đối đáp trong 8 giây thì viết ' +
        'thành cụm `setups` (phân cảnh ghép ⑦), đừng nhét câu thoại thứ hai vào văn xuôi ' +
        'videoPrompt — tool không thấy nó, nên vẫn sinh ra câu "chỉ X nói" mâu thuẫn và người ' +
        'thứ hai không được khoá giọng.',
    });
  return found;
}

// --- Bước AI viết lại -------------------------------------------------------------------
// Chỉ chạy khi tool đã sửa bằng luật cứng mà vẫn bị từ chối. Ràng buộc chặt: AI được đổi CÁCH
// VIẾT, không được đổi chuyện. Thoại giữ nguyên từng chữ — đổi thoại là hỏng lip-sync và hỏng
// cả phim, mà model thì rất sẵn lòng "viết cho hay hơn".
export const AI_SYSTEM = `Bạn là người sửa prompt cho model sinh video. Một prompt đã bị BỘ LỌC
NỘI DUNG của model từ chối nhiều lần. Hãy viết lại nó để qua được bộ lọc.

GIỮ NGUYÊN TUYỆT ĐỐI:
- Mọi câu thoại trong ngoặc kép — đúng từng chữ, đúng dấu, không dịch, không rút gọn.
- Ai nói câu nào, thứ tự các nhịp, mốc thời gian, cỡ cảnh và hướng máy.
- Các dòng "Voice lock for ...", "Camera:", "Style:", "Audio:" — giữ nguyên nội dung.
- Khuôn hình (9:16 / 16:9) và số giây.

ĐƯỢC PHÉP SỬA:
- Bỏ mọi mô tả ngoại hình người thật (tuổi, khuôn mặt, mắt, tóc, dáng, màu da). Ảnh đính kèm
  đã mang ngoại hình; chữ tả thêm chính là thứ làm bộ lọc coi đó là người thật.
- Thay từ ngữ có thể bị hiểu là bạo lực, tình dục, giám sát, trẻ em, người nổi tiếng bằng cách
  nói trung tính hơn mà vẫn đúng hành động máy quay thấy.
- Gộp câu lặp, bỏ câu thừa, làm prompt ngắn và rõ hơn.
- Bảo đảm có câu: nhân vật là hư cấu do AI tạo, không phải người thật.

CHỈ trả về prompt đã viết lại. Không giải thích, không tiêu đề, không dấu nháy bao ngoài.`;

export const aiUserPrompt = (text, error) =>
  `Model trả về lý do từ chối: ${String(error || '(không nêu lý do)')}\n\nPROMPT BỊ TỪ CHỐI:\n${text}`;

// AI trả về rác thì thà giữ prompt cũ còn hơn gửi đi một thứ hỏng. Kiểm tối thiểu: có nội dung,
// không dài bất thường, và KHÔNG được đánh mất câu thoại nào.
export function acceptAiRewrite(original, rewritten) {
  const t = String(rewritten || '').trim();
  if (t.length < 40 || t.length > String(original).length * 2 + 2000) return '';
  const quotes = s => [...String(s).matchAll(/["“]([^"”]{2,300})["”]/g)].map(m => m[1].trim());
  const had = quotes(original);
  const now = new Set(quotes(t));
  if (had.some(q => !now.has(q))) return ''; // mất thoại → bỏ
  return t;
}

// --- Sổ học của agent -------------------------------------------------------------------
// Để ở thư mục dữ liệu (không phải trong project) vì bài học rút ở phim này phải áp cho phim
// sau. Mỗi luật ghi một lần; gặp lại thì chỉ tăng đếm.
const rulesFile = () => path.join(data, 'learned-rules.json');

export function loadRules() {
  try {
    const list = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function learn(entries) {
  if (!entries?.length) return loadRules();
  const list = loadRules();
  for (const e of entries) {
    const hit = list.find(x => x.key === e.key);
    if (hit) {
      hit.count = (hit.count || 1) + 1;
      hit.at = new Date().toISOString();
      continue;
    }
    list.push({ key: e.key, rule: e.rule, count: 1, at: new Date().toISOString() });
  }
  try {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(rulesFile(), JSON.stringify(list, null, 2));
  } catch {
    // Không ghi được sổ thì việc sửa prompt vẫn phải chạy tiếp.
  }
  return list;
}

// Khối chèn vào prompt của các trạm viết kịch bản. Luật gặp nhiều lần đứng trước.
export function rulesText() {
  const list = loadRules()
    .slice()
    .sort((a, b) => (b.count || 1) - (a.count || 1));
  if (!list.length) return '';
  return (
    '\n\nBÀI HỌC ĐÃ RÚT TỪ NHỮNG LẦN MODEL VIDEO TỪ CHỐI (bắt buộc tuân theo):\n' +
    list
      .map((r, i) => `${i + 1}. ${r.rule}${r.count > 1 ? ` [gặp ${r.count} lần]` : ''}`)
      .join('\n')
  );
}
