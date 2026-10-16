// Routes: node Kịch bản (SCRIPT). Chạy xưởng (ý tưởng → truyện → bảng shot → blueprint + QC),
// kiểm lại blueprint đã sửa tay, và dựng graph từ nó.
//
// Chạy nền giống /api/music/auto: đặt n.run = {status, step, …} rồi cập nhật dần, UI đọc qua
// /api/state. Không đụng graph cho tới khi bấm Dựng, nên vẫn soạn được trong lúc đang render.
import crypto from 'node:crypto';
import { applyGraph } from '../apply-graph.mjs';
import { measureSong, measuredBrief, measuredOf } from '../music-measure.mjs';
import { songOf, studioKind } from '../studio-kind.mjs';
import { buildGraph } from '../../director.mjs';
import { normVia, requireLLM, runTurnFull } from '../director-web.mjs';
import { musicImport } from './music.mjs';
import { NEXT, body, json } from '../http.mjs';
import { requireIdle } from '../jobs.mjs';
import { getNode } from '../nodes.mjs';
import { db, save, scriptTasks } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { parseCast } from '../music-auto.mjs';
import { MODES, missingBefore, qcBlueprint, runStudio, stages } from '../script-studio.mjs';

export const isScript = n => n?.kind === 'script';
const scriptNode = id => {
  const n = getNode(id);
  if (!n || !isScript(n)) throw new Error('Node kịch bản không tồn tại.');
  return n;
};
// Bài hát + phân tích của nó, viết thành một đoạn cho LLM đọc.
function songText(m) {
  if (!m) return '';
  const a = m.analysis?.json || null;
  const secs = Array.isArray(a?.sections) ? a.sections : [];
  const head = a
    ? [
        a.title && `Tên: ${a.title}`,
        a.artist && `Nghệ sĩ: ${a.artist}`,
        a.language && `Ngôn ngữ: ${a.language}`,
        a.bpm && `BPM: ${a.bpm}`,
        a.key && `Tông: ${a.key}`,
        a.genre && `Thể loại: ${a.genre}`,
        a.mood && `Mood: ${a.mood}`,
        a.energyCurve && `Đường năng lượng: ${a.energyCurve}`,
        a.styleHints && `Gợi ý style: ${a.styleHints}`,
        a.cameraHints && `Gợi ý máy quay: ${a.cameraHints}`,
      ]
        .filter(Boolean)
        .join('\n')
    : measuredOf(m)
      ? '(xem phần BÀI HÁT — TOOL ĐÃ ĐO bên dưới)'
      : '(node nhạc chưa phân tích — chỉ có file/lời)';
  const total = Number(a?.durationSec) || Number(m.audioDuration) || 0;
  const table = secs.length
    ? '\nCẤU TRÚC BÀI (giây):\n' +
      secs
        .map(
          s =>
            `- ${s.startSec ?? '?'}–${s.endSec ?? '?'} ${s.name || ''}` +
            (s.energy ? ` (${s.energy})` : '') +
            (String(s.lyric || '').trim() ? `: "${String(s.lyric).trim().slice(0, 200)}"` : ''),
        )
        .join('\n')
    : '';
  const lyrics = String(m.lyrics || '').trim();
  return (
    `BÀI HÁT (node Nhạc nối vào node này):\n${head}\n` +
    (total ? `Tổng thời lượng: ${Math.round(total)} giây\n` : '') +
    table +
    (lyrics ? `\nLỜI BÀI HÁT:\n${lyrics.slice(0, 8000)}\n` : '')
  ).trim();
}
// Brief người dùng điền trên node, gộp thành một đoạn cho LLM.
const briefText = n => {
  const b = n.brief || {};
  const line = (k, v) => (String(v || '').trim() ? `${k}: ${String(v).trim()}\n` : '');
  const song = songText(songOf(n));
  // The genre skill: content rules (characters, imagery, pacing, lighting…) every station reads.
  // Library skills were written for the Director tab's blueprint step and end with "output this
  // JSON" — the header says the station's own output format wins, so the CSV fill step is not
  // talked into returning a blueprint.
  const skill = String(n.skillText || '').trim();
  return (
    line('Ý TƯỞNG / LOGLINE', b.idea) +
    line('QUỐC GIA', b.country) +
    line('THỜI LƯỢNG (giây)', b.duration) +
    line('THỂ LOẠI', b.genre) +
    line('TÔNG', b.tone) +
    line('SỐ NHÂN VẬT', b.chars) +
    line('NGÔN NGỮ THOẠI', b.lang) +
    (song ? '\n' + song : '') +
    (skill
      ? '\n\nSKILL THỂ LOẠI (bám luật về nội dung, nhân vật, hình ảnh, ánh sáng, nhịp; ĐỊNH DẠNG ' +
        'ĐẦU RA vẫn theo hướng dẫn của trạm đang chạy, không theo skill):\n' +
        skill.slice(0, 60000)
      : '')
  ).trim();
};
// Một node chỉ chạy một lượt xưởng; Map (scriptTasks, ở projects.mjs để lúc nạp project biết lượt
// nào còn sống) giữ promise để không chạy chồng.
const running = scriptTasks;

