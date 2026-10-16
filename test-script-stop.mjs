// Ba lỗi thật của node Kịch bản, người dùng gặp sau khi chạy xong 7/7:
//   ① Bấm "Chạy xưởng" XOÁ SẠCH kết quả các bước đã có, lặng lẽ, không hỏi.
//   ② Bấm "Dừng" không dừng được: vòng lặp không hề kiểm cờ, nó chạy hết cả bảy trạm.
//   ③ Dừng xong chạy lại → HAI lượt cùng ghi vào một node, lượt cũ đè lượt mới.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stages } from './lib/script-studio.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-stop-'));
const PORT = 17809;
const start = () =>
  spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      MV_PORT: String(PORT),
      MV_ORBIT_URL: 'http://127.0.0.1:1',
      MV_DATA_DIR: dir,
    },
    stdio: 'pipe',
  });
let proc = start();
const api = async (p, method = 'GET', b) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const state = async () => (await api('/api/state')).data;
const node = async id => (await state()).nodes.find(n => n.id === id);
const settle = async (test, ms = 20000) => {
  for (let i = 0; i < ms / 50; i++) {
    if (await test()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
};

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  let r = await api('/api/nodes', 'POST', { kind: 'script', name: 'Kịch bản' });
  assert.equal(r.status, 201, JSON.stringify(r.data)?.slice(0, 200));
  const id = r.data.nodes.find(n => n.kind === 'script').id;
  await api('/api/node', 'PATCH', {
    id,
    mode: 'full',
    brief: { idea: 'một ý tưởng' },
    skillText: 'LUẬT KINH DỊ: không bao giờ cho thấy con quái vật; mọi sợ hãi đến từ âm thanh.',
  });
  assert.match((await node(id)).skillText, /LUẬT KINH DỊ/, 'skill lưu trên node');

  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const authed = async (p, b) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(b),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  // "Extension" trả lời chậm có kiểm soát, để kịp bấm Dừng giữa chừng.
  let answered = 0;
  let holdMs = 0;
  const prompts = [];
  const pump = setInterval(async () => {
    try {
      const c = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
      const job = c.data?.job;
      if (!job) return;
      if (holdMs) await new Promise(r => setTimeout(r, holdMs));
      answered++;
      prompts.push(job.payload.prompt);
      await authed('/api/worker/complete', {
        id: job.id,
        lease: job.lease,
        text: /blueprint|JSON/i.test(job.payload.prompt.slice(0, 900))
          ? '```json\n{"project":{"name":"X","theme":"film"},"style":"s","assets":[],"shots":[]}\n```'
          : 'nội dung trạm',
      });
    } catch {}
  }, 60);
  const probe = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
  assert.equal(probe.status, 200, 'extension giả đăng nhập được');

  // --- Chạy đủ 7/7 ---------------------------------------------------------------------------
  r = await api('/api/script/run', 'POST', { id, mode: 'full', via: 'web' });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  assert.ok(
    await settle(async () => (await node(id))?.run?.status === 'done', 40000),
    'chạy xong 7/7: ' + JSON.stringify((await node(id))?.run),
  );
  const full = stages('full', 'drama');
  const after = await node(id);
  // token đã dùng ghi theo từng lượt: 6 trạm + QC = ít nhất 6 lượt; qua extension là ước tính
  assert.ok(after.run.tokens, 'run có bộ đếm token');
  assert.ok(after.run.tokens.turns >= full.length, 'đếm đủ số lượt LLM: ' + after.run.tokens.turns);
  assert.ok(after.run.tokens.in > 0 && after.run.tokens.out > 0, 'có số token vào/ra');
  assert.equal(after.run.tokens.estimated, true, 'qua ChatGPT web thì đánh dấu ước tính');
  // n.stages giữ kết quả 6 trạm + khoá 'qc' mà runStudio trả thêm.
  for (const st of full)
    assert.ok(after.stages[st.key], 'có kết quả trạm ' + st.label + ' sau khi chạy 7/7');
  const savedKeys = Object.keys(after.stages).length;
  // skill thể loại đi vào MỌI trạm, dưới tiêu đề nói rõ định dạng đầu ra vẫn theo trạm
  const withSkill = prompts.filter(p => /SKILL THỂ LOẠI/.test(p) && /LUẬT KINH DỊ/.test(p));
  assert.ok(withSkill.length >= 1, 'trạm nhận skill: ' + withSkill.length);
  assert.match(withSkill[0], /ĐỊNH DẠNG ĐẦU RA vẫn theo hướng dẫn của trạm/);

  // --- ① Bấm "Chạy xưởng" KHÔNG được xoá lặng lẽ ---------------------------------------------
  r = await api('/api/script/run', 'POST', { id, mode: 'full', via: 'web' });
  assert.equal(r.status, 400, 'chạy lại từ đầu khi đã có kết quả thì bị chặn');
  assert.match(r.data.error, /đã có kết quả của \d+ bước/, 'và nói rõ sẽ mất gì: ' + r.data.error);
  assert.match(r.data.error, /Chạy tiếp từ đây/, 'và chỉ cách giữ lại');
  assert.equal(
    Object.keys((await node(id)).stages).length,
    savedKeys,
    'KHÔNG bước nào bị xoá khi bị chặn',
  );

  // Xác nhận rõ ràng thì mới cho chạy lại từ đầu.
  holdMs = 400; // chậm lại để kịp bấm Dừng
  r = await api('/api/script/run', 'POST', { id, mode: 'full', via: 'web', restart: true });
  assert.equal(
    r.status,
    200,
    'có restart:true thì chạy lại được: ' + JSON.stringify(r.data)?.slice(0, 150),
  );
  assert.ok(await settle(async () => (await node(id))?.run?.status === 'running'), 'đang chạy');

  // --- ② Bấm Dừng phải dừng THẬT -------------------------------------------------------------
  const before = answered;
  r = await api('/api/script/stop', 'POST', { id });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 150));
  assert.ok(
    await settle(async () => (await node(id))?.run?.status === 'stopped'),
    'trạng thái chuyển sang stopped: ' + JSON.stringify((await node(id))?.run),
  );
  // Chờ đủ lâu để — nếu vòng lặp không kiểm cờ — nó kịp chạy nốt các trạm còn lại.
  await new Promise(r2 => setTimeout(r2, 2500));
  const spent = answered - before;
  assert.ok(
    spent <= 2,
    `sau khi Dừng chỉ còn tối đa 1 lượt LLM đang bay, không chạy nốt cả bảy trạm (đã tiêu ${spent})`,
  );
  assert.equal((await node(id)).run.status, 'stopped', 'vẫn là stopped, không tự nhảy sang done');

  // --- ③ Dừng rồi chạy lại: lượt CŨ không được ghi đè lượt mới --------------------------------
  holdMs = 0;
  r = await api('/api/script/run', 'POST', { id, mode: 'full', via: 'web', restart: true });
  assert.equal(
    r.status,
    200,
    'dừng xong chạy lại được ngay: ' + JSON.stringify(r.data)?.slice(0, 150),
  );
  const newId = (await node(id)).run.id;
  assert.ok(newId, 'lượt chạy có mã riêng');
  assert.ok(
    await settle(async () => (await node(id))?.run?.status === 'done', 40000),
    'lượt mới chạy xong: ' + JSON.stringify((await node(id))?.run),
  );
  const done = await node(id);
  assert.equal(done.run.id, newId, 'lượt cũ không ghi đè trạng thái của lượt mới');
  assert.equal(done.run.status, 'done', 'kết thúc là done, không bị lượt cũ kéo về stopped/failed');
  for (const st of full) assert.ok(done.stages[st.key], 'đủ bước sau lượt mới: thiếu ' + st.label);

  // --- Dừng khi không chạy gì: không nổ ------------------------------------------------------
  r = await api('/api/script/stop', 'POST', { id });
  assert.equal(r.status, 200, 'bấm Dừng lúc rảnh vẫn ok');
  assert.equal((await node(id)).run.status, 'done', 'và không đổi trạng thái đã xong');

  // --- ④ Tắt/mở lại app giữa lúc xưởng chạy -------------------------------------------------
  // Lỗi thật: người dùng mở lại tool khi đang ở trạm ②; lượt chạy chết theo server cũ nhưng
  // project vẫn ghi "running bước 2" → treo mãi, nút nào cũng khoá.
  holdMs = 1500;
  r = await api('/api/script/run', 'POST', { id, mode: 'full', via: 'web', restart: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 150));
  assert.ok(
    await settle(async () => (await node(id))?.run?.step >= 2, 20000),
    'đã tới trạm ②: ' + JSON.stringify((await node(id))?.run),
  );
  const cutAt = (await node(id)).run.key;
  assert.ok(full.some(st => st.key === cutAt), 'run ghi khoá trạm đang chạy: ' + cutAt);
  proc.kill();
  await new Promise(r2 => proc.once('exit', r2));
  proc = start();
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r2 => setTimeout(r2, 200));
  }
  const orphan = await node(id);
  assert.equal(orphan.run.status, 'failed', 'mở lại app: lượt dở thành lỗi, không treo "running"');
  assert.match(orphan.run.error, /khởi động lại/);
  assert.equal(orphan.run.failedAt, cutAt, 'đánh dấu đúng trạm bị cắt ngang');
  holdMs = 0;
  r = await api('/api/script/run', 'POST', { id, mode: 'full', via: 'web', from: cutAt });
  assert.equal(r.status, 200, 'chạy tiếp từ bước lỗi được: ' + JSON.stringify(r.data)?.slice(0, 150));
  assert.ok(
    await settle(async () => (await node(id))?.run?.status === 'done', 40000),
    'chạy tiếp tới cuối: ' + JSON.stringify((await node(id))?.run),
  );

  clearInterval(pump);
  console.log(
    'PASS: node Kịch bản — chạy lại từ đầu khi đã có kết quả thì BỊ CHẶN và nói rõ sẽ mất gì ' +
      '(phải restart:true mới xoá), bấm Dừng thì vòng lặp dừng thật thay vì chạy nốt bảy trạm, ' +
      'và dừng xong chạy lại thì lượt cũ không ghi đè lượt mới; mở lại app giữa chừng thì lượt dở ' +
      'thành lỗi ở đúng trạm và chạy tiếp được',
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
