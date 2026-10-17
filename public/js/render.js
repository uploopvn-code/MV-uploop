// Top-level rendering: draws the current view (and the sidebar song player) and refreshes
// state from the server.
import { store } from './store.js';
import { renderGraph, suppressNodeClick } from './canvas.js';
import { $, api, esc, paint, toast, workflowBusy, workflowProcessing } from './core.js';
import { loadDirector } from './director.js';
import { renderGallery } from './gallery.js';
import { inspect, upload } from './inspector.js';
import { renderJobs } from './jobs.js';
import { renderProjects } from './projects.js';
import { orbitStatus, paintDefaults, showOrbit } from './providers.js';
import { keepCaptures } from './stage-keeper.js';
import { nodeStream, nodeTime } from './zones.js';
import { t } from './i18n.js';

// --- The two-lane time strip under the canvas ---------------------------------------------------
// Lane A = luồng phủ cảnh (⑥ ⑦), lane B = câu hát nhép (⑪). Every block is placed by its own
// seconds over the song's length, so the two lanes read as what they are: two tracks the editor
// cuts between. Blocks that overlap inside one lane drop to a second row and are outlined — the
// user has to SEE an overlap (a take's cut can run into the next one's), not have it hidden.
const clock = s => {
  const v = Math.floor(Math.max(0, s));
  return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
};
const timelineSelection = new Set();
const clipDurations = new Map();
let timelineCursor = 0;
let timelinePlayToken = 0;
let timelinePlaying = false; // the Play/Pause toggle state (montage preview)
let timelineZoom = 1; // horizontal zoom of the strip (+/- keys)
let finishTimelineClip = null;
let timelineRaf = null; // the song-time-driven playback loop (rAF handle)
let timelineActiveBlock = null; // the clip the preview is currently showing (for manual re-sync)
// A fixed lip-sync offset (seconds) the user dials in to compensate for video-vs-audio latency or a
// re-rendered clip (e.g. Google Vids) whose mouth lands a touch early/late: positive pushes the
// video AHEAD of the song (fixes a mouth that lags). Saved per browser.
let timelineSyncOffset = 0;
try {
  timelineSyncOffset = Number(localStorage.getItem('mv-timeline-sync-offset')) || 0;
} catch {}
// The song track: the project-level audio, or (the new place) the MUSIC node's own audio.
const projectAudio = () =>
  store.state.audio || store.state.nodes?.find(n => n.kind === 'music')?.audio || null;
// Per-lane audio: mute/solo like a mixer. Lanes a (phủ cảnh) and b (hát nhép) carry each clip's own
// audio; "audio" is the song. The user flips these from the lane headers. Smart default: hear the
// SONG, with the clips muted (so a lip-sync vocal doesn't double the song) — but when there is NO
// song, the clips play their own audio. An explicit toggle overrides the default.
const timelineAudio = { mute: {}, solo: null };
const laneHasAudio = id => id === 'a' || id === 'b' || id === 'audio';
const laneAudible = id => {
  if (timelineAudio.solo) return timelineAudio.solo === id;
  if (id in timelineAudio.mute) return !timelineAudio.mute[id];
  if (id === 'audio') return true;
  // Clip lanes default audible only when the SONG track isn't carrying the sound — i.e. there is no
  // song, or the user muted it. That way muting the song reveals the clips instead of going silent.
  const songAudible = 'audio' in timelineAudio.mute ? !timelineAudio.mute.audio : true;
  return !projectAudio()?.url || !songAudible;
};
let timelinePlayLane = 'a';
// Waveform: decode an audio/video file once (cached), compute per-pixel peaks, draw on a canvas.
const wavePeaksCache = new Map();
async function decodePeaks(url, buckets = 1600) {
  if (wavePeaksCache.has(url)) return wavePeaksCache.get(url);
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const arr = await (await fetch(url)).arrayBuffer();
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(arr);
    ctx.close?.();
    const ch = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / buckets));
    const peaks = new Float32Array(buckets);
    let peak = 0;
    for (let i = 0; i < buckets; i++) {
      let m = 0;
      const s = i * step;
      for (let j = 0; j < step && s + j < ch.length; j++) {
        const v = Math.abs(ch[s + j]);
        if (v > m) m = v;
      }
      peaks[i] = m;
      if (m > peak) peak = m;
    }
    if (peak > 0) for (let i = 0; i < buckets; i++) peaks[i] /= peak; // normalise
    wavePeaksCache.set(url, peaks);
    return peaks;
  } catch {
    return null;
  }
}
function drawWave(canvas, peaks, played = 0) {
  const w = Math.max(1, Math.round(canvas.clientWidth || canvas.width));
  const h = Math.max(1, Math.round(canvas.clientHeight || 24));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!peaks) return;
  const mid = h / 2;
  const n = peaks.length;
  const cut = Math.round(played * w); // played part drawn brighter
  for (let x = 0; x < w; x++) {
    const bar = Math.max(1, (peaks[Math.floor((x / w) * n)] || 0) * (h - 2));
    g.fillStyle = x <= cut ? '#a9e063' : '#4f6a33';
    g.fillRect(x, mid - bar / 2, 1, bar);
  }
}
function applyTimelineAudio() {
  const au = $('#timelinePreviewAudio');
  const pl = $('#timelinePlayer');
  if (au) au.muted = !laneAudible('audio');
  if (pl) pl.muted = !laneAudible(timelinePlayLane);
}
// Wire the song player in the audio lane each render (its DOM is rebuilt by paint): draw the
// waveform (from cache), move the playhead, and hook play/stop/seek.
// Decode waveforms off the main thread-ish: at most a few audio files decoding at once, cached.
const waveQueue = [];
let waveActive = 0;
function pumpWaveQueue() {
  while (waveActive < 3 && waveQueue.length) {
    const { canvas, url } = waveQueue.shift();
    waveActive++;
    decodePeaks(url)
      .then(p => { if (p && canvas.isConnected) drawWave(canvas, p); })
      .finally(() => { waveActive--; pumpWaveQueue(); });
  }
}
function enqueueWave(canvas, url) {
  if (!canvas || !url) return;
  const cached = wavePeaksCache.get(url);
  if (cached) { if (canvas.isConnected) drawWave(canvas, cached); return; }
  waveQueue.push({ canvas, url });
  pumpWaveQueue();
}
// Draw the song waveform in the audio lane (click = scrub the timeline cursor) and each video
// clip's own audio waveform — but only for clips wide enough to read (i.e. once zoomed in), so a
// fully zoomed-out timeline of 100+ tiny clips never fetches them all.
function setupWaveforms() {
  const strip = document.querySelector?.('#timelineTrack .timeline-strip');
  const total = Number(strip?.dataset?.total) || 1;
  const songCanvas = document.querySelector?.('#timelineTrack .audio-track .wave-canvas');
  if (songCanvas) {
    const url = songCanvas.closest('.audio-track').dataset.audioUrl;
    enqueueWave(songCanvas, url);
    songCanvas.onclick = e => {
      const lane = songCanvas.closest('.lane');
      const r = (lane || songCanvas).getBoundingClientRect();
      setTimelineCursor(((e.clientX - r.left) / r.width) * total);
    };
  }
  document.querySelectorAll?.('#timelineTrack .wave-video').forEach(c => {
    if (wavePeaksCache.has(c.dataset.audioUrl)) drawWave(c, wavePeaksCache.get(c.dataset.audioUrl));
    else if (c.offsetWidth >= 24) enqueueWave(c, c.dataset.audioUrl); // only when wide enough to see
  });
}
function setTimelineZoom(z) {
  timelineZoom = Math.max(1, Math.min(8, z));
  applyTimelineZoom();
}
function applyTimelineZoom() {
  const strip = document.querySelector?.('#timelineTrack .timeline-strip');
  if (!strip) return;
  const base = Math.max(120, strip.clientWidth - 144); // lane width at 100% (minus the sticky name)
  const laneW = Math.round(base * timelineZoom);
  const zoomed = timelineZoom > 1.001;
  strip.classList.toggle('zoomed', zoomed);
  strip.querySelectorAll('.lane, .timeline-ruler').forEach(l => {
    l.style.width = zoomed ? laneW + 'px' : '';
    l.style.flex = zoomed ? '0 0 auto' : '';
  });
  const lbl = document.querySelector('#timelineZoomLabel');
  if (lbl) lbl.textContent = Math.round(timelineZoom * 100) + '%';
  requestAnimationFrame(setupWaveforms); // redraw waveforms at the new width
}
const tx = key =>
  typeof t === 'function'
    ? t(key)
    : ({
        'timeline.preview': 'Timeline Preview',
        'timeline.playAll': 'Play All',
        'timeline.pause': 'Pause',
        'timeline.clear': 'Clear Selection',
        'timeline.start': 'Start',
        'timeline.duration': 'Duration',
        'timeline.apply': 'Apply Trim',
        'timeline.selected': 'selected',
        'timeline.clips': 'clips',
        'render.addSong': 'Add song',
        'render.orbitDirectReady': 'Direct Orbit runner is enabled. Sign in and choose a script/account in the node.',
      }[key] || key);
