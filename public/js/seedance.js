// Seedance groups: several shots filmed in one Seedance render. "🧩 Chia nhóm Seedance" splits
// the shots into groups; a group's inspector shows its timeline and the images it sends,
// composes its storyboard sheet from the shots' keyframes (on a canvas, in the browser) and
// starts the render.
import { store } from './store.js';
import { $, api, copy, esc, toast } from './core.js';
import { closeInspector, deleteNode, lockInspectorIfBusy, videoResults } from './inspector.js';
import { refresh, render, view } from './render.js';

const PANEL_W = 640,
  PANEL_H = 360,
  GAP = 16;

// Columns × rows for `count` 16:9 panels: as close to a 16:9 sheet as possible, never wider
// than 2.5 : 1 nor taller than 1 : 2.5 (the shape Seedance accepts for a reference image).
function grid(count) {
  let best = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const ratio = (cols * PANEL_W) / (rows * PANEL_H);
    if (ratio < 0.4 || ratio > 2.5) continue;
    const score = Math.abs(Math.log(ratio / (16 / 9))) + 0.05 * (cols * rows - count);
    if (!best || score < best.score) best = { cols, rows, score };
  }
  return best || { cols: 1, rows: count };
}
const loadImage = url =>
  new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error('Không tải được ảnh ' + url));
    img.src = url;
  });

// The storyboard sheet: the shots' keyframes in timeline order, numbered 1…N like the prompt's
// "Shot 1…N", and nothing else written on it — captions make Seedance mix up the characters.
export async function composeStoryboard(g) {
  const members = g.seedance?.members || [];
  if (!members.length) throw new Error('Nhóm chưa có shot nào.');
  const notReady = members.find(m => !m.ready);
  if (notReady)
    throw new Error(`Shot "${notReady.name}" chưa có ảnh hoặc ảnh đã cũ. Tạo ảnh shot trước.`);
  const { cols, rows } = grid(members.length);
  const canvas = document.createElement('canvas');
  canvas.width = cols * PANEL_W + (cols + 1) * GAP;
  canvas.height = rows * PANEL_H + (rows + 1) * GAP;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const images = await Promise.all(members.map(m => loadImage(m.image)));
  images.forEach((img, i) => {
    const x = GAP + (i % cols) * (PANEL_W + GAP),
      y = GAP + Math.floor(i / cols) * (PANEL_H + GAP);
    ctx.fillStyle = '#000000';
    ctx.fillRect(x, y, PANEL_W, PANEL_H);
    // the whole keyframe, letterboxed if it is not 16:9
    const s = Math.min(PANEL_W / img.width, PANEL_H / img.height);
    const w = img.width * s,
      h = img.height * s;
    ctx.drawImage(img, x + (PANEL_W - w) / 2, y + (PANEL_H - h) / 2, w, h);
    // the panel number, small, in the corner
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(x + 8, y + 8, 40, 34);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x + 28, y + 26);
  });
  const blob = await new Promise(ok => canvas.toBlob(ok, 'image/jpeg', 0.9));
  // sent straight to the server so a refusal (e.g. the queue is running) reaches the caller
  const base64 = await new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = no;
    r.readAsDataURL(blob);
  });
  store.state = await api('/api/upload', {
    method: 'POST',
    body: { nodeId: g.id, kind: 'image', name: 'storyboard.jpg', mime: 'image/jpeg', base64 },
  });
  render();
}

