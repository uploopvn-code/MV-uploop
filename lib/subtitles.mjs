// Subtitles: build an .srt track from a project's storyboard. Every shot already carries the
// spoken line (`lyric`), its length (`duration`) and its order (`seq`), so the track needs no
// transcription — it reads straight off the graph. Shots are assumed to play back-to-back in
// order, so timecodes accumulate from each shot's duration; silent shots (no line, or a stage
// direction in brackets) take up their time but emit no subtitle block.
import { isSetting } from './nodes.mjs';
import { noLine } from './prompts.mjs';
import { isFrame } from './merged.mjs';
import { nodeZone } from './zones.mjs';

const DEFAULT_SECONDS = 8; // a shot with no duration is treated as one Veo clip

// The storyboard shots that carry the film's dialogue, in play order. Production shots and
// merged scenes (one clip of 2–3 setups), never the per-setup frame images or setting nodes.
function shots(nodes) {
  return nodes
    .filter(
      n =>
        !n.terminal &&
        !isSetting(n) &&
        !isFrame(n) &&
        ['production', 'merged'].includes(nodeZone(n)),
    )
    .sort((a, b) => {
      const sa = Number.isFinite(a.start) ? a.start : Infinity;
      const sb = Number.isFinite(b.start) ? b.start : Infinity;
      return sa - sb || (a.seq || 0) - (b.seq || 0);
    });
}

// "Eleanor: Chúng ta phải đi." → "Chúng ta phải đi." when speaker names are dropped. Also
// strips the surrounding quotes a lyric is sometimes wrapped in.
function lineText(lyric, keepNames) {
  let t = String(lyric || '').trim();
  if (!keepNames) t = t.replace(/^\s*[^:[\]"]{1,40}:\s*/, '');
  return t.replace(/^["“”']+|["“”']+$/g, '').trim();
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function timecode(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return (
    `${pad(Math.floor(ms / 3600000))}:` +
    `${pad(Math.floor(ms / 60000) % 60)}:` +
    `${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
  );
}

// Builds the SRT text for the project. keepNames keeps the "Name:" speaker prefix on each line.
export function buildSrt(nodes, { keepNames = false } = {}) {
  const blocks = [];
  let t = 0; // running start time on the assembled timeline, in seconds
  let index = 0;
  for (const n of shots(nodes)) {
    const dur = Number.isFinite(n.duration) && n.duration > 0 ? n.duration : DEFAULT_SECONDS;
    const start = t;
    t += dur;
    if (noLine(n.lyric)) continue; // silent shot: it still takes up time, but shows nothing
    const text = lineText(n.lyric, keepNames);
    if (!text) continue;
    blocks.push(`${++index}\n${timecode(start)} --> ${timecode(t)}\n${text}`);
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

// How many subtitle lines the track would hold (for the UI to report before download).
export const srtLineCount = nodes =>
  shots(nodes).filter(n => !noLine(n.lyric) && lineText(n.lyric, false)).length;
