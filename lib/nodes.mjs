// Node lookups and graph wiring helpers: getNode, inputs (deps), image/setting parents.
import { db } from './projects.mjs';
import { nodeZone } from './zones.mjs';

export const getNode = id => db.nodes.find(n => n.id === id);
export const deps = id => db.edges.filter(e => e.target === id).map(e => e.source);
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
