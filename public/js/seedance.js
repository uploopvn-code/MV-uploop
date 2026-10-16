// Seedance groups: several shots filmed in one Seedance render. "🧩 Chia nhóm Seedance" splits
// the shots into groups; a group's inspector shows its timeline and the images it sends,
// composes its storyboard sheet from the shots' keyframes (on a canvas, in the browser) and
// starts the render.
import { store } from './store.js';
import { $, api, copy, esc, toast } from './core.js';
import {
  closeInspector,
  deleteNode,
  inspect,
  lockInspectorIfBusy,
  normalizeInspectorLayout,
  openInspector,
  videoResults,
} from './inspector.js';
import { refresh, render, view } from './render.js';
import { t } from './i18n.js';

const PANEL_W = 640,
  PANEL_H = 360,
  GAP = 16,
  LABEL_H = 30; // white strip above each panel for its number (outside the image)

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
    img.onerror = () => no(new Error(t('seedance.imageLoadError') + ' ' + url));
    img.src = url;
  });

// The storyboard sheet: the shots' keyframes in timeline order, numbered 1…N like the prompt's
// "Shot 1…N", and nothing else written on it — captions make Seedance mix up the characters.
export async function composeStoryboard(g) {
  const members = g.seedance?.members || [];
  if (!members.length) throw new Error(t('seedance.noShots'));
  const notReady = members.find(m => !m.ready);
  if (notReady)
    throw new Error(t('seedance.shotNotReady', { name: notReady.name }));
  const { cols, rows } = grid(members.length);
  const canvas = document.createElement('canvas');
  // Số thứ tự panel đặt NGOÀI khung (trong dải nhãn trắng phía trên mỗi panel), không vẽ đè lên
  // ảnh — số nằm trong hình dễ bị model coi là chi tiết của cảnh / nhân vật.
  canvas.width = cols * PANEL_W + (cols + 1) * GAP;
  canvas.height = rows * (PANEL_H + LABEL_H) + (rows + 1) * GAP;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const images = await Promise.all(members.map(m => loadImage(m.image)));
  images.forEach((img, i) => {
    const col = i % cols,
      row = Math.floor(i / cols);
    const x = GAP + col * (PANEL_W + GAP);
    const labelTop = GAP + row * (PANEL_H + LABEL_H + GAP);
    const y = labelTop + LABEL_H; // panel sits below its number strip
    // the panel number, in the white strip ABOVE the panel (outside the image)
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x + 2, labelTop + LABEL_H / 2);
    ctx.fillStyle = '#000000';
    ctx.fillRect(x, y, PANEL_W, PANEL_H);
    // the whole keyframe, letterboxed if it is not 16:9
    const s = Math.min(PANEL_W / img.width, PANEL_H / img.height);
    const w = img.width * s,
      h = img.height * s;
    ctx.drawImage(img, x + (PANEL_W - w) / 2, y + (PANEL_H - h) / 2, w, h);
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
    `<div class="inspector-head"><h2>🧩 ${esc(n.name)}</h2><button class="close" aria-label="${t('common.close')}">×</button></div>` +
    '<div class="inspector-scroll">' +
    `<div class="inspector-preview">${n.image ? `<img src="${esc(n.image.url)}" alt="${t('seedance.storyboardAlt')} ${esc(n.name)}">` : t('seedance.storyboardPlaceholder')}</div>` +
    (info.problem
      ? `<div class="note">${esc(info.problem)}` +
        // Mở thẳng shot đang chặn (chưa có ảnh / ảnh cũ) để xử lý.
        ((info.missingShots?.[0] || info.staleShots?.[0])
          ? ` <button class="button" id="openProblemShot" data-shot="${esc((info.missingShots?.[0] || info.staleShots?.[0]).id)}">→ Mở shot cần xử lý</button>`
          : '') +
        // Ảnh đã cũ (không phải thiếu ảnh): cho ép dùng ảnh hiện tại, khỏi phải render lại.
        (info.staleShots?.length && !info.missingShots?.length
          ? ` <button class="button" id="keepStaleImages">✓ Dùng ảnh hiện tại (${info.staleShots.length})</button>`
          : '') +
        '</div>'
      : '') +
    (info.uncertain
      ? `<div class="note">Nhóm còn ${info.uncertain} tác vụ Seedance chờ kiểm tra (quá giờ, app khởi động lại hoặc mất phản hồi): Seedvis có thể đã làm xong. Kiểm tra lại miễn phí trước khi tạo mới. <button class="button" id="recheckGroup">↻ ${t('seedance.recheck')}</button></div>`
      : '') +
    `<label>${t('seedance.groupName')}<input id="groupName" value="${esc(n.name)}"></label>` +
    `<section class="inspector-section"><h3>${t('seedance.shotsInGroup')}</h3><ol class="seedance-shots">${shots}</ol>` +
    `<p class="field-hint">${length}</p>` +
    `<p class="field-hint">${t('seedance.editShotsHint')}</p>` +
    `<button class="button" id="buildStoryboard">🧩 ${t('seedance.buildStoryboard')}</button></section>` +
    `<section class="inspector-section"><h3>${t('seedance.sendTitle')}</h3><p class="field-hint">${t('seedance.imagesSent')}: ${refs}</p>` +
    // Dola là Seedance (của Seedane trên máy): chạy qua API key Seedvis, hoặc qua nick Dola của Seedane.
    `<label>Nguồn<select id="groupSource">` +
    `<option value="seedvis" ${info.source !== 'dola' ? 'selected' : ''}>Seedance · Seedvis (API key)</option>` +
    `<option value="dola" ${info.source === 'dola' ? 'selected' : ''}>Seedance · Dola (Seedane)</option>` +
    '</select></label>' +
    `<label data-group-model-row="seedvis" ${info.source === 'dola' ? 'hidden' : ''}>Model<select id="groupModel">${models}</select></label>` +
    `<label data-group-model-row="dola" ${info.source === 'dola' ? '' : 'hidden'}>Model Dola<select id="groupDolaModel">` +
    `<option value="2.5" ${info.dolaModel !== '2.0' ? 'selected' : ''}>Dola 2.5 (tới 30 giây)</option>` +
    `<option value="2.0" ${info.dolaModel === '2.0' ? 'selected' : ''}>Dola 2.0 (tới 15 giây)</option>` +
    '</select></label>' +
    (info.source === 'dola' && !info.dolaConfigured
      ? '<p class="field-hint">Chưa nhập token Seedane — Kết nối web → Seedane.</p>'
      : '') +
    `<label>Prompt <span class="field-hint">${t('seedance.promptHint')}</span><textarea id="groupPrompt" rows="12">${esc(n.resolvedPrompts.video)}</textarea></label>` +
    `<div class="prompt-tools"><button id="copyGroupPrompt">${t('seedance.copyPrompt')}</button><button id="resetGroupPrompt">${t('seedance.resetPrompt')}</button></div>` +
    videoResults(n) +
    `<label>${t('seedance.versionCount')}<select id="nodeVideoVersions"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>` +
    `<div class="actions"><button class="button primary" id="generateGroup" ${info.problem ? 'disabled' : ''}>${t('seedance.generateVideo')}</button></div></section>` +
    `<section class="inspector-footer"><button class="button wide" id="saveGroup">${t('common.save')}</button><button class="button wide danger" id="deleteNode">${t('seedance.deleteGroup')}</button></section></div>`;
  openInspector('seedance');
  normalizeInspectorLayout();
  const save = async () => {
    const b = { id };
    if ($('#groupName').value !== n.name) b.name = $('#groupName').value;
    const source = $('#groupSource').value;
    if (source === 'dola') {
      // Dola qua Seedane: tắt nguồn Seedvis, bật seedane.video platform dola.
      b.seedvis = { video: false };
      b.seedane = { video: { platform: 'dola', model: $('#groupDolaModel').value } };
    } else {
      // Seedvis: tắt Seedane nếu đang bật, chọn model Seedance.
      if (info.source === 'dola') b.seedane = { video: false };
      b.seedvis = { video: { model: $('#groupModel').value, aspectRatio: '16:9' } };
    }
    if ($('#groupPrompt').value !== n.resolvedPrompts.video)
      b.videoPrompt = $('#groupPrompt').value;
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
  $('#groupSource').onchange = () => {
    const dola = $('#groupSource').value === 'dola';
    document.querySelector('[data-group-model-row="seedvis"]').hidden = dola;
    document.querySelector('[data-group-model-row="dola"]').hidden = !dola;
  };
  $('#buildStoryboard').onclick = run(async () => {
    $('#buildStoryboard').disabled = true;
    try {
      await composeStoryboard(n);
      const g = store.state.nodes.find(x => x.id === id);
      if (g && store.selected === id) inspectGroup(g);
      toast(t('seedance.storyboardBuilt'));
    } finally {
      if ($('#buildStoryboard')) $('#buildStoryboard').disabled = false;
    }
  });
  if ($('#recheckGroup'))
    $('#recheckGroup').onclick = run(async () => {
      store.state = await api('/api/seedance/recheck', { method: 'POST', body: { id } });
      render();
      closeInspector();
      toast(t('render.rechecking'));
    });
  // Mở thẳng shot đang chặn storyboard (chưa có ảnh / ảnh cũ) để xử lý.
  if ($('#openProblemShot'))
    $('#openProblemShot').onclick = () => inspect($('#openProblemShot').dataset.shot);
  // Ép dùng ảnh hiện tại của các shot ảnh cũ: dựng storyboard được ngay, khỏi render lại.
  if ($('#keepStaleImages'))
    $('#keepStaleImages').onclick = run(async () => {
      store.state = await api('/api/node/keep-image', {
        method: 'POST',
        body: { ids: (info.staleShots || []).map(s => s.id) },
      });
      render();
      const g = store.state.nodes.find(x => x.id === id);
      if (g) inspectGroup(g);
      toast('Đã dùng ảnh hiện tại — dựng storyboard được rồi.');
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
    toast(t('common.saved'));
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

// Toolbar: split the shots that are in no group yet (resplit=false), or re-split the whole
// timeline after dropping the groups no render was spent on (resplit=true), then compose each
// new group's storyboard when its shots all have their keyframes.
async function splitGroups(resplit) {
  try {
    const r = await api('/api/seedance/groups', { method: 'POST', body: { resplit } });
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
}
$('#seedanceGroups').onclick = () => splitGroups(false);
$('#seedanceResplit').onclick = () => {
  if (
    confirm(
      'Chia lại sẽ XÓA các nhóm Seedance chưa render rồi chia lại toàn bộ shot cho đầy 30 giây. ' +
        'Nhóm đã có video được giữ nguyên. Tiếp tục?',
    )
  )
    splitGroups(true);
};
