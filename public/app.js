let canvasPrefs;
try {
  canvasPrefs = JSON.parse(localStorage.getItem('mv-canvas-v1') || 'null');
} catch {}
const graphView = { x: 25, y: 25, z: 1, ...canvasPrefs?.view };
const savedPositions = canvasPrefs?.positions || {};
let gesture = null,
  suppressNodeClick = false;
let connectSource = null;
let orbitStatus = null;
let seedvisStatus = null;
let selectedEdge = null;
const gallerySel = new Set();
// The workflow is read-only while any job is queued/running or an auto-run is active —
// the server rejects edits then, so the UI mirrors that lock instead of letting the user
// make changes that would only error or silently not persist.
const workflowBusy = () =>
  !!(
    typeof state !== 'undefined' &&
    state &&
    (state.autoRun?.status === 'running' ||
      state.autoVideoRun?.status === 'running' ||
      state.autoImageRun?.status === 'running' ||
      state.jobs?.some(j => ['queued', 'running'].includes(j.status) && !j.cancelRequested))
  );
// Workflow zones (process stages) shown as columns on the canvas.
const ZONES = [
  { id: 'character', label: '① Nhân vật' },
  { id: 'design', label: '② Bối cảnh' },
  { id: 'setup', label: '③ Style & Máy quay' },
  { id: 'production', label: '④ Sản xuất video' },
  { id: 'output', label: '⑤ Video' },
];
const ZONE_W = 340;
const zoneIndex = id =>
  Math.max(
    0,
    ZONES.findIndex(z => z.id === id),
  );
// Order within a zone: production follows seq; output follows its source's seq then version.
const zoneOrder = n =>
  n.zone === 'output' ? (n.sourceSeq || 999) * 100 + (n.version || 0) : n.seq || 999;
// Lays every node out into its zone column, stacked in order (the arrange button).
// Output videos are special: each sits on the SAME ROW as the production node it came
// from, and extra versions line up to its right — so a shot with no video yet leaves a
// gap instead of pulling the videos below it upward.
const OUT_STEP = 250; // horizontal gap between versions of the same shot
function zoneLayout() {
  const rows = {},
    pos = {},
    sourceY = {},
    outputs = [];
  for (const n of [...state.nodes].sort((a, b) => zoneOrder(a) - zoneOrder(b))) {
    if (n.zone === 'output') {
      outputs.push(n);
      continue;
    }
    const zi = zoneIndex(n.zone),
      row = rows[zi] || 0;
    rows[zi] = row + 1;
    const y = 54 + row * 285;
    pos[n.id] = { x: 24 + zi * ZONE_W, y };
    sourceY[n.id] = y;
  }
  const oi = zoneIndex('output');
  const used = {}; // versions already placed per source → horizontal offset
  let orphanRow = Object.values(sourceY).length; // videos whose source is gone stack below
  for (const n of outputs) {
    const y = n.source in sourceY ? sourceY[n.source] : 54 + orphanRow++ * 285;
    const col = used[n.source || n.id] || 0;
    used[n.source || n.id] = col + 1;
    pos[n.id] = { x: 24 + oi * ZONE_W + col * OUT_STEP, y };
  }
  return pos;
}
let state,
  selected = null,
  currentView = 'studio',
  dirty = false;
const pad2 = n => String(n || 0).padStart(2, '0');
// Filesystem-safe version of a node name.
const safeName = s =>
  String(s || 'video')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'video';
const extOf = url => String(url).match(/\.(mp4|webm|png|jpg|jpeg|webp)(?:\?|$)/i)?.[1] || 'mp4';
// Download name: <stt>_<tên node>[_vN].<ext>, so the source is obvious.
function downloadName(n, kind = 'video') {
  const asset = n[kind] || n.video || n.image;
  const ext = extOf(asset?.url || asset?.name || '');
  if (n.terminal) {
    // Name by the source shot's production number so the origin is obvious.
    const src = state?.nodes?.find(x => x.id === n.source);
    const num = src?.seq ?? n.sourceSeq,
      nm = src?.name ?? n.sourceName;
    return pad2(num) + '_' + safeName(nm) + '_v' + (n.version || 1) + '.' + ext;
  }
  return pad2(n.seq) + '_' + safeName(n.name) + '.' + ext;
}
// Point a media URL at the download route so the server forces a file save (browsers
// otherwise play video inline and ignore the download attribute).
const dlUrl = (url, name) =>
  String(url) + (String(url).includes('?') ? '&' : '?') + 'dl=' + encodeURIComponent(name);
