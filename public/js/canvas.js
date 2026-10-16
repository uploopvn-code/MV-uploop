// The node canvas: pan/zoom, wires, drag to move and connect, arrange/fit.
// test-canvas.mjs runs this file with stubs for its imports: a new import needs a stub there.
import { store } from './store.js';
import {
  card,
  clipsOf,
  hasVideoPort,
  pickClip,
  shownClip,
  timelineClip,
  videosOf,
} from './cards.js';
import { $, api, esc, paint, toast, workflowBusy } from './core.js';
import { render } from './render.js';
import { CLIP_ZONES, ZONES, ZONE_W, zoneLabel, zoneLayout } from './zones.js';
const ui = key => globalThis.mvT?.(key) || key;

// Bumped when a column is added: pixel positions saved before that point are a column off.
const LAYOUT_KEY = 'mv-canvas-v4';
let canvasPrefs;
try {
  canvasPrefs = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
  // Saved under an older key: a new column ("Phân cảnh ghép" then "Kịch bản") shifted every
  // later column one step right, so those pixel positions no longer match their zone. Keep the
  // view and let the nodes fall back to the zone layout instead of sitting a column off.
  if (!canvasPrefs) {
    const old = JSON.parse(
      localStorage.getItem('mv-canvas-v3') ||
        localStorage.getItem('mv-canvas-v2') ||
        localStorage.getItem('mv-canvas-v1') || 'null',
    );
    if (old) canvasPrefs = { view: old.view };
  }
} catch {}
const graphView = { x: 25, y: 25, z: 1, ...canvasPrefs?.view };
const savedPositions = canvasPrefs?.positions || {};
// A collapsed Seedance group only hides its member cards on this device. It does not alter the
// group, its wires, jobs or storyboard in project data, so expanding is always reversible.
const collapsedSeedanceGroups = new Set(canvasPrefs?.collapsedSeedanceGroups || []);
// Canvas groups are a view aid, separate from Seedance render groups. They live in this
// browser's canvas preference because grouping must never add render inputs or alter the film.
let canvasGroups = Array.isArray(canvasPrefs?.canvasGroups) ? canvasPrefs.canvasGroups : [];
const selectedNodeIds = new Set();
let currentPositions = {};
export let gesture = null,
  suppressNodeClick = false;
let connectSource = null;
let selectedEdge = null;
// The canvas "spotlight": one pinned node whose card + connected nodes/wires stay bright while
// everything else dims and a light runs along its wires. It is SEPARATE from the Inspector's
// store.selected — a single click pins/clears it, panning keeps it, and it never opens the editor.
let focusedNodeId = null;

