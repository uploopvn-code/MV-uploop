// The node canvas: pan/zoom, wires, drag to move and connect, arrange/fit.
// test-canvas.mjs runs this file with stubs for its imports: a new import needs a stub there.
import { store } from './store.js';
import { card, hasVideoPort, showClip, shownClip, videosOf } from './cards.js';
import { $, api, esc, paint, toast, workflowBusy } from './core.js';
import { render } from './render.js';
import { CLIP_ZONES, ZONES, ZONE_W, zoneLayout } from './zones.js';

// Bumped when a column is added: pixel positions saved before that point are a column off.
const LAYOUT_KEY = 'mv-canvas-v2';
let canvasPrefs;
try {
  canvasPrefs = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
  // Saved under the old key: the "Phân cảnh ghép" column shifted every later column one
  // step right, so those pixel positions no longer match their zone. Keep the view and let
  // the nodes fall back to the zone layout instead of sitting a column off.
  if (!canvasPrefs) {
    const old = JSON.parse(localStorage.getItem('mv-canvas-v1') || 'null');
    if (old) canvasPrefs = { view: old.view };
  }
} catch {}
const graphView = { x: 25, y: 25, z: 1, ...canvasPrefs?.view };
const savedPositions = canvasPrefs?.positions || {};
export let gesture = null,
  suppressNodeClick = false;
let connectSource = null;
let selectedEdge = null;

