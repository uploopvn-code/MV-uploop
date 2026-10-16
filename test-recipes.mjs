// Quy trình (recipe): tool tự điều khiển cả chuỗi kịch bản → dựng graph → ảnh → video → zip,
// dừng hỏi ở các điểm đã định, và NHỚ để lần sau chạy không cần LLM lập kế hoạch.
//
// Chạy THẬT: server thật, bộ chạy thật. LLM và máy tạo ảnh/video là một "extension" giả trả
// lời đúng hợp đồng worker (text / image / video) — như ChatGPT và Muse thật làm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { matchRecipe, normalizeSteps, DEFAULT_RECIPES } from './lib/recipe-def.mjs';

// --- phần thuần: khớp câu kích hoạt, chuẩn hoá bước ------------------------------------------
assert.equal(matchRecipe('Chạy toàn bộ', DEFAULT_RECIPES)?.recipe.id, 'builtin:full');
assert.equal(matchRecipe('chay toan bo tung buoc de ra san pham cuoi cung', DEFAULT_RECIPES)?.recipe.id, 'builtin:full');
assert.equal(matchRecipe('Chạy toàn bộ, không hỏi', DEFAULT_RECIPES)?.auto, true);
assert.equal(matchRecipe('Chạy toàn bộ', DEFAULT_RECIPES)?.auto, false);
assert.equal(matchRecipe('chạy hết ảnh khu nhân vật', DEFAULT_RECIPES), null, 'câu ngắn phải khớp cả câu');
assert.throws(() => normalizeSteps([{ type: 'confirm', text: 'x' }]), /không có việc/);
assert.throws(() => normalizeSteps([{ type: 'shell' }]), /không hỗ trợ/);
assert.deepEqual(normalizeSteps([{ type: 'images', zones: ['character', 'bogus'] }]), [
  { type: 'images', zones: ['character'] },
]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-recipes-'));
const PORT = 17815;
const start = () =>
  spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, MV_PORT: String(PORT), MV_ORBIT_URL: 'http://127.0.0.1:1', MV_DATA_DIR: dir },
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
const run = async () => (await state()).recipeRun;
const settle = async (test, ms = 30000) => {
  for (let i = 0; i < ms / 100; i++) {
    if (await test()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
};
const up = async () => {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server không lên');
};
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=';
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(16)]).toString('base64');
const BLUEPRINT = {
  project: { name: 'X', theme: 'film' },
  style: 'cinematic 35mm',
  assets: [
    {
      key: 'hero',
      role: 'character',
      name: 'Hero',
      code: 'NV1',
      identity_label: 'the man in the grey coat',
      back_view: 'grey coat, short dark hair',
      physical_anchors: ['short dark hair'],
      prompt: 'A tired man in a grey coat',
    },
    { key: 'room', role: 'scene', name: 'Room', prompt: 'A small kitchen at night' },
  ],
  shots: [
    { name: 'S01 — Mở', start: 0, duration: 8, uses: ['hero', 'room'], videoPrompt: 'The man opens a jar, fails, tries again.' },
  ],
};