// One node's card and its ports, as markup. Kept separate so a refresh that changed only
// a few nodes can rewrite just those (see renderGraph): rebuilding the whole canvas
// reloads every preview image and makes dragging stutter while jobs run.
function nodeMarkup(n, p) {
  const focused = focusedNodeId;
  const related =
    focused &&
    store.state.edges.some(
      e =>
        (e.source === focused && e.target === n.id) || (e.target === focused && e.source === n.id),
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
    (n.terminal ? ' video-stack-shell' : '') +
    (selectedNodeIds.has(n.id) ? ' canvas-selected' : '') +
    focusClass +
    '" data-graph-id="' +
    n.id +
    '" style="left:' +
    p.x +
    'px;top:' +
    p.y +
    'px">';
  // A music node holds a song + its analysis. It takes no input, but it feeds the screenplay
  // node: wire it across and the studio breaks the song down into shots instead of inventing
  // a story from scratch.
  if (n.kind === 'music')
    return (
      open +
      card(n) +
      '<div class="ports"><button class="port ' +
      (connectSource === n.id ? 'selected' : '') +
      '" data-port-out="' +
      n.id +
      '" data-label="OUT 🎵" title="Nối sang node Kịch bản để phân cảnh theo bài hát">●</button></div></div>'
    );
  // A screenplay node takes the song (optional) and produces a blueprint; it feeds nothing.
  if (n.kind === 'script')
    return (
      open +
      card(n) +
      '<div class="ports"><button class="port" data-port-in="' +
      n.id +
      '" data-label="IN 🎵 ' +
      store.state.edges.filter(e => e.target === n.id).length +
      '" title="Nối node Nhạc vào đây để phân cảnh theo bài hát">●</button></div></div>'
    );
  const groupMembers =
    n.role === 'seedance'
      ? store.state.edges.filter(e => e.target === n.id).map(e => e.source)
      : [];
  const groupToggle =
    groupMembers.length > 1
      ? '<button type="button" class="canvas-group-toggle" data-toggle-seedance-group="' +
        n.id +
        '" aria-expanded="' +
        !collapsedSeedanceGroups.has(n.id) +
        '" title="' +
        (collapsedSeedanceGroups.has(n.id)
          ? 'Mở các shot trong nhóm'
          : 'Thu gọn các shot trong nhóm') +
        '">' +
        (collapsedSeedanceGroups.has(n.id) ? '▶ Mở' : '▼ Ẩn') +
        ' ' +
        groupMembers.length +
        ' shot</button>'
      : '';
  return (
    open +
    card(n) +
    groupToggle +
    '<div class="ports">' +
    // Image / shot nodes show two inputs: reference images, and style / camera text.
    // Both accept a wire; the server tells them apart by the source node's kind.
    (n.terminal
      ? '<button class="port video-in" data-port-in="' +
        n.id +
        '" data-label="🎬 video" title="' +
        ui('canvas.sourceVideoTitle') +
        '">●</button>'
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
          ' ' +
          ui('canvas.imageLabel') +
          '" title="' +
          ui('canvas.referenceImageTitle') +
          ': ' +
          (n.imageInputs ?? 0) +
          '">●</button><button class="port" data-port-in="' +
          n.id +
          '" data-port-kind="setting" data-label="🎨🎥 ' +
          (n.settingInputs ?? 0) +
          '" title="' +
          ui('canvas.settingTitle') +
          ': ' +
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
          ? '" data-label="OUT" title="' + ui('canvas.settingOutputTitle') + '">●</button>'
          : '" data-label="OUT ' +
            ui('canvas.imageLabel') +
            '" title="' +
            ui('canvas.imageOutputTitle') +
            '">●</button>')) +
    // The video output is not wired by hand: each produced clip becomes its own node.
    (!hasVideoPort(n)
      ? ''
      : '<button class="port video-out" ' +
        (videosOf(n).length
          ? 'data-open-node="' +
            videosOf(n).at(-1).id +
            '" title="' +
            ui('canvas.latestVideoTitle') +
            '"'
          : n.video
            ? 'data-open-node="' + n.id + '" title="' + ui('canvas.attachedVideoTitle') + '"'
            : 'disabled title="' + ui('canvas.noVideoTitle') + '"') +
        ' data-label="🎬 ' +
        (videosOf(n).length + (n.video ? 1 : 0)) +
        '">●</button>') +
    '</div></div>'
  );
}
function groupCardWidth(group) {
  // Approximate the title's rendered width so Vietnamese names stay readable while very long
  // names cannot take over an entire canvas lane.
  return Math.max(235, Math.min(420, 112 + String(group.name || 'Nhóm node').length * 7.4));
}
function canvasGroupMarkup(group, p) {
  const collapsed = group.collapsed !== false;
  return (
    '<section class="canvas-fold-group" data-canvas-group="' +
    esc(group.id) +
    '" style="left:' +
    p.x +
    'px;top:' +
    p.y +
    'px;width:' +
    groupCardWidth(group) +
    'px"><strong data-rename-canvas-group="' +
    esc(group.id) +
    '" title="Bấm để đổi tên Group">▣ ' +
    esc(group.name || 'Nhóm node') +
    '</strong><span>' +
    group.members.length +
    ' node</span><button type="button" data-toggle-canvas-group="' +
    esc(group.id) +
    '" aria-expanded="' +
    !collapsed +
    '">' +
    (collapsed ? '▶ Mở nhóm' : '▼ Ẩn nhóm') +
    '</button><button type="button" data-remove-canvas-group="' +
    esc(group.id) +
    '" title="Bỏ Group, giữ nguyên các node">×</button></section>'
  );
}
function canvasOutputGroupMarkup(group, p, count) {
  return (
    '<section class="canvas-fold-group canvas-output-fold-group" data-canvas-group="' +
    esc(group.id) +
    '" style="left:' +
    p.x +
    'px;top:' +
    p.y +
    'px;width:' +
    groupCardWidth(group) +
    'px"><strong>🎬 Out · ' +
    esc(group.name || 'Nhóm node') +
    '</strong><span>' +
    count +
    ' video</span><button type="button" data-toggle-canvas-group="' +
    esc(group.id) +
    '" aria-expanded="false">▶ Mở Group</button></section>'
  );
}
function validCanvasGroups() {
  const ids = new Set(store.state.nodes.map(n => n.id));
  canvasGroups = canvasGroups
    .map(g => ({ ...g, members: (g.members || []).filter(id => ids.has(id)).slice(0, 10) }))
    .filter(g => g.members.length > 1);
}
function groupPosition(members, positions, defaults) {
  const memberPositions = members
    .map(id => savedPositions[id] || positions[id] || defaults[id])
    .filter(Boolean);
  if (!memberPositions.length) return { x: 20, y: 74 };
  const first = memberPositions.sort((a, b) => a.y - b.y || a.x - b.x)[0];
  // Keep the compact card in the same lane and immediately above its first node. It remains
  // easy to locate when the members are opened again, without spilling into the next column.
  return { x: first.x, y: Math.max(20, first.y - 58) };
}
function flowedGroupPositions(positions, defaults) {
  const result = {};
  for (const [zoneIndex, zone] of ZONES.entries()) {
    const groups = canvasGroups
      .filter(g => store.state.nodes.find(n => n.id === g.members[0])?.zone === zone.id)
      .sort((a, b) => (a.position?.y || 0) - (b.position?.y || 0));
    let cursor = 74;
    for (const group of groups) {
      const automatic = group.auto || String(group.id).startsWith('canvas-group-auto-');
      if (!automatic) {
        result[group.id] = group.position || groupPosition(group.members, positions, defaults);
        continue;
      }
      result[group.id] = { x: zoneIndex * ZONE_W + 20, y: cursor };
      if (group.collapsed !== false) {
        cursor += 94;
        continue;
      }
      // Opening a Group inserts its cards into the same vertical flow, so every following
      // Group starts after its last node rather than sitting on top of it.
      const firstY = cursor + 70;
      group.members.forEach((id, i) => {
        const y = firstY + i * 265;
        if (positions[id]) positions[id] = { x: zoneIndex * ZONE_W + 20, y };
        // A rendered video is the Out card of its source. Keep it on the same row in its own
        // output lane, so opening a Group reads horizontally source → result.
        for (const clip of store.state.nodes.filter(n => n.terminal && n.source === id)) {
          if (!positions[clip.id]) continue;
          const outputZone = Math.max(
            0,
            ZONES.findIndex(z => z.id === clip.zone),
          );
          positions[clip.id] = { x: outputZone * ZONE_W + 20, y };
        }
      });
      cursor = firstY + group.members.length * 265 + 22;
    }
  }
  return result;
}
// Markup of the nodes drawn last time, by id: a refresh only rewrites what differs.
let drawn = new Map();
function displayLayout() {
  const hidden = new Set();
  const collapsedZones = new Set();
  const collapsedCanvasGroups = [];
  // A Seedance group has incoming edges from the shots it will render. Hide only those members;
  // the group card itself stays available in column ⑨ as the compact block and control point.
  for (const groupId of collapsedSeedanceGroups) {
    const group = store.state.nodes.find(n => n.id === groupId && n.role === 'seedance');
    if (!group) continue;
    for (const edge of store.state.edges.filter(e => e.target === groupId)) {
      const member = store.state.nodes.find(n => n.id === edge.source);
      if (!member) continue;
      hidden.add(member.id);
      collapsedZones.add(member.zone);
      // An old individually rendered clip must hide with its source; the group render remains.
      for (const clip of store.state.nodes.filter(n => n.terminal && n.source === member.id))
        hidden.add(clip.id);
    }
  }
  validCanvasGroups();
  for (const group of canvasGroups)
    if (group.collapsed !== false) {
      collapsedCanvasGroups.push(group);
      for (const id of group.members) {
        hidden.add(id);
        // Compacting a Group also compacts every video Out made by its member nodes.
        for (const clip of store.state.nodes.filter(n => n.terminal && n.source === id))
          hidden.add(clip.id);
      }
    }
  const defaults = zoneLayout(hidden);
  const positions = {};
  for (const n of store.state.nodes) {
    if (hidden.has(n.id)) continue;
    // Collapsed columns use the automatic layout to close the vertical space. Saved positions are
    // kept untouched and return when the group is expanded.
    positions[n.id] = collapsedZones.has(n.zone)
      ? defaults[n.id]
      : savedPositions[n.id] || defaults[n.id];
  }
  const groupPositions = flowedGroupPositions(positions, defaults);
  // The clips of one source are one card: only the currently selected version is displayed.
  for (const n of store.state.nodes)
    if (n.terminal && n.source && shownClip(n.source)?.id !== n.id) delete positions[n.id];
  // Give every hidden member the position of its compact Group for wire drawing. This is
  // visual only: the edge remains attached to the original node in project data.
  const proxyPositions = {};
  const proxyGroupByNode = {};
  const proxyWidthByNode = {};
  for (const group of collapsedCanvasGroups) {
    const p =
      groupPositions[group.id] ||
      group.position ||
      groupPosition(group.members, positions, defaults);
    for (const id of group.members) {
      proxyPositions[id] = p;
      proxyGroupByNode[id] = group.id;
      proxyWidthByNode[id] = groupCardWidth(group);
    }
  }
  return {
    positions,
    hidden,
    collapsedZones,
    proxyPositions,
    proxyGroupByNode,
    proxyWidthByNode,
    groupPositions,
  };
}
export function renderGraph() {
  if (gesture) return;
  const layout = displayLayout();
  const positions = layout.positions;
  currentPositions = { ...positions, ...layout.proxyPositions };
  const groupPositions = canvasGroups.map(
    group => layout.groupPositions[group.id] || group.position,
  );
  // A compact source Group also leaves one compact Out card in each video-output lane. It
  // replaces its individual clips but keeps the result count visible where editors expect it.
  const outputGroups = [];
  for (const group of canvasGroups) {
    if (group.collapsed === false) continue;
    const byZone = new Map();
    for (const clip of store.state.nodes.filter(
      n => n.terminal && group.members.includes(n.source),
    ))
      byZone.set(clip.zone, (byZone.get(clip.zone) || 0) + 1);
    for (const [zone, count] of byZone) {
      const zi = ZONES.findIndex(z => z.id === zone);
      if (zi < 0) continue;
      outputGroups.push({
        group,
        count,
        position: { x: zi * ZONE_W + 20, y: (layout.groupPositions[group.id] || group.position).y },
      });
    }
  }
  const allBoxes = [
    ...Object.values(positions),
    ...groupPositions,
    ...outputGroups.map(x => x.position),
  ];
  const w = Math.max(3 * ZONE_W + 40, ...allBoxes.map(p => p.x + 280)),
    h = Math.max(520, ...allBoxes.map(p => p.y + 265));
  if (selectedEdge && !store.state.edges.some(e => e.source + '>' + e.target === selectedEdge))
    selectedEdge = null;
  const lines =
    wiresMarkup(
      currentPositions,
      e =>
        layout.proxyGroupByNode[e.source] &&
        layout.proxyGroupByNode[e.source] === layout.proxyGroupByNode[e.target],
      layout.proxyWidthByNode,
    ) + outputGroupWiresMarkup(outputGroups, layout.groupPositions);
  const bands = ZONES.map(
    (z, i) =>
      '<div class="zone-band" style="left:' +
      i * ZONE_W +
      'px;width:' +
      ZONE_W +
      'px;height:' +
      h +
      'px"><span class="zone-label">' +
      esc(zoneLabel(z)) +
      '</span></div>',
  ).join('');
  const canvas = $('#graphCanvas');
  if (canvas.style.width !== w + 'px') canvas.style.width = w + 'px';
  if (canvas.style.height !== h + 'px') canvas.style.height = h + 'px';
  const nodes = new Map(
    store.state.nodes.filter(n => positions[n.id]).map(n => [n.id, nodeMarkup(n, positions[n.id])]),
  );
  const groupCards = canvasGroups
    .map((group, i) => canvasGroupMarkup(group, groupPositions[i]))
    .join('');
  const outputGroupCards = outputGroups
    .map(item => canvasOutputGroupMarkup(item.group, item.position, item.count))
    .join('');
  const shell =
    bands +
    '<svg width="' +
    w +
    '" height="' +
    h +
    '" class="wires">' +
    lines +
    '</svg>' +
    wireDeleteButton(currentPositions) +
    groupCards +
    outputGroupCards;
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
  updateAutoGroupButton();
  $('#groupSelectedCount').textContent = selectedNodeIds.size + '/10';
  $('#groupSelectedNodes').classList?.toggle(
    'active',
    selectedNodeIds.size >= 2 && selectedNodeIds.size <= 10,
  );
  // Hovering a node temporarily brings its connected wires forward without changing the
  // persisted graph or interrupting drag gestures.
  canvas.onpointerover = e => {
    const node = e.target.closest?.('[data-graph-id]');
    if (!node) return;
    const id = node.dataset.graphId;
    canvas
      .querySelectorAll?.('.wire.hover-focus')
      .forEach(path => path.classList.remove('hover-focus'));
    canvas
      .querySelectorAll?.(
        '.wire[data-edge-source="' + id + '"], .wire[data-edge-target="' + id + '"]',
      )
      .forEach(path => path.classList.add('hover-focus'));
  };
  canvas.onpointerout = e => {
    if (e.target.closest?.('[data-graph-id]'))
      canvas
        .querySelectorAll?.('.wire.hover-focus')
        .forEach(path => path.classList.remove('hover-focus'));
  };
  const previous = $('#autoTarget').value;
  if (
    paint(
      '#autoTarget',
      '<option value="">' +
        ui('canvas.allWorkflow') +
        '</option>' +
        store.state.nodes
          .map(
            n =>
              '<option value="' +
              n.id +
              '">' +
              ui('canvas.targetPrefix') +
              ': ' +
              esc(n.name) +
              '</option>',
          )
          .join(''),
    )
  )
    $('#autoTarget').value = previous;
  const run = store.state.autoRun;
  const statusText = status =>
    ({
      running: ui('canvas.statusRunning'),
      completed: ui('canvas.statusCompleted'),
      blocked: ui('canvas.statusBlocked'),
      stopped: ui('canvas.statusStopped'),
    })[status] || status;
  $('#autoStatus').textContent = run
    ? statusText(run.status) + ' · ' + run.index + '/' + run.order.length + ' · ' + run.message
    : ui('canvas.autoRunHint');
  // "Dừng" is available whenever something of that kind still locks the workflow: an
  // auto-run, or any queued/running job — including one started from a single node's
  // own "Tạo ảnh / Tạo video" button, which has no auto-run to stop.
  const activeJobs = kind =>
    store.state.jobs.some(
      j => j.kind === kind && ['queued', 'running'].includes(j.status) && !j.cancelRequested,
    );
  const singleJobsRunning = activeJobs('image') || activeJobs('video');
  const ir = store.state.autoImageRun;
  $('#autoStart').disabled = workflowBusy() || singleJobsRunning;
  $('#autoStop').disabled = !(
    run?.status === 'running' ||
    ir?.status === 'running' ||
    activeJobs('image')
  );
  // Per-zone quick image batch status.
  const zoneNames = {};
  $('#autoImageStatus').textContent = ir
    ? '🖼 ' +
      (ui('zone.' + ir.zone) || zoneNames[ir.zone] || ir.zone) +
      ': ' +
      statusText(ir.status) +
      ' · ' +
      ir.message
    : ui('canvas.batchImageHint');
  $('#autoImageStart').disabled = workflowBusy() || singleJobsRunning;
  const vr = store.state.autoVideoRun;
  const vrLabel = vr ? '🎬 Video: ' + statusText(vr.status) + ' · ' + vr.message : '';
  $('#autoVideoStatus').textContent = vrLabel || ui('canvas.batchVideoHint');
  if ($('#autoVideoZoneStatus')) $('#autoVideoZoneStatus').textContent = vrLabel;
  $('#autoVideoStart').disabled = workflowBusy() || singleJobsRunning;
  if ($('#autoVideoZoneStart'))
    $('#autoVideoZoneStart').disabled = workflowBusy() || singleJobsRunning;
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
    retryBtn.textContent = '↻ ' + ui('canvas.retryFailed').replace('{count}', failedVideos);
    retryBtn.disabled = workflowBusy() || singleJobsRunning;
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
      (missing
        ? `✚ ${ui('canvas.createMissing', { count: missing })}`
        : '✚ ' + ui('canvas.checkQueuedJobs')) +
      (recheckOnly ? ` · ${ui('canvas.recheckCount')} ${recheckOnly}` : '') +
      ` · ${ui('canvas.filmedCount')} ${filmed}/${shots.length}`;
    missBtn.title =
      ui('canvas.missingVideoHint') ||
      'Shot chưa có video: chưa quay, lỗi hoặc đã dừng thì tạo mới. Tác vụ Seedvis có thể đã ' +
        'làm xong (quá giờ, app khởi động lại, bị dừng khi đang tạo) thì kiểm tra lại trước, kể ' +
        'cả ở shot đã có video — xong rồi thì nhận video về, không tạo trùng.';
    missBtn.disabled = workflowBusy() || singleJobsRunning;
  }
  applyGraphView();
  document.querySelectorAll('.graph-node').forEach(el => {
    const id = el.dataset.graphId;
    const state = store.state.nodes.find(n => n.id === id);
    // Do not overwrite manual positions while the compact view temporarily repacks a column.
    if (state && !layout.collapsedZones.has(state.zone)) savedPositions[id] = positions[id];
  });
  document.querySelectorAll('[data-toggle-seedance-group]').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      const id = button.dataset.toggleSeedanceGroup;
      if (collapsedSeedanceGroups.has(id)) collapsedSeedanceGroups.delete(id);
      else collapsedSeedanceGroups.add(id);
      persistCanvas();
      render();
    };
  });
  document.querySelectorAll('[data-toggle-canvas-group]').forEach(button => {
    button.onclick = () => {
      const group = canvasGroups.find(g => g.id === button.dataset.toggleCanvasGroup);
      if (!group) return;
      group.collapsed = group.collapsed === false;
      persistCanvas();
      renderGraph();
    };
  });
  document.querySelectorAll('[data-remove-canvas-group]').forEach(button => {
    button.onclick = () => {
      canvasGroups = canvasGroups.filter(g => g.id !== button.dataset.removeCanvasGroup);
      persistCanvas();
      renderGraph();
    };
  });
  document.querySelectorAll('[data-rename-canvas-group]').forEach(title => {
    title.onclick = () => {
      const group = canvasGroups.find(g => g.id === title.dataset.renameCanvasGroup);
      if (!group) return;
      const next = window.prompt('Tên Group', group.name || 'Nhóm node');
      if (next === null) return;
      const name = next.trim().slice(0, 80);
      if (!name) return toast('Tên Group không được để trống.', true);
      group.name = name;
      persistCanvas();
      renderGraph();
    };
  });
  document.querySelectorAll('[data-port-out]').forEach(
    e =>
      (e.onclick = () => {
        if (suppressNodeClick) return;
        connectSource = e.dataset.portOut;
        $('#connectHint').textContent = ui('canvas.connectSourceSelected');
        render();
      }),
  );
  document.querySelectorAll('[data-port-in]').forEach(
    e =>
      (e.onclick = async () => {
        if (suppressNodeClick) return;
        if (!connectSource) return toast(ui('canvas.selectOutput'), true);
        try {
          store.state = await api('/api/edges', {
            method: 'PUT',
            body: {
              edges: [...store.state.edges, { source: connectSource, target: e.dataset.portIn }],
            },
          });
          connectSource = null;
          render();
          toast(ui('canvas.connected'));
        } catch (err) {
          toast(err.message, true);
        }
      }),
  );
  document
    .querySelectorAll('[data-delete-edge]')
    .forEach(e => (e.onclick = () => deleteEdge(e.dataset.deleteEdge)));
}

