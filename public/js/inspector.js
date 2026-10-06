// Node inspector panel: edit a node, its inputs, prompts, uploads and generation.
import { store } from './store.js';
import { addAngle, addLook, addReverseAngles, addWardrobe } from './add-nodes.js';
import { pickClip, videosOf } from './cards.js';
import { $, api, copy, dlUrl, downloadName, esc, toast, workflowBusy } from './core.js';
import { editImage, editPanel, swapImage } from './edit-image.js';
import {
  bindProviderSettings,
  kindsFor,
  orbitSettings,
  outputSettings,
  providerSettings,
  readProviderSettings,
  updateOutputPreview,
  videoFromRefs,
  videoUsesRefs,
} from './providers.js';
import { refresh, render, view } from './render.js';
import { inspectGroup } from './seedance.js';
import { inspectMerged } from './merged.js';
import { sheetPanel, wardrobePanel } from './wardrobe.js';
import { ZONES } from './zones.js';

// Everything wired into this node: the image inputs first, in the order the model receives
// them (the same [1] [2] [3] the prompt names), then the style / camera / sound presets.
// Each row opens its node or cuts that one wire — no need to hunt for the wire on canvas.
function inputChips(n) {
  const parents = store.state.edges
    .filter(e => e.target === n.id)
    .map(e => store.state.nodes.find(x => x.id === e.source))
    .filter(Boolean);
  if (!parents.length) return '';
  const sent = new Map(n.references.map((r, i) => [r.role, i + 1]));
  const row = (p, inner) =>
    `<div class="ref-chip"><button type="button" class="ref-open" data-open="${esc(p.id)}" ` +
    `title="Mở ${esc(p.name)}">${inner}</button>` +
    `<button type="button" class="ref-cut" data-cut="${esc(p.id)}" title="Bỏ nối node này">×</button></div>`;
  const image = p => {
    const i = sent.get(p.id);
    return row(
      p,
      (p.image
        ? `<img src="${esc(p.image.url)}" alt="${esc(p.name)}" loading="lazy">`
        : '<span class="ref-blank">chưa có ảnh</span>') +
        `<span class="ref-name">${i ? '[' + i + '] ' : ''}${esc(p.name)}</span>` +
        (i ? `<code>{{mv_input_${i}_path}}</code>` : ''),
    );
  };
  const setting = p =>
    row(
      p,
      `<span class="ref-icon">${{ camera: '🎥', audio: '🔊' }[p.settingType] || '🎨'}</span>` +
        `<span class="ref-name">${esc(p.name)}</span>`,
    );
  return (
    '<div class="reference-chips">' +
    parents
      .filter(p => p.kind !== 'setting')
      .map(image)
      .join('') +
    parents
      .filter(p => p.kind === 'setting')
      .map(setting)
      .join('') +
    '</div>'
  );
}
// The clips this node has produced, newest first: preview, file name, open the node.
export function videoResults(n) {
  const own = n.video
    ? `<div class="video-result"><video controls src="${esc(n.video.url)}"></video></div>`
    : '';
  const made = videosOf(n)
    .slice()
    .reverse()
    .map(
      t =>
        `<div class="video-result"><video controls src="${esc(t.video.url)}"></video>` +
        `<p class="field-hint">v${t.version || 1} · <code>${esc(downloadName(t))}</code></p>` +
        `<div class="actions"><button type="button" class="button" data-open="${esc(t.id)}">Mở node video</button>` +
        `<a class="button" href="${esc(dlUrl(t.video.url, downloadName(t)))}" download="${esc(downloadName(t))}">↓ Tải video</a></div></div>`,
    )
    .join('');
  return own + made ? `<div class="video-results">${own}${made}</div>` : '';
}
// Cuts one wire into the inspected node, then reopens it so the list refreshes.
async function cutInput(source, target) {
  if (workflowBusy()) return toast('Đợi hàng đợi chạy xong trước khi sửa dây nối.', true);
  try {
    store.state = await api('/api/edges', {
      method: 'PUT',
      body: { edges: store.state.edges.filter(e => !(e.source === source && e.target === target)) },
    });
    render();
    inspect(target);
    toast('Đã bỏ một đầu vào');
  } catch (err) {
    toast(err.message, true);
  }
}
// Zone picker (design/production) for a non-output node.
const zoneSelect = n =>
  '<label>Khu vực<select id="nodeZone">' +
  ZONES.filter(z => !['merged', 'output', 'seedance', 'seedance-video'].includes(z.id))
    .map(
      z => `<option value="${z.id}" ${n.zone === z.id ? 'selected' : ''}>${esc(z.label)}</option>`,
    )
    .join('') +
  '</select></label>';
