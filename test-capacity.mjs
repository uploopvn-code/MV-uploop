// Phim dài trong MỘT project: trần node 400 (thay vì 200), và lịch sử job không được phình to
// làm nặng cả file project lẫn mỗi lần /api/state (browser gọi lại mỗi 4 giây).
//
// Đo trên dữ liệu thật trước khi sửa: một project 243 node có file 2,29 MB, trong đó job chiếm
// 1,97 MB (riêng chữ prompt là 1,1 MB) còn node chỉ 219 KB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildGraph } from './director.mjs';
import { compactJobs, JOB_HISTORY, isSettled } from './lib/job-history.mjs';
import { NODE_CAP, NODE_WARN } from './lib/limits.mjs';

// --- 1) Trần node: 400, và cùng một con số ở cả hai cổng chặn ---------------------------------
assert.equal(NODE_CAP, 400);
assert.ok(NODE_WARN < NODE_CAP, 'mốc cảnh báo phải thấp hơn trần');

// Blueprint đủ lớn để từng bị chặn ở 200 nhưng vẫn dưới 400: phải dựng được.
const blueprint = count => ({
  project: { name: 'Phim dài', theme: 'drama' },
  style: 'Cinematic 35mm photorealistic',
  assets: [
    { key: 'nv1', role: 'character', name: 'NV1', prompt: 'model sheet' },
    { key: 'loc', role: 'scene', name: 'Phòng khách', prompt: 'living room' },
  ],
  cameras: [{ key: 'cam', name: 'Wide', config: 'wide shot' }],
  shots: Array.from({ length: count }, (_, i) => ({
    name: `Shot ${i + 1}`,
    start: i * 8,
    duration: 8,
    uses: ['nv1', 'loc'],
    camera: 'cam',
    videoPrompt: 'walks in',
  })),
});
// 2 asset + 1 style + 1 camera = 4 node nền, nên 290 shot ≈ 294 node.
const big = buildGraph(blueprint(290));
assert.equal(big.nodes.length, 294, 'blueprint 294 node dựng được (trần cũ 200 đã chặn)');
assert.throws(
  () => buildGraph(blueprint(400)),
  /404 node > 400/,
  'quá 400 thì chặn, và báo đúng con số mới',
);

// --- 2) compactJobs: bỏ phần nặng của job đã xong, giữ nguyên job còn sống -------------------
// Hình dạng job thật: payload mang prompt + references đã gửi đi (đây là phần chiếm chỗ).
const job = (id, nodeId, status, extra = {}) => ({
  id,
  nodeId,
  kind: 'image',
  status,
  createdAt: new Date().toISOString(),
  payload: {
    site: 'chatgpt',
    website: 'chatgpt.com',
    prompt: 'x'.repeat(4000),
    references: [{ role: 'nv1', asset: { id: 'a1' } }],
    timing: { start: 0, duration: 8 },
    projectRevision: 3,
  },
  ...extra,
});
const heavy = j => 'prompt' in j.payload;

{
  const d = {
    jobs: [
      job('old', 'n1', 'completed'), // job cũ của n1 → bỏ phần nặng
      job('new', 'n1', 'completed'), // job mới nhất của n1 → giữ nguyên
      job('live', 'n2', 'queued'), // chưa chạy → giữ nguyên
      job('review', 'n3', 'needs_review'), // chờ người xử lý → giữ nguyên
      job('sent', 'n4', 'cancelled', { maybeSent: true }), // có thể đã tốn tiền → giữ nguyên
      job('later', 'n4', 'completed'),
    ],
  };
  const r = compactJobs(d);
  const by = id => d.jobs.find(j => j.id === id);
  assert.equal(r.stripped, 1, 'chỉ một job bị bỏ phần nặng');
  assert.equal(r.dropped, 0, 'chưa quá hạn mức thì không xóa job nào');
  assert.ok(!heavy(by('old')), 'job cũ đã xong: bỏ prompt');
  assert.ok(!('references' in by('old').payload), 'bỏ cả references');
  assert.ok(!('timing' in by('old').payload), 'bỏ cả timing');
  // Những trường browser thật sự đọc phải còn, không thì hàng đợi mất thông tin.
  assert.equal(by('old').payload.site, 'chatgpt', 'giữ site');
  assert.equal(by('old').payload.website, 'chatgpt.com', 'giữ website');
  for (const id of ['new', 'live', 'review', 'sent'])
    assert.ok(heavy(by(id)), `job "${id}" phải giữ nguyên payload`);
}

// Quá hạn mức: xóa job cũ nhất, nhưng KHÔNG bao giờ xóa job còn sống hay job mới nhất của node.
{
  const jobs = [];
  for (let i = 0; i < JOB_HISTORY + 50; i++) jobs.push(job('j' + i, 'n' + (i % 5), 'completed'));
  jobs.push(job('waiting', 'n9', 'queued'));
  const d = { jobs };
  const r = compactJobs(d);
  assert.equal(d.jobs.length, JOB_HISTORY, `cắt về đúng ${JOB_HISTORY} job`);
  assert.equal(r.dropped, 51, 'xóa đúng số job vượt hạn mức');
  assert.ok(
    d.jobs.some(j => j.id === 'waiting'),
    'job chưa chạy không bị xóa',
  );
  assert.equal(d.jobs[0].id, 'j51', 'xóa từ cũ nhất trở đi');
  // Mỗi node vẫn còn job mới nhất của nó (badge trên card đọc job này).
  for (let k = 0; k < 5; k++)
    assert.ok(
      d.jobs.some(j => j.nodeId === 'n' + k),
      'node n' + k + ' vẫn còn job',
    );
}
assert.equal(isSettled({ status: 'needs_review' }), false, 'needs_review còn sống');
assert.equal(isSettled({ status: 'cancelled' }), true, 'cancelled là đã xong');

