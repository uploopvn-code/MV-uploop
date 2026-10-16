// Node Kịch bản (SCRIPT): brief → chạy xưởng (truyện → bảng shot → blueprint + QC) → Dựng.
// Xưởng chạy nền ở server; chỗ này chỉ gửi lệnh và vẽ lại trạng thái mà /api/state trả về.
import { store } from './store.js';
import { $, api, copy, esc, toast } from './core.js';
import {
  closeInspector,
  deleteNode,
  normalizeInspectorLayout,
  openInspector,
} from './inspector.js';
import { refresh, render } from './render.js';

const FIELDS = [
  [
    'idea',
    'Ý tưởng / logline',
    'Vợ muốn đi uống cà phê chia tay người yêu cũ trước ngày anh ta cưới; chồng ghen…',
    4,
  ],
  ['country', 'Quốc gia / bối cảnh', 'Việt Nam — căn hộ chung cư TP.HCM', 1],
  ['duration', 'Thời lượng (giây)', '64', 1],
  ['genre', 'Thể loại', 'Drama ngắn dọc 9:16', 1],
  ['tone', 'Tông', 'Căng, lạnh, kết mở cho khán giả phán xét', 1],
  ['chars', 'Số nhân vật', '2', 1],
  ['lang', 'Ngôn ngữ thoại', 'Tiếng Việt', 1],
];

const VIA_LABEL = { claude: 'Claude (gói)', web: 'ChatGPT extension', api: 'API key' };
const clock = ms => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const since = iso => (iso ? clock(Date.now() - Date.parse(iso)) : '');
const kTok = n => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
// What the run has spent so far: "12.3k vào · 4.1k ra · 3 lượt" (+ "ước tính" via ChatGPT web).
const tokensLine = t =>
  t && t.turns
    ? `Token: <b>${kTok(t.in)}</b> vào · <b>${kTok(t.out)}</b> ra · ${t.turns} lượt LLM` +
      (t.model ? ` · ${esc(t.model)}` : '') +
      (t.estimated ? ' · ước tính (ChatGPT web không báo số)' : '')
    : '';
// Trạm nào đang chạy: run.step là số thứ tự (1-based) trong danh sách trạm; step > số trạm = QC.
const runningKey = (steps, run) =>
  run?.status === 'running' && run.step >= 1 ? steps[run.step - 1]?.[0] || 'qc' : '';
