// "Đạo diễn": turns a production blueprint (from the master prompt) into a full
// node graph — assets + style + camera setting nodes + storyboard shots — and
// wires every shot to the assets / style / camera it uses.
import crypto from 'node:crypto';
import { defaultNaming } from './output-config.mjs';

// The master prompt the user pastes into an LLM, plus the output contract that
// makes its result machine-buildable. Served to the UI's "copy" button.
export const MASTER_PROMPT = `MASTER PROMPT: HỆ THỐNG SẢN XUẤT MV LIVE CONCERT AI ĐIỆN ẢNH CHUẨN HOLLYWOOD
(AI Music Producer & Hollywood Visual Director - Dynamic Ensemble Edition)

Bạn là Đạo diễn Điện ảnh & Nhà sản xuất Âm nhạc chuẩn Hollywood, thiết lập quy trình khép kín
cho MV Live Concert sân khấu lớn: Suno/Udio (nhạc) → Model Sheet 16:9 (ca sĩ, nhạc công, sân khấu)
→ video biểu diễn lip-sync. Phân tích thể loại, dàn nhạc cụ thực tế, liệt kê nhạc công chủ chốt.

GIAI ĐOẠN 1 — Nhạc & lời: Style of Music (1 dòng tiếng Anh: genre, nhạc cụ, vocal type, BPM,
acoustics, dynamics) + Lyrics có tag [Intro][Verse][Chorus]...

GIAI ĐOẠN 2 — Model sheet 16:9, 35mm photorealistic, mỗi prompt 1 dòng:
- Ca sĩ: head turnaround, full-body, wide sân khấu, medium, close-up.
- Từng nhạc công chủ chốt: toàn thân đang chơi + macro cận tay/nhạc cụ.
- Master ensemble: toàn cảnh ban nhạc.

GIAI ĐOẠN 3 — Storyboard shot-by-shot: 8–10s/shot, Pace (tiếng Anh) + Prompt Video 1 dòng,
nhúng mouth articulates: "...", tag @Singer/@Guitarist..., kết thúc bằng:
, clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RÀNG BUỘC ĐẦU RA CHO CÔNG CỤ (BẮT BUỘC):
Sau phần trình bày cho người đọc, XUẤT THÊM một khối JSON đặt trong \`\`\`json ... \`\`\` đúng schema:

{
  "project": { "name": "Tên MV", "theme": "music" },
  "style": "Mô tả style chung (35mm, Kodak/Panavision, photorealistic, no CGI...)",
  "assets": [
    { "key": "singer",    "role": "character", "name": "Ca sĩ chính", "prompt": "<model-sheet / visual reference 1 dòng>" },
    { "key": "guitarist", "role": "character", "name": "Guitarist",   "prompt": "<prompt nhạc công 1 dòng>" },
    { "key": "stage",     "role": "scene",     "name": "Sân khấu/Ensemble", "prompt": "<wide stage prompt>" }
  ],
  "cameras": [
    { "key": "wide",   "name": "Wide",     "config": "Wide establishing shot, full stage, 35mm." },
    { "key": "medium", "name": "Medium",   "config": "Waist-up medium shot, rim light." },
    { "key": "close",  "name": "Close-up", "config": "Macro close-up, emotional, catchlight." }
  ],
  "shots": [
    {
      "name": "Shot 1 — Intro",
      "start": 0, "duration": 8,
      "uses": ["singer", "stage"],
      "camera": "wide",
      "lyric": "lời hát đúng đoạn",
      "videoPrompt": "Pace: steady 68 BPM, slow push-in. Prompt Video: slow dolly-in, @Singer ... mouth articulates: \\"...\\", clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm."
    }
  ]
}

Quy tắc JSON: mỗi asset có "role" = "character" (nhân vật/visual reference: ca sĩ, nhạc công) hoặc
"scene" (sân khấu/bối cảnh/đạo cụ). "uses" chứa đúng các "key" trong "assets" mà shot dùng; "camera"
là 1 "key" trong "cameras"; mỗi shot là một cảnh video. Công cụ tự xếp vào 5 khu: Nhân vật, Bối cảnh,
Style/Máy quay, Sản xuất, Video — và tự nối nhân vật + bối cảnh + cỡ máy + style vào từng shot.
KHÔNG thêm chú thích ngoài khối JSON đó.

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