export function closeInspector() {
  store.selected = null;
  store.dirty = false;
  $('#inspector').hidden = true;
  $('#overlay').hidden = true;
}
$('#overlay').onclick = closeInspector;
// While the queue runs, the inspector becomes view-only: every editing control and action
// button is disabled (close/copy/download stay), with a note explaining why.
export function lockInspectorIfBusy() {
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
export function inspect(id) {
  store.selected = id;
  store.dirty = false;
  const n = store.state.nodes.find(n => n.id === id),
    // Shots carry timing; compose/reference nodes (scene, singer…) do not.
    shot = n && 'duration' in n && !n.terminal && n.kind !== 'setting';
  $('#inspector').hidden = false;
  $('#overlay').hidden = false;
  // A Seedance group has its own panel (timeline, storyboard, one render for all its shots).
  if (n.role === 'seedance') return inspectGroup(n);
  // A merged scene too: its frames, the cut times, one render for all of them.
  if (n.role === 'merged') return inspectMerged(n);
  if (n.kind === 'setting') {
    const targets = store.state.edges
      .filter(e => e.source === n.id)
      .map(e => store.state.nodes.find(x => x.id === e.target)?.name)
      .filter(Boolean);
    $('#inspector').innerHTML =
      `<div class="inspector-head"><h2>${{ camera: '🎥', audio: '🔊' }[n.settingType] || '🎨'} ${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
      `<p class="field-hint">Node ${{ camera: 'máy quay', audio: 'âm thanh' }[n.settingType] || 'style'}: nội dung dưới đây được chèn vào prompt của mọi node bạn nối ra. Nối cổng Ra của node này vào node cần áp.</p>` +
      `<label>Tên<input id="settingName" value="${esc(n.name)}"></label>` +
      `<label>Nội dung ${{ camera: '(mô tả máy quay, góc, ống kính…)', audio: '(nhạc nền + tiếng hiện trường, tiếng Anh: "low cello drone, rain on umbrellas, distant bell; no dialogue")' }[n.settingType] || '(mô tả phong cách, màu, chất liệu…)'}<textarea id="settingConfig" rows="5">${esc(n.config || '')}</textarea></label>` +
      zoneSelect(n) +
      `<p class="field-hint">Đang áp cho: ${targets.length ? esc(targets.join(', ')) : 'chưa nối node nào'}</p>` +
      `<section class="inspector-section"><button class="button wide primary" id="saveSetting">Lưu</button>${id.startsWith('node-') ? '<button class="button wide danger" id="deleteNode">Xóa node này</button>' : ''}</section>`;
    $('.close').onclick = closeInspector;
    $('#saveSetting').onclick = async () => {
      try {
        store.state = await api('/api/node', {
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
    const src = store.state.nodes.find(x => x.id === n.source);
    // Every clip of this source: ‹ › walk through them, keep the good one, drop the rest.
    const stack = videosOf({ id: n.source });
    const k = stack.findIndex(x => x.id === n.id);
    const others = stack.filter(x => x.id !== n.id);
    $('#inspector').innerHTML =
      `<div class="inspector-head"><h2>${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
      `<p class="field-hint">Phiên bản video${src ? ' từ node “' + esc(src.name) + '”' : ''}. Node này chỉ để xem/tải; tạo lại từ node nguồn.</p>` +
      (stack.length > 1
        ? `<div class="prompt-tools"><button id="clipPrev" ${k > 0 ? '' : 'disabled'}>‹ Bản trước</button><span class="field-hint">bản ${k + 1}/${stack.length}</span><button id="clipNext" ${k < stack.length - 1 ? '' : 'disabled'}>Bản sau ›</button></div>`
        : '') +
      (n.video
        ? `<video controls src="${esc(n.video.url)}" style="width:100%;border-radius:8px"></video><p class="field-hint">Tên file tải về: <code>${esc(downloadName(n))}</code></p><div class="actions"><a class="button" href="${esc(dlUrl(n.video.url, downloadName(n)))}" download="${esc(downloadName(n))}">↓ Tải video</a></div>`
        : '<p>Chưa có video.</p>') +
      `<section class="inspector-section">${others.length ? `<button class="button wide" id="keepClip">Giữ bản này, xóa ${others.length} bản khác</button>` : ''}<button class="button wide danger" id="deleteNode">Xóa phiên bản này</button></section>`;
    $('.close').onclick = closeInspector;
    const go = t => {
      if (!t) return;
      pickClip(n.source, t.id);
      render();
      inspect(t.id);
    };
    if ($('#clipPrev')) $('#clipPrev').onclick = () => go(stack[k - 1]);
    if ($('#clipNext')) $('#clipNext').onclick = () => go(stack[k + 1]);
    if ($('#keepClip'))
      $('#keepClip').onclick = async () => {
        if (!confirm(`Giữ bản này và xóa ${others.length} bản khác?`)) return;
        try {
          for (const o of others)
            store.state = await api('/api/nodes/delete', { method: 'POST', body: { id: o.id } });
          render();
          inspect(n.id);
          toast('Đã xóa ' + others.length + ' bản, giữ ' + n.name);
        } catch (e) {
          toast(e.message, true);
        }
      };
    $('#deleteNode').onclick = () => deleteNode(id);
    lockInspectorIfBusy();
    return;
  }
  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div><div class="inspector-preview">${n.image ? `<img src="${esc(n.image.url)}" alt="Ảnh ${esc(n.name)}">` : 'Ảnh của node sẽ xuất hiện ở đây'}</div>${editPanel(n)}${n.stale ? '<div class="note">Đầu vào đã đổi. Tạo lại ảnh hoặc tải ảnh đã duyệt trước khi làm video.</div>' : ''}<div class="two"><label>STT trong khu vực<input id="nodeSeq" type="number" min="1" value="${n.seq || ''}"></label><label>Tên node<input id="nodeName" value="${esc(n.name)}"></label></div><p class="field-hint">File tải về của node này: <code>${esc(downloadName({ ...n, terminal: false }, n.video ? 'video' : 'image'))}</code></p>${zoneSelect(n)}${sheetPanel(n)}${wardrobePanel(n)}${inputsSummary(n, shot)}${inputChips(n)}<label>Prompt ảnh <code class="variable-tag" title="Biến Orbit nhận khi chạy tác vụ tạo ảnh">{{prompt}}</code><textarea id="imagePrompt" rows="5">${esc(n.resolvedPrompts.image)}</textarea></label><p class="field-hint">Orbit nhận nội dung này qua <code>{{prompt}}</code> hoặc <code>{{mv_prompt}}</code> khi tạo ảnh. Khi tạo video, hai biến này chứa prompt video.</p><div class="prompt-tools"><button id="copyImage">Sao chép prompt</button><button id="resetPrompt">Dùng prompt kế thừa</button></div><div class="actions"><label class="button">↑ Tải ảnh<input type="file" id="imageUpload" accept="image/png,image/jpeg,image/webp" hidden></label><button class="button primary" id="generateImage">${generateLabel(n, 'image')}</button></div><p class="queue-hint">${n.providers.image.type === 'seedvis' ? 'Gửi prompt và ' + n.references.length + ' ảnh đầu vào tới Seedvis · ' + esc(n.providers.image.modelName) + '.' : n.providers.image.type === 'web' ? 'Gửi prompt' + (n.references.length ? ' + ' + n.references.length + ' ảnh đầu vào' : '') + ' sang ChatGPT qua extension (bật worker trong trình duyệt).' : 'Tác vụ sẽ mở nick và chạy kịch bản bằng phiên Orbit đã đăng nhập.'}</p>${shot ? `<section class="inspector-section"><h3>Video của shot</h3><label>Ảnh đầu vào cho video<select id="videoInput"><option value="self" ${!videoUsesRefs(n) ? 'selected' : ''}>Ảnh của node này (keyframe)</option><option value="refs" ${videoUsesRefs(n) ? 'selected' : ''}>Ảnh từ node nối vào (${n.imageInputs} ảnh tham chiếu${n.videoRefLimit ? ', model nhận tối đa ' + n.videoRefLimit : ''})</option></select></label><p class="field-hint" id="videoInputHint">${esc(videoInputHint(n))}</p><div class="two"><label>Bắt đầu (giây) <code class="variable-tag">{{mv_start}}</code><input id="start" type="number" min="0" value="${n.start}"></label><label>Thời lượng (giây) <code class="variable-tag">{{mv_duration}}</code><input id="duration" type="number" min="1" value="${n.duration}"></label></div><label>Lời hát đúng đoạn này <span class="field-hint">Nhúng trong prompt video, không có biến riêng</span><textarea id="lyric" rows="2" placeholder="Để trống nếu chưa căn lời">${esc(n.lyric)}</textarea></label><details><summary>Prompt chuyển động <code class="variable-tag" title="Biến Orbit nhận khi chạy tác vụ tạo video">{{prompt}}</code></summary><label>Prompt video <code class="variable-tag">{{prompt}}</code><textarea id="videoPrompt" rows="5">${esc(n.resolvedPrompts.video)}</textarea></label><p class="field-hint">Tool tự thêm dòng “Reference subjects” (liệt kê từng ảnh tham chiếu theo đúng thứ tự gửi đi, kèm đặc điểm nhận dạng từ Bible), thay mọi <code>@key</code> bằng tên nhân vật, và từ thoại dạng “Tên: …” thêm câu nói rõ ai là người nói và dòng “Voice lock” khóa giọng (voice_profile trong Bible + audio_delivery của shot) — để Veo không nhầm người và không đổi giọng giữa các shot.</p><button id="copyVideo" class="button">Sao chép</button></details>${videoResults(n)}${n.providers.video.type === 'seedvis' ? `<label>Số phiên bản<select id="nodeVideoVersions"><option value="1">1 bản</option><option value="2">2 bản</option><option value="3">3 bản</option><option value="4">4 bản</option></select></label><p class="field-hint">Mỗi bản thành một node video riêng ở cột ⑧ Video, nối từ cổng 🎬 của shot.</p>` : ''}<div class="actions"><label class="button">↑ Tải video<input type="file" id="videoUpload" accept="video/mp4,video/webm" hidden></label><button class="button primary" id="generateVideo" ${videoReady(n) ? '' : 'disabled'}>${generateLabel(n, 'video')}</button></div><p class="muted">Keyframe: dùng chính ảnh của node. Node nối vào: dùng ảnh ban nhạc/bối cảnh đã nối. Khẩu hình cần model hỗ trợ audio/lip-sync.</p></section>` : ''}${providerSettings(n, shot)}${usesOrbit(n, shot) ? outputSettings(n, shot) + orbitSettings(n, shot) : '<details class="inspector-section"><summary>Cài đặt Orbit (chỉ cần khi chọn nguồn Orbit)</summary>' + outputSettings(n, shot) + orbitSettings(n, shot) + '</details>'}<section class="inspector-section"><button class="button wide" id="saveNode">Lưu chỉnh sửa</button>${id.startsWith('node-') ? '<button class="button wide danger" id="deleteNode">Xóa node này</button>' : ''}</section>`;
  $('.close').onclick = closeInspector;
  $('#nodeName').oninput = () => (store.dirty = true);
  document.querySelectorAll('[data-output-pattern]').forEach(
    e =>
      (e.oninput = () => {
        store.dirty = true;
        updateOutputPreview();
      }),
  );
  document
    .querySelectorAll('[data-orbit-select]')
    .forEach(e => (e.onchange = () => (store.dirty = true)));
  bindProviderSettings(n);
  if ($('#nodeSeq')) $('#nodeSeq').oninput = () => (store.dirty = true);
  if ($('#nodeZone')) $('#nodeZone').onchange = () => (store.dirty = true);
  if ($('#wardrobeOutfit')) {
    $('#wardrobeOutfit').oninput = () => (store.dirty = true);
    $('#wardrobeItems').oninput = () => (store.dirty = true);
  }
  if ($('#addWardrobeFor')) $('#addWardrobeFor').onclick = () => addWardrobe(id);
  if ($('#addLookFor')) $('#addLookFor').onclick = () => addLook(id);
  if ($('#editImage')) $('#editImage').onclick = () => editImage(id);
  if ($('#swapImage')) $('#swapImage').onclick = () => swapImage(id);
  if ($('#angleText')) $('#angleText').oninput = () => (store.dirty = true);
  if ($('#sheetDesc')) $('#sheetDesc').oninput = () => (store.dirty = true);
  if ($('#addReverseAngles')) $('#addReverseAngles').onclick = () => addReverseAngles(id);
  if ($('#addAngleFor')) $('#addAngleFor').onclick = () => addAngle(id);
  document
    .querySelectorAll('[data-open]')
    .forEach(e => (e.onclick = () => inspect(e.dataset.open)));
  document
    .querySelectorAll('[data-cut]')
    .forEach(e => (e.onclick = () => cutInput(e.dataset.cut, id)));
  $('#imagePrompt').oninput = () => (store.dirty = true);
  if (shot) {
    $('#lyric').oninput = () => (store.dirty = true);
    $('#start').oninput = () => (store.dirty = true);
    $('#duration').oninput = () => (store.dirty = true);
    $('#videoPrompt').oninput = () => (store.dirty = true);
    $('#videoInput').onchange = () => {
      store.dirty = true;
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
      store.state = await api('/api/node', {
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
export async function saveNode() {
  if (!store.selected || !store.dirty) return;
  const n = store.state.nodes.find(n => n.id === store.selected),
    b = { id: store.selected };
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
  const prov = readProviderSettings(n);
  if (Object.keys(prov.seedvis).length) b.seedvis = prov.seedvis;
  if (Object.keys(prov.web).length) b.web = prov.web;
  if ($('#wardrobeOutfit')) {
    if ($('#wardrobeOutfit').value !== (n.outfit || '')) b.outfit = $('#wardrobeOutfit').value;
    if ($('#wardrobeItems').value !== (n.items || '')) b.items = $('#wardrobeItems').value;
  }
  if ($('#angleText') && $('#angleText').value !== (n.angle || '')) b.angle = $('#angleText').value;
  if ($('#sheetDesc') && $('#sheetDesc').value !== (n.desc || '')) b.desc = $('#sheetDesc').value;
  if ($('#imagePrompt').value !== n.resolvedPrompts.image) b.prompt = $('#imagePrompt').value;
  if ($('#lyric')) {
    b.lyric = $('#lyric').value;
    b.start = Number($('#start').value);
    b.duration = Number($('#duration').value);
    if ($('#videoInput').value !== n.videoInput) b.videoInput = $('#videoInput').value;
    if ($('#videoPrompt').value !== n.resolvedPrompts.video)
      b.videoPrompt = $('#videoPrompt').value;
  }
  store.state = await api('/api/node', { method: 'PATCH', body: b });
  store.dirty = false;
  render();
}
export async function generate(id, kind) {
  try {
    await saveNode();
    // Scoped to the inspector: the toolbar has its own #videoVersions for auto runs.
    const pick = $('#inspector #nodeVideoVersions');
    const count = kind === 'video' && pick ? Number(pick.value) : 1;
    await api('/api/jobs', { method: 'POST', body: { nodeId: id, kind, count } });
    await refresh();
    toast(count > 1 ? 'Đã xếp ' + count + ' phiên bản vào hàng đợi' : 'Đã xếp vào hàng đợi');
    closeInspector();
    view('queue');
  } catch (e) {
    toast(e.message, true);
  }
}
// Uploads a file into a node (or the project's song when nodeId is 'audio').
export async function upload(file, nodeId, kind) {
  if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('File tối đa 100 MB');
    const base64 = await new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(r.result.split(',')[1]);
      r.onerror = no;
      r.readAsDataURL(file);
    });
    store.state = await api('/api/upload', {
      method: 'POST',
      body: { nodeId, kind, name: file.name, mime: file.type, base64 },
    });
    render();
    if (store.selected) inspect(store.selected);
    toast('Đã lưu file trên máy bạn');
  } catch (e) {
    toast(e.message, true);
  }
}
const usesOrbit = (n, shot) => kindsFor(shot).some(kind => n.providers[kind].type === 'orbit');
function generateLabel(n, kind) {
  const type = n.providers[kind].type;
  return (
    (kind === 'image' ? 'Tạo ảnh' : 'Tạo video') +
    (type === 'seedvis' ? ' · Seedvis' : type === 'web' ? ' · ChatGPT' : ' qua Orbit')
  );
}
// Video can run now if its own image exists (keyframe) or, in refs mode within the
// limit, a connected parent node already has an image.
const videoReady = n => (videoFromRefs(n) ? n.references.length > 0 : !!n.image);
// What the auto-video run can take on: ready to film, or a refs-mode shot over the limit
// whose refs are in — the run composes its keyframe first, then films.
function videoInputHint(n) {
  if (n.videoNeedsKeyframe && !n.image)
    return `${n.imageInputs} ảnh tham chiếu > giới hạn ${n.videoRefLimit} ảnh của model video: phải tạo ảnh khung hình trước (gộp các ảnh tham chiếu; model ảnh nhận tới 10), video sẽ dùng ảnh đó. "▶ Tạo video" tự động làm bước này, hoặc bấm Tạo ảnh rồi Tạo video.`;
  if (!videoUsesRefs(n))
    return n.image
      ? 'Dùng ảnh đã duyệt của node này làm keyframe.'
      : 'Node này chưa có ảnh. Tạo hoặc tải ảnh trước, hoặc chuyển sang dùng ảnh node nối vào.';
  // refs mode
  if (n.image)
    return 'Node đã có ảnh — video dùng đúng ảnh này (keyframe), không gửi lại ảnh node nối vào.';
  return n.references.length
    ? `Chưa có ảnh của node — gửi thẳng ${n.references.length} ảnh tham chiếu (trong giới hạn ${n.videoRefLimit ?? '—'} của model) vào tạo video. Tạo ảnh của node này nếu muốn video bám đúng một khung hình.`
    : 'Chưa có node nào đã có ảnh nối vào. Nối một node đã có ảnh, hoặc tải ảnh lên node đó.';
}
// Inspector line: the node's inputs split into reference images and style / camera text.
function inputsSummary(n, shot) {
  return `<p class="field-hint">Đầu vào: 🖼 <b>${n.imageInputs}</b> ảnh tham chiếu (${n.references.length} đã có ảnh) · 🎨🎥 <b>${n.settingInputs}</b> style/máy quay${shot && n.videoRefLimit ? ` · model video nhận tối đa ${n.videoRefLimit} ảnh` : ''}${shot && n.videoNeedsKeyframe ? ' · <b>vượt giới hạn → tạo ảnh khung hình trước, video dùng ảnh đó</b>' : ''}</p>`;
}
export async function deleteNode(id) {
  if (!confirm('Xóa node này?')) return;
  try {
    store.state = await api('/api/nodes/delete', { method: 'POST', body: { id } });
    closeInspector();
    render();
    toast('Đã xóa node');
  } catch (e) {
    toast(e.message, true);
  }
}