function closeVideoStack() {
  document.querySelector('.video-stack-overlay')?.remove();
}
async function selectTimelineClip(sourceId, clipId) {
  try {
    store.state = await api('/api/timeline/clip', {
      method: 'POST',
      body: { sourceId, clipId },
    });
    pickClip(sourceId, clipId);
    closeVideoStack();
    render();
    toast(ui('canvas.timelineVersionSelected'));
  } catch (error) {
    toast(error.message, true);
  }
}
// Delete one video version from inside the picker: remove the clip node, then rebuild the dialog
// without it (or close it when the shot has no versions left).
async function deleteStackClip(sourceId, clipId) {
  if (!confirm(ui('canvas.deleteVersion') + '?')) return;
  try {
    store.state = await api('/api/nodes/delete', { method: 'POST', body: { id: clipId } });
    render();
    if (clipsOf(sourceId).length) openVideoStack(sourceId);
    else {
      closeVideoStack();
      toast(ui('canvas.timelineVersionDeleted'));
    }
  } catch (error) {
    toast(error.message, true);
  }
}
function openVideoStack(sourceId) {
  closeVideoStack();
  const source = store.state.nodes.find(n => n.id === sourceId);
  const clips = clipsOf(sourceId);
  if (!source || !clips.length) return;
  const selected = timelineClip(sourceId);
  const overlay = document.createElement('div');
  overlay.className = 'video-stack-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', ui('canvas.chooseTimelineVersion'));
  overlay.innerHTML =
    `<section class="video-stack-dialog"><header><div><strong>${esc(source.name)}</strong>` +
    `<p>${esc(ui('canvas.chooseTimelineVersionHelp'))}</p></div>` +
    `<button class="video-stack-close" type="button" aria-label="${esc(ui('canvas.close'))}">×</button></header>` +
    `<div class="video-stack-grid">${clips
      .map((clip, index) => {
        const active = clip.id === selected?.id;
        return (
          `<article class="video-version-tile${active ? ' selected' : ''}" data-pick-timeline-clip="${esc(clip.id)}" tabindex="0">` +
          `<div class="video-version-preview"><video controls playsinline preload="metadata" src="${esc(clip.video.url)}"></video>` +
          `<span class="video-version-number">v${clip.version || index + 1}</span>` +
          `<button class="video-version-delete" type="button" data-delete-clip="${esc(clip.id)}" title="${esc(ui('canvas.deleteVersion'))}" aria-label="${esc(ui('canvas.deleteVersion'))}">🗑</button></div>` +
          `<div class="video-version-meta"><strong>${esc(clip.name || source.name)}</strong>` +
          `<button type="button">${active ? '✓ ' + esc(ui('canvas.onTimeline')) : esc(ui('canvas.useOnTimeline'))}</button></div></article>`
        );
      })
      .join('')}</div></section>`;
  overlay.onclick = event => {
    if (event.target === overlay || event.target.closest('.video-stack-close'))
      return closeVideoStack();
    if (event.target.closest('video')) return;
    // Delete this version right here, before the tile's "use on timeline" click.
    const del = event.target.closest('[data-delete-clip]');
    if (del) {
      event.stopPropagation();
      return deleteStackClip(sourceId, del.dataset.deleteClip);
    }
    const tile = event.target.closest('[data-pick-timeline-clip]');
    if (tile) selectTimelineClip(sourceId, tile.dataset.pickTimelineClip);
  };
  overlay.onkeydown = event => {
    const tile = event.target.closest?.('[data-pick-timeline-clip]');
    if (tile && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      selectTimelineClip(sourceId, tile.dataset.pickTimelineClip);
    }
  };
  document.body.appendChild(overlay);
  overlay.querySelector('.video-stack-close')?.focus();
}
// Delegation survives the canvas' incremental node replacement: a refreshed card never loses
// the click that opens its version stack.
document.addEventListener('click', event => {
  const card = event.target.closest?.('[data-video-stack-source]');
  if (!card || suppressNodeClick) return;
  openVideoStack(card.dataset.videoStackSource);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') return closeVideoStack();
  const card = event.target.closest?.('[data-video-stack-source]');
  if (!card || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  openVideoStack(card.dataset.videoStackSource);
});
async function deleteEdge(key) {
  try {
    store.state = await api('/api/edges', {
      method: 'PUT',
      body: { edges: store.state.edges.filter(e => e.source + '>' + e.target !== key) },
    });
    selectedEdge = null;
    render();
    toast(ui('canvas.edgeDeleted'));
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
// Delete / Backspace with a marquee selection removes every selected node at once. Fixed template
// and system nodes (ids not starting with "node-") are kept; the server rejects a batch that holds
// one, so we drop them here and delete only what the user may remove.
async function deleteSelectedNodes() {
  const ids = [...selectedNodeIds].filter(id => String(id).startsWith('node-'));
  const kept = selectedNodeIds.size - ids.length;
  if (!ids.length) {
    toast(
      selectedNodeIds.size
        ? 'Các node đang chọn là node cố định/mẫu, không xóa được.'
        : 'Chưa chọn node nào. Giữ Shift và kéo trên vùng trống để chọn.',
      true,
    );
    return;
  }
  if (
    !confirm(
      `Xóa ${ids.length} node đã chọn?` + (kept ? ` (giữ lại ${kept} node cố định)` : ''),
    )
  )
    return;
  try {
    store.state = await api('/api/nodes/delete', { method: 'POST', body: { ids } });
    selectedNodeIds.clear();
    render();
    toast('Đã xóa ' + ids.length + ' node.');
  } catch (err) {
    toast(err.message, true);
  }
}
document.addEventListener('keydown', e => {
  if (!selectedNodeIds.size || !['Delete', 'Backspace'].includes(e.key)) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || !$('#inspector').hidden)
    return;
  e.preventDefault();
  deleteSelectedNodes();
});
const TOOLS_PREF_KEY = 'mv-canvas-tools-open';
const graphArea = $('#graphArea');
const graphSide = $('#graphSide');
const toolsToggle = $('#toolsToggle');
const assistantToggle = $('#assistantToggle');
const toolsClose = $('#toolsClose');
// The Tools drawer is now tools-only — the Director Assistant is its own floating dock below.
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

// Director Assistant dock: a standalone panel pinned to the right; collapsing it slides it down
// into a launcher pill docked at the bottom. Its open/closed state persists on its own.
const assistantDock = $('#assistantDock');
const assistantLauncher = $('#assistantLauncher');
const DOCK_PREF_KEY = 'mv-assistant-dock-open';
let dockOpen = false;
try {
  dockOpen = localStorage.getItem(DOCK_PREF_KEY) === '1';
} catch {}
function setDockOpen(open, persist = true) {
  dockOpen = !!open;
  assistantDock?.classList?.toggle?.('collapsed', !dockOpen);
  assistantLauncher?.classList?.toggle?.('hidden', dockOpen);
  assistantToggle?.setAttribute?.('aria-expanded', String(dockOpen));
  assistantToggle?.classList?.toggle?.('active', dockOpen);
  if (persist)
    try {
      localStorage.setItem(DOCK_PREF_KEY, dockOpen ? '1' : '0');
    } catch {}
  if (dockOpen) $('#commandInput')?.focus?.();
}

const FULL_PREF_KEY = 'mv-canvas-full';
function setFullscreen(full, persist = true) {
  const area = $('#graphArea');
  const toggle = $('#fullscreenToggle');
  if (!area?.classList) return;
  area.classList.toggle('full', full);
  if (toggle) {
    toggle.textContent = full ? '⤢ ' + ui('canvas.minimize') : '⛶ ' + ui('canvas.fullscreenLabel');
    toggle.setAttribute?.('aria-expanded', String(full));
  }
  if (full) setToolsOpen(false);
  if (persist)
    try {
      localStorage.setItem(FULL_PREF_KEY, full ? '1' : '0');
    } catch {}
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (store.state?.nodes?.length) $('#fitCanvas')?.click();
    }),
  );
}
// Always open with the canvas filling the whole screen, whatever the last session left behind.
setFullscreen(true, false);
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
setDockOpen(dockOpen, false);
toolsToggle?.addEventListener?.('click', () =>
  setToolsOpen(!graphArea.classList.contains('tools-open')),
);
assistantToggle?.addEventListener?.('click', () => setDockOpen(!dockOpen));
assistantLauncher?.addEventListener?.('click', () => setDockOpen(true));
$('#assistantCollapse')?.addEventListener?.('click', () => setDockOpen(false));
// Expand the dock to fill the tab (full width) so the whole conversation is readable, then back.
$('#assistantExpand')?.addEventListener?.('click', () => assistantDock?.classList?.toggle?.('expanded'));
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
  if (focusedNodeId) {
    clearNodeFocus();
    return;
  }
  if (store.selected) {
    store.selected = null;
    render();
  }
});
// The canvas spotlight (focusedNodeId). A single click on a node pins it (dim the rest, run a light
// along its wires); clicking any node again — including a different one — clears back to the full
// view; panning never clears it. Painted directly onto the DOM so pinning does not re-render the
// canvas (which would reload every preview image); a full render re-applies it from the markup.
function applyNodeFocus() {
  const id = focusedNodeId;
  const edges = store.state?.edges || [];
  document.querySelectorAll('#graphCanvas [data-graph-id]').forEach(el => {
    const nid = el.dataset.graphId;
    const related =
      !!id &&
      edges.some(
        e => (e.source === id && e.target === nid) || (e.target === id && e.source === nid),
      );
    el.classList.toggle('selected', !!id && nid === id);
    el.classList.toggle('related', !!id && related && nid !== id);
    el.classList.toggle('dimmed', !!id && nid !== id && !related);
  });
  document
    .querySelectorAll('#graphCanvas .wire[data-edge-source][data-edge-target]')
    .forEach(el =>
      el.classList.toggle(
        'focus',
        !!id && (el.dataset.edgeSource === id || el.dataset.edgeTarget === id),
      ),
    );
  document
    .querySelectorAll(
      '#graphCanvas .wires .wire-flow, #graphCanvas .wires .wire-flow-mid, #graphCanvas .wires .wire-flow-glow',
    )
    .forEach(el => el.remove());
  if (id) {
    const svgNS = 'http://www.w3.org/2000/svg';
    document.querySelectorAll('#graphCanvas .wires .wire.focus').forEach(wire => {
      const d = wire.getAttribute('d');
      if (!d) return;
      // halo → mid → core: stacked they read as one streak tapering at both ends
      for (const cls of ['wire-flow-glow', 'wire-flow-mid', 'wire-flow']) {
        const flow = document.createElementNS(svgNS, 'path');
        flow.setAttribute('class', cls);
        flow.setAttribute('d', d);
        wire.parentNode.appendChild(flow); // after all wires → drawn on top
      }
    });
  }
}
function toggleNodeFocus(id) {
  focusedNodeId = focusedNodeId ? null : id; // pin when nothing is pinned, else clear to full view
  applyNodeFocus();
}
function clearNodeFocus() {
  if (!focusedNodeId) return;
  focusedNodeId = null;
  applyNodeFocus();
}
document.addEventListener('nodefocus', e => {
  if (e.detail) toggleNodeFocus(e.detail);
});

