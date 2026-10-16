import { $, api, toast } from './core.js';
import { store } from './store.js';

let loadedProject = null, busy = false, loadVersion = 0, remoteTimer;
const buttons = ['Save', 'Generate', 'Validate', 'Feedback', 'ExportJson', 'ExportOtio', 'Blueprint', 'UseScript'];
const fields = ['Title', 'Script', 'Bible', 'Camera', 'Emotion', 'Json', 'ScriptFile', 'BibleFile'];
function lock(value) {
  busy = value;
  for (const key of [...buttons, ...fields]) if ($('#obrion' + key)) $('#obrion' + key).disabled = value;
}
function status(text) { $('#obrionStatus').textContent = text; }
function showResult(production) {
  $('#obrionResult').hidden = !production;
  $('#obrionJson').value = production ? JSON.stringify(production, null, 2) : '';
  const shots = production?.shots || [];
  $('#obrionSummary').textContent = shots.length ? `${shots.length} shot · ${shots.at(-1).timecode.end_seconds}s · ${new Set(shots.map(s => s.scene_id)).size} cảnh` : '';
}
function showDraft(draft) {
  for (const [field, key] of [['Title', 'title'], ['Script', 'raw_script'], ['Camera', 'camera_rules'], ['Emotion', 'emotion_rules']])
    $('#obrion' + field).value = draft?.[key] || '';
  $('#obrionBible').value = JSON.stringify(draft?.asset_bible || {}, null, 2);
  showResult(draft?.production);
  $('#obrionLogs').textContent = (draft?.logs || []).join('\n');
  $('#obrionLogs').hidden = !draft?.logs?.length;
}
export async function loadObrion() {
  if (!$('#obrionStudio') || busy) return;
  const version = ++loadVersion;
  const r = await api('/api/director/obrion');
  if (version !== loadVersion || r.projectId !== store.state?.activeProjectId) return;
  if (loadedProject === r.projectId) return;
  loadedProject = r.projectId;
  showDraft(r.draft);
  status(r.running ? 'OBRION đang chạy ở một cửa sổ khác. Mở lại sau khi hoàn tất.' : 'Sẵn sàng. Lưu bản nháp để giữ nội dung theo project.');
  if (r.running) {
    lock(true);
    const monitor = async () => {
      try {
        const next = await api('/api/director/obrion');
        if (next.projectId !== r.projectId || !next.running) {
          lock(false);
          loadedProject = null;
          await loadObrion();
          return;
        }
        $('#obrionLogs').hidden = false;
        $('#obrionLogs').textContent = next.logs.join('\n');
        remoteTimer = setTimeout(monitor, 2000);
      } catch (e) {
        lock(false);
        loadedProject = null;
        status(e.message);
      }
    };
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(monitor, 2000);
  }
}
function input() {
  if (loadedProject !== store.state?.activeProjectId) throw new Error('Đợi tải OBRION cho project đang mở.');
  return { projectId: loadedProject, title: $('#obrionTitle').value || 'OBRION', raw_script: $('#obrionScript').value,
    asset_bible: JSON.parse($('#obrionBible').value || '{}'), camera_rules: $('#obrionCamera').value, emotion_rules: $('#obrionEmotion').value };
}
async function perform(action, onDone) {
  if (busy) return;
  let timer;
  const id = loadedProject;
  try {
    const payload = input();
    if (!['save', 'generate'].includes(action)) payload.production = JSON.parse($('#obrionJson').value);
    lock(true);
    status(action === 'generate' ? 'Đang phân cảnh… Có thể mất vài phút.' : 'Đang xử lý…');
    if (action === 'generate') {
      $('#obrionLogs').textContent = '';
      $('#obrionLogs').hidden = false;
      timer = setInterval(async () => {
        try {
          const s = await api('/api/director/obrion');
          if (s.projectId === id && store.state?.activeProjectId === id) $('#obrionLogs').textContent = s.logs.join('\n');
        } catch {}
      }, 2000);
    }
    const result = await api('/api/director/obrion/' + action, { method: 'POST', body: payload });
    if (store.state?.activeProjectId !== id) return;
    onDone(result);
  } catch (e) {
    if (store.state?.activeProjectId === id) status('Lỗi: ' + e.message);
    toast(e.message, true);
  } finally {
    clearInterval(timer);
    lock(false);
    if (store.state?.activeProjectId !== id) {
      loadedProject = null;
      showDraft(null);
      loadObrion().catch(e => status(e.message));
    }
  }
}
function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
if ($('#obrionStudio')) {
  $('#obrionUseScript').onclick = () => {
    $('#obrionScript').value = $('#agentScriptText').value;
    $('#obrionTitle').value = $('#projTitle').value;
    status('Đã lấy kịch bản. Có thể chỉnh sửa trước khi phân cảnh.');
  };
  for (const [fileId, target, json] of [['ScriptFile', 'Script', false], ['BibleFile', 'Bible', true]]) {
    $('#obrion' + fileId).onchange = async e => {
      const f = e.target.files[0], id = loadedProject;
      if (!f) return;
      try {
        if (f.size > (json ? 500000 : 100000)) throw new Error('File quá lớn. Hãy chia thành phân đoạn.');
        const text = (await f.text()).replace(/^\uFEFF/, '');
        if (id !== loadedProject || busy) return;
        $('#obrion' + target).value = json ? JSON.stringify(JSON.parse(text), null, 2) : text;
        status('Đã nhập ' + f.name + '. Bấm Lưu bản nháp để giữ lại.');
      } catch (err) { toast(err.message, true); }
      e.target.value = '';
    };
  }
  $('#obrionCheck').onclick = async () => {
    try {
      const r = await api('/api/director/obrion/check', { method: 'POST', body: {} });
      status('Python ' + r.python + ' · thư viện OBRION sẵn sàng.');
    } catch (e) { status(e.message); }
  };
  $('#obrionSave').onclick = () => perform('save', () => status('Đã lưu bản nháp vào project.'));
  $('#obrionGenerate').onclick = () => perform('generate', r => { showDraft(r.draft); status('Đã hoàn tất. Xem và sửa shot JSON bên dưới.'); });
  $('#obrionValidate').onclick = () => perform('validate', r => { showResult(r.production); status('JSON và timeline hợp lệ. Đã lưu chỉnh sửa.'); });
  $('#obrionFeedback').onclick = () => perform('feedback', r => status(`Đã lưu ${r.saved} phản hồi mới vào bộ nhớ đạo diễn.`));
  $('#obrionExportJson').onclick = () => perform('validate', r => { download(JSON.stringify(r.production, null, 2), 'obrion-shots.json', 'application/json'); status('Đã xuất JSON hợp lệ.'); });
  $('#obrionExportOtio').onclick = () => perform('validate', r => { download(r.otio, 'obrion-timeline.otio', 'application/json'); status('Đã xuất timeline OTIO.'); });
  $('#obrionBlueprint').onclick = () => perform('blueprint', r => {
    $('#blueprintInput').value = JSON.stringify(r.blueprint, null, 2);
    $('#blueprintInput').dispatchEvent(new Event('input', { bubbles: true }));
    $('#blueprintInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
    status('Đã chuyển sang bước 3. Xem blueprint rồi bấm Dựng sơ đồ ở bước 4.');
  });
  document.addEventListener('appstatechange', () => {
    if (loadedProject && loadedProject !== store.state?.activeProjectId && !busy) {
      loadedProject = null;
      showDraft(null);
      loadObrion().catch(e => status(e.message));
    }
  });
}
