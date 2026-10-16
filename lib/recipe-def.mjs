// A recipe: one whole production run written as steps the tool executes by itself — script
// studio (+ build) → images per zone → videos per zone → package — with confirm stops in
// between. Pure (no project state), so the assistant's planner, its tests and the runner all
// validate a recipe the same way without a server.
export const IMAGE_ZONES = ['character', 'wardrobe', 'design', 'production', 'lipsync'];
export const VIDEO_ZONES = ['production', 'merged', 'lipsync'];
export const PROVIDERS = ['musechat', 'seedvis', 'gvids'];
export const ZONE_VI = {
  character: 'nhân vật',
  wardrobe: 'trang phục',
  design: 'bối cảnh',
  production: 'shot',
  merged: 'phân cảnh ghép',
  lipsync: 'hát nhép',
};
export const MAX_STEPS = 20;
const clip = (v, n) =>
  String(v ?? '')
    .trim()
    .slice(0, n);

// The steps, checked and normalised; throws on anything the runner cannot do.
export function normalizeSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('Quy trình cần ít nhất một bước.');
  if (raw.length > MAX_STEPS) throw new Error(`Quy trình tối đa ${MAX_STEPS} bước.`);
  const out = [];
  for (const s of raw) {
    const type = clip(s?.type, 20);
    if (type === 'script') out.push({ type, mode: s.mode === 'full' ? 'full' : 'fast' });
    else if (type === 'confirm') out.push({ type, text: clip(s.text, 300) || 'Tiếp tục?' });
    else if (type === 'images' || type === 'videos') {
      const all = type === 'images' ? IMAGE_ZONES : VIDEO_ZONES;
      const zones = (Array.isArray(s.zones) ? s.zones : [s.zone])
        .map(z => clip(z, 20))
        .filter(z => all.includes(z));
      if (!zones.length) throw new Error(`Bước ${type} cần khu hợp lệ (${all.join(', ')}).`);
      const step = { type, zones: [...new Set(zones)] };
      if (type === 'videos' && PROVIDERS.includes(s.provider)) step.provider = s.provider;
      out.push(step);
    } else if (type === 'package') out.push({ type });
    else throw new Error(`Bước quy trình không hỗ trợ: ${type || '(trống)'}.`);
  }
  if (!out.some(s => s.type !== 'confirm'))
    throw new Error('Quy trình chỉ có điểm dừng, không có việc nào.');
  return out;
}

export const stepLabel = s =>
  s.type === 'script'
    ? `Chạy xưởng kịch bản (${s.mode === 'full' ? 'Kỹ' : 'Nhanh'}) + dựng graph`
    : s.type === 'confirm'
      ? `⏸ ${s.text}`
      : s.type === 'images'
        ? `Tạo ảnh: ${s.zones.map(z => ZONE_VI[z]).join(', ')}`
        : s.type === 'videos'
          ? `Tạo video: ${s.zones.map(z => ZONE_VI[z]).join(', ')}${s.provider ? ` (${s.provider})` : ''}`
          : 'Đóng gói zip';

// Shipped with the app, so the very first "run everything" costs no LLM call either. The stops
// are where the user asked for them: after the graph is built, after the cast + set images, and
// after the videos (then the zip).
export const DEFAULT_RECIPES = [
  {
    id: 'builtin:full',
    name: 'Toàn bộ: kịch bản → ảnh → video → zip',
    builtin: true,
    triggers: [
      'chạy toàn bộ',
      'chạy hết',
      'chạy toàn bộ quy trình',
      'chạy từng bước để ra sản phẩm cuối cùng',
      'chạy toàn bộ từng bước',
      'làm hết từ đầu đến cuối',
      'ra sản phẩm cuối cùng',
      'run everything',
    ],
    steps: [
      { type: 'script', mode: 'fast' },
      {
        type: 'confirm',
        text: 'Kịch bản xong, graph đã dựng. Tạo ảnh nhân vật, trang phục, bối cảnh?',
      },
      { type: 'images', zones: ['character', 'wardrobe', 'design'] },
      {
        type: 'confirm',
        text: 'Ảnh nhân vật và bối cảnh xong. Tạo ảnh khung cho shot rồi quay video?',
      },
      { type: 'images', zones: ['production'] },
      { type: 'videos', zones: ['production', 'merged', 'lipsync'] },
      { type: 'confirm', text: 'Video xong. Đóng gói zip?' },
      { type: 'package' },
    ],
  },
];

export const fold = v =>
  String(v || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
const AUTO_RE =
  /\b(khong hoi|khong dung|khong can xac nhan|khong can hoi|tu dong hoan toan|chay thang|mot mach|without asking|no confirmation)\b/;
// The recipe a request names — one of its trigger phrases, compared without accents, case or
// extra spaces (a short phrase must match the whole request; a long one may sit inside it) —
// and whether the user asked to run through every stop. Zero tokens: no LLM reads this.
export function matchRecipe(request, recipes) {
  const key = fold(request);
  if (!key) return null;
  for (const r of recipes || [])
    for (const t of r.triggers || []) {
      const k = fold(t);
      if (k.length >= 6 && (key === k || (k.length >= 12 && key.includes(k))))
        return { recipe: r, auto: AUTO_RE.test(key) };
    }
  return null;
}