// Dựng graph từ kết quả xưởng: MV có file nhạc → bộ dựng hai luồng của node Nhạc (căn giây theo
// vocal thật, luồng phủ cảnh + luồng hát nhép); còn lại → blueprint (phải qua QC).
export async function buildFromStudio(n, { force = false } = {}) {
  if (studioKind(n) === 'mvaudio') {
    if (!String(n.mvCsv || '').trim()) throw new Error('Chưa có bảng shot đã điền — chạy xưởng trước.');
    const music = songOf(n);
    if (!music) throw new Error('Không thấy node Nhạc nối vào.');
    return musicImport({
      id: music.id,
      csv: n.mvCsv,
      replaceShots: true,
      autoWire: true,
      takes: true,
      // the treatment's cast: its people + places become the project's nodes, every row wires to them
      cast: parseCast(n.stages?.story),
    });
  }
  requireIdle();
  if (!String(n.blueprint || '').trim()) throw new Error('Chưa có blueprint để dựng.');
  const qc = qcBlueprint(n.blueprint);
  if (!qc.ok && !force)
    throw new Error('QC còn lỗi: ' + qc.errors.slice(0, 3).join(' · ') + ' — sửa rồi dựng lại.');
  // applyGraph giữ lại node kịch bản (như node nhạc), nên brief không mất khi dựng.
  applyGraph(buildGraph(JSON.stringify(qc.blueprint)));
  save();
  return publicState();
}