// One node's card and its ports, as markup. Kept separate so a refresh that changed only
// a few nodes can rewrite just those (see renderGraph): rebuilding the whole canvas
// reloads every preview image and makes dragging stutter while jobs run.
function nodeMarkup(n, p) {
  const focused = store.selected;
  const related = focused &&
    store.state.edges.some(e =>
      (e.source === focused && e.target === n.id) ||
      (e.target === focused && e.source === n.id),
    );
  const focusClass = focused
    ? n.id === focused
      ? ' selected'
      : related
        ? ' related'
        : ' dimmed'
    : '';
  const open =
    '<div class="graph-node' +
    focusClass +
    '" data-graph-id="' +
    n.id +
    '" style="left:' +
    p.x +
    'px;top:' +
    p.y +
    'px">';
  // A music node is a standalone data node: it holds a song + its analysis, wires to nothing.
  if (n.kind === 'music') return open + card(n) + '<div class="ports"></div></div>';
  return (
    open +
    card(n) +
    '<div class="ports">' +
    // Image / shot nodes show two inputs: reference images, and style / camera text.
    // Both accept a wire; the server tells them apart by the source node's kind.
    (n.terminal
      ? '<button class="port video-in" data-port-in="' +
        n.id +
        '" data-label="🎬 video" title="Video do shot nguồn tạo ra">●</button>'
      : n.kind === 'setting'
        ? '<button class="port" data-port-in="' +
          n.id +
          '" data-label="IN (' +
          store.state.edges.filter(e => e.target === n.id).length +
          ')">●</button>'
        : '<button class="port" data-port-in="' +
          n.id +
          '" data-port-kind="image" data-label="🖼 ' +
          (n.imageInputs ?? 0) +
          ' ảnh" title="Ảnh tham chiếu nối vào: ' +
          (n.imageInputs ?? 0) +
          '">●</button><button class="port" data-port-in="' +
          n.id +
          '" data-port-kind="setting" data-label="🎨🎥 ' +
          (n.settingInputs ?? 0) +
          '" title="Style / Máy quay nối vào: ' +
          (n.settingInputs ?? 0) +
          '">●</button>') +
    // A clip node feeds nothing (it holds a video, not an image), so it has no output.
    (n.terminal
      ? ''
      : '<button class="port ' +
        (connectSource === n.id ? 'selected' : '') +
        '" data-port-out="' +
        n.id +
        (n.kind === 'setting'
          ? '" data-label="OUT" title="Nội dung node này — kéo sang IN 🎨🎥 của node khác">●</button>'
          : '" data-label="OUT ảnh" title="Ảnh của node này — kéo sang IN của node khác">●</button>')) +
    // The video output is not wired by hand: each produced clip becomes its own node.
    (!hasVideoPort(n)
      ? ''
      : '<button class="port video-out" ' +
        (videosOf(n).length
          ? 'data-open-node="' + videosOf(n).at(-1).id + '" title="Mở video mới nhất"'
          : n.video
            ? 'data-open-node="' + n.id + '" title="Video gắn trên node này"'
            : 'disabled title="Chưa có video"') +
        ' data-label="🎬 ' +
        (videosOf(n).length + (n.video ? 1 : 0)) +
        '">●</button>') +
    '</div></div>'
  );
}
// Markup of the nodes drawn last time, by id: a refresh only rewrites what differs.
let drawn = new Map();
export function renderGraph() {
  if (gesture) return;
  const positions = {};
  const defaults = zoneLayout();
  for (const n of store.state.nodes) positions[n.id] = savedPositions[n.id] || defaults[n.id];
  // The clips of one source are one card: only the version being looked at is drawn (and
  // wired); ‹ › on that card walks through the others.
  for (const n of store.state.nodes)
    if (n.terminal && n.source && shownClip(n.source)?.id !== n.id) delete positions[n.id];
  const w = Math.max(3 * ZONE_W + 40, ...Object.values(positions).map(p => p.x + 280)),
    h = Math.max(520, ...Object.values(positions).map(p => p.y + 265));
  if (selectedEdge && !store.state.edges.some(e => e.source + '>' + e.target === selectedEdge))
    selectedEdge = null;
  const lines = wiresMarkup(positions);
  const bands = ZONES.map(
    (z, i) =>
      '<div class="zone-band" style="left:' +
      i * ZONE_W +
      'px;width:' +
      ZONE_W +
      'px;height:' +
      h +
      'px"><span class="zone-label">' +
      esc(z.label) +
      '</span></div>',
  ).join('');
  const canvas = $('#graphCanvas');
  if (canvas.style.width !== w + 'px') canvas.style.width = w + 'px';
  if (canvas.style.height !== h + 'px') canvas.style.height = h + 'px';
  const nodes = new Map(
    store.state.nodes.filter(n => positions[n.id]).map(n => [n.id, nodeMarkup(n, positions[n.id])]),
  );
  const shell =
    bands +
    '<svg width="' +
    w +
    '" height="' +
    h +
    '" class="wires">' +
    lines +
    '</svg>' +
    wireDeleteButton(positions);
  // Same nodes as last time: patch only the cards whose markup changed (a job badge, a new
  // image) and leave the rest of the DOM — and its loaded previews — alone.
  let patched =
    canvas.__shell === shell &&
    drawn.size === nodes.size &&
    [...nodes.keys()].every(id => drawn.has(id));
  if (patched)
    for (const [id, html] of nodes) {
      if (drawn.get(id) === html) continue;
      const el = document.querySelector('[data-graph-id="' + id + '"]');
      if (!el) {
        patched = false;
        break;
      }
      el.outerHTML = html;
    }
  if (!patched) {
    canvas.innerHTML = shell + [...nodes.values()].join('');
    canvas.__shell = shell;
  }
  drawn = nodes;
  // Hovering a node temporarily brings its connected wires forward without changing the
  // persisted graph or interrupting drag gestures.
  canvas.onpointerover = e => {
    const node = e.target.closest?.('[data-graph-id]');
    if (!node) return;
    const id = node.dataset.graphId;
    canvas.querySelectorAll?.('.wire.hover-focus').forEach(path => path.classList.remove('hover-focus'));
    canvas.querySelectorAll?.('.wire[data-edge-source="' + id + '"], .wire[data-edge-target="' + id + '"]')
      .forEach(path => path.classList.add('hover-focus'));
  };
  canvas.onpointerout = e => {
    if (e.target.closest?.('[data-graph-id]'))
      canvas.querySelectorAll?.('.wire.hover-focus').forEach(path => path.classList.remove('hover-focus'));
  };
  // ‹ › on a clip card: show another version of the same source, in the same place.
  document.querySelectorAll('[data-stack-prev],[data-stack-next]').forEach(b => {
    b.onclick = ev => {
      ev.stopPropagation();
      const src = b.dataset.stackPrev || b.dataset.stackNext;
      const was = shownClip(src);
      const next = showClip(src, b.dataset.stackPrev ? -1 : 1);
      if (was && next && savedPositions[was.id] && !savedPositions[next.id])
        savedPositions[next.id] = savedPositions[was.id];
      render();
    };
  });
  const previous = $('#autoTarget').value;
  if (
    paint(
      '#autoTarget',
      '<option value="">Toàn bộ workflow</option>' +
        store.state.nodes
          .map(n => '<option value="' + n.id + '">Đến: ' + esc(n.name) + '</option>')
          .join(''),
    )
  )
    $('#autoTarget').value = previous;
  const run = store.state.autoRun;
  $('#autoStatus').textContent = run
    ? ({
        running: 'Đang chạy',
        completed: 'Hoàn tất',
        blocked: 'Đã dừng vì lỗi',
        stopped: 'Đã dừng',
      }[run.status] || run.status) +
      ' · ' +
      run.index +
      '/' +
      run.order.length +
      ' · ' +
      run.message
    : 'Tự động chạy theo đường nối, bỏ qua ảnh đã có và còn hợp lệ. Chỉ chạy node sau khi nhận được file.';
  // "Dừng" is available whenever something of that kind still locks the workflow: an
  // auto-run, or any queued/running job — including one started from a single node's
  // own "Tạo ảnh / Tạo video" button, which has no auto-run to stop.
  const activeJobs = kind =>
    store.state.jobs.some(
      j => j.kind === kind && ['queued', 'running'].includes(j.status) && !j.cancelRequested,
    );
  const ir = store.state.autoImageRun;
  $('#autoStart').disabled = run?.status === 'running';
  $('#autoStop').disabled = !(
    run?.status === 'running' ||
    ir?.status === 'running' ||
    activeJobs('image')
  );
  // Per-zone quick image batch status.
  const zoneLabel = {
    character: 'Nhân vật',
    wardrobe: 'Trang phục & vật dụng',
    design: 'Bối cảnh',
    production: 'Khung hình shot',
  };
  $('#autoImageStatus').textContent = ir
    ? '🖼 ' +
      (zoneLabel[ir.zone] || ir.zone) +
      ': ' +
      ({
        running: 'đang tạo song song',
        completed: 'hoàn tất',
        blocked: 'xong, một số lỗi',
        stopped: 'đã dừng',
      }[ir.status] || ir.status) +
      ' · ' +
      ir.message
    : 'Chọn khu vực rồi tạo ảnh đồng loạt cho mọi node còn thiếu ảnh trong khu đó (song song).';
  const otherBusy = run?.status === 'running' || store.state.autoVideoRun?.status === 'running';
  $('#autoImageStart').disabled = otherBusy || ir?.status === 'running';
  const vr = store.state.autoVideoRun;
  $('#autoVideoStatus').textContent = vr
    ? '🎬 Video: ' +
      ({
        running: 'đang tạo song song',
        completed: 'hoàn tất',
        blocked: 'xong, một số lỗi',
        stopped: 'đã dừng',
      }[vr.status] || vr.status) +
      ' · ' +
      vr.message
    : 'Tự động tạo video cho mọi node đã sẵn ảnh, chạy song song. Mỗi phiên bản thành một node video riêng.';
  $('#autoVideoStart').disabled = run?.status === 'running' || vr?.status === 'running';
  $('#autoVideoStop').disabled = !(vr?.status === 'running' || activeJobs('video'));
  // Offer a one-click retry whenever some video jobs failed.
  const lastVideoJob = new Map();
  for (const j of store.state.jobs) if (j.kind === 'video') lastVideoJob.set(j.nodeId, j);
  const failedVideoList = [...lastVideoJob.values()]
    .filter(j => j.status === 'failed')
    .map(j => j.nodeId);
  const failedVideos = failedVideoList.length;
  const retryBtn = $('#autoVideoRetry');
  if (retryBtn) {
    retryBtn.hidden = failedVideos === 0;
    retryBtn.textContent = '↻ Chạy lại ' + failedVideos + ' video lỗi';
    retryBtn.disabled = workflowBusy();
  }
  // "Create missing videos": the server's own list of shots without a clip (to film, or to
  // check again when Seedvis may already have rendered them), so the count matches the run.
  const missing = (store.state.missingVideo || []).length;
  const shots = store.state.nodes.filter(
    n =>
      !n.terminal &&
      n.kind !== 'setting' &&
      n.role !== 'frame' &&
      ['production', 'merged'].includes(n.zone),
  );
  // filmed: its own clip, or a clip of a Seedance group it is wired into
  const groupFilmed = n =>
    store.state.edges.some(e => {
      const g = e.source === n.id && store.state.nodes.find(x => x.id === e.target);
      return g?.role === 'seedance' && videosOf(g).length > 0;
    });
  const filmed = shots.filter(n => videosOf(n).length || groupFilmed(n)).length;
  const missBtn = $('#autoVideoMissing');
  if (missBtn) {
    // shots that have a clip but also a job Seedvis may have finished (another version)
    const recheckOnly = store.state.recheckVideo || 0;
    missBtn.hidden = missing + recheckOnly === 0;
    missBtn.textContent =
      (missing ? `✚ Tạo ${missing} video còn thiếu` : '✚ Kiểm tra tác vụ chờ') +
      (recheckOnly ? ` · kiểm tra lại ${recheckOnly}` : '') +
      ` · đã có ${filmed}/${shots.length}`;
    missBtn.title =
      'Shot chưa có video: chưa quay, lỗi hoặc đã dừng thì tạo mới. Tác vụ Seedvis có thể đã ' +
      'làm xong (quá giờ, app khởi động lại, bị dừng khi đang tạo) thì kiểm tra lại trước, kể ' +
      'cả ở shot đã có video — xong rồi thì nhận video về, không tạo trùng.';
    missBtn.disabled = workflowBusy();
  }
  applyGraphView();
  document.querySelectorAll('.graph-node').forEach(el => {
    const id = el.dataset.graphId;
    savedPositions[id] = positions[id];
  });
  document.querySelectorAll('[data-port-out]').forEach(
    e =>
      (e.onclick = () => {
        if (suppressNodeClick) return;
        connectSource = e.dataset.portOut;
        $('#connectHint').textContent =
          'Đã chọn nguồn. Bấm Vào trên node đích để nối; bấm Ra nguồn khác để đổi.';
        render();
      }),
  );
  document.querySelectorAll('[data-port-in]').forEach(
    e =>
      (e.onclick = async () => {
        if (suppressNodeClick) return;
        if (!connectSource) return toast('Chọn cổng Ra của node nguồn trước', true);
        try {
          store.state = await api('/api/edges', {
            method: 'PUT',
            body: {
              edges: [...store.state.edges, { source: connectSource, target: e.dataset.portIn }],
            },
          });
          connectSource = null;
          render();
          toast('Đã nối node');
        } catch (err) {
          toast(err.message, true);
        }
      }),
  );
  document
    .querySelectorAll('[data-delete-edge]')
    .forEach(e => (e.onclick = () => deleteEdge(e.dataset.deleteEdge)));
}
async function deleteEdge(key) {
  if (workflowBusy()) return toast('Đợi hàng đợi chạy xong trước khi sửa dây nối.', true);
  try {
    store.state = await api('/api/edges', {
      method: 'PUT',
      body: { edges: store.state.edges.filter(e => e.source + '>' + e.target !== key) },
    });
    selectedEdge = null;
    render();
    toast('Đã xóa dây nối');
  } catch (err) {
    toast(err.message, true);
  }
}
document.addEventListener('keydown', e => {
  if (!selectedEdge || !['Delete', 'Backspace'].includes(e.key)) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || !$('#inspector').hidden)
    return;
  e.preventDefault();
  deleteEdge(selectedEdge);
});
const TOOLS_PREF_KEY = 'mv-canvas-tools-open';
const graphArea = $('#graphArea');
const graphSide = $('#graphSide');
const toolsToggle = $('#toolsToggle');
const toolsClose = $('#toolsClose');
function setToolsOpen(open, persist = true) {
  if (!graphArea?.classList || !graphSide || !toolsToggle?.setAttribute) return;
  graphArea.classList.toggle('tools-open', open);
  toolsToggle.setAttribute('aria-expanded', String(open));
  toolsToggle.classList?.toggle?.('active', open);
  if (persist) {
    try {
      localStorage.setItem(TOOLS_PREF_KEY, open ? '1' : '0');
    } catch {}
  }
}

