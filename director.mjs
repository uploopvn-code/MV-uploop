// "Đạo diễn": turns a production blueprint (from the master prompt) into a full
// node graph — assets + style + camera setting nodes + storyboard shots — and
// wires every shot to the assets / style / camera it uses.
import crypto from 'node:crypto';
import { defaultNaming } from './output-config.mjs';

// The master prompt the user pastes into an LLM, plus the output contract that
// makes its result machine-buildable. Served to the UI's "copy" button.
export const MASTER_PROMPT = `MASTER PROMPT — ĐẠO DIỄN SẢN XUẤT MV AI (XUẤT JSON BLUEPRINT)
Vai trò: Bạn là Đạo diễn Điện ảnh & Nhà sản xuất Âm nhạc chuẩn Hollywood. Từ một bài hát
(tên / link / lời / mô tả), hãy thiết kế TOÀN BỘ hồ sơ sản xuất MV Live Concert sân khấu lớn
rồi XUẤT RA DUY NHẤT một khối JSON (trong \`\`\`json ... \`\`\`) để công cụ tự dựng & nối node.

HÃY THIẾT KẾ ĐẦY ĐỦ CÁC PHẦN SAU rồi gói tất cả vào JSON:

1) TẠO HÌNH CA SĨ & NHẠC CÔNG (assets role="character")
   - Ca sĩ chính: model sheet / visual reference 1 dòng (ngoại hình, trang phục, thần thái,
     ánh sáng, 35mm photorealistic). Đây là "nhân vật" dùng lại cho mọi cảnh.
   - Mỗi nhạc công chủ chốt phù hợp thể loại (guitarist, drummer, pianist, bassist...): 1 asset
     riêng, prompt toàn thân đang chơi + thần thái.

2) TẠO HÌNH BỐI CẢNH / SÂN KHẤU (assets role="scene")
   - Sân khấu chính, hậu cảnh, ánh sáng concert, khán đài, đạo cụ... mỗi bối cảnh 1 asset,
     prompt wide 1 dòng. Đây là nơi nhân vật sẽ được ghép vào.

3) STYLE CHUNG (style)
   - Một chuỗi mô tả phong cách hình ảnh áp cho cả MV: định dạng phim (35mm/anamorphic),
     film stock (Kodak/Panavision), bảng màu, grain, "photorealistic, no CGI"...

4) CÁC CỠ CẢNH / MÁY QUAY (cameras)
   - Liệt kê các cỡ cảnh của nhân vật kết hợp với style: wide (toàn sân khấu), medium (nửa người),
     close-up (cận mặt/cảm xúc), macro (cận tay/nhạc cụ), và các góc đặc trưng khác nếu cần.
   - Mỗi camera là một "cỡ cảnh" tái sử dụng được, config mô tả khung hình + chuyển động + ánh sáng.

5) STORYBOARD (shots) — mỗi shot là MỘT cảnh video 8–10 giây
   - "uses": liệt kê đúng "key" của những asset (nhân vật + bối cảnh) ghép vào shot đó.
   - "camera": 1 "key" trong cameras (cỡ cảnh của nhân vật khi kết hợp style).
   - "lyric": đúng đoạn lời hát của cảnh (để lip-sync).
   - "videoPrompt": 1 dòng tiếng Anh "Pace: ... . Prompt Video: ...", nhúng mouth articulates: "...",
     dùng tag @Singer/@Guitarist..., KẾT THÚC bằng:
     , clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHỈ XUẤT MỘT KHỐI JSON duy nhất theo schema sau (không thêm bất kỳ chữ nào ngoài khối JSON):

\`\`\`json
{
  "project": { "name": "Tên MV", "theme": "music" },
  "style": "Cinematic 35mm, Kodak Vision3, teal-orange grade, fine film grain, photorealistic, no CGI.",
  "assets": [
    { "key": "singer",    "role": "character", "name": "Ca sĩ chính", "prompt": "<model-sheet ca sĩ 1 dòng>" },
    { "key": "guitarist", "role": "character", "name": "Guitarist",   "prompt": "<prompt guitarist 1 dòng>" },
    { "key": "drummer",   "role": "character", "name": "Drummer",     "prompt": "<prompt drummer 1 dòng>" },
    { "key": "stage",     "role": "scene",     "name": "Sân khấu chính", "prompt": "<wide stage prompt 1 dòng>" }
  ],
  "cameras": [
    { "key": "wide",   "name": "Wide",     "config": "Wide establishing shot, full stage, slow dolly, 35mm." },
    { "key": "medium", "name": "Medium",   "config": "Waist-up medium shot, rim light, shallow depth." },
    { "key": "close",  "name": "Close-up", "config": "Emotional close-up on face, catchlight, soft key." },
    { "key": "macro",  "name": "Macro",    "config": "Macro on hands/instrument, high detail." }
  ],
  "shots": [
    {
      "name": "Shot 1 — Intro",
      "start": 0, "duration": 8,
      "uses": ["singer", "stage"],
      "camera": "wide",
      "lyric": "lời hát đúng đoạn",
      "videoPrompt": "Pace: steady 68 BPM, slow push-in. Prompt Video: slow dolly-in on @Singer center stage, mouth articulates: \\"...\\", concert lights pulsing, clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm."
    },
    {
      "name": "Shot 2 — Verse",
      "start": 8, "duration": 8,
      "uses": ["singer", "guitarist"],
      "camera": "medium",
      "lyric": "lời hát đúng đoạn",
      "videoPrompt": "Pace: ... . Prompt Video: @Singer and @Guitarist, mouth articulates: \\"...\\", clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm."
    }
  ]
}
\`\`\`

QUY TẮC:
- "role" của asset chỉ nhận "character" (ca sĩ/nhạc công/nhân vật) hoặc "scene" (sân khấu/bối cảnh/đạo cụ).
- "uses" chỉ chứa các "key" có thật trong "assets"; "camera" chỉ là một "key" có thật trong "cameras".
- Giữ "key" ngắn, không dấu, không trùng. Tạo đủ shot để phủ hết bài hát.
- Công cụ tự xếp node vào 5 khu (Nhân vật · Bối cảnh · Style/Máy quay · Sản xuất · Video) và tự nối
  nhân vật + bối cảnh + cỡ máy + style vào từng shot. KHÔNG viết gì ngoài khối JSON.

LỆNH KÍCH HOẠT: "BẮT ĐẦU: [Tên bài hát / Link / Lời]".`;

