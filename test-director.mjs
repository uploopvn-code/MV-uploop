// Director: blueprint → full node graph with wiring, plus the LLM auto path.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildGraph, parseBlueprint } from './director.mjs';

// --- Unit: blueprint parsing + graph building (no server) ---
const bp = {
  project: { name: 'Test MV', theme: 'music' },
  style: 'Cinematic 35mm photorealistic, no CGI',
  assets: [
    { key: 'singer', role: 'character', name: 'Ca sĩ', prompt: 'singer model sheet' },
    { key: 'guitarist', role: 'character', name: 'Guitarist', prompt: 'guitarist playing' },
    { key: 'stage', role: 'scene', name: 'Sân khấu', prompt: 'wide stage' },
  ],
  cameras: [
    { key: 'wide', name: 'Wide', config: 'wide establishing shot' },
    { key: 'close', name: 'Close', config: 'macro close-up' },
  ],
  shots: [
    {
      name: 'Shot 1',
      start: 0,
      duration: 8,
      uses: ['singer', 'stage'],
      camera: 'wide',
      lyric: 'la la',
      videoPrompt: 'Pace: x. Prompt Video: y.',
    },
    {
      name: 'Shot 2',
      start: 8,
      duration: 10,
      uses: ['guitarist'],
      camera: 'close',
      videoPrompt: 'z',
    },
  ],
};
const g = buildGraph(bp);
assert.equal(g.name, 'Test MV');
const byName = n => g.nodes.find(x => x.name === n);
// Characters, scene, setup (style+cameras), shots across the 5 zones.
assert.equal(g.nodes.filter(n => n.zone === 'character').length, 2); // singer + guitarist
assert.equal(g.nodes.filter(n => n.zone === 'design').length, 1); // stage
assert.equal(g.nodes.filter(n => n.zone === 'setup').length, 3); // style + 2 cameras
assert.equal(g.nodes.filter(n => n.zone === 'production').length, 2);
assert.equal(byName('Style').kind, 'setting');
assert.equal(byName('Style').zone, 'setup');
assert.equal(byName('Ca sĩ').zone, 'character');
assert.equal(byName('Sân khấu').zone, 'design');
assert.equal(byName('Wide').settingType, 'camera');
assert.equal(byName('Ca sĩ').prompt, 'singer model sheet');
assert.equal(byName('Shot 1').videoInput, 'refs');
assert.equal(byName('Shot 2').duration, 10);
// Shot 1 wired to singer, stage, wide-camera and style.
const s1 = byName('Shot 1').id;
const parents = g.edges.filter(e => e.target === s1).map(e => e.source);
assert.ok(parents.includes(byName('Ca sĩ').id));
assert.ok(parents.includes(byName('Sân khấu').id));
assert.ok(parents.includes(byName('Wide').id));
assert.ok(parents.includes(byName('Style').id));
assert.ok(!parents.includes(byName('Guitarist').id), 'Shot 1 does not use the guitarist');
// A shot with no "prompt" gets its image prompt from the blueprint's own videoPrompt
// (composition + staging), never the project's default template fields; and the baked
// "Camera:/Style:" tail is stripped so the wired setting nodes are the single source.
const baked = buildGraph({
  project: { name: 'Baked', theme: 'music' },
  style: 'Kodak Vision3, teal-orange, no CGI',
  assets: [{ key: 'singer', role: 'character', name: 'Ca sĩ', prompt: 'ref singer' }],
  cameras: [{ key: 'close', name: 'Close', config: 'Tight emotional close-up on face.' }],
  shots: [
    {
      name: 'S1',
      duration: 8,
      uses: ['singer'],
      camera: 'close',
      videoPrompt:
        'Compose the connected reference images into one coherent shot. Preserve the referenced subjects. @singer center stage. Camera: Tight emotional close-up on face. Style: Kodak Vision3, teal-orange, no CGI, 16:9, no text.',
    },
  ],
});
const bshot = baked.nodes.find(n => n.name === 'S1');
assert.ok(
  /^Compose the connected reference images/.test(bshot.prompt),
  'image prompt from blueprint',
);
assert.ok(!/Camera:/i.test(bshot.prompt), 'baked Camera: stripped from the shot prompt');
assert.ok(!/Burgundy|wavy hair|polished wooden/i.test(bshot.prompt), 'no default-template leakage');

