// Which generator a node uses (Seedvis or Orbit) and its model limits.
import {
  catalog as seedvisCatalog,
  defaultSeedvis,
  validateSeedvisBinding,
  videoDuration,
} from '../seedvis-client.mjs';
import { projectAspect } from './aspect.mjs';
import { imageParents } from './nodes.mjs';
import { db } from './projects.mjs';
import { nodeZone } from './zones.mjs';

// Seedvis is the default generator; a node keeps Orbit when it already has an Orbit
// binding or was explicitly switched to Orbit (seedvis[kind] === false). A node that has
// chosen nothing follows the project default (db.defaults[kind]: seedvis | web | orbit).
export function seedvisBinding(n, kind) {
  const s = n.seedvis?.[kind];
  if (s === false) return null;
  if (s) return s;
  if (n.orbit?.[kind]) return null;
  if (n.web?.[kind]) return null;
  if (n.gvids?.[kind]) return null;
  if (n.musechat?.[kind]) return null;
  if (n.seedane?.[kind]) return null;
  // A look (character wearing a costume) renders like its character's model sheet: with no
  // image binding of its own it takes the character's image model + aspect ratio. A scene
  // angle likewise follows its scene.
  if (kind === 'image' && n.role === 'look') {
    const ch = imageParents(n).find(p => p.role === 'character' || nodeZone(p) === 'character');
    if (ch?.seedvis?.image) return ch.seedvis.image;
  }
  if (kind === 'image' && n.role === 'angle') {
    const sc = imageParents(n)[0];
    if (sc?.seedvis?.image) return sc.seedvis.image;
  }
  // Nothing chosen on the node: the project default decides. A web/orbit/gvids/musechat
  // default means no Seedvis binding (the node runs through a browser).
  const def = db.defaults?.[kind];
  if (['web', 'orbit', 'gvids', 'musechat', 'seedane-dola', 'seedane-muse'].includes(def)) return null;
  // Seedvis source: use the project's default MODEL when it set one (validated in projects.mjs),
  // else the built-in default. validateSeedvisBinding (in providers() below) fixes the aspect.
  const model = db.defaults?.[kind === 'image' ? 'imageModel' : 'videoModel'];
  // Tỉ lệ khung lấy theo cài đặt project, không phải '16:9' ghi cứng trong seedvis-client.
  //
  // Ảnh sheet xin thêm độ phân giải, khung shot thì không. Lý do: mọi lần render sau đều đọc mặt
  // người, bối cảnh và đạo cụ TỪ sheet, mà sheet 3-trong-1 còn chia bề ngang cho ba khung — ở cỡ
  // gốc 1672x941 của model thì mỗi khung chỉ còn chừng 557px. Đã đo 359 sheet trên đĩa: tất cả ra
  // đúng bằng cỡ một khung shot. Khung shot giữ cỡ gốc vì nó chỉ nạp vào clip 1920x1080, to hơn là
  // trả tiền rồi vứt. Node đã tự chọn upscale thì đã return ở trên, nên đây không đè lên ai cả.
  const isSheet = kind === 'image' && ['character', 'wardrobe', 'design'].includes(nodeZone(n));
  // Mức nâng cỡ lấy theo cài đặt project (ô "Độ nét ảnh tham chiếu"); chưa đặt thì 2k. Model nào
  // không nhận mức đó thì validateSeedvisBinding hạ xuống mức đầu tiên nó cho phép.
  const sheetUp = db.defaults?.sheetUpscale || '2k';
  const base = {
    ...defaultSeedvis[kind],
    aspectRatio: projectAspect(),
    ...(isSheet && sheetUp !== 'none' ? { upscale: sheetUp } : {}),
  };
  return model && seedvisCatalog[kind].some(m => m.id === model) ? { ...base, model } : base;
}
export function providers(n) {
  const out = {};
  for (const kind of ['image', 'video']) {
    const s = seedvisBinding(n, kind);
    // With no Seedvis binding a node runs through a browser: the web worker extension
    // (ChatGPT, images only), Google Vids (video only), or Orbit (a Hub script). An explicit
    // per-node choice wins; otherwise the project default decides web/gvids vs orbit.
    out[kind] = s
      ? {
          type: 'seedvis',
          ...validateSeedvisBinding(kind, s),
          ...(kind === 'video' ? { duration: videoDuration(s.model) } : {}),
        }
      : n.seedane?.[kind]
        ? seedaneSource(kind, n.seedane[kind])
        : n.musechat?.[kind]
        ? { type: 'musechat' }
        : n.web?.[kind]
          ? { type: 'web' }
          : n.gvids?.[kind]
            ? { type: 'gvids' }
            : n.seedvis?.[kind] === false || n.orbit?.[kind]
              ? { type: 'orbit' }
              : db.defaults?.[kind] === 'web'
                ? { type: 'web' }
                : db.defaults?.[kind] === 'gvids'
                  ? { type: 'gvids' }
                  : db.defaults?.[kind] === 'musechat'
                    ? { type: 'musechat' }
                    : String(db.defaults?.[kind] || '').startsWith('seedane-')
                      ? seedaneSource(kind, {
                          platform: db.defaults[kind].slice(8),
                          model: db.defaults.seedaneModel,
                        })
                      : { type: 'orbit' };
  }
  return out;
}
// How many reference images the node's video model takes in one request (Veo 3,
// Seedance 10); null when the video runs through Orbit.
// A Seedane source: Dola makes video only (model 2.5 / 2.0), Muse image or video; `account` picks
// a nick (empty: Seedane takes the first READY one).
export function seedaneSource(kind, b = {}) {
  const platform = kind === 'image' || b.platform === 'muse' ? 'muse' : 'dola';
  const model = platform === 'dola' ? (b.model === '2.0' ? '2.0' : '2.5') : '';
  return {
    type: 'seedane',
    platform,
    model,
    account: String(b.account || '').slice(0, 100),
    modelName: platform === 'dola' ? 'Seedane · Dola ' + model : 'Seedane · Muse',
  };
}
export function videoRefLimit(n) {
  const v = providers(n).video;
  // Dola is Seedance underneath: 2.5 takes 10 reference images, 2.0 takes 9.
  if (v.type === 'seedane') return v.platform === 'dola' ? (v.model === '2.0' ? 9 : 10) : null;
  if (v.type !== 'seedvis') return null;
  return seedvisCatalog.video.find(m => m.id === v.model)?.maxImages ?? null;
}
// More reference images than the video model takes: the shot must compose its own
// keyframe first (the image model takes up to 10 refs) and film from that single frame.
// Within the limit, the refs go straight into the video request.
export const videoNeedsKeyframe = n => {
  const limit = videoRefLimit(n);
  return limit !== null && imageParents(n).length > limit;
};
// Lượt video này gửi ẢNH CỦA CÁC NODE NỐI VÀO hay ảnh keyframe của chính node?
//
// Đúng theo ô chọn "Ảnh đầu vào cho video" trong Inspector: mặc định `self` dùng ảnh đã render
// của node, chọn `refs` thì dùng ảnh các node nối vào. Ngoại lệ DUY NHẤT là khi số ảnh nối vào
// vượt trần của model video (Veo nhận 3) — lúc đó không có cách nào gửi hết, nên shot buộc phải
// dựng một keyframe rồi quay từ đó.
//
// Trước đây luật là `refs && !n.image`: hễ node đã có ảnh render là lựa chọn của người dùng bị
// bỏ qua. Nó được chép ở 4 chỗ (jobs/prompts/stage3d/auto) nên sửa một chỗ là lệch — giờ cả
// bốn gọi hàm này.
export const videoRunsFromRefs = n => n?.videoInput === 'refs' && !videoNeedsKeyframe(n);
// Chế độ "ảnh khung + nhân vật chọn thêm": chạy được khi node đã có ảnh khung. Số ảnh gửi đi
// là 1 + số nhân vật được tick, và UI/khi tạo job đều chặn ở trần của model.
export const videoRunsMixed = n => n?.videoInput === 'mix' && !!n.image;
// Còn tick thêm được mấy nhân vật nữa (ảnh khung đã chiếm một suất).
export const mixedRoom = n => Math.max(0, (videoRefLimit(n) ?? 1) - 1);
// Tên các model video nhận đủ `count` ảnh tham chiếu. Trần là của MODEL chứ không phải của
// tool (Veo nhận 3, Seedance nhận 10), nên "vượt giới hạn" thường chỉ cần đổi model — câu báo
// lỗi phải nói ra, đừng bắt người dùng tự tra.
export const videoModelsTaking = count =>
  seedvisCatalog.video.filter(m => (m.maxImages ?? 0) >= count).map(m => m.name || m.id);
