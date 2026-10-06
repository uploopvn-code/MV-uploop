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

// "♫ Thêm bài hát" in the sidebar; render() shows its name and player.
$('#audioUpload').onchange = e => upload(e.target.files[0], 'audio', 'audio');

let currentView = 'studio';
export function render() {
  const online = store.state.worker?.online;
  const busy = workflowBusy();
  $('#graphArea').classList.toggle('busy', busy);
  $('#graphLock').hidden = !busy;
  // Lock the canvas edit buttons while running; auto start/stop are managed separately.
  for (const id of [
    'addNode',
    'addCharacter',
    'addProp',
    'addScene',
    'addWardrobe',
    'addStyle',
    'addCamera',
    'addAudio',
    'arrangeZones',
  ])
    $('#' + id).disabled = busy;
  $('#projectName').textContent = store.state.name;
  renderProjects();
  $('#workerBadge').textContent = online ? '● Orbit worker đã nối' : '○ Chưa nối Orbit';
  $('#workerBadge').className = 'badge' + (online ? ' online' : '');
  $('#jobCount').textContent = store.state.jobs.filter(
    j => ['queued', 'running'].includes(j.status) && !j.cancelRequested,
  ).length;
  renderGraph();
  paint(
    '#timelineTrack',
    store.state.nodes
      .filter(n => 'duration' in n && !n.terminal && n.kind !== 'setting')
      .map(
        n =>
          `<button data-node="${n.id}">${esc(n.name)}<small>${n.start}s · ${n.duration}s</small></button>`,
      )
      .join(''),
  );
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
