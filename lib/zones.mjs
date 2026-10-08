// Canvas zones (columns) and the per-zone numbering of nodes.
import { db } from './projects.mjs';

// Workflow zones: Nhân vật → Trang phục & vật dụng → Bối cảnh → Style/Máy quay → Âm thanh →
// Sản xuất (luồng A · phủ cảnh) → Phân cảnh ghép (2–3 frames filmed as one Veo clip) →
// Video (clips of A) → Seedance (groups) → Video Seedance (clips of groups) →
// Lip-sync (luồng B · câu hát nhép, filmed by Omni Flash from keyframe + vocal) →
// Video lip-sync (clips of B). The two lip-sync columns come last so adding them shifted no
// existing column. See nodeStream(): the zone is what makes a node part of luồng A or luồng B.
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
  'lipsync',
  'lipsync-video',
];
// The columns that hold produced clips: numbered by their source, then version.
export const CLIP_ZONES = ['output', 'seedance-video', 'lipsync-video'];
const CHARACTER_IDS = new Set(['singer', 'char', 'character']);
const defaultZone = n =>
  n.kind === 'music'
    ? 'audio'
    : n.role === 'lipsync'
      ? 'lipsync'
      : n.terminal
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
// The two data streams the film is edited from. The zone IS the stream, so no node carries a
// stream field: ⑥/⑦/⑧ = luồng A (phủ cảnh — band, nhạc cụ, toàn cảnh, khán giả — tiling the whole
// song; ⑦ is one production shot filmed as a single clip, so it rides along in A), ⑪/⑫ = luồng B
// (câu hát nhép). Everything else is '': an asset, or a Seedance group — a repackaging of A's
// shots into one render, not a row of its own on the timeline.
const STREAM = {
  production: 'A',
  merged: 'A',
  output: 'A',
  lipsync: 'B',
  'lipsync-video': 'B',
};
export const nodeStream = n => (n ? STREAM[nodeZone(n)] || '' : '');
// Where a node sits on the song, in seconds, as [in, out] — or null when it has no time. A shot
// spans [start, start + duration]; a lip-sync take spans the cut it sends to Omni,
// [clipStart, clipEnd]. A take deliberately carries no `duration`: several filters read
// `'duration' in n` to mean "this node is a shot".
export function nodeTime(n) {
  if (!n) return null;
  const [a, b] =
    n.role === 'lipsync'
      ? [Number(n.clipStart), Number(n.clipEnd)]
      : [Number(n.start), Number(n.start) + Number(n.duration)];
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a ? [a, b] : null;
}
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
