// Every video prompt that leaves the app must say WHICH attached image is which: the keyframe, the
// storyboard sheet, the 3D layout, and which face belongs to @NV1. Without that map a shot sent
// with a keyframe plus a storyboard arrives as "animate the attached image" and the model treats
// the extra sheet as a second scene. Real server, real Seedvis stand-in over HTTP, real PNG/MP4.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-refmap-'));
const KEY = 'k';
const API = 'http://127.0.0.1:17808/api/v1';
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
        outputs: [{ type: g.kind, url: 'http://127.0.0.1:17808/cdn/' + poll[1] }],
        references: [],
      },
    });
  }
  if (req.method === 'POST') {
    const id = req.headers['idempotency-key'];
    const b = JSON.parse(raw || '{}'); // lệnh huỷ của app gửi POST không có thân
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
await new Promise(r => srv.listen(17808, '127.0.0.1', r));

const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    SEEDVIS_API_KEY: '',
    MV_PORT: '17807',
    MV_ORBIT_URL: 'http://127.0.0.1:1',
    MV_SEEDVIS_URL: API,
    MV_SEEDVIS_POLL_MS: '20',
    MV_SEEDVIS_TIMEOUT_MS: '2000',
    MV_DATA_DIR: dir,
  },
  stdio: 'pipe',
});
const api = async (p, method = 'GET', b) => {
  const r = await fetch('http://127.0.0.1:17807' + p, {
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
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch('http://127.0.0.1:17807/api/state')).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // Ba shot giống nhau, mỗi shot thử một chế độ ảnh đầu vào. Phải là ba node riêng: một node chỉ
  // giữ MỘT job video (khoá theo nodeId+kind), nên tạo lại trên cùng node chỉ trả về job cũ.
  let r = await api('/api/director/build', 'POST', {
    blueprint: JSON.stringify({
      project: { name: 'Ref map', theme: 'drama' },
      style: 'Cinematic 35mm',
      assets: [
        { key: 'a', role: 'character', name: 'NVA', code: 'NV1', prompt: 'model sheet' },
        { key: 'b', role: 'character', name: 'NVB', code: 'NV2', prompt: 'model sheet' },
        { key: 'loc', role: 'scene', name: 'Cau thep', prompt: 'bridge' },
      ],
      shots: [0, 1, 2].map(i => ({
        name: 'Shot' + i,
        start: i * 8,
        duration: 8,
        uses: ['a', 'b', 'loc'],
        videoPrompt: 'they walk',
      })),
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  const shots = [0, 1, 2].map(i => r.data.nodes.find(n => n.name === 'Shot' + i));
  assert.ok(shots.every(Boolean), 'có đủ 3 shot');

  // Ảnh cho mọi node nối vào, rồi cho từng shot (mọi shot đều CÓ ảnh khung).
  for (const a of (await state()).nodes.filter(
    n => !n.terminal && !n.imageInputs && n.kind !== 'setting',
  )) {
    const q = await api('/api/jobs', 'POST', { nodeId: a.id, kind: 'image' });
    assert.equal(q.status, 201, a.name + ': ' + JSON.stringify(q.data));
    assert.ok(await settle(async () => !!(await node(a.id))?.image), a.name + ' có ảnh');
  }
  for (const sh of shots) {
    const q = await api('/api/jobs', 'POST', { nodeId: sh.id, kind: 'image' });
    assert.equal(q.status, 201, JSON.stringify(q.data));
    assert.ok(await settle(async () => !!(await node(sh.id))?.image), sh.name + ' có ảnh khung');
  }

  const videoJob = async id => {
    const v = await api('/api/jobs', 'POST', { nodeId: id, kind: 'video' });
    assert.equal(v.status, 201, JSON.stringify(v.data));
    return { prompt: v.data.job.payload.prompt, refs: v.data.job.payload.references };
  };
  // Số dòng "image N =" phải luôn bằng số ảnh THẬT SỰ đính kèm — bảng sai số còn hại hơn không có.
  const lines = t => (t.match(/image \d+ =/g) || []).length;
  const maps = t => (t.match(/Attached images, in this exact order:/g) || []).length;

  // 1. Chạy từ ẢNH KHUNG (mặc định): một ảnh, nhưng vẫn phải nói rõ ảnh đó là khung đầu và ai trong đó.
  let { prompt, refs } = await videoJob(shots[0].id);
  assert.equal(refs.length, 1, 'chế độ khung gửi đúng 1 ảnh');
  assert.equal(maps(prompt), 1, 'có bảng ánh xạ ảnh');
  assert.match(prompt, /image 1 = the first frame of this shot/, 'ảnh 1 là khung đầu');
  assert.match(prompt, /@NV1/, 'nhân vật được gắn tag @');
  assert.match(prompt, /@NV2/, 'nhân vật thứ hai cũng được gắn tag');
  assert.equal(lines(prompt), refs.length, 'bảng khớp số ảnh gửi đi');
  fs.writeFileSync(path.join(os.tmpdir(), 'refmap-prompt.txt'), prompt);

  // 2. Chạy từ ẢNH THAM CHIẾU: prompt đã có sẵn danh sách "Reference subjects" đánh số theo đúng
  //    thứ tự ảnh gửi đi, nên KHÔNG chèn bảng thứ hai — nhưng mọi ảnh vẫn phải được gọi tên.
  let p = await api('/api/node', 'PATCH', { id: shots[1].id, videoInput: 'refs' });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  ({ prompt, refs } = await videoJob(shots[1].id));
  assert.ok(refs.length >= 3, 'chế độ refs gửi ảnh của các node nối vào');
  assert.equal(maps(prompt), 0, 'đã có danh sách riêng → không chèn bảng thứ hai');
  assert.match(
    prompt,
    /Reference subjects, in the order of the attached images:/,
    'vẫn giữ danh sách sẵn có',
  );
  assert.equal(
    (prompt.match(/\[\d+\]/g) || []).length,
    refs.length,
    'danh sách gọi tên ĐỦ mọi ảnh đính kèm',
  );

  // 3. ẢNH KHUNG + NHÂN VẬT CHỌN THÊM: prompt vốn đã tự đánh số ảnh → KHÔNG được chèn bảng thứ hai.
  p = await api('/api/node', 'PATCH', {
    id: shots[2].id,
    videoInput: 'mix',
    videoRefPick: [(await state()).nodes.find(n => n.name === 'NVA').id],
  });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  ({ prompt, refs } = await videoJob(shots[2].id));
  assert.equal(refs.length, 2, 'mix gửi ảnh khung + 1 nhân vật');
  assert.equal(maps(prompt), 0, 'chế độ mix đã tự đánh số → không chèn bảng');
  assert.match(prompt, /Image 1 is the first frame of this shot/, 'mix nói rõ ảnh 1 là khung đầu');
  assert.match(prompt, /image 2 = NV1/, 'mix gọi đúng tên ảnh 2');
  // mixedLine tả ảnh 1 bằng câu chữ, nên chỉ các ảnh nhận dạng (2..n) mang dạng "image N =".
  assert.equal(lines(prompt), refs.length - 1, 'gọi tên đủ các ảnh nhận dạng');

  // Các job video vừa tạo ở trên còn đang chạy; gom nhóm đòi workflow rảnh, nên dừng chúng trước.
  const stopped = await api('/api/auto/video/stop', 'POST', {});
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  assert.ok(
    await settle(async () => {
      const js = (await state()).jobs || [];
      return !js.some(j => ['queued', 'running'].includes(j.status));
    }),
    'không còn job nào đang chạy',
  );

  // 4. Nhóm Seedance: NHIỀU shot trong một lượt render. Khi nhóm có ít ảnh asset, groupRefs đính
  //    chính khung của từng shot làm tham chiếu (lib/seedance.mjs: `refs.length < 2`). Lúc đó đầu
  //    prompt liệt kê "Image N: the opening frame of shot k" — và dòng của chính shot đó cũng phải
  //    gọi số ảnh ấy, để model không phải nhớ bảng ánh xạ suốt một prompt dài.
  let gr = await api('/api/seedance/groups', 'POST', {});
  assert.equal(gr.status, 200, JSON.stringify(gr.data));

  // Hai shot trần, không nối asset nào → nhánh dự phòng đính khung của chính chúng.
  const bare = [];
  for (const name of ['Tran 1', 'Tran 2']) {
    const made = await api('/api/nodes', 'POST', { name });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const id = made.data.nodes.at(-1).id;
    assert.equal((await api('/api/node', 'PATCH', { id, duration: 8 })).status, 200);
    const q = await api('/api/jobs', 'POST', { nodeId: id, kind: 'image' });
    assert.equal(q.status, 201, name + ': ' + JSON.stringify(q.data));
    assert.ok(await settle(async () => !!(await node(id))?.image), name + ' có ảnh');
    bare.push(id);
  }
  const stop2 = await api('/api/auto/video/stop', 'POST', {});
  assert.equal(stop2.status, 200, JSON.stringify(stop2.data));
  gr = await api('/api/seedance/groups', 'POST', {});
  assert.equal(gr.status, 200, JSON.stringify(gr.data));
  const st4 = gr.data;
  const bareGroup = (st4.created || [])
    .map(id => st4.nodes.find(n => n.id === id))
    .find(g => st4.edges.some(e => e.target === g.id && bare.includes(e.source)));
  assert.ok(bareGroup, 'hai shot trần được gom thành một nhóm');
  const gp = bareGroup.resolvedPrompts.video;
  const listed = [...gp.matchAll(/Image (\d+): the opening frame of shot (\d+)/g)];
  assert.ok(listed.length, 'prompt nhóm liệt kê khung mở đầu của shot');
  for (const [, img, k] of listed) {
    const line = gp.split(String.fromCharCode(10)).find(l => l.startsWith(`Shot ${k} (`));
    assert.ok(line, `prompt co dong cua shot ${k}`);
    assert.ok(
      line.includes(`Opens on image ${img}.`),
      `shot ${k} phai tu goi anh ${img}; dong hien tai: ${line}`,
    );
  }

  // 5. Cảnh gộp: mỗi block thoại phải gọi số ảnh của setup nó dùng, khớp với dòng "Image N = …".
  const proj = await api('/api/projects', 'POST', {
    name: 'Ghép ref map',
    theme: 'film',
    exportDir: path.join(dir, 'merged-folder'),
  });
  assert.equal(proj.status, 201, JSON.stringify(proj.data));
  const mb = await api('/api/director/build', 'POST', {
    blueprint: {
      project: { title: 'Ghép' },
      assets: [
        { key: 'e', role: 'character', name: 'Eleanor', code: 'NV1', prompt: 'model sheet',
          identity_label: 'the auburn-haired woman', back_view: 'her auburn bun' },
        { key: 'v', role: 'character', name: 'Vivienne', code: 'NV2', prompt: 'model sheet',
          identity_label: 'the blonde woman', back_view: 'her blonde chignon' },
        { key: 'scene_study', role: 'scene', name: 'Study', prompt: 'a study at night' },
      ],
      shots: [
        {
          name: 'Cảnh 01',
          start: 0,
          uses: ['e', 'v', 'scene_study'],
          sides: { left: 'e', right: 'v' },
          setups: [
            { framing: 'ots_a', dialogue: 'Vivienne: "He changed the will."' },
            { framing: 'ots_b', dialogue: 'Eleanor: "I know."' },
            { framing: 'two_shot', dialogue: 'Vivienne: "Then you leave with nothing."' },
          ],
        },
      ],
    },
  });
  assert.equal(mb.status, 200, JSON.stringify(mb.data)?.slice(0, 300));
  // Ảnh cho mọi node, kể cả 3 khung setup — prompt gộp đánh số theo chính các ảnh này.
  for (const a of (await state()).nodes.filter(
    n => !n.terminal && !n.imageInputs && n.kind !== 'setting' && n.zone !== 'merged',
  )) {
    const q = await api('/api/jobs', 'POST', { nodeId: a.id, kind: 'image' });
    assert.equal(q.status, 201, a.name + ': ' + JSON.stringify(q.data));
    assert.ok(await settle(async () => !!(await node(a.id))?.image), a.name + ' có ảnh');
  }
  const merged = (await state()).nodes.find(n => n.zone === 'merged');
  assert.ok(merged, 'blueprint có setups thì dựng node cảnh gộp');
  const mp = merged.resolvedPrompts.video;
  const heads = [...mp.matchAll(/Image (\d+) = ([^.]+)\./g)];
  assert.equal(heads.length, 3, 'đầu prompt đánh số đủ 3 setup');
  // Mỗi số ảnh đã khai ở đầu phải xuất hiện lại trong ít nhất một block thoại.
  for (const [, img] of heads)
    assert.ok(mp.includes(`(image ${img})`), `co block dung anh ${img}`);
  // Và không block nào gọi một số ảnh không tồn tại.
  for (const [, img] of [...mp.matchAll(/\(image (\d+)\)/g)])
    assert.ok(Number(img) >= 1 && Number(img) <= 3, `số ảnh ${img} nằm trong khoảng đã khai`);

  console.log(
    'PASS: ref map — prompt video luôn kèm bảng "ảnh nào là gì" khi chưa có sẵn (ảnh 1 = khung đầu, kèm @NV1/@NV2), số dòng LUÔN khớp số ảnh thật sự gửi đi kể cả khi tool đổi chế độ, và KHÔNG chèn trùng khi prompt đã tự đánh số (mix); nhóm Seedance mỗi shot tự gọi số ảnh khung mở đầu; cảnh gộp mỗi block tự gọi số ảnh setup',
  );
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  srv.close();
  await new Promise(r => setTimeout(r, 300));
  fs.rmSync(dir, { recursive: true, force: true });
}
