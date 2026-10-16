// Node Kịch bản (SCRIPT): brief → xưởng → blueprint + QC → dựng graph.
// Chạy server thật trên cổng/thư mục riêng. LLM là một server HTTP đứng thay cho dịch vụ trả
// phí (giống test-director), và nó cố tình trả blueprint SAI ở lượt đầu để kiểm vòng tự sửa.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { qcBlueprint, stages } from './lib/script-studio.mjs';

// --- blueprint mẫu: một cụm thoại 4 nhịp tái dùng 2 cỡ cảnh ---------------------------------
const bp = ok => ({
  project: { title: 'Thử', theme: 'film' },
  styles: [{ key: 'st', name: 'S', prompt: 'cinematic' }],
  audio: [{ key: 'au', name: 'A', prompt: 'room tone' }],
  assets: [
    {
      key: 'chong',
      role: 'character',
      name: 'Người chồng',
      code: 'NV1',
      // Lượt đầu cố tình thiếu identity_label → QC phải bắt được.
      ...(ok
        ? {
            identity_label: 'the stubbled man in charcoal',
            back_view: 'his short hair and charcoal shoulder',
          }
        : {}),
      prompt: 'model sheet',
      voice_profile: { gender: 'Male' },
    },
    {
      key: 'vo',
      role: 'character',
      name: 'Người vợ',
      code: 'NV2',
      identity_label: 'the woman in wine-red',
      back_view: 'her long hair and wine-red strap',
      prompt: 'model sheet',
      voice_profile: { gender: 'Female' },
    },
    {
      key: 'sc',
      role: 'scene',
      name: 'Phòng khách',
      prompt: 'a living room at night',
      conversation: {
        place: 'the dim living room',
        two_shot: 'side medium two-shot',
        left: { anchor: 'by the sofa', background: 'the console', light: 'warm lamp' },
        right: { anchor: 'at the door', background: 'the door', light: 'cold spill' },
      },
    },
  ],
  shots: [
    {
      name: 'C1',
      start: 0,
      duration: 8,
      uses: ['chong', 'vo', 'sc', 'st', 'au'],
      style: 'st',
      audio: 'au',
      place: 'sc',
      sides: { left: 'chong', right: 'vo' },
      setups: [
        { framing: 'ots_b', dialogue: 'Người chồng: "Bạn nào?"', audio_delivery: 'flat' },
        { framing: 'ots_a', dialogue: 'Người vợ: "Bạn đại học."', audio_delivery: 'quick' },
        { framing: 'ots_b', dialogue: 'Người chồng: "Huy?"', audio_delivery: 'low' },
        { framing: 'ots_a', dialogue: 'Người vợ: "Ừ."', audio_delivery: 'soft' },
      ],
    },
  ],
});

// --- QC là hàm thuần: kiểm trực tiếp trước khi dựng server ----------------------------------
{
  const bad = qcBlueprint(JSON.stringify(bp(false)));
  assert.equal(bad.ok, false, 'QC phải bắt blueprint thiếu identity_label');
  assert.ok(
    bad.errors.some(e => /identity_label/.test(e)),
    bad.errors.join(' | '),
  );
  const good = qcBlueprint(JSON.stringify(bp(true)));
  assert.equal(good.ok, true, 'blueprint đủ trường phải sạch: ' + good.errors.join(' | '));

  // Người nói sai hướng mặt: ots_a phải là người bên PHẢI (vợ), không phải chồng.
  const wrongFacing = bp(true);
  wrongFacing.shots[0].setups[1].dialogue = 'Người chồng: "Bạn đại học."';
  assert.ok(
    qcBlueprint(JSON.stringify(wrongFacing)).errors.some(e => /quay mặt về máy/.test(e)),
    'QC phải bắt người nói sai hướng mặt',
  );
  // Tiền tố vai chung không khớp tên nhân vật.
  const wrongName = bp(true);
  wrongName.shots[0].setups[0].dialogue = 'Chồng: "Bạn nào?"';
  assert.ok(
    qcBlueprint(JSON.stringify(wrongName)).errors.some(e => /không khớp tên nhân vật/.test(e)),
    'QC phải bắt tiền tố người nói sai',
  );
  // Quá 6 nhịp trong một clip 8 giây.
  const tooMany = bp(true);
  tooMany.shots[0].setups = Array.from({ length: 7 }, (_, i) => ({
    framing: i % 2 ? 'ots_a' : 'ots_b',
    dialogue: (i % 2 ? 'Người vợ' : 'Người chồng') + ': "Ừ."',
  }));
  assert.ok(
    qcBlueprint(JSON.stringify(tooMany)).errors.some(e => /2–6 nhịp/.test(e)),
    'QC phải bắt quá 6 nhịp',
  );
  // Thoại quá dài cho số nhịp → cảnh báo nhịp (không chặn).
  const fast = bp(true);
  fast.shots[0].setups[0].dialogue =
    'Người chồng: "Bạn nào mà giờ này còn hẹn, phải thay tới ba bộ váy khác nhau thế?"';
  assert.ok(
    qcBlueprint(JSON.stringify(fast)).warnings.some(w => /từ\/giây|quá nhanh/.test(w)),
    'QC phải cảnh báo thoại quá nhanh',
  );
  assert.equal(stages('fast').length, 3, 'chế độ nhanh = 3 lượt LLM');
  assert.equal(stages('full').length, 6, 'chế độ kỹ = 6 lượt (⑦ QC không gọi LLM)');
}

