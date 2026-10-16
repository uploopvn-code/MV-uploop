// Ô chọn "Ảnh đầu vào cho video" phải được tôn trọng.
//
// Lỗi cũ: luật là `videoInput === 'refs' && !n.image`, chép ở 4 chỗ (jobs / prompts / stage3d /
// auto). Hễ node đã có ảnh render là lựa chọn "ảnh từ node nối vào" bị bỏ qua — tool vẫn gửi
// keyframe. Giờ cả bốn chỗ gọi chung videoRunsFromRefs().
//
// Ngoại lệ duy nhất: số ảnh nối vào vượt trần của model video thì không có cách nào gửi hết,
// shot buộc phải dựng keyframe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-vinput-'));
const KEY = 'k';
const API = 'http://127.0.0.1:17798/api/v1';
fs.writeFileSync(path.join(dir, 'seedvis-key.txt'), KEY);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(16)]);
// Giữ lại từng lượt gửi đi để đếm CHÍNH XÁC bao nhiêu ảnh được gửi và gửi ảnh nào.
const submits = [];
const gens = new Map();
const srv = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const send = (s, o) => {
    res.writeHead(s, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (req.url.startsWith('/cdn/')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(gens.get(req.url.slice(5))?.kind === 'image' ? PNG : MP4);
  }
  if (req.url === '/api/v1/account/info') return send(200, { data: { balance: 9, plan: 'Pro' } });
  if (req.url === '/api/v1/models')
    return send(200, { data: [{ id: 'GEM_PIX_2' }, { id: 'Veo-3.1' }] });
  const poll = req.url.match(/^\/api\/v1\/developer\/generations\/([\w-]+)\?wait=0$/);
  if (poll) {
    const g = gens.get(poll[1]);
    return send(200, {
      success: true,
      data: {
        id: poll[1],
        status: 'completed',
        is_final: true,
        next: { action: 'done' },
        outputs: [{ type: g.kind, url: 'http://127.0.0.1:17798/cdn/' + poll[1] }],
        references: [],
      },
    });
  }
  if (req.method === 'POST') {
    const id = req.headers['idempotency-key'];
    const b = JSON.parse(raw);
    if (!gens.has(id)) {
      const kind = req.url.includes('/google/') ? 'image' : 'video';
      gens.set(id, { kind });
      const imgs =
        b.reference_images || b.referenceImages || b.images || (b.image ? [b.image] : []);
      submits.push({ kind, images: imgs.length, prompt: String(b.prompt || '') });
    }
    return send(202, {
      success: true,
      status: 202,
      data: {
        id,
        status: 'queued',
        is_final: false,
        next: { action: 'poll', url: API + '/developer/generations/' + id + '?wait=0' },
        outputs: [],
        references: [],
      },
    });
  }
  send(404, {});
});
await new Promise(r => srv.listen(17798, '127.0.0.1', r));