try {
  await up();
  await api('/api/project', 'PATCH', { defaults: { image: 'musechat', video: 'musechat' } });
  let r = await api('/api/nodes', 'POST', { kind: 'script', name: 'Kịch bản' });
  const scriptId = r.data.nodes.find(n => n.kind === 'script').id;
  await api('/api/node', 'PATCH', { id: scriptId, via: 'web', brief: { idea: 'một người cố mở hũ dưa' } });

  // --- "extension" giả: LLM (text), ảnh và video (musechat) ---------------------------------
  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const authed = async (p, b) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(b),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  let holdText = 0;
  const served = { text: 0, image: 0, video: 0 };
  let busy = false;
  const pump = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const c = await authed('/api/worker/claim', { name: 'fake', kinds: ['text', 'image', 'video'], sites: ['chatgpt', 'musechat'] });
      const job = c.data?.job;
      if (!job) return;
      served[job.kind]++;
      if (job.kind === 'text') {
        if (holdText) await new Promise(r => setTimeout(r, holdText));
        const text = /blueprint|JSON/i.test(job.payload.prompt.slice(0, 900))
          ? '```json\n' + JSON.stringify(BLUEPRINT) + '\n```'
          : 'nội dung trạm';
        await authed('/api/worker/complete', { id: job.id, lease: job.lease, text });
      } else if (job.kind === 'image')
        await authed('/api/worker/complete', { id: job.id, lease: job.lease, name: 'r.png', mime: 'image/png', base64: png });
      else
        await authed('/api/worker/complete', { id: job.id, lease: job.lease, name: 'r.mp4', mime: 'video/mp4', base64: mp4 });
    } catch {} finally {
      busy = false;
    }
  }, 80);
  assert.equal((await authed('/api/worker/claim', { name: 'fake', kinds: ['text'] })).status, 200);

  // --- Quy trình mặc định qua TRỢ LÝ: khớp câu, 0 token, không cần Claude -------------------
  let st = await state();
  r = await api('/api/assistant/plan', 'POST', { request: 'Chạy toàn bộ từng bước để ra sản phẩm cuối cùng', projectId: st.activeProjectId, revision: st.revision, history: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  assert.equal(r.data.source, 'quick', 'trợ lý trả lời không qua LLM');
  assert.equal(r.data.actions[0].type, 'run_recipe');
  assert.equal(r.data.actions[0].recipeId, 'builtin:full');
  assert.equal(r.data.actions[0].auto, false);

  // --- Chạy: dừng sau khi dựng graph ---------------------------------------------------------
  r = await api('/api/recipes/start', 'POST', { recipeId: 'builtin:full' });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  assert.ok(await settle(async () => (await run())?.status === 'paused', 60000), 'dừng ở điểm 1: ' + JSON.stringify(await run()));
  let x = await run();
  assert.equal(x.step, 1, 'đang ở điểm dừng đầu');
  assert.match(x.label, /Tạo ảnh nhân vật/);
  st = await state();
  assert.ok(st.nodes.some(n => n.name === 'Hero' && n.zone === 'character'), 'graph đã dựng từ kịch bản');
  assert.ok(st.nodes.some(n => n.zone === 'production'), 'có shot');
  assert.equal((await api('/api/recipes/start', 'POST', { recipeId: 'builtin:full' })).status, 400, 'không chạy chồng');

  // --- Tiếp tục: ảnh nhân vật + bối cảnh, dừng điểm 2 ------------------------------------------
  r = await api('/api/recipes/continue', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  assert.ok(await settle(async () => (await run())?.status === 'paused' && (await run()).step === 3, 60000), 'dừng ở điểm 2: ' + JSON.stringify(await run()));
  st = await state();
  assert.ok(st.nodes.find(n => n.name === 'Hero').image, 'ảnh nhân vật đã tạo');
  assert.ok(st.nodes.find(n => n.name === 'Room').image, 'ảnh bối cảnh đã tạo');
  x = await run();
  assert.match(x.log.find(l => l.step === 2).note, /nhân vật: 1\/1 ảnh/);
  assert.match(x.log.find(l => l.step === 2).note, /trang phục: không có node/);

  // --- Tiếp tục: ảnh shot + video, dừng điểm 3; tiếp tục: zip → xong ----------------------------
  r = await api('/api/recipes/continue', 'POST', {});
  assert.ok(await settle(async () => (await run())?.status === 'paused' && (await run()).step === 6, 90000), 'dừng ở điểm 3: ' + JSON.stringify(await run()));
  st = await state();
  const shot = st.nodes.find(n => n.zone === 'production');
  assert.ok(shot.image, 'ảnh khung shot đã tạo');
  assert.ok(st.nodes.some(n => n.terminal && n.source === shot.id && n.video), 'video shot đã tạo');
  r = await api('/api/recipes/continue', 'POST', {});
  assert.ok(await settle(async () => (await run())?.status === 'done', 60000), 'xong: ' + JSON.stringify(await run()));
  x = await run();
  assert.ok(x.zip?.name.endsWith('.zip') && fs.existsSync(path.join(x.zip.dir, x.zip.name)), 'zip ghi ra đĩa: ' + JSON.stringify(x.zip));
  assert.ok(x.zip.bytes > 100);
  assert.ok(served.text >= 3 && served.image >= 3 && served.video >= 1, JSON.stringify(served));

  // --- Chạy lại cùng quy trình: kịch bản đã xong thì dùng lại, không chạy xưởng lại ------------
  const textsBefore = served.text;
  r = await api('/api/recipes/start', 'POST', { recipeId: 'builtin:full', auto: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  assert.ok(await settle(async () => ['done', 'failed'].includes((await run())?.status), 60000), JSON.stringify(await run()));
  x = await run();
  assert.equal(x.status, 'done', x.error);
  assert.equal(served.text, textsBefore, 'không tốn lượt LLM nào: kịch bản dùng lại');
  assert.match(x.log.find(l => l.step === 0).note, /dùng kết quả có sẵn/);
  assert.match(x.log.find(l => l.step === 1).note, /tự qua/);

  // --- Học quy trình do trợ lý lập: chạy xong → nhớ → lần sau khớp câu, 0 token ---------------
  r = await api('/api/recipes/start', 'POST', {
    steps: [{ type: 'script', mode: 'fast' }, { type: 'package' }],
    name: 'Kịch bản rồi đóng gói',
    triggers: ['đóng gói kịch bản luôn', 'kịch bản rồi zip'],
    learn: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  assert.ok(await settle(async () => (await run())?.status === 'done', 60000), JSON.stringify(await run()));
  x = await run();
  assert.ok(x.learned?.id, 'quy trình được học: ' + JSON.stringify(x.learned));
  const list = (await api('/api/recipes')).data.recipes;
  assert.ok(list.some(q => q.id === x.learned.id && q.triggers.includes('kịch bản rồi zip')));
  st = await state();
  r = await api('/api/assistant/plan', 'POST', { request: 'Kịch bản rồi ZIP', projectId: st.activeProjectId, revision: st.revision, history: [] });
  assert.equal(r.data.source, 'quick', 'câu đã học → không gọi LLM: ' + JSON.stringify(r.data)?.slice(0, 200));
  assert.equal(r.data.actions[0].recipeId, x.learned.id);
  assert.equal((await api('/api/recipes/delete', 'POST', { id: 'builtin:full' })).status, 400, 'không xoá được quy trình dựng sẵn');
  assert.equal((await api('/api/recipes/delete', 'POST', { id: x.learned.id })).status, 200);

  // --- Dừng giữa chừng + mở lại app giữa bước ------------------------------------------------
  // kịch bản mới (chạy lại xưởng chậm có kiểm soát) để quy trình phải ở bước ① một lúc
  await api('/api/node', 'PATCH', { id: scriptId, brief: { idea: 'ý tưởng khác hẳn' } });
  await api('/api/script/run', 'POST', { id: scriptId, mode: 'fast', via: 'web', restart: true, autoBuild: false });
  await settle(async () => (await state()).nodes.find(n => n.id === scriptId).run.status === 'done', 30000);
  await api('/api/script/stop', 'POST', { id: scriptId });
  // đánh dấu lượt kịch bản "chưa xong" để quy trình phải chạy xưởng: xoá kết quả bằng chạy lại
  holdText = 1500;
  r = await api('/api/recipes/start', 'POST', { steps: [{ type: 'script', mode: 'fast' }, { type: 'confirm', text: 'ok?' }, { type: 'package' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  // kịch bản đã done từ trước → bước ① dùng lại và dựng → dừng ở confirm; dừng hẳn
  assert.ok(await settle(async () => (await run())?.status === 'paused', 30000), JSON.stringify(await run()));
  r = await api('/api/recipes/stop', 'POST', {});
  assert.equal((await run()).status, 'stopped');
  // mở lại app GIỮA bước đang chạy: lượt dở thành "chờ chạy lại bước", bấm Tiếp tục chạy lại được
  await api('/api/node', 'PATCH', { id: scriptId, brief: { idea: 'ý tưởng thứ ba' } });
  r = await api('/api/script/run', 'POST', { id: scriptId, mode: 'fast', via: 'web', restart: true, autoBuild: false });
  await api('/api/script/stop', 'POST', { id: scriptId }); // run.status = stopped → quy trình phải chạy xưởng thật
  r = await api('/api/recipes/start', 'POST', { steps: [{ type: 'script', mode: 'fast' }, { type: 'package' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  assert.ok(await settle(async () => (await state()).nodes.find(n => n.id === scriptId).run?.status === 'running', 20000), 'xưởng đang chạy trong quy trình');
  proc.kill();
  await new Promise(r2 => proc.once('exit', r2));
  proc = start();
  await up();
  x = await run();
  assert.equal(x.status, 'paused', 'mở lại app: quy trình chờ chạy lại bước, không treo "running"');
  assert.equal(x.redo, true);
  assert.equal(x.step, 0);
  holdText = 0;
  r = await api('/api/recipes/continue', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  assert.ok(await settle(async () => (await run())?.status === 'done', 60000), 'chạy lại bước rồi xong: ' + JSON.stringify(await run()));
  assert.equal((await run()).step, 2);

  clearInterval(pump);
  console.log(
    'PASS: quy trình — "chạy toàn bộ" khớp câu không qua LLM; dừng đúng 3 điểm (dựng graph, ảnh nhân vật+bối cảnh, video) rồi zip ra đĩa; ' +
      'chạy lại dùng kết quả kịch bản có sẵn (0 lượt LLM); quy trình trợ lý lập được học và lần sau khớp câu 0 token; dừng được; mở lại app giữa bước thì chờ chạy lại bước đó',
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
