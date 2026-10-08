// Which generator a node uses (Seedvis or Orbit) and its model limits.
import {
  catalog as seedvisCatalog,
  defaultSeedvis,
  validateSeedvisBinding,
  videoDuration,
} from '../seedvis-client.mjs';
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
  if (['web', 'orbit', 'gvids', 'musechat'].includes(def)) return null;
  // Seedvis source: use the project's default MODEL when it set one (validated in projects.mjs),
  // else the built-in default. validateSeedvisBinding (in providers() below) fixes the aspect.
  const model = db.defaults?.[kind === 'image' ? 'imageModel' : 'videoModel'];
  const base = defaultSeedvis[kind];
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
      : n.web?.[kind]
        ? { type: 'web' }
        : n.gvids?.[kind]
          ? { type: 'gvids' }
          : n.musechat?.[kind]
            ? { type: 'musechat' }
            : n.seedvis?.[kind] === false || n.orbit?.[kind]
              ? { type: 'orbit' }
              : db.defaults?.[kind] === 'web'
                ? { type: 'web' }
                : db.defaults?.[kind] === 'gvids'
                  ? { type: 'gvids' }
                  : db.defaults?.[kind] === 'musechat'
                    ? { type: 'musechat' }
                    : { type: 'orbit' };
  }
  return out;
}
// How many reference images the node's video model takes in one request (Veo 3,
// Seedance 10); null when the video runs through Orbit.
export function videoRefLimit(n) {
  const v = providers(n).video;
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
