// Tự sửa prompt khi model video bị BỘ LỌC NỘI DUNG từ chối 3 lần liên tiếp, và sổ học cho
// agent viết kịch bản.
//
// Hai lỗi thật lấy từ một prompt của người dùng bị từ chối nhiều lần:
//   1. Shot chạy từ ảnh keyframe mà vẫn tả lại tuổi/mặt/mắt/dáng của 3 người, không có câu
//      nhân vật hư cấu → bộ lọc coi là người thật.
//   2. Shot có 2 người nói, nhưng tool chỉ biết 1 (trường `lyric`), nên nó sinh ra câu
//      "The line is spoken by NV2 only; everyone else stays silent" mâu thuẫn với câu thoại
//      của NV3 nằm trong văn xuôi videoPrompt — và NV3 không được khoá giọng.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { MAX_ATTEMPTS, STEPS, diagnose, isRejection, speakersIn } from './lib/prompt-doctor.mjs';

// --- 1) Phân biệt "bị từ chối" với lỗi khác -------------------------------------------------
// Chuỗi thật đã gặp trên Seedvis (ghi trong sổ tay dự án) và chuỗi của bản API giả.
assert.ok(isRejection('Seedvis báo lỗi: bộ lọc an toàn từ chối'), 'bộ lọc an toàn');
// Chuỗi THẬT Seedvis trả về cho Omni Flash (kiểm trên API thật, 2026-10-12) — trước đây không
// khớp mẫu nào nên thang leo không bao giờ chạy trên API thật dù test giả vẫn xanh.
assert.ok(
  isRejection('Seedvis báo lỗi: Yêu cầu tạo nội dung thất bại. [generation_failed]'),
  'lỗi thật của Seedvis: generation_failed',
);
assert.ok(isRejection('Seedvis báo lỗi: Yêu cầu tạo nội dung thất bại.'), 'câu thật, không kèm mã');
assert.ok(isRejection('Prompt bị từ chối'), 'từ chối');
assert.ok(isRejection('content_policy'), 'mã content_policy');
assert.ok(isRejection('Blocked by safety filter'), 'safety filter');
// Lỗi KHÔNG phải kiểm duyệt thì không được sửa prompt — sửa cũng vô ích, chỉ tốn credit.
assert.ok(!isRejection('Seedvis báo lỗi: không rõ lý do'), 'lỗi không rõ không tính');
assert.ok(!isRejection('Mất kết nối Seedvis'), 'lỗi mạng không tính');
assert.ok(!isRejection('Hết credit'), 'hết credit không tính');
assert.ok(!isRejection(''), 'rỗng không tính');

// --- 2) Tìm đúng ai nói, kể cả thoại tiếng Việt có dấu chấm bên trong -----------------------
const REAL = `The attached image is the first frame of this shot: animate it, keeping every face, outfit, prop and the set exactly as they are. In it: NV2 — Vietnamese woman, 30 years old, Oval face and dark-brown almond-shaped eyes; NV3 — Vietnamese man, 33 years old, Short neat black hair; NV1 — Vietnamese woman, 59 years old, Dark-gray hair with silver strands. 8-second vertical 9:16 cinematic bedroom sequence. NV2's mouth articulates the line in perfect lip-sync: "Chín giờ sáng. Mẹ tự cất tiền vào tủ thờ." Cut to a close-up of NV3 viewing the playback. NV3's mouth articulates the line in perfect lip-sync: "Mẹ... thế là sao?" Finish on an extreme close-up of NV1. The line is spoken by NV2 only; everyone else stays silent and listens. Voice lock for NV2: female, around 30.`;

assert.deepEqual(
  speakersIn(REAL),
  ['NV2', 'NV3'],
  'thấy cả hai người nói, dù thoại NV2 có dấu chấm bên trong ngoặc kép',
);
assert.deepEqual(speakersIn('NV1 nods. No one speaks.'), [], 'không có ngoặc kép thì không ai nói');

