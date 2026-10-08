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
import { ZONES, nodeTime } from './zones.js';
import { capturesReady } from './stage-keeper.js';
import { framingLabel } from './stage-math.js';

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
  // a 3D stage node sends no picture: it gives this node its marks
  const stageNode = p =>
    row(
      p,
      '<span class="ref-icon">🧍</span>' +
        `<span class="ref-name">${esc(p.name)} · vị trí 3D (không gửi ảnh)</span>`,
    );
  const pin = n.stagePin;
  const capture =
    pin?.capture === 'sent' && n.layout?.asset
      ? `<div class="ref-chip"><a class="ref-open" href="${esc(n.layout.asset.url)}" target="_blank" rel="noopener" title="Ảnh chụp 3D đúng khung hình này — tool tự chụp, gửi kèm làm ảnh cuối"><img src="${esc(n.layout.asset.url)}" alt="Ảnh chụp 3D" loading="lazy"><span class="ref-name">[${pin.refNo}] 📌 Ảnh chụp 3D (tự động)</span></a></div>`
      : '';
  const setting = p =>
    row(
      p,
      `<span class="ref-icon">${{ camera: '🎥', audio: '🔊' }[p.settingType] || '🎨'}</span>` +
        `<span class="ref-name">${esc(p.name)}</span>`,
    );
  return (
    '<div class="reference-chips">' +
    parents
      .filter(p => p.kind !== 'setting' && !p.stageOnly)
      .map(image)
      .join('') +
    capture +
    parents
      .filter(p => p.stageOnly)
      .map(stageNode)
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
  ZONES.filter(
    z =>
      !['merged', 'output', 'seedance', 'seedance-video', 'lipsync', 'lipsync-video'].includes(
        z.id,
      ),
  )
    .map(
      z => `<option value="${z.id}" ${n.zone === z.id ? 'selected' : ''}>${esc(z.label)}</option>`,
    )
    .join('') +
  '</select></label>';
function paintCanvasFocus(id) {
  const edges = store.state.edges;
  document.querySelectorAll('[data-graph-id]').forEach(el => {
    const nodeId = el.dataset.graphId;
    const related = edges.some(
      e => (e.source === id && e.target === nodeId) || (e.target === id && e.source === nodeId),
    );
    el.classList.toggle('selected', nodeId === id);
    el.classList.toggle('related', !!id && related);
    el.classList.toggle('dimmed', !!id && nodeId !== id && !related);
  });
  document.querySelectorAll('.wire[data-edge-source][data-edge-target]').forEach(el => {
    el.classList.toggle(
      'focus',
      !!id && (el.dataset.edgeSource === id || el.dataset.edgeTarget === id),
    );
  });
}

let inspectorTrigger = null;
let inspectorCloseTimer = null;
let inspectorEscapeBound = false;

function inspectorHeader({ eyebrow = 'NODE INSPECTOR', title, subtitle = '', status = '' } = {}) {
  return (
    '<div class="inspector-head">' +
    '<div class="inspector-heading"><span class="inspector-eyebrow">' +
    esc(eyebrow) +
    '</span><h2 id="inspectorTitle">' +
    title +
    '</h2>' +
    (subtitle ? '<p class="inspector-subtitle">' + subtitle + '</p>' : '') +
    (status ? '<span class="inspector-status">' + status + '</span>' : '') +
    '</div><button class="close" aria-label="Đóng">×</button></div>'
  );
}

export function openInspector(context = 'node', trigger = null) {
  const panel = $('#inspector');
  const overlay = $('#overlay');
  if (panel.hidden && !inspectorTrigger) inspectorTrigger = trigger || document.activeElement;
  clearTimeout(inspectorCloseTimer);
  panel.classList.remove('is-closing');
  panel.dataset.inspectorContext = context;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'inspectorTitle');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('inspector-open');
  bindInspectorEscape();
  panel.hidden = false;
  overlay.hidden = false;
  requestAnimationFrame(() => panel.classList.add('is-open'));
  setTimeout(() => {
    normalizeInspectorLayout();
    panel.querySelector('.close')?.focus();
  }, 0);
}

