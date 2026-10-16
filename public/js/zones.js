// Canvas columns (zones) and where each node sits in them.
import { store } from './store.js';

// Workflow zones (process stages) shown as columns on the canvas. ⑥⑧ and ⑪⑫ are named after the
// two streams the film is edited from: luồng A phủ kín cả bài bằng phủ cảnh, luồng B chạy song
// song với từng câu hát nhép (xem nodeStream).
export const ZONES = [
  { id: 'start', label: '⓪ START · Kịch bản & Nhạc', labelKey: 'zone.start' },
  { id: 'character', label: '① Characters · Nhân vật', labelKey: 'zone.character' },
  {
    id: 'wardrobe',
    label: '② Wardrobe & Props · Trang phục & Vật dụng',
    labelKey: 'zone.wardrobe',
  },
  { id: 'design', label: '③ Locations & Sets · Bối cảnh', labelKey: 'zone.design' },
  { id: 'setup', label: '④ Camera & Style · Máy quay & Phong cách', labelKey: 'zone.setup' },
  { id: 'audio', label: '⑤ Audio & Music · Âm thanh & Nhạc', labelKey: 'zone.audio' },
  { id: 'production', label: '⑥ Production · Sản xuất', labelKey: 'zone.production' },
  { id: 'merged', label: '⑦ Merged Scenes · Phân cảnh ghép', labelKey: 'zone.merged' },
  { id: 'output', label: '⑧ Deliverables · Video đầu ra', labelKey: 'zone.output' },
  { id: 'seedance', label: '⑨ Groups & Multi-shot · Nhóm Seedance', labelKey: 'zone.seedance' },
  { id: 'seedance-video', label: '⑩ Group Renders · Video nhóm', labelKey: 'zone.seedanceVideo' },
  { id: 'lipsync', label: '⑪ Lip Sync · Đồng bộ môi', labelKey: 'zone.lipsync' },
  {
    id: 'lipsync-video',
    label: '⑫ Lip Sync Renders · Video hát nhép',
    labelKey: 'zone.lipsyncVideo',
  },
];
export const zoneLabel = z =>
  (z?.labelKey && globalThis.mvT ? globalThis.mvT(z.labelKey) : z?.label) || z?.label || '';
export const ZONE_W = 340;
// Which stream a node belongs to — mirror of nodeStream() in lib/zones.mjs (the state the browser
// gets already carries the resolved zone). '' = an asset, or a Seedance group.
const STREAM = { production: 'A', merged: 'A', output: 'A', lipsync: 'B', 'lipsync-video': 'B' };
export const nodeStream = n => (n ? STREAM[n.zone] || '' : '');
export const STREAM_LABEL = { A: 'Luồng A · Phủ cảnh', B: 'Luồng B · Câu hát nhép' };
export const streamLabel = stream =>
  (globalThis.mvT && stream
    ? globalThis.mvT(stream === 'A' ? 'stream.coverage' : 'stream.lipsync')
    : '') ||
  STREAM_LABEL[stream] ||
  '';
// Where a node sits on the song, in seconds, as [in, out] — or null when it has no time. Mirror of
// nodeTime() in lib/zones.mjs: a shot spans [start, start + duration], a lip-sync take spans the
// cut it sends to Omni, [clipStart, clipEnd] (a take has no `duration` — that field means "shot").
export function nodeTime(n) {
  if (!n) return null;
  const [a, b] =
    n.role === 'lipsync'
      ? [Number(n.clipStart), Number(n.clipEnd)]
      : [Number(n.start), Number(n.start) + Number(n.duration)];
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a ? [a, b] : null;
}
const zoneIndex = id =>
  Math.max(
    0,
    ZONES.findIndex(z => z.id === id),
  );
// The columns of produced clips: ⑧ (clips of shots and merged scenes), ⑩ (Seedance groups) and
// ⑫ (lip-sync takes).
export const CLIP_ZONES = ['output', 'seedance-video', 'lipsync-video'];
// Order within a zone: production follows seq; a clip column follows its source's seq then version.
const zoneOrder = n =>
  CLIP_ZONES.includes(n.zone) ? (n.sourceSeq || 999) * 100 + (n.version || 0) : n.seq || 999;
// Lays every node out into its zone column, stacked in order (the arrange button).
// Output videos are special: each sits on the SAME ROW as the production node it came
// from, and extra versions line up to its right — so a shot with no video yet leaves a
// gap instead of pulling the videos below it upward.
const OUT_STEP = 250;
// horizontal gap between versions of the same shot
// First row, below the column name: the stream labels wrap onto two lines, so the cards start
// lower than the one-line labels needed.
const FIRST_Y = 74;
// `hidden` is a display-only set used when a Seedance group is collapsed on the canvas. The
// stored graph remains unchanged; the rest of that column closes its gap for easier navigation.
export function zoneLayout(hidden = new Set()) {
  const rows = {},
    pos = {},
    sourceY = {},
    outputs = [];
  const merged = [];
  for (const n of [...store.state.nodes].sort((a, b) => zoneOrder(a) - zoneOrder(b))) {
    if (hidden.has(n.id)) continue;
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
    const y = FIRST_Y + row * 285;
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
    const y = first && first.id in sourceY ? sourceY[first.id] : FIRST_Y + mergedRow++ * 285;
    pos[n.id] = { x: 24 + zoneIndex('merged') * ZONE_W, y };
    sourceY[n.id] = y;
  }
  const used = {}; // clip column + row → the sources placed there, left to right
  const orphanY = {}; // clips whose source is gone: one row per source, below everything
  let orphanRow = Object.values(sourceY).length;
  for (const n of outputs) {
    const key = n.source || n.id;
    const y =
      n.source in sourceY ? sourceY[n.source] : (orphanY[key] ??= FIRST_Y + orphanRow++ * 285);
    const slot = n.zone + '@' + y;
    const list = used[slot] || (used[slot] = []);
    if (!list.includes(key)) list.push(key);
    // every version of one source sits on the same spot: the canvas shows one card for them
    pos[n.id] = { x: 24 + zoneIndex(n.zone) * ZONE_W + list.indexOf(key) * OUT_STEP, y };
  }
  return pos;
}