const FULL_PREF_KEY = 'mv-canvas-full';
function setFullscreen(full, persist = true) {
  $('#graphArea').classList.toggle('full', full);
  $('#fullscreenToggle').textContent = full ? '⤢ Thu nhỏ' : '⛶ Toàn màn hình';
  $('#fullscreenToggle').setAttribute('aria-expanded', String(full));
  if (full) setToolsOpen(false);
  if (persist) try { localStorage.setItem(FULL_PREF_KEY, full ? '1' : '0'); } catch {}
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (store.state?.nodes?.length) $('#fitCanvas')?.click();
  }));
}
let startFull = true;
try { const v = localStorage.getItem(FULL_PREF_KEY); if (v !== null) startFull = v === '1'; } catch {}
setFullscreen(startFull, false);
$('#fullscreenToggle').onclick = () => {
  setFullscreen(!$('#graphArea').classList.contains('full'));
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#graphArea').classList.contains('full')) {
    setFullscreen(false);
  }
});

let toolsOpen = false;
try {
  toolsOpen = localStorage.getItem(TOOLS_PREF_KEY) === '1';
} catch {}
setToolsOpen(toolsOpen, false);
toolsToggle?.addEventListener?.('click', () => setToolsOpen(!graphArea.classList.contains('tools-open')));
toolsClose?.addEventListener?.('click', () => setToolsOpen(false));
document.addEventListener(
  'click',
  e => {
    if (!graphArea.classList.contains('tools-open')) return;
    if (e.target.closest?.('[data-graph-id]')) setToolsOpen(false);
  },
  true,
);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !$('#inspector').hidden) return;
  if (graphArea.classList.contains('tools-open')) {
    setToolsOpen(false);
    return;
  }
  if (store.selected) {
    store.selected = null;
    render();
  }
});

