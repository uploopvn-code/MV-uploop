// Director: master prompt, build the graph from blueprint JSON, asset library buttons.
import { store } from './store.js';
import { $, api, copy, esc, toast } from './core.js';
import { gallerySel } from './gallery.js';
import { importFolder } from './projects.js';
import { render, view } from './render.js';

// --- Đạo diễn: master prompt + build graph from blueprint + LLM auto ---
let directorLoaded = false;
let defaultMaster = '';
function showMasterBadge(custom) {
  $('#masterBadge').textContent = custom
    ? '· đã sửa riêng cho project này'
    : '· đang dùng mặc định';
}
export async function loadDirector() {
  try {
    const d = await api('/api/director');
    $('#masterPrompt').value = d.masterPrompt;
    defaultMaster = d.defaultMaster || '';
    showMasterBadge(d.customMaster);
    showDirectorLLM(d.llm);
    try {
      const mt = await api('/api/director/master-templates');
      fillMasterTemplates(mt.templates, '');
    } catch {}
    try {
      if ($('#agentViaWeb'))
        $('#agentViaWeb').checked = localStorage.getItem('agentViaWeb') === '1';
      if ($('#projType') && localStorage.getItem('projType'))
        $('#projType').value = localStorage.getItem('projType');
    } catch {}
    paintAgentMode();
    paintProjType();
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
// --- Master-prompt library: pick a ready-made template or save your own ---
let masterTemplates = [];
function fillMasterTemplates(list, selectId) {
  masterTemplates = list || [];
  const sel = $('#masterTemplate');
  if (!sel) return;
  const opt = t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`;
  const builtins = masterTemplates.filter(t => t.builtin);
  const mine = masterTemplates.filter(t => !t.builtin);
  sel.innerHTML =
    '<option value="">— Giữ nguyên —</option>' +
    (builtins.length
      ? '<optgroup label="Dựng sẵn">' + builtins.map(opt).join('') + '</optgroup>'
      : '') +
    (mine.length ? '<optgroup label="Mẫu của tôi">' + mine.map(opt).join('') + '</optgroup>' : '');
  sel.value = selectId || '';
  updateDelMaster();
}
function updateDelMaster() {
  const t = masterTemplates.find(x => x.id === $('#masterTemplate')?.value);
  if ($('#delMasterTemplate')) $('#delMasterTemplate').hidden = !(t && !t.builtin);
}
if ($('#masterTemplate'))
  $('#masterTemplate').onchange = async () => {
    updateDelMaster();
    const t = masterTemplates.find(x => x.id === $('#masterTemplate').value);
    if (!t) return;
    // Picking a template applies it to the project right away, so step 3 (Lên blueprint) uses it.
    $('#masterPrompt').value = t.prompt;
    try {
      const r = await api('/api/director/master', {
        method: 'POST',
        body: { masterPrompt: t.prompt },
      });
      $('#masterPrompt').value = r.masterPrompt;
      showMasterBadge(r.customMaster);
      toast('Đã áp dụng mẫu "' + t.name + '" cho project');
    } catch (e) {
      toast(e.message, true);
    }
  };
if ($('#saveMasterTemplate'))
  $('#saveMasterTemplate').onclick = async () => {
    const name = prompt('Tên mẫu master prompt:', '');
    if (name === null) return;
    try {
      const r = await api('/api/director/master-templates/save', {
        method: 'POST',
        body: { name, prompt: $('#masterPrompt').value },
      });
      fillMasterTemplates(r.templates, r.saved.id);
      toast('Đã lưu mẫu "' + r.saved.name + '"');
    } catch (e) {
      toast(e.message, true);
    }
  };
if ($('#delMasterTemplate'))
  $('#delMasterTemplate').onclick = async () => {
    const t = masterTemplates.find(x => x.id === $('#masterTemplate').value);
    if (!t || t.builtin) return;
    if (!confirm('Xóa mẫu "' + t.name + '"?')) return;
    try {
      const r = await api('/api/director/master-templates/delete', {
        method: 'POST',
        body: { id: t.id },
      });
      fillMasterTemplates(r.templates, '');
      toast('Đã xóa mẫu');
    } catch (e) {
      toast(e.message, true);
    }
  };
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
    store.state = await api('/api/director/build', { method: 'POST', body: { blueprint } });
    gallerySel.clear();
    view('studio');
    render();
    $('#arrangeZones').onclick();
    const warns = store.state.graphWarnings || [];
    if (warns.length) console.warn('Đạo diễn — cảnh báo dựng sơ đồ:\n' + warns.join('\n'));
    toast(
      'Đã dựng sơ đồ' +
        (store.state.graphReused || store.state.graphReusedOther || store.state.graphReusedFolder
          ? ' · tái dùng ' +
            ((store.state.graphReused || 0) +
              (store.state.graphReusedOther || 0) +
              (store.state.graphReusedFolder || 0)) +
            ' ảnh nhân vật/bối cảnh có sẵn' +
            (store.state.graphReusedFolder
              ? ' (' + store.state.graphReusedFolder + ' từ thư mục làm việc)'
              : '') +
            (store.state.graphReusedOther
              ? ' (' + store.state.graphReusedOther + ' từ project khác)'
              : '')
          : '') +
        (warns.length
          ? ' · ⚠ ' + warns.length + ' cảnh báo: ' + warns[0] + (warns.length > 1 ? ' (…)' : '')
          : ''),
      warns.length > 0,
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
// Fill the character / scene / costume nodes that still have no image from the other projects
// of this film (same key), e.g. episode 1's assets rendered after episode 2 was imported.
$('#pullAssets').onclick = async () => {
  try {
    const r = await api('/api/assets/pull', { method: 'POST', body: {} });
    store.state = r;
    if (r.pulled) {
      view('studio');
      render();
      toast('Đã lấy ' + r.pulled + ' ảnh từ project khác của phim này');
    } else
      toast(
        'Không có ảnh nào để lấy: node đã có ảnh, project khác chưa render, hoặc Bible thiếu film.title.',
        true,
      );
  } catch (e) {
    toast(e.message, true);
  }
};
$('#clearAssets').onclick = async () => {
  const n = store.state.nodes.filter(
    x =>
      x.image &&
      !x.terminal &&
      x.kind !== 'setting' &&
      !['production', 'merged', 'output', 'seedance', 'seedance-video'].includes(x.zone),
  ).length;
  if (!n) return toast('Không có ảnh tham chiếu nào đang gắn', true);
  if (
    !confirm(
      'Bỏ ' +
        n +
        ' ảnh đang gắn ở node nhân vật / trang phục / bối cảnh để render lại từ đầu?\nẢnh đã xuất ra thư mục làm việc vẫn còn.',
    )
  )
    return;
  try {
    store.state = await api('/api/assets/clear', { method: 'POST', body: {} });
    render();
    toast(
      'Đã bỏ ' + store.state.cleared + ' ảnh tham chiếu · render lại hoặc nhập từ thư mục khác',
    );
  } catch (e) {
    toast(e.message, true);
  }
};
$('#importFolder').onclick = () =>
  importFolder(
    (prompt('Thư mục nguồn chứa thu-vien/… (ví dụ D:\\PHIM AI\\PHIM 1\\Seq1)') || '').trim(),
  );
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
// Download the project's subtitles as an .srt file (built server-side from the shots' lyrics).
$('#exportSrt').onclick = async () => {
  const names = $('#srtNames').checked ? '1' : '0';
  try {
    const r = await fetch('/api/director/subtitles.srt?names=' + names);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Lỗi xuất phụ đề');
    const blob = await r.blob();
    const name =
      (r.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] &&
        decodeURIComponent(
          r.headers.get('Content-Disposition').match(/filename\*=UTF-8''([^;]+)/)[1],
        )) ||
      'phu-de.srt';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast('Đã xuất phụ đề' + ($('#srtNames').checked ? ' (giữ tên người nói)' : ''));
  } catch (e) {
    toast(e.message, true);
  }
};

// --- Production meta: title + type + duration (film) / song (MV) ---
// For an MV, the song's length is read in the browser from the chosen mp3 (no upload), and used
// as the target duration; for a film, the user types the minutes. Fed to the script + blueprint.
let songSeconds = 0;
function agentMeta() {
  const type = $('#projType')?.value === 'mv' ? 'mv' : 'drama';
  const m = { title: ($('#projTitle')?.value || '').trim(), type };
  if (type === 'mv') {
    m.song = ($('#projSong')?.value || '').trim();
    if (songSeconds > 0) m.seconds = Math.round(songSeconds);
  } else {
    const mins = parseFloat($('#projMinutes')?.value);
    if (mins > 0) m.minutes = mins;
  }
  return m;
}
// Suggested shot count for a target length — same formula the server states in the prompt.
function shotRange(sec) {
  const lo = Math.max(3, Math.round(sec / 8));
  const hi = Math.max(lo + 1, Math.round(sec / 5));
  return lo + '–' + hi;
}
// Live "target" line so the user sees exactly what gets pushed into the master prompt.
function paintMetaHint() {
  const el = $('#metaHint');
  if (!el) return;
  const m = agentMeta();
  const sec = m.type === 'mv' ? m.seconds || 0 : (m.minutes || 0) * 60;
  if (sec > 0)
    el.textContent = `🎯 Mục tiêu: ~${Math.round(sec)} giây · ~${shotRange(sec)} shot — gửi kèm master prompt khi viết kịch bản / blueprint.`;
  else if (m.type === 'mv')
    el.textContent = '🎯 MV: chọn file mp3 để đọc thời lượng (hoặc để phân tích ở bước sau).';
  else el.textContent = 'Nhập thời lượng (phút) để tool tính số shot và gửi kèm master prompt.';
}
// Show the right fields per type, and apply the matching master prompt in step 2.
function paintProjType() {
  const mv = $('#projType')?.value === 'mv';
  if ($('#dramaMeta')) $('#dramaMeta').hidden = mv;
  if ($('#mvMeta')) $('#mvMeta').hidden = !mv;
  paintMetaHint();
}
if ($('#projMinutes')) $('#projMinutes').oninput = paintMetaHint;
if ($('#projType'))
  $('#projType').onchange = () => {
    paintProjType();
    try {
      localStorage.setItem('projType', $('#projType').value);
    } catch {}
    // Pick the matching built-in master prompt (applied to the project by its own onchange).
    const want = $('#projType').value === 'mv' ? 'builtin:mv' : 'builtin:drama-short';
    const sel = $('#masterTemplate');
    if (sel && [...sel.options].some(o => o.value === want) && sel.value !== want) {
      sel.value = want;
      sel.onchange();
    }
  };
if ($('#projSongFile'))
  $('#projSongFile').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    if ($('#projSong') && !$('#projSong').value) $('#projSong').value = f.name;
    const url = URL.createObjectURL(f);
    const audio = new Audio();
    audio.onloadedmetadata = () => {
      songSeconds = audio.duration || 0;
      if ($('#projSongInfo'))
        $('#projSongInfo').textContent = f.name + ' · ~' + Math.round(songSeconds) + ' giây';
      paintMetaHint();
      URL.revokeObjectURL(url);
    };
    audio.onerror = () => {
      if ($('#projSongInfo')) $('#projSongInfo').textContent = 'Không đọc được thời lượng file';
      URL.revokeObjectURL(url);
    };
    audio.src = url;
  };

// --- Conversational director: idea → script → blueprint → build ---
// Asks the LLM to write a treatment from the idea box. Returns the script text (also chains on
// into the blueprint + build steps when "Tự động hoàn toàn" is on).
async function runAgentScript() {
  const idea = $('#directorIdea').value.trim();
  if (!idea) return toast('Nhập ý tưởng / lời để Đạo diễn viết kịch bản', true);
  const btn = $('#agentScript');
  btn.disabled = true;
  btn.textContent = '⏳ Đang viết kịch bản…';
  try {
    const r = await api('/api/director/agent', {
      method: 'POST',
      body: { stage: 'script', idea, via: agentVia(), meta: agentMeta() },
    });
    $('#agentScriptText').value = r.script;
    $('#agentScriptWrap').hidden = false;
    $('#agentBlueprint').disabled = false;
    toast('Đã viết kịch bản · xem/sửa, chọn master prompt (bước 2) rồi sang bước 3');
    return r.script;
  } catch (e) {
    toast(e.message, true);
    throw e;
  } finally {
    btn.disabled = false;
    btn.textContent = '① Viết kịch bản';
  }
}
// Turns the (edited) script into a blueprint, drops it into the mục-2 box, and — in auto mode —
// builds the graph straight away.
async function runAgentBlueprint(auto) {
  const script = $('#agentScriptText').value.trim();
  if (!script) return toast('Chưa có kịch bản. Bấm ① trước.', true);
  const btn = $('#agentBlueprint');
  btn.disabled = true;
  btn.textContent = '⏳ Đang lên blueprint…';
  try {
    const r = await api('/api/director/agent', {
      method: 'POST',
      body: { stage: 'blueprint', script, via: agentVia(), meta: agentMeta() },
    });
    $('#blueprintInput').value = r.blueprint;
    $('#agentSummary').textContent =
      '✓ Blueprint: ' + r.summary + ' — xem ở ô dưới, rồi sang bước 4 bấm ✦ Dựng sơ đồ.';
    if (auto) await buildFromBlueprint(r.blueprint);
    else toast('Đã tạo blueprint · kiểm tra ở ô dưới, rồi sang bước 4 bấm ✦ Dựng sơ đồ');
  } catch (e) {
    toast(e.message, true);
    throw e;
  } finally {
    btn.disabled = false;
    btn.textContent = '② Lên blueprint';
  }
}
$('#agentScript').onclick = async () => {
  const auto = $('#agentAuto').checked;
  try {
    await runAgentScript();
    if (auto) await runAgentBlueprint(true);
  } catch {} // each step already reported its own error
};
$('#agentBlueprint').onclick = () => runAgentBlueprint($('#agentAuto').checked).catch(() => {});

// Where the Director runs: through the ChatGPT extension (web, no API key) or the API key.
const agentVia = () => ($('#agentViaWeb')?.checked ? 'web' : 'api');
// Hide the API-key config when running via the extension, and show whether a worker is online.
export function paintAgentMode() {
  const web = $('#agentViaWeb')?.checked;
  if ($('#agentApiConfig')) $('#agentApiConfig').style.display = web ? 'none' : '';
  const s = $('#agentWebStatus');
  if (s)
    s.textContent = !web
      ? ''
      : store.state?.worker?.online
        ? '· ● ' + (store.state.worker.count || 1) + ' worker đang nối'
        : '· ◌ chưa thấy worker — mở tab ChatGPT và bật extension';
}
if ($('#agentViaWeb'))
  $('#agentViaWeb').onchange = () => {
    try {
      localStorage.setItem('agentViaWeb', $('#agentViaWeb').checked ? '1' : '0');
    } catch {}
    paintAgentMode();
  };