// Bước để chạy tiếp khi lỗi: bước server ghi lại, hoặc (lượt cũ chưa ghi) bước đang chạy dở.
const resumeKey = (run, steps) => run.failedAt || steps[run.step - 1]?.[0] || '';
function stageMark(key, steps, run, done) {
  if (runningKey(steps, run) === key) return ' ⏳ đang chạy';
  if (run?.failedAt === key) return ' ❌';
  return done[key] ? ' ✅' : '';
}
// Thanh tiến trình: dính trên đầu inspector và tự cập nhật (xem watchRun), nên cuộn tới trạm nào
// cũng thấy xưởng đang làm gì, trạm này đã chạy bao lâu.
function progressHtml(run, steps, via) {
  if (!run) return '';
  const busy = run.status === 'running';
  const pct = run.total ? Math.round((Math.min(run.step, run.total) / run.total) * 100) : 0;
  const icon = busy ? '⏳' : run.status === 'failed' ? '❌' : run.status === 'stopped' ? '■' : '✅';
  const now = runningKey(steps, run);
  const chips = [...steps.map(([key]) => key), 'qc']
    .map((key, i) => {
      const cls =
        key === now ? 'now' : run.failedAt === key ? 'bad' : i + 1 < run.step || run.status === 'done' ? 'ok' : '';
      return `<span class="${cls}" title="${esc(steps[i]?.[1] || '⑦ QC')}"></span>`;
    })
    .join('');
  return (
    `<div><b>${icon} ${esc(run.label || '')}</b>${run.total ? ` · bước ${Math.min(run.step, run.total)}/${run.total} (${pct}%)` : ''}</div>` +
    `<div class="script-progress-bar">${chips}</div>` +
    (busy
      ? `<div class="field-hint">Trạm này: <b>${since(run.stepAt || run.startedAt)}</b>` +
        ` · tổng: <b>${since(run.startedAt)}</b>` +
        ` · qua ${esc(VIA_LABEL[via] || via || '')}. Mỗi trạm là một lượt LLM, thường 0,5–3 phút — số giây còn chạy là còn làm, không phải treo.</div>`
      : '') +
    (tokensLine(run.tokens) ? `<div class="field-hint">${tokensLine(run.tokens)}</div>` : '') +
    (run.error ? `<div><b>${esc(run.error)}</b></div>` : '') +
    (run.built?.created
      ? `<div>Đã dựng ${run.built.created} shot phủ cảnh${run.built.takes?.takes ? ` + ${run.built.takes.takes} take hát nhép` : ''} trên canvas.</div>`
      : '') +
    (run.built?.unusedCast?.length
      ? `<div class="field-hint">Node không còn shot nào dùng (mẫu cũ): ${esc(run.built.unusedCast.join(', '))} — xoá được.</div>`
      : '') +
    (run.buildError ? `<div>Chưa dựng được graph: <b>${esc(run.buildError)}</b> — sửa rồi bấm Dựng.</div>` : '') +
    (run.status === 'failed' && resumeKey(run, steps)
      ? `<button class="button primary" id="resumeFailed" data-from="${esc(resumeKey(run, steps))}">▶ Chạy tiếp từ bước lỗi</button>` +
        '<div class="field-hint">Kết quả các bước trước đã được giữ, không phải chạy lại từ đầu.</div>'
      : '')
  );
}
// Inspector chỉ vẽ một lần khi mở; trạng thái xưởng thì /api/state làm mới mỗi 4 giây. Cập nhật
// tại chỗ thanh tiến trình, dấu ⏳/✅ từng trạm và chữ của trạm vừa xong (nếu người dùng chưa sửa
// tay ô đó) — không vẽ lại cả bảng để khỏi mất chỗ đang cuộn. Xưởng xong/dừng/lỗi → vẽ lại một lần
// để mở khoá các nút.
let runTimer = null;
function watchRun(id, reopen) {
  clearInterval(runTimer);
  const shown = new Map(
    [...document.querySelectorAll('#inspector [data-stage]')].map(el => [el.dataset.stage, el.value]),
  );
  let wasBusy = store.state.nodes.find(x => x.id === id)?.run?.status === 'running';
  runTimer = setInterval(() => {
    const box = $('#scriptProgress');
    const n = store.state.nodes.find(x => x.id === id);
    if (!box || !n || store.selected !== id) return clearInterval(runTimer);
    const busy = n.run?.status === 'running';
    if (wasBusy && !busy) {
      clearInterval(runTimer);
      return reopen();
    }
    wasBusy = busy;
    if (!busy) return;
    const steps = n.runStages || [];
    box.hidden = false;
    box.innerHTML = progressHtml(n.run, steps, n.via);
    for (const el of document.querySelectorAll('#inspector [data-stage-mark]'))
      el.textContent = stageMark(el.dataset.stageMark, steps, n.run, n.stages || {});
    for (const el of document.querySelectorAll('#inspector [data-stage]')) {
      const key = el.dataset.stage;
      const text = n.stages?.[key] || '';
      if (text !== shown.get(key) && el.value === shown.get(key)) {
        el.value = text;
        shown.set(key, text);
        el.closest('details').open = true;
      }
    }
  }, 1000);
}