// Drama (Google VEO) blueprint: project.title, role:"prop", self-contained videoPrompt.
const drama = buildGraph({
  project: { title: 'Bẫy Ngầm (The Trap)', country_setting: 'Việt Nam' },
  style: 'Cinematic 35mm anamorphic, chiaroscuro, photorealistic.',
  assets: [
    { key: 'wife', role: 'character', name: 'Người vợ', prompt: 'model sheet wife' },
    { key: 'husband', role: 'character', name: 'Người chồng', prompt: 'model sheet husband' },
    { key: 'scene_table', role: 'scene', name: 'Bàn ăn', prompt: 'dining table' },
    { key: 'prop_card', role: 'prop', name: 'Thẻ khách sạn', prompt: 'hotel keycard macro' },
  ],
  cameras: [{ key: 'ots', name: 'OTS', config: 'over-the-shoulder push-in' }],
  shots: [
    {
      name: 'Shot 01',
      start: 0,
      duration: 7,
      beat: 'setup',
      uses: ['wife', 'husband', 'scene_table', 'prop_card'],
      camera: 'ots',
      dialogue: 'Anh về muộn.',
      videoPrompt:
        'Veo Video Prompt: @wife and @husband at @scene_table. Camera: over-the-shoulder. Lighting & Physics: amber chiaroscuro, 16:9, cinematic 35mm, no text.',
    },
  ],
});
assert.equal(drama.name, 'Bẫy Ngầm (The Trap)', 'name comes from project.title');
assert.equal(drama.theme, 'film', 'drama defaults to the film theme');
const dByName = n => drama.nodes.find(x => x.name === n);
assert.equal(dByName('Người vợ').zone, 'character');
assert.equal(dByName('Bàn ăn').zone, 'design');
assert.equal(dByName('Thẻ khách sạn').zone, 'design', 'a prop is a reference image');
const dShot = dByName('Shot 01');
assert.match(dShot.videoPrompt, /Lighting & Physics/, 'VEO prompt kept intact (not stripped)');
assert.equal(dShot.lyric, 'Anh về muộn.', 'dialogue mapped to the shot line');
// The shot is wired to its uses but NOT to camera/style (those are inline in the VEO prompt).
const dParents = drama.edges.filter(e => e.target === dShot.id).map(e => e.source);
assert.equal(dParents.length, 4, 'wired to the 4 reference assets only');
assert.ok(dParents.includes(dByName('Thẻ khách sạn').id));
assert.ok(!dParents.includes(dByName('Style').id), 'style not wired for drama');
assert.ok(!dParents.includes(dByName('OTS').id), 'camera not wired for drama');

// Feature-mode: paste a bible (assets+cameras, no shots) AND a sequence (shots, no assets)
// as two JSON blocks → they merge into one graph.
const bibleTxt =
  '```json\n' +
  JSON.stringify({
    bible: {
      assets: [
        { key: 'wife', role: 'character', name: 'Vợ', prompt: 'x' },
        { key: 'room', role: 'scene', name: 'Phòng', prompt: 'y' },
      ],
      cameras: [{ key: 'ots', name: 'OTS', config: 'c' }],
    },
    style: 'Cinematic',
  }) +
  '\n```';
const seqTxt =
  '```json\n' +
  JSON.stringify({
    project: { title: 'Seq 1', part_of: 'Phim', sequence_index: 1 },
    shots: [
      {
        name: 'S1',
        duration: 6,
        uses: ['wife', 'room'],
        camera: 'ots',
        videoPrompt: 'Veo: @wife in @room. Camera: ots. Lighting & Physics: amber.',
      },
    ],
  }) +
  '\n```';
const merged = buildGraph(bibleTxt + '\n' + seqTxt);
assert.equal(merged.name, 'Seq 1');
assert.ok(
  merged.nodes.some(n => n.name === 'Vợ'),
  'bible assets merged into the sequence',
);
assert.ok(
  merged.nodes.some(n => n.name === 'S1'),
  'sequence shot present',
);
// A sequence file alone (no assets) gives a clear, guiding error.
assert.throws(
  () => buildGraph({ project: { title: 'Seq alone' }, shots: [{ name: 'S', uses: [] }] }),
  /bible/i,
  'missing-assets error mentions the bible',
);

// parseBlueprint tolerates a ```json fence and surrounding prose.
const wrapped = 'Đây là kết quả:\n```json\n' + JSON.stringify(bp) + '\n```\ncảm ơn';
assert.equal(parseBlueprint(wrapped).project.name, 'Test MV');