// Extracts the blueprint object from LLM text (handles a ```json fence or a bare object).
export function parseBlueprint(input) {
  if (input && typeof input === 'object') return input;
  const text = String(input || '');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf('{'),
    last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  throw new Error('Không đọc được JSON blueprint. Dán đúng khối JSON từ master prompt.');
}

const str = (v, n = 20000) => String(v ?? '').slice(0, n);
const nid = () => 'node-' + crypto.randomUUID();

// Builds nodes + edges from a blueprint and returns { nodes, edges, name, theme }.
// Throws on invalid input. Does not touch audio/fields/output settings.
export function buildGraph(bp) {
  const b = parseBlueprint(bp);
  const assets = Array.isArray(b.assets) ? b.assets : [];
  const cameras = Array.isArray(b.cameras) ? b.cameras : [];
  const shots = Array.isArray(b.shots) ? b.shots : [];
  if (!assets.length) throw new Error('Blueprint thiếu "assets".');
  if (!shots.length) throw new Error('Blueprint thiếu "shots".');
  if (assets.length + cameras.length + shots.length + 1 > 100)
    throw new Error('Blueprint quá lớn (>100 node). Giảm số asset/shot.');

  const nodes = [],
    edges = [];
  const assetId = {},
    camId = {};

  // Style node (one, in the Style/Camera setup zone), connected to every shot.
  let styleId = null;
  if (b.style && str(b.style).trim()) {
    styleId = nid();
    nodes.push({
      id: styleId,
      kind: 'setting',
      settingType: 'style',
      zone: 'setup',
      name: 'Style',
      config: str(b.style, 5000),
    });
  }

  const charRe = /singer|char|vocal|ca s[iĩ]|nh[aâ]n v[aậ]t|artist/i;
  for (const a of assets) {
    const key = str(a.key || a.id || a.name, 100);
    if (!key) continue;
    const id = nid();
    assetId[key] = id;
    // Character / visual-reference assets go to the Nhân vật zone; others to Bối cảnh.
    const isChar =
      a.role === 'character' || a.zone === 'character' || charRe.test(key + ' ' + str(a.name, 100));
    nodes.push({
      id,
      zone: isChar ? 'character' : 'design',
      role: isChar ? 'character' : undefined,
      name: str(a.name || key, 100),
      prompt: str(a.prompt),
      videoPrompt: '',
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
  }
  for (const c of cameras) {
    const key = str(c.key || c.id || c.name, 100);
    if (!key) continue;
    const id = nid();
    camId[key] = id;
    nodes.push({
      id,
      kind: 'setting',
      settingType: 'camera',
      zone: 'setup',
      name: str(c.name || key, 100),
      config: str(c.config || c.prompt, 5000),
    });
  }

  shots.forEach((sh, i) => {
    const id = nid();
    const dur = Number(sh.duration);
    nodes.push({
      id,
      zone: 'production',
      name: str(sh.name || 'Shot ' + (i + 1), 100),
      prompt: str(sh.prompt),
      videoPrompt: str(sh.videoPrompt),
      lyric: str(sh.lyric, 5000),
      start: Number.isFinite(Number(sh.start)) ? Number(sh.start) : i * 8,
      duration: Number.isFinite(dur) && dur > 0 ? dur : 8,
      videoInput: 'refs', // a storyboard shot is driven by the connected asset images
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
    // Wire the shot to each asset it uses.
    const uses = Array.isArray(sh.uses) ? sh.uses : [];
    for (const u of uses) {
      const src = assetId[str(u, 100)];
      if (src) edges.push({ source: src, target: id });
    }
    // Wire its camera size and the shared style.
    const cam = camId[str(sh.camera, 100)];
    if (cam) edges.push({ source: cam, target: id });
    if (styleId) edges.push({ source: styleId, target: id });
  });

  // Drop duplicate edges.
  const seen = new Set();
  const uniqueEdges = edges.filter(e => {
    const k = e.source + '>' + e.target;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    nodes,
    edges: uniqueEdges,
    name: b.project?.name ? str(b.project.name, 100) : null,
    theme: b.project?.theme || null,
  };
}
