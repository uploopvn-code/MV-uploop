import path from 'node:path';
import { NEXT, body, json } from '../http.mjs';
import { activeId, db, save } from '../projects.mjs';
import { data, directorLLM } from '../config.mjs';
import { runObrion, obrionBlueprint } from '../obrion.mjs';
import { buildGraph } from '../../director.mjs';

// Long calls retain their originating project. No writes after switching projects.
const running = new Map();
function sameProject(id) {
  if (!id || id !== activeId) throw new Error('Project đã thay đổi. Mở lại Đạo diễn trước khi tiếp tục.');
}
function draftInput(b) {
  const out = {};
  for (const key of ['title', 'raw_script', 'camera_rules', 'emotion_rules']) {
    if (typeof b[key] !== 'string' || b[key].length > 100000) throw new Error(`Trường ${key} không hợp lệ (tối đa 100000 ký tự).`);
    out[key] = b[key];
  }
  if (!b.asset_bible || typeof b.asset_bible !== 'object' || Array.isArray(b.asset_bible) || JSON.stringify(b.asset_bible).length > 500000)
    throw new Error('Asset Bible phải là JSON object, tối đa 500000 ký tự.');
  return { ...out, asset_bible: b.asset_bible };
}
export async function handle(req, res, p) {
  if (!p.startsWith('/api/director/obrion')) return NEXT;
  if (req.method === 'GET' && p === '/api/director/obrion')
    return json(res, 200, { projectId: activeId, draft: db.obrion || null, running: running.has(activeId), logs: running.get(activeId) || [] });
  if (req.method === 'POST' && p === '/api/director/obrion/check')
    return json(res, 200, await runObrion({ action: 'check' }));
  if (req.method !== 'POST') return NEXT;
  const b = await body(req), id = b.projectId;
  sameProject(id);
  if (running.has(id)) throw new Error('OBRION đang chạy trong project này.');
  const action = p.split('/').at(-1);
  if (!['save', 'generate', 'validate', 'feedback', 'blueprint'].includes(action)) return NEXT;
  const logs = [];
  running.set(id, logs);
  try {
    if (action === 'save' || action === 'generate') {
      const input = draftInput(b);
      db.obrion = { ...db.obrion, ...input };
      save();
      if (action === 'save') return json(res, 200, { draft: db.obrion });
      if (!input.raw_script.trim()) throw new Error('Nhập kịch bản trước khi phân cảnh.');
      if (!directorLLM.configured()) throw new Error('OBRION cần API key ở phần cấu hình Đạo diễn.');
      const result = await runObrion({ ...input, llm: directorLLM.bridgeConfig(), memory: path.join(data, 'director_memory.sqlite3') }, line => {
        logs.push(line);
        if (logs.length > 80) logs.shift();
      });
      sameProject(id);
      db.obrion = { ...input, original: result.production, production: result.production, logs, retries: result.retries };
      save();
      return json(res, 200, { draft: db.obrion });
    }
    const result = await runObrion({ action: 'validate', production: b.production });
    sameProject(id);
    if (action === 'feedback') {
      if (!db.obrion?.original) throw new Error('Chưa có kết quả AI gốc để so sánh.');
      const feedback = await runObrion({ action: 'feedback', original: db.obrion.original,
        corrected: result.production, memory: path.join(data, 'director_memory.sqlite3') });
      sameProject(id);
      db.obrion = { ...db.obrion, production: result.production };
      save();
      return json(res, 200, feedback);
    }
    if (action === 'blueprint') {
      const blueprint = obrionBlueprint(result.production, b.asset_bible || db.obrion?.asset_bible);
      buildGraph(blueprint); // Validate downstream limits before offering it in the editor.
      return json(res, 200, { blueprint });
    }
    db.obrion = { ...db.obrion, production: result.production };
    save();
    return json(res, 200, result);
  } finally {
    running.delete(id);
  }
}
