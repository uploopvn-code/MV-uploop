// Subtitles: build an .srt track from a project's two streams. The sung text of an MV lives in
// luồng B (⑪ câu hát nhép) — one take per 7–10 s of singing — so the track is cut from the takes
// whenever the project has them; a project without takes (a drama, or an MV before the takes are
// cut) falls back to luồng A (⑥ ⑦), where each shot carries the line it is filmed on.
// Each block is placed by the row's OWN time (nodeTime), never by adding durations up: the first
// gap in the column used to push every later subtitle out of sync. Silent rows emit nothing.
import { isSetting } from './nodes.mjs';
import { noLine } from './prompts.mjs';
import { isFrame } from './merged.mjs';
import { nodeStream, nodeTime } from './zones.mjs';

// The rows the track is cut from, in play order, and which stream they came from. Takes win over
// shots: they are the sung lines themselves, cut on the voice.
export function srtRows(nodes) {
  const timed = s =>
    nodes.filter(
      n => !n.terminal && !isSetting(n) && !isFrame(n) && nodeStream(n) === s && nodeTime(n),
    );
  const takes = timed('B');
  const rows = takes.length ? takes : timed('A');
  rows.sort((a, b) => nodeTime(a)[0] - nodeTime(b)[0] || (a.seq || 0) - (b.seq || 0));
  return { stream: takes.length ? 'B' : 'A', rows };
}

// "Eleanor: Chúng ta phải đi." → "Chúng ta phải đi." when speaker names are dropped. Also
// strips the surrounding quotes a lyric is sometimes wrapped in.
function lineText(lyric, keepNames) {
  let t = String(lyric || '').trim();
  if (!keepNames) t = t.replace(/^\s*[^:[\]"]{1,40}:\s*/, '');
  return t.replace(/^["“”']+|["“”']+$/g, '').trim();
}
// The rows that actually show a subtitle (a line that is not a stage direction).
const spoken = (rows, keepNames) =>
  rows.filter(n => !noLine(n.lyric) && lineText(n.lyric, keepNames));

const pad = (n, w = 2) => String(n).padStart(w, '0');
function timecode(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return (
    `${pad(Math.floor(ms / 3600000))}:` +
    `${pad(Math.floor(ms / 60000) % 60)}:` +
    `${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
  );
}

// One subtitle per sung line, with its own time. A lip-sync take holds several lines over 7–10 s
// (lsLines, each with its own sung start/end), so it expands into one line each — not one block of
// several lyrics across the whole padded clip. A luồng-A shot is one line at its own time.
function srtEntries(rows, keepNames) {
  const out = [];
  for (const n of rows) {
    if (Array.isArray(n.lsLines) && n.lsLines.length) {
      for (const l of n.lsLines) {
        const text = lineText(l.lyric, keepNames);
        if (text && !noLine(l.lyric)) out.push({ start: l.start, end: l.end, text });
      }
    } else if (!noLine(n.lyric)) {
      const text = lineText(n.lyric, keepNames);
      const [start, end] = nodeTime(n);
      if (text) out.push({ start, end, text });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Builds the SRT text for the project. keepNames keeps the "Name:" speaker prefix on each line.
export function buildSrt(nodes, { keepNames = false } = {}) {
  const { rows } = srtRows(nodes);
  const blocks = srtEntries(rows, keepNames).map(
    (e, i) => `${i + 1}\n${timecode(e.start)} --> ${timecode(e.end)}\n${e.text}`,
  );
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

// How many subtitle lines the track would hold, and from which stream (for the UI to report
// before the download).
export function srtInfo(nodes) {
  const { stream, rows } = srtRows(nodes);
  return { stream, lines: srtEntries(rows, false).length };
}