// Start one studio run on a script node (the /api/script/run body: mode, via, from, restart,
// autoBuild) and return at once; progress lives on n.run. Also driven by a recipe.
export function startStudioRun(n, b) {
  if (running.has(n.id)) throw new Error('Node này đang chạy — đợi xong hoặc bấm Dừng.');
  const via = normVia(b.via);
  const mode = MODES.includes(b.mode) ? b.mode : 'fast';
  requireLLM(via);
  if (!briefText(n)) throw new Error('Nhập ít nhất Ý tưởng / logline trước khi chạy xưởng.');
  // Có node Nhạc nối vào → MV. Có cả FILE nhạc → 'mvaudio': máy đo bài thật rồi LLM chỉ điền
  // khung, dựng hai luồng (lib/studio-kind.mjs giải thích ba chế độ).
  const kind = studioKind(n);
  const music = songOf(n);
  // Đo bài cần lời (khung chia theo câu hát) — chặn ngay, đừng để chạy xong treatment rồi mới hỏng.
  if (kind === 'mvaudio' && !String(music.lyrics || '').trim())
    throw new Error(
      'Node Nhạc có file nhưng chưa có LỜI bài hát. Dán lời vào node Nhạc: khung shot chia theo ' +
        'từng câu hát, và luồng hát nhép cần lời để căn khẩu hình.',
    );
  const list = stages(mode, kind);
  // Chạy tiếp từ một trạm: các trạm TRƯỚC nó phải đã có kết quả (lưu trong n.stages).
  const from = list.some(s => s.key === b.from) ? b.from : '';
  n.stages = n.stages || {};
  if (from) {
    const missing = missingBefore(mode, kind, from, n.stages);
    if (missing.length)
      throw new Error(
        'Chưa chạy được từ bước này — còn thiếu kết quả của: ' +
          missing.map(s => s.label).join(', '),
      );
  } else if (Object.keys(n.stages).length) {
    // Chạy lại từ đầu sẽ XOÁ kết quả các bước đã có. Trước đây nó xoá lặng lẽ — người dùng
    // chạy xong 7/7 rồi lỡ bấm "Chạy xưởng" là mất sạch. Giờ phải nói rõ ý muốn.
    if (!b.restart)
      throw new Error(
        `Node này đã có kết quả của ${Object.keys(n.stages).length} bước. ` +
          'Chạy lại từ đầu sẽ xoá hết — bấm "▶ Chạy tiếp từ đây" ở đúng bước muốn làm lại, ' +
          'hoặc xác nhận chạy lại từ đầu.',
      );
    n.stages = {};
  }
  n.mode = mode;
  n.via = via;
  // Chạy xong thì tự dựng graph luôn (mặc định bật) — không phải ngồi chờ để bấm Dựng.
  n.autoBuild = b.autoBuild !== false;
  // Mỗi lượt chạy có mã riêng: lượt CŨ (đã bị dừng) khi trả về sẽ thấy mã khác và không
  // ghi gì nữa. Trước đây bấm Dừng rồi chạy lại là hai lượt cùng ghi vào một node.
  const runId = crypto.randomUUID();
  n.run = {
    id: runId,
    status: 'running',
    step: 0,
    kind,
    total: list.length + 1,
    label: 'Bắt đầu',
    key: from || list[0]?.key || '',
    from,
    failedAt: '',
    startedAt: new Date().toISOString(),
    error: '',
    // what the run has spent so far, by LLM turn (the UI shows it live); `estimated` when
    // any turn went through ChatGPT web, whose spend is only guessed from text length
    tokens: { in: 0, out: 0, turns: 0, estimated: false, model: '' },
  };
  save();
  let task;
  task = (async () => {
    try {
      // MV có file nhạc: đo bài THẬT trước mọi trạm (Demucs, vài phút trên CPU; đo rồi thì lần
      // sau lấy bản đã lưu). Các trạm sáng tạo đọc tóm tắt đo được, bước điền nhận cả khung.
      let skeleton = null;
      let measured = '';
      if (kind === 'mvaudio') {
        if (n.run?.id === runId)
          Object.assign(n.run, { label: '🎧 Đo bài hát (tách vocal, năng lượng)…' });
        save();
        skeleton = await measureSong(music, {
          onProgress: pct => {
            if (n.run?.id === runId && n.run?.status === 'running')
              n.run.label = `🎧 Đo bài hát… ${Math.round(pct)}%`;
          },
        });
        if (n.run?.id !== runId || n.run?.status !== 'running') return; // dừng trong lúc đo
        measured = measuredBrief(skeleton);
      }
      const out = await runStudio({
        brief: briefText(n) + (measured ? '\n\n' + measured : ''),
        mode,
        kind,
        from,
        skeleton,
        prior: { ...n.stages },
        turn: async (system, user) => {
          const r = await runTurnFull(via, system, user);
          if (n.run?.id === runId) {
            const t = n.run.tokens || (n.run.tokens = { in: 0, out: 0, turns: 0, estimated: false, model: '' });
            const u = r.usage || {};
            t.in += (u.inputTokens || 0) + (u.cacheCreationTokens || 0) + (u.cacheReadTokens || 0);
            t.out += u.outputTokens || 0;
            t.turns++;
            if (r.estimated) t.estimated = true;
            if (r.model) t.model = r.model;
            save();
          }
          return r.text;
        },
        stopped: () => n.run?.id !== runId || n.run?.status !== 'running',
        onStep: (step, total, label, key) => {
          if (n.run?.id === runId && n.run?.status === 'running')
            Object.assign(n.run, {
              step,
              total,
              label,
              key,
              // Giờ bắt đầu trạm hiện tại: UI đếm "trạm này đã chạy bao lâu" (một lượt LLM có thể
              // mất vài phút — không có số đếm thì trông như treo).
              stepAt: label !== n.run.label ? new Date().toISOString() : n.run.stepAt,
            });
        },
        // Lưu NGAY từng trạm: một trạm sau hỏng cũng không mất công các trạm trước.
        onStage: (key, text) => {
          if (n.run?.id !== runId || n.run?.status !== 'running') return; // lượt đã bị dừng
          n.stages = { ...n.stages, [key]: text };
          if (key === 'blueprint') n.blueprint = text;
          save();
        },
      });
      if (n.run?.id !== runId || n.run?.status !== 'running') return; // đã bị dừng / có lượt mới
      n.stages = { ...n.stages, ...out };
      n.blueprint = out.blueprint || '';
      // MV có file nhạc: đầu ra là bảng CSV đã điền, nhập thẳng vào bộ dựng hai luồng.
      n.mvCsv = kind === 'mvaudio' ? out.shots || '' : '';
      n.qc = out.qc;
      if (n.autoBuild) {
        // MV có file nhạc: bộ kiểm khung đã tự thay mọi ô sai, nên bảng luôn dựng được. Drama:
        // chỉ dựng khi QC sạch — blueprint còn lỗi thì dựng ra graph hỏng.
        Object.assign(n.run, { label: '⤓ Đang dựng graph…' });
        save();
        try {
          const state = await buildFromStudio(n);
          n.run = {
            ...n.run,
            status: 'done',
            step: n.run.total,
            label: 'Xong · đã dựng graph',
            failedAt: '',
            // chỉ vài con số cho UI — bản tóm tắt nhập đủ (căn giây từng dòng…) nặng, không lưu
            built: state.importSummary
              ? {
                  created: state.importSummary.created,
                  takes: { takes: state.importSummary.takes?.takes || 0 },
                  cast: state.importSummary.cast,
                  unusedCast: state.importSummary.unusedCast,
                }
              : { created: state.nodes.filter(x => x.zone === 'production' && !x.terminal).length },
          };
        } catch (e) {
          n.run = {
            ...n.run,
            status: 'done',
            step: n.run.total,
            label: 'Xong · chưa dựng được graph',
            failedAt: '',
            buildError: e.message,
          };
        }
      } else
        n.run = { ...n.run, status: 'done', step: n.run.total, label: 'Xong', failedAt: '' };
    } catch (e) {
      if (n.run?.id !== runId) return; // lượt cũ: im lặng, đừng báo lỗi đè lên lượt mới
      if (e.stopped) {
        n.run = { ...n.run, status: 'stopped', label: 'Đã dừng' };
        return;
      }
      if (n.run)
        n.run = { ...n.run, status: 'failed', error: e.message, failedAt: e.stageKey || '' };
    } finally {
      if (running.get(n.id) === task) running.delete(n.id);
      save();
    }
  })();
  running.set(n.id, task);
}