// --- 3) Chẩn đoán: đúng 3 lỗi, và không báo lại thứ đã sửa ----------------------------------
{
  const found = diagnose(REAL);
  assert.deepEqual(
    found.map(f => f.key).sort(),
    ['dropExclusive', 'fiction', 'noAnchors'],
    'bắt đủ: mô tả ngoại hình, thiếu nhãn hư cấu, mâu thuẫn người nói',
  );
  const ex = found.find(f => f.key === 'dropExclusive');
  assert.deepEqual(ex.speakers, ['NV2', 'NV3'], 'ghi lại cả hai người nói để khoá giọng');
  assert.ok(
    found.every(f => f.rule && f.what),
    'mỗi lỗi đều có luật để ghi vào sổ học và câu giải thích cho người dùng',
  );
  // Sửa rồi thì lần sau im.
  assert.deepEqual(
    diagnose(REAL, { noAnchors: true, fiction: true, dropExclusive: true }).map(f => f.key),
    [],
    'đã sửa thì không báo lại',
  );
  // Prompt sạch thì không bịa ra lỗi.
  assert.deepEqual(
    diagnose(
      'A wide shot of an empty street at dawn. No people. The characters are fictional.',
    ).map(f => f.key),
    [],
    'prompt không người, không thoại → không có gì để sửa',
  );
}

// --- 4) Chạy thật: 3 lần bị từ chối → tự sửa → chạy lại → ghi sổ ----------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-doctor-'));
const KEY = 'test-key';
const API = 'http://127.0.0.1:17796/api/v1';
fs.writeFileSync(path.join(dir, 'seedvis-key.txt'), KEY);

