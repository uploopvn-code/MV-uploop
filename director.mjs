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
   - Mỗi nhân vật dùng lại cho mọi cảnh; "prompt" là MODEL SHEET TURNAROUND 3 góc. DÙNG ĐÚNG
     công thức đã kiểm chứng và PHẢI kết thúc bằng câu disclaimer nhân vật hư cấu:
     "Character model sheet turnaround of a <tuổi> <sắc tộc/giới> <vai trò>, <nét mặt + tóc +
     vóc dáng + trang phục chính>, portrait on left, front, side and back views on right, neutral
     standing pose, solid gray background, studio lighting, consistent facial identity, cinematic
     35mm photorealistic. This is an original fictional AI-generated character, not a real person
     and not resembling any celebrity, public figure or existing model; any resemblance is purely
     coincidental."
   - Nhạc công / ca sĩ chơi nhạc cụ: THÊM "holding <instrument>" (vd "holding Spanish acoustic
     guitar") để nhạc cụ nằm trong model sheet.

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
    { "key": "singer",    "role": "character", "name": "Ca sĩ chính", "prompt": "Character model sheet turnaround of a 28yo female pop singer, ..., portrait on left, front, side and back views on right, neutral standing pose, solid gray background, studio lighting, consistent facial identity, cinematic 35mm photorealistic. This is an original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is purely coincidental." },
    { "key": "guitarist", "role": "character", "name": "Guitarist",   "prompt": "Character model sheet turnaround of a 40yo male guitarist, ..., holding an acoustic guitar, portrait on left, front, side and back views on right, neutral standing pose, solid gray background, studio lighting, consistent look, cinematic 35mm photorealistic. This is an original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is purely coincidental." },
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

// First stage of the conversational director: turn a bare idea / logline / lyrics into a
// readable KỊCH BẢN (treatment) a human reviews and edits before any JSON is built. Plain
// prose, no JSON — the blueprint stage reuses the master prompt to turn this into JSON.
export const SCRIPT_SYSTEM = `Bạn là Đạo diễn Điện ảnh kiêm Nhà biên kịch. Từ ý tưởng/logline/lời
bài hát người dùng đưa, hãy viết một KỊCH BẢN (treatment) ngắn gọn, mạch lạc bằng tiếng Việt để
con người duyệt trước khi dựng sản xuất. Bố cục:

1) LOGLINE: 1–2 câu.
2) NHÂN VẬT: mỗi nhân vật 1 dòng (tên, ngoại hình, tính cách, vai trò).
3) BỐI CẢNH: các địa điểm/sân khấu chính, mỗi nơi 1 dòng.
4) PHONG CÁCH & TÔNG: hình ảnh, ánh sáng, nhịp.
5) PHÂN CẢNH: đánh số từng cảnh (Cảnh 1, 2, 3…), mỗi cảnh ghi: ai, ở đâu, hành động, và DÒNG
   THOẠI/LỜI đúng của cảnh (đặt trong ngoặc kép). Đủ cảnh để phủ hết câu chuyện/bài hát.

CHỈ viết kịch bản dạng văn xuôi có đánh số, KHÔNG xuất JSON, KHÔNG thêm lời dẫn ngoài kịch bản.
Nếu người dùng đã đưa kịch bản sẵn thì chỉnh trang lại cho đủ bố cục trên.`;

// The blueprint stage feeds the approved script back through the master prompt. This wraps the
// script as the activation command the master prompt expects.
export const blueprintFromScript = script =>
  'BẮT ĐẦU — dựng blueprint từ KỊCH BẢN đã được duyệt dưới đây. Giữ đúng nhân vật, bối cảnh, ' +
  'phân cảnh và lời thoại của kịch bản; mỗi cảnh thành một shot với "lyric" là đúng dòng thoại/lời ' +
  'của cảnh đó.\n\n=== KỊCH BẢN ===\n' +
  script +
  '\n=== HẾT ===\n\nChỉ trả về đúng khối JSON blueprint theo schema đã mô tả, không thêm chữ nào ngoài khối JSON.';

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
// One line from a Bible voice_profile — "Female, Late 30s; timbre: …; accent: …; pacing: …;
// baseline: …" (a plain-string profile passes through). Sent with every line the character speaks.
function voiceOf(vp) {
  if (!vp) return '';
  if (typeof vp !== 'object') return str(vp, 1000).trim();
  const label = {
    timbre: 'timbre',
    accent: 'accent',
    pacing: 'pacing',
    emotional_baseline: 'baseline',
  };
  const parts = [[vp.gender, vp.age_sound].filter(Boolean).join(', ')];
  for (const [k, v] of Object.entries(vp))
    if (k !== 'gender' && k !== 'age_sound' && v != null && String(v).trim())
      parts.push(`${label[k] || k.replace(/_/g, ' ')}: ${String(v).trim()}`);
  return str(parts.filter(Boolean).join('; '), 1000);
}
// The two opposing close angles of a dialogue location, derived from the master view:
// "a" is what camera OTS A sees (over A's shoulder, looking at B), "b" the 180° reverse.
export const ANGLE_PRESETS = {
  a: {
    name: 'góc cận A (sau vai A nhìn B)',
    angle:
      'Reverse angle A of the dialogue: medium-close, looking in the same general direction as the reference view but from much closer, right at the spot where the two speakers stand, eye level, the far side of the location filling the background',
  },
  b: {
    name: 'góc cận B (sau vai B nhìn A)',
    angle:
      'Reverse angle B of the dialogue, the 180-degree counterpart of angle A: the camera now stands at the far end of the playing area and looks back toward where the reference view was taken, medium-close, eye level, showing the side of the location that lies behind the reference camera, designed to match everything visible in the reference',
  },
};
// Which side of a dialogue a camera preset covers: "a" for an over-shoulder-A camera
// (ots_a / "over character A's shoulder"), "b" for its reverse, '' otherwise.
const otsSide = c => {
  if (!c) return '';
  const t = [c.key, c.id, c.name, c.config, c.prompt].map(x => str(x, 500)).join(' ');
  if (
    /over[-_ ]?(the[-_ ]?)?shoulder[-_ ]?a(?![a-z0-9])|(^|[^a-z])ots[-_ ]?a(?![a-z0-9])|character a'?s shoulder/i.test(
      t,
    )
  )
    return 'a';
  if (
    /over[-_ ]?(the[-_ ]?)?shoulder[-_ ]?b(?![a-z0-9])|(^|[^a-z])ots[-_ ]?b(?![a-z0-9])|character b'?s shoulder/i.test(
      t,
    )
  )
    return 'b';
  return '';
};
// A dialogue location's staging, as a merged scene's camera setups need it: the opening
// sentence of every still ("The study from image 1 at night."), then, for each side of the
// frame, what the person standing there has behind them and what light falls on them.
function stagingOf(c) {
  if (!c || typeof c !== 'object') return null;
  const side = s =>
    s && typeof s === 'object'
      ? {
          anchor: str(s.anchor, 500),
          background: str(s.background, 500),
          light: str(s.light || s.lighting, 500),
        }
      : { anchor: '', background: '', light: '' };
  const staging = {
    place: str(c.place, 500),
    two_shot: str(c.two_shot, 500),
    left: side(c.left),
    right: side(c.right),
  };
  return staging.place || staging.left.background || staging.right.background ? staging : null;
}
// The camera setups a merged scene can be written from, and what the frame node is called.
const FRAMINGS = ['ots_a', 'ots_b', 'two_shot'];
const FRAMING_LABEL = {
  ots_a: 'qua vai A',
  ots_b: 'qua vai B',
  two_shot: 'trung đôi',
};
const nid = () => 'node-' + crypto.randomUUID();

