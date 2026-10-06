// Serialize the open project's graph back into a blueprint "Bible" — the reusable asset
// definitions (characters, scenes, wardrobe, props) plus the cameras / styles / audio presets,
// in the same JSON shape the Director builds FROM. This is the inverse of director.mjs's
// buildGraph for the asset half: it does NOT include the shots (those are the per-episode
// "seq"), so one Bible can be paired with a fresh sequence each time. Keys come from a node's
// stored assetKey where there is one; setting presets (which keep no key) get one slugged from
// their name.
import { nodeZone } from './zones.mjs';

const drop = o => {
  for (const k of Object.keys(o))
    if (o[k] === undefined || o[k] === '' || o[k] === null || (Array.isArray(o[k]) && !o[k].length))
      delete o[k];
  return o;
};
// A short ascii key from a name (settings carry no blueprint key of their own).
const slug = (s, pre) =>
  (pre || '') +
  (String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'x');
const uniq = (key, used) => {
  let k = key,
    i = 2;
  while (used.has(k)) k = key + '_' + i++;
  used.add(k);
  return k;
};

export function buildBible(db) {
  const nodes = db.nodes || [];
  const keyOf = n => n.assetKey || n.id;
  // node id → the asset key a wardrobe node's character resolves to.
  const assets = [],
    wardrobe = [],
    cameras = [],
    styles = [],
    audio = [];
  const used = new Set();

  for (const n of nodes) {
    if (n.terminal) continue;
    // Settings: style / camera / audio presets.
    if (n.kind === 'setting') {
      const name = n.name || n.settingType || 'preset';
      if (n.settingType === 'camera')
        cameras.push(drop({ key: uniq(slug(name, 'cam_'), used), name, config: n.config || '' }));
      else if (n.settingType === 'audio')
        audio.push(drop({ key: uniq(slug(name, 'aud_'), used), name, prompt: n.config || '' }));
      else
        styles.push(drop({ key: uniq(slug(name, 'style_'), used), name, prompt: n.config || '' }));
      continue;
    }
    const zone = nodeZone(n);
    // Characters (not the derived "look" / dressed-character nodes).
    if (zone === 'character' && n.role !== 'look') {
      assets.push(
        drop({
          key: keyOf(n),
          role: 'character',
          name: n.name,
          code: n.code,
          identity_label: n.label,
          back_view: n.back,
          physical_anchors: n.anchors ? String(n.anchors).split(/,\s*/).filter(Boolean) : undefined,
          voice_profile: n.voice || undefined,
          prompt: n.prompt,
        }),
      );
    } else if (zone === 'design') {
      // Scenes and their derived camera angles.
      assets.push(
        drop({
          key: keyOf(n),
          role: 'scene',
          kind: n.role === 'angle' ? 'angle' : undefined,
          of: n.ofKey,
          uses: n.ofKey ? [n.ofKey] : undefined,
          name: n.name,
          angle: n.role === 'angle' ? n.angle : undefined,
          prompt: n.prompt,
          conversation: n.staging || undefined,
        }),
      );
    } else if (n.role === 'prop') {
      assets.push(drop({ key: keyOf(n), role: 'prop', name: n.name, prompt: n.desc }));
    } else if (n.role === 'wardrobe') {
      // The character this costume dresses (charId points at the character node).
      const forChar = nodes.find(x => x.id === n.charId);
      wardrobe.push(
        drop({
          key: keyOf(n),
          for: forChar ? forChar.assetKey || forChar.id : undefined,
          prompt: n.outfit,
          items: n.items,
        }),
      );
    }
  }
  return drop({
    project: drop({ title: db.name, theme: db.theme }),
    styles,
    cameras,
    audio,
    assets,
    wardrobe,
  });
}
