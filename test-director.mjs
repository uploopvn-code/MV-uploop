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
    { key: 'singer', name: 'Ca sĩ', prompt: 'singer model sheet' },
    { key: 'guitarist', name: 'Guitarist', prompt: 'guitarist playing' },
    { key: 'stage', name: 'Sân khấu', prompt: 'wide stage' },
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
// Assets + settings in design, shots in production.
assert.equal(g.nodes.filter(n => n.zone === 'design').length, 6); // style + 3 assets + 2 cameras
assert.equal(g.nodes.filter(n => n.zone === 'production').length, 2);
assert.equal(byName('Style').kind, 'setting');
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
// parseBlueprint tolerates a ```json fence and surrounding prose.
const wrapped = 'Đây là kết quả:\n```json\n' + JSON.stringify(bp) + '\n```\ncảm ơn';
assert.equal(parseBlueprint(wrapped).project.name, 'Test MV');

// --- Integration: build endpoint + LLM auto path ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-dir-'));
let llmCalls = 0;
const llm = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  llmCalls++;
  const body = JSON.parse(raw);
  assert.ok(body.messages[0].content.includes('MASTER PROMPT'), 'system = master prompt');
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
  assert.equal((await api('/api/director/auto', 'POST', { song: '' })).status, 400);

  console.log(
    'PASS: buildGraph assets/cameras/style/shots + wiring, fence parsing, build endpoint, style injection, bad blueprint rejected, LLM auto path',
  );
} finally {
  proc.kill();
  llm.close();
}