function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = dlUrl(url, name);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
const $ = s => document.querySelector(s),
  esc = s =>
    String(s ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
async function api(url, options = {}) {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Không kết nối được');
  return data;
}
function toast(msg, error = false) {
  $('#toast').textContent = msg;
  $('#toast').className = error ? 'error' : '';
  $('#toast').style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($('#toast').style.display = 'none'), 5000);
}
function status(n) {
  const j = [...state.jobs].reverse().find(j => j.nodeId === n.id);
  if (j && ['queued', 'running', 'failed', 'needs_review'].includes(j.status))
    return {
      text: {
        queued: 'Đang chờ chạy',
        running: j.payload.seedvis ? 'Đang tạo trên Seedvis' : 'Đang chạy trên web',
        failed: 'Cần xử lý lỗi',
        needs_review: j.payload.seedvis ? 'Cần kiểm tra Seedvis' : 'Cần kiểm tra website',
      }[j.status],
      class: 'warn',
    };
  if (n.stale || n.videoStale) return { text: 'Đầu vào đã thay đổi', class: 'warn' };
  return n.video
    ? { text: 'Có video', class: 'good' }
    : n.image
      ? { text: 'Đã có ảnh', class: 'good' }
      : { text: 'Chưa có ảnh', class: '' };
}
function preview(n, cls = '') {
  return `<div class="preview ${cls}">${n.image ? `<img src="${esc(n.image.url)}" alt="${esc(n.name)}">` : `<div class="placeholder"><span class="symbol">${n.id === 'singer' ? '♙' : n.id === 'stage' ? '▱' : n.id === 'scene' ? '▧' : '▣'}</span>${n.id === 'scene' ? 'Nhân vật + bối cảnh' : 'Tạo hoặc tải ảnh'}</div>`}</div>`;
}
function card(n, shot = false) {
  const s = status(n);
  if (n.kind === 'setting') {
    const icon = n.settingType === 'camera' ? '🎥' : '🎨';
    return `<article class="node setting" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>${icon} ${esc(n.name)}</span><span class="mini">↗</span></div><div class="setting-body">${n.config ? esc(n.config) : '<em>Chưa đặt nội dung</em>'}</div><div class="node-footer"><span class="status">Áp cho node được nối</span></div></article>`;
  }
  if (n.terminal)
    return `<article class="node terminal" tabindex="0" role="button" data-node="${n.id}" aria-label="Xem ${esc(n.name)}"><div class="node-top"><span>🎬 ${esc(n.name)}</span><span class="mini">↗</span></div><div class="preview video"><video muted playsinline preload="metadata" src="${esc(n.video?.url || '')}"></video><span class="play-badge">▶</span></div><div class="node-footer"><span class="status good">Phiên bản video</span><span>Bấm để xem</span></div></article>`;
  const seq = n.seq ? `<span class="seq">#${n.seq}</span>` : '';
  return shot
    ? `<article class="node shot" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}">${preview(n)}<div class="shot-info"><strong>${seq} ${esc(n.name)} <small>↗</small></strong><small>${n.start}s — ${n.start + n.duration}s · ${n.duration} giây</small><span class="status ${s.class}">${s.text}</span></div></article>`
    : `<article class="node" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>${seq} ${esc(n.name)}</span><span class="mini">↗</span></div>${preview(n, ['singer', 'stage', 'scene'].includes(n.id) ? n.id : '')}<div class="node-footer"><span class="status ${s.class}">${s.text}</span><span>${state.edges.filter(e => e.target === n.id).length + ' ảnh đầu vào'}</span></div></article>`;
}
function render() {
  const online = state.worker?.online;
  const busy = workflowBusy();
  $('#graphArea').classList.toggle('busy', busy);
  $('#graphLock').hidden = !busy;
  // Lock the canvas edit buttons while running; auto start/stop are managed separately.
  for (const id of ['addNode', 'addStyle', 'addCamera', 'arrangeZones'])
    $('#' + id).disabled = busy;
  $('#projectName').textContent = state.name;
  renderProjects();
  $('#workerBadge').textContent = online ? '● Orbit worker đã nối' : '○ Chưa nối Orbit';
  $('#workerBadge').className = 'badge' + (online ? ' online' : '');
  $('#jobCount').textContent = state.jobs.filter(
    j => ['queued', 'running'].includes(j.status) && !j.cancelRequested,
  ).length;
  renderGraph();
  $('#timelineTrack').innerHTML = state.nodes
    .filter(n => 'duration' in n && !n.terminal && n.kind !== 'setting')
    .map(
      n =>
        `<button data-node="${n.id}">${esc(n.name)}<small>${n.start}s · ${n.duration}s</small></button>`,
    )
    .join('');
  $('#songName').textContent = state.audio?.name || 'Thêm bài hát';
  if (state.audio) {
    $('#songPlayer').hidden = false;
    if (!$('#songPlayer').src.endsWith(state.audio.url)) $('#songPlayer').src = state.audio.url;
  }
  $('#connectionStatus').textContent = online
    ? `Đã nối: ${state.worker.name}`
    : 'Bộ chạy Orbit trực tiếp đã bật. Đăng nhập và chọn kịch bản/nick trong node.';
  if (orbitStatus) showOrbit(orbitStatus);
  renderJobs();
  renderGallery();
  document.querySelectorAll('[data-node]').forEach(e => {
    e.onclick = () => {
      if (!suppressNodeClick) inspect(e.dataset.node);
    };
    e.onkeydown = k => {
      if (k.key === 'Enter') inspect(e.dataset.node);
    };
  });
}
// Every node that holds a video, grouped by its source node.
function videoGroups() {
  const items = state.nodes.filter(n => n.video);
  const groups = new Map();
  for (const n of items) {
    const src = n.terminal ? state.nodes.find(x => x.id === n.source) : null;
    const key = n.terminal ? n.source || n.id : n.id;
    const seq = n.terminal ? (src?.seq ?? n.sourceSeq) : n.seq;
    const name = n.terminal ? src?.name || n.sourceName || '(nguồn đã xóa)' : n.name;
    if (!groups.has(key)) groups.set(key, { key, seq: seq || 0, name, items: [] });
    groups.get(key).items.push(n);
  }
  return [...groups.values()].sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
}
function renderGallery() {
  const groups = videoGroups();
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  $('#videoCount').textContent = total;
  for (const id of [...gallerySel])
    if (!state.nodes.some(n => n.id === id && n.video)) gallerySel.delete(id);
  $('#galleryBody').innerHTML = total
    ? groups
        .map(
          g =>
            `<div class="gallery-group"><h3>${g.seq ? '#' + g.seq + ' ' : ''}${esc(g.name)} <small>${g.items.length} video</small></h3><div class="gallery-grid">${g.items
              .map(
                n =>
                  `<div class="gallery-item ${gallerySel.has(n.id) ? 'sel' : ''}" data-node="${n.id}"><label class="pick" title="Chọn"><input type="checkbox" data-pick="${n.id}" ${gallerySel.has(n.id) ? 'checked' : ''}></label><div class="preview video"><video muted playsinline preload="metadata" src="${esc(n.video.url)}"></video><span class="play-badge">▶</span></div><div class="gallery-meta"><strong>${esc(n.terminal ? 'v' + (n.version || 1) : n.name)}</strong><a class="text-button" href="${esc(dlUrl(n.video.url, downloadName(n)))}" download="${esc(downloadName(n))}" data-dl>↓ ${esc(downloadName(n))}</a></div></div>`,
              )
              .join('')}</div></div>`,
        )
        .join('')
    : '<div class="empty">Chưa có video nào. Tạo video ở một node, hoặc dùng ▶ Tự động tạo video.</div>';
  $('#galleryBar').hidden = !total;
  $('#gallerySelected').textContent = 'Đã chọn ' + gallerySel.size;
  // Checkbox toggles selection; download link must not open the viewer.
  document.querySelectorAll('[data-pick]').forEach(
    e =>
      (e.onclick = ev => {
        ev.stopPropagation();
        if (e.checked) gallerySel.add(e.dataset.pick);
        else gallerySel.delete(e.dataset.pick);
        renderGallery();
      }),
  );
  document
    .querySelectorAll('#galleryBody [data-dl]')
    .forEach(e => (e.onclick = ev => ev.stopPropagation()));
}
$('#gallerySelectAll').onclick = () => {
  for (const g of videoGroups()) for (const n of g.items) gallerySel.add(n.id);
  renderGallery();
};
$('#galleryClear').onclick = () => {
  gallerySel.clear();
  renderGallery();
};
$('#galleryDownload').onclick = async () => {
  const picked = state.nodes.filter(n => gallerySel.has(n.id) && n.video);
  if (!picked.length) return toast('Chưa chọn video nào', true);
  // One video: download it directly. Several: package them into one ZIP named by shot.
  if (picked.length === 1) {
    triggerDownload(picked[0].video.url, downloadName(picked[0]));
    return toast('Đang tải video');
  }
  const btn = $('#galleryDownload');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Đang nén…';
  try {
    const r = await fetch('/api/videos/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: picked.map(n => n.id) }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Nén thất bại');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; // a blob URL already carries the right filename via the download attribute
    a.download = (state.name || 'videos').replace(/[^\w.\- ]+/g, '_') + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Đã nén ' + picked.length + ' video thành ZIP');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
};
$('#galleryDelete').onclick = async () => {
  const picked = state.nodes.filter(n => gallerySel.has(n.id) && n.terminal);
  const skipped = [...gallerySel].length - picked.length;
  if (!picked.length) return toast('Chỉ xóa được node phiên bản video đã chọn', true);
  if (!confirm('Xóa ' + picked.length + ' node phiên bản video đã chọn?')) return;
  try {
    for (const n of picked) {
      state = await api('/api/nodes/delete', { method: 'POST', body: { id: n.id } });
      gallerySel.delete(n.id);
    }
    render();
    toast(
      'Đã xóa ' +
        picked.length +
        ' video' +
        (skipped ? ' (bỏ qua ' + skipped + ' không phải node phiên bản)' : ''),
    );
  } catch (e) {
    toast(e.message, true);
  }
};
const themeLabel = id => (state.themes || []).find(t => t.id === id)?.label || id;
// Zone picker (design/production) for a non-output node.
const zoneSelect = n =>
  '<label>Khu vực<select id="nodeZone">' +
  ZONES.filter(z => z.id !== 'output')
    .map(
      z => `<option value="${z.id}" ${n.zone === z.id ? 'selected' : ''}>${esc(z.label)}</option>`,
    )
    .join('') +
  '</select></label>';
function renderProjects() {
  const sel = $('#projectSelect');
  sel.innerHTML = (state.projects || [])
    .map(
      p =>
        `<option value="${p.id}" ${p.id === state.activeProjectId ? 'selected' : ''}>${esc(p.name)} · ${esc(themeLabel(p.theme))}</option>`,
    )
    .join('');
  document.querySelector('.eyebrow').textContent =
    'WORKSPACE / ' + themeLabel(state.theme).toUpperCase();
  const sl = $('#saveLocation');
  if (sl && state.dataDir) sl.textContent = '💾 Lưu tại: ' + state.dataDir;
}
$('#projectSelect').onchange = async e => {
  try {
    state = await api('/api/projects/switch', { method: 'POST', body: { id: e.target.value } });
    gallerySel.clear();
    closeInspector();
    render();
  } catch (err) {
    toast(err.message, true);
    render();
  }
};
$('#newProject').onclick = () => {
  selected = null;
  $('#overlay').hidden = false;
  $('#inspector').hidden = false;
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>Project mới</h2><button class="close" aria-label="Đóng">×</button></div>' +
    '<label>Tên project<input id="npName" placeholder="Ví dụ: MV ca khúc X"></label>' +
    '<label>Chủ đề<select id="npTheme">' +
    (state.themes || []).map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('') +
    '</select></label><p class="field-hint">Project mới được nhân từ bộ node mẫu của chủ đề (kèm node Style và Máy quay).</p>' +
    '<button class="button primary wide" id="npCreate">Tạo project</button>';
  $('.close').onclick = closeInspector;
  $('#npCreate').onclick = async () => {
    try {
      state = await api('/api/projects', {
        method: 'POST',
        body: { name: $('#npName').value, theme: $('#npTheme').value },
      });
      gallerySel.clear();
      closeInspector();
      render();
      toast('Đã tạo project mới');
    } catch (e) {
      toast(e.message, true);
    }
  };
};
// Backup: download the active project (graph + media) as one .mvproj.json file.
// Guarded so an older cached index.html (without these buttons) can't halt the script.
const backupBtn = $('#backupProject');
if (backupBtn)
  backupBtn.onclick = () => {
    const name = (state.name || 'project').replace(/[^\w.\- ]+/g, '_') + '.mvproj.json';
    triggerDownload('/api/projects/export?id=' + encodeURIComponent(state.activeProjectId), name);
    toast('Đang tải file backup…');
  };
// Restore: import a .mvproj.json file as a new project.
const importInput = $('#importProject');
if (importInput)
  importInput.onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      state = await api('/api/projects/import', { method: 'POST', body: bundle });
      gallerySel.clear();
      closeInspector();
      render();
      toast('Đã nhập project từ file backup');
    } catch (err) {
      toast('Nhập thất bại: ' + err.message, true);
    }
  };
