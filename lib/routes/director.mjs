// Routes: director master prompt, LLM, build graph from blueprint, auto director.
import fs from 'node:fs';
import path from 'node:path';
import {
  MASTER_PROMPT,
  SCRIPT_SYSTEM,
  blueprintFromScript,
  buildGraph,
  parseBlueprint,
} from '../../director.mjs';
import { applyGraph } from '../apply-graph.mjs';
import { directorLLM } from '../config.mjs';
import { runTurn, workerOnline } from '../director-web.mjs';
import { NEXT, body, json } from '../http.mjs';
import { requireNoRunningJobs } from '../jobs.mjs';
import { db, save } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { STREAMS, buildManifest } from '../manifest.mjs';
import { buildSrt, srtInfo } from '../subtitles.mjs';
import { deleteMasterPrompt, listMasterPrompts, saveMasterPrompt } from '../master-prompts.mjs';

export async function handle(req, res, p, u) {
  if (p === '/api/director' && req.method === 'GET')
    return json(res, 200, {
      masterPrompt: db.masterPrompt || MASTER_PROMPT,
      customMaster: !!db.masterPrompt, // true = edited for this project
      defaultMaster: MASTER_PROMPT,
      llm: directorLLM.status(),
    });
  if (p === '/api/director/llm' && req.method === 'POST')
    return json(res, 200, { llm: directorLLM.save(await body(req)) });
  // Master-prompt library: ready-made templates per theme + the user's saved ones. The full
  // prompt is in each row so picking one fills the editor without another round-trip.
  if (p === '/api/director/master-templates' && req.method === 'GET')
    return json(res, 200, { templates: listMasterPrompts() });
  if (p === '/api/director/master-templates/save' && req.method === 'POST') {
    const b = await body(req);
    const saved = saveMasterPrompt(b.name, b.prompt);
    return json(res, 200, { saved, templates: listMasterPrompts() });
  }
  if (p === '/api/director/master-templates/delete' && req.method === 'POST') {
    const b = await body(req);
    if (!deleteMasterPrompt(String(b.id || '')))
      throw new Error('Chỉ xóa được mẫu của bạn (mẫu dựng sẵn không xóa được).');
    return json(res, 200, { templates: listMasterPrompts() });
  }
  // Save (or reset) the master prompt for THIS project. Empty text restores the default.
  if (p === '/api/director/master' && req.method === 'POST') {
    const b = await body(req);
    const text = String(b.masterPrompt || '').slice(0, 100000);
    if (text.trim()) db.masterPrompt = text;
    else delete db.masterPrompt;
    save();
    return json(res, 200, {
      masterPrompt: db.masterPrompt || MASTER_PROMPT,
      customMaster: !!db.masterPrompt,
    });
  }
  if (p === '/api/director/build' && req.method === 'POST') {
    requireNoRunningJobs();
    const b = await body(req);
    applyGraph(buildGraph(b.blueprint));
    return json(res, 200, publicState());
  }
  // Download an .srt subtitle track built from the sung lines: luồng B (⑪ câu hát nhép) when the
  // project has takes, else luồng A's shots. names=1 keeps the "Speaker:" prefix on each line.
  // X-Srt-Stream tells the page which lane it got. Also written into the working folder when set.
  if (p === '/api/director/subtitles.srt' && req.method === 'GET') {
    const keepNames = u.searchParams.get('names') === '1';
    const srt = buildSrt(db.nodes, { keepNames });
    if (!srt.trim())
      throw new Error('Chưa có thoại nào trong storyboard để xuất phụ đề (các shot đều câm).');
    const base = (String(db.name || 'phu-de').replace(/[^\w.\- ]+/g, '_') || 'phu-de').trim();
    const fname = base + '.srt';
    if (db.exportDir)
      try {
        fs.writeFileSync(path.join(db.exportDir, fname), srt);
      } catch {} // a failed export copy must not fail the download
    res.writeHead(200, {
      'Content-Type': 'application/x-subrip; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      'X-Srt-Stream': srtInfo(db.nodes).stream,
    });
    return res.end(srt);
  }
  // Download one stream's edit manifest: luong-A-phu-canh.csv (⑥ ⑦ → ⑧) or luong-B-hat-nhep.csv
  // (⑪ → ⑫). One row per clip, in time order, with the exact clip file name — the sheet an NLE
  // (or the editor's eye) needs to lay the two lanes over each other.
  if (p === '/api/director/manifest.csv' && req.method === 'GET') {
    const stream = u.searchParams.get('stream') === 'B' ? 'B' : 'A';
    const { rows, csv } = buildManifest(db.nodes, stream);
    if (!rows.length)
      throw new Error(
        stream === 'A'
          ? 'Luồng A chưa có shot nào ở cột ⑥ (nhập shot list CSV ở node MUSIC trước).'
          : 'Luồng B chưa có take nào ở cột ⑪ (cắt take hát nhép ở node MUSIC trước).',
      );
    const fname = STREAMS[stream].file;
    if (db.exportDir)
      try {
        fs.writeFileSync(path.join(db.exportDir, fname), csv);
      } catch {} // a failed export copy must not fail the download
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      'X-Manifest-Rows': String(rows.length),
    });
    return res.end(csv);
  }
  // Conversational director. One LLM turn per stage, no server-side state: the client sends
  // back the idea (stage "script") or the approved script (stage "blueprint") each time.
  //  - script:    idea → a readable treatment the user reviews and edits;
  //  - blueprint: the approved script → a JSON blueprint (built later via /api/director/build).
  if (p === '/api/director/agent' && req.method === 'POST') {
    // Neither stage mutates the graph (building happens later via /api/director/build), so the
    // script and blueprint can be drafted even while clips are still rendering.
    const b = await body(req);
    const viaWeb = b.via === 'web';
    if (!viaWeb && !directorLLM.configured())
      throw new Error('Chưa cấu hình API key LLM cho Đạo diễn, hoặc bật "Chạy qua extension".');
    if (viaWeb && !workerOnline())
      throw new Error(
        'Chưa thấy extension ChatGPT online. Mở tab ChatGPT và bấm Bắt đầu trong extension (xem phần ChatGPT).',
      );
    // One LLM turn: through the ChatGPT extension (no API key) or the OpenAI-compatible API.
    const turn = (system, user) => runTurn(b.via, system, user);
    const header = metaHeader(b.meta); // production context: title, type, target duration / song
    if (b.stage === 'blueprint') {
      const script = String(b.script || '').slice(0, 100000);
      if (!script.trim())
        throw new Error('Chưa có kịch bản để lên blueprint. Viết kịch bản ở bước ① trước.');
      const text = await turn(
        db.masterPrompt || MASTER_PROMPT,
        header + blueprintFromScript(script),
      );
      const bp = parseBlueprint(text); // throws on non-JSON — surfaced to the UI
      return json(res, 200, {
        stage: 'blueprint',
        blueprint: JSON.stringify(bp, null, 2),
        summary: summarizeBlueprint(bp),
      });
    }
    const idea = String(b.idea || '').slice(0, 20000);
    if (!idea.trim()) throw new Error('Nhập ý tưởng / logline / lời để Đạo diễn viết kịch bản.');
    const script = await turn(SCRIPT_SYSTEM, header + idea);
    return json(res, 200, { stage: 'script', script });
  }
  if (p === '/api/director/auto' && req.method === 'POST') {
    requireNoRunningJobs();
    const b = await body(req);
    if (!directorLLM.configured()) throw new Error('Chưa cấu hình API key LLM cho Đạo diễn.');
    const song = String(b.song || '').slice(0, 20000);
    if (!song.trim()) throw new Error('Nhập tên bài hát / lời / link để chạy.');
    const text = await directorLLM.complete(
      db.masterPrompt || MASTER_PROMPT,
      'BẮT ĐẦU: ' +
        song +
        '\n\nChỉ trả về đúng khối JSON blueprint theo schema đã mô tả, không thêm chữ nào ngoài khối JSON.',
    );
    applyGraph(buildGraph(text));
    return json(res, 200, publicState());
  }
  return NEXT;
}

