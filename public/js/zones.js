// Canvas columns (zones) and where each node sits in them.
import { store } from './store.js';

// Workflow zones (process stages) shown as columns on the canvas.
export const ZONES = [
  { id: 'character', label: '① Nhân vật' },
  { id: 'wardrobe', label: '② Trang phục & vật dụng' },
  { id: 'design', label: '③ Bối cảnh' },
  { id: 'setup', label: '④ Style & Máy quay' },
  { id: 'audio', label: '⑤ Âm thanh' },
  { id: 'production', label: '⑥ Sản xuất video' },
  { id: 'merged', label: '⑦ Phân cảnh ghép' },
  { id: 'output', label: '⑧ Video' },
  { id: 'seedance', label: '⑨ Seedance' },
  { id: 'seedance-video', label: '⑩ Video Seedance' },
];
export const ZONE_W = 340;
const zoneIndex = id =>
  Math.max(
    0,
    ZONES.findIndex(z => z.id === id),
  );
// The columns of produced clips: ⑧ (clips of shots and merged scenes) and ⑩ (Seedance groups).
export const CLIP_ZONES = ['output', 'seedance-video'];
// Order within a zone: production follows seq; a clip column follows its source's seq then version.
const zoneOrder = n =>
  CLIP_ZONES.includes(n.zone) ? (n.sourceSeq || 999) * 100 + (n.version || 0) : n.seq || 999;
// Lays every node out into its zone column, stacked in order (the arrange button).
// Output videos are special: each sits on the SAME ROW as the production node it came
// from, and extra versions line up to its right — so a shot with no video yet leaves a
// gap instead of pulling the videos below it upward.
const OUT_STEP = 250;
// horizontal gap between versions of the same shot
export function zoneLayout() {
  const rows = {},
    pos = {},
    sourceY = {},
    outputs = [];
  const merged = [];
  for (const n of [...store.state.nodes].sort((a, b) => zoneOrder(a) - zoneOrder(b))) {
    if (CLIP_ZONES.includes(n.zone)) {
      outputs.push(n);
      continue;
    }
    if (n.zone === 'merged') {
      merged.push(n);
      continue;
    }
    const zi = zoneIndex(n.zone),
      row = rows[zi] || 0;
    rows[zi] = row + 1;
    const y = 54 + row * 285;
    pos[n.id] = { x: 24 + zi * ZONE_W, y };
    sourceY[n.id] = y;
  }
  // A merged scene sits on the row of its first frame, so the eye follows frame → scene → clip.
  let mergedRow = Math.max(0, ...Object.values(rows)); // no frame: below everything placed
  for (const n of merged) {
    const first = store.state.edges
      .map(e => e.target === n.id && store.state.nodes.find(x => x.id === e.source))
      .filter(f => f && f.role === 'frame')
      .sort((a, b) => (a.frameNo || 0) - (b.frameNo || 0))[0];
    const y = first && first.id in sourceY ? sourceY[first.id] : 54 + mergedRow++ * 285;
    pos[n.id] = { x: 24 + zoneIndex('merged') * ZONE_W, y };
    sourceY[n.id] = y;
  }
  const used = {}; // clip column + row → the sources placed there, left to right
  const orphanY = {}; // clips whose source is gone: one row per source, below everything
  let orphanRow = Object.values(sourceY).length;
  for (const n of outputs) {
    const key = n.source || n.id;
    const y = n.source in sourceY ? sourceY[n.source] : (orphanY[key] ??= 54 + orphanRow++ * 285);
    const slot = n.zone + '@' + y;
    const list = used[slot] || (used[slot] = []);
    if (!list.includes(key)) list.push(key);
    // every version of one source sits on the same spot: the canvas shows one card for them
    pos[n.id] = { x: 24 + zoneIndex(n.zone) * ZONE_W + list.indexOf(key) * OUT_STEP, y };
  }
  return pos;
}
