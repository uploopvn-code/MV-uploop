// Canvas zones (columns) and the per-zone numbering of nodes.
import { db } from './projects.mjs';

// Workflow zones: Nhân vật → Trang phục & vật dụng → Bối cảnh → Style/Máy quay → Âm thanh →
// Sản xuất → Phân cảnh ghép (2–3 frames filmed as one Veo clip) → Video (clips) →
// Seedance (groups) → Video Seedance (clips of groups).
export const ZONES = [
  'character',
  'wardrobe',
  'design',
  'setup',
  'audio',
  'production',
  'merged',
  'output',
  'seedance',
  'seedance-video',
];
// The columns that hold produced clips: numbered by their source, then version.
export const CLIP_ZONES = ['output', 'seedance-video'];
const CHARACTER_IDS = new Set(['singer', 'char', 'character']);
const defaultZone = n =>
  n.terminal
    ? 'output'
    : n.role === 'seedance'
      ? 'seedance'
      : n.role === 'merged'
        ? 'merged'
        : n.kind === 'setting'
          ? 'setup'
          : 'duration' in n
            ? 'production'
            : n.role === 'wardrobe'
              ? 'wardrobe'
              : n.role === 'character' || CHARACTER_IDS.has(n.id)
                ? 'character'
                : 'design';
export const nodeZone = n => (ZONES.includes(n.zone) ? n.zone : defaultZone(n));
// Sequence numbers restart per zone, so each zone is numbered 1, 2, 3…
export const nextSeq = zone =>
  db.nodes.reduce((m, n) => (nodeZone(n) === zone ? Math.max(m, n.seq || 0) : m), 0) + 1;
// Order within a zone for numbering: by current seq, output by source then version.
const seqKey = n =>
  CLIP_ZONES.includes(nodeZone(n)) ? (n.sourceSeq || 999) * 1000 + (n.version || 0) : n.seq || 9999;
// Renumbers each zone to 1..n. Output follows production order (source then
// version); other zones keep the current seq order (fractional seq lets the UI
// insert a node at a chosen position before this tidies it back to integers).
export function renumberSeq(d) {
  const key = (n, z) =>
    CLIP_ZONES.includes(z) ? (n.sourceSeq || 999) * 1000 + (n.version || 0) : (n.seq ?? 9999);
  for (const z of ZONES)
    d.nodes
      .filter(n => nodeZone(n) === z)
      .sort((a, b) => key(a, z) - key(b, z))
      .forEach((n, i) => (n.seq = i + 1));
}
