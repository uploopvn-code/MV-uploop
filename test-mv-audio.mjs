// MV có FILE NHẠC: node Nhạc → node Kịch bản. Máy đo bài thật (Demucs tách vocal + đường năng
// lượng), dựng khung đã khoá giây; xưởng giữ nguyên các trạm sáng tạo nhưng bước cuối chỉ ĐIỀN
// vào khung; đầu ra là bảng CSV nhập thẳng vào bộ dựng hai luồng.
//
// Chạy THẬT: file WAV thật sinh ra ở đây, Demucs thật (mv_profile.py), server thật. LLM do một
// "extension" giả trả lời đúng hợp đồng worker kind:'text' — nó đọc khung CSV trong prompt và điền
// các cột sáng tạo, như ChatGPT thật làm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stages } from './lib/script-studio.mjs';

// --- WAV thật: 24 giây, hai đoạn to/nhỏ để đường năng lượng có hình --------------------------
function wav(seconds, rate = 22050) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const loud = t % 12 < 6 ? 0.15 : 0.6; // nhỏ 6s rồi to 6s
    const v = Math.sin(2 * Math.PI * 220 * t) * 0.6 + Math.sin(2 * Math.PI * 330 * t) * 0.4;
    data.writeInt16LE(Math.round(v * loud * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const LYRICS = [
  '[Verse 1]',
  'Donde el mar recuerda tu nombre',
  'y el viento aún canta por ti',
  '[Chorus]',
  'no me sueltes todavía',
  'que la noche no termina aquí',
].join('\n');

// What the treatment station answers: prose + the ```cast block the fill step and the build read.
const CAST = {
  singer: 'Abuela',
  people: [
    {
      name: 'Abuela',
      look: 'Latina woman about 68, small frame, silver hair in a loose bun, cream cardigan, chestnut wool shawl',
      identity_label: 'the silver-haired grandmother',
      back_view: 'silver bun, chestnut shawl over narrow shoulders',
    },
    { name: 'Adult son', look: 'man about 40, short dark hair, grey pyjama shirt' },
  ],
  places: [
    { name: "Grandmother's bedroom", look: 'small bedroom, bedside lamp, window to a dark courtyard' },
    { name: 'Porch at night', look: 'tiled porch, potted plants, one small yellow lamp, deep blue sky' },
  ],
  lipsync_place: "Grandmother's bedroom",
};
const TREATMENT =
  'Treatment: một người bà đi quanh nhà cầu nguyện trước khi ngủ.\n\n```cast\n' +
  JSON.stringify(CAST) +
  '\n```';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-audio-'));
const PORT = 17811;
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
const node = async id => (await state()).nodes.find(n => n.id === id);
const settle = async (test, ms) => {
  for (let i = 0; i < ms / 200; i++) {
    if (await test()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
};

// Điền các cột sáng tạo của một khung CSV — đúng việc LLM thật làm ở bước này.
const SIZES = ['WS', 'MS', 'CU', 'EWS', 'MCU'];
const ANGLES = ['eye level', 'low', '3/4', 'high', 'profile'];
function fillCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  const idx = k => head.indexOf(k);
  return [
    lines[0],
    ...lines.slice(1).map((line, i) => {
      // khung chỉ có ô trống hoặc giá trị đơn giản; giữ nguyên cột khoá, điền cột sáng tạo
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, ''));
      while (cells.length < head.length) cells.push('');
      const lyric = (cells[idx('Lyric')] || '').replace(/^"|"$/g, '').trim();
      // the treatment's own people + places (a narrative MV, not a band on a stage)
      cells[idx('Subject')] = ['Abuela', 'Abuela + Adult son', 'Candle', 'Adult son'][i % 4];
      cells[idx('Location')] = i ? '"Porch at night"' : '"Grandmother\'s bedroom"';
      cells[idx('Shot Size')] = SIZES[i % SIZES.length];
      cells[idx('Angle')] = ANGLES[i % ANGLES.length];
      cells[idx('Camera Movement')] = 'slow push-in';
      cells[idx('Emotion')] = '"calm — relaxed shoulders; slow breath"';
      cells[idx('Action')] = '"Abuela folds her hands under the warm lamp."';
      cells[idx('Vocal Delivery')] = lyric ? '"aching, restrained — soft voice"' : '';
      return cells.slice(0, head.length).join(',');
    }),
  ].join('\n');
}

try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // --- Node Nhạc có file thật + lời ---------------------------------------------------------
  let r = await api('/api/nodes', 'POST', { kind: 'music', name: 'Bài hát' });
  assert.equal(r.status, 201, JSON.stringify(r.data)?.slice(0, 200));
  const musicId = r.data.nodes.find(n => n.kind === 'music').id;
  r = await api('/api/node', 'PATCH', { id: musicId, lyrics: LYRICS });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  r = await api('/api/upload', 'POST', {
    nodeId: musicId,
    kind: 'audio',
    mime: 'audio/wav',
    name: 'bajo-tu-proteccion.wav',
    base64: wav(24).toString('base64'),
  });
  assert.equal(r.status, 200, 'tải file nhạc: ' + JSON.stringify(r.data)?.slice(0, 200));

  // --- Node Kịch bản nối vào ----------------------------------------------------------------
  r = await api('/api/nodes', 'POST', { kind: 'script', name: 'Kịch bản' });
  const scriptId = r.data.nodes.find(n => n.kind === 'script').id;
  const edges = (await state()).edges;
  await api('/api/edges', 'PUT', { edges: [...edges, { source: musicId, target: scriptId }] });
  await api('/api/node', 'PATCH', {
    id: scriptId,
    brief: { idea: 'MV sân khấu nhỏ, ballad Tây Ban Nha, một ca sĩ và một tay guitar' },
  });

  let s = await node(scriptId);
  assert.equal(s.studioKind, 'mvaudio', 'có file nhạc → chế độ mvaudio');
  assert.deepEqual(
    s.runStages.map(x => x[0]),
    stages('fast', 'mvaudio').map(x => x.key),
    'trạm: treatment + điền khung (không còn "chia mốc giây" + "ráp JSON")',
  );
  assert.match(s.runStages.at(-1)[1], /Điền khung/, 'bước cuối là điền khung đã đo');

  // Chế độ Kỹ giữ đủ các trạm sáng tạo.
  await api('/api/node', 'PATCH', { id: scriptId, mode: 'full' });
  assert.deepEqual(
    (await node(scriptId)).runStages.map(x => x[0]),
    ['story', 'look', 'faces', 'shots'],
    'Kỹ: treatment → hình ảnh → biểu cảm → điền khung',
  );
  await api('/api/node', 'PATCH', { id: scriptId, mode: 'fast' });

  // --- "Extension" trả lời các trạm ---------------------------------------------------------
  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const authed = async (p, b) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(b),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const asked = [];
  const probe = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
  assert.equal(probe.status, 200, 'extension giả đăng nhập được');
  const pump = setInterval(async () => {
    try {
      const c = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
      const job = c.data?.job;
      if (!job) return;
      const prompt = job.payload.prompt;
      asked.push(prompt);
      const block = prompt.match(/```csv\n([\s\S]*?)\n```/);
      const text = block
        ? '```csv\n' + fillCsv(block[1]) + '\n```'
        : TREATMENT;
      await authed('/api/worker/complete', { id: job.id, lease: job.lease, text });
    } catch {}
  }, 150);

  // --- Chạy xưởng: tự ĐO bài trước --------------------------------------------------------
  r = await api('/api/script/run', 'POST', {
    id: scriptId,
    mode: 'fast',
    via: 'web',
    autoBuild: false,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  const labels = new Set();
  const done = await settle(async () => {
    const x = await node(scriptId);
    if (x?.run?.label) labels.add(x.run.label);
    return ['done', 'failed'].includes(x?.run?.status);
  }, 300000);
  clearInterval(pump);
  s = await node(scriptId);
  assert.ok(done, 'xưởng chạy xong: ' + JSON.stringify(s?.run));
  assert.notEqual(s.run.status, 'failed', 'không lỗi: ' + (s.run.error || ''));
  assert.ok(
    [...labels].some(l => /Đo bài hát/.test(l)),
    'có bước đo bài hát: ' + [...labels].join(' | '),
  );

  // Đo THẬT: thời lượng đúng 24 giây, có vocal tách ra, có khung.
  const m = await node(musicId);
  assert.ok(m.measured, 'node Nhạc lưu kết quả đo');
  assert.ok(
    Math.abs(m.measured.total - 24) < 1.5,
    'đo đúng thời lượng thật ~24s: ' + m.measured.total,
  );
  assert.ok(m.vocals, 'Demucs đã tách vocal (luồng hát nhép cắt từ đây)');
  assert.ok(m.measured.rows.length >= 3, 'có khung shot: ' + m.measured.rows.length + ' ô');

  // Các trạm sáng tạo đọc được số đo THẬT, không phải "chưa phân tích".
  const treatmentAsk = asked.find(p => !/```csv/.test(p));
  assert.match(treatmentAsk, /TOOL ĐÃ ĐO TỪ AUDIO THẬT/, 'treatment được báo đây là số đo thật');
  assert.match(treatmentAsk, /Thời lượng: 24 giây/, 'treatment biết đúng thời lượng');
  assert.ok(!/chưa phân tích/.test(treatmentAsk), 'không còn "(node nhạc chưa phân tích)"');

  // Bước điền nhận HƯỚNG SÁNG TẠO (treatment) + KHUNG đã khoá giây.
  const fillAsk = asked.find(p => /```csv/.test(p));
  assert.ok(fillAsk, 'có lượt điền khung');
  assert.match(fillAsk, /TUYỆT ĐỐI không đổi Start\/End/, 'được dặn không đổi mốc giây');
  assert.match(fillAsk, /TREATMENT \(trạm ①\)/, 'mang theo treatment của trạm ①');
  assert.match(fillAsk, /ballad Tây Ban Nha/, 'mang theo brief/skill');
  // Subject / Location theo dàn của treatment — không còn ép về ban nhạc trên một sân khấu.
  assert.match(fillAsk, /CHỈ dùng tên trong dàn của treatment: "Abuela", "Adult son"/);
  assert.match(fillAsk, /Location: điền ĐÚNG một tên bối cảnh của treatment/);
  assert.ok(!/Dim concert hall stage/.test(fillAsk), 'khung không còn khoá sân khấu mặc định');
  assert.ok(s.mvCsv.includes('Porch at night'), 'bảng giữ bối cảnh của treatment');
  // Tên đoạn đọc từ lời: [Verse 1] / [Chorus] → Verse 1 / Chorus 1 (không phải Verse 1–N).
  assert.ok(m.measured.rows.some(r2 => r2.Section === 'Chorus 1'), 'đoạn Chorus đọc đúng');

  // Đầu ra: bảng CSV, mốc giây KHỚP khung đã đo (LLM không được dời).
  assert.ok(s.mvCsv, 'node Kịch bản giữ bảng CSV đã điền');
  const startCol = s.mvCsv.split(/\r?\n/)[0].split(',').indexOf('Start');
  const starts = s.mvCsv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(l => l.split(',')[startCol]);
  assert.deepEqual(
    starts,
    m.measured.rows.map(r2 => r2.Start),
    'mốc giây trong bảng đúng y khung đã đo',
  );
  assert.ok(s.qc, 'có kết quả QC của khung');

  // --- Đo một lần: chạy lại không chạy Demucs lại -------------------------------------------
  const firstAt = m.measured.at;
  let castAsked = 0;
  const pump2 = setInterval(async () => {
    try {
      const c = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
      const job = c.data?.job;
      if (!job) return;
      const block = job.payload.prompt.match(/```csv\n([\s\S]*?)\n```/);
      // treatment 2 has NO cast block (as one written before the rule): the fill step asks for
      // the block alone, and gets it
      const castAsk = /chỉ trả về khối cast/.test(job.payload.prompt);
      if (castAsk) castAsked++;
      await authed('/api/worker/complete', {
        id: job.id,
        lease: job.lease,
        text: block
          ? '```csv\n' + fillCsv(block[1]) + '\n```'
          : castAsk
            ? '```cast\n' + JSON.stringify(CAST) + '\n```'
            : 'Treatment 2.',
      });
    } catch {}
  }, 150);
  r = await api('/api/script/run', 'POST', {
    id: scriptId,
    mode: 'fast',
    via: 'web',
    restart: true,
    autoBuild: false,
  });
  assert.equal(r.status, 200);
  assert.ok(
    await settle(async () => (await node(scriptId))?.run?.status === 'done', 60000),
    'chạy lại xong',
  );
  clearInterval(pump2);
  assert.equal((await node(musicId)).measured.at, firstAt, 'dùng lại kết quả đo, không đo lại');
  assert.equal(castAsked, 1, 'treatment thiếu khối cast → hỏi riêng khối đó một lần');
  assert.match((await node(scriptId)).stages.story, /```cast/, 'khối cast được nối vào treatment');

  // --- Gói giao hàng xuất đúng tên bước của MV ---------------------------------------------
  // Trước đây lib/package.mjs đọc scriptNode.kind === 'mv' — luôn sai (kind là 'script'), nên
  // project MV bị xuất tên bước của drama.
  const plan = await api('/api/package/plan');
  assert.equal(plan.status, 200, JSON.stringify(plan.data)?.slice(0, 200));
  const kb = plan.data.entries.filter(e => e.startsWith('kich-ban/'));
  assert.ok(
    kb.some(e => /dien-khung/.test(e)),
    'gói có bước "điền khung" của MV: ' + kb.join(', '),
  );
  assert.ok(
    !kb.some(e => /truc-blocking|bien-kich/.test(e)),
    'không còn tên bước của drama: ' + kb.join(', '),
  );

  // --- Dựng: bộ hai luồng + DÀN NHÂN VẬT của treatment -------------------------------------
  r = await api('/api/script/build', 'POST', { id: scriptId });
  assert.equal(r.status, 200, 'Dựng MV qua bộ hai luồng: ' + JSON.stringify(r.data)?.slice(0, 300));
  {
    const st = await state();
    const by = name => st.nodes.find(n => n.name === name);
    const lead = by('Abuela (ca sĩ)');
    assert.ok(lead && lead.zone === 'character', 'người hát chính thành node nhân vật');
    assert.ok(lead.lead, 'được đánh dấu là ca sĩ chính');
    assert.match(lead.desc, /silver hair/, 'ngoại hình lấy từ treatment');
    assert.equal(st.nodes.filter(n => n.lead).length, 1, 'chỉ một ca sĩ chính');
    const son = by('Adult son');
    const porch = by('Porch at night');
    assert.ok(son && porch && porch.zone === 'design', 'nhân vật phụ + bối cảnh của treatment');
    const shots = st.nodes.filter(n => !n.terminal && n.zone === 'production');
    const inputs = n => st.edges.filter(e => e.target === n.id).map(e => e.source);
    const both = shots.find(n => (n.parts || []).some(p => p.subject === 'Abuela + Adult son'));
    assert.ok(both, 'có shot hai người');
    assert.ok(
      inputs(both).includes(lead.id) && inputs(both).includes(son.id),
      '"Abuela + Adult son" nối CẢ HAI người, không chỉ người đầu',
    );
    assert.ok(
      shots.some(n => inputs(n).includes(porch.id)),
      'shot nối đúng bối cảnh của treatment',
    );
    assert.equal((await node(musicId)).mvCast?.lipsyncPlace, "Grandmother's bedroom");
  }

  s = await node(scriptId);
  r = await api('/api/music/import', 'POST', {
    id: musicId,
    csv: s.mvCsv,
    replaceShots: true,
    autoWire: true,
    takes: true,
  });
  assert.equal(
    r.status,
    200,
    'bộ dựng hai luồng nhận bảng: ' + JSON.stringify(r.data)?.slice(0, 300),
  );
  const st = await state();
  const coverage = st.nodes.filter(n => !n.terminal && n.zone === 'production');
  assert.ok(coverage.length >= 3, 'luồng A (phủ cảnh) có shot: ' + coverage.length);
  assert.ok(
    st.nodes.find(n => n.id === musicId),
    'node Nhạc còn',
  );
  assert.ok(
    st.nodes.find(n => n.id === scriptId),
    'node Kịch bản còn',
  );
  // Luồng B (hát nhép) cắt theo câu hát được căn trên vocal THẬT. File thử là âm thuần, không có
  // giọng hát → máy căn lời không tìm thấy chữ nào, nên luồng B rỗng là ĐÚNG ở đây.
  const takes = st.nodes.filter(n => !n.terminal && n.role === 'lipsync');
  console.log(
    `PASS: MV có file nhạc — chế độ mvaudio (treatment + điền khung), Demucs đo thật bài 24s, ` +
      `tách vocal, ${m.measured.rows.length} ô khung khoá giây; trạm sáng tạo đọc số đo thật thay ` +
      `vì "chưa phân tích"; bước điền giữ đúng mốc giây; đo một lần dùng lại; dựng qua bộ hai luồng ` +
      `(luồng A ${coverage.length} shot, luồng B ${takes.length} take — âm thử không có giọng hát)`,
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
