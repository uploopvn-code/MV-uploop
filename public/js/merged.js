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
import { t } from './i18n.js';

const FRAMING = { ots_a: 'qua vai A', ots_b: 'qua vai B', two_shot: 'trung đôi' };
const frameLabel = key =>
  t({ ots_a: 'merged.otsA', ots_b: 'merged.otsB', two_shot: 'merged.twoShot' }[key]) || key;

// The merged-scene inspector (inspect() hands a merged node over to it).
export function inspectMerged(n) {
  const id = n.id,
    info = n.merged;
  // The video model this clip renders with. A merged scene films its 2–3 frames in one clip, so
  // any Seedvis video model that takes that many reference images works (Veo 3.1, Omni Flash,
  // Seedance). The picker lets the user switch off the default; the server validates the choice.
  const vm = n.providers?.video || {};
  // Phân cảnh ghép quay 2–3 khung trong MỘT clip: chạy qua API key Seedvis (chọn model nhận đủ
  // số ảnh — Veo 3, Seedance 10, Omni 3), hoặc qua nick Dola của Seedane (Dola chính là Seedance).
  const dola = vm.type === 'seedane';
  const seedvis = vm.type === 'seedvis';
  const vcat = store.state.seedvisCatalog?.video || [];
  // Model Seedvis hiện tại (hoặc mặc định đầu danh mục khi đang ở nguồn khác) để ô chọn có sẵn.
  const svModelId = seedvis ? vm.model : vcat[0]?.id;
  const vmodel = vcat.find(x => x.id === svModelId) || {};
  const modelLabel = dola ? vm.modelName || 'Seedane · Dola' : vm.modelName || vmodel.name || vm.model || '';
  const sourcePicker =
    `<label>Nguồn<select id="mergedSource">` +
    `<option value="seedvis" ${!dola ? 'selected' : ''}>Seedvis API</option>` +
    `<option value="dola" ${dola ? 'selected' : ''}>Seedane · Dola</option>` +
    '</select></label>';
  const svFields =
    `<div data-merged-src="seedvis" ${dola ? 'hidden' : ''}><div class="two">` +
    `<label>${t('provider.model')}<select id="mergedModel">${vcat
      .map(
        x => `<option value="${esc(x.id)}" ${x.id === svModelId ? 'selected' : ''}>${esc(x.name)}</option>`,
      )
      .join('')}</select></label>` +
    `<label>${t('merged.aspectRatio')}<select id="mergedAspect">${(vmodel.aspect || ['16:9'])
      .map(a => `<option value="${esc(a)}" ${a === vm.aspectRatio ? 'selected' : ''}>${esc(a)}</option>`)
      .join('')}</select></label></div>` +
    `<p class="field-hint">${t('merged.frameInputHint', { count: info.maxFrames, max: vmodel.maxImages || 3 })}</p></div>`;
  const dolaFields =
    `<div data-merged-src="dola" ${dola ? '' : 'hidden'}><label>Model Dola<select id="mergedDolaModel">` +
    `<option value="2.5" ${vm.model !== '2.0' ? 'selected' : ''}>Dola 2.5 (tới 30 giây, 10 ảnh)</option>` +
    `<option value="2.0" ${vm.model === '2.0' ? 'selected' : ''}>Dola 2.0 (tới 15 giây, 9 ảnh)</option>` +
    '</select></label>' +
    (dola && !store.state.seedaneConfigured
      ? '<p class="field-hint">Chưa nhập token Seedane — Kết nối web → Seedane.</p>'
      : '') +
    '</div>';
  const modelPicker = sourcePicker + svFields + dolaFields;
  // Rapid dialogue cuts among the ≤3 setup images more than three times, so there are more
  // beats than images. Then the lines live on the merged node (editable here); otherwise each
  // line rides on its frame node (edited by opening that node), as before.
  const reuse = info.beats > info.images;
  const frames = info.frames
    .map((f, i) => {
      const meta =
        `${f.words} ${t('merged.words')}` +
        (f.tooFast
          ? ` · ⚠ ${f.pace} ${t('merged.wordsPerSecond')}, ${t('merged.recommendedMax')} 3`
          : '') +
        (f.hasImage ? '' : ' · ' + t('merged.noImage')) +
        (f.stale ? ' · ' + t('merged.staleImage') : '') +
        (f.reuses ? ' · ↩ dùng lại ảnh cỡ cảnh này' : '');
      const title = f.id ? `<a href="#" data-open-node="${f.id}">${esc(f.name)}</a>` : esc(f.name);
      const line = reuse
        ? `<textarea class="beat-line" data-beat="${i}" rows="2" placeholder='Tên: "lời thoại"'>${esc(f.line || '')}</textarea>`
        : f.line
          ? `<div class="field-hint">“${esc(f.line)}”</div>`
          : '';
      return `<li>${f.hasImage && !f.stale ? '' : '⚠ '}<b>${f.from}–${f.to} ${t('common.seconds')}</b> · ${esc(frameLabel(f.framing))} · ${title} <span class="field-hint">${meta}</span>${line}</li>`;
    })
    .join('');
  const reuseHint = reuse
    ? `<p class="field-hint">⚡ Đối thoại nhanh: ${info.beats} nhịp cắt dùng lại ${info.images} ảnh cỡ cảnh. Sửa lời từng nhịp ngay đây; ảnh tạo ở node khung (mỗi cỡ cảnh một ảnh).</p>`
    : '';
  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>🎞 ${esc(n.name)}</h2><button class="close" aria-label="${t('common.close')}">×</button></div>` +
    '<div class="inspector-scroll">' +
    (info.problem ? `<div class="note">${esc(info.problem)}</div>` : '') +
    (info.warning ? `<div class="note">${esc(info.warning)}</div>` : '') +
    (info.uncertain
      ? `<div class="note">${t('merged.uncertainHint', { count: info.uncertain })} <button class="button" id="recheckMerged">↻ ${t('merged.recheck')}</button></div>`
      : '') +
    `<label>${t('merged.sceneName')}<input id="mergedName" value="${esc(n.name)}"></label>` +
    `<section class="inspector-section"><h3>${t('merged.framesTitle')}</h3><ol class="seedance-shots">${frames || '<li>' + t('merged.noFrames') + '</li>'}</ol>` +
    reuseHint +
    `<p class="field-hint">${t('merged.timelineHint', { seconds: info.seconds, frames: info.maxFrames })}</p>` +
    `<div class="actions"><button class="button" id="openStaging">🎬 ${t('merged.openStaging')}</button></div></section>` +
    `<section class="inspector-section"><h3>${t('merged.sendVideo')}${modelLabel ? ' · ' + esc(modelLabel) : ''}</h3>` +
    modelPicker +
    `<label>Prompt <span class="field-hint">${t('merged.promptHint')}</span><textarea id="mergedPrompt" rows="14">${esc(n.resolvedPrompts.video)}</textarea></label>` +
    `<div class="prompt-tools"><button id="copyMergedPrompt">${t('merged.copyPrompt')}</button><button id="resetMergedPrompt">${t('merged.resetPrompt')}</button></div>` +
    videoResults(n) +
    `<label>${t('merged.versionCount')}<select id="nodeVideoVersions"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>` +
    `<p class="field-hint">${t('merged.versionHint')}</p>` +
    `<div class="actions"><button class="button primary" id="generateMerged" ${info.problem ? 'disabled' : ''}>${t('merged.generateVideo')}${modelLabel ? ' · ' + esc(modelLabel) : ''}</button></div></section>` +
    `<section class="inspector-footer"><button class="button wide" id="saveMerged">${t('common.save')}</button><button class="button wide danger" id="deleteNode">${t('merged.deleteScene')}</button></section></div>`;
  openInspector('merged');
  normalizeInspectorLayout();
  const save = async () => {
    const b = { id };
    if ($('#mergedName').value !== n.name) b.name = $('#mergedName').value;
    if ($('#mergedPrompt').value !== n.resolvedPrompts.video)
      b.videoPrompt = $('#mergedPrompt').value;
    // Rapid-dialogue scenes keep their lines on the merged node: gather the edited beat lines.
    if (reuse) {
      const beats = info.frames.map((f, i) => ({
        framing: f.framing,
        lyric: document.querySelector(`[data-beat="${i}"]`)?.value ?? f.line ?? '',
        frameAction: f.action || '',
        audioDelivery: f.delivery || '',
      }));
      if (beats.some((bt, i) => bt.lyric !== (info.frames[i].line || ''))) b.beats = beats;
    }
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
      toast(t('render.rechecking'));
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
    toast(t('common.saved'));
  });
  // Đổi nguồn / model / tỉ lệ: lưu sửa prompt trước, rồi dựng lại để ô tỉ lệ bám model mới.
  const applyModel = run(async () => {
    await save();
    const body =
      $('#mergedSource').value === 'dola'
        ? { id, seedvis: { video: false }, seedane: { video: { platform: 'dola', model: $('#mergedDolaModel').value } } }
        : {
            id,
            seedane: { video: false },
            seedvis: {
              video: {
                model: $('#mergedModel').value,
                aspectRatio: $('#mergedAspect').value,
                upscale: null,
              },
            },
          };
    store.state = await api('/api/node', { method: 'PATCH', body });
    render();
    reopen();
  });
  if ($('#mergedSource'))
    $('#mergedSource').onchange = () => {
      // Đổi nguồn thì hiện/ẩn ngay; đổi tỉ lệ cần dựng lại nên gọi applyModel.
      const toDola = $('#mergedSource').value === 'dola';
      document.querySelector('[data-merged-src="seedvis"]').hidden = toDola;
      document.querySelector('[data-merged-src="dola"]').hidden = !toDola;
      applyModel();
    };
  if ($('#mergedModel')) $('#mergedModel').onchange = applyModel;
  if ($('#mergedAspect')) $('#mergedAspect').onchange = applyModel;
  if ($('#mergedDolaModel')) $('#mergedDolaModel').onchange = applyModel;
  $('#generateMerged').onclick = run(async () => {
    // a render that may already be paid for: only on purpose
    const force = !!info.uncertain && confirm(t('merged.duplicateConfirm'));
    if (info.uncertain && !force) return;
    await save();
    store.dirty = false;
    const count = Number($('#inspector #nodeVideoVersions')?.value) || 1;
    await api('/api/jobs', { method: 'POST', body: { nodeId: id, kind: 'video', count, force } });
    await refresh();
    toast(count > 1 ? t('merged.queuedVersions', { count }) : t('merged.queued'));
    closeInspector();
    view('queue');
  });
  $('#deleteNode').onclick = () => deleteNode(id);
  lockInspectorIfBusy(); // read-only while the queue runs, like every other node
}