// The skill library (builtin presets by genre + the user's own), fetched once per page.
let skillLibrary = null;
async function loadSkills() {
  if (!skillLibrary)
    skillLibrary = (await api('/api/director/master-templates')).templates || [];
  return skillLibrary;
}
function fillSkillSelect(sel, chosen) {
  const opt = t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`;
  const genres = (store.state.promptGenres || []).filter(g =>
    skillLibrary.some(t => (t.genre || 'other') === g.id && t.builtin),
  );
  const mine = skillLibrary.filter(t => !t.builtin);
  sel.innerHTML =
    '<option value="">— Không dùng skill —</option>' +
    genres
      .map(
        g =>
          `<optgroup label="${esc(g.label)}">` +
          skillLibrary.filter(t => t.builtin && (t.genre || 'other') === g.id).map(opt).join('') +
          '</optgroup>',
      )
      .join('') +
    (mine.length ? '<optgroup label="Mẫu của tôi">' + mine.map(opt).join('') + '</optgroup>' : '');
  sel.value = chosen || '';
}

export function inspectScript(n) {
  const id = n.id;
  const b = n.brief || {};
  const run = n.run || null;
  const qc = n.qc || null;
  const busy = run?.status === 'running';
  // Node Nhạc nối vào → xưởng chạy chế độ MV: phân cảnh bám mốc giây của bài, không dựng truyện.
  const song = store.state.nodes.find(
    x => x.kind === 'music' && store.state.edges.some(e => e.source === x.id && e.target === id),
  );
  const songBox = song
    ? `<div class="note">🎵 <b>Chế độ MV</b> — nối từ “${esc(song.name)}”.` +
      (song.analysis
        ? ' Đã có phân tích bài hát: xưởng sẽ phủ kín bài theo đúng mốc giây và lời.'
        : ' <b>Bài này chưa phân tích.</b> Mở node nhạc, bấm phân tích trước — không có mốc giây thì phân cảnh sẽ không khớp bài.') +
      '</div>'
    : '<p class="field-hint">Chưa nối bài hát. Kéo dây từ node <b>Nhạc (MUSIC)</b> vào cổng IN của node này để phân cảnh theo bài; để trống thì xưởng viết drama từ ý tưởng.</p>';

  const brief = FIELDS.map(([k, label, ph, rows]) =>
    rows > 1
      ? `<label>${esc(label)}<textarea id="sb_${k}" rows="${rows}" placeholder="${esc(ph)}">${esc(b[k] || '')}</textarea></label>`
      : `<label>${esc(label)}<input id="sb_${k}" value="${esc(b[k] || '')}" placeholder="${esc(ph)}"></label>`,
  ).join('');

  // Các trạm của chế độ đang chọn, kèm kết quả đã lưu (nếu có).
  const done = n.stages || {};
  const steps = n.runStages || []; // server gửi xuống theo chế độ Nhanh/Kỹ và có nhạc hay không
  const progress = `<div id="scriptProgress" class="script-progress"${run ? '' : ' hidden'}>${progressHtml(run, steps, n.via)}</div>`;
  // Mỗi trạm: kết quả sửa được + nút chạy lại từ chính nó (và mọi trạm sau).
  const stageBoxes = steps
    .map(([key, label]) => {
      const text = done[key] || '';
      return (
        `<details class="inspector-section"${text || run?.failedAt === key ? ' open' : ''}>` +
        `<summary>${esc(label)}<span data-stage-mark="${esc(key)}">${stageMark(key, steps, run, done)}</span></summary>` +
        (key === 'blueprint'
          ? '<p class="field-hint">Blueprint sửa ở mục ③ bên dưới.</p>'
          : `<textarea data-stage="${esc(key)}" rows="8" placeholder="Chưa chạy bước này">${esc(text)}</textarea>`) +
        `<div class="actions"><button class="button" data-run-from="${esc(key)}" ${busy ? 'disabled' : ''}>▶ Chạy tiếp từ đây</button></div>` +
        '<p class="field-hint">Chạy lại chính bước này và mọi bước sau. Sửa tay bước trước rồi bấm nút của bước kế tiếp để dùng bản đã sửa.</p>' +
        '</details>'
      );
    })
    .join('');

  // MV có file nhạc: bộ kiểm khung TỰ THAY mọi ô sai (cú máy không hợp năng lượng, ca sĩ quay
  // chính diện ở luồng phủ cảnh…) ngay khi kiểm, nên những dòng nó báo là biên bản "LLM đã viết
  // sai gì và tool đã chỉnh", KHÔNG phải thứ còn hỏng. Hiện ❌ "còn lỗi" ở đây khiến người dùng
  // tưởng phải sửa trước khi dựng — trong khi bấm Dựng là xong.
  const fixedByTool = n.studioKind === 'mvaudio' && !qc?.ok;
  const qcBox = qc
    ? `<div class="note">${
        qc.ok
          ? '✅ QC sạch'
          : fixedByTool
            ? `⚠ Tool đã tự chỉnh ${qc.errors.length} ô — bấm <b>Dựng</b> được luôn, không cần sửa`
            : `❌ QC còn ${qc.errors.length} lỗi`
      }` +
      (qc.rounds ? ` · LLM đã sửa ${qc.rounds} vòng` : '') +
      (fixedByTool
        ? '<p class="field-hint">Mỗi dòng dưới là chỗ LLM viết chưa đúng luật; tool đã thay bằng giá trị hợp lệ trong bảng sẽ dựng.</p>'
        : '') +
      (qc.errors?.length
        ? '<ul>' +
          qc.errors
            .slice(0, 8)
            .map(e => `<li>${esc(e)}</li>`)
            .join('') +
          '</ul>'
        : '') +
      (qc.warnings?.length
        ? `<details><summary>${qc.warnings.length} cảnh báo</summary><ul>` +
          qc.warnings
            .slice(0, 12)
            .map(w => `<li>${esc(w)}</li>`)
            .join('') +
          '</ul></details>'
        : '') +
      '</div>'
    : '';

  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>✍ ${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
    '<div class="inspector-scroll">' +
    progress +
    `<label>Tên node<input id="scriptName" value="${esc(n.name)}"></label>` +
    `<section class="inspector-section"><h3>① Brief</h3>${songBox}${brief}` +
    // Skill thể loại: chọn từ thư viện (tab Đạo diễn có thể lưu mẫu riêng), rồi sửa tay cho
    // riêng node này; hoặc nạp file .txt/.md. Mọi trạm của xưởng đọc đoạn này.
    `<label>Skill thể loại<select id="scriptSkill"><option value="">${n.skillId ? '…' : '— Không dùng skill —'}</option></select></label>` +
    `<textarea id="scriptSkillText" rows="6" placeholder="Luật thể loại cho xưởng: nhân vật, hình ảnh, ánh sáng, nhịp… Chọn skill ở trên để nạp rồi sửa tuỳ ý, hoặc nạp file.">${esc(n.skillText || '')}</textarea>` +
    `<div class="prompt-tools"><label class="button">Nạp file .txt/.md<input type="file" id="scriptSkillFile" accept=".txt,.md,text/plain" hidden></label></div>` +
    '<p class="field-hint">Skill nói VỀ NỘI DUNG (thể loại, nhân vật, hình ảnh, nhịp); định dạng đầu ra mỗi trạm vẫn do xưởng quy định.</p>' +
    '</section>' +
    '<section class="inspector-section"><h3>② Chạy xưởng</h3>' +
    `<div class="two"><label>Độ kỹ<select id="scriptMode">` +
    `<option value="fast" ${n.mode !== 'full' ? 'selected' : ''}>Nhanh · 3 lượt LLM</option>` +
    `<option value="full" ${n.mode === 'full' ? 'selected' : ''}>Kỹ · 7 trạm riêng</option>` +
    `</select></label><label>Chạy qua<select id="scriptVia">` +
    // Claude: chạy Claude Code CLI trên máy này, trừ vào GÓI Claude (Pro/Max) đã đăng nhập —
    // không cần API key, không cần mở tab trình duyệt.
    `<option value="claude" ${n.via === 'claude' ? 'selected' : ''}>Claude (gói Pro/Max của bạn)</option>` +
    `<option value="web" ${n.via === 'web' ? 'selected' : ''}>Extension ChatGPT</option>` +
    `<option value="api" ${!['web', 'claude'].includes(n.via) ? 'selected' : ''}>API key LLM</option>` +
    '</select></label></div>' +
    // Khuôn hình của cả phim: đặt NGAY đây để mọi ảnh/video render đúng chiều. Mặc định ngang
    // 16:9. Áp vào cài đặt project (store.state.defaults.aspect) — một nơi duy nhất.
    `<label>🖼 Khuôn hình phim<select id="scriptAspect">` +
    [
      ['16:9', 'Ngang · 16:9'],
      ['9:16', 'Dọc · 9:16'],
      ['1:1', 'Vuông · 1:1'],
      ['4:3', 'Ngang · 4:3'],
      ['3:4', 'Dọc · 3:4'],
    ]
      .map(
        ([a, label]) =>
          `<option value="${a}" ${a === (store.state.defaults?.aspect || '16:9') ? 'selected' : ''}>${label}</option>`,
      )
      .join('') +
    '</select></label>' +
    '<p class="field-hint">Chọn chiều phim TRƯỚC khi chạy — mọi ảnh và video sẽ render đúng chiều này. Đổi sau sẽ đánh dấu ảnh/video cũ cần làm lại.</p>' +
    `<label class="music-via"><input type="checkbox" id="scriptAutoBuild" ${n.autoBuild !== false ? 'checked' : ''}> Chạy xong tự dựng graph</label>` +
    '<p class="field-hint">Nhanh: ① truyện → ②–⑤ gộp → ⑥ ráp JSON. Kỹ: tách 7 trạm, chất lượng cao hơn nhưng chậm và tốn token hơn. Sau đó ⑦ QC bằng chính validator của tool, tự sửa tối đa 2 vòng.</p>' +
    `<div class="actions"><button class="button primary" id="runScript" ${busy ? 'disabled' : ''}>▶ Chạy xưởng</button>` +
    `<button class="button" id="stopScript" ${busy ? '' : 'disabled'}>■ Dừng</button></div></section>` +
    stageBoxes +
    '<section class="inspector-section"><h3>③ Blueprint</h3>' +
    qcBox +
    `<textarea id="scriptBlueprint" rows="14" placeholder="Chạy xưởng để sinh, hoặc dán blueprint JSON vào đây">${esc(n.blueprint || '')}</textarea>` +
    `<div class="prompt-tools"><button id="copyBlueprint">Sao chép</button><button id="qcScript">↻ Kiểm lại (QC)</button></div>` +
    `<div class="actions"><button class="button primary" id="buildScript" ${n.blueprint ? '' : 'disabled'}>⤓ Dựng graph từ blueprint</button></div>` +
    '<p class="field-hint">Dựng sẽ <b>thay toàn bộ graph hiện tại</b> và reset hàng đợi. Node kịch bản này được giữ lại.</p></section>' +
    `<div class="inspector-footer"><button class="button wide" id="saveScript">Lưu</button>` +
    `<button class="button wide danger" id="deleteNode">Xóa node này</button></div></div>`;
  openInspector('script');
  normalizeInspectorLayout();

  const run_ = fn => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const save = async () => {
    const body = { id, brief: {} };
    for (const [k] of FIELDS) body.brief[k] = $(`#sb_${k}`).value;
    if ($('#scriptName').value !== n.name) body.name = $('#scriptName').value;
    body.mode = $('#scriptMode').value;
    body.via = $('#scriptVia').value;
    body.skillId = $('#scriptSkill').value;
    body.skillText = $('#scriptSkillText').value;
    if ($('#scriptBlueprint').value !== (n.blueprint || ''))
      body.blueprint = $('#scriptBlueprint').value;
    // Kết quả từng trạm có thể đã sửa tay: gửi lên để lần "chạy tiếp" dùng bản đã sửa.
    const edited = {};
    for (const el of document.querySelectorAll('#inspector [data-stage]'))
      if (el.value !== (n.stages?.[el.dataset.stage] || '')) edited[el.dataset.stage] = el.value;
    if (Object.keys(edited).length) body.stages = edited;
    store.state = await api('/api/node', { method: 'PATCH', body });
  };
  // Chạy lại từ một trạm: lưu mọi sửa tay trước đã, rồi gọi xưởng với `from`.
  const runFrom = from =>
    run_(async () => {
      await save();
      // Chạy lại TỪ ĐẦU sẽ xoá kết quả các bước đã có. Hỏi trước — người dùng chạy xong 7/7 rồi
      // lỡ bấm "Chạy xưởng" là mất sạch công.
      const done = Object.keys(store.state.nodes.find(x => x.id === id)?.stages || {}).length;
      let restart = false;
      if (!from && done) {
        if (
          !confirm(
            `Node này đã có kết quả của ${done} bước.\n\n` +
              'Chạy lại từ đầu sẽ XOÁ HẾT và viết lại từ bước ①.\n' +
              'Muốn giữ các bước đã xong thì bấm Huỷ, rồi dùng "▶ Chạy tiếp từ đây" ở đúng bước cần làm lại.\n\n' +
              'Vẫn chạy lại từ đầu?',
          )
        )
          return;
        restart = true;
      }
      store.state = await api('/api/script/run', {
        method: 'POST',
        body: {
          id,
          mode: $('#scriptMode').value,
          via: $('#scriptVia').value,
          from,
          restart,
          autoBuild: $('#scriptAutoBuild').checked,
        },
      });
      render();
      reopen();
      toast(from ? 'Đang chạy tiếp từ bước đã chọn…' : 'Xưởng đang chạy…');
    });
  const reopen = () => {
    const x = store.state.nodes.find(y => y.id === id);
    if (x && store.selected === id) inspectScript(x);
  };
  $('.close').onclick = closeInspector;
  watchRun(id, reopen);
  // Đổi khuôn hình phim → áp ngay vào cài đặt project (một nơi quyết định tỉ lệ mọi ảnh/video).
  $('#scriptAspect').onchange = run_(async () => {
    const aspect = $('#scriptAspect').value;
    if (aspect === (store.state.defaults?.aspect || '16:9')) return;
    store.state = await api('/api/project', {
      method: 'PATCH',
      body: { defaults: { ...(store.state.defaults || {}), aspect } },
    });
    render();
    toast('Đã đặt khuôn hình: ' + aspect);
  });
  loadSkills()
    .then(() => fillSkillSelect($('#scriptSkill'), n.skillId))
    .catch(e => toast(e.message, true));
  $('#scriptSkill').onchange = () => {
    const t = (skillLibrary || []).find(x => x.id === $('#scriptSkill').value);
    if (t) $('#scriptSkillText').value = t.prompt;
  };
  $('#scriptSkillFile').onchange = async () => {
    const f = $('#scriptSkillFile').files[0];
    if (!f) return;
    $('#scriptSkillText').value = await f.text();
    $('#scriptSkill').value = '';
    toast('Đã nạp skill từ ' + f.name + ' — bấm Lưu hoặc Chạy xưởng.');
  };
  $('#saveScript').onclick = run_(async () => {
    await save();
    render();
    reopen();
    toast('Đã lưu');
  });
  $('#copyBlueprint').onclick = () => copy($('#scriptBlueprint').value);
  $('#qcScript').onclick = run_(async () => {
    store.state = await api('/api/script/qc', {
      method: 'POST',
      body: { id, blueprint: $('#scriptBlueprint').value },
    });
    render();
    reopen();
  });
  $('#runScript').onclick = runFrom(''); // chạy lại từ đầu
  if ($('#resumeFailed')) $('#resumeFailed').onclick = runFrom($('#resumeFailed').dataset.from);
  for (const btn of document.querySelectorAll('#inspector [data-run-from]'))
    btn.onclick = runFrom(btn.dataset.runFrom);
  $('#stopScript').onclick = run_(async () => {
    store.state = await api('/api/script/stop', { method: 'POST', body: { id } });
    render();
    reopen();
  });
  $('#buildScript').onclick = run_(async () => {
    await save();
    const cur = store.state.nodes.find(x => x.id === id);
    // MV có file nhạc: đầu ra là bảng CSV đã điền → dựng bằng đúng bộ dựng hai luồng mà nút
    // "✨ Tạo storyboard tự động" của node Nhạc đang dùng (căn lại giây theo vocal thật, dựng
    // luồng phủ cảnh + luồng hát nhép).
    // MV có file nhạc: bảng shot đã điền + dàn nhân vật của treatment → bộ dựng hai luồng (căn lại
    // giây theo vocal thật, luồng phủ cảnh + luồng hát nhép), cùng đường với "tự dựng" khi xưởng xong.
    if (cur?.studioKind === 'mvaudio') {
      if (!cur.mvCsv) throw new Error('Chưa có bảng shot đã điền — chạy xưởng trước.');
      if (
        !confirm(
          'Dựng MV hai luồng (phủ cảnh + hát nhép) từ bảng đã điền, nhân vật + bối cảnh theo treatment, căn giây theo vocal thật? Các shot cũ sẽ được thay.',
        )
      )
        return;
      store.state = await api('/api/script/build', { method: 'POST', body: { id } });
      await refresh();
      render();
      reopen();
      toast('Đã dựng MV hai luồng.');
      return;
    }
    if (!confirm('Dựng sẽ thay toàn bộ graph hiện tại và reset hàng đợi. Tiếp tục?')) return;
    store.state = await api('/api/script/build', { method: 'POST', body: { id } });
    await refresh();
    render();
    reopen();
    toast('Đã dựng graph từ blueprint.');
  });
  $('#deleteNode').onclick = () => deleteNode(id);
}