function renderJobs() {
  $('#jobs').innerHTML = state.jobs.length
    ? [...state.jobs]
        .reverse()
        .map(
          j =>
            `<div class="job-row"><div><strong>${esc(state.nodes.find(n => n.id === j.nodeId)?.name)} · ${j.kind === 'image' ? 'Tạo ảnh' : 'Tạo video'}</strong><p>${esc(j.payload.website)} · ${new Date(j.createdAt).toLocaleString('vi-VN')}</p>${j.progress ? `<p>${esc(j.progress)}</p>` : ''}${j.error ? `<p>${esc(j.error)}</p>` : ''}${j.warning ? `<p>${esc(j.warning)}</p>` : ''}${j.resultStale ? '<p>Đầu vào đã thay đổi trong khi chạy: cần duyệt lại kết quả.</p>' : ''}</div><span class="badge">${esc({ queued: 'Đang chờ', running: 'Đang chạy', script_completed: 'Kịch bản đã xong', completed: 'Hoàn tất', failed: 'Lỗi', needs_review: 'Cần kiểm tra', cancelled: 'Đã hủy' }[j.status])}</span>${j.status === 'queued' ? `<button class="button" data-cancel="${j.id}">Hủy chờ</button>` : ['needs_review', 'script_completed'].includes(j.status) && (j.payload.output || j.payload.seedvis) ? `<button class="button" data-collect="${j.id}">${j.payload.seedvis ? 'Kiểm tra lại' : 'Nhận file'}</button>` : j.result ? `<a class="button" href="${esc(dlUrl(j.result.url, j.result.name || 'ket-qua'))}" download="${esc(j.result.name || 'ket-qua')}">Tải kết quả</a>` : '<span></span>'}</div>`,
        )
        .join('')
    : '<div class="empty">Chưa có tác vụ. Chọn một node và nhấn “Tạo ảnh”.</div>';
  document.querySelectorAll('[data-collect]').forEach(
    e =>
      (e.onclick = async () => {
        e.disabled = true;
        try {
          await api('/api/jobs/collect', { method: 'POST', body: { id: e.dataset.collect } });
          await refresh();
          toast(
            state.jobs.find(j => j.id === e.dataset.collect)?.payload.seedvis
              ? 'Đang đọc lại trạng thái Seedvis'
              : 'Đã nhận file',
          );
        } catch (err) {
          toast(err.message, true);
        } finally {
          e.disabled = false;
        }
      }),
  );
  document.querySelectorAll('[data-cancel]').forEach(
    e =>
      (e.onclick = async () => {
        try {
          await api('/api/jobs/cancel', { method: 'POST', body: { id: e.dataset.cancel } });
          await refresh();
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}
function view(id) {
  currentView = id;
  document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== id));
  document
    .querySelectorAll('[data-view]')
    .forEach(b => b.classList.toggle('active', b.dataset.view === id));
  // Reload each time: the master prompt is per-project, so it must refresh after a switch.
  if (id === 'director') loadDirector();
}
document.querySelectorAll('[data-view]').forEach(b => (b.onclick = () => view(b.dataset.view)));
function closeInspector() {
  selected = null;
  dirty = false;
  $('#inspector').hidden = true;
  $('#overlay').hidden = true;
}
$('#overlay').onclick = closeInspector;
// While the queue runs, the inspector becomes view-only: every editing control and action
// button is disabled (close/copy/download stay), with a note explaining why.
function lockInspectorIfBusy() {
  if (!workflowBusy()) return;
  const insp = $('#inspector');
  const keep = new Set(['copyImage', 'copyVideo']);
  insp.querySelectorAll('input, textarea, select, button').forEach(el => {
    if (el.classList.contains('close') || keep.has(el.id)) return;
    el.disabled = true;
  });
  const head = insp.querySelector('.inspector-head');
  if (head && !insp.querySelector('.busy-note')) {
    const note = document.createElement('div');
    note.className = 'note busy-note';
    note.textContent =
      '🔒 Hàng đợi đang chạy — node ở chế độ chỉ xem. Đợi xong hoặc bấm Dừng để sửa.';
    head.after(note);
  }
}
function inspect(id) {
  selected = id;
  dirty = false;
  const n = state.nodes.find(n => n.id === id),
    // Shots carry timing; compose/reference nodes (scene, singer…) do not.
    shot = n && 'duration' in n && !n.terminal && n.kind !== 'setting';
  $('#inspector').hidden = false;
  $('#overlay').hidden = false;
  if (n.kind === 'setting') {
    const targets = state.edges
      .filter(e => e.source === n.id)
      .map(e => state.nodes.find(x => x.id === e.target)?.name)
      .filter(Boolean);
    $('#inspector').innerHTML =
      `<div class="inspector-head"><h2>${n.settingType === 'camera' ? '🎥' : '🎨'} ${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
      `<p class="field-hint">Node ${n.settingType === 'camera' ? 'máy quay' : 'style'}: nội dung dưới đây được chèn vào prompt của mọi node bạn nối ra. Nối cổng Ra của node này vào node cần áp.</p>` +
      `<label>Tên<input id="settingName" value="${esc(n.name)}"></label>` +
      `<label>Nội dung ${n.settingType === 'camera' ? '(mô tả máy quay, góc, ống kính…)' : '(mô tả phong cách, màu, chất liệu…)'}<textarea id="settingConfig" rows="5">${esc(n.config || '')}</textarea></label>` +
      zoneSelect(n) +
      `<p class="field-hint">Đang áp cho: ${targets.length ? esc(targets.join(', ')) : 'chưa nối node nào'}</p>` +
      `<section class="inspector-section"><button class="button wide primary" id="saveSetting">Lưu</button>${id.startsWith('node-') ? '<button class="button wide danger" id="deleteNode">Xóa node này</button>' : ''}</section>`;
    $('.close').onclick = closeInspector;
    $('#saveSetting').onclick = async () => {
      try {
        state = await api('/api/node', {
          method: 'PATCH',
          body: {
            id,
            name: $('#settingName').value,
            config: $('#settingConfig').value,
            zone: $('#nodeZone').value,
          },
        });
        render();
        inspect(id);
        toast('Đã lưu');
      } catch (e) {
        toast(e.message, true);
      }
    };
    if ($('#deleteNode')) $('#deleteNode').onclick = () => deleteNode(id);
    lockInspectorIfBusy();
    return;
  }
  if (n.terminal) {
    const src = state.nodes.find(x => x.id === n.source);
    $('#inspector').innerHTML =
      `<div class="inspector-head"><h2>${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
      `<p class="field-hint">Phiên bản video${src ? ' từ node “' + esc(src.name) + '”' : ''}. Node này chỉ để xem/tải; tạo lại từ node nguồn.</p>` +
      (n.video
        ? `<video controls src="${esc(n.video.url)}" style="width:100%;border-radius:8px"></video><p class="field-hint">Tên file tải về: <code>${esc(downloadName(n))}</code></p><div class="actions"><a class="button" href="${esc(dlUrl(n.video.url, downloadName(n)))}" download="${esc(downloadName(n))}">↓ Tải video</a></div>`
        : '<p>Chưa có video.</p>') +
      `<section class="inspector-section"><button class="button wide danger" id="deleteNode">Xóa phiên bản này</button></section>`;
    $('.close').onclick = closeInspector;
    $('#deleteNode').onclick = () => deleteNode(id);
    lockInspectorIfBusy();
    return;
  }
  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div><div class="inspector-preview">${n.image ? `<img src="${esc(n.image.url)}" alt="Ảnh ${esc(n.name)}">` : 'Ảnh của node sẽ xuất hiện ở đây'}</div>${n.stale ? '<div class="note">Đầu vào đã đổi. Tạo lại ảnh hoặc tải ảnh đã duyệt trước khi làm video.</div>' : ''}<div class="two"><label>STT trong khu vực<input id="nodeSeq" type="number" min="1" value="${n.seq || ''}"></label><label>Tên node<input id="nodeName" value="${esc(n.name)}"></label></div><p class="field-hint">File tải về của node này: <code>${esc(downloadName({ ...n, terminal: false }, n.video ? 'video' : 'image'))}</code></p>${zoneSelect(n)}<div class="reference-chips">${n.references.map((r, i) => `<span>✓ ${esc(state.nodes.find(n => n.id === r.role)?.name || r.role)} <code>{{mv_input_${i + 1}_path}}</code></span>`).join('')}</div><label>Prompt ảnh <code class="variable-tag" title="Biến Orbit nhận khi chạy tác vụ tạo ảnh">{{prompt}}</code><textarea id="imagePrompt" rows="5">${esc(n.resolvedPrompts.image)}</textarea></label><p class="field-hint">Orbit nhận nội dung này qua <code>{{prompt}}</code> hoặc <code>{{mv_prompt}}</code> khi tạo ảnh. Khi tạo video, hai biến này chứa prompt video.</p><div class="prompt-tools"><button id="copyImage">Sao chép prompt</button><button id="resetPrompt">Dùng prompt kế thừa</button></div><div class="actions"><label class="button">↑ Tải ảnh<input type="file" id="imageUpload" accept="image/png,image/jpeg,image/webp" hidden></label><button class="button primary" id="generateImage">${generateLabel(n, 'image')}</button></div><p class="queue-hint">${n.providers.image.type === 'seedvis' ? 'Gửi prompt và ' + n.references.length + ' ảnh đầu vào tới Seedvis · ' + esc(n.providers.image.modelName) + '.' : 'Tác vụ sẽ mở nick và chạy kịch bản bằng phiên Orbit đã đăng nhập.'}</p>${shot ? `<section class="inspector-section"><h3>Video của shot</h3><label>Ảnh đầu vào cho video<select id="videoInput"><option value="self" ${!videoUsesRefs(n) ? 'selected' : ''}>Ảnh của node này (keyframe)</option><option value="refs" ${videoUsesRefs(n) ? 'selected' : ''}>Ảnh từ node nối vào (${n.references.length} ảnh)</option></select></label><p class="field-hint" id="videoInputHint">${esc(videoInputHint(n))}</p><div class="two"><label>Bắt đầu (giây) <code class="variable-tag">{{mv_start}}</code><input id="start" type="number" min="0" value="${n.start}"></label><label>Thời lượng (giây) <code class="variable-tag">{{mv_duration}}</code><input id="duration" type="number" min="1" value="${n.duration}"></label></div><label>Lời hát đúng đoạn này <span class="field-hint">Nhúng trong prompt video, không có biến riêng</span><textarea id="lyric" rows="2" placeholder="Để trống nếu chưa căn lời">${esc(n.lyric)}</textarea></label><details><summary>Prompt chuyển động <code class="variable-tag" title="Biến Orbit nhận khi chạy tác vụ tạo video">{{prompt}}</code></summary><label>Prompt video <code class="variable-tag">{{prompt}}</code><textarea id="videoPrompt" rows="5">${esc(n.resolvedPrompts.video)}</textarea></label><button id="copyVideo" class="button">Sao chép</button></details>${n.video ? `<video controls src="${esc(n.video.url)}" style="width:100%;margin-top:15px"></video>` : ''}${n.providers.video.type === 'seedvis' ? `<label>Số phiên bản<select id="videoCount"><option value="1">1 bản</option><option value="2">2 bản (tách node)</option><option value="3">3 bản (tách node)</option><option value="4">4 bản (tách node)</option></select></label><p class="field-hint">Từ 2 bản trở lên, mỗi bản thành một node video riêng.</p>` : ''}<div class="actions"><label class="button">↑ Tải video<input type="file" id="videoUpload" accept="video/mp4,video/webm" hidden></label><button class="button primary" id="generateVideo" ${videoReady(n) ? '' : 'disabled'}>${generateLabel(n, 'video')}</button></div><p class="muted">Keyframe: dùng chính ảnh của node. Node nối vào: dùng ảnh ban nhạc/bối cảnh đã nối. Khẩu hình cần model hỗ trợ audio/lip-sync.</p></section>` : ''}${providerSettings(n, shot)}${usesOrbit(n, shot) ? outputSettings(n, shot) + orbitSettings(n, shot) : '<details class="inspector-section"><summary>Cài đặt Orbit (chỉ cần khi chọn nguồn Orbit)</summary>' + outputSettings(n, shot) + orbitSettings(n, shot) + '</details>'}<section class="inspector-section"><button class="button wide" id="saveNode">Lưu chỉnh sửa</button>${id.startsWith('node-') ? '<button class="button wide danger" id="deleteNode">Xóa node này</button>' : ''}</section>`;
  $('.close').onclick = closeInspector;
  $('#nodeName').oninput = () => (dirty = true);
  document.querySelectorAll('[data-output-pattern]').forEach(
    e =>
      (e.oninput = () => {
        dirty = true;
        updateOutputPreview();
      }),
  );
  document
    .querySelectorAll('[data-orbit-select]')
    .forEach(e => (e.onchange = () => (dirty = true)));
  bindProviderSettings(n);
  if ($('#nodeSeq')) $('#nodeSeq').oninput = () => (dirty = true);
  if ($('#nodeZone')) $('#nodeZone').onchange = () => (dirty = true);
  $('#imagePrompt').oninput = () => (dirty = true);
  if (shot) {
    $('#lyric').oninput = () => (dirty = true);
    $('#start').oninput = () => (dirty = true);
    $('#duration').oninput = () => (dirty = true);
    $('#videoPrompt').oninput = () => (dirty = true);
    $('#videoInput').onchange = () => {
      dirty = true;
      const preview = { ...n, videoInput: $('#videoInput').value };
      $('#videoInputHint').textContent = videoInputHint(preview);
      $('#generateVideo').disabled = !videoReady(preview);
    };
    $('#videoUpload').onchange = e => upload(e.target.files[0], id, 'video');
    $('#copyVideo').onclick = () => copy($('#videoPrompt').value);
    $('#generateVideo').onclick = () => generate(id, 'video');
  }
  $('#imageUpload').onchange = e => upload(e.target.files[0], id, 'image');
  $('#copyImage').onclick = () => copy($('#imagePrompt').value);
  $('#resetPrompt').onclick = async () => {
    try {
      state = await api('/api/node', {
        method: 'PATCH',
        body: { id, prompt: '', videoPrompt: '' },
      });
      render();
      inspect(id);
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#saveNode').onclick = async () => {
    try {
      await saveNode();
      toast('Đã lưu');
      inspect(id);
    } catch (e) {
      toast(e.message, true);
    }
  };
  if ($('#deleteNode')) $('#deleteNode').onclick = () => deleteNode(id);
  $('#generateImage').onclick = () => generate(id, 'image');
  lockInspectorIfBusy();
}
async function saveNode() {
  if (!selected || !dirty) return;
  const n = state.nodes.find(n => n.id === selected),
    b = { id: selected };
  b.name = $('#nodeName').value;
  if ($('#nodeSeq') && Number($('#nodeSeq').value) && Number($('#nodeSeq').value) !== n.seq)
    b.seq = Number($('#nodeSeq').value);
  if ($('#nodeZone') && $('#nodeZone').value !== n.zone) b.zone = $('#nodeZone').value;
  b.outputNaming = {};
  document
    .querySelectorAll('[data-output-pattern]')
    .forEach(e => (b.outputNaming[e.dataset.outputPattern] = e.value));
  b.orbit = {};
  for (const kind of ['image', 'video']) {
    const script = document.querySelector('[data-orbit-script="' + kind + '"]'),
      profile = document.querySelector('[data-orbit-profile="' + kind + '"]');
    if (script && profile) {
      const value = script.value;
      const existing = n.orbit?.[kind];
      if (
        value !== (existing ? existing.type + ':' + existing.scriptId : '') ||
        profile.value !== (existing?.profileId || '')
      ) {
        if (!value && !profile.value) b.orbit[kind] = null;
        else {
          const split = value.indexOf(':');
          b.orbit[kind] = {
            type: value.slice(0, split),
            scriptId: value.slice(split + 1),
            profileId: profile.value,
          };
        }
      }
    }
  }
  const seedvis = readProviderSettings(n);
  if (Object.keys(seedvis).length) b.seedvis = seedvis;
  if ($('#imagePrompt').value !== n.resolvedPrompts.image) b.prompt = $('#imagePrompt').value;
  if ($('#lyric')) {
    b.lyric = $('#lyric').value;
    b.start = Number($('#start').value);
    b.duration = Number($('#duration').value);
    if ($('#videoInput').value !== n.videoInput) b.videoInput = $('#videoInput').value;
    if ($('#videoPrompt').value !== n.resolvedPrompts.video)
      b.videoPrompt = $('#videoPrompt').value;
  }
  state = await api('/api/node', { method: 'PATCH', body: b });
  dirty = false;
  render();
}
async function generate(id, kind) {
  try {
    await saveNode();
    const count = kind === 'video' && $('#videoCount') ? Number($('#videoCount').value) : 1;
    await api('/api/jobs', { method: 'POST', body: { nodeId: id, kind, count } });
    await refresh();
    toast(count > 1 ? 'Đã xếp ' + count + ' phiên bản vào hàng đợi' : 'Đã xếp vào hàng đợi');
    closeInspector();
    view('queue');
  } catch (e) {
    toast(e.message, true);
  }
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Đã sao chép');
  } catch {
    toast('Trình duyệt chưa cho phép sao chép. Chọn và copy nội dung prompt.', true);
  }
}
async function upload(file, nodeId, kind) {
  if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('File tối đa 100 MB');
    const base64 = await new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(r.result.split(',')[1]);
      r.onerror = no;
      r.readAsDataURL(file);
    });
    state = await api('/api/upload', {
      method: 'POST',
      body: { nodeId, kind, name: file.name, mime: file.type, base64 },
    });
    render();
    if (selected) inspect(selected);
    toast('Đã lưu file trên máy bạn');
  } catch (e) {
    toast(e.message, true);
  }
}
$('#audioUpload').onchange = e => upload(e.target.files[0], 'audio', 'audio');
$('#editBrief').onclick = () => {
  selected = 'brief';
  $('#overlay').hidden = false;
  $('#inspector').hidden = false;
  const labels = {
    identity: 'Nhân vật',
    wardrobe: 'Trang phục',
    instrument: 'Nhạc cụ',
    stage: 'Bối cảnh & bố trí',
    lighting: 'Ánh sáng',
    bpm: 'BPM đã xác nhận (tùy chọn)',
  };
  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>Định hướng chung</h2><button class="close" aria-label="Đóng">×</button></div><p>Mô tả được kế thừa vào các node. Thay đổi sẽ đánh dấu ảnh/video cũ cần cập nhật.</p>${Object.entries(
      labels,
    )
      .map(
        ([k, l]) =>
          `<label>${l}<textarea data-field="${k}" rows="${k === 'bpm' ? 1 : 3}">${esc(state.fields[k])}</textarea></label>`,
      )
      .join('')}<button id="saveBrief" class="button primary wide">Lưu định hướng</button>`;
  $('.close').onclick = closeInspector;
  $('#saveBrief').onclick = async () => {
    try {
      const fields = Object.fromEntries(
        [...document.querySelectorAll('[data-field]')].map(e => [e.dataset.field, e.value]),
      );
      state = await api('/api/project', { method: 'PATCH', body: { fields } });
      render();
      closeInspector();
      toast('Đã cập nhật prompt kế thừa');
    } catch (e) {
      toast(e.message, true);
    }
  };
};
$('#export').onclick = async () => {
  try {
    const b = await api('/api/export');
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'MV-Director-batch.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Đã xuất prompt và metadata');
  } catch (e) {
    toast(e.message, true);
  }
};
const kindsFor = shot => (shot ? ['image', 'video'] : ['image']);
const usesOrbit = (n, shot) => kindsFor(shot).some(kind => n.providers[kind].type === 'orbit');
function generateLabel(n, kind) {
  return (
    (kind === 'image' ? 'Tạo ảnh' : 'Tạo video') +
    (n.providers[kind].type === 'seedvis' ? ' · Seedvis' : ' qua Orbit')
  );
}
const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const videoUsesRefs = n => n.videoInput === 'refs';
// Once the node has composed its own image, that exact keyframe drives the video —
// the connected refs only seed it beforehand. Mirrors the server.
const videoFromRefs = n => videoUsesRefs(n) && !n.image;
// Video can run if its own image exists (keyframe) or, in refs mode, a connected
// parent node already has an image.
const videoReady = n => (videoFromRefs(n) ? n.references.length > 0 : !!n.image);
function videoInputHint(n) {
  if (!videoUsesRefs(n))
    return n.image
      ? 'Dùng ảnh đã duyệt của node này làm keyframe.'
      : 'Node này chưa có ảnh. Tạo hoặc tải ảnh trước, hoặc chuyển sang dùng ảnh node nối vào.';
  // refs mode
  if (n.image)
    return 'Node đã có ảnh — video dùng đúng ảnh này (keyframe), không gửi lại ảnh node nối vào.';
  return n.references.length
    ? `Chưa có ảnh của node — dùng ${n.references.length} ảnh của node nối vào làm input. Tạo ảnh của node này để video bám đúng ảnh đó.`
    : 'Chưa có node nào đã có ảnh nối vào. Nối một node đã có ảnh, hoặc tải ảnh lên node đó.';
}
function seedvisFields(n, kind, cur) {
  const models = state.seedvisCatalog[kind],
    m = models.find(x => x.id === cur.model) || models[0],
    available = seedvisStatus?.available;
  const options = (list, value, label = v => v) =>
    list
      .map(
        v => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(label(v))}</option>`,
      )
      .join('');
  const hint =
    kind === 'image'
      ? n.references.length
        ? `Ảnh → ảnh: gửi ${n.references.length} ảnh đầu vào (tối đa ${m.maxImages}).`
        : 'Chữ → ảnh: node chưa có ảnh đầu vào.'
      : `${videoFromRefs(n) ? `Ảnh → video từ ${n.references.length} ảnh node nối vào` + (m.maxImages ? ` (model này tối đa ${m.maxImages})` : '') : 'Ảnh → video từ keyframe (ảnh của chính node này)'}. Thời lượng gửi: ${m.durations ? nearest(m.durations, n.duration) + ' giây' : 'model tự quyết'} (shot ${n.duration} giây).`;
  return (
    `<label>Model<select data-sv-model="${kind}">${models
      .map(
        x =>
          `<option value="${esc(x.id)}" ${x.id === m.id ? 'selected' : ''}>${esc(x.name)}${available && !available.includes(x.id) ? ' (tài khoản chưa dùng được)' : ''}</option>`,
      )
      .join('')}</select></label>` +
    `<div class="two"><label>Tỉ lệ khung<select data-sv-aspect="${kind}">${options(m.aspect, cur.aspectRatio)}</select></label>` +
    (m.upscale.length
      ? `<label>Upscale<select data-sv-upscale="${kind}">${options(m.upscale, cur.upscale, v => (v === 'none' ? 'Không' : v))}</select></label>`
      : '') +
    `</div><p class="field-hint">${esc(hint)}</p>` +
    (m.note ? `<p class="note">${esc(m.note)}</p>` : '')
  );
}
function providerSettings(n, shot) {
  return (
    '<section class="inspector-section"><h3>Nguồn tạo</h3>' +
    (state.seedvisConfigured
      ? ''
      : '<p class="note">Chưa có API key Seedvis. Nhập key trong Kết nối web.</p>') +
    kindsFor(shot)
      .map(kind => {
        const cur = n.providers[kind],
          sv = cur.type === 'seedvis' ? cur : { ...state.seedvisDefaults[kind] };
        return `<h4>${kind === 'image' ? 'Tạo ảnh' : 'Tạo video'}</h4><label>Dùng<select data-provider="${kind}"><option value="seedvis" ${cur.type === 'seedvis' ? 'selected' : ''}>Seedvis API</option><option value="orbit" ${cur.type === 'orbit' ? 'selected' : ''}>Orbit (kịch bản web)</option></select></label><div data-seedvis-fields="${kind}" ${cur.type === 'seedvis' ? '' : 'hidden'}>${seedvisFields(n, kind, sv)}</div>`;
      })
      .join('') +
    '</section>'
  );
}
function bindProviderSettings(n) {
  const bindFields = kind => {
    const box = document.querySelector(`[data-seedvis-fields="${kind}"]`);
    box.querySelectorAll('select').forEach(e => (e.onchange = () => (dirty = true)));
    box.querySelector('[data-sv-model]').onchange = e => {
      dirty = true;
      const aspect = box.querySelector('[data-sv-aspect]')?.value,
        upscale = box.querySelector('[data-sv-upscale]')?.value;
      box.innerHTML = seedvisFields(n, kind, {
        model: e.target.value,
        aspectRatio: aspect,
        upscale,
      });
      bindFields(kind);
    };
  };
  document.querySelectorAll('[data-provider]').forEach(select => {
    const kind = select.dataset.provider;
    select.onchange = () => {
      dirty = true;
      document.querySelector(`[data-seedvis-fields="${kind}"]`).hidden = select.value !== 'seedvis';
    };
    bindFields(kind);
  });
}
// Only the kinds whose provider or Seedvis options changed are sent.
function readProviderSettings(n) {
  const out = {};
  document.querySelectorAll('[data-provider]').forEach(select => {
    const kind = select.dataset.provider,
      cur = n.providers[kind];
    if (select.value === 'orbit') {
      if (cur.type !== 'orbit') out[kind] = false;
      return;
    }
    const next = {
      model: document.querySelector(`[data-sv-model="${kind}"]`).value,
      aspectRatio: document.querySelector(`[data-sv-aspect="${kind}"]`).value,
      upscale: document.querySelector(`[data-sv-upscale="${kind}"]`)?.value || null,
    };
    if (
      cur.type !== 'seedvis' ||
      cur.model !== next.model ||
      cur.aspectRatio !== next.aspectRatio ||
      (cur.upscale || null) !== next.upscale
    )
      out[kind] = next;
  });
  return out;
}
function showSeedvis(o) {
  seedvisStatus = o;
  $('#seedvisStatus').textContent = o.configured
    ? [
        o.message,
        'key ' + o.keyHint,
        o.account?.plan ? 'gói ' + o.account.plan : '',
        o.account?.balance != null ? 'số dư ' + o.account.balance : '',
        o.source === 'env' ? 'lấy từ biến môi trường SEEDVIS_API_KEY' : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : o.message;
  $('#seedvisKey').placeholder = o.configured ? 'Dán key mới để thay' : 'Dán API key Seedvis';
  $('#removeSeedvis').hidden = !o.configured || o.source === 'env';
}
async function refreshSeedvis() {
  showSeedvis(await api('/api/seedvis'));
}
$('#testSeedvis').onclick = () => refreshSeedvis().catch(e => toast(e.message, true));
$('#seedvisKeyForm').onsubmit = async e => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    showSeedvis(
      await api('/api/seedvis/key', { method: 'POST', body: { key: $('#seedvisKey').value } }),
    );
    await refresh();
    toast(
      seedvisStatus.error ? seedvisStatus.message : 'Đã lưu API key Seedvis',
      seedvisStatus.error,
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#seedvisKey').value = '';
    button.disabled = false;
  }
};
$('#removeSeedvis').onclick = async () => {
  if (!confirm('Xóa API key Seedvis khỏi máy này?')) return;
  try {
    showSeedvis(await api('/api/seedvis/key', { method: 'POST', body: { key: null } }));
    await refresh();
    toast('Đã xóa API key Seedvis');
  } catch (e) {
    toast(e.message, true);
  }
};
refreshSeedvis().catch(() => {});
async function refresh() {
  state = await api('/api/state');
  render();
}
try {
  await refresh();
} catch (e) {
  // Don't leave a blank page: show what went wrong and how to recover.
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div style="position:fixed;inset:0;z-index:9999;background:#1a1410;color:#fde68a;padding:24px;font:14px system-ui;overflow:auto">' +
      '<h2 style="color:#fbbf24">Không tải được dữ liệu</h2>' +
      '<p>' +
      esc(e.message) +
      '</p><p>Thử: nhấn <b>Ctrl+F5</b> để tải lại. Nếu vẫn lỗi, chụp màn hình cửa sổ chạy server (dòng “Lỗi xử lý …”) để được hỗ trợ.</p>' +
      '<button onclick="location.reload()" style="padding:8px 16px;margin-top:8px;cursor:pointer">Tải lại</button>' +
      '</div>',
  );
}
setInterval(() => refresh().catch(() => {}), 4000);

function showOrbit(o) {
  orbitStatus = o;
  $('#orbitStatus').textContent = o.message;
  $('#orbitInventory').textContent = o.authenticated
    ? o.profiles.length +
      ' nick · ' +
      (o.apps || []).length +
      ' App · ' +
      o.workflows.length +
      ' kịch bản · ' +
      o.flows.length +
      ' khối'
    : '';
  $('#orbitLogin').hidden = !!o.authenticated;
  $('#logoutOrbit').hidden = !o.authenticated;
  $('#workerBadge').textContent = state.worker?.online
    ? '● Worker đang nối'
    : o.authenticated
      ? '● Orbit: ' + o.user.email
      : '◐ Đăng nhập Orbit';
}
async function refreshOrbit() {
  const o = await api('/api/orbit');
  showOrbit(o);
}
$('#testOrbit').onclick = () => refreshOrbit().catch(e => toast(e.message, true));
$('#orbitLogin').onsubmit = async e => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/orbit/login', {
      method: 'POST',
      body: { email: $('#orbitEmail').value, password: $('#orbitPassword').value },
    });
    await refreshOrbit();
    toast('Đã đăng nhập. Mở node để chọn kịch bản và nick.');
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('#orbitPassword').value = '';
    button.disabled = false;
  }
};
$('#logoutOrbit').onclick = async () => {
  try {
    await api('/api/orbit/logout', { method: 'POST', body: {} });
    await refreshOrbit();
    toast('Đã đăng xuất Orbit');
  } catch (e) {
    toast(e.message, true);
  }
};
function orbitSettings(n, shot) {
  const c = orbitStatus;
  if (!c?.authenticated)
    return '<section class="inspector-section"><h3>Cài đặt Orbit</h3><p>Đăng nhập trong Kết nối web để chọn kịch bản và nick chạy.</p></section>';
  const scripts = [
    ...(c.apps || []).map(s => ({ ...s, type: 'app', label: 'App' })),
    ...c.workflows.map(s => ({ ...s, type: 'workflow', label: 'Kịch bản' })),
    ...c.flows.map(s => ({ ...s, type: 'flow', label: 'Khối' })),
  ];
  return (
    '<section class="inspector-section"><h3>Cài đặt Orbit</h3><p>Chọn App / kịch bản và nick cho từng loại tác vụ. App cần công khai các biến prompt, mv_prompt… trong public params.</p>' +
    (shot ? ['image', 'video'] : ['image'])
      .map(kind => {
        const saved = n.orbit?.[kind],
          value = saved ? saved.type + ':' + saved.scriptId : '';
        return (
          '<h4>' +
          (kind === 'image' ? 'Tạo ảnh' : 'Tạo video') +
          '</h4><label>Kịch bản<select data-orbit-select data-orbit-script="' +
          kind +
          '"><option value="">Chọn kịch bản…</option>' +
          (!value || scripts.some(s => s.type + ':' + s.id === value)
            ? ''
            : '<option selected value="' +
              esc(value) +
              '">Không còn quyền truy cập — chọn lại</option>') +
          scripts
            .map(
              s =>
                '<option value="' +
                esc(s.type + ':' + s.id) +
                '" ' +
                (value === s.type + ':' + s.id ? 'selected' : '') +
                '>' +
                esc(s.label + ' · ' + s.name) +
                '</option>',
            )
            .join('') +
          '</select></label><label>Nick chạy<select data-orbit-select data-orbit-profile="' +
          kind +
          '"><option value="">Chọn nick…</option>' +
          (!saved?.profileId || c.profiles.some(p => p.id === saved.profileId)
            ? ''
            : '<option selected value="' +
              esc(saved.profileId) +
              '">Nick không còn quyền truy cập — chọn lại</option>') +
          c.profiles
            .map(
              p =>
                '<option value="' +
                esc(p.id) +
                '" ' +
                (p.id === saved?.profileId ? 'selected' : '') +
                '>' +
                esc(p.name) +
                '</option>',
            )
            .join('') +
          '</select></label>'
        );
      })
      .join('') +
    '<p class="muted">Lựa chọn được lưu theo node và đính kèm từng job. Tự mở nick và chạy kịch bản đã chọn. Ảnh đầu vào được truyền bằng mv_input_1_path, mv_input_2_path… Kịch bản cần upload chúng; lưu kết quả tới mv_output_path.</p></section>'
  );
}
await refreshOrbit();

function outputSettings(n, shot) {
  return (
    '<section class="inspector-section"><h3>File đầu ra</h3><p class="field-hint">Thư mục trên máy Orbit: ' +
    esc(state.outputDirectory) +
    '</p>' +
    (shot ? ['image', 'video'] : ['image'])
      .map(
        kind =>
          '<label>Tên file ' +
          (kind === 'image' ? 'ảnh' : 'video') +
          ' <code class="variable-tag">{{mv_output_filename}}</code><input data-output-pattern="' +
          kind +
          '" value="' +
          esc(
            n.outputNaming?.[kind] ||
              (kind === 'image' ? '{node_id}_{job_id}.png' : '{node_id}_{job_id}.mp4'),
          ) +
          '"></label><p class="field-hint" data-output-preview="' +
          kind +
          '">Ví dụ: ' +
          esc(
            (
              n.outputNaming?.[kind] ||
              (kind === 'image' ? '{node_id}_{job_id}.png' : '{node_id}_{job_id}.mp4')
            )
              .replaceAll('{node_id}', n.id)
              .replaceAll('{job_id}', 'JOB-ID')
              .replaceAll('{kind}', kind),
          ) +
          '</p>',
      )
      .join('') +
    '<p class="field-hint">Mẫu dùng {node_id}, {kind}, {job_id}. Kịch bản lưu tới <code>{{mv_output_path}}</code>. Đuôi file phải đúng định dạng tải về. App cần công khai các biến đầu ra này. Tự nhận file từ đường dẫn đầu ra khi kịch bản xong.</p></section>'
  );
}
function updateOutputPreview() {
  document.querySelectorAll('[data-output-pattern]').forEach(e => {
    document.querySelector('[data-output-preview="' + e.dataset.outputPattern + '"]').textContent =
      'Ví dụ: ' +
      e.value
        .replaceAll('{node_id}', selected)
        .replaceAll('{job_id}', 'JOB-ID')
        .replaceAll('{kind}', e.dataset.outputPattern);
  });
}
$('#projectSettings').onclick = () => {
  selected = null;
  $('#overlay').hidden = false;
  $('#inspector').hidden = false;
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>Cài đặt project</h2><button class="close" aria-label="Đóng">×</button></div><label>Tên project<input id="projectTitle" value="' +
    esc(state.name) +
    '"></label><label>Chủ đề<select id="projectTheme">' +
    (state.themes || [])
      .map(
        t =>
          `<option value="${t.id}" ${t.id === state.theme ? 'selected' : ''}>${esc(t.label)}</option>`,
      )
      .join('') +
    '</select></label><p class="field-hint">Đổi chủ đề chỉ đổi nhãn phân loại; không dựng lại node. Dùng Project mới để lấy bộ node mẫu của chủ đề khác.</p>' +
    '<label>📁 Thư mục lưu ảnh/video của project<input id="exportDir" placeholder="Để trống = lưu trong thư mục mặc định của project" value="' +
    esc(state.exportDir || '') +
    '"></label><p class="field-hint">Đường dẫn tuyệt đối trên máy chạy tool (vd <code>D:\\MV\\Ashford</code>). Ảnh/video tạo ra được lưu thành các thư mục con: <code>thu-vien/nhan-vat</code>, <code>thu-vien/boi-canh</code>, <code>khung-hinh/&lt;seq&gt;</code>, <code>video/&lt;seq&gt;</code>. Để trống thì lưu trong thư mục mặc định của project.</p>' +
    '<label>Thư mục lưu trên máy chạy Orbit <code class="variable-tag">{{mv_output_dir}}</code><input id="outputDirectory" value="' +
    esc(state.outputDirectory) +
    '"></label><p class="field-hint">Nhập đường dẫn tuyệt đối. Thư mục phải truy cập được bằng cùng đường dẫn từ MV Director và Orbit (cùng máy hoặc thư mục mạng dùng chung).</p><p>Đường dẫn đầy đủ gửi sang Orbit: <code>{{mv_output_path}}</code></p><button class="button primary wide" id="saveProjectSettings">Lưu cài đặt</button><button class="button wide danger" id="deleteProject">🗑 Xóa project này</button>';
  $('.close').onclick = closeInspector;
  $('#saveProjectSettings').onclick = async () => {
    try {
      state = await api('/api/project', {
        method: 'PATCH',
        body: {
          name: $('#projectTitle').value,
          theme: $('#projectTheme').value,
          outputDirectory: $('#outputDirectory').value,
          exportDir: $('#exportDir').value.trim(),
        },
      });
      render();
      closeInspector();
      toast('Đã lưu cài đặt project');
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#deleteProject').onclick = async () => {
    if (
      !confirm(
        'Xóa project "' + state.name + '" cùng toàn bộ video/ảnh của nó? Không hoàn tác được.',
      )
    )
      return;
    try {
      state = await api('/api/projects/delete', {
        method: 'POST',
        body: { id: state.activeProjectId },
      });
      gallerySel.clear();
      closeInspector();
      render();
      toast('Đã xóa project');
    } catch (e) {
      toast(e.message, true);
    }
  };
};

function renderGraph() {
  if (gesture) return;
  const positions = {};
  const defaults = zoneLayout();
  for (const n of state.nodes) positions[n.id] = savedPositions[n.id] || defaults[n.id];
  const w = Math.max(3 * ZONE_W + 40, ...Object.values(positions).map(p => p.x + 280)),
    h = Math.max(520, ...Object.values(positions).map(p => p.y + 265));
  if (selectedEdge && !state.edges.some(e => e.source + '>' + e.target === selectedEdge))
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
  $('#graphCanvas').style.width = w + 'px';
  $('#graphCanvas').style.height = h + 'px';
  $('#graphCanvas').innerHTML =
    bands +
    '<svg width="' +
    w +
    '" height="' +
    h +
    '" class="wires">' +
    lines +
    '</svg>' +
    wireDeleteButton(positions) +
    state.nodes
      .map(n => {
        const p = positions[n.id];
        return (
          '<div class="graph-node" data-graph-id="' +
          n.id +
          '" style="left:' +
          p.x +
          'px;top:' +
          p.y +
          'px">' +
          card(n) +
          '<div class="ports"><button class="port" data-port-in="' +
          n.id +
          '">● Vào (' +
          state.edges.filter(e => e.target === n.id).length +
          ')</button><button class="port ' +
          (connectSource === n.id ? 'selected' : '') +
          '" data-port-out="' +
          n.id +
          '">Ra ●</button></div></div>'
        );
      })
      .join('');
  $('#edgeList').innerHTML = state.edges
    .map(
      (e, i) =>
        '<button class="button" data-remove-edge="' +
        i +
        '" title="Bỏ đường nối">' +
        esc(state.nodes.find(n => n.id === e.source).name) +
        ' → ' +
        esc(state.nodes.find(n => n.id === e.target).name) +
        ' ×</button>',
    )
    .join('');
  const previous = $('#autoTarget').value;
  $('#autoTarget').innerHTML =
    '<option value="">Toàn bộ workflow</option>' +
    state.nodes.map(n => '<option value="' + n.id + '">Đến: ' + esc(n.name) + '</option>').join('');
  $('#autoTarget').value = previous;
  const run = state.autoRun;
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
  $('#autoStart').disabled = run?.status === 'running';
  $('#autoStop').disabled = run?.status !== 'running';
  // Per-zone quick image batch status.
  const ir = state.autoImageRun;
  const zoneLabel = { character: 'Nhân vật', design: 'Bối cảnh', production: 'Khung hình shot' };
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
  const otherBusy = run?.status === 'running' || state.autoVideoRun?.status === 'running';
  $('#autoImageStart').disabled = otherBusy || ir?.status === 'running';
  const vr = state.autoVideoRun;
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
  $('#autoVideoStop').disabled = vr?.status !== 'running';
  // Offer a one-click retry whenever some video jobs failed.
  const failedVideos = state.jobs.filter(j => j.kind === 'video' && j.status === 'failed').length;
  const retryBtn = $('#autoVideoRetry');
  if (retryBtn) {
    retryBtn.hidden = failedVideos === 0;
    retryBtn.textContent = '↻ Chạy lại ' + failedVideos + ' video lỗi';
    retryBtn.disabled = workflowBusy();
  }
  // Offer "create missing videos" for ready production nodes that have no video yet (not failed).
  const failedVideoIds = new Set(
    state.jobs.filter(j => j.kind === 'video' && j.status === 'failed').map(j => j.nodeId),
  );
  const hasVideoFor = n =>
    n.video || state.nodes.some(t => t.terminal && t.source === n.id && t.video);
  const missing = state.nodes.filter(
    n =>
      !n.terminal &&
      n.kind !== 'setting' &&
      n.zone === 'production' &&
      n.providers?.video?.type === 'seedvis' &&
      videoReady(n) &&
      !hasVideoFor(n) &&
      !failedVideoIds.has(n.id),
  ).length;
  const missBtn = $('#autoVideoMissing');
  if (missBtn) {
    missBtn.hidden = missing === 0;
    missBtn.textContent = '✚ Tạo ' + missing + ' video còn thiếu';
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
          state = await api('/api/edges', {
            method: 'PUT',
            body: { edges: [...state.edges, { source: connectSource, target: e.dataset.portIn }] },
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
  document.querySelectorAll('[data-remove-edge]').forEach(
    e =>
      (e.onclick = async () => {
        try {
          state = await api('/api/edges', {
            method: 'PUT',
            body: { edges: state.edges.filter((_, i) => i !== Number(e.dataset.removeEdge)) },
          });
          render();
        } catch (err) {
          toast(err.message, true);
        }
      }),
  );
}
async function deleteNode(id) {
  if (!confirm('Xóa node này?')) return;
  try {
    state = await api('/api/nodes/delete', { method: 'POST', body: { id } });
    closeInspector();
    render();
    toast('Đã xóa node');
  } catch (e) {
    toast(e.message, true);
  }
}
async function deleteEdge(key) {
  if (workflowBusy()) return toast('Đợi hàng đợi chạy xong trước khi sửa dây nối.', true);
  try {
    state = await api('/api/edges', {
      method: 'PUT',
      body: { edges: state.edges.filter(e => e.source + '>' + e.target !== key) },
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
$('#addNode').onclick = async () => {
  try {
    state = await api('/api/nodes', {
      method: 'POST',
      body: { name: 'Ảnh mới ' + (state.nodes.length + 1) },
    });
    render();
    inspect(state.nodes.at(-1).id);
  } catch (e) {
    toast(e.message, true);
  }
};
async function addSetting(settingType) {
  try {
    state = await api('/api/nodes', { method: 'POST', body: { kind: 'setting', settingType } });
    render();
    inspect(state.nodes.at(-1).id);
  } catch (e) {
    toast(e.message, true);
  }
}
$('#addStyle').onclick = () => addSetting('style');
$('#addCamera').onclick = () => addSetting('camera');
// --- Đạo diễn: master prompt + build graph from blueprint + LLM auto ---
let directorLoaded = false;
let defaultMaster = '';
function showMasterBadge(custom) {
  $('#masterBadge').textContent = custom
    ? '· đã sửa riêng cho project này'
    : '· đang dùng mặc định';
}
async function loadDirector() {
  try {
    const d = await api('/api/director');
    $('#masterPrompt').value = d.masterPrompt;
    defaultMaster = d.defaultMaster || '';
    showMasterBadge(d.customMaster);
    showDirectorLLM(d.llm);
    directorLoaded = true;
  } catch (e) {
    toast(e.message, true);
  }
}
function showDirectorLLM(llm) {
  $('#directorLLMStatus').textContent = llm.configured
    ? 'Đã cấu hình · ' + llm.model + ' · key ' + llm.keyHint + ' · ' + llm.baseUrl
    : 'Chưa cấu hình API key.';
  if (!$('#llmBaseUrl').value) $('#llmBaseUrl').value = llm.baseUrl || '';
  if (!$('#llmModel').value) $('#llmModel').value = llm.model || '';
}
$('#copyMaster').onclick = () => copy($('#masterPrompt').value);
$('#saveMaster').onclick = async () => {
  try {
    const r = await api('/api/director/master', {
      method: 'POST',
      body: { masterPrompt: $('#masterPrompt').value },
    });
    $('#masterPrompt').value = r.masterPrompt;
    showMasterBadge(r.customMaster);
    toast('Đã lưu master prompt cho project này');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#resetMaster').onclick = async () => {
  if (!confirm('Khôi phục master prompt mặc định cho project này?')) return;
  try {
    const r = await api('/api/director/master', { method: 'POST', body: { masterPrompt: '' } });
    $('#masterPrompt').value = r.masterPrompt;
    showMasterBadge(r.customMaster);
    toast('Đã dùng lại master prompt mặc định');
  } catch (e) {
    toast(e.message, true);
  }
};
async function buildFromBlueprint(blueprint) {
  if (!confirm('Dựng sơ đồ sẽ THAY TOÀN BỘ node của project đang mở. Tiếp tục?')) return;
  const btn = $('#buildGraph');
  btn.disabled = true;
  try {
    state = await api('/api/director/build', { method: 'POST', body: { blueprint } });
    gallerySel.clear();
    view('studio');
    render();
    $('#arrangeZones').onclick();
    toast(
      'Đã dựng sơ đồ' +
        (state.graphReused
          ? ' · tái dùng ' + state.graphReused + ' ảnh nhân vật/bối cảnh có sẵn'
          : ''),
    );
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}
$('#buildGraph').onclick = () => {
  const bp = $('#blueprintInput').value.trim();
  if (!bp) return toast('Dán blueprint JSON hoặc chọn file trước', true);
  buildFromBlueprint(bp);
};
// Pick one or more .json files (feature mode: bible.json + seq-XX.json) and build from them.
$('#blueprintFiles').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  try {
    const parts = [];
    for (const f of files) parts.push(JSON.parse(await f.text()));
    await buildFromBlueprint(parts);
  } catch (err) {
    toast('File JSON không hợp lệ: ' + err.message, true);
  }
};
$('#saveLLM').onclick = async () => {
  try {
    const r = await api('/api/director/llm', {
      method: 'POST',
      body: {
        baseUrl: $('#llmBaseUrl').value,
        model: $('#llmModel').value,
        key: $('#llmKey').value,
      },
    });
    $('#llmKey').value = '';
    showDirectorLLM(r.llm);
    toast('Đã lưu cấu hình LLM');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#runAuto').onclick = async () => {
  const song = $('#directorSong').value.trim();
  if (!song) return toast('Nhập bài hát / lời để chạy', true);
  if (
    !confirm('Chạy LLM rồi dựng sơ đồ (thay toàn bộ node project đang mở)? Có thể mất 30–120 giây.')
  )
    return;
  const btn = $('#runAuto');
  btn.disabled = true;
  btn.textContent = '⏳ Đang chạy LLM…';
  try {
    state = await api('/api/director/auto', { method: 'POST', body: { song } });
    gallerySel.clear();
    view('studio');
    render();
    $('#arrangeZones').onclick();
    toast('Đã dựng sơ đồ tự động');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Chạy tự động & dựng';
  }
};
$('#fullscreenToggle').onclick = () => {
  const full = $('#graphArea').classList.toggle('full');
  $('#fullscreenToggle').textContent = full ? '⤢ Thu nhỏ' : '⛶ Toàn màn hình';
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#graphArea').classList.contains('full') && $('#inspector').hidden) {
    $('#graphArea').classList.remove('full');
    $('#fullscreenToggle').textContent = '⛶ Toàn màn hình';
  }
});
$('#autoStart').onclick = async () => {
  try {
    state = await api('/api/auto/start', {
      method: 'POST',
      body: { target: $('#autoTarget').value },
    });
    render();
    toast('Đã bắt đầu chuỗi tự động');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoImageStart').onclick = async () => {
  try {
    state = await api('/api/auto/images/start', {
      method: 'POST',
      body: { zone: $('#imageZone').value },
    });
    render();
    toast('Đang tạo ảnh đồng loạt cho khu vực đã chọn');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoStop').onclick = async () => {
  try {
    state = await api('/api/auto/stop', { method: 'POST', body: {} });
    render();
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoStart').onclick = async () => {
  try {
    state = await api('/api/auto/video/start', {
      method: 'POST',
      body: { target: $('#autoTarget').value, versions: Number($('#videoVersions').value) },
    });
    render();
    toast('Đã bắt đầu tạo video tự động');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoStop').onclick = async () => {
  try {
    state = await api('/api/auto/video/stop', { method: 'POST', body: {} });
    render();
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoRetry').onclick = async () => {
  try {
    state = await api('/api/auto/video/retry', {
      method: 'POST',
      body: { versions: Number($('#videoVersions').value) },
    });
    render();
    toast('Đang chạy lại các video lỗi');
  } catch (e) {
    toast(e.message, true);
  }
};
const missingBtn = $('#autoVideoMissing');
if (missingBtn)
  missingBtn.onclick = async () => {
    try {
      state = await api('/api/auto/video/missing', {
        method: 'POST',
        body: { versions: Number($('#videoVersions').value) },
      });
      render();
      toast('Đang tạo các video còn thiếu');
    } catch (e) {
      toast(e.message, true);
    }
  };

function persistCanvas() {
  try {
    localStorage.setItem(
      'mv-canvas-v1',
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
  return [
    { x: a.x + 235, y: a.y + 110 },
    { x: b.x, y: b.y + 110 },
  ];
}
// Each wire has a wide transparent twin so it is easy to click.
function wiresMarkup(pos) {
  return state.edges
    .map(e => {
      const key = e.source + '>' + e.target,
        d = edgePath(...wireEnds(e, pos));
      return (
        '<path class="wire-hit" data-edge="' +
        key +
        '" d="' +
        d +
        '"><title>Bấm để chọn dây, rồi bấm × hoặc Delete để xóa</title></path><path class="wire' +
        (selectedEdge === key ? ' selected' : '') +
        '" d="' +
        d +
        '"/>'
      );
    })
    .join('');
}
function wireDeleteButton(pos) {
  const e = state.edges.find(e => e.source + '>' + e.target === selectedEdge);
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
$('#arrangeZones').onclick = () => {
  const layout = zoneLayout();
  for (const id of Object.keys(savedPositions)) delete savedPositions[id];
  Object.assign(savedPositions, layout);
  persistCanvas();
  render();
  $('#fitCanvas').onclick();
  toast('Đã xếp node vào 3 khu vực theo thứ tự');
};
$('#fitCanvas').onclick = () => {
  const ps = Object.keys(savedPositions).length
    ? Object.values(savedPositions)
    : Object.values(zoneLayout());
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
  const wire = !port && !node ? e.target.closest('[data-edge]') : null;
  if (workflowBusy()) {
    // Read-only while running: allow pan/zoom and node click (to view), block wiring + drag.
    if (port || (node && e.target.closest('.node-top'))) return;
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
    gesture = { type: 'node', id, start: { ...savedPositions[id] } };
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
    const p = { x: gesture.start.x + dx / graphView.z, y: gesture.start.y + dy / graphView.z };
    savedPositions[gesture.id] = p;
    const el = document.querySelector('[data-graph-id="' + gesture.id + '"]');
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    repaintWires();
  } else if (gesture.type === 'pan') {
    graphView.x = gesture.start.x + dx;
    graphView.y = gesture.start.y + dy;
    applyGraphView();
  } else {
    repaintWires(worldPoint(e.clientX, e.clientY));
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
  viewport.releasePointerCapture(e.pointerId);
  suppressNodeClick = g.moved;
  setTimeout(() => (suppressNodeClick = false), 150);
  document.querySelectorAll('.hover-target').forEach(el => el.classList.remove('hover-target'));
  if (cancel && g.type === 'node') savedPositions[g.id] = g.start;
  if (cancel && g.type === 'pan') Object.assign(graphView, g.start);
  // A click (no drag) on a wire selects it; a click on empty canvas clears the selection.
  if (!cancel && !g.moved && g.type === 'pan') selectedEdge = g.wire || null;
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
        state = await api('/api/edges', { method: 'PUT', body: { edges: [...state.edges, edge] } });
        connectSource = null;
        toast('Đã nối node');
      } catch (err) {
        toast(err.message, true);
      }
    }
  }
  // Dropping a node into a different zone band reassigns its zone.
  if (!cancel && g.moved && g.type === 'node') {
    const node = state.nodes?.find(n => n.id === g.id);
    const pos = savedPositions[g.id];
    if (node && pos && !node.terminal) {
      const zi = Math.max(0, Math.min(ZONES.length - 1, Math.floor((pos.x + 117) / ZONE_W)));
      const newZone = ZONES[zi].id;
      if (newZone !== 'output' && newZone !== node.zone) {
        try {
          state = await api('/api/node', { method: 'PATCH', body: { id: g.id, zone: newZone } });
          toast('Chuyển sang ' + ZONES[zi].label);
        } catch (err) {
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
