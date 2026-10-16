// Chạy xưởng kịch bản qua Claude Code CLI = gói Claude (Pro/Max) đã đăng nhập trên máy.
//
// Test này gọi Claude THẬT (không có bản giả nào đóng vai Claude). Nên:
//   - máy không có Claude Code → bỏ qua, báo rõ là bỏ qua (không giả vờ PASS);
//   - có → chạy MỘT lượt xưởng Nhanh, ngắn, trên Sonnet: tốn chút quota của gói.
// Không nằm trong `npm test` vì nó tiêu quota thật; chạy tay: node test-claude-cli.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { claudeAvailable, claudeComplete } from './lib/claude-cli.mjs';
import { normVia } from './lib/director-web.mjs';

// --- Chuẩn hoá via: 'claude' KHÔNG được bị ép về 'api' ----------------------------------------
assert.equal(normVia('claude'), 'claude', "via 'claude' giữ nguyên");
assert.equal(normVia('web'), 'web');
assert.equal(normVia('api'), 'api');
assert.equal(normVia('linh tinh'), 'api', 'giá trị lạ rơi về api');

if (!claudeAvailable()) {
  console.log('SKIP: máy này không có Claude Code (lệnh `claude`) — không có gì để kiểm.');
  process.exit(0);
}

// --- 1) Một lượt thẳng: dùng GÓI, không dùng API key ---------------------------------------
// Đặt một API key GIẢ vào môi trường: nếu module quên gỡ nó, Claude Code sẽ dùng key giả đó và
// báo lỗi xác thực. Trả lời được nghĩa là nó đã đi bằng đăng nhập gói.
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-GIA-DE-KIEM-' + 'x'.repeat(40);
const one = await claudeComplete('Chỉ trả lời đúng chữ được yêu cầu.', 'Trả lời đúng một từ: SẴN');
assert.match(one, /SẴN/, 'Claude trả lời được — tức là KHÔNG dùng API key giả trong env: ' + one);

// --- 2) Cả xưởng kịch bản qua route thật ---------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-claude-'));
const PORT = 17813;
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    MV_PORT: String(PORT),
    MV_ORBIT_URL: 'http://127.0.0.1:1',
    MV_DATA_DIR: dir,
  },
  stdio: 'pipe',
});
const api = async (p, method = 'GET', b) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const node = async id =>
  (await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json()).nodes.find(n => n.id === id);

try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  let r = await api('/api/nodes', 'POST', { kind: 'script', name: 'Kịch bản' });
  const id = r.data.nodes.find(n => n.kind === 'script').id;

  // --- Trợ lý đạo diễn qua gói Claude (không API key) --------------------------------------
  r = await api('/api/assistant/claude', 'POST', { via: 'claude' });
  assert.equal(r.data.via, 'claude', 'trợ lý lưu nguồn = gói Claude');
  assert.equal(r.data.configured, true, 'có Claude Code → trợ lý sẵn sàng dù không có API key');
  const st = (await api('/api/state')).data;
  r = await api('/api/assistant/plan', 'POST', {
    request: 'Tạo một node bối cảnh tên "Sân khấu đêm": sân khấu tối, một luồng đèn xanh từ trên xuống.',
    projectId: st.activeProjectId,
    revision: st.revision,
    history: [],
  });
  assert.equal(r.status, 200, 'trợ lý lập được kế hoạch qua gói: ' + JSON.stringify(r.data)?.slice(0, 300));
  assert.equal(r.data.source, 'claude');
  assert.ok(r.data.actions?.length || r.data.question, 'kế hoạch có thao tác hoặc câu hỏi');
  assert.ok(r.data.usage.usage.outputTokens > 0, 'sổ token vẫn ghi được khi chạy qua gói');
  console.log(
    `PASS: Trợ lý qua gói Claude — ${r.data.actions?.map(a => a.type).join(', ') || 'hỏi lại'} · ` +
      `${r.data.usage.model} · ${r.data.usage.usage.outputTokens} token ra`,
  );

  // --- Trợ lý lập QUY TRÌNH cho một yêu cầu cả chuỗi mà quy trình dựng sẵn không khớp -------
  const st2 = (await api('/api/state')).data;
  r = await api('/api/assistant/plan', 'POST', {
    request:
      'Viết kịch bản chế độ Kỹ, dựng graph, tạo ảnh nhân vật và bối cảnh, hỏi tôi trước khi quay video, quay xong thì đóng gói zip',
    projectId: st2.activeProjectId,
    revision: st2.revision,
    history: [],
  });
  assert.equal(r.status, 200, 'trợ lý lập quy trình: ' + JSON.stringify(r.data)?.slice(0, 400));
  assert.equal(r.data.source, 'claude', 'câu lạ → Claude lập, không phải quy trình có sẵn');
  const plan = r.data.actions?.[0];
  assert.equal(plan?.type, 'run_recipe', 'ra đúng một bước run_recipe: ' + JSON.stringify(r.data.actions));
  const kinds = plan.steps.map(s => s.type);
  assert.equal(plan.steps[0].type, 'script');
  assert.equal(plan.steps[0].mode, 'full', 'chế độ Kỹ');
  assert.ok(kinds.includes('images') && kinds.includes('videos') && kinds.at(-1) === 'package');
  assert.ok(
    kinds.indexOf('confirm') > -1 && kinds.lastIndexOf('confirm') < kinds.indexOf('videos'),
    'có điểm dừng trước video: ' + kinds.join(' → '),
  );
  assert.ok(plan.triggers.length >= 1, 'có câu kích hoạt để lần sau không cần Claude');
  console.log(
    `PASS: Trợ lý lập quy trình qua Claude — ${kinds.join(' → ')} · nhớ cho: ${plan.triggers.join(' / ')}`,
  );
  await api('/api/node', 'PATCH', {
    id,
    via: 'claude',
    brief: {
      idea: 'Tiểu phẩm 16 giây: một người cố mở hũ dưa, ba lần, lần sau quá đà hơn.',
      duration: '16',
    },
  });
  assert.equal((await node(id)).via, 'claude', 'node lưu đúng via=claude (trước đây bị ép về api)');

  r = await api('/api/script/run', 'POST', { id, mode: 'fast', via: 'claude' });
  assert.equal(
    r.status,
    200,
    'xưởng nhận chạy qua Claude: ' + JSON.stringify(r.data)?.slice(0, 200),
  );
  let n;
  for (let i = 0; i < 900; i++) {
    n = await node(id);
    if (['done', 'failed', 'stopped'].includes(n?.run?.status)) break;
    await new Promise(r2 => setTimeout(r2, 1000));
  }
  assert.equal(
    n.run.status,
    'done',
    'xưởng chạy xong qua Claude: ' + (n.run.error || n.run.status),
  );
  assert.ok(n.stages.story?.length > 100, 'trạm ① có nội dung thật từ Claude');
  assert.ok(n.blueprint?.length > 100, 'có blueprint');
  assert.ok(n.qc, 'có kết quả QC');
  console.log(
    `PASS: Claude Code CLI — via 'claude' không bị ép về api, gỡ ANTHROPIC_API_KEY nên đi bằng ` +
      `gói đã đăng nhập, chạy trọn xưởng Nhanh (${Object.keys(n.stages).length} bước, ` +
      `QC ${n.qc.ok ? 'sạch' : n.qc.errors.length + ' lỗi'})`,
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
