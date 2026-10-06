// Projects: create/switch/open windows, working folders, backup, brief and settings.
import { store } from './store.js';
import { $, api, esc, toast, triggerDownload } from './core.js';
import { gallerySel } from './gallery.js';
import { closeInspector } from './inspector.js';
import { render } from './render.js';

const themeLabel = id => (store.state.themes || []).find(t => t.id === id)?.label || id;
// The saved user templates, as rows in the project-settings dialog (with a delete button each).
const templateRows = () =>
  (store.state.templates || [])
    .map(
      t =>
        `<li><span>${esc(t.name)} · ${esc(themeLabel(t.theme))} · ${t.nodeCount} node</span> <button type="button" class="link" data-del-template="${t.id}">🗑 Xóa</button></li>`,
    )
    .join('') || '<li class="field-hint">Chưa có template nào.</li>';
// Redraws the template list and (re)binds each delete button to remove that template.
function bindTemplateList() {
  const list = $('#templateList');
  if (!list) return;
  list.innerHTML = templateRows();
  document.querySelectorAll('[data-del-template]').forEach(
    b =>
      (b.onclick = async () => {
        if (!confirm('Xóa template này?')) return;
        try {
          const r = await api('/api/templates/delete', {
            method: 'POST',
            body: { id: b.dataset.delTemplate },
          });
          store.state.templates = r.templates;
          bindTemplateList();
          toast('Đã xóa template');
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
        `<option value="${p.id}" ${p.id === store.state.activeProjectId ? 'selected' : ''} ${p.window ? 'disabled' : ''}>${esc(p.name)} · ${esc(themeLabel(p.theme))}${p.window ? ' · đang mở ở cổng ' + p.window : ''}</option>`,
    )
    .join('');
  const win = store.state.window || {};
  document.querySelector('.eyebrow').textContent =
    (win.child ? 'CỬA SỔ PHỤ · CỔNG ' + win.port + ' / ' : 'WORKSPACE / ') +
    themeLabel(store.state.theme).toUpperCase();
  // A secondary window works on its one project; creating, importing and opening further
  // projects happens in the main window.
  $('#newProject').hidden = !!win.child;
  $('#openWindow').hidden = !!win.child;
  $('#importProject').parentElement.hidden = !!win.child;
  const sl = $('#saveLocation');
  if (sl && store.state.dataDir) {
    sl.textContent = store.state.exportDir
      ? '📁 Thư mục làm việc: ' + store.state.exportDir
      : '💾 Lưu tại: ' + store.state.dataDir;
    sl.title = 'Project lưu ở ' + store.state.dataDir;
  }
}
// "Mở nhiều project cùng lúc": each extra project runs in its own window + server process.
$('#openWindow').onclick = () => {
  store.selected = null;
  $('#overlay').hidden = false;
  $('#inspector').hidden = false;
  const open = Object.fromEntries((store.state.openWindows || []).map(w => [w.id, w]));
  const rows = (store.state.projects || [])
    .filter(p => p.id !== store.state.activeProjectId)
    .map(p => {
      const w = open[p.id];
      const action = w
        ? `<a class="button" href="${esc(w.url)}" target="_blank" rel="noopener">↗ Tới cửa sổ (cổng ${w.port})</a><button type="button" class="button" data-close-window="${p.id}">✕ Đóng</button>`
        : p.window
          ? `<span class="field-hint">đang mở ở cổng ${p.window}</span>`
          : `<button type="button" class="button primary" data-open-window="${p.id}">⧉ Mở cửa sổ mới</button>`;
      return `<li><span>${esc(p.name)} · ${esc(themeLabel(p.theme))}</span><span class="window-actions">${action}</span></li>`;
    })
    .join('');
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>Mở nhiều project cùng lúc</h2><button class="close" aria-label="Đóng">×</button></div>' +
    '<p class="field-hint">Mỗi project mở thêm chạy trong một cửa sổ riêng (tiến trình server riêng trên cổng kế tiếp), có hàng đợi tạo ảnh/video riêng, và tắt cùng cửa sổ chính. Một project chỉ mở được ở một cửa sổ tại một thời điểm.</p>' +
    (rows
      ? '<ul class="wardrobe-list window-list">' + rows + '</ul>'
      : '<p class="field-hint">Chỉ có project đang mở. Tạo thêm project rồi quay lại đây.</p>');
  $('.close').onclick = closeInspector;
  document.querySelectorAll('[data-open-window]').forEach(
    b =>
      (b.onclick = async () => {
        const tab = window.open('', '_blank'); // opened on the click itself → not popup-blocked
        b.disabled = true;
        b.textContent = '⏳ Đang mở…';
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
          b.textContent = '⧉ Mở cửa sổ mới';
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
          toast('Đã đóng cửa sổ');
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
  $('#overlay').hidden = false;
  $('#inspector').hidden = false;
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>Ảnh tham chiếu</h2><button class="close" aria-label="Đóng">×</button></div>' +
    '<p class="field-hint">Thư mục <code>' +
    esc(info.dir) +
    '</code> chưa có ảnh tham chiếu. Nếu phim này đã có nhân vật / bối cảnh / trang phục render ở thư mục khác (cùng key trong Bible), lấy chúng sang; nếu không, bắt đầu mới.</p>' +
    '<label>Thư mục nguồn (chứa thu-vien/…)<input id="srcDir" placeholder="D:\\PHIM AI\\PHIM 1\\Seq1"></label>' +
    (info.sources?.length
      ? '<p class="field-hint">Thư mục của project khác:</p><ul class="wardrobe-list">' +
        info.sources
          .map(
            s =>
              `<li><button type="button" class="link" data-src="${esc(s.exportDir)}">${esc(s.name)}</button> · ${s.images} ảnh · <code>${esc(s.exportDir)}</code></li>`,
          )
          .join('') +
        '</ul>'
      : '') +
    '<div class="actions"><button class="button primary" id="srcImport">📥 Lấy ảnh tham chiếu</button><button class="button" id="srcSkip">Bắt đầu mới</button></div>';
  $('.close').onclick = closeInspector;
  document
    .querySelectorAll('[data-src]')
    .forEach(e => (e.onclick = () => ($('#srcDir').value = e.dataset.src)));
  $('#srcSkip').onclick = () => {
    closeInspector();
    toast('Project mới, chưa có ảnh tham chiếu');
  };
  $('#srcImport').onclick = () => importFolder($('#srcDir').value.trim());
}
export async function importFolder(dir) {
  if (!dir) return toast('Nhập thư mục nguồn', true);
  try {
    const r = await api('/api/assets/import-folder', { method: 'POST', body: { dir } });
    store.state = r;
    closeInspector();
    render();
    toast(
      r.found
        ? 'Đã chép ' +
            r.copied +
            ' ảnh vào thư mục project' +
            (r.attached ? ', gắn vào ' + r.attached + ' node' : ', sẽ tự gắn khi dựng sơ đồ')
        : 'Thư mục nguồn không có ảnh tham chiếu (thu-vien/nhan-vat, boi-canh, trang-phuc)',
      !r.found,
    );
  } catch (e) {
    toast(e.message, true);
  }
}
$('#newProject').onclick = () => {
  store.selected = null;
  $('#overlay').hidden = false;
  $('#inspector').hidden = false;
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>Project mới</h2><button class="close" aria-label="Đóng">×</button></div>' +
    '<label>Tên project<input id="npName" placeholder="Ví dụ: MV ca khúc X"></label>' +
    '<label>📁 Thư mục làm việc (bắt buộc)<input id="npDir" placeholder="D:\\PHIM AI\\PHIM 1\\Seq2"></label>' +
    '<p class="field-hint">Đường dẫn tuyệt đối trên máy này; tool tạo thư mục nếu chưa có. Ảnh/video sinh ra lưu vào đó (<code>thu-vien/…</code>, <code>khung-hinh/…</code>, <code>video/…</code>). Khi dựng sơ đồ, <b>chỉ ảnh trong <code>thu-vien</code> của thư mục này</b> được tự gắn — project khác không bị lấy sang. Thư mục trống → bước tiếp theo cho lấy ảnh từ thư mục khác.</p>' +
    '<label>Chủ đề<select id="npTheme">' +
    (store.state.themes || [])
      .map(t => `<option value="${t.id}">${esc(t.label)}</option>`)
      .join('') +
    '</select></label><p class="field-hint">Project mới được nhân từ bộ node mẫu của chủ đề (kèm node Style và Máy quay).</p>' +
    '<label>Hoặc từ template của tôi<select id="npTemplate"><option value="">— Không, dùng chủ đề ở trên —</option>' +
    (store.state.templates || [])
      .map(
        t =>
          `<option value="${t.id}">${esc(t.name)} · ${esc(themeLabel(t.theme))} · ${t.nodeCount} node</option>`,
      )
      .join('') +
    '</select></label><p class="field-hint">Template là bộ node/prompt bạn đã lưu từ một project (không kèm ảnh/video). Chọn template thì bỏ qua chủ đề ở trên. Lưu template ở ⚙ Project.</p>' +
    '<button class="button primary wide" id="npCreate">Tạo project</button>';
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
        toast('Đã tạo project và mở ở cửa sổ riêng — cửa sổ này vẫn đang chạy tác vụ.');
        return;
      }
      tab?.close();
      const info = await api('/api/folders/inspect?dir=' + encodeURIComponent(exportDir));
      if (info.images) {
        closeInspector();
        toast(
          'Đã tạo project · thư mục có sẵn ' +
            info.images +
            ' ảnh tham chiếu, sẽ tự gắn khi dựng sơ đồ',
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
      store.state = await api('/api/projects/import', { method: 'POST', body: bundle });
      gallerySel.clear();
      closeInspector();
      render();
      toast('Đã nhập project từ file backup');
    } catch (err) {
      toast('Nhập thất bại: ' + err.message, true);
    }
  };
$('#editBrief').onclick = () => {
  store.selected = 'brief';
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
          `<label>${l}<textarea data-field="${k}" rows="${k === 'bpm' ? 1 : 3}">${esc(store.state.fields[k])}</textarea></label>`,
      )
      .join('')}<button id="saveBrief" class="button primary wide">Lưu định hướng</button>`;
  $('.close').onclick = closeInspector;
  $('#saveBrief').onclick = async () => {
    try {
      const fields = Object.fromEntries(
        [...document.querySelectorAll('[data-field]')].map(e => [e.dataset.field, e.value]),
      );
      store.state = await api('/api/project', { method: 'PATCH', body: { fields } });
      render();
      closeInspector();
      toast('Đã cập nhật prompt kế thừa');
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
    toast('Đã xuất prompt + bible.json');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#projectSettings').onclick = () => {
  store.selected = null;
  $('#overlay').hidden = false;
  $('#inspector').hidden = false;
  $('#inspector').innerHTML =
    '<div class="inspector-head"><h2>Cài đặt project</h2><button class="close" aria-label="Đóng">×</button></div><label>Tên project<input id="projectTitle" value="' +
    esc(store.state.name) +
    '"></label><label>Chủ đề<select id="projectTheme">' +
    (store.state.themes || [])
      .map(
        t =>
          `<option value="${t.id}" ${t.id === store.state.theme ? 'selected' : ''}>${esc(t.label)}</option>`,
      )
      .join('') +
    '</select></label><p class="field-hint">Đổi chủ đề chỉ đổi nhãn phân loại; không dựng lại node. Dùng Project mới để lấy bộ node mẫu của chủ đề khác.</p>' +
    '<label>📁 Thư mục lưu ảnh/video của project<input id="exportDir" placeholder="Để trống = lưu trong thư mục mặc định của project" value="' +
    esc(store.state.exportDir || '') +
    '"></label><p class="field-hint">Đường dẫn tuyệt đối trên máy chạy tool (vd <code>D:\\MV\\Ashford</code>). Ảnh/video tạo ra được lưu thành các thư mục con: <code>thu-vien/nhan-vat</code>, <code>thu-vien/boi-canh</code>, <code>khung-hinh/&lt;seq&gt;</code>, <code>video/&lt;seq&gt;</code>. Để trống thì lưu trong thư mục mặc định của project.</p>' +
    '<label>Thư mục lưu trên máy chạy Orbit <code class="variable-tag">{{mv_output_dir}}</code><input id="outputDirectory" value="' +
    esc(store.state.outputDirectory) +
    '"></label><p class="field-hint">Nhập đường dẫn tuyệt đối. Thư mục phải truy cập được bằng cùng đường dẫn từ MV Director và Orbit (cùng máy hoặc thư mục mạng dùng chung).</p><p>Đường dẫn đầy đủ gửi sang Orbit: <code>{{mv_output_path}}</code></p><button class="button primary wide" id="saveProjectSettings">Lưu cài đặt</button>' +
    // Reusable templates: save this project's node/prompt skeleton (no media) for new projects.
    '<hr><h3 style="margin: 10px 0 4px">⭐ Template dùng lại</h3><p class="field-hint">Lưu bộ node/prompt của project này (không kèm ảnh/video) để tạo project mới giống hệt.</p>' +
    '<button class="button wide" id="saveAsTemplate">⭐ Lưu project này làm template</button>' +
    '<ul class="wardrobe-list" id="templateList">' +
    templateRows() +
    '</ul>' +
    // Deleting happens in the main window (a secondary window only works on its project).
    (store.state.window?.child
      ? ''
      : '<button class="button wide danger" id="deleteProject">🗑 Xóa project này</button>');
  $('.close').onclick = closeInspector;
  bindTemplateList();
  $('#saveAsTemplate').onclick = async () => {
    const name = prompt('Tên template:', store.state.name || '');
    if (name === null) return;
    try {
      const r = await api('/api/templates/save', { method: 'POST', body: { name } });
      store.state.templates = r.templates;
      bindTemplateList();
      toast('Đã lưu template "' + r.saved.name + '" · ' + r.saved.nodeCount + ' node');
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
        },
      });
      render();
      closeInspector();
      toast('Đã lưu cài đặt project');
    } catch (e) {
      toast(e.message, true);
    }
  };
  if (!$('#deleteProject')) return;
  $('#deleteProject').onclick = async () => {
    if (
      !confirm(
        'Xóa project "' +
          store.state.name +
          '" cùng toàn bộ video/ảnh của nó? Không hoàn tác được.',
      )
    )
      return;
    try {
      store.state = await api('/api/projects/delete', {
        method: 'POST',
        body: { id: store.state.activeProjectId },
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