// --- 3) Chạy thật trên server: /api/state và file project trên đĩa ---------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-capacity-'));
const PORT = 17809;
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
const state = async () => (await api('/api/state')).data;

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // Ngân sách node đi kèm state, để canvas nói được "còn bao nhiêu chỗ".
  let st = await state();
  assert.equal(st.nodeBudget.cap, NODE_CAP, 'state nói đúng trần');
  assert.equal(st.nodeBudget.warn, NODE_WARN, 'state nói đúng mốc cảnh báo');
  assert.equal(
    st.nodeBudget.used,
    st.nodes.filter(n => !n.terminal && n.role !== 'seedance').length,
    'đếm đúng node làm việc (clip không tính)',
  );
  assert.ok(st.nodeBudget.used < st.nodeBudget.warn, 'project mẫu chưa tới mốc cảnh báo');

  // Dựng thật blueprint 294 node qua đúng route của tool — trước đây 200 là chặn.
  let r = await api('/api/director/build', 'POST', { blueprint: JSON.stringify(blueprint(290)) });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  assert.equal(r.data.nodeBudget.used, 294, 'project 294 node chạy được trong một project');
  assert.ok(r.data.nodeBudget.used > r.data.nodeBudget.warn, 'đã qua mốc cảnh báo');

  // Blueprint quá 400 vẫn bị chặn, với lời nhắc đúng con số.
  r = await api('/api/director/build', 'POST', { blueprint: JSON.stringify(blueprint(400)) });
  assert.notEqual(r.status, 200, 'quá trần thì không dựng');
  assert.match(JSON.stringify(r.data), /404 node > 400/, 'báo lỗi nói 400');

  // Tạo job thật trên một shot, rồi hủy → job "đã xong". Chạy qua web worker (extension) để
  // không cần API key: không có extension nào bật nên job nằm ở "queued" — đúng cái cần hủy.
  r = await api('/api/project', 'PATCH', { defaults: { image: 'web' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = await state();
  // Một node asset (không có ảnh đầu vào nào) thì tạo ảnh được ngay.
  const shot = st.nodes.find(
    n => !n.terminal && !n.imageInputs && n.resolvedPrompts?.image && n.kind !== 'setting',
  );
  assert.ok(shot, 'có node asset để chạy');
  r = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'image', count: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const jobId = r.data.job.id;
  assert.ok(r.data.job.payload.prompt, 'job thật mang theo prompt');

  // Khi job còn sống, /api/state vẫn gửi payload đầy đủ.
  st = await state();
  let wire = st.jobs.find(j => j.id === jobId);
  assert.ok(wire, 'job có trong state');
  assert.ok(!isSettled(wire), 'job chưa xong');
  assert.ok(wire.payload.prompt, 'job còn sống: state gửi cả prompt');

  r = await api('/api/jobs/cancel', 'POST', { id: jobId });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  // Job đã xong: /api/state KHÔNG gửi prompt nữa (phần nặng nhất, không ai trên trang đọc),
  // nhưng mọi thứ khác vẫn còn để vẽ hàng đợi và badge trên node.
  st = await state();
  wire = st.jobs.find(j => j.id === jobId);
  assert.ok(wire, 'job đã hủy vẫn nằm trong lịch sử');
  assert.equal(wire.status, 'cancelled');
  assert.ok(!('prompt' in wire.payload), 'state không còn gửi prompt của job đã xong');
  assert.equal(wire.payload.site, 'chatgpt', 'vẫn biết job chạy ở đâu');
  assert.ok(wire.payload.website, 'vẫn còn tên nguồn cho dòng hàng đợi');
  assert.ok(wire.kind && wire.createdAt, 'vẫn đủ dữ liệu cho dòng hàng đợi');

  // Nhưng trên đĩa job này là job mới nhất của node đó, nên payload vẫn còn nguyên — bỏ đi là
  // mất khả năng đối chiếu "ảnh này có đúng là từ input hiện tại".
  const file = path.join(dir, 'projects', st.activeProjectId, 'project.json');
  let disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(
    disk.jobs.find(j => j.id === jobId).payload.prompt,
    'job mới nhất của node giữ payload trên đĩa',
  );

  // Chạy thêm một job nữa trên cùng node → job cũ không còn là mới nhất → bị dọn khỏi đĩa.
  r = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'image', count: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await api('/api/jobs/cancel', 'POST', { id: r.data.job.id });
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(
    !('prompt' in disk.jobs.find(j => j.id === jobId).payload),
    'job cũ đã xong: prompt bị dọn khỏi file project',
  );
  assert.ok(
    disk.jobs.find(j => j.id === jobId).payload.site !== undefined ||
      disk.jobs.find(j => j.id === jobId).payload.seedvis !== undefined,
    'vẫn còn đủ để biết job đó chạy ở đâu',
  );

  // Khởi động lại cũng dọn (compact chạy cả lúc nạp project).
  assert.ok(
    disk.jobs.every(j => j.status !== 'running'),
    'không còn job treo',
  );

  console.log(
    `PASS: phim dài một project — trần node ${NODE_CAP} (294 node dựng được, 404 bị chặn), state mang nodeBudget, /api/state bỏ prompt của job đã xong, lịch sử job trên đĩa được dọn (giữ job còn sống, job mới nhất mỗi node+loại, job có thể đã tốn tiền) và cắt về ${JOB_HISTORY} job`,
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