const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    SEEDVIS_API_KEY: '',
    MV_PORT: '17797',
    MV_ORBIT_URL: 'http://127.0.0.1:1',
    MV_SEEDVIS_URL: API,
    MV_SEEDVIS_POLL_MS: '20',
    MV_SEEDVIS_TIMEOUT_MS: '2000',
    MV_DATA_DIR: dir,
  },
  stdio: 'pipe',
});
const api = async (p, method = 'GET', b) => {
  const r = await fetch('http://127.0.0.1:17797' + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const state = async () => (await api('/api/state')).data;
const node = async id => (await state()).nodes.find(n => n.id === id);
const settle = async (test, ms = 10000) => {
  for (let i = 0; i < ms / 50; i++) {
    if (await test()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
};
const lastVideo = () => submits.filter(s => s.kind === 'video').at(-1);

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch('http://127.0.0.1:17797/api/state')).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // Một shot nối 2 nhân vật + 1 bối cảnh = 3 ảnh tham chiếu, đúng bằng trần của Veo.
  let r = await api('/api/director/build', 'POST', {
    blueprint: JSON.stringify({
      project: { name: 'Video input', theme: 'drama' },
      style: 'Cinematic 35mm',
      assets: [
        { key: 'a', role: 'character', name: 'NVA', code: 'NV1', prompt: 'model sheet' },
        { key: 'b', role: 'character', name: 'NVB', code: 'NV2', prompt: 'model sheet' },
        { key: 'loc', role: 'scene', name: 'Phong', prompt: 'room' },
      ],
      shots: [
        {
          name: 'Shot',
          start: 0,
          duration: 8,
          uses: ['a', 'b', 'loc'],
          videoPrompt: 'they talk',
        },
      ],
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  const shot = r.data.nodes.find(n => n.name === 'Shot');
  assert.ok(shot, 'có shot');

  // Tạo ảnh cho mọi node nối vào, rồi cho chính shot → shot CÓ ảnh render.
  for (const a of (await state()).nodes.filter(
    n => !n.terminal && !n.imageInputs && n.kind !== 'setting',
  )) {
    const q = await api('/api/jobs', 'POST', { nodeId: a.id, kind: 'image' });
    assert.equal(q.status, 201, a.name + ': ' + JSON.stringify(q.data));
    assert.ok(await settle(async () => !!(await node(a.id))?.image), a.name + ' có ảnh');
  }
  let q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'image' });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(await settle(async () => !!(await node(shot.id))?.image), 'shot có ảnh keyframe');

  let n = await node(shot.id);
  assert.equal(n.videoInput, 'self', 'mặc định là ảnh của node này');
  assert.equal(n.imageInputs, 3, '3 ảnh nối vào');
  assert.equal(n.videoRefLimit, 3, 'model nhận tối đa 3');
  assert.equal(n.videoNeedsKeyframe, false, 'chưa vượt trần');

  // --- Mặc định: gửi ĐÚNG ảnh keyframe của node --------------------------------------------
  q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'video', count: 1 });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(await settle(() => lastVideo()?.images >= 1), 'lượt video mặc định đã gửi');
  assert.equal(lastVideo().images, 1, 'mặc định gửi 1 ảnh (keyframe của node)');
  assert.match(
    (await node(shot.id)).resolvedPrompts.video,
    /The attached image is the first frame of this shot/,
    'prompt mặc định nói đây là khung hình đầu',
  );
  await settle(async () =>
    ['completed', 'failed', 'needs_review'].includes(
      (await state()).jobs.filter(j => j.kind === 'video').at(-1)?.status,
    ),
  );

  // --- Chọn "ảnh từ node nối vào" KHI NODE ĐÃ CÓ ẢNH: đây chính là lỗi cũ -------------------
  r = await api('/api/node', 'PATCH', { id: shot.id, videoInput: 'refs' });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  n = await node(shot.id);
  assert.equal(n.videoInput, 'refs', 'lựa chọn được lưu');
  assert.ok(n.image, 'node VẪN có ảnh render — trước đây chính nó làm lựa chọn bị bỏ qua');
  assert.ok(
    !/The attached image is the first frame of this shot/.test(n.resolvedPrompts.video),
    'prompt không còn nói "ảnh đính kèm là khung hình đầu"',
  );
  assert.match(
    n.resolvedPrompts.video,
    /Reference subjects, in the order of the attached images:/,
    'prompt chuyển sang liệt kê các ảnh tham chiếu',
  );

  const before = submits.filter(s => s.kind === 'video').length;
  q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'video', count: 1 });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(
    await settle(() => submits.filter(s => s.kind === 'video').length > before),
    'lượt video chế độ refs đã gửi',
  );
  assert.equal(
    lastVideo().images,
    3,
    'GỬI ĐÚNG 3 ảnh của các node nối vào, không phải 1 ảnh keyframe',
  );
  await settle(async () =>
    ['completed', 'failed', 'needs_review'].includes(
      (await state()).jobs.filter(j => j.kind === 'video').at(-1)?.status,
    ),
  );

  // --- Quay lại mặc định thì lại dùng keyframe ----------------------------------------------
  await api('/api/node', 'PATCH', { id: shot.id, videoInput: 'self' });
  const before2 = submits.filter(s => s.kind === 'video').length;
  q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'video', count: 1 });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(
    await settle(() => submits.filter(s => s.kind === 'video').length > before2),
    'lượt video self đã gửi',
  );
  assert.equal(lastVideo().images, 1, 'về mặc định thì lại gửi 1 ảnh keyframe');

  // --- Ngoại lệ: vượt trần ảnh của model thì buộc dùng keyframe ------------------------------
  // Nối thêm một nhân vật nữa → 4 ảnh > trần 3.
  r = await api('/api/nodes', 'POST', { role: 'character', name: 'NVC' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const extra = r.data.nodes.at(-1);
  q = await api('/api/jobs', 'POST', { nodeId: extra.id, kind: 'image' });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(await settle(async () => !!(await node(extra.id))?.image), 'NVC có ảnh');
  const edges = (await state()).edges;
  r = await api('/api/edges', 'PUT', {
    edges: [...edges, { source: extra.id, target: shot.id }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  await api('/api/node', 'PATCH', { id: shot.id, videoInput: 'refs' });
  n = await node(shot.id);
  assert.equal(n.imageInputs, 4, 'giờ có 4 ảnh nối vào');
  assert.equal(n.videoNeedsKeyframe, true, 'vượt trần 3 của model');
  assert.match(
    n.resolvedPrompts.video,
    /The attached image is the first frame of this shot/,
    'vượt trần thì quay lại dùng keyframe — model không nhận nổi 4 ảnh',
  );
  // Nối thêm node làm ảnh khung cũ thành "cần cập nhật" — đúng như tool phải báo. Dựng lại nó
  // rồi mới quay (model ảnh gộp tới 10 ảnh nên 4 ảnh vẫn vào được một khung).
  q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'image' });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(await settle(async () => !(await node(shot.id))?.stale), 'ảnh khung đã dựng lại');

  const before3 = submits.filter(s => s.kind === 'video').length;
  q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'video', count: 1 });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(
    await settle(() => submits.filter(s => s.kind === 'video').length > before3),
    'lượt video vượt trần đã gửi',
  );
  assert.equal(lastVideo().images, 1, 'vượt trần → vẫn gửi 1 ảnh keyframe, không gửi 4');

  // --- Chế độ 'mix': ảnh khung + ảnh nhận dạng của nhân vật được tick ------------------------
  // Dùng cho cảnh qua vai: người quay lưng không có mặt trong khung, khi họ quay lại model bịa
  // ra mặt khác. Gửi kèm ảnh nhân vật đó để giữ đúng người.
  n = await node(shot.id);
  const people = n.references.map(r => r.role).slice(0, 2);
  r = await api('/api/node', 'PATCH', { id: shot.id, videoInput: 'mix' });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  n = await node(shot.id);
  assert.equal(n.videoInput, 'mix', 'chế độ được lưu');
  assert.equal(n.mixedRoom, 2, 'ảnh khung chiếm 1 suất nên còn 2 chỗ (trần model = 3)');
  // Chưa tick ai: chỉ ảnh khung.
  const b4 = submits.filter(s => s.kind === 'video').length;
  q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'video', count: 1 });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(await settle(() => submits.filter(s => s.kind === 'video').length > b4), 'đã gửi');
  assert.equal(lastVideo().images, 1, 'mix chưa tick ai → chỉ ảnh khung');

  // Tick 2 nhân vật → gửi 3 ảnh, ảnh khung đứng đầu.
  r = await api('/api/node', 'PATCH', { id: shot.id, videoRefPick: people });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  n = await node(shot.id);
  assert.deepEqual(n.videoRefPick, people, 'nhớ đúng ai được tick');
  const vp = n.resolvedPrompts.video;
  assert.match(
    vp,
    /^3 images are attached\. Image 1 is the first frame of this shot/,
    'ảnh 1 = khung hình',
  );
  assert.match(
    vp,
    /identity references only — image 2 = \S+, image 3 = \S+/,
    'ảnh 2–3 là nhận dạng',
  );
  assert.match(vp, /never cut to them/, 'cấm model cắt sang ảnh nhận dạng');
  assert.ok(
    !/The attached image is the first frame of this shot:/.test(vp),
    'không còn câu một-ảnh',
  );

  const b5 = submits.filter(s => s.kind === 'video').length;
  q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'video', count: 1 });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.ok(await settle(() => submits.filter(s => s.kind === 'video').length > b5), 'đã gửi');
  assert.equal(lastVideo().images, 3, 'gửi 3 ảnh: 1 ảnh khung + 2 ảnh nhân vật');

  // Tick quá trần thì bị chặn, không để model từ chối.
  const tooMany = (await node(shot.id)).references.map(r => r.role).slice(0, 3);
  await api('/api/node', 'PATCH', { id: shot.id, videoRefPick: tooMany });
  q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'video', count: 1 });
  assert.equal(q.status, 400, 'tick quá trần bị chặn');
  assert.match(q.data.error, /chỉ nhận tối đa 3/, 'và nói rõ trần của model');
  // Id lạc (không nối vào node này) bị bỏ, không biến thành ảnh gửi đi.
  await api('/api/node', 'PATCH', { id: shot.id, videoRefPick: [...people, 'khong-ton-tai'] });
  assert.deepEqual((await node(shot.id)).videoRefPick, people, 'id lạc bị loại');

  console.log(
    'PASS: ô chọn ảnh đầu vào cho video — mặc định gửi 1 ảnh keyframe của node; chọn "ảnh từ ' +
      'node nối vào" thì gửi đúng 3 ảnh các node nối vào KỂ CẢ khi node đã có ảnh render ' +
      '(lỗi cũ); đổi lại thì về keyframe; vượt trần ảnh của model thì buộc dùng keyframe; ' +
      'chế độ "ảnh khung + nhân vật chọn thêm" gửi 1+2 ảnh với prompt nói rõ vai trò từng ảnh, ' +
      'chặn khi tick quá trần và loại id lạc',
  );
} finally {
  proc.kill();
  srv.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