function segmentsOf(n, clip, sourceTime = nodeTime(n)) {
  // A lip-sync clip is pinned to the song by the Omni cut it was RENDERED FROM (clip.start, the
  // start of "Đoạn gửi Omni" at that moment) and by nothing else — never by the take's current
  // clipStart, nor by a position/trim saved against an OLDER cut. Both of those slide the picture
  // in by exactly the lead-in later added at the front, which is the lag we were chasing. Its
  // length follows the real video (measured), else the length recorded with the clip.
  if (n.role === 'lipsync' && Number.isFinite(Number(clip.start)))
    return [
      {
        id: clip.id,
        position: Number(clip.start),
        inPoint: 0,
        outPoint: Number(
          clipDurations.get(clip.id) ?? clip.duration ?? sourceTime[1] - sourceTime[0],
        ),
      },
    ];
  if (clip.timelineSegments?.length) return clip.timelineSegments;
  return [{ id: clip.id, position: Number(clip.timelineStart ?? sourceTime[0]),
    inPoint: Number(clip.trimIn ?? 0),
    outPoint: Number(clip.trimOut ?? clipDurations.get(clip.id) ?? (sourceTime[1] - sourceTime[0])) }];
}
async function saveTimelineSegment(block, edit) {
  stopTimelinePreview();
  const segments = segmentsOf(block.n, block.clip).map(s => s.id === block.key ? { ...s, ...edit } : s);
  await api('/api/node', { method: 'PATCH', body: { id: block.clip.id, timelineSegments: segments } });
  await refresh();
}
// Rows of one lane: the node, its [in, out], and which sub-row it has to sit in to stay readable.
function laneBlocks(stream) {
  const outputs = new Map();
  for (const n of store.state.nodes) {
    if (!n.terminal || !n.source || !n.video?.url) continue;
    const previous = outputs.get(n.source);
    if (!previous || Number(n.version || 0) >= Number(previous.version || 0))
      outputs.set(n.source, n);
  }
  const hasRenderedVideo = store.state.nodes.some(n => n.video?.url);
  const rows = store.state.nodes
    .filter(
      n =>
        !n.terminal &&
        n.kind !== 'setting' &&
        (!hasRenderedVideo || !!(outputs.get(n.id)?.video?.url || n.video?.url)) &&
        nodeStream(n) === stream &&
        nodeTime(n),
    )
    .flatMap(n => {
      const preferred = n.timelineClipId
        ? store.state.nodes.find(
            clip =>
              clip.id === n.timelineClipId &&
              clip.terminal &&
              clip.source === n.id &&
              clip.video?.url,
          )
        : null;
      const clip = preferred || outputs.get(n.id) || (n.video?.url ? n : null);
      const sourceTime = nodeTime(n);
      if (!clip) return [{ n, t: sourceTime, clip: null, key: n.id }];
      return segmentsOf(n, clip, sourceTime).map(s => ({ n,
        t: [s.position, s.position + s.outPoint - s.inPoint],
        clip, key: s.id, edit: { position: s.position, inPoint: s.inPoint, outPoint: s.outPoint } }));
    })
    .sort((a, b) => a.t[0] - b.t[0]);
  const ends = []; // where each sub-row is free again
  const lane = stream === 'B' ? 'b' : 'a';
  for (const b of rows) {
    b.lane = lane;
    // 1 ms of slack: shots are meant to touch, only a real overlap goes to the next row
    b.row = ends.findIndex(e => e <= b.t[0] + 0.001);
    if (b.row < 0) b.row = ends.push(0) - 1;
    ends[b.row] = b.t[1];
  }
  return rows;
}
function timelineClips() {
  return [...laneBlocks('A'), ...laneBlocks('B')]
    .filter(b => b.clip?.video?.url)
    .sort((a, b) => a.t[0] - b.t[0] || a.n.seq - b.n.seq);
}
function setTimelineCursor(seconds) {
  const strip = $('#timelineTrack .timeline-strip');
  const total = Number(strip?.dataset?.total) || Math.max(1, ...timelineClips().map(b => b.t[1]));
  timelineCursor = Math.max(0, Math.min(total, Number(seconds) || 0));
  const percent = `${(timelineCursor / total) * 100}%`;
  document.querySelectorAll('#timelineTrack [data-playhead]').forEach(marker => {
    marker.style.left = percent;
  });
  const time = $('#timelineTime');
  if (time) time.textContent = `${clock(timelineCursor)} / ${clock(total)}`;
  const split = $('#timelineSplit');
  if (split) split.disabled = !timelineClips().some(b => b.t[0] + 0.1 < timelineCursor && timelineCursor < b.t[1] - 0.1);
}
async function splitTimelineAtCursor() {
  stopTimelinePreview();
  const underCursor = timelineClips().filter(b => b.t[0] + 0.1 < timelineCursor && timelineCursor < b.t[1] - 0.1);
  const block = underCursor.find(b => timelineSelection.has(b.key)) || underCursor[0];
  if (!block) return;
  const cut = block.edit.inPoint + timelineCursor - block.t[0];
  const newId = 'cut-' + crypto.randomUUID();
  const segments = segmentsOf(block.n, block.clip).flatMap(s => s.id === block.key
    ? [{ ...s, outPoint: cut }, { id: newId, position: timelineCursor, inPoint: cut, outPoint: s.outPoint }]
    : [s]);
  try {
    await api('/api/node', { method: 'PATCH', body: { id: block.clip.id, timelineSegments: segments } });
    timelineSelection.clear();
    timelineSelection.add(newId);
    await refresh();
  } catch (err) { toast(err.message, true); }
}
async function removeTimelineSegment() {
  stopTimelinePreview();
  const block = timelineClips().find(b => timelineSelection.has(b.key));
  if (!block) return;
  const segments = segmentsOf(block.n, block.clip);
  if (segments.length < 2) return;
  try {
    await api('/api/node', { method: 'PATCH', body: {
      id: block.clip.id, timelineSegments: segments.filter(s => s.id !== block.key),
    } });
    timelineSelection.clear();
    await refresh();
  } catch (err) { toast(err.message, true); }
}
function scrubTimeline() {
  stopTimelinePreview();
  const block = timelineClips().find(b => b.t[0] <= timelineCursor && timelineCursor < b.t[1]);
  const panel = $('#timelinePreview');
  const player = $('#timelinePlayer');
  const label = $('#timelinePreviewLabel');
  if (!panel || !player || !label) return;
  panel.hidden = false;
  if (!block) {
    label.textContent = tx('timeline.emptyAtCursor');
    return;
  }
  label.textContent = `${block.n.name} · ${clock(timelineCursor)}`;
  const offset = block.edit.inPoint + timelineCursor - block.t[0];
  if (player.getAttribute('src') !== block.clip.video.url) player.src = block.clip.video.url;
  const seek = () => { try { player.currentTime = offset; } catch {} };
  if (player.readyState >= 1) seek();
  else player.onloadedmetadata = seek;
}
function stopTimelinePreview() {
  timelinePlayToken++;
  timelinePlaying = false;
  timelineActiveBlock = null;
  if (timelineRaf) {
    cancelAnimationFrame(timelineRaf);
    timelineRaf = null;
  }
  finishTimelineClip?.();
  const player = $('#timelinePlayer');
  if (player) {
    player.onloadedmetadata = null;
    player.pause();
  }
  $('#timelinePreviewAudio')?.pause();
  updatePlayButton();
}
// Play/pause toggle for the whole timeline preview (montage + song). Replaces "Phát toàn bộ".
function toggleTimeline() {
  if (timelinePlaying) stopTimelinePreview();
  else if (timelineClips().length) playTimelinePreview();
}
function updatePlayButton() {
  const btn = $('#timelinePlayPause');
  if (btn) {
    btn.textContent = timelinePlaying ? '⏸ ' + tx('timeline.pause') : '▶ ' + tx('timeline.playAll');
    btn.classList.toggle('active', timelinePlaying);
  }
}
// Play the timeline the way the editor will cut it: the SONG is the master clock and runs
// continuously, while each clip is shown at its own song-time (the gaps between clips play as real
// silence/standstill). The old montage played clips back-to-back and skipped the gaps, so nothing
// lined up with the music — useless for checking lip-sync. With no song, a wall clock drives the
// same timeline so the gaps are still honoured.
async function playTimelinePreview(startId = null) {
  stopTimelinePreview();
  timelinePlaying = true;
  updatePlayButton();
  const token = timelinePlayToken;
  const allClips = timelineClips();
  if (startId) {
    const chosen = allClips.find(b => b.key === startId || b.n.id === startId);
    if (chosen) setTimelineCursor(chosen.t[0]);
  }
  const panel = $('#timelinePreview');
  const player = $('#timelinePlayer');
  const audio = $('#timelinePreviewAudio');
  const label = $('#timelinePreviewLabel');
  if (!panel || !player || !audio || !label) return;
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (!allClips.length) {
    label.textContent = tx('timeline.noVideos');
    timelinePlaying = false;
    updatePlayButton();
    return;
  }
  const strip = $('#timelineTrack .timeline-strip');
  const total =
    Number(strip?.dataset?.total) || Math.max(1, ...allClips.map(b => b.t[1]));
  // Start from the cursor; if it is already at the end, restart from 0.
  if (timelineCursor >= total - 0.05) setTimelineCursor(0);
  const startCursor = timelineCursor;
  const audioUrl = projectAudio()?.url;
  if (audioUrl) {
    if (audio.getAttribute('src') !== audioUrl) audio.src = audioUrl;
  } else audio.removeAttribute('src');
  audio.muted = !laneAudible('audio');

  // The master clock is SONG TIME: the music element when there is a song, else a wall timer.
  let wallStart = performance.now();
  const songTime = () =>
    audioUrl ? audio.currentTime : startCursor + (performance.now() - wallStart) / 1000;
  // The clip to SHOW at song time t: a block covering t, lane B (hát nhép) preferred for lip-sync,
  // then the one that started most recently.
  const activeAt = t => {
    const covering = allClips.filter(b => t >= b.t[0] - 1e-3 && t < b.t[1] - 1e-3);
    if (!covering.length) return null;
    covering.sort(
      (a, b) => (a.lane === 'b' ? 0 : 1) - (b.lane === 'b' ? 0 : 1) || b.t[0] - a.t[0],
    );
    return covering[0];
  };
  let current = null;
  const loadBlock = b => {
    current = b;
    if (player.getAttribute('src') !== b.clip.video.url) player.src = b.clip.video.url;
    timelinePlayLane = b.lane || 'a';
    label.textContent = `${b.n.name}${b.clip.terminal ? ' · v' + (b.clip.version || 1) : ''} · ${clock(b.t[0])}`;
  };
  // Keep the shown clip's frame matched to the song: seek it to its in-point + how far the song is
  // into the clip, and nudge it back whenever it drifts more than ~0.18 s.
  const syncPlayer = t => {
    if (!current) return;
    const want = current.edit.inPoint + (t - current.t[0]) + timelineSyncOffset;
    if (player.readyState >= 1 && Math.abs(player.currentTime - want) > 0.18) {
      try { player.currentTime = Math.max(0, want); } catch {}
    }
    if (player.paused) player.play().catch(() => {});
  };

  if (audioUrl) {
    try { audio.currentTime = startCursor; } catch {}
    await audio.play().catch(() => {});
    wallStart = performance.now(); // align the fallback clock in case the song cannot play
  }

  const tick = () => {
    if (token !== timelinePlayToken) return;
    const t = songTime();
    if (t >= total - 0.02) {
      setTimelineCursor(total);
      stopTimelinePreview();
      return;
    }
    setTimelineCursor(t);
    const want = activeAt(t);
    if (want) {
      if (want !== current || player.getAttribute('src') !== want.clip.video.url) loadBlock(want);
      player.muted = !laneAudible(timelinePlayLane); // the mixer can change mid-play
      syncPlayer(t);
      timelineActiveBlock = current; // what the "Sync Audio" button realigns
    } else {
      // A gap: no clip here. Hold the last frame and let the song keep playing.
      current = null;
      timelineActiveBlock = null;
      if (!player.paused) player.pause();
      label.textContent = '♪ ' + clock(t);
    }
    audio.muted = !laneAudible('audio');
    timelineRaf = requestAnimationFrame(tick);
  };
  timelineRaf = requestAnimationFrame(tick);
}
// Manual "Sync Audio": snap the shown video HARD onto the song clock right now (the loop only nudges
// once drift passes ~0.18 s, so a small steady lag can linger — this zeroes it on demand). Works
// while playing; paused, it aligns the clip under the playhead to the cursor.
function syncTimelineAudio() {
  const player = $('#timelinePlayer');
  const audio = $('#timelinePreviewAudio');
  if (!player) return;
  const audioUrl = projectAudio()?.url;
  const t = audioUrl && audio && !audio.paused ? audio.currentTime : timelineCursor;
  let block = timelineActiveBlock;
  if (!block || !(t >= block.t[0] - 1e-3 && t < block.t[1] - 1e-3)) {
    block = timelineClips()
      .filter(b => t >= b.t[0] - 1e-3 && t < b.t[1] - 1e-3)
      .sort((a, b) => (a.lane === 'b' ? 0 : 1) - (b.lane === 'b' ? 0 : 1) || b.t[0] - a.t[0])[0];
  }
  if (!block) {
    toast(tx('timeline.syncNoClip'));
    return;
  }
  const want = block.edit.inPoint + (t - block.t[0]) + timelineSyncOffset;
  try {
    player.currentTime = Math.max(0, want);
  } catch {}
  if (timelinePlaying && player.paused) player.play().catch(() => {});
  toast(tx('timeline.syncDone'));
}
function timelineStrip() {
  const selected = [...timelineSelection][0];
  const selectedBlock = selected ? timelineClips().find(b => b.key === selected) : null;
  const lanes = [
    { id: 'a', name: tx('timeline.laneA'), blocks: laneBlocks('A') },
    { id: 'b', name: tx('timeline.laneB'), blocks: laneBlocks('B') },
  ];
  const audio = projectAudio();
  const audioDuration = Math.max(
    0,
    ...store.state.nodes.map(n => Number(n.audioDuration) || 0),
    Number(audio?.duration) || 0,
  );
  if (audio?.url) {
    lanes.push({
      id: 'audio',
      name: tx('timeline.audio'),
      blocks: [{ n: { id: 'audio-track', name: audio?.name || tx('timeline.projectAudio'), audioUrl: audio.url }, t: [0, audioDuration || 1], row: 0 }],
    });
  }
  const captionBlocks = laneBlocks('B').filter(b => b.n.lyric || b.n.name).map(b => ({ ...b, clip: null }));
  if (audio?.url && captionBlocks.length)
    lanes.push({ id: 'captions', name: tx('timeline.captions'), blocks: captionBlocks });
  if (!lanes.some(l => l.blocks.length)) return '';
  // The song is as long as the music node says, or at least as long as the last block.
  const total = Math.max(
    1,
    ...store.state.nodes.map(n => Number(n.audioDuration) || 0),
    ...lanes.flatMap(l => l.blocks.map(b => b.t[1])),
  );
  const markup = lanes
    .map(l => {
      const rows = Math.max(1, ...l.blocks.map(b => b.row + 1));
      const blocks = l.blocks
        .map(b => {
          const label = l.id === 'b' ? String(b.n.lyric || b.n.name) : b.n.name;
          const title = `${b.n.name} · ${clock(b.t[0])} → ${clock(b.t[1])} · ${(b.t[1] - b.t[0]).toFixed(2)}s${b.row ? ' · ⚠ ' + (globalThis.mvT?.('render.timelineOverlap') || 'chồng thời gian với khối khác cùng luồng') : ''}`;
          return (
            `<div class="blk${b.clip?.video?.url ? ' video-blk' : ''}${b.row ? ' over' : ''}${timelineSelection.has(b.key) ? ' selected' : ''}"${b.clip?.video?.url ? ' draggable="true"' : ''} data-node="${b.n.id}" data-segment="${esc(b.key)}" data-start="${b.t[0]}" title="${esc(title)}"` +
            ` style="left:${((b.t[0] / total) * 100).toFixed(3)}%;width:${Math.max(0.4, ((b.t[1] - b.t[0]) / total) * 100).toFixed(3)}%;top:${2 + b.row * (l.blocks.some(x => x.clip?.video?.url) ? 54 : 24)}px">` +
            (b.clip?.video?.url
              ? `<video class="timeline-thumb" muted playsinline preload="metadata" src="${esc(b.clip.video.url)}"></video><canvas class="wave-canvas wave-video" data-audio-url="${esc(b.clip.video.url)}"></canvas>`
              : b.n.id === 'audio-track'
                ? `<div class="timeline-placeholder audio-track" data-audio-url="${esc(b.n.audioUrl)}" title="${esc(label)}"><canvas class="wave-canvas"></canvas></div>`
                : `<div class="timeline-placeholder">${esc(label)}</div>`) +
            `<span class="timeline-label">${esc(label)}</span>${b.clip?.video?.url ? `<span class="trim-handle trim-handle-in" data-trim="in" title="${esc(tx('timeline.trimIn'))}"></span><span class="trim-handle trim-handle-out" data-trim="out" title="${esc(tx('timeline.trimOut'))}"></span>` : ''}</div>`
          );
        })
        .join('');
      const audioCtrl = laneHasAudio(l.id)
        ? `<span class="lane-audio">` +
          `<button type="button" class="lane-audio-btn${laneAudible(l.id) ? '' : ' off'}" data-lane-mute="${l.id}" title="Ẩn/bật tiếng layer này">${laneAudible(l.id) ? '🔊' : '🔇'}</button>` +
          `<button type="button" class="lane-audio-btn${timelineAudio.solo === l.id ? ' on' : ''}" data-lane-solo="${l.id}" title="Chỉ nghe tiếng layer này (solo)">S</button>` +
          `</span>`
        : '';
      return (
        `<div class="lane-row"><span class="lane-name">${esc(l.name)}<small>${l.blocks.length} ${esc(tx('timeline.blocks'))}</small>${audioCtrl}</span>` +
        `<div class="lane ${l.id}" style="height:${rows * (l.blocks.some(b => b.clip?.video?.url) ? 54 : 24) + 4}px">${blocks}<span class="timeline-playhead" data-playhead></span></div></div>`
      );
    })
    .join('');
  const input = (id, key, value) => `<label class="trim-control">${esc(tx(key))} <input id="${id}" type="number" min="0" step="0.01" value="${value}" ${selectedBlock ? '' : 'disabled'}></label>`;
  return `<div class="timeline-strip" data-total="${total}">` +
    `<div class="timeline-toolbar"><strong>${esc(tx('timeline.preview'))}</strong>` +
    `<button class="button${timelinePlaying ? ' active' : ''}" id="timelinePlayPause" type="button" ${timelineClips().length ? '' : 'disabled'}>${timelinePlaying ? '⏸ ' + esc(tx('timeline.pause')) : '▶ ' + esc(tx('timeline.playAll'))}</button>` +
    `<button class="button" id="timelineSyncAudio" type="button" title="${esc(tx('timeline.syncAudioHelp'))}">⟲ ${esc(tx('timeline.syncAudio'))}</button>` +
    `<label class="timeline-sync-offset" title="${esc(tx('timeline.syncOffsetHelp'))}">${esc(tx('timeline.syncOffset'))} <input id="timelineSyncOffset" type="number" step="50" value="${Math.round(timelineSyncOffset * 1000)}"> ms</label>` +
    `<span class="timeline-zoom"><button class="button" id="timelineZoomOut" type="button" title="Thu nhỏ timeline (phím −)">−</button><span id="timelineZoomLabel">${Math.round(timelineZoom * 100)}%</span><button class="button" id="timelineZoomIn" type="button" title="Phóng to timeline (phím +)">+</button></span>` +
    `<button class="button" id="timelineClearSelection" type="button">${esc(tx('timeline.clear'))}</button>` +
    `<button class="button" id="timelineSplit" type="button">✂ ${esc(tx('timeline.split'))}</button>` +
    `<button class="button" id="timelineRemove" type="button" ${selectedBlock && segmentsOf(selectedBlock.n, selectedBlock.clip).length > 1 ? '' : 'disabled'}>${esc(tx('timeline.removeSegment'))}</button>` +
    input('timelineTrimStart', 'timeline.position', selectedBlock?.edit.position ?? 0) +
    input('timelineTrimIn', 'timeline.trimIn', selectedBlock?.edit.inPoint ?? 0) +
    input('timelineTrimOut', 'timeline.trimOut', selectedBlock?.edit.outPoint ?? 0) +
    `<button class="button" id="timelineApplyTrim" type="button" ${selectedBlock ? '' : 'disabled'}>${esc(tx('timeline.apply'))}</button>` +
    `<span class="field-hint">${timelineSelection.size} ${esc(tx('timeline.selected'))} · ${lanes.reduce((n, l) => n + l.blocks.length, 0)} ${esc(tx('timeline.clips'))}</span></div>` +
    `<div class="lane-row timeline-ruler-row"><span class="lane-name" id="timelineTime"></span><div class="lane timeline-ruler" id="timelineRuler"><span>0:00</span><span>${clock(total / 2)}</span><span>${clock(total)}</span><span class="timeline-playhead timeline-playhead-handle" data-playhead></span></div></div>` +
    markup + `<div class="lane-scale"><span>0:00</span><span>${clock(total / 2)}</span><span>${clock(total)}</span></div></div>`;
}

