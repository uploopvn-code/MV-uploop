// Node lookups and graph wiring helpers: getNode, inputs (deps), image/setting parents.
import { db } from './projects.mjs';
import { nodeZone } from './zones.mjs';

// getNode / deps are called 10–14× per node while building /api/state (and all over the app), each
// a full scan of db.nodes / db.edges → O(n·e) per state build. Back them with an id→node map and a
// target→sources map instead. The index only needs rebuilding when a node or edge is ADDED or
// REMOVED — which always changes the array's identity (filter / reassign) or its length (push). A
// content edit (renaming a node, re-wiring handled by replacing db.edges) keeps the same object
// references, so the maps stay valid without a rebuild. Cheap to check, safe against staleness.
let _nodesRef = null,
  _edgesRef = null,
  _edgeCount = -1,
  _nodeById = new Map(),
  _depsByTarget = new Map();
function ensureIndex() {
  if (
    _nodesRef === db.nodes &&
    _edgesRef === db.edges &&
    _nodeById.size === db.nodes.length &&
    _edgeCount === db.edges.length
  )
    return;
  _nodesRef = db.nodes;
  _edgesRef = db.edges;
  _edgeCount = db.edges.length;
  _nodeById = new Map(db.nodes.map(n => [n.id, n]));
  _depsByTarget = new Map();
  for (const e of db.edges) {
    const list = _depsByTarget.get(e.target);
    if (list) list.push(e.source);
    else _depsByTarget.set(e.target, [e.source]);
  }
}
export const getNode = id => {
  ensureIndex();
  return _nodeById.get(id);
};
// A fresh array each call (callers .map/.filter it, and some mutate the result): never hand out the
// cached list itself.
export const deps = id => {
  ensureIndex();
  const list = _depsByTarget.get(id);
  return list ? list.slice() : [];
};
// Style / camera config nodes: wired into the graph but carry text, not media.
export const isSetting = n => n?.kind === 'setting';
// A music node: holds a song reference (YouTube link / file / lyrics) and its analysis, not media
// that feeds a shot. It carries no prompt and wires to nothing.
export const isMusic = n => n?.kind === 'music';
// A lip-sync take: one sung line of the storyboard, filmed by Omni Flash from its keyframe + the
// isolated vocal of exactly that line (video-to-video).
export const isLipsync = n => n?.role === 'lipsync';
// Costume node (one character re-rendered in one look): by role, or any role-less image
// node the user dragged into the wardrobe column. Items (props) in that column keep their
// own role and are rendered on their own.
export const isWardrobe = n =>
  !!n &&
  !n.terminal &&
  !isSetting(n) &&
  (n.role === 'wardrobe' || (!n.role && nodeZone(n) === 'wardrobe' && !('duration' in n)));
// A character node (a person's model sheet). A "look" (the character already dressed in a
// costume) is not one: it is that character's picture in another outfit.
export const isCharacter = x =>
  !!x && x.role !== 'look' && (x.role === 'character' || nodeZone(x) === 'character');
// A 3D stage node ("🧍 Sân khấu 3D"): a set that only holds where its performers stand, pinned in
// the 3D editor. The nodes wired from it keep its marks (lib/stage3d.mjs); like a setting node it
// is not one of their image inputs — pinned or not yet — and it is never generated. Said by the
// node itself (`stageNode`), never guessed from a location left blank; a blank toolbar scene
// pinned before the flag existed (its stage saved as v1) counts as one.
export const isStageOnly = n =>
  !!n &&
  !n.terminal &&
  (n.stageNode === true ||
    (n.stage3d?.v === 1 &&
      !!n.stage3d.performers?.length &&
      !n.image &&
      String(n.id).startsWith('node-') &&
      !String(n.prompt || '').trim() &&
      !String(n.desc || '').trim()));
export const assetRefs = n =>
  imageParents(n)
    .map(s => ({ role: s.id, asset: s.image }))
    .filter(r => r.asset);
// Chế độ "ảnh khung + nhân vật chọn thêm" (videoInput: 'mix').
//
// Vì sao cần: một shot qua vai quay từ ảnh khung của nó thì người gần máy chỉ có lưng. Khi họ
// quay mặt lại trong lúc thoại, model không có gì để bám nên bịa ra một khuôn mặt khác. Gửi
// kèm ảnh nhân vật đó làm tham chiếu nhận dạng thì mặt mới khớp.
//
// Ảnh khung LUÔN đứng đầu (image 1 = khung hình đầu tiên), các ảnh nhân vật được tick xếp sau
// theo đúng thứ tự người dùng nối vào — prompt gọi chúng theo số thứ tự này.
export const mixedRefs = n => {
  if (!n?.image) return [];
  const pick = new Set(Array.isArray(n.videoRefPick) ? n.videoRefPick : []);
  return [
    { role: 'keyframe', asset: n.image },
    ...imageParents(n)
      .filter(s => pick.has(s.id) && s.image)
      .map(s => ({ role: s.id, asset: s.image })),
  ];
};
// A node's inputs, split the way the canvas shows them: parents that feed an image
// (character, wardrobe, scene, prop, another shot) vs. the text-only setting nodes.
export const imageParents = n =>
  deps(n.id)
    .map(getNode)
    .filter(s => s && !isSetting(s) && !isStageOnly(s)); // (and dangling edges to missing nodes)
export const settingParents = n =>
  deps(n.id)
    .map(getNode)
    .filter(s => s && isSetting(s));