function persistCanvas() {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        view: graphView,
        positions: savedPositions,
        collapsedSeedanceGroups: [...collapsedSeedanceGroups],
        canvasGroups,
      }),
    );
  } catch {
    toast(ui('canvas.layoutSaveFailed'), true);
  }
}
export function placeNewCanvasNode(id) {
  const node = store.state?.nodes?.find(n => n.id === id);
  if (!node) return;
  const layout = displayLayout();
  const zoneIndex = Math.max(
    0,
    ZONES.findIndex(z => z.id === node.zone),
  );
  const laneBottoms = Object.entries(layout.positions)
    .filter(
      ([otherId]) =>
        otherId !== id && store.state.nodes.find(n => n.id === otherId)?.zone === node.zone,
    )
    .map(([, p]) => p.y + 265);
  // A compact Group is shorter than a full card; include its visual bottom so a new node
  // lands immediately after the last Group even when every grouped member is hidden.
  for (const group of canvasGroups) {
    const first = store.state.nodes.find(n => n.id === group.members[0]);
    const p = layout.groupPositions[group.id];
    if (first?.zone === node.zone && p) laneBottoms.push(p.y + 82);
  }
  savedPositions[id] = {
    x: zoneIndex * ZONE_W + 24,
    y: Math.max(74, ...(laneBottoms.length ? [Math.max(...laneBottoms) + 14] : [])),
  };
  persistCanvas();
}
function applyGraphView() {
  const c = $('#graphCanvas');
  c.style.transform =
    'translate(' + graphView.x + 'px,' + graphView.y + 'px) scale(' + graphView.z + ')';
  // Tên cột chống-scale theo biến này (style.css): canvas thu nhỏ để vừa màn hình thì chữ
  // cũng thu theo và không còn đọc được — mà tên cột là thứ phải đọc được ở mọi mức zoom.
  c.style.setProperty('--graph-z', String(graphView.z));
  $('#zoomValue').textContent = Math.round(graphView.z * 100) + '%';
  // Hướng dẫn khoanh vùng theo vị trí thật của các cột, nên nó phải đo lại mỗi khi khung nhìn
  // đổi (fit-to-screen chạy sau khi hướng dẫn đã mở là đúng trường hợp này).
  document.dispatchEvent(new CustomEvent('graphviewchange'));
}
function worldPoint(x, y) {
  const viewport = $('.graph-scroll');
  const r = viewport.getBoundingClientRect();
  return {
    x: (x - r.left + (Number(viewport.scrollLeft) || 0) - graphView.x) / graphView.z,
    y: (y - r.top + (Number(viewport.scrollTop) || 0) - graphView.y) / graphView.z,
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
function wireEnds(e, pos, compactNodes = {}) {
  const a = pos[e.source],
    b = pos[e.target];
  const src = store.state.nodes.find(n => n.id === e.source),
    dst = store.state.nodes.find(n => n.id === e.target);
  // A style / camera wire lands on the lower "🎨🎥" input of an image / shot node.
  const lower = src?.kind === 'setting' && dst && dst.kind !== 'setting' && !dst.terminal;
  // A produced clip leaves from the lower "🎬" output, the image wires from the upper one.
  const fromVideo = !!dst?.terminal && dst.source === e.source && hasVideoPort(src);
  // A compact Group is a short summary card, not a full node card with ports at y=110/150.
  // Its representative wires must meet the middle of the card so the visual connection is
  // anchored to the Group itself rather than floating beneath it.
  const sourceWidth = compactNodes[e.source],
    targetWidth = compactNodes[e.target],
    sourceCompact = Number.isFinite(sourceWidth),
    targetCompact = Number.isFinite(targetWidth);
  return [
    {
      x: a.x + (sourceCompact ? sourceWidth : 235),
      y: a.y + (sourceCompact ? 27 : fromVideo ? 150 : 110),
    },
    { x: b.x, y: b.y + (targetCompact ? 27 : lower ? 150 : 110) },
  ];
}
// Each wire has a wide transparent twin so it is easy to click.
function wiresMarkup(pos, skip = () => false, compactNodes = {}) {
  // Flow markers for the focused node's wires are collected and drawn AFTER every wire, so the
  // travelling light sits on top of the whole web (see applyNodeFocus for the click-time path).
  const flows = [];
  const wires = store.state.edges
    .filter(e => pos[e.source] && pos[e.target] && !skip(e))
    .map(e => {
      const key = e.source + '>' + e.target,
        d = edgePath(...wireEnds(e, pos, compactNodes));
      const focusEdge =
        focusedNodeId && (e.source === focusedNodeId || e.target === focusedNodeId);
      // halo → mid → core, in that order: stacked they read as one streak tapering at both ends
      if (focusEdge)
        flows.push(
          ['wire-flow-glow', 'wire-flow-mid', 'wire-flow']
            .map(c => '<path class="' + c + '" d="' + d + '"/>')
            .join(''),
        );
      return (
        '<path class="wire-hit" data-edge="' +
        key +
        '" data-edge-source="' +
        esc(e.source) +
        '" data-edge-target="' +
        esc(e.target) +
        '" d="' +
        d +
        '"><title>' +
        ui('canvas.wireHint') +
        '</title></path><path class="wire' +
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
  return wires + flows.join('');
}
function outputGroupWiresMarkup(outputGroups, groupPositions) {
  return outputGroups
    .map(item => {
      const from = groupPositions[item.group.id];
      if (!from) return '';
      const a = { x: from.x + groupCardWidth(item.group), y: from.y + 27 };
      const b = { x: item.position.x, y: item.position.y + 27 };
      const midX = Math.round((a.x + b.x) / 2),
        midY = Math.round((a.y + b.y) / 2 - 8);
      return (
        '<path class="wire group-output-wire" d="' +
        edgePath(a, b) +
        '"><title>Luồng đầu ra: ' +
        item.count +
        ' video</title></path><text class="group-wire-count" x="' +
        midX +
        '" y="' +
        midY +
        '">🎬 ' +
        item.count +
        '</text>'
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
    'px" title="' +
    ui('canvas.deleteWire') +
    '" aria-label="' +
    ui('canvas.deleteWire') +
    '">×</button>'
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
  svg.innerHTML = wiresMarkup(currentPositions);
  if (gesture?.type === 'wire' && pointer) {
    const p = currentPositions[gesture.id];
    const a = gesture.direction === 'out' ? { x: p.x + 235, y: p.y + 110 } : pointer,
      b = gesture.direction === 'out' ? pointer : { x: p.x, y: p.y + 110 };
    svg.innerHTML += '<path class="draft-wire" d="' + edgePath(a, b) + '"/>';
  }
}
function zoomAt(factor, x, y) {
  const viewport = $('.graph-scroll');
  const r = viewport.getBoundingClientRect(),
    before = worldPoint(x, y);
  graphView.z = Math.max(0.25, Math.min(2.5, graphView.z * factor));
  graphView.x = x - r.left + (Number(viewport.scrollLeft) || 0) - before.x * graphView.z;
  graphView.y = y - r.top + (Number(viewport.scrollTop) || 0) - before.y * graphView.z;
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
  toast(ui('canvas.arranged'));
};
$('#fitCanvas').onclick = () => {
  const visibleNodes = store.state.nodes.filter(
    n => !n.terminal || shownClip(n.source)?.id === n.id,
  );
  const layout = displayLayout();
  const ps = visibleNodes.map(n => layout.positions[n.id]).filter(Boolean);
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
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
  applyGraphView();
  persistCanvas();
};
const viewport = $('.graph-scroll');
// Đưa một khoảng ngang [left, right] (toạ độ màn hình) vào tầm nhìn. Canvas dời bằng CSS
// transform chứ không phải scroll, nên chỉnh scrollLeft là vô tác dụng — phải dịch graphView.x.
// `translate()` đứng trước `scale()` nên 1 đơn vị ở đây đúng bằng 1 pixel màn hình.
// Khoảng rộng hơn khung thì canh mép trái. Không ghi vào prefs: đây là xê dịch tạm.
export function panIntoView(left, right, margin = 16) {
  const r = viewport.getBoundingClientRect();
  let dx = 0;
  if (left < r.left + margin) dx = r.left + margin - left;
  else if (right > r.right - margin)
    dx = -Math.min(right - (r.right - margin), left - (r.left + margin));
  if (!dx) return false;
  graphView.x += dx;
  applyGraphView();
  return true;
}
// Start at the top-left each time the app opens. Groups and node positions remain saved, while
// the first view consistently starts at the beginning of the production board.
if (typeof window !== 'undefined')
  window.addEventListener(
    'load',
    () => {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      graphView.x = 25;
      graphView.y = 25;
      applyGraphView();
    },
    { once: true },
  );
$('#groupSelectedNodes').onclick = () => {
  const members = [...selectedNodeIds].filter(id => currentPositions[id]).slice(0, 10);
  if (members.length < 2) {
    toast('Giữ Shift và kéo trên vùng trống để chọn ít nhất 2 node trước.');
    return;
  }
  if (selectedNodeIds.size > 10) {
    toast('Mỗi Group canvas tối đa 10 node. Hãy quét một cụm nhỏ hơn.', true);
    return;
  }
  const index = canvasGroups.length + 1;
  canvasGroups.push({
    id: 'canvas-group-' + Date.now(),
    name: 'Group ' + String(index).padStart(2, '0'),
    members,
    position: groupPosition(members, currentPositions, zoneLayout()),
    collapsed: true,
  });
  selectedNodeIds.clear();
  persistCanvas();
  renderGraph();
  toast('Đã tạo Group và thu gọn ' + members.length + ' node.');
};
// Gom tự động chỉ tạo các Group có cờ `auto`. Nút chuyển chế độ theo đó: có nhóm auto → "Bỏ gom"
// (xoá hết nhóm auto, trở về trạng thái trước); chưa có → "Tự động gom".
function hasAutoGroups() {
  return canvasGroups.some(g => g.auto);
}
export function updateAutoGroupButton() {
  const btn = $('#autoGroupNodes');
  if (!btn) return;
  const ungroup = hasAutoGroups();
  btn.textContent = ungroup ? '▤ Bỏ gom' : '▦ Tự động gom';
  btn.title = ungroup
    ? 'Bỏ hết các nhóm vừa tự động gom, trở về trạng thái trước'
    : 'Tự xếp node theo khu vực rồi gom các cụm liền kề, tối đa 10 node mỗi Group';
}
function ungroupAuto() {
  canvasGroups = canvasGroups.filter(g => !g.auto);
  selectedNodeIds.clear();
  persistCanvas();
  renderGraph();
  toast('Đã bỏ gom, trở về trạng thái trước.');
}
function autoGroupNodes() {
  const layout = zoneLayout();
  // Restore a tidy, vertical order first. Groups are visual-only, so terminal result cards and
  // special render-group cards are left out; they keep their own output columns.
  for (const id of Object.keys(savedPositions)) delete savedPositions[id];
  Object.assign(savedPositions, layout);
  const candidates = store.state.nodes
    .filter(n => !n.terminal && n.role !== 'seedance')
    .sort((a, b) => {
      const za = ZONES.findIndex(z => z.id === a.zone),
        zb = ZONES.findIndex(z => z.id === b.zone);
      return (
        za - zb || (a.seq || 0) - (b.seq || 0) || (layout[a.id]?.y || 0) - (layout[b.id]?.y || 0)
      );
    });
  canvasGroups = [];
  // Never mix columns: a Group represents consecutive cards in one visual lane.
  for (const zone of ZONES.map(z => z.id)) {
    const lane = candidates.filter(n => n.zone === zone);
    let compactIndex = 0;
    const zoneIndex = ZONES.findIndex(z => z.id === zone);
    for (let i = 0; i < lane.length; i += 10) {
      const members = lane.slice(i, i + 10).map(n => n.id);
      if (members.length < 2) continue;
      canvasGroups.push({
        id: 'canvas-group-auto-' + Date.now() + '-' + zone + '-' + i,
        name: 'Group ' + String(canvasGroups.length + 1).padStart(2, '0'),
        members,
        // While collapsed, show every Group as a tight list at the top of its own lane.
        // The ten full cards keep their ordered positions and return there on “Mở nhóm”.
        position: { x: zoneIndex * ZONE_W + 20, y: 74 + compactIndex++ * 94 },
        auto: true,
        collapsed: true,
      });
    }
  }
  selectedNodeIds.clear();
  persistCanvas();
  renderGraph();
  toast(
    canvasGroups.length
      ? 'Đã tự xếp và tạo ' + canvasGroups.length + ' Group.'
      : 'Cần ít nhất 2 node để tạo Group.',
  );
}
$('#autoGroupNodes').onclick = () => (hasAutoGroups() ? ungroupAuto() : autoGroupNodes());
function updateSelectionBox(g, clientX, clientY) {
  const a = worldPoint(g.x, g.y),
    b = worldPoint(clientX, clientY);
  const left = Math.min(a.x, b.x),
    top = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x),
    height = Math.abs(a.y - b.y);
  let box = $('#graphCanvas .canvas-selection-box');
  if (!box) {
    box = document.createElement('div');
    box.className = 'canvas-selection-box';
    $('#graphCanvas').appendChild(box);
  }
  Object.assign(box.style, {
    left: left + 'px',
    top: top + 'px',
    width: width + 'px',
    height: height + 'px',
  });
  selectedNodeIds.clear();
  for (const [id, p] of Object.entries(currentPositions)) {
    const node = store.state.nodes.find(n => n.id === id);
    if (!node || node.terminal) continue;
    if (p.x < left + width && p.x + 235 > left && p.y < top + height && p.y + 245 > top)
      selectedNodeIds.add(id);
  }
  document
    .querySelectorAll('.graph-node')
    .forEach(el => el.classList.toggle('canvas-selected', selectedNodeIds.has(el.dataset.graphId)));
  $('#groupSelectedCount').textContent = selectedNodeIds.size + '/10';
  $('#groupSelectedNodes').classList?.toggle(
    'active',
    selectedNodeIds.size >= 2 && selectedNodeIds.size <= 10,
  );
}
viewport.addEventListener(
  'wheel',
  e => {
    if (gesture) return;
    // Normal wheel is native vertical scroll. Shift makes the wide canvas travel left/right;
    // Ctrl is the explicit zoom gesture so browsing long node columns never changes scale.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    } else if (e.shiftKey) {
      e.preventDefault();
      viewport.scrollLeft = (Number(viewport.scrollLeft) || 0) + (e.deltaY || e.deltaX);
    }
  },
  { passive: false },
);
viewport.addEventListener('dragstart', e => e.preventDefault());
viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  const port = e.target.closest('[data-port-in],[data-port-out]'),
    node = e.target.closest('.graph-node');
  if (!port && e.target.closest('.wire-delete')) return;
  const groupToggle =
    e.target.dataset?.toggleSeedanceGroup ||
    e.target.dataset?.toggleCanvasGroup ||
    e.target.dataset?.removeCanvasGroup ||
    e.target.dataset?.renameCanvasGroup;
  // Group controls are buttons. Do not start a pan or preventDefault here, otherwise their
  // click event never fires and a compact group cannot be opened again.
  if (groupToggle) return;
  // The 🎬 marker is a plain button (open the newest clip), never a drag handle.
  if (!port && e.target.closest('[data-open-node]')) return;
  const wire = !port && !node ? e.target.closest('[data-edge]') : null;
  if (e.shiftKey && !port && !node) {
    // Shift + drag draws a marquee. It chooses a consecutive visual cluster for a compact
    // canvas group; it never moves nodes or changes their graph connections.
    gesture = { type: 'select' };
    selectedNodeIds.clear();
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
      const crossed = Math.abs(dx) > 80 && Math.abs(rawZoneIndex - zoneIndex) >= 1;
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
    currentPositions[gesture.id] = p;
    const el = document.querySelector('[data-graph-id="' + gesture.id + '"]');
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    repaintWiresSoon();
  } else if (gesture.type === 'pan') {
    graphView.x = gesture.start.x + dx;
    graphView.y = gesture.start.y + dy;
    applyGraphView();
  } else if (gesture.type === 'select') {
    updateSelectionBox(gesture, e.clientX, e.clientY);
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
  const prevEdge = selectedEdge; // to tell whether this gesture (de)selected a wire
  let changed = false; // true only when the GRAPH DATA changed (an edge added / a zone moved)
  // The wires were redrawn outside renderGraph (and a draft wire may be mid-flight): drop
  // what is pending.
  if (wireFrame) {
    cancelAnimationFrame(wireFrame);
    wireFrame = null;
  }
  document.querySelectorAll('#graphCanvas .draft-wire').forEach(el => el.remove());
  document.querySelectorAll('#graphCanvas .canvas-selection-box').forEach(el => el.remove());
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
  if (g.type === 'select') {
    // Keep the selected nodes highlighted after the marquee disappears so the dock action is
    // explicit and the user can review the count before creating a Group.
    suppressNodeClick = true;
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
        changed = true;
        toast(ui('canvas.connected'));
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
          changed = true;
          toast(ui('canvas.movedTo').replace('{zone}', zoneLabel(ZONES[zi])));
        } catch (err) {
          savedPositions[g.id] = g.start;
          toast(err.message, true);
        }
      }
    }
  }
  persistCanvas();
  // Only a real data change needs a full render (rebuilds node cards + reloads their media). A node
  // dragged within its column, or a wire drag that added nothing, already moved in the DOM — just
  // repaint the wires (fast, no cards). A pure pan or a click that touched no selection does
  // nothing. Clicking a wire to (de)select it falls back to a full render for the × button.
  if (changed) {
    $('#graphCanvas').__shell = null; // the drag redrew wires outside renderGraph; force a clean shell
    render();
  } else if (g.moved && (g.type === 'node' || g.type === 'wire')) {
    repaintWires();
  } else if (selectedEdge !== prevEdge) {
    $('#graphCanvas').__shell = null;
    render();
  }
}
viewport.addEventListener('pointerup', e => endGesture(e));
viewport.addEventListener('pointercancel', e => endGesture(e, true));
document.addEventListener('localechange', () => {
  if (store.state) renderGraph();
});
document.addEventListener('canvasnodeadded', e => {
  placeNewCanvasNode(e.detail?.id);
});