// --- Integration: build endpoint + LLM auto path ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-dir-'));
let llmCalls = 0;
let lastSystem = '';
const llm = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  llmCalls++;
  const body = JSON.parse(raw);
  lastSystem = body.messages[0].content;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: 'Blueprint:\n```json\n' + JSON.stringify(bp) + '\n```' } }],
    }),
  );
});
await new Promise(r => llm.listen(17796, '127.0.0.1', r));
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: '17797', MV_ORBIT_URL: 'http://127.0.0.1:1', MV_DATA_DIR: dir },
  stdio: 'pipe',
});
async function api(p, method = 'GET', b) {
  const r = await fetch('http://127.0.0.1:17797' + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });
  // Build from a pasted blueprint (string with a fence).
  let r = await api('/api/director/build', 'POST', { blueprint: wrapped });
  assert.equal(r.status, 200);
  let s = r.data;
  assert.equal(s.name, 'Test MV');
  assert.equal(s.nodes.filter(n => n.zone === 'production').length, 2);
  const shot1 = s.nodes.find(n => n.name === 'Shot 1');
  const p1 = s.edges.filter(e => e.target === shot1.id).map(e => e.source);
  assert.equal(p1.length, 4);
  // Style text reaches the shot's resolved prompt.
  assert.match(shot1.resolvedPrompts.video, /Cinematic 35mm/);
  // Bad blueprint is rejected.
  r = await api('/api/director/build', 'POST', { blueprint: '{"assets":[]}' });
  assert.equal(r.status, 400);

  // Build from an array of files (feature mode: bible + sequence picked together).
  const bibleObj = {
    bible: { assets: [{ key: 'q', role: 'character', name: 'Q', prompt: 'p' }] },
    cameras: [{ key: 'c1', name: 'C', config: 'x' }],
    style: 'Cinematic',
  };
  const seqObj = {
    project: { title: 'Seq A' },
    shots: [{ name: 'SA', duration: 6, uses: ['q'], camera: 'c1', videoPrompt: 'Veo @q.' }],
  };
  r = await api('/api/director/build', 'POST', { blueprint: [bibleObj, seqObj] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.name, 'Seq A');
  assert.equal(r.data.theme, 'film');
  assert.ok(
    r.data.nodes.some(n => n.name === 'Q'),
    'bible asset built from the array',
  );

  // Reuse across sequences: give the asset an image, then build a NEW sequence with the same
  // key — the image is re-attached automatically so it is not regenerated.
  const qNode = r.data.nodes.find(n => n.assetKey === 'q');
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await api('/api/upload', 'POST', {
    nodeId: qNode.id,
    kind: 'image',
    mime: 'image/png',
    base64: PNG,
  });
  const seqB = {
    project: { title: 'Seq B' },
    shots: [{ name: 'SB', duration: 6, uses: ['q'], camera: 'c1', videoPrompt: 'Veo @q.' }],
  };
  r = await api('/api/director/build', 'POST', { blueprint: [bibleObj, seqB] });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Seq B');
  assert.equal(r.data.graphReused, 1, 'reused the asset image from the previous sequence');
  assert.ok(
    r.data.nodes.find(n => n.assetKey === 'q')?.image,
    'the new sequence node already has the reused image',
  );

  // LLM auto path: point the Director at the mock, then auto-build.
  await api('/api/director/llm', 'POST', {
    key: 'test-key-1234',
    baseUrl: 'http://127.0.0.1:17796/v1',
    model: 'mock',
  });
  assert.equal((await api('/api/director')).data.llm.configured, true);
  r = await api('/api/director/auto', 'POST', { song: 'BẮT ĐẦU: Bài test' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.name, 'Test MV');
  assert.equal(llmCalls, 1);
  assert.ok(lastSystem.includes('MASTER PROMPT'), 'default master prompt sent to the LLM');
  assert.equal((await api('/api/director/auto', 'POST', { song: '' })).status, 400);

  // Per-project master prompt: save a custom one, confirm it is served and used by auto.
  let d = (await api('/api/director')).data;
  assert.equal(d.customMaster, false);
  const custom = 'MASTER PROMPT TUỲ CHỈNH RIÊNG · marker-XYZ';
  d = (await api('/api/director/master', 'POST', { masterPrompt: custom })).data;
  assert.equal(d.customMaster, true);
  assert.equal(d.masterPrompt, custom);
  assert.equal((await api('/api/director')).data.masterPrompt, custom);
  await api('/api/director/auto', 'POST', { song: 'Bài 2' });
  assert.ok(lastSystem.includes('marker-XYZ'), 'the custom prompt is sent to the LLM');
  // Reset restores the default.
  d = (await api('/api/director/master', 'POST', { masterPrompt: '' })).data;
  assert.equal(d.customMaster, false);
  assert.ok(d.masterPrompt.includes('MASTER PROMPT'), 'default restored');

  console.log(
    'PASS: buildGraph assets/cameras/style/shots + wiring, fence parsing, build endpoint, style injection, bad blueprint rejected, LLM auto path, per-project master prompt',
  );
} finally {
  proc.kill();
  llm.close();
}
