// Merged scenes: 2–3 camera setups of one conversation filmed as ONE Veo clip. The director
// builds them from a blueprint shot with "setups"; the inspector shows the frames in cut
// order with their seconds, the prompt the tool composes, and starts the render.
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
import { openStaging } from './staging.js';

const FRAMING = { ots_a: 'qua vai A', ots_b: 'qua vai B', two_shot: 'trung đôi' };

// The merged-scene inspector (inspect() hands a merged node over to it).
export function inspectMerged(n) {
  const id = n.id,
    info = n.merged;
  // The video model this clip renders with. A merged scene films its 2–3 frames in one clip, so
  // any Seedvis video model that takes that many reference images works (Veo 3.1, Omni Flash,
  // Seedance). The picker lets the user switch off the default; the server validates the choice.
  const vm = n.providers?.video || {};
  const seedvis = vm.type === 'seedvis';
  const vcat = store.state.seedvisCatalog?.video || [];
  const vmodel = vcat.find(x => x.id === vm.model) || {};
  const modelLabel = seedvis ? vm.modelName || vmodel.name || vm.model : '';
  const modelPicker = seedvis
    ? `<div class="two"><label>Model<select id="mergedModel">${vcat
        .map(
          x =>
            `<option value="${esc(x.id)}" ${x.id === vm.model ? 'selected' : ''}>${esc(x.name)}</option>`,
        )
        .join('')}</select></label><label>Tỉ lệ khung<select id="mergedAspect">${(
        vmodel.aspect || ['16:9']
      )
        .map(
          a =>
            `<option value="${esc(a)}" ${a === vm.aspectRatio ? 'selected' : ''}>${esc(a)}</option>`,
        )
        .join('')}</select></label></div>` +
      `<p class="field-hint">Gửi ${info.maxFrames} ảnh khung vào một clip (model nhận tối đa ${vmodel.maxImages || 3}). Veo dễ qua kiểm duyệt với mặt người thật; Omni Flash / Seedance có thể bị bộ lọc từ chối ảnh chân dung.</p>`
    : `<p class="note">Phân cảnh ghép quay bằng Seedvis — đặt nguồn video = Seedvis (mặc định project hoặc cho node) để chọn model.</p>`;
  const frames = info.frames
    .map(
      f =>
        `<li>${f.hasImage && !f.stale ? '' : '⚠ '}<b>${f.from}–${f.to} giây</b> · ${esc(FRAMING[f.framing] || f.framing)} · <a href="#" data-open-node="${f.id}">${esc(f.name)}</a> <span class="field-hint">${f.words} từ${f.tooFast ? ` · ⚠ ${f.pace} từ/giây, nên ≤ 3` : ''}${f.hasImage ? '' : ' · chưa có ảnh'}${f.stale ? ' · ảnh đã cũ' : ''}</span></li>`,
    )
    .join('');
  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>🎞 ${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
    '<div class="inspector-scroll">' +
    (info.problem ? `<div class="note">${esc(info.problem)}</div>` : '') +
    (info.warning ? `<div class="note">${esc(info.warning)}</div>` : '') +
    (info.uncertain
      ? `<div class="note">Còn ${info.uncertain} tác vụ Seedvis chờ kiểm tra (quá giờ, app khởi động lại hoặc mất phản hồi): Seedvis có thể đã làm xong. Kiểm tra lại miễn phí trước khi tạo mới. <button class="button" id="recheckMerged">↻ Kiểm tra lại</button></div>`
      : '') +
    `<label>Tên phân cảnh<input id="mergedName" value="${esc(n.name)}"></label>` +
    `<section class="inspector-section"><h3>Các khung, theo thứ tự cắt</h3><ol class="seedance-shots">${frames || '<li>Chưa có khung nào nối vào.</li>'}</ol>` +
    `<p class="field-hint">Một clip Veo ${info.seconds} giây, tối đa ${info.maxFrames} khung; thời gian mỗi khung chia theo số từ của câu thoại. Thêm hoặc bớt khung: nối hoặc cắt dây từ khung (cột ⑥) vào phân cảnh này. Tạo ảnh ở từng khung trước.</p>` +
    `<div class="actions"><button class="button" id="openStaging">🎬 Dàn dựng 2D (đặt máy, trái/phải, mô tả)</button></div></section>` +
    `<section class="inspector-section"><h3>Gửi video${modelLabel ? ' · ' + esc(modelLabel) : ''}</h3>` +
    modelPicker +
    `<label>Prompt <span class="field-hint">tự dựng từ các khung; sửa tay rồi Lưu nếu cần</span><textarea id="mergedPrompt" rows="14">${esc(n.resolvedPrompts.video)}</textarea></label>` +
    `<div class="prompt-tools"><button id="copyMergedPrompt">Sao chép prompt</button><button id="resetMergedPrompt">Dùng prompt tự dựng</button></div>` +
    videoResults(n) +
    `<label>Số phiên bản<select id="nodeVideoVersions"><option value="1">1 bản</option><option value="2">2 bản</option><option value="3">3 bản</option><option value="4">4 bản</option></select></label>` +
    `<p class="field-hint">Mỗi bản thành một node video riêng ở cột ⑧ Video, cùng hàng với phân cảnh.</p>` +
    `<div class="actions"><button class="button primary" id="generateMerged" ${info.problem ? 'disabled' : ''}>Tạo video${modelLabel ? ' · ' + esc(modelLabel) : ''}</button></div></section>` +
    `<section class="inspector-footer"><button class="button wide" id="saveMerged">Lưu chỉnh sửa</button><button class="button wide danger" id="deleteNode">Xóa phân cảnh này</button></section></div>`;
  openInspector('merged');
  normalizeInspectorLayout();
  const save = async () => {
    const b = { id };
    if ($('#mergedName').value !== n.name) b.name = $('#mergedName').value;
    if ($('#mergedPrompt').value !== n.resolvedPrompts.video)
      b.videoPrompt = $('#mergedPrompt').value;
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
  const reopen = () => {
    const m = store.state.nodes.find(x => x.id === id);
    if (m && store.selected === id) inspectMerged(m);
  };
  $('.close').onclick = closeInspector;
  // The frame links and the clip buttons: render() only wires these on the next poll.
  document.querySelectorAll('#inspector [data-open-node], #inspector [data-open]').forEach(e => {
    e.onclick = ev => {
      ev.preventDefault();
      ev.stopPropagation();
      inspect(e.dataset.openNode || e.dataset.open);
    };
  });
  if ($('#recheckMerged'))
    $('#recheckMerged').onclick = run(async () => {
      store.state = await api('/api/merged/recheck', { method: 'POST', body: { id } });
      render();
      closeInspector();
      toast('Đang kiểm tra lại với Seedvis — không tạo trùng');
    });
  if ($('#openStaging')) $('#openStaging').onclick = () => openStaging(n);
  $('#copyMergedPrompt').onclick = () => copy($('#mergedPrompt').value);
  $('#resetMergedPrompt').onclick = run(async () => {
    store.state = await api('/api/node', { method: 'PATCH', body: { id, videoPrompt: '' } });
    render();
    reopen();
  });
  $('#saveMerged').onclick = run(async () => {
    await save();
    render();
    reopen();
    toast('Đã lưu');
  });
  // Switch the clip's video model / aspect: keep any prompt edit, then rebuild so the aspect
  // options follow the new model.
  const applyModel = run(async () => {
    await save();
    store.state = await api('/api/node', {
      method: 'PATCH',
      body: {
        id,
        seedvis: {
          video: {
            model: $('#mergedModel').value,
            aspectRatio: $('#mergedAspect').value,
            upscale: null,
          },
        },
      },
    });
    render();
    reopen();
  });
  if ($('#mergedModel')) $('#mergedModel').onchange = applyModel;
  if ($('#mergedAspect')) $('#mergedAspect').onchange = applyModel;
  $('#generateMerged').onclick = run(async () => {
    // a render that may already be paid for: only on purpose
    const force =
      !!info.uncertain &&
      confirm(
        'Phân cảnh còn tác vụ Seedvis chờ kiểm tra — Seedvis có thể đã làm xong. Tạo lượt mới có thể trả tiền hai lần. Vẫn tạo?',
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
