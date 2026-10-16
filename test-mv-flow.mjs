// Luồng MV: nối node Nhạc → node Kịch bản, xưởng chuyển sang các trạm MV, chạy hết rồi dựng
// ra project MV sân khấu. Chạy thật qua server; LLM do một "extension" giả trả lời đúng hợp
// đồng worker thật (job kind:'text'), nên mọi đoạn code của tool đều là code thật.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stages } from './lib/script-studio.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-flow-'));
const PORT = 17807;
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
const settle = async (test, ms = 30000) => {
  for (let i = 0; i < ms / 100; i++) {
    if (await test()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
};

// Blueprint MV sân khấu, ballad Tây Ban Nha — thứ trạm ⑥ phải trả về.
const BLUEPRINT = {
  project: { name: 'Donde el Mar Recuerda', theme: 'music' },
  style:
    'Cinematic 35mm photorealistic live concert, warm amber stage wash, haze, shallow depth of field',
  assets: [
    {
      key: 'ca_si',
      role: 'character',
      name: 'Ca sĩ',
      code: 'NV1',
      identity_label: 'the dark-haired singer',
      physical_anchors: ['Spanish woman, late 20s', 'long dark wavy hair', 'deep brown eyes'],
      voice_profile: 'female, late 20s, warm low alto, Castilian Spanish, restrained and aching',
      prompt: 'model sheet turnaround of a singer',
    },
    {
      key: 'guitar',
      role: 'character',
      name: 'Guitarist',
      code: 'NV2',
      identity_label: 'the flamenco guitarist',
      physical_anchors: ['Spanish man, 40s', 'short grey-flecked beard'],
      prompt: 'model sheet turnaround of a flamenco guitarist',
    },
    { key: 'san_khau', role: 'scene', name: 'Sân khấu', prompt: 'intimate concert stage, haze' },
  ],
  cameras: [
    { key: 'wide', name: 'Toàn sân khấu', config: 'wide establishing, slow push-in' },
    { key: 'close', name: 'Cận ca sĩ', config: '85mm close-up, eye level' },
  ],
  shots: [
    {
      name: 'S01 — Mở màn',
      start: 0,
      duration: 8,
      uses: ['ca_si', 'san_khau'],
      camera: 'wide',
      lyric: 'Donde el mar recuerda tu nombre',
      videoPrompt: 'she steps into the light',
    },
    {
      name: 'S02 — Guitar vào',
      start: 8,
      duration: 8,
      uses: ['guitar', 'san_khau'],
      camera: 'wide',
      lyric: 'y el viento aún canta por ti',
      videoPrompt: 'he begins the figure',
    },
    {
      name: 'S03 — Cận',
      start: 16,
      duration: 8,
      uses: ['ca_si', 'san_khau'],
      camera: 'close',
      lyric: 'no me sueltes todavía',
      videoPrompt: 'she closes her eyes',
    },
  ],
};

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // --- 1) Hai node mở đầu, cùng ở cột ⓪ START -----------------------------------------------
  let r = await api('/api/nodes', 'POST', { kind: 'music', name: 'Bài hát' });
  assert.equal(r.status, 201, JSON.stringify(r.data)?.slice(0, 200));
  const music = r.data.nodes.find(n => n.kind === 'music');
  r = await api('/api/nodes', 'POST', { kind: 'script', name: 'Kịch bản' });
  assert.equal(r.status, 201, JSON.stringify(r.data)?.slice(0, 200));
  const script = r.data.nodes.find(n => n.kind === 'script');
  assert.equal(music.zone, 'start', 'node Nhạc ở cột START');
  assert.equal(script.zone, 'start', 'node Kịch bản ở cột START');

  // --- 2) CHƯA nối: xưởng chạy các trạm DRAMA ------------------------------------------------
  let s = await node(script.id);
  assert.deepEqual(
    s.runStages.map(x => x[0]),
    stages('fast', 'drama').map(x => x.key),
    'chưa nối nhạc thì là trạm drama',
  );
  assert.ok(!s.runStages.some(x => /MV|bài/i.test(x[1])), 'nhãn trạm chưa nhắc tới bài hát');

  // --- 3) Nối Nhạc → Kịch bản: xưởng tự chuyển sang trạm MV ----------------------------------
  const edges = (await state()).edges;
  r = await api('/api/edges', 'PUT', {
    edges: [...edges, { source: music.id, target: script.id }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  s = await node(script.id);
  assert.deepEqual(
    s.runStages.map(x => x[0]),
    stages('fast', 'mv').map(x => x.key),
    'nối nhạc vào thì chuyển sang trạm MV',
  );
  assert.match(s.runStages[0][1], /MV/, 'trạm ① đổi thành Treatment MV: ' + s.runStages[0][1]);
  assert.ok(
    s.runStages.some(x => /bài/i.test(x[1])),
    'có trạm bám theo bài hát: ' + s.runStages.map(x => x[1]).join(' | '),
  );

  // Chế độ Kỹ cũng phải theo MV, không rơi về drama.
  await api('/api/node', 'PATCH', { id: script.id, mode: 'full' });
  s = await node(script.id);
  assert.deepEqual(
    s.runStages.map(x => x[0]),
    stages('full', 'mv').map(x => x.key),
    'chế độ Kỹ + nhạc = trạm MV đầy đủ',
  );
  await api('/api/node', 'PATCH', { id: script.id, mode: 'fast' });

  // Gỡ dây thì quay lại drama — cái nối mới là thứ quyết định, không phải trạng thái dính.
  await api('/api/edges', 'PUT', { edges });
  assert.deepEqual(
    (await node(script.id)).runStages.map(x => x[0]),
    stages('fast', 'drama').map(x => x.key),
    'gỡ dây thì quay lại trạm drama',
  );
  await api('/api/edges', 'PUT', { edges: [...edges, { source: music.id, target: script.id }] });

  // --- 4) Bài hát + brief chủ đề -------------------------------------------------------------
  r = await api('/api/node', 'PATCH', {
    id: music.id,
    lyrics:
      'Donde el mar recuerda tu nombre\ny el viento aún canta por ti\nno me sueltes todavía\nque la noche no termina aquí',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));
  r = await api('/api/node', 'PATCH', {
    id: script.id,
    brief: { idea: 'MV sân khấu, ballad Tây Ban Nha, một ca sĩ và một tay guitar flamenco' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 200));

  // --- 5) "Extension" trả lời các trạm -------------------------------------------------------
  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const authed = async (p, b) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(b),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  // Một lượt claim để server ghi nhận worker là ĐANG BẬT — xưởng từ chối chạy via:'web' khi
  // chưa thấy extension nào online.
  const probe = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
  assert.equal(probe.status, 200, 'extension giả đăng nhập được: ' + JSON.stringify(probe.data));
  const asked = [];
  const pump = setInterval(async () => {
    try {
      const c = await authed('/api/worker/claim', { name: 'llm', kinds: ['text'] });
      const job = c.data?.job;
      if (!job) return;
      const prompt = job.payload.prompt;
      asked.push(prompt);
      // Trạm ráp JSON đòi một khối JSON; các trạm khác chỉ cần văn bản.
      const isAssemble = /blueprint|JSON/i.test(prompt.slice(0, 900));
      const text = isAssemble
        ? '```json\n' + JSON.stringify(BLUEPRINT, null, 2) + '\n```'
        : 'Treatment: một đêm diễn nhỏ, ballad Tây Ban Nha. Ca sĩ hát về biển và người đã đi.';
      await authed('/api/worker/complete', { id: job.id, lease: job.lease, text });
    } catch {}
  }, 120);

  // --- 6) Chạy cả xưởng ----------------------------------------------------------------------
  r = await api('/api/script/run', 'POST', { id: script.id, via: 'web' });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  const done = await settle(async () => {
    const n = await node(script.id);
    return n?.run?.status === 'done' || n?.run?.status === 'failed';
  }, 60000);
  clearInterval(pump);
  const after = await node(script.id);
  assert.ok(done, 'xưởng chạy xong, trạng thái: ' + JSON.stringify(after?.run));
  assert.notEqual(after.run.status, 'failed', 'không lỗi: ' + (after.run.error || ''));

  // Lời bài hát PHẢI tới tay các trạm — đó là lý do nối node Nhạc vào.
  assert.ok(asked.length >= 2, 'có ít nhất 2 trạm đã hỏi LLM');
  assert.ok(
    asked.some(p => p.includes('Donde el mar recuerda tu nombre')),
    'lời bài hát được đưa vào prompt của xưởng',
  );
  assert.ok(
    asked.some(p => /ballad Tây Ban Nha/i.test(p)),
    'chủ đề trong brief cũng được đưa vào',
  );

  // --- 7) Dựng ra project MV -----------------------------------------------------------------
  r = await api('/api/script/build', 'POST', { id: script.id, force: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 300));
  const st = await state();
  const byName = n => st.nodes.find(x => x.name === n);
  assert.ok(byName('Ca sĩ'), 'có node Ca sĩ');
  assert.ok(byName('Guitarist'), 'có node Guitarist');
  assert.ok(byName('Sân khấu'), 'có node Sân khấu');
  assert.equal(byName('Ca sĩ').zone, 'character', 'ca sĩ nằm ở cột Nhân vật');
  assert.equal(byName('Sân khấu').zone, 'design', 'sân khấu nằm ở cột Bối cảnh');

  const shots = st.nodes
    .filter(n => !n.terminal && 'duration' in n)
    .sort((a, b) => a.start - b.start);
  assert.equal(shots.length, 3, '3 shot');
  assert.deepEqual(
    shots.map(x => x.start),
    [0, 8, 16],
    'mốc giây bám theo bài',
  );
  assert.match(shots[0].lyric, /Donde el mar/, 'shot mang đúng câu hát của nó');
  assert.match(
    shots[0].resolvedPrompts.video,
    /Donde el mar recuerda tu nombre/,
    'prompt video nhúng lời hát đúng đoạn: ' + shots[0].resolvedPrompts.video.slice(0, 200),
  );
  assert.match(
    shots[0].resolvedPrompts.image,
    /concert|stage|haze/i,
    'prompt ảnh mang phong cách sân khấu: ' + shots[0].resolvedPrompts.image.slice(0, 120),
  );
  // DNA giọng của ca sĩ phải vào prompt video của shot cô ấy hát.
  assert.match(
    shots[0].resolvedPrompts.video,
    /Voice lock for NV1/,
    'khoá giọng ca sĩ trong shot cô ấy hát',
  );
  assert.match(
    shots[0].resolvedPrompts.video,
    /Castilian Spanish/,
    'DNA giọng mang đúng chất Tây Ban Nha',
  );

  // Node Nhạc và node Kịch bản không bị bản dựng xoá mất.
  assert.ok(
    st.nodes.find(n => n.id === music.id),
    'node Nhạc còn sau khi dựng',
  );
  assert.ok(
    st.nodes.find(n => n.id === script.id),
    'node Kịch bản còn sau khi dựng',
  );

  console.log(
    'PASS: luồng MV — Nhạc + Kịch bản cùng ở cột START, nối dây thì xưởng tự chuyển sang trạm ' +
      'MV (gỡ dây quay lại drama, chế độ Kỹ cũng theo), lời bài hát + chủ đề tới tay các trạm, ' +
      'chạy hết rồi dựng ra project MV sân khấu đúng mốc giây, có lời hát trong prompt video và ' +
      'khoá giọng ca sĩ',
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
