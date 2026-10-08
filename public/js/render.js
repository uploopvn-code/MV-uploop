// Top-level rendering: draws the current view (and the sidebar song player) and refreshes
// state from the server.
import { store } from './store.js';
import { renderGraph, suppressNodeClick } from './canvas.js';
import { $, api, esc, paint, workflowBusy } from './core.js';
import { loadDirector } from './director.js';
import { renderGallery } from './gallery.js';
import { inspect, upload } from './inspector.js';
import { renderJobs } from './jobs.js';
import { renderProjects } from './projects.js';
import { orbitStatus, paintDefaults, showOrbit } from './providers.js';
import { keepCaptures } from './stage-keeper.js';
import { nodeStream, nodeTime } from './zones.js';

// --- The two-lane time strip under the canvas ---------------------------------------------------
// Lane A = luồng phủ cảnh (⑥ ⑦), lane B = câu hát nhép (⑪). Every block is placed by its own
// seconds over the song's length, so the two lanes read as what they are: two tracks the editor
// cuts between. Blocks that overlap inside one lane drop to a second row and are outlined — the
// user has to SEE an overlap (a take's cut can run into the next one's), not have it hidden.
const clock = s => {
  const v = Math.floor(Math.max(0, s));
  return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
};
// Rows of one lane: the node, its [in, out], and which sub-row it has to sit in to stay readable.
function laneBlocks(stream) {
  const rows = store.state.nodes
    .filter(n => !n.terminal && n.kind !== 'setting' && nodeStream(n) === stream && nodeTime(n))
    .map(n => ({ n, t: nodeTime(n) }))
    .sort((a, b) => a.t[0] - b.t[0]);
  const ends = []; // where each sub-row is free again
  for (const b of rows) {
    // 1 ms of slack: shots are meant to touch, only a real overlap goes to the next row
    b.row = ends.findIndex(e => e <= b.t[0] + 0.001);
    if (b.row < 0) b.row = ends.push(0) - 1;
    ends[b.row] = b.t[1];
  }
  return rows;
}
function timelineStrip() {
  const lanes = [
    { id: 'a', name: 'A · Phủ cảnh', blocks: laneBlocks('A') },
    { id: 'b', name: 'B · Hát nhép', blocks: laneBlocks('B') },
  ];
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
          const title = `${b.n.name} · ${clock(b.t[0])} → ${clock(b.t[1])} · ${(b.t[1] - b.t[0]).toFixed(2)}s${b.row ? ' · ⚠ chồng thời gian với khối khác cùng luồng' : ''}`;
          return (
            `<button class="blk${b.row ? ' over' : ''}" data-node="${b.n.id}" title="${esc(title)}"` +
            ` style="left:${((b.t[0] / total) * 100).toFixed(3)}%;width:${Math.max(0.4, ((b.t[1] - b.t[0]) / total) * 100).toFixed(3)}%;top:${2 + b.row * 24}px">` +
            `${esc(label)}</button>`
          );
        })
        .join('');
      return (
        `<div class="lane-row"><span class="lane-name">${esc(l.name)}<small>${l.blocks.length} khối</small></span>` +
        `<div class="lane ${l.id}" style="height:${rows * 24 + 4}px">${blocks}</div></div>`
      );
    })
    .join('');
  return (
    `<div class="timeline-strip">${markup}` +
    `<div class="lane-scale"><span>0:00</span><span>${clock(total / 2)}</span><span>${clock(total)}</span></div></div>`
  );
}

// "♫ Thêm bài hát" in the sidebar; render() shows its name and player.
$('#audioUpload').onchange = e => upload(e.target.files[0], 'audio', 'audio');

let currentView = 'studio';
export function render() {
  const online = store.state.worker?.online;
  const busy = workflowBusy();
  $('#graphArea').classList.toggle('busy', busy);
  $('#graphLock').hidden = !busy;
  $('#canvasProjectName').textContent = store.state.name;
  $('#canvasState').innerHTML = busy
    ? '<i class="canvas-state-dot busy-dot"></i> Đang xử lý'
    : '<i class="canvas-state-dot"></i> Sẵn sàng';
  // Lock the canvas edit buttons while running; auto start/stop are managed separately.
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
    'arrangeZones',
  ])
    if ($('#' + id)) $('#' + id).disabled = busy;
  $('#projectName').textContent = store.state.name;
  renderProjects();
  $('#workerBadge').textContent = online ? '● Orbit worker đã nối' : '○ Chưa nối Orbit';
  $('#workerBadge').className = 'badge' + (online ? ' online' : '');
  $('#jobCount').textContent = store.state.jobs.filter(
    j => ['queued', 'running'].includes(j.status) && !j.cancelRequested,
  ).length;
  renderGraph();
  paint('#timelineTrack', timelineStrip());
  $('#songName').textContent = store.state.audio?.name || 'Thêm bài hát';
  if (store.state.audio) {
    $('#songPlayer').hidden = false;
    if (!$('#songPlayer').src.endsWith(store.state.audio.url))
      $('#songPlayer').src = store.state.audio.url;
  }
  $('#connectionStatus').textContent = online
    ? `Đã nối: ${store.state.worker.name}`
    : 'Bộ chạy Orbit trực tiếp đã bật. Đăng nhập và chọn kịch bản/nick trong node.';
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
    e.onclick = () => {
      if (!suppressNodeClick) inspect(e.dataset.node);
    };
    e.onkeydown = k => {
      if (k.key === 'Enter') inspect(e.dataset.node);
    };
  });
  // nodes on a pinned stage whose framing has no 3D capture yet get one, on their own
  keepCaptures(render);
}
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
export async function refresh() {
  store.state = await api('/api/state');
  render();
}