// "♫ Thêm bài hát" in the sidebar; render() shows its name and player.
$('#audioUpload').onchange = e => upload(e.target.files[0], 'audio', 'audio');

// Keyboard over the timeline: Space = play/pause the preview, +/- = zoom the strip. Skipped while
// typing; Space is also skipped when a focusable element (node card/button) has focus. The zoom
// keys only act when the timeline strip is actually on screen, so they don't fire from the canvas.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t && t.closest && t.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (!document.querySelector('#timelineTrack .timeline-strip')) return;
    if (e.key === ' ' || e.code === 'Space') {
      if (t && t.closest && t.closest('button,a,[data-node],[data-graph-id],[tabindex]')) return;
      e.preventDefault();
      toggleTimeline();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setTimelineZoom(timelineZoom * 1.5);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setTimelineZoom(timelineZoom / 1.5);
    }
  });
}

let currentView = 'studio';
export function render() {
  if (typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function')
    document.dispatchEvent(new CustomEvent('appstatechange', {
      detail: { projectId: store.state?.activeProjectId || null },
    }));
  const online = store.state.worker?.online;
  const busy = workflowBusy();
  $('#graphArea').classList.toggle('busy', false);
  $('#graphLock').hidden = !busy;
  $('#canvasProjectName').textContent = store.state.name;
  // A project is one file polled whole, so a very full one gets heavy to work in. Say how
  // full it is once it passes the warning mark — there is still room, but it is worth knowing
  // before planning another fifty shots.
  const budget = store.state.nodeBudget;
  const budgetNote =
    budget && budget.used >= budget.warn
      ? ` <span class="badge${budget.used >= budget.cap ? ' warn' : ''}">${budget.used}/${budget.cap} node</span>`
      : '';
  $('#canvasState').innerHTML =
    (workflowProcessing()
      ? `<i class="canvas-state-dot busy-dot"></i> ${esc(tx('canvas.processing'))}`
      : `<i class="canvas-state-dot"></i> ${esc(tx('canvas.ready'))}`) + budgetNote;
  // New nodes can join the graph while an existing auto run follows its frozen target list.
  for (const id of [
    'addNode',
    'addCharacter',
    'addProp',
    'addScene',
    'addStage',
    'addWardrobe',
    'addStyle',
    'addCamera',
    'addAudio',
    'addMusic',
  ])
    if ($('#' + id)) $('#' + id).disabled = false;
  if ($('#arrangeZones')) $('#arrangeZones').disabled = busy;
  $('#projectName').textContent = store.state.name;
  renderProjects();
  $('#workerBadge').textContent = online ? `● ${tx('canvas.workerConnected')}` : `○ ${tx('canvas.workerDisconnected')}`;
  $('#workerBadge').className = 'badge' + (online ? ' online' : '');
  $('#jobCount').textContent = store.state.jobs.filter(
    j => ['queued', 'running'].includes(j.status) && !j.cancelRequested,
  ).length;
  renderGraph();
  paint('#timelineTrack', timelineStrip());
  setTimelineCursor(timelineCursor);
  const playBtn = $('#timelinePlayPause');
  if (playBtn) playBtn.onclick = () => toggleTimeline();
  const syncBtn = $('#timelineSyncAudio');
  if (syncBtn) syncBtn.onclick = () => syncTimelineAudio();
  const syncOffset = $('#timelineSyncOffset');
  if (syncOffset)
    syncOffset.onchange = () => {
      timelineSyncOffset = (Number(syncOffset.value) || 0) / 1000;
      try {
        localStorage.setItem('mv-timeline-sync-offset', String(timelineSyncOffset));
      } catch {}
      if (timelinePlaying) syncTimelineAudio(); // apply the new offset right away
    };
  const zoomIn = $('#timelineZoomIn');
  const zoomOut = $('#timelineZoomOut');
  if (zoomIn) zoomIn.onclick = () => setTimelineZoom(timelineZoom * 1.5);
  if (zoomOut) zoomOut.onclick = () => setTimelineZoom(timelineZoom / 1.5);
  applyTimelineZoom();
  // Per-lane audio mute/solo (bound once; the lane buttons live inside #timelineTrack).
  const track = $('#timelineTrack');
  if (track?.addEventListener && !track.__audioBound) {
    track.__audioBound = true;
    track.addEventListener('click', e => {
      const mute = e.target.closest?.('[data-lane-mute]');
      const solo = e.target.closest?.('[data-lane-solo]');
      if (!mute && !solo) return;
      e.stopPropagation();
      e.preventDefault();
      if (mute) {
        const id = mute.dataset.laneMute;
        const audible = laneAudible(id);
        timelineAudio.solo = null;
        timelineAudio.mute[id] = audible; // audible → mute it; muted → unmute it
      } else {
        const id = solo.dataset.laneSolo;
        timelineAudio.solo = timelineAudio.solo === id ? null : id;
      }
      render();
      applyTimelineAudio();
    });
  }
  const stopPreview = $('#timelineStop');
  if (stopPreview && !stopPreview.__bound) {
    stopPreview.__bound = true;
    stopPreview.onclick = stopTimelinePreview;
  }
  setupWaveforms();
  const split = $('#timelineSplit');
  if (split && !split.__bound) { split.__bound = true; split.onclick = splitTimelineAtCursor; }
  const remove = $('#timelineRemove');
  if (remove && !remove.__bound) { remove.__bound = true; remove.onclick = removeTimelineSegment; }
  const ruler = $('#timelineRuler');
  if (ruler?.addEventListener && !ruler.__bound) {
    ruler.__bound = true;
    const seek = e => {
      const rect = ruler.getBoundingClientRect();
      setTimelineCursor(((e.clientX - rect.left) / rect.width) * Number($('#timelineTrack .timeline-strip')?.dataset.total || 1));
    };
    ruler.addEventListener('pointerdown', e => {
      e.preventDefault();
      ruler.setPointerCapture(e.pointerId);
      seek(e);
    });
    ruler.addEventListener('pointermove', e => {
      if (ruler.hasPointerCapture(e.pointerId)) seek(e);
    });
    ruler.addEventListener('pointerup', e => {
      if (!ruler.hasPointerCapture(e.pointerId)) return;
      seek(e);
      ruler.releasePointerCapture(e.pointerId);
      scrubTimeline();
    });
  }
  document.querySelectorAll('#timelineTrack .lane:not(.timeline-ruler)').forEach(lane => {
    lane.onclick = e => {
      if (e.target !== lane && !e.target.matches('[data-playhead]')) return;
      const rect = lane.getBoundingClientRect();
      setTimelineCursor(((e.clientX - rect.left) / rect.width) * Number($('#timelineTrack .timeline-strip')?.dataset.total || 1));
      scrubTimeline();
    };
    if (lane.classList.contains('a') || lane.classList.contains('b')) {
      lane.ondragover = e => e.preventDefault();
      lane.ondrop = async e => {
        e.preventDefault();
        const entry = timelineClips().find(b => b.key === e.dataTransfer.getData('text/plain'));
        const rect = lane.getBoundingClientRect();
        if (!entry || !rect.width) return;
        const total = Number($('#timelineTrack .timeline-strip')?.dataset.total) || 1;
        const position = Math.max(0, Math.round((((e.clientX - rect.left) / rect.width) * total) * 100) / 100);
        try { await saveTimelineSegment(entry, { position }); }
        catch (err) { toast(err.message, true); }
      };
    }
  });
  document.querySelectorAll('#timelineTrack .video-blk').forEach(block => {
    if (block.__dragBound) return;
    block.__dragBound = true;
    const thumb = block.querySelector('.timeline-thumb');
    thumb?.addEventListener('loadedmetadata', () => {
      const clip = timelineClips().find(b => b.key === block.dataset.segment)?.clip;
      if (!clip || !Number.isFinite(thumb.duration) || thumb.duration <= 0 || clipDurations.get(clip.id) === thumb.duration) return;
      clipDurations.set(clip.id, thumb.duration);
      if (!clip.timelineSegments?.length && clip.trimOut == null && timelineSelection.has(block.dataset.segment))
        $('#timelineTrimOut').value = thumb.duration.toFixed(2);
    });
    block.addEventListener('click', e => {
      if (e.target.closest('[data-trim]')) return;
      if (e.target.closest('video')) {
        timelineSelection.clear();
        timelineSelection.add(block.dataset.segment);
        render();
        playTimelinePreview(block.dataset.segment);
        return;
      }
      const id = block.dataset.segment;
      if (timelineSelection.has(id)) timelineSelection.delete(id);
      else timelineSelection.add(id);
      render();
    });
    block.addEventListener('dragstart', e => {
      if (e.target.closest('[data-trim]')) return e.preventDefault();
      e.dataTransfer.setData('text/plain', block.dataset.segment);
      e.dataTransfer.effectAllowed = 'move';
    });
    block.querySelectorAll('[data-trim]').forEach(handle => {
      handle.addEventListener('pointerdown', e => {
        e.stopPropagation();
        e.preventDefault();
        const entry = timelineClips().find(b => b.key === block.dataset.segment);
        const lane = block.closest('.lane');
        if (!entry || !lane) return;
        const total = Number($('#timelineTrack .timeline-strip')?.dataset.total) || 1;
        const width = lane.getBoundingClientRect().width;
        if (!width) return;
        const initial = { ...entry.edit };
        let edit = { ...initial };
        const draw = () => {
          block.style.left = `${(edit.position / total) * 100}%`;
          block.style.width = `${Math.max(0.4, ((edit.outPoint - edit.inPoint) / total) * 100)}%`;
          if (timelineSelection.has(entry.key)) {
            $('#timelineTrimStart').value = edit.position.toFixed(2);
            $('#timelineTrimIn').value = edit.inPoint.toFixed(2);
            $('#timelineTrimOut').value = edit.outPoint.toFixed(2);
          }
        };
        const restore = () => { edit = { ...initial }; draw(); };
        handle.setPointerCapture(e.pointerId);
        handle.onpointermove = move => {
          const delta = ((move.clientX - e.clientX) / width) * total;
          if (handle.dataset.trim === 'in') {
            edit.inPoint = Math.max(0, Math.min(initial.outPoint - 0.1, initial.inPoint + delta));
            edit.position = Math.max(0, initial.position + edit.inPoint - initial.inPoint);
          } else {
            const limit = clipDurations.get(entry.clip.id) || 86400;
            edit.outPoint = Math.max(initial.inPoint + 0.1, Math.min(limit, initial.outPoint + delta));
          }
          draw();
        };
        handle.onpointerup = async up => {
          up.stopPropagation();
          handle.releasePointerCapture(up.pointerId);
          handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
          try {
            await saveTimelineSegment(entry, edit);
          } catch (err) { restore(); toast(err.message, true); }
        };
        handle.onpointercancel = () => {
          handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
          restore();
        };
      });
    });
  });
  const clearSelection = $('#timelineClearSelection');
  if (clearSelection && !clearSelection.__bound) {
    clearSelection.__bound = true;
    clearSelection.onclick = () => {
      timelineSelection.clear();
      render();
    };
  }
  const applyTrim = $('#timelineApplyTrim');
  if (applyTrim && !applyTrim.__bound) {
    applyTrim.__bound = true;
    applyTrim.onclick = async () => {
      const entry = timelineClips().find(b => b.key === [...timelineSelection][0]);
      const position = Number($('#timelineTrimStart')?.value);
      const trimIn = Number($('#timelineTrimIn')?.value);
      const trimOut = Number($('#timelineTrimOut')?.value);
      if (!entry || ![position, trimIn, trimOut].every(Number.isFinite) || position < 0 || trimIn < 0 || trimOut - trimIn < 0.1 || trimOut > (clipDurations.get(entry.clip.id) || 86400)) {
        toast(tx('timeline.invalidTrim'), true);
        return;
      }
      try {
        await saveTimelineSegment(entry, { position, inPoint: trimIn, outPoint: trimOut });
      } catch (err) {
        const { toast } = await import('./core.js');
        toast(err.message, true);
      }
    };
  }
  $('#songName').textContent = store.state.audio?.name || tx('render.addSong');
  if (store.state.audio) {
    $('#songPlayer').hidden = false;
    if (!$('#songPlayer').src.endsWith(store.state.audio.url))
      $('#songPlayer').src = store.state.audio.url;
  }
  $('#connectionStatus').textContent = online
    ? tx('render.workerConnected').replace('{name}', store.state.worker.name)
    : tx('render.orbitDirectReady');
  if (orbitStatus) showOrbit(orbitStatus);
  paintDefaults();
  renderJobs();
  renderGallery();
  document.querySelectorAll('[data-open-node]').forEach(e => {
    e.onclick = ev => {
      ev.stopPropagation();
      inspect(e.dataset.openNode);
    };
  });
  document.querySelectorAll('[data-node]').forEach(e => {
    if (e.closest('#timelineTrack')) return;
    // A single click pins the canvas spotlight on the node (dim the rest, light runs along its
    // wires) WITHOUT opening the editor; a double click (or Enter) opens the Inspector. The short
    // delay lets a double click cancel the pending single-click focus.
    e.onclick = () => {
      if (suppressNodeClick) return;
      clearTimeout(e.__focusTimer);
      const id = e.dataset.node;
      e.__focusTimer = setTimeout(
        () => document.dispatchEvent(new CustomEvent('nodefocus', { detail: id })),
        220,
      );
    };
    e.ondblclick = () => {
      clearTimeout(e.__focusTimer);
      inspect(e.dataset.node);
    };
    e.onkeydown = k => {
      if (k.key === 'Enter') inspect(e.dataset.node);
    };
  });
  // nodes on a pinned stage whose framing has no 3D capture yet get one, on their own
  keepCaptures(render);
}

// Dynamic panels (especially the timeline lanes and toolbar) are rebuilt from locale keys.
// Repaint them when the language selector changes, while preserving current graph state.
if (typeof document.addEventListener === 'function')
  document.addEventListener('localechange', () => {
    if (store.state) render();
  });
export function view(id) {
  currentView = id;
  document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== id));
  document
    .querySelectorAll('[data-view]')
    .forEach(b => b.classList.toggle('active', b.dataset.view === id));
  // Reload each time: the master prompt is per-project, so it must refresh after a switch.
  if (id === 'director') loadDirector();
}
document.querySelectorAll('[data-view]').forEach(b => (b.onclick = () => view(b.dataset.view)));
document.querySelectorAll('[data-workspace]').forEach(b => {
  b.onclick = () => {
    const target = b.dataset.workspace;
    document.querySelectorAll('[data-workspace]').forEach(x =>
      x.classList.toggle('active', x === b),
    );
    if (target === 'queue') return view('queue');
    if (target === 'deliverables') return view('gallery');
    view('studio');
    const el = target === 'timeline' ? $('#timelineTrack') : $('#graphArea');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
});
export async function refresh() {
  store.state = await api('/api/state');
  render();
}
// The background poll: it asks a cheap /api/revision first and only pulls the full ~1.8 MB state +
// re-renders when the graph actually changed (another window edited it) OR a job is live (progress
// to show). An idle window on a steady project does nothing. Paused while the tab is hidden.
let lastDoneSeen = null;
export async function pollState() {
  if (typeof document !== 'undefined' && document.hidden) return;
  try {
    const r = await api('/api/revision');
    // A finished job does not bump the revision, and the tick after it finished sees nothing
    // active — so without lastDone the poll cannot tell "a picture just landed" from "nothing is
    // happening", and an idle canvas keeps the old image until a reload. First answer only
    // records the mark; the window already has whatever finished before it opened.
    const landed = lastDoneSeen !== null && r.lastDone !== lastDoneSeen;
    lastDoneSeen = r.lastDone ?? '';
    // store.state.revision is kept current by refresh() and by every action that returns full
    // state, so comparing against it never triggers a redundant fetch after a local edit.
    if (r.revision !== store.state?.revision || r.active > 0 || landed) await refresh();
  } catch {}
}

// The push channel (/api/events): the server sends a line the moment the graph changes or a worker
// hands in an image/video, and this reloads right then, instead of up to one poll interval later.
// A job result does not bump the revision, so the poll alone cannot see it — this is how a finished
// image/video reaches an idle window. The poll stays on as a safety net if an event is missed.
let pushTimer = null;
let missedWhileHidden = false;
// Coalesce a burst (a batch mutating many nodes) into one reload.
function reloadSoon() {
  if (typeof document !== 'undefined' && document.hidden) {
    missedWhileHidden = true; // reloading a hidden window is wasted work; catch up when it shows
    return;
  }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => refresh().catch(() => {}), 150);
}
export function listenForChanges() {
  if (typeof EventSource === 'undefined') return null; // the poll alone still keeps the UI current
  const source = new EventSource('/api/events');
  source.addEventListener('change', reloadSoon);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && missedWhileHidden) {
      missedWhileHidden = false;
      reloadSoon();
    }
  });
  return source;
}