// Collects every JSON blueprint from the input: an object, an array of objects, or text
// with one or more ```json blocks. Lets the user paste a feature-mode bible together with a
// sequence file (two blocks) and have them merged.
function collectBlueprints(input) {
  if (Array.isArray(input)) return input.filter(x => x && typeof x === 'object');
  if (input && typeof input === 'object') return [input];
  const text = String(input || '');
  const out = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {}
  }
  if (out.length) return out;
  const first = text.indexOf('{'),
    last = text.lastIndexOf('}');
  for (const c of [first !== -1 && last > first ? text.slice(first, last + 1) : null, text]) {
    if (!c) continue;
    try {
      return [JSON.parse(c)];
    } catch {}
  }
  throw new Error('Không đọc được JSON blueprint. Dán đúng khối JSON từ master prompt / skill.');
}
const arr = v => (Array.isArray(v) ? v : []);

// A blueprint usually bakes "Camera: … Style: …" into each videoPrompt, but the tool
// injects those from the wired camera + style setting nodes. Strip that trailing clause
// so they are not duplicated, leaving the composition + staging description that drives
// both the keyframe image and the video motion.
function baseShotPrompt(sh) {
  const vp = str(sh.videoPrompt);
  const i = vp.search(/\s*Camera\s*:/i);
  const base = (i >= 0 ? vp.slice(0, i) : vp).trim();
  return base;
}