// Bản API Seedvis tối giản: mọi lượt video đều bị bộ lọc nội dung từ chối — đúng tình huống
// người dùng gặp. Đếm số lần nhận prompt và giữ lại từng prompt để xem bản sửa khác ra sao.
const sent = []; // prompt của từng lượt VIDEO, theo thứ tự gửi đi
const submitsVideo = () => sent;
let allowFrom = Infinity; // từ lượt video thứ n trở đi thì cho qua
const gens = new Map();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// Client kiểm loại file thật, nên file giả phải có header mp4 hợp lệ.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(16)]);
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
  if (req.url === '/api/v1/models') return send(200, { data: [{ id: 'Veo-3.1' }] });
  const poll = req.url.match(/^\/api\/v1\/developer\/generations\/([\w-]+)\?wait=0$/);
  if (poll) {
    const g = gens.get(poll[1]);
    // Ảnh luôn qua (shot cần một keyframe thật mới vào được đường prompt có mô tả ngoại hình);
    // chỉ VIDEO bị bộ lọc nội dung chặn — đúng tình huống người dùng gặp.
    const ok = g.kind === 'image' || g.index >= allowFrom;
    return send(200, {
      success: true,
      data: {
        id: poll[1],
        status: ok ? 'completed' : 'failed',
        is_final: true,
        next: { action: 'done' },
        outputs: ok ? [{ type: g.kind, url: 'http://127.0.0.1:17796/cdn/' + poll[1] }] : [],
        references: [],
        // Đúng nguyên văn Seedvis thật trả cho Omni Flash (đã kiểm trên API thật).
        ...(ok
          ? {}
          : { error: { code: 'generation_failed', message: 'Yêu cầu tạo nội dung thất bại.' } }),
      },
    });
  }
  if (req.method === 'POST') {
    const id = req.headers['idempotency-key'];
    const b = JSON.parse(raw);
    if (!gens.has(id)) {
      const kind = req.url.includes('/google/') ? 'image' : 'video';
      gens.set(id, { kind, index: kind === 'video' ? sent.length : -1 });
      if (kind === 'video') sent.push(String(b.prompt || ''));
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
await new Promise(r => srv.listen(17796, '127.0.0.1', r));

const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    SEEDVIS_API_KEY: '',
    MV_PORT: '17795',
    MV_ORBIT_URL: 'http://127.0.0.1:1',
    MV_SEEDVIS_URL: API,
    MV_SEEDVIS_POLL_MS: '20',
    MV_SEEDVIS_TIMEOUT_MS: '2000',
    // Máy có Claude Code thì bước AI tự chọn nó — tức là chạy test sẽ trừ quota gói Claude thật
    // của người dùng. Tắt đi để bước AI đi qua "extension" giả bên dưới.
    MV_CLAUDE_BIN: 'none',
    MV_DATA_DIR: dir,
  },
  stdio: 'pipe',
});
const api = async (p, method = 'GET', b) => {
  const r = await fetch('http://127.0.0.1:17795' + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const state = async () => (await api('/api/state')).data;
const node = async id => (await state()).nodes.find(n => n.id === id);
const settle = async (test, ms = 8000) => {
  for (let i = 0; i < ms / 50; i++) {
    if (await test()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
};

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch('http://127.0.0.1:17795/api/state')).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // Dựng đúng tình huống: một shot chạy từ ảnh keyframe, hai nhân vật có anchors, và thoại
  // của người thứ hai nằm trong văn xuôi videoPrompt.
  let r = await api('/api/director/build', 'POST', {
    blueprint: JSON.stringify({
      project: { name: 'Doctor', theme: 'drama' },
      style: 'Cinematic 35mm photorealistic',
      assets: [
        {
          key: 'vo',
          role: 'character',
          name: 'Người vợ',
          code: 'NV2',
          identity_label: 'the younger woman',
          physical_anchors: [
            'Vietnamese woman, 30 years old',
            'oval face',
            'dark-brown almond eyes',
          ],
          voice_profile: 'female, around 30, clear bright mid-register',
          prompt: 'model sheet',
        },
        {
          key: 'chong',
          role: 'character',
          name: 'Người chồng',
          code: 'NV3',
          identity_label: 'the younger man',
          physical_anchors: ['Vietnamese man, 33 years old', 'short neat black hair'],
          voice_profile: 'male, around 33, low warm mid-register',
          prompt: 'model sheet',
        },
        { key: 'phong', role: 'scene', name: 'Phòng ngủ', prompt: 'bedroom' },
      ],
      shots: [
        {
          name: 'Doi thoai',
          start: 0,
          duration: 8,
          uses: ['vo', 'chong', 'phong'],
          dialogue: 'NV2: Chín giờ sáng. Mẹ tự cất tiền vào tủ thờ.',
          videoPrompt:
            'NV2 raises the phone. NV3\'s mouth articulates the line in perfect lip-sync: "Mẹ... thế là sao?" Finish on NV3 in disbelief.',
        },
      ],
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  const shot = r.data.nodes.find(n => n.name === 'Doi thoai');
  assert.ok(shot, 'có shot');

  // Shot phải có ảnh keyframe của chính nó — đó là đường duy nhất prompt chèn mô tả ngoại
  // hình. Tạo ảnh thật qua đúng hàng đợi (bản API giả luôn cho ảnh qua).
  await api('/api/node', 'PATCH', { id: shot.id, videoInput: 'self' });
  // Ảnh khung của shot chỉ chạy khi các node nối vào đã có ảnh: làm nhân vật + bối cảnh trước.
  for (const a of (await state()).nodes.filter(
    n => !n.terminal && !n.imageInputs && n.kind !== 'setting',
  )) {
    const q = await api('/api/jobs', 'POST', { nodeId: a.id, kind: 'image' });
    assert.equal(q.status, 201, a.name + ': ' + JSON.stringify(q.data));
    assert.ok(await settle(async () => !!(await node(a.id))?.image), a.name + ' có ảnh');
  }
  const imgJob = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'image' });
  assert.equal(imgJob.status, 201, JSON.stringify(imgJob.data));
  assert.ok(await settle(async () => !!(await node(shot.id))?.image), 'shot đã có ảnh keyframe');

  let before = (await node(shot.id)).resolvedPrompts.video;
  assert.match(before, / In it: /, 'prompt gốc có khối mô tả ngoại hình');
  assert.match(before, /30 years old/, 'và tả cả tuổi');
  assert.match(before, /is spoken by .* only; everyone else stays silent/, 'và câu "chỉ X nói"');
  assert.ok(!/fictional/i.test(before), 'và KHÔNG có câu nhân vật hư cấu');
  assert.ok(!/Voice lock for NV3/.test(before), 'NV3 nói nhưng chưa được khoá giọng');

  // --- Thang leo 5 lượt, chạy thật qua đúng hàng đợi --------------------------------------
  // Bản API giả từ chối MỌI lượt video, nên thang phải leo hết các bước rồi mới dừng.
  const videoCount = () => submitsVideo().length;
  const run = async () => {
    const q = await api('/api/jobs', 'POST', { nodeId: shot.id, kind: 'video', count: 1 });
    assert.equal(q.status, 201, JSON.stringify(q.data));
    return q.data.job.id;
  };
  const settleJob = async id =>
    settle(async () =>
      ['failed', 'needs_review'].includes((await state()).jobs.find(j => j.id === id)?.status),
    );

  // Một "extension ChatGPT" đang bật suốt — như khi người dùng mở sẵn extension. Nó chỉ nhận
  // job kind:'text' (không đụng job video) và trả lời: viết lại gọn hơn nhưng GIỮ NGUYÊN mọi
  // câu thoại — đúng điều kiện acceptAiRewrite đòi.
  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const authed = async (p, b) => {
    const r = await fetch('http://127.0.0.1:17795' + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(b),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  let aiAsked = null;
  const probe = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
  assert.equal(probe.status, 200, 'extension giả đăng nhập được: ' + JSON.stringify(probe.data));
  const pump = setInterval(async () => {
    try {
      const c = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
      const job = c.data?.job;
      if (!job) return;
      aiAsked = job.payload.prompt;
      const src = job.payload.prompt.split('PROMPT BỊ TỪ CHỐI:')[1] || '';
      const lines = [...src.matchAll(/["“]([^"”]{2,300})["”]/g)].map(m => m[1]);
      const rewritten =
        'A quiet bedroom scene, 8 seconds, vertical. ' +
        lines.map(l => `Someone says: "${l}".`).join(' ') +
        ' The people are original fictional AI-generated characters, not real people.';
      await authed('/api/worker/complete', { id: job.id, lease: job.lease, text: rewritten });
    } catch {}
  }, 150);

  // Lượt 1: gửi nguyên văn.
  const before1 = (await node(shot.id)).resolvedPrompts.video;
  assert.match(before1, / In it: /, 'prompt gốc có khối mô tả ngoại hình');
  assert.ok(!/fictional/i.test(before1), 'và chưa có câu nhân vật hư cấu');
  assert.equal(videoCount(), 0, 'chưa gửi lượt nào');
  await settleJob(await run());

  // Sau lần từ chối thứ 1 → bước "gửi lại nguyên văn": lượt 2 đi ra, prompt KHÔNG đổi.
  assert.ok(await settle(() => videoCount() >= 2), 'tự gửi lại lượt 2');
  assert.equal(submitsVideo()[1], submitsVideo()[0], 'lượt 2 gửi đúng prompt cũ, chưa sửa gì');
  // (Không kiểm trạng thái node ở đây: thang leo tự chạy tiếp rất nhanh, lúc đọc có thể đã
  // sang bước sau. Thứ thật sự đã gửi đi — so ở trên — mới là bằng chứng.)
  assert.ok(!/fictional/i.test(submitsVideo()[1]), 'lượt 2 chưa có câu hư cấu: chưa sửa gì');

  // Sau lần thứ 2 → bước "tool sửa": lượt 3 mang prompt đã sửa.
  assert.ok(await settle(() => videoCount() >= 3, 15000), 'tự gửi lại lượt 3');
  const n = await node(shot.id);
  assert.equal(n.promptFix.noAnchors, true, 'bỏ mô tả ngoại hình');
  assert.equal(n.promptFix.fiction, true, 'thêm nhãn hư cấu');
  assert.equal(n.promptFix.dropExclusive, true, 'bỏ câu "chỉ X nói"');
  assert.deepEqual(n.promptFix.voices, ['NV2', 'NV3'], 'ghi cả hai người nói');
  const sent3 = submitsVideo()[2];
  assert.ok(!/30 years old/.test(sent3), 'lượt 3: hết tả tuổi');
  assert.match(sent3, /fictional/i, 'lượt 3: có câu nhân vật hư cấu');
  assert.ok(
    !/is spoken by .* only; everyone else stays silent/.test(sent3),
    'lượt 3: hết mâu thuẫn',
  );
  assert.match(sent3, /Voice lock for NV3/, 'lượt 3: khoá giọng cả NV3');
  // Bước này mới chỉ bật CỜ: prompt vẫn sinh lại từ node.
  assert.match(
    (await node(shot.id)).resolvedPrompts.video,
    /raises the phone/,
    'prompt vẫn sinh ra từ videoPrompt của node',
  );

  // Sau lần thứ 3 → bước AI. Không có API key, nhưng "extension" (bật từ đầu, ở trên) đang
  // online nên tool chạy AI qua đó: đẩy ra một job kind:'text' và chờ — đúng runViaExtension.
  const gotAi = await settle(async () => !!(await node(shot.id))?.promptFix?.aiPrompt, 25000);
  if (!gotAi) {
    const jv = (await state()).jobs.filter(x => x.kind === 'video');
    console.log('DEBUG:', jv.map(x => x.status + ' | ' + x.progress).join(' || '));
  }
  assert.ok(gotAi, 'bước AI đã chạy và ghi bản viết lại lên node');
  assert.match(aiAsked || '', /BỘ LỌC/, 'AI được đưa đúng nhiệm vụ sửa prompt bị từ chối');
  assert.match(
    aiAsked || '',
    /tạo nội dung thất bại.*generation_failed/,
    'và được cho biết lý do model trả về — cả câu lẫn MÃ lỗi (trước đây mã bị vứt)',
  );
  const ai = (await node(shot.id)).promptFix.aiPrompt;
  // Bất biến: mọi câu thoại trong ngoặc kép mà AI NHẬN được đều phải còn nguyên trong bản viết
  // lại. (Thoại NV2 ở đây nằm ở trường `lyric`, không có trong prompt video, nên không tính.)
  const quoted = s => [...String(s).matchAll(/["“]([^"”]{2,300})["”]/g)].map(m => m[1].trim());
  const asked = quoted((aiAsked || '').split('PROMPT BỊ TỪ CHỐI:')[1]);
  assert.ok(asked.length >= 1, 'AI nhận được ít nhất một câu thoại để giữ');
  for (const line of asked) assert.ok(ai.includes(line), 'bản AI giữ nguyên: ' + line);
  assert.match(ai, /thế là sao/, 'cụ thể: câu thoại của NV3 còn nguyên');
  // Bản AI thay cả prompt: đây là bước ĐẦU TIÊN đóng băng chữ.
  assert.equal((await node(shot.id)).resolvedPrompts.video, ai, 'prompt video = bản AI viết lại');
  assert.ok(await settle(() => videoCount() >= 4, 15000), 'lượt 4 đi ra với bản AI');
  assert.equal(submitsVideo()[3], ai, 'lượt 4 gửi đúng bản AI đã viết lại');

  // Sau lần thứ 4 → bước lưới ảnh (chưa bật): tool nói thẳng chứ không im lặng.
  const stopped = await settle(async () => {
    const jv = (await state()).jobs.filter(x => x.kind === 'video');
    return /lưới|xem lại ẢNH/i.test(jv.at(-1)?.progress || '');
  }, 20000);
  assert.ok(stopped, 'tới bước cuối thì báo rõ trạng thái, không im lặng');
  clearInterval(pump);

  // Sổ học: luật được ghi ra thư mục dữ liệu, dùng chung cho mọi project.
  const rules = JSON.parse(fs.readFileSync(path.join(dir, 'learned-rules.json'), 'utf8'));
  assert.deepEqual(
    rules.map(x => x.key).sort(),
    ['dropExclusive', 'fiction', 'noAnchors'],
    'ba bài học được ghi',
  );
  assert.ok(
    rules.every(x => x.rule.length > 40 && x.count >= 1),
    'mỗi bài học là một câu luật đọc được, có số lần gặp',
  );

  // --- Đường thứ hai: video chạy qua EXTENSION ----------------------------------------------
  // Job extension hỏng ở /api/worker/fail, không đi qua runJob — bác sĩ phải được gọi ở cả hai
  // đường, nếu không người dùng chạy Google Vids / Muse sẽ không bao giờ thấy tự sửa.
  {
    const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
    const authed = async (p, b) => {
      const r = await fetch('http://127.0.0.1:17795' + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(b),
      });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    const ext = (await api('/api/nodes', 'POST', { name: 'VidsShot' })).data.nodes.at(-1);
    await api('/api/node', 'PATCH', {
      id: ext.id,
      seedvis: { video: false },
      gvids: { video: true },
      videoPrompt: 'NV2 nói, rồi NV3 đáp: "Sao cơ?"',
    });
    for (let i = 1; i <= 3; i++) {
      const q = await api('/api/jobs', 'POST', { nodeId: ext.id, kind: 'video' });
      assert.equal(q.status, 201, JSON.stringify(q.data));
      const c = await authed('/api/worker/claim', { name: 'gvids', kinds: ['video'] });
      assert.ok(c.data?.job, 'extension nhận được job lượt ' + i);
      const f = await authed('/api/worker/fail', {
        id: c.data.job.id,
        lease: c.data.job.lease,
        error: 'Google Vids: bộ lọc an toàn từ chối nội dung này',
      });
      assert.equal(f.status, 200, JSON.stringify(f.data));
      assert.equal(f.data.status, 'failed', 'chưa gửi đi nên là failed, không phải needs_review');
      const n2 = await node(ext.id);
      if (i < 3) assert.equal(n2.rejects, i, `đếm ${i} lần qua đường extension`);
    }
    const extFixed = await node(ext.id);
    assert.ok(extFixed.promptFix?.fiction, 'đường extension cũng leo thang và sửa được prompt');
    assert.ok(extFixed.fixLog?.length, 'và ghi lại từng bước');
  }

  // Đường lui: gỡ bản sửa thì prompt quay lại đúng như cũ và node được sửa lại từ đầu.
  const undone = await api('/api/node', 'PATCH', { id: shot.id, promptFix: null });
  assert.equal(undone.status, 200, JSON.stringify(undone.data)?.slice(0, 200));
  const back = await node(shot.id);
  assert.ok(!back.promptFix, 'bản sửa đã gỡ');
  assert.equal(back.fixRounds, 0, 'số vòng sửa reset để node được tự sửa lại');
  assert.ok(!back.rejects, 'bộ đếm cũng reset');
  assert.match(back.resolvedPrompts.video, / In it: /, 'prompt quay lại như trước khi sửa');
  assert.ok(!/fictional/i.test(back.resolvedPrompts.video), 'và hết câu nhân vật hư cấu');
  // Đặt cờ bằng tay thì không được — chỉ bác sĩ mới đặt, sau khi bị từ chối thật.
  await api('/api/node', 'PATCH', { id: shot.id, promptFix: { fiction: true } });
  assert.ok(!(await node(shot.id)).promptFix, 'không bật cờ sửa bằng tay qua API');

  // Chạy được một lần thì bộ đếm liên tiếp phải về 0 (lỗi cũ không cộng dồn với lỗi mới).
  allowFrom = sent.length;
  const okId = await run();
  const good = await settle(
    async () => (await state()).jobs.find(j => j.id === okId)?.status === 'completed',
    20000,
  );
  const okJob = (await state()).jobs.find(j => j.id === okId);
  assert.ok(
    good,
    'khi model cho qua thì job xong — ' + JSON.stringify(okJob?.error || okJob?.status),
  );
  assert.ok(!(await node(shot.id)).rejects, 'chạy được → xoá bộ đếm bị từ chối');

  console.log(
    `PASS: tự sửa prompt — phân biệt bị-từ-chối với lỗi mạng/quota, tìm đúng nhiều người nói, ` +
      `chẩn đoán 3 lỗi thật (mô tả ngoại hình, thiếu nhãn hư cấu, mâu thuẫn "chỉ X nói"), ` +
      `thang leo ${MAX_ATTEMPTS} lượt (${STEPS.map(x => x.kind).join(' → ')}), AI viết lại qua extension ` +
      `giữ nguyên thoại, ghi sổ học dùng chung, và chạy được thì xoá bộ đếm`,
  );
} finally {
  proc.kill();
  srv.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