function persistCanvas() {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ view: graphView, positions: savedPositions }),
    );
  } catch {
    toast('Trình duyệt không lưu được bố cục', true);
  }
}
function applyGraphView() {
  const c = $('#graphCanvas');
  c.style.transform =
    'translate(' + graphView.x + 'px,' + graphView.y + 'px) scale(' + graphView.z + ')';
  $('#zoomValue').textContent = Math.round(graphView.z * 100) + '%';
}
function worldPoint(x, y) {
  const r = $('.graph-scroll').getBoundingClientRect();
  return {
    x: (x - r.left - graphView.x) / graphView.z,
    y: (y - r.top - graphView.y) / graphView.z,
  };
}
function edgePath(a, b) {
  const bend = Math.max(65, Math.abs(b.x - a.x) * 0.5);
  return (
    'M ' +
    a.x +
    ' ' +
    a.y +
    ' C ' +
    (a.x + bend) +
    ' ' +
    a.y +
    ', ' +
    (b.x - bend) +
    ' ' +
    b.y +
    ', ' +
    b.x +
    ' ' +
    b.y
  );
}
function wireEnds(e, pos) {
  const a = pos[e.source],
    b = pos[e.target];
  const src = store.state.nodes.find(n => n.id === e.source),
    dst = store.state.nodes.find(n => n.id === e.target);
  // A style / camera wire lands on the lower "🎨🎥" input of an image / shot node.
  const lower = src?.kind === 'setting' && dst && dst.kind !== 'setting' && !dst.terminal;
  // A produced clip leaves from the lower "🎬" output, the image wires from the upper one.
  const fromVideo = !!dst?.terminal && dst.source === e.source && hasVideoPort(src);
  return [
    { x: a.x + 235, y: a.y + (fromVideo ? 150 : 110) },
    { x: b.x, y: b.y + (lower ? 150 : 110) },
  ];
}
// Each wire has a wide transparent twin so it is easy to click.
function wiresMarkup(pos) {
  return store.state.edges
    .filter(e => pos[e.source] && pos[e.target])
    .map(e => {
      const key = e.source + '>' + e.target,
        d = edgePath(...wireEnds(e, pos));
      const focusEdge = store.selected && (e.source === store.selected || e.target === store.selected);
      return (
        '<path class="wire-hit" data-edge="' +
        key +
        '" data-edge-source="' +
        esc(e.source) +
        '" data-edge-target="' +
        esc(e.target) +
        '" d="' +
        d +
        '"><title>Bấm để chọn dây, rồi bấm × hoặc Delete để xóa</title></path><path class="wire' +
        (selectedEdge === key ? ' selected' : '') +
        (focusEdge ? ' focus' : '') +
        '" data-edge-source="' +
        esc(e.source) +
        '" data-edge-target="' +
        esc(e.target) +
        '" d="' +
        d +
        '"/>'
      );
    })
    .join('');
}
function wireDeleteButton(pos) {
  const e = store.state.edges.find(e => e.source + '>' + e.target === selectedEdge);
  if (!e) return '';
  const [a, b] = wireEnds(e, pos),
    bend = Math.max(65, Math.abs(b.x - a.x) * 0.5);
  // Midpoint of the cubic Bézier drawn by edgePath.
  const x = (a.x + 3 * (a.x + bend) + 3 * (b.x - bend) + b.x) / 8,
    y = (a.y + b.y) / 2;
  return (
    '<button class="wire-delete" data-delete-edge="' +
    selectedEdge +
    '" style="left:' +
    x +
    'px;top:' +
    y +
    'px" title="Xóa dây nối" aria-label="Xóa dây nối">×</button>'
  );
}
// Dragging fires many pointermove events per frame; redrawing every wire on each one is
// what makes a big graph stutter. Coalesce them into one repaint per animation frame.
let wireFrame = null;
function repaintWiresSoon(pointer) {
  if (wireFrame) return;
  wireFrame = requestAnimationFrame(() => {
    wireFrame = null;
    repaintWires(pointer);
  });
}
function repaintWires(pointer) {
  const svg = $('#graphCanvas .wires');
  if (!svg) return;
  document.querySelectorAll('.wire-delete').forEach(el => el.remove());
  svg.innerHTML = wiresMarkup(savedPositions);
  if (gesture?.type === 'wire' && pointer) {
    const p = savedPositions[gesture.id];
    const a = gesture.direction === 'out' ? { x: p.x + 235, y: p.y + 110 } : pointer,
      b = gesture.direction === 'out' ? pointer : { x: p.x, y: p.y + 110 };
    svg.innerHTML += '<path class="draft-wire" d="' + edgePath(a, b) + '"/>';
  }
}
function zoomAt(factor, x, y) {
  const r = $('.graph-scroll').getBoundingClientRect(),
    before = worldPoint(x, y);
  graphView.z = Math.max(0.25, Math.min(2.5, graphView.z * factor));
  graphView.x = x - r.left - before.x * graphView.z;
  graphView.y = y - r.top - before.y * graphView.z;
  applyGraphView();
  persistCanvas();
}
function centerZoom(factor) {
  const r = $('.graph-scroll').getBoundingClientRect();
  zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
}
$('#zoomIn').onclick = () => centerZoom(1.2);
$('#zoomOut').onclick = () => centerZoom(1 / 1.2);
$('#arrangeZones').onclick = async () => {
  // Renumber first: the shot column is the timeline, so arranging restores that order even
  // after a shot was dragged into another zone and back.
  try {
    store.state = await api('/api/nodes/arrange', { method: 'POST', body: {} });
    render();
  } catch (e) {
    toast(e.message, true);
  }
  const layout = zoneLayout();
  for (const id of Object.keys(savedPositions)) delete savedPositions[id];
  Object.assign(savedPositions, layout);
  persistCanvas();
  render();
  $('#fitCanvas').onclick();
  toast('Đã xếp node theo khu vực; shot đánh số lại theo mốc thời gian');
};
$('#fitCanvas').onclick = () => {
  const visibleNodes = store.state.nodes.filter(
    n => !n.terminal || shownClip(n.source)?.id === n.id,
  );
  const defaults = zoneLayout();
  const ps = visibleNodes.map(n => savedPositions[n.id] || defaults[n.id]).filter(Boolean);
  if (!ps.length) return;
  const minX = Math.min(...ps.map(p => p.x)),
    minY = Math.min(...ps.map(p => p.y)),
    maxX = Math.max(...ps.map(p => p.x + 235)),
    maxY = Math.max(...ps.map(p => p.y + 245)),
    r = $('.graph-scroll').getBoundingClientRect();
  graphView.z = Math.max(
    0.25,
    Math.min(1.5, (r.width - 100) / (maxX - minX), (r.height - 100) / (maxY - minY)),
  );
  graphView.x = (r.width - (maxX - minX) * graphView.z) / 2 - minX * graphView.z;
  graphView.y = (r.height - (maxY - minY) * graphView.z) / 2 - minY * graphView.z;
  applyGraphView();
  persistCanvas();
};
const viewport = $('.graph-scroll');
viewport.addEventListener(
  'wheel',
  e => {
    if (gesture) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  },
  { passive: false },
);
viewport.addEventListener('dragstart', e => e.preventDefault());
viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  const port = e.target.closest('[data-port-in],[data-port-out]'),
    node = e.target.closest('.graph-node');
  if (!port && e.target.closest('.wire-delete')) return;
  // The 🎬 marker is a plain button (open the newest clip), never a drag handle.
  if (!port && e.target.closest('[data-open-node]')) return;
  const wire = !port && !node ? e.target.closest('[data-edge]') : null;
  if (workflowBusy()) {
    // Read-only while running: allow pan/zoom and node click (to view), block wiring + drag.
    // Any press on a node is a click to view it; only the empty canvas pans.
    if (port || node) return;
    gesture = {
      type: 'pan',
      start: { x: graphView.x, y: graphView.y },
      wire: wire?.dataset.edge || null,
    };
  } else if (port) {
    gesture = {
      type: 'wire',
      id: port.dataset.portOut || port.dataset.portIn,
      direction: port.dataset.portOut ? 'out' : 'in',
    };
  } else if (node && e.target.closest('.node-top')) {
    const id = node.dataset.graphId;
    const state = store.state.nodes.find(n => n.id === id);
    gesture = {
      type: 'node',
      id,
      start: { ...savedPositions[id] },
      zone: state?.zone,
      targetZone: state?.zone,
      crossed: false,
    };
  } else if (!node || e.button === 1) {
    gesture = {
      type: 'pan',
      start: { x: graphView.x, y: graphView.y },
      wire: wire?.dataset.edge || null,
    };
  } else return;
  Object.assign(gesture, { pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false });
  viewport.setPointerCapture(e.pointerId);
  e.preventDefault();
});
viewport.addEventListener('pointermove', e => {
  if (!gesture || gesture.pointer !== e.pointerId) return;
  const dx = e.clientX - gesture.x,
    dy = e.clientY - gesture.y;
  if (Math.hypot(dx, dy) > 4) gesture.moved = true;
  if (!gesture.moved) return;
  if (gesture.type === 'node') {
    const node = store.state.nodes.find(n => n.id === gesture.id);
    const rawX = gesture.start.x + dx / graphView.z;
    const rawY = gesture.start.y + dy / graphView.z;
    let x = rawX;
    // Nodes stay in their column by default: a short drag clamps them to the zone edges.
    if (node && !node.terminal && gesture.zone) {
      const zoneIndex = ZONES.findIndex(z => z.id === gesture.zone);
      const rawZoneIndex = Math.floor((rawX + 117) / ZONE_W);
      const worldDx = rawX - gesture.start.x;
      const crossed =
        Math.abs(dx) > 80 && Math.abs(rawZoneIndex - zoneIndex) >= 1;
      gesture.crossed ||= crossed;
      const targetIndex = gesture.crossed
        ? Math.max(0, Math.min(ZONES.length - 1, rawZoneIndex))
        : zoneIndex;
      gesture.targetZone = ZONES[targetIndex]?.id || gesture.zone;
      x = Math.max(targetIndex * ZONE_W + 10, Math.min(rawX, (targetIndex + 1) * ZONE_W - 245));
    } else {
      gesture.targetZone = gesture.zone;
    }
    const p = { x, y: rawY };
    savedPositions[gesture.id] = p;
    const el = document.querySelector('[data-graph-id="' + gesture.id + '"]');
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    repaintWiresSoon();
  } else if (gesture.type === 'pan') {
    graphView.x = gesture.start.x + dx;
    graphView.y = gesture.start.y + dy;
    applyGraphView();
  } else {
    repaintWiresSoon(worldPoint(e.clientX, e.clientY));
    document
      .querySelectorAll('.port.hover-target')
      .forEach(el => el.classList.remove('hover-target'));
    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest(gesture.direction === 'out' ? '[data-port-in]' : '[data-port-out]');
    hit?.classList.add('hover-target');
  }
});
async function endGesture(e, cancel = false) {
  if (!gesture || gesture.pointer !== e.pointerId) return;
  const g = gesture;
  gesture = null;
  // The wires were redrawn outside renderGraph (and a draft wire may be mid-flight): drop
  // what is pending and make the next render rewrite the shell once.
  if (wireFrame) {
    cancelAnimationFrame(wireFrame);
    wireFrame = null;
  }
  document.querySelectorAll('#graphCanvas .draft-wire').forEach(el => el.remove());
  $('#graphCanvas').__shell = null;
  viewport.releasePointerCapture(e.pointerId);
  suppressNodeClick = g.moved;
  setTimeout(() => (suppressNodeClick = false), 150);
  document.querySelectorAll('.hover-target').forEach(el => el.classList.remove('hover-target'));
  if (cancel && g.type === 'node') savedPositions[g.id] = g.start;
  if (cancel && g.type === 'pan') Object.assign(graphView, g.start);
  // A click (no drag) on a wire selects it; a click on empty canvas clears the selection.
  if (!cancel && !g.moved && g.type === 'pan') {
    selectedEdge = g.wire || null;
    if (!g.wire) store.selected = null;
  }
  if (!cancel && g.moved && g.type === 'wire') {
    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest(g.direction === 'out' ? '[data-port-in]' : '[data-port-out]');
    if (hit) {
      const edge =
        g.direction === 'out'
          ? { source: g.id, target: hit.dataset.portIn }
          : { source: hit.dataset.portOut, target: g.id };
      try {
        store.state = await api('/api/edges', {
          method: 'PUT',
          body: { edges: [...store.state.edges, edge] },
        });
        connectSource = null;
        toast('Đã nối node');
      } catch (err) {
        toast(err.message, true);
      }
    }
  }
  // Dropping a node into a different zone band reassigns its zone.
  if (!cancel && g.moved && g.type === 'node') {
    const node = store.state.nodes?.find(n => n.id === g.id);
    const pos = savedPositions[g.id];
    if (node && pos) {
      const zi = Math.max(0, Math.min(ZONES.length - 1, Math.floor((pos.x + 117) / ZONE_W)));
      const newZone = ZONES[zi].id;
      const intendedZone = g.targetZone || newZone;
      const allowZoneMove = g.crossed && intendedZone !== node.zone;
      const movedZone = allowZoneMove && intendedZone === newZone;
      // Produced clip nodes stay in their output column and never change zones.
      if (node.terminal || CLIP_ZONES.includes(newZone)) {
        savedPositions[g.id] = g.start;
      } else if (movedZone) {
        try {
          store.state = await api('/api/node', {
            method: 'PATCH',
            body: { id: g.id, zone: newZone },
          });
          toast('Chuyển sang ' + ZONES[zi].label);
        } catch (err) {
          savedPositions[g.id] = g.start;
          toast(err.message, true);
        }
      }
    }
  }
  persistCanvas();
  render();
}
viewport.addEventListener('pointerup', e => endGesture(e));
viewport.addEventListener('pointercancel', e => endGesture(e, true));