// Drama (VEO) prompts carry "Camera: <config>." mid-prompt, right before "Lighting &
// Physics: …". When the shot is wired to a camera node that node injects "Camera: …", so
// drop just that sentence and keep the staging + lighting + safety tail intact. A prompt
// with no recognisable camera sentence is left untouched.
function stripInlineCamera(vp) {
  return vp
    .replace(/\s*Camera\s*:\s*.*?\.(?=\s+(?:[A-Z]|lighting)|\s*$)/, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Builds nodes + edges from a blueprint and returns { nodes, edges, name, theme }.
// Throws on invalid input. Does not touch audio/fields/output settings.
export function buildGraph(bp) {
  const parts = collectBlueprints(bp).map(p => p.blueprint || p);
  // Merge assets / cameras / styles / shots across all parts, pulling from a feature-mode
  // bible and from split character/scene/prop arrays too. Dedupe each list by key.
  let project = null;
  let film = null; // the film this sequence belongs to (assets are shared across its projects)
  const assets = [],
    cameras = [],
    styles = [],
    audio = [],
    shots = [];
  for (const p of parts) {
    project = project || p.project;
    film = film || p.film || p.bible?.film;
    for (const a of [p.assets, p.bible?.assets, p.characters, p.scenes, p.props].flatMap(arr))
      assets.push(a);
    for (const c of [p.cameras, p.bible?.cameras].flatMap(arr)) cameras.push(c);
    // Background music / on-set sound presets, wired into the shots that use them.
    for (const a of [p.audio, p.sound, p.bible?.audio, p.bible?.sound].flatMap(arr)) audio.push(a);
    // Wardrobe list (costume wiring spec): kind "costume" = one character re-rendered in a
    // new look (input: that character's image), kind "item" = a prop kept in the same
    // column. Older files declare costumes as assets with role "wardrobe"; both work.
    for (const w of [p.wardrobe, p.wardrobes, p.outfits, p.bible?.wardrobe, p.bible?.wardrobes]
      .flatMap(arr)
      .filter(w => w && typeof w === 'object'))
      assets.push({ ...w, role: w.kind === 'item' || w.role === 'item' ? 'item' : 'wardrobe' });
    // Style: a keyed "styles" array (drama bible) and/or one film-level "style" string.
    for (const s of [p.styles, p.bible?.styles].flatMap(arr)) styles.push(s);
    const plain = p.style ?? p.bible?.style;
    if (plain && typeof plain === 'object') styles.push(plain);
    else if (str(plain, 5000).trim()) styles.push({ key: 'style', name: 'Style', prompt: plain });
    for (const s of arr(p.shots)) shots.push(s);
  }
  const b = { project, assets, cameras, shots };
  const dedupe = list => {
    const seen = new Set();
    return list.filter(x => {
      const k = str(x?.key || x?.id || x?.name, 200);
      if (!k || seen.has(k)) return !!k && false;
      seen.add(k);
      return true;
    });
  };
  const uniqAssets = dedupe(assets);
  const uniqCameras = dedupe(cameras);
  const uniqAudio = dedupe(audio);
  const uniqStyles = dedupe(styles);
  if (!uniqAssets.length) {
    const keys = [...new Set(parts.flatMap(p => Object.keys(p)))].join(', ') || '(trống)';
    throw new Error(
      'Blueprint thiếu "assets" (không thấy nhân vật/bối cảnh). Nếu đây là file phân đoạn ' +
        'seq-XX của phim dài, hãy dán kèm cả bible.json (dán cả hai khối JSON vào ô này). ' +
        'Khóa JSON tìm thấy: ' +
        keys +
        '.',
    );
  }
  if (!shots.length) throw new Error('Blueprint thiếu "shots".');

  // Drama (Google VEO) blueprints use project.title, role:"prop" assets and a keyed
  // "styles" array; each shot's videoPrompt bakes in "Camera: … Lighting & Physics: …".
  // A drama shot is wired to its camera + style nodes exactly like a music shot (so
  // editing one node updates every shot that uses it); only the inline "Camera:" sentence
  // is dropped so the wired camera node is the single source — the lighting + safety tail
  // of the VEO prompt stays verbatim.
  const isDrama =
    !!(b.project && b.project.title && !b.project.name) ||
    assets.some(a => ['prop', 'item', 'wardrobe'].includes(a.role));

  const nodes = [],
    edges = [];
  const assetId = {},
    camId = {},
    audioId = {},
    styleId = {};

  // Style nodes (Style/Camera setup zone): one per "styles" entry, or the single
  // film-level "style" string. A shot picks one by key; a lone style is wired to every shot.
  for (const s of uniqStyles) {
    const key = str(s.key || s.id || s.name, 100);
    const config = str(s.prompt || s.config, 5000);
    if (!key || !config.trim()) continue;
    const id = nid();
    styleId[key] = id;
    nodes.push({
      id,
      kind: 'setting',
      settingType: 'style',
      zone: 'setup',
      name: str(s.name || key, 100),
      config,
    });
  }

  const charRe = /singer|char|vocal|ca s[iĩ]|nh[aâ]n v[aậ]t|artist/i;
  const assetKeyOf = a => str(a.key || a.id || a.name, 100);
  // Character by role/zone, or (role-less music assets) by a name hint.
  const isCharAsset = a =>
    a.role === 'character' ||
    a.zone === 'character' ||
    (!a.role && !a.kind && charRe.test(assetKeyOf(a) + ' ' + str(a.name, 100)));
  const charKeys = new Set(uniqAssets.filter(isCharAsset).map(assetKeyOf));
  const sceneKeys = new Set(
    uniqAssets
      .filter(a => a.role === 'scene' || (!a.role && !a.kind && !isCharAsset(a)))
      .map(assetKeyOf),
  );
  const wardrobeOf = {}; // costume key → the character key it dresses ('' when unknown)
  const angleOf = {}; // derived scene key → the scene it is a view of ("of")
  const reverse = new Set(); // scenes that get the two opposing dialogue angles
  const reverseText = {}; // scene key → { a, b } angle descriptions written for that place
  const warnings = [];
  for (const a of uniqAssets) {
    const key = assetKeyOf(a);
    if (!key) continue;
    const id = nid();
    assetId[key] = id;
    // Item (prop/vật dụng) → Trang phục & vật dụng column, rendered on its own as a
    // 3-angle object sheet; costume → same column, rendered FROM its character's image;
    // character → Nhân vật; scenes → Bối cảnh. A prop is an object, never a location, so
    // role:"prop" is treated exactly like an item (the LLM often writes "prop", not "item").
    const isItem = a.role === 'item' || a.role === 'prop' || a.kind === 'item';
    const isWardrobe =
      !isItem && (a.role === 'wardrobe' || a.zone === 'wardrobe' || a.kind === 'costume');
    const isChar = !isItem && !isWardrobe && isCharAsset(a);
    // A scene with "of" is another camera position of that scene (rendered from its image).
    const isScene = !isItem && !isWardrobe && !isChar;
    const sceneUses = arr(a.uses).map(k => str(k, 100));
    const ofKey = isScene
      ? str(a.of || a.master || a.parent, 100) || sceneUses.find(k => sceneKeys.has(k)) || ''
      : '';
    if (ofKey) angleOf[key] = ofKey;
    // A plain location shows all THREE shot sizes — wide + close A + close B — in ONE
    // reference image (a location model sheet, like the character turnaround), rendered once
    // (`sheet3`). reverse_angles:{ a, b } (or true) instead splits them into SEPARATE angle
    // plates, each its own node/render, for over-the-shoulder coverage shots that wire one
    // side; reverse_angles:false (or 'none' / 'off') keeps just the plain wide (for an insert
    // or flashback). A derived angle (it has an "of") is always its own single view.
    const rev = a.reverse_angles ?? a.angles;
    const wantsReverse = rev === true || rev === 'ab' || (rev && typeof rev === 'object');
    const optOutAngles = isScene && !ofKey && (rev === false || rev === 'none' || rev === 'off');
    // The 3-in-1 sheet is the default for a plain scene; a Bible round-trips the opt-out via
    // `noAngles` (it carries no angle children to suppress the sheet otherwise).
    const sheet3 = isScene && !ofKey && !wantsReverse && !optOutAngles;
    if (isScene && !ofKey && wantsReverse) {
      reverse.add(key);
      if (rev && typeof rev === 'object')
        reverseText[key] = { a: str(rev.a, 2000), b: str(rev.b, 2000) };
    }
    if (isWardrobe) {
      // The character this look dresses: "for" / "character" (spec), else the first
      // character key in the costume's own "uses" list.
      const uses = arr(a.uses).map(k => str(k, 100));
      wardrobeOf[key] =
        str(a.for || a.character || a.characterKey || a.of, 100) ||
        uses.find(k => charKeys.has(k)) ||
        '';
    }
    const items = Array.isArray(a.items) ? a.items.join(', ') : a.items;
    nodes.push({
      id,
      zone: isWardrobe || isItem ? 'wardrobe' : isChar ? 'character' : 'design',
      // A master scene carries role:'scene' so the tool owns its reference sheet (prompts.mjs
      // keys the location sheet off role==='scene', and the inspector lets its desc be edited);
      // a derived view takes role:'angle' via the ofKey spread below.
      role: isWardrobe
        ? 'wardrobe'
        : isItem
          ? 'prop'
          : isChar
            ? 'character'
            : isScene && !ofKey
              ? 'scene'
              : undefined,
      assetKey: key, // stable id across sequences → lets the project reuse its image
      name: str(a.name || key, 100),
      // An item's / outfit's / location's blueprint prompt describes the object, garment or
      // place, so it becomes the DESCRIPTION the server wraps in its own reference sheet (a
      // prop turnaround, a headless-mannequin outfit turnaround, or a 3-view location sheet)
      // instead of replacing that sheet — so props, clothing and scenes always come out as the
      // tool's clean references. A derived angle (isScene && ofKey) keeps its own prompt.
      prompt: isItem || isWardrobe || (isScene && !ofKey) ? '' : str(a.prompt),
      ...(isItem || (isScene && !ofKey) ? { desc: str(a.prompt, 2000) } : {}),
      // Physical anchors identify the person to the video model (the prompt's "@key" tags
      // mean nothing to it): the server lists them per reference image, in order.
      ...(isChar && arr(a.physical_anchors).length
        ? { anchors: str(arr(a.physical_anchors).join(', '), 1000) }
        : {}),
      ...(isChar && voiceOf(a.voice_profile) ? { voice: voiceOf(a.voice_profile) } : {}),
      // Code (NV1, NV2…): what the prompt calls this person. Real names raise the odds
      // of the video model refusing "a real person", so they never leave the Bible.
      ...(isChar && str(a.code, 20).trim() ? { code: str(a.code, 20).trim() } : {}),
      // What an over-the-shoulder frame may call this person ("the auburn-haired woman")
      // and what the camera sees of them from behind — the only two things those stills
      // say about a face the attached sheet already shows.
      ...(str(a.identity_label, 200).trim() ? { label: str(a.identity_label, 200).trim() } : {}),
      ...(str(a.back_view, 500).trim() ? { back: str(a.back_view, 500).trim() } : {}),
      // Where the two speakers stand in this location, and the light on each side: a merged
      // scene builds every one of its camera setups from it.
      ...(stagingOf(a.conversation) ? { staging: stagingOf(a.conversation) } : {}),
      ...(sheet3 ? { sheet3: true } : {}),
      ...(optOutAngles ? { noAngles: true } : {}),
      ...(ofKey ? { role: 'angle', ofKey, angle: str(a.angle || a.prompt, 2000) } : {}),
      ...(isWardrobe
        ? { outfit: str(a.outfit || a.wardrobe || a.prompt, 2000), items: str(items, 2000) }
        : {}),
      videoPrompt: '',
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
  }
  // The costume node renders the GARMENT alone (on a mannequin), so it takes no image
  // input — feeding it the person only invites the model to redraw them. It just records
  // which character it dresses; the "NV đã mặc" node below does the try-on.
  for (const [w, c] of Object.entries(wardrobeOf)) {
    if (c && assetId[c]) {
      const node = nodes.find(n => n.id === assetId[w]);
      node.charId = assetId[c];
    } else
      warnings.push(
        `Trang phục "${w}": ` +
          (c ? `nhân vật "${c}" không có trong Bible` : 'thiếu "for" trỏ nhân vật') +
          ' — không dựng được node "NV đã mặc", cảnh sẽ thiếu look này.',
      );
  }
  // Two-stage dressing (virtual try-on). The costume node renders the OUTFIT with its own
  // prompt (a garment on a mannequin is fine); a "look" node then composes character +
  // costume into that same person wearing the outfit, with a prompt the tool controls.
  // Shots use the look, never the raw costume, so Veo always sees a complete, face-locked
  // reference.
  const lookId = {}; // costume key → look node id
  const lookChar = {}; // look node id → its character's node id (for placement)
  for (const [w, c] of Object.entries(wardrobeOf)) {
    if (!c || !assetId[c]) continue;
    const id = nid();
    lookId[w] = id;
    lookChar[id] = assetId[c];
    const costumeName = nodes.find(n => n.id === assetId[w])?.name || w;
    nodes.push({
      id,
      zone: 'character', // a dressed version of the character: Nhân vật column, under them
      role: 'look',
      assetKey: 'look_' + w,
      name: str('NV đã mặc: ' + costumeName, 100),
      prompt: '',
      videoPrompt: '',
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
    edges.push({ source: assetId[c], target: id }); // the face
    edges.push({ source: assetId[w], target: id }); // the outfit
  }
  // Order within a column follows the node list, so slot each look right after its
  // character (and after that character's earlier looks).
  for (const id of Object.values(lookId)) {
    const look = nodes.splice(
      nodes.findIndex(n => n.id === id),
      1,
    )[0];
    let at = nodes.findIndex(n => n.id === lookChar[id]);
    while (nodes[at + 1]?.role === 'look' && lookChar[nodes[at + 1].id] === lookChar[id]) at++;
    nodes.splice(at + 1, 0, look);
  }
  // Scene angles: a scene declared with "of": "<scene>" (+ "angle": what this camera sees)
  // is a derived view of that scene, rendered FROM its image so every angle shows the same
  // place, dressing and light (anti "the room changes between shot sizes").
  const angleMaster = {}; // angle node id → its scene's node id (for wiring + placement)
  for (const [k, of] of Object.entries(angleOf)) {
    const node = nodes.find(n => n.id === assetId[k]);
    const master = nodes.find(n => n.id === assetId[of]);
    if (master && !['character', 'wardrobe', 'prop'].includes(master.role)) {
      edges.push({ source: master.id, target: node.id });
      angleMaster[node.id] = master.id;
      // A scene that has its own separate angle plates is no longer the 3-in-1 sheet: it is a
      // plain wide, and each derived angle renders from that clean wide (not from a sheet). This
      // also round-trips an opt-in: a Bible exports the angles as `of` children, and re-ingesting
      // them drops the master back to a plain wide here instead of letting it default to a sheet.
      if (master.sheet3) delete master.sheet3;
    } else {
      warnings.push(
        `Bối cảnh "${k}": "of" trỏ tới "${of}" không phải bối cảnh trong Bible — giữ như bối cảnh thường.`,
      );
      delete node.role;
      delete node.ofKey;
    }
  }
  // Dialogue locations: two opposing close angles (what camera OTS A sees / what OTS B
  // sees), derived from the scene. A shot that names the scene with an OTS camera is wired
  // to the matching side below; explicit "<key>_a" / "<key>_b" in uses work too.
  const reverseId = {}; // scene key → { a: node id, b: node id }
  for (const k of reverse) {
    const master = nodes.find(n => n.id === assetId[k]);
    if (!master) continue;
    reverseId[k] = {};
    for (const side of ['a', 'b']) {
      const key = `${k}_${side}`;
      if (!assetId[key]) {
        const id = nid();
        assetId[key] = id;
        nodes.push({
          id,
          zone: 'design',
          role: 'angle',
          assetKey: key,
          ofKey: k,
          preset: side,
          name: str(`${master.name} — ${ANGLE_PRESETS[side].name}`, 100),
          angle: reverseText[k]?.[side] || ANGLE_PRESETS[side].angle,
          prompt: '',
          videoPrompt: '',
          image: null,
          video: null,
          outputNaming: { ...defaultNaming },
        });
        edges.push({ source: master.id, target: id });
        angleMaster[id] = master.id;
      }
      reverseId[k][side] = assetId[key];
    }
  }
  // An angle sits right under its scene (after that scene's earlier angles), like a look.
  for (const id of Object.keys(angleMaster)) {
    const angle = nodes.splice(
      nodes.findIndex(n => n.id === id),
      1,
    )[0];
    let at = nodes.findIndex(n => n.id === angleMaster[id]);
    while (nodes[at + 1]?.role === 'angle' && angleMaster[nodes[at + 1].id] === angleMaster[id])
      at++;
    nodes.splice(at + 1, 0, angle);
  }
  for (const c of uniqCameras) {
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

  for (const a of uniqAudio) {
    const key = str(a.key || a.id || a.name, 100);
    const config = str(a.config || a.prompt || a.sound, 5000);
    if (!key || !config.trim()) continue;
    const id = nid();
    audioId[key] = id;
    nodes.push({
      id,
      kind: 'setting',
      settingType: 'audio',
      zone: 'audio',
      name: str(a.name || key, 100),
      config,
    });
  }

  shots.forEach((sh, i) => {
    const id = nid();
    const dur = Number(sh.duration);
    // Everything the shot connects to: the "uses" list (drama blueprints list the camera +
    // style keys there too) plus the scalar "camera" / "style" keys.
    const uses = Array.isArray(sh.uses) ? sh.uses : [];
    const outfits = Array.isArray(sh.wardrobe) ? sh.wardrobe : [sh.wardrobe];
    const keys = [
      ...new Set(
        [...uses, sh.camera, sh.style, sh.audio, sh.sound, ...outfits]
          .map(k => str(k, 100))
          .filter(Boolean),
      ),
    ];
    const camWired = keys.some(k => camId[k]);
    // A shot that names no style gets the blueprint's only style (music blueprints).
    if (!keys.some(k => styleId[k]) && Object.keys(styleId).length === 1)
      keys.push(Object.keys(styleId)[0]);
    // …same for a lone audio preset: one sound bed for the whole piece.
    if (!keys.some(k => audioId[k]) && Object.keys(audioId).length === 1)
      keys.push(Object.keys(audioId)[0]);
    // A shot written as 2–3 camera setups of one conversation ("setups") is a merged scene:
    // a frame node per setup in the production column, all wired into one node in the
    // "Phân cảnh ghép" column that films them as a single 8-second Veo clip.
    if (arr(sh.setups).length >= 2) {
      buildMerged(sh, i, keys);
      return;
    }
    // One setup alone is just a shot: keep its line and say so.
    if (arr(sh.setups).length === 1) {
      const s0 = sh.setups[0] && typeof sh.setups[0] === 'object' ? sh.setups[0] : {};
      warnings.push(
        `${str(sh.name || 'Shot ' + (i + 1), 100)}: "setups" cần 2–3 cỡ cảnh — dựng như shot thường.`,
      );
      sh = {
        ...sh,
        dialogue: sh.dialogue ?? s0.dialogue,
        audio_delivery: sh.audio_delivery ?? s0.audio_delivery,
      };
    }
    // Music: strip the baked "Camera:/Style:" tail so the wired setting nodes are the source.
    // Drama: keep the VEO prompt, minus its inline camera sentence once a camera node is wired.
    const base = isDrama
      ? camWired
        ? stripInlineCamera(str(sh.videoPrompt))
        : str(sh.videoPrompt)
      : baseShotPrompt(sh);
    nodes.push({
      id,
      zone: 'production',
      name: str(sh.name || 'Shot ' + (i + 1), 100),
      prompt: str(sh.prompt) || base,
      videoPrompt: str(sh.videoPrompt) ? base : '',
      // Drama shots carry a spoken line in "dialogue"; music shots in "lyric".
      lyric: str(sh.lyric ?? sh.dialogue, 5000),
      audioDelivery: str(sh.audio_delivery, 500), // modulates the speaker's voice_profile
      start: Number.isFinite(Number(sh.start)) ? Number(sh.start) : i * 8,
      duration: Number.isFinite(dur) && dur > 0 ? dur : 8,
      videoInput: 'refs', // a storyboard shot is driven by the connected asset images
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
    // Wire the shot to each asset, camera and style it names (edge order = prompt order:
    // reference images first, then "Camera: …", then "Style: …"). A shot that uses a
    // wardrobe gets that image INSTEAD of the bare character: same face, the right
    // costume, and one fewer reference image to spend.
    const dressed = new Set(keys.map(k => wardrobeOf[k]).filter(Boolean));
    // An over-shoulder camera on a scene that has reverse angles → that side's plate.
    const camKey = keys.find(k => camId[k]) || str(sh.camera, 100);
    const side = otsSide(uniqCameras.find(c => str(c.key || c.id || c.name, 100) === camKey));
    // One look per person: two costumes of the same character in one shot would make
    // VEO mix the outfits — keep both wires (we cannot pick) but say so.
    const looks = {};
    for (const k of keys)
      if (wardrobeOf[k]) {
        const c = wardrobeOf[k];
        if (looks[c])
          warnings.push(
            `${str(sh.name || 'Shot ' + (i + 1), 100)}: nhân vật "${c}" có 2 bộ trang phục (${looks[c]}, ${k}) — giữ một bộ để Veo không mặc lẫn.`,
          );
        looks[c] = k;
      }
    for (const k of keys) {
      if (dressed.has(k)) continue;
      // A costume key resolves to its look node (the dressed character), when it has one.
      const src =
        (side && reverseId[k]?.[side]) ||
        lookId[k] ||
        assetId[k] ||
        camId[k] ||
        styleId[k] ||
        audioId[k];
      if (src) edges.push({ source: src, target: id });
    }
  });

  // One shot written as 2–3 camera setups of the same conversation. Each setup becomes a
  // frame node (its own still, built from the location + the two character sheets); all of
  // them wire into a merged node that films them as one 8-second Veo clip with a hard cut
  // at each timecode. See lib/merged.mjs and Veo-shot-notes.md, sections 3–6.
  function buildMerged(sh, i, keys) {
    const shotName = str(sh.name || 'Shot ' + (i + 1), 100);
    const warn = msg => warnings.push(`${shotName}: ${msg}`);
    const setups = arr(sh.setups).slice(0, 3);
    if (arr(sh.setups).length > 3) warn('Veo nhận tối đa 3 ảnh — chỉ lấy 3 cỡ cảnh đầu.');
    // The people in frame, each as ONE node: the look when this shot dresses them in a
    // costume (the bare character stays out then, as in a normal shot), else the character.
    const nodeFor = {}; // character key → the node that stands for them in this shot
    const people = []; // character keys, in the order "uses" names them
    for (const k of keys) {
      const c = wardrobeOf[k] && lookId[k] ? wardrobeOf[k] : charKeys.has(k) ? k : '';
      if (!c) continue;
      if (!people.includes(c)) people.push(c);
      if (!nodeFor[c] || lookId[k]) nodeFor[c] = lookId[k] || assetId[c];
    }
    // "sides" says who stands where (a character key, or the costume they wear here);
    // without it, the order they appear in "uses" decides.
    const sides = sh.sides && typeof sh.sides === 'object' ? sh.sides : {};
    const sideKey = v => {
      const k = str(v, 100);
      return k && wardrobeOf[k] && lookId[k] ? wardrobeOf[k] : k;
    };
    let leftKey = sideKey(sides.left),
      rightKey = sideKey(sides.right);
    if (leftKey && !nodeFor[leftKey]) {
      warn(`"sides.left" (${leftKey}) không có trong "uses" của shot.`);
      leftKey = '';
    }
    if (rightKey && !nodeFor[rightKey]) {
      warn(`"sides.right" (${rightKey}) không có trong "uses" của shot.`);
      rightKey = '';
    }
    if (leftKey && leftKey === rightKey) {
      warn(`"sides" trái và phải cùng một người (${leftKey}).`);
      rightKey = '';
    }
    leftKey = leftKey || people.find(k => k !== rightKey) || '';
    rightKey = rightKey || people.find(k => k !== leftKey) || '';
    const extra = people.filter(k => k !== leftKey && k !== rightKey);
    if (extra.length)
      warn(`phân cảnh ghép chỉ lấy 2 người (${leftKey}, ${rightKey}); bỏ: ${extra.join(', ')}.`);
    const left = nodeFor[leftKey],
      right = nodeFor[rightKey];
    if (!left || !right)
      warn('phân cảnh ghép cần đúng 2 nhân vật — khai "sides": {"left": …, "right": …}.');
    // The location image the frames are built from. Prefer the scene that carries the
    // conversation staging (lib/merged.mjs reads it from the frame's own scene parent); it
    // may sit on an angle the shot lists in `uses` or on the master it is a view of, so walk
    // each candidate's `of`-chain and pick the first with staging, else the master view.
    const sceneNode = k => nodes.find(n => n.id === assetId[k]);
    const ofChain = k => {
      const out = [];
      let c = k,
        seen = new Set();
      while (c && !seen.has(c)) {
        out.push(c);
        seen.add(c);
        c = angleOf[c] || sceneNode(c)?.ofKey;
      }
      return out;
    };
    const candidates = [str(sh.place, 100), ...keys.filter(k => sceneKeys.has(k))]
      .filter(Boolean)
      .flatMap(ofChain);
    const placeKey = candidates.find(k => sceneNode(k)?.staging) || candidates[0] || '';
    const place = placeKey && assetId[placeKey];
    if (!place)
      warn('không tìm thấy node bối cảnh cho phân cảnh ghép (khai "place" hoặc trong "uses").');
    const start = Number.isFinite(Number(sh.start)) ? Number(sh.start) : i * 8;
    const mergedId = nid();
    nodes.push({
      id: mergedId,
      zone: 'merged',
      role: 'merged',
      name: shotName,
      prompt: '',
      videoPrompt: '', // the tool composes the cut list from the frames
      lyric: '',
      audioDelivery: str(sh.audio_delivery, 500),
      start,
      duration: 8, // a Veo clip is always 8 seconds
      videoInput: 'refs', // the frames are the reference images
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
    // Style and sound presets go on the merged node: they belong to the clip, not to a still.
    for (const k of keys) {
      const src = styleId[k] || audioId[k];
      if (src) edges.push({ source: src, target: mergedId });
    }
    setups.forEach((s, k) => {
      const framing = FRAMINGS.includes(str(s.framing, 20)) ? str(s.framing, 20) : '';
      if (!framing) warn(`cỡ cảnh "${str(s.framing, 20)}" không hợp lệ (ots_a, ots_b, two_shot).`);
      const suffix = ` · ${k + 1}${FRAMING_LABEL[framing] ? ' ' + FRAMING_LABEL[framing] : ''}`;
      const frameId = nid();
      nodes.push({
        id: frameId,
        zone: 'production',
        role: 'frame',
        frameNo: k + 1,
        framing: framing || 'two_shot',
        name: shotName.slice(0, 100 - suffix.length) + suffix,
        prompt: str(s.prompt), // empty: built from the location + the two sheets
        videoPrompt: '',
        lyric: str(s.dialogue ?? s.lyric, 5000),
        audioDelivery: str(s.audio_delivery, 500),
        frameAction: str(s.action, 500), // "takes one step toward NV1"
        start, // keeps the frames beside their scene when the column is arranged by time
        image: null,
        video: null,
        outputNaming: { ...defaultNaming },
      });
      // Wire order IS the image order the still prompt names: [1] place, [2] left, [3] right.
      for (const src of [place, left, right]) if (src) edges.push({ source: src, target: frameId });
      edges.push({ source: frameId, target: mergedId });
    });
  }

  if (nodes.length > 200)
    throw new Error(`Blueprint quá lớn (${nodes.length} node > 200). Giảm số asset/shot.`);

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
    name: b.project?.name || b.project?.title ? str(b.project.name || b.project.title, 100) : null,
    theme: b.project?.theme || (isDrama ? 'film' : null),
    film: str(typeof film === 'string' ? film : film?.title, 200).trim() || null,
    warnings, // non-fatal wiring problems, surfaced to the user after the build
  };
}