function bindInspectorEscape() {
  if (inspectorEscapeBound) return;
  inspectorEscapeBound = true;
  document.addEventListener('keydown', e => {
    if (!$('#inspector').hidden && e.key === 'Escape') {
      e.preventDefault();
      closeInspector();
      return;
    }
    if ($('#inspector').hidden || e.key !== 'Tab') return;
    const panel = $('#inspector');
    const items = [
      ...panel.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(el => el.getClientRects().length);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

export function normalizeInspectorLayout() {
  const panel = $('#inspector');
  const head = panel.querySelector(':scope > .inspector-head');
  if (!head) return;
  const h2 = head.querySelector('h2');
  if (h2) {
    h2.id = 'inspectorTitle';
    if (!head.querySelector('.inspector-heading')) {
      const heading = document.createElement('div');
      heading.className = 'inspector-heading';
      const eyebrow = document.createElement('span');
      eyebrow.className = 'inspector-eyebrow';
      eyebrow.textContent =
        ({ node: 'NODE INSPECTOR', stage: 'SÂN KHẤU 3D', setting: 'THIẾT LẬP NODE', brief: 'PROJECT BRIEF', project: 'PROJECT SETTINGS' }[
          panel.dataset.inspectorContext
        ] || 'WORKFLOW INSPECTOR');
      heading.append(eyebrow, h2);
      head.insertBefore(heading, head.querySelector('.close'));
    }
  }
  if (panel.querySelector(':scope > .inspector-scroll')) return;
  const action = panel.querySelector(
    '#saveNode, #saveSetting, #saveStageName, #saveBrief, #saveProjectSettings, #deleteNode',
  );
  const footer = action?.closest('.inspector-section');
  if (footer) footer.classList.add('inspector-footer');
  const scroll = document.createElement('div');
  scroll.className = 'inspector-scroll';
  [...panel.children].forEach(child => {
    if (child !== head && child !== footer) scroll.append(child);
  });
  panel.append(scroll);
  if (footer) panel.append(footer);
}

function inspectorMarkup(body, context, header, footer = '') {
  return (
    header +
    '<div class="inspector-scroll">' +
    body +
    '</div>' +
    (footer ? '<div class="inspector-footer">' + footer + '</div>' : '')
  );
}

function mountInspector(body, context, header, footer = '') {
  const panel = $('#inspector');
  panel.innerHTML = inspectorMarkup(body, context, header, footer);
  openInspector(context);
  panel.querySelector('.close').onclick = closeInspector;
  bindInspectorEscape();
  normalizeInspectorLayout();
}

export function closeInspector() {
  store.selected = null;
  store.dirty = false;
  paintCanvasFocus(null);
  const panel = $('#inspector');
  const overlay = $('#overlay');
  panel.classList.remove('is-open');
  panel.classList.add('is-closing');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('inspector-open');
  clearTimeout(inspectorCloseTimer);
  inspectorCloseTimer = setTimeout(() => {
    panel.hidden = true;
    overlay.hidden = true;
    panel.classList.remove('is-closing');
    if (inspectorTrigger?.isConnected) inspectorTrigger.focus();
    inspectorTrigger = null;
  }, 220);
}
$('#overlay').onclick = closeInspector;
// While the queue runs, the inspector becomes view-only: every editing control and action
// button is disabled (close/copy/download stay), with a note explaining why.
// `alsoKeep`: controls of steps that touch nothing a queued render depends on (the music node's
// lip-sync preparation), so they stay usable while e.g. a long image batch runs.
// The sets the storyboard is filmed in (or that its shots keep the marks of), each with its 3D
// stage button and how many nodes use it (music node, step 3).
function stageSets() {
  const byId = new Map(store.state.nodes.map(x => [x.id, x]));
  const uses = new Map(); // set id → nodes keeping its marks
  for (const x of store.state.nodes)
    if (x.stagePin) uses.set(x.stagePin.setId, (uses.get(x.stagePin.setId) || 0) + 1);
  const sets = store.state.nodes.filter(
    x =>
      x.zone === 'design' &&
      x.role !== 'angle' &&
      !x.terminal &&
      x.kind !== 'setting' &&
      (uses.has(x.id) ||
        store.state.edges.some(
          e => e.source === x.id && byId.get(e.target)?.zone === 'production',
        )),
  );
  if (!sets.length) return '';
  return (
    '<h3>📌 Ghim vị trí trên sân khấu (3D)</h3>' +
    '<p class="field-hint">Mỗi bối cảnh ghim một lần — đặt từng người đúng chỗ (piano, trống, guitar…). Mọi node quay ở đó tự nhận vị trí, kể cả node thêm hay sửa sau; cỡ cảnh và góc máy tool tự tính theo từng node, nên trái/phải không bị đảo giữa các shot. Dùng node sân khấu 3D riêng cũng được: nối nó vào các shot, hoặc vào bối cảnh của chúng.</p>' +
    `<div class="actions">${sets
      .map(s => {
        const k = s.stage3d?.performers?.length;
        return `<button type="button" class="button" data-stage3d="${esc(s.id)}">${k ? '📌' : '🧍'} ${esc(s.name)} · ${k ? k + ' người · ' + (uses.get(s.id) || 0) + ' node' : 'chưa ghim'}</button>`;
      })
      .join('')}</div>`
  );
}
// The 3D stage editor of a set, loaded on demand (it brings three.js).
export function openStage(setId) {
  closeInspector();
  import('./stage3d.js')
    .then(m => m.openStage3d(setId))
    .catch(e => toast('Không mở được dàn dựng 3D: ' + e.message, true));
}
// Every 🧍 button of the inspector (music step 3, a node's pinned position) opens its set's stage.
$('#inspector').addEventListener('click', e => {
  const b = e.target.closest('[data-stage3d]');
  if (b && !b.disabled) openStage(b.dataset.stage3d);
});
export function lockInspectorIfBusy(alsoKeep = []) {
  if (!workflowBusy()) return;
  const insp = $('#inspector');
  const keep = new Set(['copyImage', 'copyVideo', ...alsoKeep]);
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
  paintCanvasFocus(id);
  store.dirty = false;
  const n = store.state.nodes.find(n => n.id === id),
    shot = n && 'duration' in n && !n.terminal && n.kind !== 'setting';
  if (n.role === 'seedance') {
    openInspector('seedance');
    return inspectGroup(n);
  }
  if (n.role === 'merged') {
    openInspector('merged');
    return inspectMerged(n);
  }
  if (n.kind === 'music') {
    openInspector('music');
    return inspectMusic(n);
  }
  if (n.role === 'lipsync') {
    openInspector('lipsync');
    return inspectLipsync(n);
  }
  if (n.stageOnly) {
    $('#inspector').innerHTML =
      `<div class="inspector-head"><h2>🧍 ${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
      `<div class="inspector-preview">${n.stage3d?.capture ? `<img src="${esc(n.stage3d.capture.url)}" alt="Ảnh toàn cảnh 3D">` : 'Chưa ghim — mở 3D để đặt từng người'}</div>` +
      `<label>Tên node<input id="stageName" value="${esc(n.name)}"></label>` +
      wardrobePanel(n) +
      `<section class="inspector-section"><button class="button wide" id="saveStageName">Lưu tên</button>${id.startsWith('node-') ? '<button class="button wide danger" id="deleteNode">Xóa node này</button>' : ''}</section>`;
    openInspector('stage');
    normalizeInspectorLayout();
    $('.close').onclick = closeInspector;
    if ($('#openStage3d')) $('#openStage3d').onclick = () => openStage(id);
    $('#saveStageName').onclick = async () => {
      try {
        store.state = await api('/api/node', {
          method: 'PATCH',
          body: { id, name: $('#stageName').value },
        });
        render();
        inspect(id);
      } catch (e) {
        toast(e.message, true);
      }
    };
    if ($('#deleteNode')) $('#deleteNode').onclick = () => deleteNode(id);
    return lockInspectorIfBusy();
  }
  if (n.kind === 'setting') {
    const targets = store.state.edges
      .filter(e => e.source === n.id)
      .map(e => store.state.nodes.find(x => x.id === e.target)?.name)
      .filter(Boolean);
    const body =
      `<p class="field-hint">Node ${{ camera: 'máy quay', audio: 'âm thanh' }[n.settingType] || 'style'}: nội dung dưới đây được chèn vào prompt của mọi node bạn nối ra. Nối cổng Ra của node này vào node cần áp.</p>` +
      `<label>Tên<input id="settingName" value="${esc(n.name)}"></label>` +
      `<label>Nội dung ${{ camera: '(mô tả máy quay, góc, ống kính…)', audio: '(nhạc nền + tiếng hiện trường, tiếng Anh: "low cello drone, rain on umbrellas, distant bell; no dialogue")' }[n.settingType] || '(mô tả phong cách, màu, chất liệu…)'}<textarea id="settingConfig" rows="5">${esc(n.config || '')}</textarea></label>` +
      zoneSelect(n) +
      `<p class="field-hint">Đang áp cho: ${targets.length ? esc(targets.join(', ')) : 'chưa nối node nào'}</p>`;
    const icon = { camera: '🎥', audio: '🔊' }[n.settingType] || '🎨';
    $('#inspector').innerHTML =
      inspectorHeader({ eyebrow: 'THIẾT LẬP NODE', title: icon + ' ' + esc(n.name), subtitle: 'Nội dung áp dụng cho node được nối' }) +
      '<div class="inspector-scroll">' + body + '</div>' +
      `<div class="inspector-footer"><button class="button wide primary" id="saveSetting">Lưu</button>${id.startsWith('node-') ? '<button class="button wide danger" id="deleteNode">Xóa node này</button>' : ''}</div>`;
    openInspector('setting');
    normalizeInspectorLayout();
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
      `<div class="inspector-scroll"><p class="field-hint">Phiên bản video${src ? ' từ node “' + esc(src.name) + '”' : ''}. Node này chỉ để xem/tải; tạo lại từ node nguồn.</p>` +
      (stack.length > 1
        ? `<div class="prompt-tools"><button id="clipPrev" ${k > 0 ? '' : 'disabled'}>‹ Bản trước</button><span class="field-hint">bản ${k + 1}/${stack.length}</span><button id="clipNext" ${k < stack.length - 1 ? '' : 'disabled'}>Bản sau ›</button></div>`
        : '') +
      (n.video
        ? `<video controls src="${esc(n.video.url)}" style="width:100%;border-radius:8px"></video><p class="field-hint">Tên file tải về: <code>${esc(downloadName(n))}</code></p><div class="actions"><a class="button" href="${esc(dlUrl(n.video.url, downloadName(n)))}" download="${esc(downloadName(n))}">↓ Tải video</a></div>`
        : '<p>Chưa có video.</p>') +
      '</div><div class="inspector-footer">' +
      `${others.length ? `<button class="button wide" id="keepClip">Giữ bản này, xóa ${others.length} bản khác</button>` : ''}<button class="button wide danger" id="deleteNode">Xóa phiên bản này</button></div>`;
    openInspector('video');
    normalizeInspectorLayout();
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
      `<div class="inspector-head"><h2>${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
      '<div class="inspector-scroll">' +
      `<div class="inspector-preview">${n.image ? `<img src="${esc(n.image.url)}" alt="Ảnh ${esc(n.name)}">` : 'Ảnh của node sẽ xuất hiện ở đây'}</div>` +
      editPanel(n) +
      (n.stale ? '<div class="note">Đầu vào đã đổi. Tạo lại ảnh hoặc tải ảnh đã duyệt trước khi làm video.</div>' : '') +
      `<div class="two"><label>STT trong khu vực<input id="nodeSeq" type="number" min="1" value="${n.seq || ''}"></label><label>Tên node<input id="nodeName" value="${esc(n.name)}"></label></div>` +
      `<p class="field-hint">File tải về của node này: <code>${esc(downloadName({ ...n, terminal: false }, n.video ? 'video' : 'image'))}</code></p>` +
      zoneSelect(n) + sheetPanel(n) + wardrobePanel(n) + inputsSummary(n, shot) + inputChips(n) + stagePanel(n) +
      `<label>Prompt ảnh <code class="variable-tag" title="Biến Orbit nhận khi chạy tác vụ tạo ảnh">{{prompt}}</code><textarea id="imagePrompt" rows="5">${esc(n.resolvedPrompts.image)}</textarea></label>` +
      '<p class="field-hint">Orbit nhận nội dung này qua <code>{{prompt}}</code> hoặc <code>{{mv_prompt}}</code> khi tạo ảnh. Khi tạo video, hai biến này chứa prompt video.</p>' +
      '<div class="prompt-tools"><button id="copyImage">Sao chép prompt</button><button id="resetPrompt">Dùng prompt kế thừa</button></div>' +
      `<div class="actions"><label class="button">↑ Tải ảnh<input type="file" id="imageUpload" accept="image/png,image/jpeg,image/webp" hidden></label><button class="button primary" id="generateImage">${generateLabel(n, 'image')}</button></div>` +
      `<p class="queue-hint">${n.providers.image.type === 'seedvis' ? 'Gửi prompt và ' + imagesSent(n) + ' ảnh đầu vào tới Seedvis · ' + esc(n.providers.image.modelName) + '.' : n.providers.image.type === 'web' ? 'Gửi prompt' + (imagesSent(n) ? ' + ' + imagesSent(n) + ' ảnh đầu vào' : '') + ' sang ChatGPT qua extension (bật worker trong trình duyệt).' : 'Tác vụ sẽ mở nick và chạy kịch bản bằng phiên Orbit đã đăng nhập.'}</p>` +
      (shot ? `<section class="inspector-section"><h3>Video của shot</h3><label>Ảnh đầu vào cho video<select id="videoInput"><option value="self" ${!videoUsesRefs(n) ? 'selected' : ''}>Ảnh của node này (keyframe)</option><option value="refs" ${videoUsesRefs(n) ? 'selected' : ''}>Ảnh từ node nối vào (${n.imageInputs} ảnh tham chiếu${n.videoRefLimit ? ', model nhận tối đa ' + n.videoRefLimit : ''})</option></select></label><p class="field-hint" id="videoInputHint">${esc(videoInputHint(n))}</p><div class="two"><label>Bắt đầu (giây) <code class="variable-tag">{{mv_start}}</code><input id="start" type="number" min="0" value="${n.start}"></label><label>Thời lượng (giây) <code class="variable-tag">{{mv_duration}}</code><input id="duration" type="number" min="1" value="${n.duration}"></label></div><label>Lời hát đúng đoạn này <span class="field-hint">Nhúng trong prompt video, không có biến riêng</span><textarea id="lyric" rows="2" placeholder="Để trống nếu chưa căn lời">${esc(n.lyric)}</textarea></label><details><summary>Prompt chuyển động <code class="variable-tag">{{prompt}}</code></summary><label>Prompt video <code class="variable-tag">{{prompt}}</code><textarea id="videoPrompt" rows="5">${esc(n.resolvedPrompts.video)}</textarea></label><p class="field-hint">Tool tự thêm dòng Reference subjects và Voice lock vào prompt video.</p><button id="copyVideo" class="button">Sao chép</button></details>${videoResults(n)}${n.providers.video.type === 'seedvis' ? `<label>Số phiên bản<select id="nodeVideoVersions"><option value="1">1 bản</option><option value="2">2 bản</option><option value="3">3 bản</option><option value="4">4 bản</option></select></label>` : ''}<div class="actions"><label class="button">↑ Tải video<input type="file" id="videoUpload" accept="video/mp4,video/webm" hidden></label><button class="button primary" id="generateVideo" ${videoReady(n) ? '' : 'disabled'}>${generateLabel(n, 'video')}</button></div></section>` : '') +
      providerSettings(n, shot) +
      (usesOrbit(n, shot) ? outputSettings(n, shot) + orbitSettings(n, shot) : '<details class="inspector-section"><summary>Cài đặt Orbit</summary>' + outputSettings(n, shot) + orbitSettings(n, shot) + '</details>') +
      '</div><div class="inspector-footer"><button class="button wide" id="saveNode">Lưu chỉnh sửa</button>' +
      (id.startsWith('node-') ? '<button class="button wide danger" id="deleteNode">Xóa node này</button>' : '') +
      '</div>';
    openInspector('node');
    normalizeInspectorLayout();
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
  if ($('#openStage3d')) $('#openStage3d').onclick = () => openStage(id);
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
  if (Object.keys(prov.gvids).length) b.gvids = prov.gvids;
  if (Object.keys(prov.musechat).length) b.musechat = prov.musechat;
  if ($('#wardrobeOutfit')) {
    if ($('#wardrobeOutfit').value !== (n.outfit || '')) b.outfit = $('#wardrobeOutfit').value;
    if ($('#wardrobeItems').value !== (n.items || '')) b.items = $('#wardrobeItems').value;
  }
  if ($('#angleText') && $('#angleText').value !== (n.angle || '')) b.angle = $('#angleText').value;
  if ($('#sheetDesc') && $('#sheetDesc').value !== (n.desc || '')) b.desc = $('#sheetDesc').value;
  // (edited = differs from what the box was opened with — the prompt the tool makes may have moved
  // since, e.g. a 3D capture arrived; that is not the user's edit)
  const edited = el => el.value !== el.defaultValue;
  if (edited($('#imagePrompt'))) b.prompt = $('#imagePrompt').value;
  if ($('#lyric')) {
    b.lyric = $('#lyric').value;
    b.start = Number($('#start').value);
    b.duration = Number($('#duration').value);
    if ($('#videoInput').value !== n.videoInput) b.videoInput = $('#videoInput').value;
    if (edited($('#videoPrompt'))) b.videoPrompt = $('#videoPrompt').value;
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
    // a shot on a pinned stage goes out with its 3D capture (taken on its own after any change)
    if (kind === 'image') await capturesReady();
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
    (type === 'seedvis'
      ? ' · Seedvis'
      : type === 'web'
        ? ' · ChatGPT'
        : type === 'gvids'
          ? ' · Google Vids'
          : type === 'musechat'
            ? ' · Muse chat'
            : ' qua Orbit')
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
  return `<p class="field-hint">Đầu vào: 🖼 <b>${n.imageInputs}</b> ảnh tham chiếu (${n.references.length} đã có ảnh)${n.stagePin?.capture === 'sent' ? ' · 📌 +1 ảnh chụp 3D' : ''} · 🎨🎥 <b>${n.settingInputs}</b> style/máy quay${shot && n.videoRefLimit ? ` · model video nhận tối đa ${n.videoRefLimit} ảnh` : ''}${shot && n.videoNeedsKeyframe ? ' · <b>vượt giới hạn → tạo ảnh khung hình trước, video dùng ảnh đó</b>' : ''}</p>`;
}
// The images an image job of this node sends: its references, then its 3D capture.
const imagesSent = n => n.references.length + (n.stagePin?.capture === 'sent' ? 1 : 0);
// A node keeping a pinned stage's marks: the framing the tool chose for it and what goes with
// its prompt. Nothing to set here — the marks are pinned once on the set.
function stagePanel(n) {
  const pin = n.stagePin;
  if (!pin) return '';
  const byId = new Map(store.state.nodes.map(x => [x.id, x]));
  const nameOf = id =>
    String(byId.get(id)?.name || '')
      .split(/\s*[(—–]\s*/)[0]
      .trim() || 'người đã xóa';
  const capture = {
    sent: `✓ Ảnh chụp 3D đúng khung này gửi kèm làm ảnh tham chiếu cuối [${pin.refNo}].`,
    missing: '⏳ Tool đang tự chụp ảnh 3D cho khung này — trong lúc chờ, prompt vẫn có câu vị trí.',
    full: 'Node đã dùng đủ 10 ảnh tham chiếu — chỉ gửi câu vị trí, không gửi ảnh chụp 3D.',
  };
  return (
    `<section class="inspector-section"><h3>📌 Vị trí đã ghim · ${esc(pin.setName)}</h3>` +
    (pin.sig
      ? `<p class="field-hint">Khung hình tool tự chọn: <b>${esc(framingLabel({ size: pin.size, angle: pin.angle, target: pin.target, group: pin.group }, nameOf))}</b> — lấy từ cỡ cảnh, góc máy, chủ thể của chính node này. Prompt ảnh đã có câu vị trí (ai trái/phải, trước/sau, quay mặt hướng nào).</p>` +
        `<p class="field-hint">${capture[pin.capture] || ''}</p>`
      : `<p class="field-hint">Ảnh của node này là cận đồ vật / chi tiết — không cần vị trí.${pin.map ? ' Video của node nhận sơ đồ sân khấu.' : ''}</p>`) +
    `<div class="actions"><button type="button" class="button" data-stage3d="${esc(pin.setId)}">🧍 Sửa vị trí trên sân khấu</button></div></section>`
  );
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

// --- Music node: paste a YouTube link / upload a song, analyze it into the tool's parameters ---
const mmss = s => {
  const n = Number(s);
  if (!Number.isFinite(n)) return esc(String(s ?? ''));
  return Math.floor(n / 60) + ':' + String(Math.round(n % 60)).padStart(2, '0');
};
function musicAnalysisView(a) {
  if (!a || !a.json)
    return '<p class="field-hint">Chưa phân tích. Điền nguồn nhạc ở trên rồi bấm “✦ Phân tích bài hát”.</p>';
  const j = a.json;
  const row = (k, v) =>
    v || v === 0 ? `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>` : '';
  const secs = Array.isArray(j.sections) ? j.sections : [];
  const sectionRows = secs
    .map(
      (s, i) =>
        `<tr><td>${i + 1}</td><td>${esc(s.name || '')}</td><td>${mmss(s.startSec)}–${mmss(s.endSec)}</td><td>${esc(s.energy || '')}</td><td>${esc(String(s.lyric || '').slice(0, 140))}</td></tr>`,
    )
    .join('');
  return (
    `<div class="note">✓ Đã phân tích lúc ${esc(
      String(a.at || '')
        .slice(0, 19)
        .replace('T', ' '),
    )}</div>` +
    '<table class="music-params"><tbody>' +
    row('Tiêu đề', j.title) +
    row('Nghệ sĩ', j.artist) +
    row('Thời lượng (giây)', j.durationSec) +
    row('BPM', j.bpm) +
    row('Nhịp', j.timeSignature) +
    row('Tông', j.key) +
    row('Thể loại', j.genre) +
    row('Mood', j.mood) +
    row('Số shot gợi ý', j.suggestedShots) +
    '</tbody></table>' +
    (j.energyCurve ? `<p class="field-hint"><b>Năng lượng:</b> ${esc(j.energyCurve)}</p>` : '') +
    (secs.length
      ? `<h3>Cấu trúc (${secs.length} đoạn)</h3><table class="music-sections"><thead><tr><th>#</th><th>Đoạn</th><th>Thời gian</th><th>Năng lượng</th><th>Lời</th></tr></thead><tbody>${sectionRows}</tbody></table>`
      : '') +
    (j.styleHints ? `<p class="field-hint"><b>Style:</b> ${esc(j.styleHints)}</p>` : '') +
    (j.cameraHints ? `<p class="field-hint"><b>Camera:</b> ${esc(j.cameraHints)}</p>` : '') +
    (j.notes ? `<p class="field-hint"><b>Ghi chú:</b> ${esc(j.notes)}</p>` : '') +
    `<details><summary>JSON thô</summary><pre class="music-json">${esc(JSON.stringify(j, null, 2))}</pre></details>`
  );
}
// Read a song file's duration in the browser (so the server can anchor the analysis timing).
function readAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.onloadedmetadata = () => {
      const d = audio.duration || 0;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) && d > 0 ? Math.round(d) : null);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Không đọc được thời lượng file nhạc'));
    };
    audio.src = url;
  });
}
async function uploadMusicFile(file, id) {
  if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('File tối đa 100 MB');
    const duration = await readAudioDuration(file).catch(() => null);
    const base64 = await new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(r.result.split(',')[1]);
      r.onerror = no;
      r.readAsDataURL(file);
    });
    store.state = await api('/api/upload', {
      method: 'POST',
      body: { nodeId: id, kind: 'audio', name: file.name, mime: file.type, base64, duration },
    });
    // Separate the vocals of the new song straight away (Demucs, in the background), so they are
    // ready when the shot list is imported.
    let separating = false;
    try {
      store.state = await api('/api/music/vocals', { method: 'POST', body: { id } });
      separating = true;
    } catch {}
    render();
    inspect(id);
    toast(
      'Đã tải nhạc vào node' + (separating ? ' — đang tách vocal (khoảng một phút trên GPU)' : ''),
    );
  } catch (e) {
    toast(e.message, true);
  }
}
function inspectMusic(n) {
  const id = n.id;
  let viaWeb = false;
  try {
    viaWeb = localStorage.getItem('agentViaWeb') === '1';
  } catch {}
  const online = store.state.worker?.online;
  // Shots that came from a CSV import: the cast step designs the performers they need.
  const csvShots = store.state.nodes.filter(
    x => !x.terminal && x.zone === 'production' && Array.isArray(x.parts),
  ).length;
  // The storyboard was built from a CSV but not re-timed to the vocal (its beats carry no sung time).
  const notRetimed = store.state.nodes.filter(
    x =>
      !x.terminal &&
      x.zone === 'production' &&
      Array.isArray(x.parts) &&
      x.parts.some(p => p.sungStart === undefined),
  ).length;
  const ri = n.retimeInfo;
  const task = n.vocalTask || {};
  const separating = task.status === 'running';
  const song = n.audio || store.state.audio;
  $('#inspector').innerHTML =
    inspectorHeader({ eyebrow: 'NHẠC / MV', title: '🎼 ' + esc(n.name), subtitle: 'Phân tích bài hát và dựng shot list' }) +
    '<div class="inspector-scroll">' +
    '<p class="field-hint">Quy trình MV — 3 bước: <b>1</b> Tải nhạc (tool tự tách vocal) → <b>2</b> Viết shot list bằng master prompt, ' +
    'nhập <b>một</b> file CSV (tool tự đọc lời trên vocal bằng GPU, căn timecode, dựng cả hai luồng) → ' +
    '<b>3</b> Tạo hình dàn biểu diễn. Sau đó tạo ảnh và quay như thường.</p>' +
    '<p class="field-hint">Một file CSV sinh ra <b>hai luồng dữ liệu song song</b> để dựng:<br>' +
    '· <b>Luồng A · Phủ cảnh</b> (cột ⑥ → video ⑧): band toàn / trung / cận, nhạc cụ đang chơi, toàn cảnh sân khấu, cảm xúc khán giả — ' +
    'phủ kín cả bài, mỗi shot tối đa 8 giây, các hàng ngắn liền nhau được gộp thành MỘT prompt kèm đủ ảnh tham chiếu.<br>' +
    '· <b>Luồng B · Câu hát nhép</b> (cột ⑪ → video ⑫): từng câu ca sĩ hát, gộp các câu liền nhau cho mỗi take dài 7–10 giây, ' +
    'một cỡ cảnh + một ảnh khung mỗi take, Omni Flash làm ảnh tĩnh + vocal thành clip hát nhép.<br>' +
    'Hai luồng chạy trên cùng một dòng thời gian nên khi dựng có thể cắt qua band ở bất kỳ giây nào. ' +
    'Xem thanh 2 làn dưới canvas; tải bảng kê từng luồng (.csv) ở tab Đạo diễn, bước 4.</p>' +
    '<section class="inspector-section"><h3>Bước 1 · Nhạc</h3>' +
    `<label>Tên<input id="musicName" value="${esc(n.name)}"></label>` +
    `<label>Link YouTube / nhạc<input id="musicUrl" placeholder="https://youtu.be/… hoặc link mp3" value="${esc(n.youtubeUrl || '')}"></label>` +
    `<div class="actions"><label class="button ${n.audio ? '' : 'primary'}">↑ Tải file nhạc<input type="file" id="musicUpload" accept="audio/*" hidden></label>${n.audio ? `<span class="field-hint">🎵 ${esc(n.audio.name)}${n.audioDuration ? ' · ~' + Math.round(n.audioDuration) + ' giây' : ''}</span>` : ''}</div>` +
    (n.audio
      ? `<audio controls src="${esc(n.audio.url)}" style="width:100%;margin-top:6px"></audio>`
      : '') +
    `<label>Lời bài hát đúng như bản thu (mỗi câu một dòng, ghi đủ các lần hát lặp — chép kèm master prompt ở bước 2)<textarea id="musicLyrics" rows="5" placeholder="Dán lời bài hát, mỗi câu một dòng…">${esc(n.lyrics || '')}</textarea></label>` +
    '<div class="actions"><button class="button" id="musicSave">Lưu</button></div>' +
    vocalsStatus(n) +
    '</section>' +
    '<section class="inspector-section"><h3>Bước 2 · Shot list CSV</h3>' +
    '<div class="music-auto"><p class="field-hint"><b>Cách nhanh — một nút:</b> tool tự tách vocal, đo nhạc cụ + Energy, chia hàng theo lời, ' +
    'gọi LLM điền cảm xúc / góc máy / cách hát, tự kiểm và sửa, rồi dựng luôn cả hai luồng. Cần có file nhạc (và nên có lời) ở bước 1' +
    (viaWeb
      ? ' và extension ChatGPT đang bật'
      : ' và API key LLM (hoặc tick “Chạy LLM qua extension” ở bước 3)') +
    '.</p>' +
    '<label>Bối cảnh (tiếng Anh, 2–5 chữ) <input id="musicAutoLoc" placeholder="Dim concert hall stage"></label>' +
    `<div class="actions"><button class="button primary" id="musicAuto" ${song ? '' : 'disabled'}>✨ Tạo storyboard tự động từ nhạc</button></div></div>` +
    '<p class="field-hint" style="margin-top:10px"><b>Hoặc tự viết CSV:</b> bấm <b>Sao chép master prompt</b> (đã kèm tên bài, thời lượng và lời; trước khi gửi có thể sửa 2 dòng ở cuối prompt: “Ý tưởng MV” — mặc định live concert — và “Nhạc cụ” — ghi các nhạc cụ có trong bài, vd piano, guitar, dàn dây) → dán vào ChatGPT cùng file mp3 → ' +
    'tải về <b>một</b> file CSV → <b>Nhập shot list CSV</b>. CSV quyết định mỗi shot quay gì (lời, cảm xúc, bối cảnh, góc máy); ' +
    'tool đọc từng câu trên vocal bằng GPU và <b>dời mỗi hàng về đúng chỗ câu đó được hát</b>, gộp shot phủ cảnh ~8 giây (luồng A), nối nhân vật và bối cảnh, ' +
    'rồi cắt luồng B: các câu hát liền nhau gộp thành take 7–10 giây.</p>' +
    '<div class="actions"><button class="button" id="musicCopyDeep">⧉ Sao chép master prompt</button>' +
    '<label class="button primary">↑ Nhập shot list CSV<input type="file" id="musicCsv" accept=".csv,text/csv" hidden></label></div>' +
    (String(n.lyrics || '').trim()
      ? ''
      : '<div class="note">Chưa có lời bài hát: dán lời chính thức vào ô ở bước 1 trước khi sao chép prompt — tool cần đúng từng chữ để tìm từng câu trên giọng hát (ChatGPT tự nghe lời thường sai).</div>') +
    (song && !n.vocals
      ? `<p class="field-hint">${separating ? '⏳ Vocal đang tách — chọn CSV lúc này thì tool đợi tách xong rồi mới dựng.' : 'Chưa có vocal: khi nhập CSV, tool tách vocal trước (khoảng một phút) rồi mới dựng.'}</p>`
      : '') +
    '<details><summary>Tùy chọn nhập</summary>' +
    '<label>Luồng A · gộp shot phủ cảnh về ~? giây (0 = giữ nguyên từng hàng CSV)<input id="musicTarget" type="number" min="0" max="20" step="1" value="8"></label>' +
    `<label class="music-via"><input type="checkbox" id="musicReplace" ${csvShots ? 'checked' : ''}> Xóa các shot hiện có trước khi nhập (ảnh khung của shot mở đầu cùng hàng CSV được giữ)</label>` +
    '<label class="music-via"><input type="checkbox" id="musicAutoWire" checked> Tự nối nhân vật / bối cảnh theo cột Subject, Location</label>' +
    '<label class="music-via"><input type="checkbox" id="musicTakes" checked> Cắt luôn luồng B · câu hát nhép (cột ⑪) từ các câu hát của bài</label>' +
    '</details>' +
    (notRetimed && n.vocals
      ? `<div class="note">Storyboard hiện có (${notRetimed} shot) dựng theo timecode CSV cũ, chưa căn theo vocal. Nhập lại file CSV (giữ tick “Xóa các shot hiện có”) để dựng lại đúng nhịp bài.</div>`
      : '') +
    (ri
      ? ri.aligned
        ? `<p class="field-hint">✓ Lần nhập gần nhất: GPU đặt ${ri.aligned}/${ri.sungRows} hàng có lời vào đúng chỗ được hát` +
          (ri.unsure ? ` (${ri.unsure} tin cậy thấp)` : '') +
          ` — CSV gốc chỉ ${ri.csvHeld}/${ri.aligned} hàng chứa đúng câu của nó; ${ri.moved} hàng được dời hơn 1 giây (xa nhất ${ri.maxShift} s).</p>`
        : `<div class="note">Lần nhập gần nhất chưa căn được theo vocal (${esc(ri.note || '')}) — timecode giữ theo CSV.</div>`
      : '') +
    (n.lyricTiming?.lines?.length ? lyricTimingView(n) : '') +
    '</section>' +
    '<section class="inspector-section"><h3>Bước 3 · Tạo hình dàn biểu diễn (master prompt MV)</h3>' +
    '<p class="field-hint">Lấy dàn nhân vật (Singer, Pianist, Guitarist…) và các bối cảnh (cột Location) từ storyboard, chạy ' +
    '<b>master prompt MV</b> của project (mặc định “MV ca nhạc (concert)”) để tạo model sheet ca sĩ, nhạc công, ' +
    'bối cảnh và style — <b>gộp thêm</b> vào cột ① ③ ④ (không xóa shot), rồi nối lại từng shot vào đúng nhân vật và bối cảnh. ' +
    'Sau đó: tạo ảnh ① ③ → keyframe / video.</p>' +
    `<label class="music-via"><input type="checkbox" id="musicViaWeb" ${viaWeb ? 'checked' : ''}> Chạy LLM qua extension ChatGPT (không cần API key)${online ? ' · ● worker đang nối' : ''}</label>` +
    `<div class="actions"><button class="button primary" id="musicCast" ${csvShots ? '' : 'disabled'}>✦ Tạo hình dàn biểu diễn</button></div>` +
    (csvShots
      ? `<p class="field-hint">${csvShots} shot từ CSV sẽ được nối lại vào dàn mới.</p>`
      : '<p class="field-hint">Nhập shot list CSV trước để mở nút này.</p>') +
    stageSets() +
    '</section>' +
    lipsyncSection(n, csvShots) +
    '<details class="inspector-section"><summary>Phân tích nhanh bằng LLM (không đọc audio)</summary>' +
    '<p class="field-hint">LLM văn bản đoán cấu trúc / thời lượng / nhịp từ tên bài, link và lời — không nghe được nhạc, chỉ để tham khảo.</p>' +
    '<div class="actions"><button class="button" id="musicAnalyze">✦ Phân tích bài hát</button></div>' +
    musicAnalysisView(n.analysis) +
    '</details>' +
    '</div>' +
    (id.startsWith('node-')
      ? '<div class="inspector-footer"><button class="button wide danger" id="deleteNode">Xóa node này</button></div>'
      : '');
  openInspector('music');
  normalizeInspectorLayout();
  $('#musicUpload').onchange = e => uploadMusicFile(e.target.files[0], id);
  const saveMusic = () =>
    api('/api/node', {
      method: 'PATCH',
      body: {
        id,
        name: $('#musicName').value,
        youtubeUrl: $('#musicUrl').value,
        lyrics: $('#musicLyrics').value,
      },
    });
  $('#musicSave').onclick = async () => {
    try {
      store.state = await saveMusic();
      render();
      inspect(id);
      toast('Đã lưu');
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#musicViaWeb').onchange = () => {
    try {
      localStorage.setItem('agentViaWeb', $('#musicViaWeb').checked ? '1' : '0');
    } catch {}
  };
  $('#musicAnalyze').onclick = async () => {
    const btn = $('#musicAnalyze');
    btn.disabled = true;
    btn.textContent = '⏳ Đang phân tích…';
    try {
      store.state = await saveMusic();
      store.state = await api('/api/music/analyze', {
        method: 'POST',
        body: { id, via: $('#musicViaWeb').checked ? 'web' : 'api' },
      });
      render();
      inspect(id);
      toast('Đã phân tích bài hát');
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '✦ Phân tích bài hát';
    }
  };
  $('#musicCopyDeep').onclick = async () => {
    try {
      // the lyrics box as typed goes into the prompt
      if ($('#musicLyrics').value !== (n.lyrics || '')) store.state = await saveMusic();
      const r = await api('/api/music/deep-prompt?id=' + encodeURIComponent(id));
      copy(r.prompt);
    } catch (e) {
      toast(e.message, true);
    }
  };
  if ($('#musicAuto'))
    $('#musicAuto').onclick = async () => {
      const btn = $('#musicAuto');
      const replace = store.state.nodes.some(
        x => !x.terminal && x.zone === 'production' && Array.isArray(x.parts),
      );
      if (
        replace &&
        !confirm('Tạo tự động sẽ dựng lại storyboard và xóa các shot hiện có. Tiếp tục?')
      )
        return;
      btn.disabled = true;
      btn.textContent = '⏳ Tách vocal, đo nhạc, gọi LLM… (vài phút)';
      try {
        if ($('#musicLyrics').value !== (n.lyrics || '')) store.state = await saveMusic();
        // 1) analyze + skeleton + LLM fill + validate → the final CSV
        store.state = await api('/api/music/auto', {
          method: 'POST',
          body: {
            id,
            via: $('#musicViaWeb')?.checked ? 'web' : 'api',
            location: $('#musicAutoLoc')?.value || '',
          },
        });
        const a = store.state.autoSummary;
        if (!a?.csv) throw new Error('Không nhận được CSV từ bước tạo tự động.');
        // 2) import that CSV the usual way (re-times to the vocal, builds luồng A + luồng B)
        btn.textContent = '⏳ Đọc lời trên vocal & dựng hai luồng…';
        store.state = await api('/api/music/import', {
          method: 'POST',
          body: { id, csv: a.csv, replaceShots: true, autoWire: true, takes: true },
        });
        const sum = store.state.importSummary || {};
        render();
        closeInspector();
        view('studio');
        toast(
          `✨ Tự động: ${a.instruments?.length ? a.instruments.join(', ') : 'không rõ nhạc cụ'} · bài ${a.feel === 'nhanh' ? 'nhanh' : 'chậm'} · ` +
            `${a.rows} hàng${a.tries > 1 ? ` (LLM sửa ${a.tries - 1} vòng)` : ''}${a.remaining ? ` · ⚠ còn ${a.remaining} chỗ chưa chuẩn` : ''} → ${sum.created || 0} shot phủ cảnh` +
            (sum.takes && !sum.takes.error ? ` + ${sum.takes.takes || 0} take hát nhép` : '') +
            '. Tiếp: bước 3 tạo hình dàn biểu diễn.',
          !a.ok,
        );
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
        btn.textContent = '✨ Tạo storyboard tự động từ nhạc';
      }
    };
  $('#musicCsv').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const replaceShots = !!$('#musicReplace')?.checked;
    if (
      replaceShots &&
      !confirm(
        'Xóa các shot hiện có rồi dựng lại storyboard từ CSV?\nẢnh khung của shot mở đầu cùng hàng CSV được giữ; video của các shot cũ bị bỏ (file đã xuất vẫn còn trong thư mục làm việc).',
      )
    )
      return;
    const btnLabel = e.target.closest('label');
    try {
      const csv = await file.text();
      const targetSeconds = Math.max(0, Number($('#musicTarget')?.value) || 0);
      // No vocal yet (an older song, or a separation that failed): separate first — the import
      // waits for it, then reads the lyrics on it.
      const cur = store.state.nodes.find(x => x.id === id);
      if (song && !cur?.vocals && cur?.vocalTask?.status !== 'running')
        store.state = await api('/api/music/vocals', { method: 'POST', body: { id } });
      const waiting = !store.state.nodes.find(x => x.id === id)?.vocals && !!song;
      if (btnLabel)
        btnLabel.firstChild.textContent = waiting
          ? '⏳ Đang tách vocal, đọc lời & dựng…'
          : '⏳ Đang đọc lời trên vocal & dựng…';
      store.state = await api('/api/music/import', {
        method: 'POST',
        body: {
          id,
          csv,
          replaceShots,
          targetSeconds,
          autoWire: $('#musicAutoWire')?.checked !== false,
          takes: $('#musicTakes')?.checked !== false,
        },
      });
      const sum = store.state.importSummary;
      render();
      if (sum?.kind === 'shots') {
        closeInspector();
        view('studio');
        const rt = sum.retime,
          tk = sum.takes;
        toast(
          `${sum.rows} hàng CSV → ${sum.created} shot${sum.target > 0 ? ' (gộp ~' + sum.target + 's)' : ''}` +
            (sum.skipped ? ` · ⚠ bỏ ${sum.skipped} hàng thiếu Start/End hợp lệ` : '') +
            (sum.lyricsCheck && !sum.lyricsCheck.ok
              ? ` · ⚠ lời trong CSV khác lời chính thức từ từ thứ ${sum.lyricsCheck.at + 1}: “${sum.lyricsCheck.csv || '(hết)'}” ≠ “${sum.lyricsCheck.official || '(hết)'}” — sửa CSV rồi nhập lại`
              : '') +
            (rt
              ? rt.aligned
                ? ` · GPU căn ${rt.aligned}/${rt.sungRows} hàng có lời theo vocal (${rt.moved} hàng dời >1s, xa nhất ${rt.maxShift}s)` +
                  (rt.dropped
                    ? ` · bỏ ${rt.dropped} hàng không lời bị kẹp giữa hai câu hát liền nhau`
                    : '')
                : ` · ⚠ chưa căn được theo vocal (${rt.note}) — giữ timecode CSV`
              : ' · ⚠ chưa có vocal — giữ timecode CSV') +
            (tk?.error
              ? ` · ⚠ chưa tạo take lip-sync: ${tk.error}`
              : tk
                ? ` · ${tk.takes} take lip-sync (${tk.created} mới)`
                : '') +
            (sum.keyframesHad ? ` · giữ ${sum.keyframesKept}/${sum.keyframesHad} ảnh khung` : '') +
            (sum.wired ? ` · nối ${sum.wired} shot vào tham chiếu` : '') +
            '. Bấm “Sắp xếp theo khu vực” để xếp theo thời gian.',
          !rt?.aligned || !!tk?.error || !!sum.skipped || sum.lyricsCheck?.ok === false,
        );
      } else {
        inspect(id);
        toast(`Đã nhập ${sum?.sections || 0} đoạn lời (cấu trúc bài hát)`);
      }
    } catch (err) {
      toast(err.message, true);
      inspect(id);
    }
  };
  $('#musicCast').onclick = async () => {
    const btn = $('#musicCast');
    btn.disabled = true;
    btn.textContent = '⏳ Đang tạo hình…';
    try {
      store.state = await api('/api/music/cast', {
        method: 'POST',
        body: { id, via: $('#musicViaWeb').checked ? 'web' : 'api' },
      });
      const c = store.state.castSummary || {};
      render();
      closeInspector();
      view('studio');
      toast(
        `Đã thêm ${c.characters || 0} nhân vật · ${c.scenes || 0} bối cảnh` +
          (c.kept ? ` · giữ ${c.kept} asset có sẵn` : '') +
          (['added', 'updated'].includes(c.style) ? ' · style MV' : '') +
          (c.removedPlaceholders ? ` · bỏ ${c.removedPlaceholders} node mẫu trống` : '') +
          ` · nối lại ${c.rewired || 0}/${c.shots || 0} shot. Tiếp: tạo ảnh khu ① Nhân vật + ③ Bối cảnh.`,
      );
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '✦ Tạo hình dàn biểu diễn';
    }
  };
  bindLipsyncSection(n);
  if ($('#deleteNode')) $('#deleteNode').onclick = () => deleteNode(id);
  // Separating the vocals, copying the prompt, refreshing the beats and cutting the takes touch no
  // queued render.
  lockInspectorIfBusy(['lsSeparate', 'musicCopyDeep', 'lsRefreshCsv', 'lsMake']);
}

// --- Lip-sync with Omni Flash: vocals → cut every sung line → keyframe + vocal → Omni ----------
const clock = s => {
  const v = Number(s) || 0,
    m = Math.floor(v / 60);
  return String(m).padStart(2, '0') + ':' + (v - m * 60).toFixed(3).padStart(6, '0');
};
const takesOf = musicId =>
  store.state.nodes.filter(x => x.role === 'lipsync' && x.musicId === musicId);
// The song's vocals (Demucs, on this machine — started by itself when the song is uploaded): where
// the separation is, the vocal to listen to, and a retry.
function vocalsStatus(n) {
  const task = n.vocalTask || {};
  const running = task.status === 'running';
  const song = n.audio || store.state.audio;
  if (!song) return '';
  return (
    (running
      ? `<div class="note">⏳ Đang tách vocal… ${task.progress || 0}% (Demucs, khoảng một phút trên GPU)</div>`
      : n.vocals
        ? `<p class="field-hint">✓ Vocal đã tách${task.model ? ' · ' + esc(task.model) : ''}</p><audio controls src="${esc(n.vocals.url)}" style="width:100%"></audio>`
        : task.status === 'failed'
          ? `<div class="note">Tách vocal lỗi: ${esc(task.error || '')}</div>`
          : '<p class="field-hint">Chưa tách vocal.</p>') +
    (running
      ? ''
      : `<div class="actions"><button class="button" id="lsSeparate">${n.vocals ? '↻ Tách lại vocal' : 'Tách vocal'}</button></div>`)
  );
}
// The GPU reading of every sung line (made at the last import): where each is really sung, where
// the CSV had it, the confidence — as a table and a LYRIC TIMING download.
function lyricTimingView(n) {
  const lt = n.lyricTiming;
  const rows = lt.lines
    .map((l, i) => {
      const d = l.start !== null && l.csvStart !== undefined ? l.start - l.csvStart : null;
      return (
        `<tr><td>${i + 1}</td>` +
        `<td>${l.start === null ? '—' : clock(l.start) + ' → ' + clock(l.end)}</td>` +
        `<td>${l.csvStart === undefined ? '—' : clock(l.csvStart)}</td>` +
        `<td>${d === null ? '—' : (Math.abs(d) > 1 ? '⚠ ' : '') + (d > 0 ? '+' : '') + d.toFixed(1) + 's'}</td>` +
        `<td>${l.score === null ? '—' : Math.round(l.score * 100) + '%' + (l.score < 0.5 ? ' ⚠' : '')}</td>` +
        `<td>${esc(String(l.text).slice(0, 60))}</td></tr>`
      );
    })
    .join('');
  return (
    `<details><summary>Bảng timecode GPU — ${lt.aligned}/${lt.lines.length} câu đọc được trên vocal (${esc(lt.lang || '')})` +
    (lt.csvOff ? ` · CSV lệch >1 s ở ${lt.csvOff} câu (xa nhất ${lt.csvOffMax} s)` : '') +
    '</summary>' +
    `<div class="actions"><a class="button" href="/api/music/lyric-timing.csv?id=${encodeURIComponent(n.id)}">↓ Tải LYRIC TIMING (GPU) .csv</a></div>` +
    `<div class="music-scroll"><table class="music-sections"><thead><tr><th>#</th><th>GPU (giọng thật)</th><th>CSV</th><th>Lệch</th><th>Tin cậy</th><th>Lời</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
  );
}
// Lip-sync with Omni Flash — one take per sung line (cut on the vocal; made by the CSV import),
// the takes' keyframes, then the ready takes filmed by Omni Flash (keyframe + vocal → video-to-video).
function lipsyncSection(n, csvShots) {
  const takes = takesOf(n.id);
  const withImage = takes.filter(t => t.image).length;
  const filmed = takes.filter(t => videosOf(t).length).length;
  const ready = takes.filter(t => t.image && !t.stale && !videosOf(t).length).length;
  // A storyboard imported before its beats carried their time, line and lip-sync flag.
  const old = store.state.nodes.filter(
    x =>
      !x.terminal &&
      x.zone === 'production' &&
      Array.isArray(x.parts) &&
      x.parts.some(p => !('start' in p) || !('lipSync' in p)),
  ).length;
  return (
    '<section class="inspector-section"><h3>🎤 Luồng B · Câu hát nhép (Omni Flash)</h3>' +
    '<p class="field-hint">Luồng B chạy <b>song song</b> với luồng A (phủ cảnh ở cột ⑥), trên cùng dòng thời gian của bài. ' +
    'Tool cắt từ <b>mọi câu hát</b> của bài — không chỉ các hàng Lip Sync = YES — rồi gộp các câu liền nhau cho mỗi take dài <b>7–10 giây</b>; ' +
    'mỗi take một cỡ cảnh, một ảnh khung. Tạo ảnh khung ca sĩ cho các take → <b>ghép ảnh + vocal</b> thành video nguồn và gửi Omni Flash ' +
    '(video-to-video): ca sĩ hát nhép đúng đoạn vocal đó, clip dài đúng bằng đoạn cắt. Omni đắt ~10× Veo mỗi clip.</p>' +
    (old
      ? `<div class="note">Storyboard được nhập từ bản cũ: ${old}/${csvShots} shot chưa lưu thời gian từng câu, nên chưa cắt được câu lip-sync. ` +
        'Nên nhập lại CSV ở bước 2 để dựng lại storyboard theo vocal. Hoặc chọn lại file <b>MASTER SHOT LIST</b> (.csv) dưới đây — tool gán lại các câu vào đúng shot theo mốc thời gian, ' +
        'giữ nguyên shot, ảnh, video và dây nối' +
        (n.vocals ? ', rồi tự tạo take.' : '.') +
        '</div><div class="actions"><label class="button">↑ Cập nhật thời gian từng câu từ CSV' +
        '<input type="file" id="lsRefreshCsv" accept=".csv,text/csv" hidden></label></div>'
      : '') +
    (n.lipsyncInfo && takes.length ? alignPanel(n.lipsyncInfo) : '') +
    (takes.length
      ? `<p class="field-hint">${takes.length} take · ${withImage} có ảnh khung · ${filmed} đã có video lip-sync. ` +
        takeLengths(takes) +
        '</p>' +
        '<div class="actions">' +
        `<button class="button" id="lsImages" ${withImage < takes.length ? '' : 'disabled'}>Tạo ảnh khung các take</button>` +
        `<button class="button primary" id="lsRender" ${ready ? '' : 'disabled'}>Quay lip-sync Omni (${ready} take)</button>` +
        '</div>'
      : '') +
    '<div class="actions">' +
    `<button class="button" id="lsMake" ${n.vocals && csvShots && n.vocalTask?.status !== 'running' && !old ? '' : 'disabled'}>${takes.length ? '↻ Cắt lại luồng B theo vocal' : 'Cắt luồng B · câu hát nhép 7–10s'}</button>` +
    '</div>' +
    '</section>'
  );
}
// How long luồng B's takes came out, and how much of the song they hold: the 7–10 s window is the
// point of merging the lines, so the user sees at once whether a take fell short of it.
function takeLengths(takes) {
  const lens = takes
    .map(t => nodeTime(t))
    .filter(Boolean)
    .map(([a, b]) => b - a);
  if (!lens.length) return '';
  const total = lens.reduce((s, v) => s + v, 0);
  const short = lens.filter(v => v < 7).length;
  return (
    `Dài ${Math.min(...lens).toFixed(1)}–${Math.max(...lens).toFixed(1)} s, tổng ${Math.round(total)} s hát nhép` +
    (short ? ` · ⚠ ${short} take ngắn hơn 7 s (câu đứng một mình, không gộp được).` : '.')
  );
}
// What reading the vocal found: lines placed by forced alignment, and how far the storyboard (an
// LLM's estimate) had them from where the voice really is.
function alignPanel(i) {
  if (!i.aligned)
    return `<div class="note">Chưa căn được lời vào vocal (${esc(i.alignNote || 'không rõ lý do')}) — các take dùng mốc CSV, chỉ tinh chỉnh ±0.5 s theo giọng.</div>`;
  return (
    `<p class="field-hint">✓ Căn lời theo vocal: ${i.aligned}/${i.takes} câu lip-sync đặt đúng chỗ giọng thật` +
    (i.unsure ? ` · ${i.unsure} câu tin cậy thấp (xem lại trong take)` : '') +
    '.</p>' +
    (i.csvOff
      ? `<div class="note">⚠ ${i.csvOff}/${i.sungLines} câu của storyboard ở cột ⑥ lệch hơn 1 giây so với chỗ ca sĩ thật sự hát (lệch nhiều nhất ${i.csvOffMax} s). ` +
        'Các take đã cắt theo giọng thật; nhập lại CSV ở bước 2 để dời cả storyboard theo vocal.</div>'
      : '')
  );
}
function bindLipsyncSection(n) {
  const id = n.id;
  if (n.vocalTask?.status === 'running')
    // Follow the separation while this inspector stays open (and nobody is typing in it).
    setTimeout(async () => {
      if (store.selected !== id || $('#inspector').contains(document.activeElement)) return;
      try {
        await refresh();
        if (store.selected === id) inspect(id);
      } catch {}
    }, 2000);
  const run = (sel, busyText, fn) => {
    const btn = $(sel);
    if (!btn) return;
    btn.onclick = async () => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = busyText;
      try {
        await fn();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
        btn.textContent = label;
      }
    };
  };
  run('#lsSeparate', '⏳ Đang bắt đầu…', async () => {
    store.state = await api('/api/music/vocals', { method: 'POST', body: { id } });
    render();
    inspect(id);
    toast('Đang tách vocal (Demucs) — khoảng một phút cho cả bài trên GPU.');
  });
  const makeTakes = async (prefix = '') => {
    // re-cutting merges the sung lines into 7–10s takes anew: a keyframe-only take whose line moved
    // into another window is dropped (a take that already has a video is kept). Warn once.
    const withImg = store.state.nodes.filter(
      n => n.role === 'lipsync' && n.musicId === id && n.image && !n.video,
    ).length;
    if (
      withImg &&
      !confirm(
        `Cắt lại luồng B sẽ gộp các câu hát thành take 7–10s. ${withImg} take đang có ảnh khung — ` +
          'take nào không còn khớp cửa sổ mới sẽ bị bỏ (take đã có video thì giữ lại). Tiếp tục?',
      )
    )
      return;
    store.state = await api('/api/music/lipsync', { method: 'POST', body: { id } });
    const s = store.state.lipsyncSummary || {};
    render();
    inspect(id);
    toast(
      prefix +
        `${s.sungLines ?? s.takes} câu hát → ${s.takes} take 7–10s (${s.created} mới${s.updated ? ', ' + s.updated + ' cập nhật' : ''})` +
        (s.short ? ` · ⚠ ${s.short} take dưới 7s` : '') +
        (s.capped ? ` · ${s.capped} take chạm trần 10s` : '') +
        (s.aligned
          ? ` · căn lời theo vocal ${s.aligned}/${s.sungLines ?? s.aligned} câu${s.unsure ? ` (${s.unsure} tin cậy thấp)` : ''}`
          : ` · ⚠ chưa căn lời: ${s.alignNote || 'không rõ'}`) +
        (s.csvOff
          ? ` · ${s.csvOff}/${s.sungLines} câu CSV lệch >1s (tối đa ${s.csvOffMax}s)`
          : '') +
        (s.quiet ? ` · ⚠ ${s.quiet} take nghe ít giọng` : '') +
        (s.removedWithImage ? ` · ⚠ bỏ ${s.removedWithImage} take đã có ảnh khung` : '') +
        (s.filmedKept ? ` · giữ ${s.filmedKept} take đã có video (kiểm tra lại)` : '') +
        ` · tổng ~${s.seconds}s gửi Omni.`,
      !s.aligned || !!s.quiet || !!s.removedWithImage,
    );
  };
  run('#lsMake', '⏳ Đang đọc vocal…', () => makeTakes());
  // Old storyboard: give its shots their beats back from the CSV (nothing else changes), then
  // cut the takes straight away when the vocals are ready.
  if ($('#lsRefreshCsv'))
    $('#lsRefreshCsv').onchange = async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        store.state = await api('/api/music/refresh-beats', {
          method: 'POST',
          body: { id, csv: await file.text() },
        });
        const r = store.state.refreshSummary || {};
        const head =
          `Đã cập nhật ${r.matched}/${r.total} shot (${r.lines} câu hát)` +
          (r.missed?.length ? ` · ${r.total - r.matched} shot không khớp: ${r.missed[0]}…` : '') +
          '. ';
        render();
        if (store.state.nodes.find(x => x.id === id)?.vocals) await makeTakes(head);
        else {
          inspect(id);
          toast(head + 'Tách vocal (bước 1) rồi bấm “Tạo take lip-sync”.');
        }
      } catch (err) {
        toast(err.message, true);
        inspect(id);
      }
    };
  run('#lsImages', '⏳ Đang xếp hàng…', async () => {
    await capturesReady();
    store.state = await api('/api/auto/images/start', {
      method: 'POST',
      body: { zone: 'lipsync' },
    });
    render();
    closeInspector();
    view('queue');
    toast('Đang tạo ảnh khung cho các take lip-sync');
  });
  run('#lsRender', '⏳ Đang xếp hàng…', async () => {
    const ready = takesOf(id).filter(t => t.image && !t.stale && !videosOf(t).length).length;
    if (!confirm(`Gửi ${ready} take sang Omni Flash (video-to-video)? Mỗi clip Omni đắt ~10× Veo.`))
      throw new Error('Đã hủy.');
    store.state = await api('/api/music/lipsync-render', { method: 'POST', body: { id } });
    const r = store.state.lipsyncRender || {};
    await refresh();
    closeInspector();
    view('queue');
    toast(
      `Đã xếp ${r.queued} take vào hàng đợi Omni` +
        (r.errors?.length ? ` · ${r.errors.length} lỗi: ${r.errors[0]}` : ''),
      !!r.errors?.length,
    );
  });
}
// One lip-sync take: its line, where the vocal really is, the cut sent to Omni (adjustable), its
// keyframe, the source video (keyframe + vocal) to check, and the Omni render.
function inspectLipsync(n) {
  const id = n.id;
  const music = store.state.nodes.find(x => x.id === n.musicId);
  const sig = [n.image?.id, music?.vocals?.id, n.clipStart, n.clipEnd].join('|');
  const inputCurrent = n.lsInput && n.lsInputSig === sig;
  const dur = (n.clipEnd || 0) - (n.clipStart || 0);
  const edge = ok => (ok ? '✓' : n.align ? '· giữ mốc căn lời' : '· giữ mốc CSV');
  $('#inspector').innerHTML =
    inspectorHeader({ eyebrow: 'HÁT NHÉP / TAKE', title: '🎤 ' + esc(n.name), subtitle: 'Chi tiết câu hát và video đầu ra' }) +
    '<div class="inspector-scroll">' +
    '<p class="field-hint">Take của <b>luồng B · câu hát nhép</b> (chạy song song với luồng A phủ cảnh ở cột ⑥): Omni Flash (video-to-video) ' +
    'làm ca sĩ hát nhép đúng đoạn vocal tách riêng của (các) câu này — một cỡ cảnh, một ảnh khung cho cả take. ' +
    'Video nguồn = ảnh khung (ca sĩ, miệng khép) + đoạn vocal cắt bên dưới; clip trả về dài đúng bằng đoạn cắt — đặt vào timeline tại mốc “Bắt đầu đoạn”.</p>' +
    `<div class="inspector-preview">${n.image ? `<img src="${esc(n.image.url)}" alt="Ảnh ${esc(n.name)}">` : 'Ảnh khung (ca sĩ) sẽ xuất hiện ở đây'}</div>` +
    (n.stale ? '<div class="note">Đầu vào đã đổi. Tạo lại ảnh khung trước khi quay.</div>' : '') +
    '<table class="music-params"><tbody>' +
    `<tr><td>Câu hát</td><td>“${esc(n.lyric || '')}”</td></tr>` +
    `<tr><td>Theo CSV</td><td>${clock(n.csvStart)} → ${clock(n.csvEnd)}</td></tr>` +
    `<tr><td>Căn lời theo vocal</td><td>${n.align ? `${clock(n.align.start)} → ${clock(n.align.end)} · tin cậy ${Math.round((n.align.score || 0) * 100)}%${n.align.score < 0.5 ? ' ⚠ thấp — nghe lại video nguồn' : ''}` : 'không căn được — dùng mốc CSV'}</td></tr>` +
    `<tr><td>Mép giọng thật (đọc vocal)</td><td>${clock(n.lsStart)} ${edge(n.snappedStart)} → ${clock(n.lsEnd)} ${edge(n.snappedEnd)}</td></tr>` +
    `<tr><td>Có giọng hát</td><td>${Math.round((n.voiced || 0) * 100)}%${n.voiced < 0.3 ? ' ⚠ ít giọng — kiểm tra mốc cắt' : ''}</td></tr>` +
    `<tr><td>Đoạn gửi Omni</td><td>${clock(n.clipStart)} → ${clock(n.clipEnd)} (${dur.toFixed(2)} s)</td></tr>` +
    '</tbody></table>' +
    `<div class="two"><label>Bắt đầu đoạn (giây)<input id="lsClipStart" type="number" step="0.01" min="0" value="${n.clipStart}"></label>` +
    `<label>Kết thúc đoạn (giây)<input id="lsClipEnd" type="number" step="0.01" min="0" value="${n.clipEnd}"></label></div>` +
    '<div class="actions"><button class="button" id="lsSaveCut">Lưu đoạn cắt</button></div>' +
    (dur > 10
      ? '<p class="field-hint">⚠ Đoạn dài hơn 10 giây — ngoài khoảng 7–10 s của luồng B; nếu Omni từ chối thời lượng, rút ngắn đoạn cắt.</p>'
      : dur < 7
        ? '<p class="field-hint">Đoạn ngắn hơn 7 giây — câu này không gộp được với câu liền kề (khoảng nghỉ quá dài).</p>'
        : '') +
    (n.lsNote ? `<p class="field-hint">${esc(n.lsNote)}</p>` : '') +
    (Array.isArray(n.lsLines) && n.lsLines.length > 1
      ? `<p class="field-hint">${n.lsLines.length} câu trong take này: ${esc(n.lsLines.map(l => `${l.at}s “${String(l.lyric).slice(0, 24)}”`).join(' · '))}</p>`
      : '') +
    inputChips(n) +
    stagePanel(n) +
    `<label>Prompt ảnh khung<textarea id="lsImagePrompt" rows="4">${esc(n.resolvedPrompts.image)}</textarea></label>` +
    `<div class="actions"><label class="button">↑ Tải ảnh<input type="file" id="imageUpload" accept="image/png,image/jpeg,image/webp" hidden></label><button class="button primary" id="generateImage">${generateLabel(n, 'image')}</button></div>` +
    '<section class="inspector-section"><h3>Video lip-sync · Omni Flash</h3>' +
    (inputCurrent
      ? `<p class="field-hint">Video nguồn (ảnh + vocal) — nghe thử đúng câu chưa trước khi gửi Omni:</p><div class="video-result"><video controls src="${esc(n.lsInput.url)}"></video></div><div class="actions"><a class="button" href="${esc(dlUrl(n.lsInput.url, n.name.replace(/[^\w.\- ]+/g, '_') + '-input.mp4'))}">↓ Tải video nguồn</a></div>`
      : `<p class="field-hint">${n.lsInput ? 'Ảnh khung hoặc đoạn cắt đã đổi — ghép lại để xem.' : 'Chưa ghép video nguồn.'} Khi bấm Tạo video, tool tự ghép lại.</p>`) +
    `<div class="actions"><button class="button" id="lsBuildInput" ${n.image ? '' : 'disabled'}>🎬 Ghép ảnh + vocal (xem trước)</button></div>` +
    `<details><summary>Prompt gửi Omni</summary><textarea id="lsVideoPrompt" rows="6">${esc(n.videoPrompt || '')}</textarea><div class="actions"><button class="button" id="lsSavePrompt">Lưu prompt</button></div></details>` +
    '<label>Số phiên bản<select id="nodeVideoVersions"><option value="1">1 bản</option><option value="2">2 bản</option><option value="3">3 bản</option><option value="4">4 bản</option></select></label>' +
    `<div class="actions"><button class="button primary" id="generateVideo" ${n.image && !n.stale ? '' : 'disabled'}>Tạo video lip-sync · Omni Flash</button></div>` +
    videoResults(n) +
    '</section>' +
    '</div>' +
    '<div class="inspector-footer"><button class="button wide danger" id="deleteNode">Xóa take này</button></div>';
  openInspector('lipsync');
  normalizeInspectorLayout();
  const patch = async (b, msg) => {
    try {
      store.state = await api('/api/node', { method: 'PATCH', body: { id, ...b } });
      render();
      inspect(id);
      if (msg) toast(msg);
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#lsSaveCut').onclick = () =>
    patch(
      { clipStart: Number($('#lsClipStart').value), clipEnd: Number($('#lsClipEnd').value) },
      'Đã lưu đoạn cắt',
    );
  $('#lsSavePrompt').onclick = () =>
    patch({ videoPrompt: $('#lsVideoPrompt').value }, 'Đã lưu prompt');
  $('#imageUpload').onchange = e => upload(e.target.files[0], id, 'image');
  $('#generateImage').onclick = async () => {
    // a prompt edited here goes with the render
    if ($('#lsImagePrompt').value !== $('#lsImagePrompt').defaultValue)
      try {
        store.state = await api('/api/node', {
          method: 'PATCH',
          body: { id, prompt: $('#lsImagePrompt').value },
        });
      } catch (e) {
        return toast(e.message, true);
      }
    generate(id, 'image');
  };
  $('#lsBuildInput').onclick = async () => {
    const btn = $('#lsBuildInput');
    btn.disabled = true;
    btn.textContent = '⏳ Đang ghép…';
    try {
      store.state = await api('/api/music/lipsync-input', { method: 'POST', body: { id } });
      render();
      inspect(id);
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '🎬 Ghép ảnh + vocal (xem trước)';
    }
  };
  $('#generateVideo').onclick = () => generate(id, 'video');
  document
    .querySelectorAll('#inspector [data-open]')
    .forEach(e => (e.onclick = () => inspect(e.dataset.open)));
  document
    .querySelectorAll('#inspector [data-cut]')
    .forEach(e => (e.onclick = () => cutInput(e.dataset.cut, id)));
  $('#deleteNode').onclick = () => deleteNode(id);
  lockInspectorIfBusy();
}
