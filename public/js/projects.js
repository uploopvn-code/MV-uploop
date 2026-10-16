// Projects: create/switch/open windows, working folders, backup, brief and settings.
import { store } from './store.js';
import { $, api, esc, toast, triggerDownload } from './core.js';
import { gallerySel } from './gallery.js';
import { closeInspector, normalizeInspectorLayout, openInspector } from './inspector.js';
import { render } from './render.js';
import { t as tx } from './i18n.js';

const themeLabel = id => (store.state.themes || []).find(t => t.id === id)?.label || id;
// The saved user templates, as rows in the project-settings dialog (with a delete button each).
const templateRows = () =>
  (store.state.templates || [])
    .map(
      t =>
        `<li><span>${esc(t.name)} · ${esc(themeLabel(t.theme))} · ${t.nodeCount} node</span> <button type="button" class="link" data-del-template="${t.id}">🗑 ${tx('project.delete')}</button></li>`,
    )
    .join('') || `<li class="field-hint">${tx('project.noTemplates')}</li>`;
// Redraws the template list and (re)binds each delete button to remove that template.
function bindTemplateList() {
  const list = $('#templateList');
  if (!list) return;
  list.innerHTML = templateRows();
  document.querySelectorAll('[data-del-template]').forEach(
    b =>
      (b.onclick = async () => {
        if (!confirm(tx('project.deleteTemplateConfirm'))) return;
        try {
          const r = await api('/api/templates/delete', {
            method: 'POST',
            body: { id: b.dataset.delTemplate },
          });
          store.state.templates = r.templates;
          bindTemplateList();
          toast(tx('project.templateDeleted'));
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}
export function renderProjects() {
  const sel = $('#projectSelect');
  // A project open in another window cannot be switched into here (the server refuses).
  sel.innerHTML = (store.state.projects || [])
    .map(
      p =>
        `<option value="${p.id}" ${p.id === store.state.activeProjectId ? 'selected' : ''} ${p.window ? 'disabled' : ''}>${esc(p.name)} · ${esc(themeLabel(p.theme))}${p.window ? ' · ' + tx('project.openAtPort') + ' ' + p.window : ''}</option>`,
    )
    .join('');
  const win = store.state.window || {};
  document.querySelector('.eyebrow').textContent =
    (win.child
      ? tx('project.childWindow') + ' · ' + tx('project.port') + ' ' + win.port + ' / '
      : 'WORKSPACE / ') + themeLabel(store.state.theme).toUpperCase();
  // A secondary window works on its one project; creating, importing and opening further
  // projects happens in the main window.
  $('#newProject').hidden = !!win.child;
  $('#openWindow').hidden = !!win.child;
  $('#importProject').parentElement.hidden = !!win.child;
  const sl = $('#saveLocation');
  if (sl && store.state.dataDir) {
    sl.textContent = store.state.exportDir
      ? '📁 ' + tx('project.workingFolder') + ': ' + store.state.exportDir
      : '💾 ' + tx('project.savedAt') + ': ' + store.state.dataDir;
    sl.title = tx('project.savedAt') + ' ' + store.state.dataDir;
  }
}
document.addEventListener('localechange', () => {
  if (store.state) renderProjects();
});
// "Mở nhiều project cùng lúc": each extra project runs in its own window + server process.
$('#openWindow').onclick = () => {
  store.selected = null;
  const open = Object.fromEntries((store.state.openWindows || []).map(w => [w.id, w]));
  const rows = (store.state.projects || [])
    .filter(p => p.id !== store.state.activeProjectId)
    .map(p => {
      const w = open[p.id];
      const action = w
        ? `<a class="button" href="${esc(w.url)}" target="_blank" rel="noopener">↗ ${tx('project.goWindow')} (${tx('project.port')} ${w.port})</a><button type="button" class="button" data-close-window="${p.id}">✕ ${tx('common.close')}</button>`
        : p.window
          ? `<span class="field-hint">${tx('project.openAtPort')} ${p.window}</span>`
          : `<button type="button" class="button primary" data-open-window="${p.id}">⧉ ${tx('project.openNewWindow')}</button>`;
      return `<li><span>${esc(p.name)} · ${esc(themeLabel(p.theme))}</span><span class="window-actions">${action}</span></li>`;
    })
    .join('');
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>' +
    tx('project.openMultiple') +
    '</h2><button class="close" aria-label="' +
    tx('common.close') +
    '">×</button></div>' +
    '<p class="field-hint">' +
    tx('project.openMultipleHint') +
    '</p>' +
    (rows
      ? '<ul class="wardrobe-list window-list">' + rows + '</ul>'
      : '<p class="field-hint">' + tx('project.onlyCurrent') + '</p>');
  openInspector('project-windows');
  normalizeInspectorLayout();
  $('.close').onclick = closeInspector;
  document.querySelectorAll('[data-open-window]').forEach(
    b =>
      (b.onclick = async () => {
        const tab = window.open('', '_blank'); // opened on the click itself → not popup-blocked
        b.disabled = true;
        b.textContent = '⏳ ' + tx('project.opening');
        try {
          const r = await api('/api/projects/open-window', {
            method: 'POST',
            body: { id: b.dataset.openWindow },
          });
          store.state = r;
          if (tab) tab.location = r.opened.url;
          else window.open(r.opened.url, '_blank');
          render();
          $('#openWindow').onclick();
        } catch (e) {
          if (tab) tab.close();
          toast(e.message, true);
          b.disabled = false;
          b.textContent = '⧉ ' + tx('project.openNewWindow');
        }
      }),
  );
  document.querySelectorAll('[data-close-window]').forEach(
    b =>
      (b.onclick = async () => {
        try {
          store.state = await api('/api/projects/close-window', {
            method: 'POST',
            body: { id: b.dataset.closeWindow },
          });
          render();
          $('#openWindow').onclick();
          toast(tx('project.windowClosed'));
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
};
$('#projectSelect').onchange = async e => {
  try {
    store.state = await api('/api/projects/switch', {
      method: 'POST',
      body: { id: e.target.value },
    });
    gallerySel.clear();
    closeInspector();
    render();
  } catch (err) {
    toast(err.message, true);
    render();
  }
};
// A new project's working folder has no reference images yet: offer to bring them in from
// another folder of the same film (same keys), or start from scratch.
function importFolderDialog(info) {
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>' +
    tx('project.referenceImages') +
    '</h2><button class="close" aria-label="' +
    tx('common.close') +
    '">×</button></div>' +
    '<p class="field-hint">' +
    tx('project.referenceFolderHint') +
    ' <code>' +
    esc(info.dir) +
    '</code></p>' +
    '<label>' +
    tx('project.sourceFolder') +
    '<input id="srcDir" placeholder="D:\\PHIM AI\\PHIM 1\\Seq1"></label>' +
    (info.sources?.length
      ? '<p class="field-hint">' +
        tx('project.otherProjectFolders') +
        '</p><ul class="wardrobe-list">' +
        info.sources
          .map(
            s =>
              `<li><button type="button" class="link" data-src="${esc(s.exportDir)}">${esc(s.name)}</button> · ${s.images} ${tx('project.images')} · <code>${esc(s.exportDir)}</code></li>`,
          )
          .join('') +
        '</ul>'
      : '') +
    '<div class="actions"><button class="button primary" id="srcImport">📥 ' +
    tx('project.importReferences') +
    '</button><button class="button" id="srcSkip">' +
    tx('project.startFresh') +
    '</button></div>';
  openInspector('project-references');
  normalizeInspectorLayout();
  $('.close').onclick = closeInspector;
  document
    .querySelectorAll('[data-src]')
    .forEach(e => (e.onclick = () => ($('#srcDir').value = e.dataset.src)));
  $('#srcSkip').onclick = () => {
    closeInspector();
    toast(tx('project.newNoAssets'));
  };
  $('#srcImport').onclick = () => importFolder($('#srcDir').value.trim());
}
export async function importFolder(dir) {
  if (!dir) return toast(tx('project.sourceFolderRequired'), true);
  try {
    const r = await api('/api/assets/import-folder', { method: 'POST', body: { dir } });
    store.state = r;
    closeInspector();
    render();
    toast(
      r.found
        ? tx('project.referencesCopied') +
            ' ' +
            r.copied +
            ' ' +
            tx('project.images') +
            (r.attached
              ? ' · ' + tx('project.attachedTo') + ' ' + r.attached + ' node'
              : ' · ' + tx('project.autoAttachLater'))
        : tx('project.noReferenceAssets'),
      !r.found,
    );
  } catch (e) {
    toast(e.message, true);
  }
}
$('#newProject').onclick = () => {
  store.selected = null;
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>' +
    tx('project.newTitle') +
    '</h2><button class="close" aria-label="' +
    tx('common.close') +
    '">×</button></div>' +
    '<label>' +
    tx('project.nameLabel') +
    '<input id="npName" placeholder="' +
    tx('project.namePlaceholder') +
    '"></label>' +
    '<label>📁 ' +
    tx('project.workingFolderRequired') +
    '<input id="npDir" placeholder="D:\\PHIM AI\\PHIM 1\\Seq2"></label>' +
    '<p class="field-hint">' +
    tx('project.newFolderHint') +
    '</p>' +
    '<label>' +
    tx('project.themeLabel') +
    '<select id="npTheme">' +
    (store.state.themes || [])
      .map(t => `<option value="${t.id}">${esc(t.label)}</option>`)
      .join('') +
    '</select></label><p class="field-hint">' +
    tx('project.newFromThemeHint') +
    '</p>' +
    '<label>' +
    tx('project.templateLabel') +
    '<select id="npTemplate"><option value="">— ' +
    tx('project.noTemplate') +
    ' —</option>' +
    (store.state.templates || [])
      .map(
        t =>
          `<option value="${t.id}">${esc(t.name)} · ${esc(themeLabel(t.theme))} · ${t.nodeCount} node</option>`,
      )
      .join('') +
    '</select></label><p class="field-hint">' +
    tx('project.templateHint') +
    '</p>' +
    '<button class="button primary wide" id="npCreate">' +
    tx('project.create') +
    '</button>';
  openInspector('project-new');
  normalizeInspectorLayout();
  $('.close').onclick = closeInspector;
  $('#npCreate').onclick = async () => {
    // Opened on the click itself → not popup-blocked. A project created while this window is
    // still generating opens in a window of its own; the tab is closed again if we stay here.
    const tab = window.open('', '_blank');
    try {
      const exportDir = $('#npDir').value.trim();
      const created = await api('/api/projects', {
        method: 'POST',
        body: {
          name: $('#npName').value,
          theme: $('#npTheme').value,
          templateId: $('#npTemplate').value || undefined,
          exportDir,
        },
      });
      store.state = created;
      gallerySel.clear();
      render();
      if (created.opened) {
        // The new project is open in the OTHER window now. Reading its folder from here would
        // import those images into the project this window still has open.
        if (tab) tab.location = created.opened.url;
        else window.open(created.opened.url, '_blank');
        closeInspector();
        toast(tx('project.createdInWindow'));
        return;
      }
      tab?.close();
      const info = await api('/api/folders/inspect?dir=' + encodeURIComponent(exportDir));
      if (info.images) {
        closeInspector();
        toast(
          tx('project.createdPrefix') + info.images + ' ' + tx('project.referenceImagesAttached'),
        );
      } else importFolderDialog(info);
    } catch (e) {
      tab?.close();
      toast(e.message, true);
    }
  };
};
// Backup: download the active project (graph + media) as one .mvproj.json file.
// Guarded so an older cached index.html (without these buttons) can't halt the script.
const backupBtn = $('#backupProject');
if (backupBtn)
  backupBtn.onclick = () => {
    const name = (store.state.name || 'project').replace(/[^\w.\- ]+/g, '_') + '.mvproj.json';
    triggerDownload(
      '/api/projects/export?id=' + encodeURIComponent(store.state.activeProjectId),
      name,
    );
    toast(tx('project.backupDownloading'));
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
      store.state = await api('/api/projects/import', { method: 'POST', body: bundle });
      gallerySel.clear();
      closeInspector();
      render();
      toast(tx('project.backupImported'));
    } catch (err) {
      toast(tx('project.importFailed') + ': ' + err.message, true);
    }
  };
$('#editBrief').onclick = () => {
  store.selected = 'brief';
  const labels = {
    identity: tx('brief.identity'),
    wardrobe: tx('brief.wardrobe'),
    instrument: tx('brief.instrument'),
    stage: tx('brief.stage'),
    lighting: tx('brief.lighting'),
    bpm: tx('brief.bpm'),
  };
  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>${tx('brief.title')}</h2><button class="close" aria-label="${tx('common.close')}">×</button></div>` +
    '<div class="inspector-scroll"><p>' +
    tx('brief.hint') +
    '</p>' +
    Object.entries(labels)
      .map(
        ([k, l]) =>
          `<label>${l}<textarea data-field="${k}" rows="${k === 'bpm' ? 1 : 3}">${esc(store.state.fields[k])}</textarea></label>`,
      )
      .join('') +
    '</div><div class="inspector-footer"><button id="saveBrief" class="button primary wide">' +
    tx('brief.save') +
    '</button></div>';
  openInspector('brief');
  normalizeInspectorLayout();
  $('.close').onclick = closeInspector;
  $('#saveBrief').onclick = async () => {
    try {
      const fields = Object.fromEntries(
        [...document.querySelectorAll('#inspector [data-field]')].map(e => [
          e.dataset.field,
          e.value,
        ]),
      );
      store.state = await api('/api/project', { method: 'PATCH', body: { fields } });
      render();
      closeInspector();
      toast(tx('brief.saved'));
    } catch (e) {
      toast(e.message, true);
    }
  };
};
// Download a JSON object as a file.
function downloadJson(obj, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }),
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#export').onclick = async () => {
  try {
    const b = await api('/api/export');
    const { bible, ...batch } = b;
    const base = (batch.project || 'project').replace(/[^\w.\- ]+/g, '_') || 'project';
    downloadJson(batch, base + '-prompts.json'); // resolved prompts + metadata
    if (bible) downloadJson(bible, base + '-bible.json'); // reusable asset definitions (Bible)
    toast(tx('project.promptExported'));
  } catch (e) {
    toast(e.message, true);
  }
};
// Gói giao hàng: một zip gồm video (đặt tên theo shot trên canvas) + đủ các bước kịch bản +
// prompt/Bible/manifest. Hiện bản kê trước để người dùng biết sắp tải về cái gì và nặng bao
// nhiêu — zip dựng hết trong RAM nên đừng để họ bấm mù.
$('#packageAll').onclick = async () => {
  const btn = $('#packageAll');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '📦 Đang kê…';
  try {
    const plan = await api('/api/package/plan');
    const mb = (plan.bytes / 1024 / 1024).toFixed(1);
    const ok = confirm(
      `Đóng gói “${plan.name}”\n\n` +
        `• ${plan.clips} video + ${plan.images} ảnh (đặt tên theo node; clip/ảnh của nhóm trong thư mục nhom/)\n` +
        `• ${plan.steps} bước kịch bản\n` +
        `• prompts.json + bible.json + manifest\n` +
        (plan.skipped ? `• bỏ qua ${plan.skipped} clip thiếu file\n` : '') +
        (plan.imageSkipped ? `• bỏ qua ${plan.imageSkipped} ảnh thiếu file\n` : '') +
        `\nDung lượng: ${mb} MB. Tải về?`,
    );
    if (!ok) return;
    btn.textContent = '📦 Đang đóng gói…';
    const a = document.createElement('a');
    a.href = '/api/package';
    a.download = plan.name;
    a.click();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};
$('#projectSettings').onclick = () => {
  store.selected = null;
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>' +
    tx('project.settingsTitle') +
    '</h2><button class="close" aria-label="' +
    tx('common.close') +
    '">×</button></div>' +
    '<div class="inspector-scroll"><label>' +
    tx('project.nameLabel') +
    '<input id="projectTitle" value="' +
    esc(store.state.name) +
    '"></label><label>' +
    tx('project.themeLabel') +
    '<select id="projectTheme">' +
    (store.state.themes || [])
      .map(
        t =>
          `<option value="${t.id}" ${t.id === store.state.theme ? 'selected' : ''}>${esc(t.label)}</option>`,
      )
      .join('') +
    '</select></label><p class="field-hint">' +
    tx('project.topicHint') +
    '</p>' +
    // One frame shape for the whole project: every reference image, every still and the final
    // video follow it, so a vertical film never renders a horizontal character sheet.
    '<label>🖼 Khuôn hình (áp cho mọi ảnh và video)<select id="projectAspect">' +
    ['16:9', '9:16', '1:1', '4:3', '3:4']
      .map(
        a =>
          `<option value="${a}" ${a === (store.state.defaults?.aspect || '16:9') ? 'selected' : ''}>${a}${a === '16:9' ? ' · ngang' : a === '9:16' ? ' · dọc' : a === '1:1' ? ' · vuông' : ''}</option>`,
      )
      .join('') +
    '</select></label><p class="field-hint">Tỉ lệ này đi vào cả tham số gửi model lẫn nội dung prompt. Đổi khuôn hình sẽ cập nhật mọi node và <b>đánh dấu ảnh/video đã tạo là cần làm lại</b> (vì chúng đang ở khuôn cũ). Model nào không hỗ trợ tỉ lệ này sẽ tự lùi về tỉ lệ gần nhất nó nhận.</p>' +
    '<label>📁 ' +
    tx('project.mediaFolder') +
    '<input id="exportDir" placeholder="' +
    tx('project.mediaFolderPlaceholder') +
    '" value="' +
    esc(store.state.exportDir || '') +
    '"></label><p class="field-hint">Đường dẫn tuyệt đối trên máy chạy tool (vd <code>D:\\MV\\Ashford</code>). Ảnh/video tạo ra được lưu thành các thư mục con: <code>thu-vien/nhan-vat</code>, <code>thu-vien/boi-canh</code>, <code>khung-hinh/&lt;seq&gt;</code>, <code>video/&lt;seq&gt;</code>. Để trống thì lưu trong thư mục mặc định của project.</p>' +
    '<label>' +
    tx('project.orbitFolder') +
    ' <code class="variable-tag">{{mv_output_dir}}</code><input id="outputDirectory" value="' +
    esc(store.state.outputDirectory) +
    '"></label><p class="field-hint">Nhập đường dẫn tuyệt đối. Thư mục phải truy cập được bằng cùng đường dẫn từ MV Director và Orbit (cùng máy hoặc thư mục mạng dùng chung).</p><p>Đường dẫn đầy đủ gửi sang Orbit: <code>{{mv_output_path}}</code></p>' +
    '<hr><h3 style="margin: 10px 0 4px">⭐ ' +
    tx('project.reusableTemplate') +
    '</h3><p class="field-hint">' +
    tx('project.reusableTemplateHint') +
    '</p>' +
    '<button class="button wide" id="saveAsTemplate">⭐ ' +
    tx('project.saveAsTemplate') +
    '</button>' +
    '<ul class="wardrobe-list" id="templateList">' +
    templateRows() +
    '</ul>' +
    (store.state.window?.child
      ? ''
      : '<button class="button wide danger" id="deleteProject">🗑 ' +
        tx('project.deleteThis') +
        '</button>') +
    '</div><div class="inspector-footer"><button class="button primary wide" id="saveProjectSettings">' +
    tx('project.saveSettings') +
    '</button></div>';
  openInspector('project');
  normalizeInspectorLayout();
  $('.close').onclick = closeInspector;
  bindTemplateList();
  $('#saveAsTemplate').onclick = async () => {
    const name = prompt(tx('project.templateNamePrompt'), store.state.name || '');
    if (name === null) return;
    try {
      const r = await api('/api/templates/save', { method: 'POST', body: { name } });
      store.state.templates = r.templates;
      bindTemplateList();
      toast(
        tx('project.templateSaved') + ' "' + r.saved.name + '" · ' + r.saved.nodeCount + ' node',
      );
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#saveProjectSettings').onclick = async () => {
    try {
      store.state = await api('/api/project', {
        method: 'PATCH',
        body: {
          name: $('#projectTitle').value,
          theme: $('#projectTheme').value,
          outputDirectory: $('#outputDirectory').value,
          exportDir: $('#exportDir').value.trim(),
          defaults: { ...(store.state.defaults || {}), aspect: $('#projectAspect').value },
        },
      });
      render();
      closeInspector();
      toast(tx('project.settingsSaved'));
    } catch (e) {
      toast(e.message, true);
    }
  };
  if (!$('#deleteProject')) return;
  $('#deleteProject').onclick = async () => {
    if (!confirm(tx('project.deleteConfirm').replace('{name}', store.state.name))) return;
    try {
      store.state = await api('/api/projects/delete', {
        method: 'POST',
        body: { id: store.state.activeProjectId },
      });
      gallerySel.clear();
      closeInspector();
      render();
      toast(tx('project.deleted'));
    } catch (e) {
      toast(e.message, true);
    }
  };
};
