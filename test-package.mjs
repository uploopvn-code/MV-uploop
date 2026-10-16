// Gói giao hàng: MỘT zip gồm video đã render (tên theo tên shot trên UI) + đủ các bước kịch
// bản + prompt/Bible/manifest. Chạy thật qua server, mở zip ra kiểm từng mục.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { stages } from './lib/script-studio.mjs';

// Đọc tên + nội dung từng mục trong zip (store hoặc deflate) — không dùng thư viện ngoài, để
// test kiểm đúng cái zip thật gửi cho người dùng.
function readZip(buf) {
  const out = new Map();
  // Duyệt central directory từ cuối file.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'zip có End Of Central Directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header hợp lệ');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-pack-'));
const PORT = 17805;
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
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(16),
]).toString('base64');

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  let r = await api('/api/director/build', 'POST', {
    blueprint: JSON.stringify({
      project: { name: 'Vết Xước · Tập 9', theme: 'drama' },
      style: 'Cinematic 35mm',
      assets: [
        { key: 'vo', role: 'character', name: 'Người vợ', code: 'NV1', prompt: 'sheet' },
        { key: 'phong', role: 'scene', name: 'Phòng khách', prompt: 'room' },
      ],
      shots: [
        { name: 'Mở màn', start: 0, duration: 8, uses: ['vo', 'phong'], videoPrompt: 'she enters' },
        {
          name: 'Đối chất',
          start: 8,
          duration: 8,
          uses: ['vo', 'phong'],
          videoPrompt: 'she turns',
        },
      ],
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));

  // Hai shot có video thật (tải lên, không cần API).
  const shots = (await state()).nodes.filter(n => !n.terminal && 'duration' in n);
  assert.equal(shots.length, 2, 'có 2 shot');
  for (const s of shots) {
    const up = await api('/api/upload', 'POST', {
      nodeId: s.id,
      kind: 'video',
      mime: 'video/mp4',
      name: 'x.mp4',
      base64: MP4,
    });
    assert.equal(up.status, 200, s.name + ': ' + JSON.stringify(up.data)?.slice(0, 150));
  }
  // Một ảnh để prompts.json có đủ thứ để giải.
  const vo = (await state()).nodes.find(n => n.name === 'Người vợ');
  await api('/api/upload', 'POST', {
    nodeId: vo.id,
    kind: 'image',
    mime: 'image/png',
    name: 'x.png',
    base64: PNG,
  });

  // Node Kịch bản ở chế độ "Kỹ" với kết quả của cả 6 trạm đã lưu.
  r = await api('/api/nodes', 'POST', { kind: 'script', name: 'Kịch bản' });
  assert.equal(r.status, 201, JSON.stringify(r.data)?.slice(0, 200));
  const script = r.data.nodes.find(n => n.kind === 'script');
  assert.ok(script, 'có node Kịch bản');
  const list = stages('full', 'drama');
  assert.equal(list.length, 6, 'chế độ Kỹ có 6 trạm');
  const saved = {};
  for (const st of list) saved[st.key] = `NỘI DUNG CỦA ${st.key.toUpperCase()}`;
  saved.blueprint = '{"project":{"name":"x"}}';
  r = await api('/api/node', 'PATCH', { id: script.id, mode: 'full', stages: saved });
  if (r.status !== 200) console.log('DEBUG PATCH:', JSON.stringify(r.data));
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));

  // --- Bản kê trước khi tải ------------------------------------------------------------------
  const plan = await api('/api/package/plan');
  assert.equal(plan.status, 200, JSON.stringify(plan.data)?.slice(0, 200));
  assert.equal(plan.data.clips, 2, 'kê đúng 2 clip');
  assert.equal(plan.data.steps, 7, 'kê đúng 7 bước (6 trạm + QC)');
  assert.match(
    plan.data.name,
    /^Vết Xước · Tập 9-\d{4}-\d{2}-\d{2}\.zip$/,
    'tên gói theo project + ngày',
  );

  // --- Tải gói thật rồi mở ra ----------------------------------------------------------------
  const res = await fetch(`http://127.0.0.1:${PORT}/api/package`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/zip/);
  assert.match(
    decodeURIComponent(res.headers.get('content-disposition')),
    /Vết Xước · Tập 9/,
    'tên file tải về mang tên project',
  );
  const zip = readZip(Buffer.from(await res.arrayBuffer()));
  const names = [...zip.keys()];

  // Video: đúng 2 clip, tên theo SỐ THỨ TỰ + TÊN SHOT TRÊN UI, không phải uuid.
  const vids = names.filter(n => n.startsWith('video/'));
  assert.equal(vids.length, 2, 'gói có 2 video');
  assert.ok(
    vids.some(n => n.includes('Mở màn')) && vids.some(n => n.includes('Đối chất')),
    'tên clip theo tên shot trên UI: ' + vids.join(', '),
  );
  assert.ok(
    vids.every(n => /^video\/\d{2}_.+_v\d+\.mp4$/.test(n)),
    'dạng <stt>_<tên>_v<phiên bản>.mp4: ' + vids.join(', '),
  );
  assert.ok(
    vids.every(n => !/[0-9a-f]{8}-[0-9a-f]{4}/.test(n)),
    'không còn uuid trong tên file',
  );
  for (const v of vids) assert.ok(zip.get(v).length > 0, v + ' có nội dung');

  // Ảnh: node có ảnh được đóng gói, tên theo node (không uuid), trong thư mục anh/.
  assert.equal(plan.data.images, 1, 'kê đúng 1 ảnh (Người vợ)');
  const imgs = names.filter(n => n.startsWith('anh/'));
  assert.equal(imgs.length, 1, 'gói có 1 ảnh: ' + imgs.join(', '));
  assert.ok(imgs[0].includes('Người vợ') && imgs[0].endsWith('.png'), 'ảnh đặt tên theo node: ' + imgs[0]);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(imgs[0]), 'ảnh không còn uuid');
  assert.ok(zip.get(imgs[0]).length > 0, 'ảnh có nội dung');

  // Kịch bản: đủ 7 bước, đánh số, và mang đúng nội dung từng trạm.
  const kb = names.filter(n => n.startsWith('kich-ban/')).sort();
  assert.equal(kb.length, 7, 'đủ 7 bước: ' + kb.join(', '));
  assert.ok(
    kb.every((n, i) => n.startsWith('kich-ban/' + String(i + 1).padStart(2, '0') + '-')),
    'đánh số 01..07 liên tục: ' + kb.join(', '),
  );
  assert.match(kb[0], /bien-kich/, 'bước 1 là biên kịch');
  assert.match(kb[1], /dao-dien-hinh-anh/, 'bước 2 là đạo diễn hình ảnh');
  assert.match(kb[6], /qc-validator/, 'bước 7 là QC');
  assert.match(zip.get(kb[0]).toString('utf8'), /NỘI DUNG CỦA STORY/, 'bước 1 mang nội dung thật');
  assert.match(
    zip.get(kb[1]).toString('utf8'),
    /NỘI DUNG CỦA LOOK/,
    'bước 2 mang nội dung thật của trạm đạo diễn hình ảnh',
  );
  assert.ok(kb[5].endsWith('.json'), 'bước ráp JSON xuất ra .json');
  assert.match(zip.get(kb[6]).toString('utf8'), /Chưa chạy kiểm/, 'QC chưa chạy thì nói rõ');

  // Prompt / Bible / manifest / tờ khai.
  assert.ok(names.includes('prompts.json'), 'có prompts.json');
  assert.ok(names.includes('bible.json'), 'có bible.json');
  assert.ok(names.includes('DOC-TRUOC.txt'), 'có tờ khai');
  const pj = JSON.parse(zip.get('prompts.json').toString('utf8'));
  assert.equal(pj.project, 'Vết Xước · Tập 9');
  assert.ok(
    pj.shots.some(s => s.name === 'Mở màn' && s.prompts?.video),
    'prompts.json có prompt video đã giải, kèm tên shot',
  );
  const bible = JSON.parse(zip.get('bible.json').toString('utf8'));
  assert.ok(
    JSON.stringify(bible).includes('Người vợ'),
    'bible.json mang nhân vật để dùng lại cho tập sau',
  );
  const doc = zip.get('DOC-TRUOC.txt').toString('utf8');
  assert.match(doc, /2 clip shot lẻ/, 'tờ khai đếm đúng clip shot lẻ');
  assert.match(doc, /7 bước/, 'tờ khai đếm đúng bước');

  // Project chưa có node Kịch bản: vẫn đóng gói được, và nói rõ là thiếu.
  r = await api('/api/nodes/delete', 'POST', { id: script.id });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 150));
  const zip2 = readZip(
    Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/api/package`)).arrayBuffer()),
  );
  assert.ok(
    [...zip2.keys()].filter(n => n.startsWith('video/')).length === 2,
    'không có kịch bản thì video vẫn đủ',
  );
  assert.match(
    zip2.get('DOC-TRUOC.txt').toString('utf8'),
    /chưa có node Kịch bản/,
    'tờ khai nói rõ project chưa có node Kịch bản',
  );

  // --- Đặt tên theo số cảnh trong TÊN shot, không theo seq -----------------------------------
  // seq do tool đánh và không đáng tin: trên project thật có hai shot cùng seq, và seq 4 lại là
  // cảnh S12 còn seq 5 là S03. Thứ tự thật nằm ở số S trong tên.
  r = await api('/api/director/build', 'POST', {
    blueprint: JSON.stringify({
      project: { name: 'Thứ tự cảnh', theme: 'drama' },
      style: 'Cinematic',
      assets: [{ key: 'a', role: 'character', name: 'NV A', code: 'NV1', prompt: 'sheet' }],
      shots: [
        { name: 'S11 — Bằng chứng', start: 0, duration: 8, uses: ['a'], videoPrompt: 'x' },
        { name: 'S02 — Chối', start: 8, duration: 8, uses: ['a'], videoPrompt: 'x' },
        { name: 'S100 — Cảnh cuối', start: 16, duration: 8, uses: ['a'], videoPrompt: 'x' },
        { name: 'Không đánh số', start: 24, duration: 8, uses: ['a'], videoPrompt: 'x' },
      ],
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  for (const s of (await state()).nodes.filter(n => !n.terminal && 'duration' in n))
    await api('/api/upload', 'POST', {
      nodeId: s.id,
      kind: 'video',
      mime: 'video/mp4',
      name: 'x.mp4',
      base64: MP4,
    });
  const z3 = readZip(
    Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/api/package`)).arrayBuffer()),
  );
  const v3 = [...z3.keys()].filter(n => n.startsWith('video/')).sort();
  assert.ok(
    v3.some(n => n.includes('S002_Chối')),
    'S02 → S002 (đệm theo cảnh lớn nhất là 100): ' + v3.join(', '),
  );
  assert.ok(
    v3.some(n => n.includes('S011_Bằng chứng')),
    'S11 → S011',
  );
  assert.ok(
    v3.some(n => n.includes('S100_Cảnh cuối')),
    'S100 giữ nguyên',
  );
  // Sắp theo TÊN là ra đúng thứ tự cảnh — đây mới là mục đích. Nếu đệm không đồng nhất thì
  // S100 sẽ chen lên trước S011 và phép so sánh này đỏ.
  const order = v3.filter(n => /\/S\d/.test(n)).map(n => n.match(/S(\d+)_/)[1]);
  assert.deepEqual(
    order,
    ['002', '011', '100'],
    'sắp theo tên ra đúng thứ tự cảnh: ' + v3.join(', '),
  );
  assert.ok(!v3.some(n => /S\d+_S\d/.test(n)), 'không lặp "S11_S11 —" trong tên');
  assert.ok(
    v3.some(n => /video\/\d{2}_Không đánh số/.test(n)),
    'shot không có số S thì vẫn đánh theo seq: ' + v3.join(', '),
  );

  // --- Clip của NHÓM Seedance tách riêng thư mục video/nhom/ ---------------------------------
  // Gom các shot đang có (đều đã có video) thành một nhóm, cho nhóm một video + storyboard, rồi gói.
  await api('/api/seedance/groups', 'POST', { resplit: true });
  let gstate = await state();
  const group = gstate.nodes.find(n => n.role === 'seedance');
  assert.ok(group, 'có nhóm Seedance');
  // nhóm có storyboard (ảnh) + một clip video
  await api('/api/upload', 'POST', { nodeId: group.id, kind: 'image', mime: 'image/png', name: 'board.png', base64: PNG });
  await api('/api/upload', 'POST', { nodeId: group.id, kind: 'video', mime: 'video/mp4', name: 'g.mp4', base64: MP4 });
  const z4 = readZip(
    Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/api/package`)).arrayBuffer()),
  );
  const z4n = [...z4.keys()];
  assert.ok(
    z4n.some(n => n.startsWith('video/nhom/') && /Seedance/.test(n)),
    'clip của nhóm vào video/nhom/: ' + z4n.filter(n => n.startsWith('video/')).join(', '),
  );
  assert.ok(
    z4n.some(n => n.startsWith('anh/nhom/') && /Seedance/.test(n)),
    'storyboard của nhóm vào anh/nhom/: ' + z4n.filter(n => n.startsWith('anh/')).join(', '),
  );
  // các clip shot lẻ vẫn ở video/ (không lọt vào nhom/)
  assert.ok(
    z4n.some(n => n.startsWith('video/') && !n.startsWith('video/nhom/')),
    'clip shot lẻ vẫn ở video/',
  );

  console.log(
    'PASS: gói giao hàng — một zip gồm video đặt tên theo shot trên UI (không uuid), đủ 7 bước ' +
      'kịch bản đánh số 01..07 mang đúng nội dung từng trạm, prompts.json + bible.json + tờ khai; ' +
      'bản kê trước khi tải khớp với zip; thiếu node Kịch bản vẫn gói được và nói rõ; ' +
      'tên clip lấy số cảnh từ TÊN shot (S02→S002, S100) nên sắp theo tên là đúng thứ tự cảnh',
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