export async function handle(req, res, p, u) {
  if (p === '/api/script/run' && req.method === 'POST') {
    const b = await body(req);
    startStudioRun(scriptNode(b.id), b);
    return json(res, 200, publicState());
  }
  if (p === '/api/script/stop' && req.method === 'POST') {
    const n = scriptNode((await body(req)).id);
    // Lượt LLM đang bay không huỷ được, nhưng đánh dấu dừng thì kết quả của nó bị bỏ qua.
    if (n.run?.status === 'running') n.run = { ...n.run, status: 'stopped', label: 'Đã dừng' };
    running.delete(n.id);
    save();
    return json(res, 200, publicState());
  }
  // Kiểm lại blueprint (sau khi sửa tay trong ô JSON) mà không gọi LLM.
  if (p === '/api/script/qc' && req.method === 'POST') {
    const b = await body(req);
    const n = scriptNode(b.id);
    if (typeof b.blueprint === 'string') n.blueprint = b.blueprint.slice(0, 400000);
    const qc = qcBlueprint(n.blueprint);
    n.qc = { ok: qc.ok, errors: qc.errors, warnings: qc.warnings, rounds: n.qc?.rounds || 0 };
    if (qc.blueprint) n.blueprint = JSON.stringify(qc.blueprint, null, 2);
    save();
    return json(res, 200, publicState());
  }
  // Dựng graph từ blueprint của node. Thay graph hiện tại, nên đòi hàng đợi rảnh.
  if (p === '/api/script/build' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const n = scriptNode(b.id);
    // MV có file nhạc: bảng CSV đã điền + dàn nhân vật của treatment → bộ dựng hai luồng của node
    // Nhạc (căn lại giây theo vocal, luồng phủ cảnh + luồng hát nhép). Còn lại: blueprint.
    return json(res, 200, await buildFromStudio(n, { force: !!b.force }));
  }
  return NEXT;
}