// The group inspector (inspect() hands a group over to it).
export function inspectGroup(n) {
  const id = n.id,
    info = n.seedance;
  const shots = info.members
    .map(
      m =>
        `<li>${m.ready ? '' : '⚠ '}<b>Shot ${m.k}</b> · ${esc(m.name)} <span class="field-hint">${m.from}–${m.to} giây</span></li>`,
    )
    .join('');
  const tail = info.D - info.total;
  const length =
    info.total > info.max
      ? `⚠ Dài ${info.total} giây, quá ${info.max} giây của model.`
      : `Tổng ${info.total} giây → gửi ${info.D} giây${tail ? ` (${tail} giây cuối giữ khung để cắt)` : ''}.`;
  const refs = ['[1] Storyboard', ...info.refs.map((r, i) => `[${i + 2}] ${esc(r.name)}`)].join(
    ' · ',
  );
  const models = info.models
    .map(
      m =>
        `<option value="${m.id}" ${m.id === info.model ? 'selected' : ''}>${esc(m.name)} (tới ${m.max} giây)</option>`,
    )
    .join('');
  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>🧩 ${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
    `<div class="inspector-preview">${n.image ? `<img src="${esc(n.image.url)}" alt="Storyboard ${esc(n.name)}">` : 'Storyboard sẽ hiện ở đây'}</div>` +
    (info.problem ? `<div class="note">${esc(info.problem)}</div>` : '') +
    (info.uncertain
      ? `<div class="note">Nhóm còn ${info.uncertain} tác vụ Seedance chờ kiểm tra (quá giờ, app khởi động lại hoặc mất phản hồi): Seedvis có thể đã làm xong. Kiểm tra lại miễn phí trước khi tạo mới. <button class="button" id="recheckGroup">↻ Kiểm tra lại</button></div>`
      : '') +
    `<label>Tên nhóm<input id="groupName" value="${esc(n.name)}"></label>` +
    `<section class="inspector-section"><h3>Shot trong nhóm</h3><ol class="seedance-shots">${shots}</ol>` +
    `<p class="field-hint">${length}</p>` +
    `<p class="field-hint">Thêm hoặc bớt shot: nối hoặc cắt dây từ shot vào nhóm này. Ảnh shot đổi thì dựng lại storyboard.</p>` +
    `<button class="button" id="buildStoryboard">🧩 Dựng storyboard</button></section>` +
    `<section class="inspector-section"><h3>Gửi Seedance</h3><p class="field-hint">Ảnh gửi đi: ${refs}</p>` +
    `<label>Model<select id="groupModel">${models}</select></label>` +
    `<label>Prompt <span class="field-hint">tự dựng từ các shot; sửa tay rồi Lưu nếu cần</span><textarea id="groupPrompt" rows="12">${esc(n.resolvedPrompts.video)}</textarea></label>` +
    `<div class="prompt-tools"><button id="copyGroupPrompt">Sao chép prompt</button><button id="resetGroupPrompt">Dùng prompt tự dựng</button></div>` +
    videoResults(n) +
    `<label>Số phiên bản<select id="nodeVideoVersions"><option value="1">1 bản</option><option value="2">2 bản</option><option value="3">3 bản</option><option value="4">4 bản</option></select></label>` +
    `<div class="actions"><button class="button primary" id="generateGroup" ${info.problem ? 'disabled' : ''}>Tạo video Seedance</button></div></section>` +
    `<section class="inspector-section"><button class="button wide" id="saveGroup">Lưu chỉnh sửa</button><button class="button wide danger" id="deleteNode">Xóa nhóm này</button></section>`;
  const save = async () => {
    const b = { id };
    if ($('#groupName').value !== n.name) b.name = $('#groupName').value;
    if ($('#groupModel').value !== info.model)
      b.seedvis = { video: { model: $('#groupModel').value, aspectRatio: '16:9' } };
    if ($('#groupPrompt').value !== n.resolvedPrompts.video)
      b.videoPrompt = $('#groupPrompt').value;
    if (Object.keys(b).length > 1)
      store.state = await api('/api/node', { method: 'PATCH', body: b });
  };
  const run = action => async () => {
    try {
      await action();
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('.close').onclick = closeInspector;
  $('#buildStoryboard').onclick = run(async () => {
    $('#buildStoryboard').disabled = true;
    try {
      await composeStoryboard(n);
      const g = store.state.nodes.find(x => x.id === id);
      if (g && store.selected === id) inspectGroup(g);
      toast('Đã dựng storyboard');
    } finally {
      if ($('#buildStoryboard')) $('#buildStoryboard').disabled = false;
    }
  });
  if ($('#recheckGroup'))
    $('#recheckGroup').onclick = run(async () => {
      store.state = await api('/api/seedance/recheck', { method: 'POST', body: { id } });
      render();
      closeInspector();
      toast('Đang kiểm tra lại với Seedvis — không tạo trùng');
    });
  $('#copyGroupPrompt').onclick = () => copy($('#groupPrompt').value);
  $('#resetGroupPrompt').onclick = run(async () => {
    store.state = await api('/api/node', { method: 'PATCH', body: { id, videoPrompt: '' } });
    render();
    const g = store.state.nodes.find(x => x.id === id);
    if (g) inspectGroup(g);
  });
  $('#saveGroup').onclick = run(async () => {
    await save();
    render();
    const g = store.state.nodes.find(x => x.id === id);
    if (g) inspectGroup(g);
    toast('Đã lưu');
  });
  $('#generateGroup').onclick = run(async () => {
    // a render that may already be paid for: only on purpose
    const force =
      !!info.uncertain &&
      confirm(
        'Nhóm còn tác vụ Seedance chờ kiểm tra — Seedvis có thể đã làm xong. Tạo lượt mới có thể trả tiền hai lần. Vẫn tạo?',
      );
    if (info.uncertain && !force) return;
    await save();
    store.dirty = false;
    const count = Number($('#inspector #nodeVideoVersions')?.value) || 1;
    await api('/api/jobs', { method: 'POST', body: { nodeId: id, kind: 'video', count, force } });
    await refresh();
    toast(count > 1 ? 'Đã xếp ' + count + ' phiên bản vào hàng đợi' : 'Đã xếp vào hàng đợi');
    closeInspector();
    view('queue');
  });
  $('#deleteNode').onclick = () => deleteNode(id);
  lockInspectorIfBusy(); // read-only while the queue runs, like every other node
}

// Toolbar: split the shots that are in no group yet, then compose each new group's storyboard
// when its shots all have their keyframes.
$('#seedanceGroups').onclick = async () => {
  try {
    const r = await api('/api/seedance/groups', { method: 'POST', body: {} });
    store.state = r;
    render();
    let built = 0;
    for (const id of r.created) {
      const g = store.state.nodes.find(n => n.id === id);
      if (!g?.seedance?.members.every(m => m.ready)) continue;
      try {
        await composeStoryboard(g);
        built++;
      } catch (e) {
        toast(g.name + ': ' + e.message, true);
      }
    }
    toast(
      `Đã chia ${r.created.length} nhóm Seedance · dựng ${built} storyboard` +
        (built < r.created.length ? ' (nhóm còn lại: tạo ảnh shot trước rồi dựng)' : ''),
    );
  } catch (e) {
    toast(e.message, true);
  }
};