// Suggested shot count for a target length: shots run 4–8s (merged clusters are 8s), so a
// storyboard needs roughly seconds/8 … seconds/5 shots to fill the duration. Exported so the UI
// hint and the prompt state the same numbers.
export function shotRange(sec) {
  const lo = Math.max(3, Math.round(sec / 8));
  const hi = Math.max(lo + 1, Math.round(sec / 5));
  return lo + '–' + hi;
}
// A short production-context header prepended to the LLM input so the script/blueprint match the
// film name (or song), the kind, and the TARGET LENGTH — stated as total seconds + how many shots
// to fill it, which overrides any default range baked into the master prompt. For an MV the song's
// length (read in the browser from the mp3) sets the target; for a film the user gives minutes.
function metaHeader(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const s = (v, n = 300) =>
    String(v ?? '')
      .slice(0, n)
      .trim();
  const parts = [];
  const title = s(meta.title);
  if (title) parts.push('Tên: ' + title);
  let sec = 0;
  if (meta.type === 'mv') {
    parts.push('Loại: MV ca nhạc');
    const song = s(meta.song);
    if (song) parts.push('Bài hát: ' + song);
    sec = Number(meta.seconds) || 0;
    if (!sec) parts.push('Thời lượng phân tích theo bài hát ở bước sau');
  } else {
    parts.push('Loại: phim/drama');
    sec = (Number(meta.minutes) || 0) * 60;
  }
  if (sec > 0) {
    const mins = Number(meta.minutes);
    const label = meta.type !== 'mv' && mins > 0 ? ` (~${mins} phút)` : '';
    parts.push(
      `Thời lượng mục tiêu ~${Math.round(sec)} giây${label}; dựng khoảng ${shotRange(sec)} shot ` +
        `(mỗi shot 4–8 giây, cụm ghép 8 giây) sao cho TỔNG duration các shot ≈ ${Math.round(sec)} giây`,
    );
  }
  if (!parts.length) return '';
  return `BỐI CẢNH SẢN XUẤT (ƯU TIÊN hơn mọi con số mặc định trong hướng dẫn) — ${parts.join('; ')}.\n\n`;
}

// A one-line human summary of a blueprint, shown before the user builds it.
function summarizeBlueprint(bp) {
  const n = k => (Array.isArray(bp?.[k]) ? bp[k].length : 0);
  const name = bp?.project?.name || bp?.project?.title || bp?.film?.title || 'Blueprint';
  const parts = [];
  if (n('assets')) parts.push(n('assets') + ' asset');
  if (n('cameras')) parts.push(n('cameras') + ' máy quay');
  if (n('styles')) parts.push(n('styles') + ' style');
  if (n('shots')) parts.push(n('shots') + ' shot');
  return `${name} · ${parts.join(' · ') || 'không rõ cấu trúc'}`;
}
