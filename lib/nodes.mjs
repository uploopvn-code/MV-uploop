// Node lookups and graph wiring helpers: getNode, inputs (deps), image/setting parents.
import { db } from './projects.mjs';
import { nodeZone } from './zones.mjs';

export const getNode = id => db.nodes.find(n => n.id === id);
export const deps = id => db.edges.filter(e => e.target === id).map(e => e.source);
// Style / camera config nodes: wired into the graph but carry text, not media.
export const isSetting = n => n?.kind === 'setting';
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
export const assetRefs = n =>
  deps(n.id)
    .map(getNode)
    .filter(s => s && !isSetting(s)) // skip setting nodes and dangling edges to missing nodes
    .map(s => ({ role: s.id, asset: s.image }))
    .filter(r => r.asset);
// A node's inputs, split the way the canvas shows them: parents that feed an image
// (character, wardrobe, scene, prop, another shot) vs. the text-only setting nodes.
export const imageParents = n =>
  deps(n.id)
    .map(getNode)
    .filter(s => s && !isSetting(s));
export const settingParents = n =>
  deps(n.id)
    .map(getNode)
    .filter(s => s && isSetting(s));