// --- chạy trọn luồng qua server -------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-script-'));
let calls = 0;
const systems = [];
const userPrompts = [];
// Đặt key trạm vào đây để LLM giả lập ném lỗi đúng ở trạm đó (kiểm "chạy tiếp từ bước lỗi").
let failAt = '';
const llm = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  calls++;
  const body = JSON.parse(raw);
  const system = body.messages[0].content;
  systems.push(system);
  userPrompts.push(body.messages[1]?.content || '');
  // Trạm ráp JSON (và lượt sửa) trả blueprint; các trạm khác trả văn xuôi.
  const wantsJson = /HỢP ĐỒNG JSON/.test(system);
  // Trạm "shots" (bảng shot) nhận biết qua system prompt của nó.
  if (failAt === 'shots' && /Đạo diễn Hình ảnh kiêm Trục/.test(system)) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'LLM sập' } }));
    return;
  }
  // Lượt ráp ĐẦU TIÊN trả bản thiếu identity_label để ép QC vào vòng sửa.
  const firstAssemble = wantsJson && !systems.slice(0, -1).some(s => /HỢP ĐỒNG JSON/.test(s));
  const content = wantsJson
    ? '```json\n' + JSON.stringify(bp(!firstAssemble)) + '\n```'
    : 'Văn xuôi trạm ' + calls;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise(r => llm.listen(17798, '127.0.0.1', r));
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: '17799', MV_ORBIT_URL: 'http://127.0.0.1:1', MV_DATA_DIR: dir },
  stdio: 'pipe',
});
const api = async (p, method = 'GET', b) => {
  const r = await fetch('http://127.0.0.1:17799' + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch('http://127.0.0.1:17799/api/state')).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  let r = await api('/api/projects', 'POST', {
    name: 'script',
    theme: 'film',
    exportDir: path.join(dir, 'out'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  // Trỏ Đạo diễn LLM vào server đứng thay.
  r = await api('/api/director/llm', 'POST', {
    key: 'test-key-1234',
    baseUrl: 'http://127.0.0.1:17798/v1',
    model: 'mock',
  });
  assert.equal(r.status, 200, 'cấu hình LLM: ' + JSON.stringify(r.data));
  assert.equal((await api('/api/director')).data.llm.configured, true);

  // Tạo node kịch bản
  r = await api('/api/nodes', 'POST', { kind: 'script' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const node = r.data.nodes.find(n => n.kind === 'script');
  assert.ok(node, 'node kịch bản được tạo');
  assert.equal(node.zone, 'start', 'nằm ở cột ⓪ START cùng node Nhạc');

  // Chưa có ý tưởng thì không chạy
  r = await api('/api/script/run', 'POST', { id: node.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Ý tưởng/);

  // Nhập brief rồi chạy
  r = await api('/api/node', 'PATCH', {
    id: node.id,
    brief: { idea: 'Vợ đi gặp người yêu cũ.', country: 'Việt Nam', duration: '8' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('/api/script/run', 'POST', { id: node.id, mode: 'fast', via: 'api', restart: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  // Đợi chạy xong
  let done = null;
  for (let i = 0; i < 150; i++) {
    const st = (await api('/api/state')).data;
    const n = st.nodes.find(x => x.id === node.id);
    if (n?.run && n.run.status !== 'running') {
      done = n;
      break;
    }
    await new Promise(res => setTimeout(res, 100));
  }
  assert.ok(done, 'xưởng phải kết thúc');
  assert.equal(done.run.status, 'done', 'chạy xong: ' + (done.run.error || ''));
  assert.ok(done.stages.story, 'có story bible');
  assert.ok(done.stages.shots, 'có bảng shot');
  assert.ok(done.blueprint, 'có blueprint');
  // 3 lượt trạm + ít nhất 1 lượt sửa (lượt ráp đầu cố tình sai)
  assert.ok(calls >= 4, `phải có vòng tự sửa, mới gọi ${calls} lượt`);
  assert.equal(
    done.qc.ok,
    true,
    'QC phải sạch sau khi tự sửa: ' + (done.qc.errors || []).join(' | '),
  );
  assert.equal(done.qc.rounds, 1, 'đúng một vòng sửa');

  // Dựng graph từ blueprint
  r = await api('/api/script/build', 'POST', { id: node.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = r.data.nodes;
  assert.ok(
    after.some(n => n.zone === 'merged'),
    'graph có phân cảnh ghép',
  );
  assert.ok(
    after.some(n => n.role === 'frame'),
    'graph có node khung',
  );
  const kept = after.find(n => n.id === node.id);
  assert.ok(kept, 'node kịch bản sống sót qua lần dựng');
  assert.ok(kept.blueprint, 'và giữ nguyên blueprint của nó');

  // QC lại sau khi sửa tay một blueprint hỏng
  r = await api('/api/script/qc', 'POST', { id: node.id, blueprint: JSON.stringify(bp(false)) });
  assert.equal(r.status, 200);
  const rechecked = r.data.nodes.find(n => n.id === node.id);
  assert.equal(rechecked.qc.ok, false, 'QC tay phải bắt lại lỗi');
  // Và không cho dựng khi còn lỗi
  r = await api('/api/script/build', 'POST', { id: node.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /QC còn lỗi/);

  // --- Nhân vật phải ra ĐÚNG model sheet của tool, không bị prompt blueprint đè -------------
  {
    const st2 = (await api('/api/state')).data;
    const ch = st2.nodes.find(x => x.role === 'character' && x.assetKey === 'chong');
    assert.ok(ch, 'có node nhân vật sau khi dựng');
    assert.equal(ch.prompt, '', 'mô tả blueprint KHÔNG đè lên sheet của tool');
    assert.equal(ch.desc, 'model sheet', 'mô tả blueprint thành desc để tool bọc');
    const img = ch.resolvedPrompts.image;
    // Một ảnh chính (chân dung) + 3 góc toàn thân, cùng tỉ lệ trên một đường chân.
    assert.match(img, /Character model sheet turnaround of one single person: model sheet/);
    assert.match(img, /large head-and-shoulders portrait on the left/, 'có ảnh chính mặt');
    assert.match(
      img,
      /full-body front, side and back views on the right at the same scale on one shared baseline/,
      'có đủ 3 góc xoay, cùng tỉ lệ, một đường chân',
    );
    assert.match(img, /The exact same person in every view/, 'khoá nhận dạng giữa các góc');
    assert.match(img, /Solid gray background/, 'nền xám trơn');
    assert.match(img, /no text/, 'không chữ trên ảnh');
  }

  // --- Một trạm hỏng: giữ kết quả các trạm trước, và chạy tiếp từ đúng trạm đó ---------------
  failAt = 'shots'; // trạm ②–⑤ sẽ ném lỗi
  r = await api('/api/script/run', 'POST', { id: node.id, mode: 'fast', via: 'api', restart: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let broke = null;
  for (let i = 0; i < 150; i++) {
    const st = (await api('/api/state')).data;
    const x = st.nodes.find(y => y.id === node.id);
    if (x?.run && x.run.status !== 'running') {
      broke = x;
      break;
    }
    await new Promise(res => setTimeout(res, 100));
  }
  assert.ok(broke, 'lượt hỏng phải kết thúc');
  assert.equal(broke.run.status, 'failed', 'trạm hỏng → run.failed');
  assert.equal(broke.run.failedAt, 'shots', 'ghi đúng trạm hỏng để chạy tiếp');
  assert.ok(broke.stages.story, 'KẾT QUẢ TRẠM TRƯỚC ĐƯỢC GIỮ, không mất khi trạm sau hỏng');
  assert.ok(!broke.stages.shots, 'trạm hỏng thì không có kết quả');

  // Chạy tiếp từ đúng trạm lỗi: không gọi lại trạm ① nữa.
  failAt = '';
  const storyBefore = broke.stages.story;
  systems.length = 0;
  r = await api('/api/script/run', 'POST', {
    id: node.id,
    mode: 'fast',
    via: 'api',
    from: 'shots',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let resumed = null;
  for (let i = 0; i < 150; i++) {
    const st = (await api('/api/state')).data;
    const x = st.nodes.find(y => y.id === node.id);
    if (x?.run && x.run.status !== 'running') {
      resumed = x;
      break;
    }
    await new Promise(res => setTimeout(res, 100));
  }
  assert.equal(resumed.run.status, 'done', 'chạy tiếp thành công: ' + (resumed.run.error || ''));
  assert.equal(resumed.stages.story, storyBefore, 'trạm ① KHÔNG bị chạy lại — giữ nguyên bản cũ');
  assert.ok(!systems.some(s => /Bạn là Biên kịch/.test(s)), 'không gọi LLM cho trạm đã có kết quả');
  assert.ok(resumed.stages.shots, 'trạm lỗi đã chạy lại xong');

  // --- Sửa tay một trạm rồi chạy tiếp: các trạm sau dùng bản đã sửa --------------------------
  const edited = 'STORY BIBLE ĐÃ SỬA TAY — mã kiểm tra ZZTOP';
  r = await api('/api/node', 'PATCH', { id: node.id, stages: { story: edited } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(
    r.data.nodes.find(x => x.id === node.id).stages.story,
    edited,
    'sửa tay một trạm được lưu',
  );
  userPrompts.length = 0;
  r = await api('/api/script/run', 'POST', {
    id: node.id,
    mode: 'fast',
    via: 'api',
    from: 'shots',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (let i = 0; i < 150; i++) {
    const st = (await api('/api/state')).data;
    const x = st.nodes.find(y => y.id === node.id);
    if (x?.run && x.run.status !== 'running') break;
    await new Promise(res => setTimeout(res, 100));
  }
  assert.ok(
    userPrompts.some(u => u.includes('ZZTOP')),
    'các trạm sau nhận ĐÚNG bản story đã sửa tay',
  );

  // Không cho chạy tiếp từ một trạm khi trạm trước chưa có kết quả.
  r = await api('/api/node', 'PATCH', { id: node.id, stages: { story: '' } });
  assert.equal(r.status, 200);
  r = await api('/api/script/run', 'POST', {
    id: node.id,
    mode: 'fast',
    via: 'api',
    from: 'shots',
  });
  assert.equal(r.status, 400, 'thiếu kết quả trạm trước thì phải chặn');
  assert.match(r.data.error, /còn thiếu kết quả/);
  // Khôi phục để phần MV chạy tiếp được.
  await api('/api/node', 'PATCH', { id: node.id, stages: { story: edited } });

  // --- Chế độ MV: nối node Nhạc vào node Kịch bản -------------------------------------------
  r = await api('/api/nodes', 'POST', { kind: 'music' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const music = r.data.nodes.find(x => x.kind === 'music');
  assert.ok(music, 'tạo được node nhạc');
  // Bài hát đã phân tích: cấu trúc theo giây + lời.
  r = await api('/api/node', 'PATCH', { id: music.id, lyrics: 'Đêm nay anh nhớ em' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Nối nhạc → kịch bản
  const edges = r.data.edges.concat([{ source: music.id, target: node.id }]);
  r = await api('/api/edges', 'PUT', { edges });
  assert.equal(r.status, 200, 'nối được node nhạc vào node kịch bản: ' + JSON.stringify(r.data));
  assert.ok(
    r.data.edges.some(e => e.source === music.id && e.target === node.id),
    'dây nhạc → kịch bản được giữ',
  );
  // Chạy lại: xưởng phải sang chế độ MV và brief phải mang theo bài hát.
  systems.length = 0;
  r = await api('/api/script/run', 'POST', { id: node.id, mode: 'fast', via: 'api', restart: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let mv = null;
  for (let i = 0; i < 150; i++) {
    const st = (await api('/api/state')).data;
    const x = st.nodes.find(y => y.id === node.id);
    if (x?.run && x.run.status !== 'running') {
      mv = x;
      break;
    }
    await new Promise(res => setTimeout(res, 100));
  }
  assert.ok(mv, 'lượt MV phải kết thúc');
  assert.equal(mv.run.kind, 'mv', 'có nhạc nối vào thì chạy chế độ MV');
  assert.ok(
    systems.some(s => /Đạo diễn MV/.test(s)),
    'dùng prompt MV chứ không phải prompt drama',
  );
  assert.ok(
    userPrompts.some(u => /BÀI HÁT \(node Nhạc nối vào/.test(u) && /Đêm nay anh nhớ em/.test(u)),
    'brief gửi đi có kèm bài hát + lời của node nhạc',
  );

  console.log(
    'PASS: QC thuần (thiếu identity_label, sai hướng mặt, sai tiền tố người nói, quá 6 nhịp, cảnh báo nhịp thoại), node kịch bản ở cột riêng, chặn khi thiếu ý tưởng, chạy xưởng 3 lượt + tự sửa 1 vòng tới khi QC sạch, dựng graph và node sống sót, QC tay chặn dựng khi còn lỗi, trạm hỏng vẫn giữ kết quả trạm trước + chạy tiếp từ đúng trạm lỗi (không gọi lại trạm cũ), sửa tay một trạm thì các trạm sau dùng bản đã sửa, chặn chạy tiếp khi trạm trước trống, nối node Nhạc vào thì chuyển sang chế độ MV và brief mang theo bài hát + lời',
  );
} finally {
  proc.kill();
  llm.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
