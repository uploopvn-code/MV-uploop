// Edit manifests: one CSV per stream, to open in an NLE next to the downloaded clips.
// Luồng A (⑥ ⑦ → ⑧) tiles the whole song with coverage — band wide/medium/close, the instrument
// playing at that moment, the full stage, the audience. Luồng B (⑪ → ⑫) holds the sung lines, one
// take per 7–10 s of singing. Both lanes run over the same seconds of the song, so the editor cuts
// between them freely — which is exactly what a flat prompt export cannot say.
// Each row is one clip to place: its seconds, its timecode, what it shows, and the EXACT name the
// clip downloads as (videoFileName), so the file on disk can be matched without guessing.
import { isFrame } from './merged.mjs';
import { videoFileName } from './media.mjs';
import { isSetting } from './nodes.mjs';
import { groupsOf } from './seedance.mjs';
import { nodeStream, nodeTime } from './zones.mjs';

export const MANIFEST_COLUMNS = [
  'No',
  'In_s',
  'Out_s',
  'In_TC',
  'Out_TC',
  'Dur_s',
  'Section',
  'Subject',
  'Shot Size',
  'Angle',
  'Movement',
  'Location',
  'Lyric',
  'ClipFile',
  'Status',
];
// The timecode form every NLE reads. 25 fps: the project's songs are cut to seconds, not to a
// broadcast frame rate, so one fixed grid keeps the two manifests comparable.
export const FPS = 25;
export const STREAMS = {
  A: { file: 'luong-A-phu-canh.csv', label: 'Luồng A · Phủ cảnh' },
  B: { file: 'luong-B-hat-nhep.csv', label: 'Luồng B · Câu hát nhép' },
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
// hh:mm:ss:ff
export function timecode(sec, fps = FPS) {
  const f = Math.max(0, Math.round(Number(sec) * fps));
  return (
    `${pad(Math.floor(f / (3600 * fps)))}:${pad(Math.floor(f / (60 * fps)) % 60)}:` +
    `${pad(Math.floor(f / fps) % 60)}:${pad(f % fps)}`
  );
}
const csvCell = v => {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// A camera column the CSV wrote per beat: a merged shot keeps them in parts[], a single row has
// them on the node too. The first beat that filled it wins — that is the frame the clip opens on.
function beatField(n, key) {
  for (const p of Array.isArray(n.parts) ? n.parts : [])
    if (String(p?.[key] ?? '').trim()) return String(p[key]).trim();
  return String(n[key] ?? '').trim();
}
// The clip the editor will actually place: the newest version in the clip column, else a video
// uploaded onto the node by hand, else — when this coverage shot is filmed inside a Seedance group
// (one clip covers several shots) — that group's clip, flagged so the editor knows one file holds
// more than this row.
const clipOf = (n, nodes) => {
  const own =
    nodes
      .filter(t => t.terminal && t.source === n.id && t.video)
      .sort((a, b) => (a.version || 0) - (b.version || 0))
      .at(-1) || (n.video ? n : null);
  if (own) return own;
  for (const g of groupsOf(n.id)) {
    const gc =
      nodes
        .filter(t => t.terminal && t.source === g.id && t.video)
        .sort((a, b) => (a.version || 0) - (b.version || 0))
        .at(-1) || (g.video ? g : null);
    if (gc) return { ...gc, group: true };
  }
  return null;
};

// The rows of one stream, sorted by time (the order they are laid on the timeline).
export function manifestRows(nodes, stream) {
  return nodes
    .filter(
      n => !n.terminal && !isSetting(n) && !isFrame(n) && nodeStream(n) === stream && nodeTime(n),
    )
    .sort((a, b) => nodeTime(a)[0] - nodeTime(b)[0] || (a.seq || 0) - (b.seq || 0))
    .map((n, i) => {
      const [inSec, outSec] = nodeTime(n);
      const clip = clipOf(n, nodes);
      return {
        No: i + 1,
        In_s: inSec.toFixed(3),
        Out_s: outSec.toFixed(3),
        In_TC: timecode(inSec),
        Out_TC: timecode(outSec),
        Dur_s: (outSec - inSec).toFixed(3),
        Section: n.section || beatField(n, 'section'),
        Subject: n.subject || beatField(n, 'subject'),
        'Shot Size': n.shotSize || beatField(n, 'shotSize'),
        Angle: beatField(n, 'angle'),
        Movement: beatField(n, 'movement'),
        Location: beatField(n, 'location'),
        Lyric: n.lyric || '',
        ClipFile: clip ? videoFileName(clip) : '',
        // A clip carries its own out-of-date flag; a video uploaded onto the node reads the node's.
        Status: !clip
          ? 'chưa có video'
          : clip.group
            ? 'trong clip nhóm Seedance'
            : (clip.outdated ?? n.videoStale)
              ? 'video cũ — đầu vào đã đổi'
              : 'đã có video',
      };
    });
}
// The CSV text of one stream (BOM first, so Excel reads the Vietnamese and the Spanish lyrics).
export function buildManifest(nodes, stream) {
  const rows = manifestRows(nodes, stream);
  const lines = rows.map(r => MANIFEST_COLUMNS.map(c => csvCell(r[c])).join(','));
  return { rows, csv: '﻿' + [MANIFEST_COLUMNS.join(','), ...lines].join('\n') + '\n' };
}
