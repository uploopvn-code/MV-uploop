import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-graph-')),
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=',
    'base64',
  );
let calls = [],
  skipOutput = false,
  cookie = '';
const hub = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  let out = {};
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/login') res.setHeader('Set-Cookie', 'orbit_session=test');
  else if (req.url === '/api/auth-status') out = { user: { email: 'test@example.com' } };
  else if (req.url === '/api/profiles') out = [{ id: 'p', name: 'Test' }];
  else if (req.url === '/api/flows') out = [{ id: 'f', name: 'Create image' }];
  else if (req.url === '/api/apps' || req.url.startsWith('/api/workflows')) out = [];
  else if (req.url.endsWith('/flow-progress')) out = { running: false };
  else if (req.url.endsWith('/launch')) out = { ok: true };
  else if (req.url.endsWith('/run-flow')) {
    const { vars } = JSON.parse(raw);
    calls.push(vars);
    for (const file of JSON.parse(vars.mv_inputs_json)) assert.ok(fs.existsSync(file.path));
    if (!skipOutput) fs.writeFileSync(vars.mv_output_path, png);
    out = { ok: true };
  }
  res.end(JSON.stringify(out));
});
await new Promise(r => hub.listen(17792, '127.0.0.1', r));
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    MV_PORT: '17791',
    MV_ORBIT_URL: 'http://127.0.0.1:17792',
    MV_DATA_DIR: dir,
    MV_OUTPUT_WAIT_MS: '2100',
  },
  stdio: 'pipe',
});
async function api(p, method = 'GET', body) {
  const r = await fetch('http://127.0.0.1:17791' + p, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  return { status: r.status, data: await r.json() };
}
async function wait() {
  for (let i = 0; i < 120; i++) {
    const s = (await api('/api/state')).data;
    if (s.autoRun?.status !== 'running') return s;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timed out');
}
try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });
  await api('/api/orbit/login', 'POST', { email: 'test@example.com', password: 'test' });
  await api('/api/project', 'PATCH', { outputDirectory: path.join(dir, 'results') });
  for (const id of ['singer', 'stage'])
    await api('/api/upload', 'POST', {
      nodeId: id,
      mime: 'image/png',
      base64: png.toString('base64'),
    });
  const state = (await api('/api/nodes', 'POST', { name: 'Second output' })).data,
    newId = state.nodes.at(-1).id;
  const edges = [
    { source: 'singer', target: 'scene' },
    { source: 'stage', target: 'scene' },
    { source: 'scene', target: newId },
  ];
  assert.equal((await api('/api/edges', 'PUT', { edges })).status, 200);
  assert.equal(
    (await api('/api/edges', 'PUT', { edges: [...edges, { source: newId, target: 'singer' }] }))
      .status,
    400,
  );
  const binding = { type: 'flow', scriptId: 'f', profileId: 'p' };
  for (const id of ['scene', newId])
    await api('/api/node', 'PATCH', { id, orbit: { image: binding } });
  assert.equal((await api('/api/auto/start', 'POST', { target: newId })).status, 200);
  assert.equal((await api('/api/nodes', 'POST', {})).status, 400);
  let done = await wait();
  assert.equal(done.autoRun.status, 'completed');
  assert.deepEqual(
    calls.map(c => c.mv_node_id),
    ['scene', newId],
  );
  assert.equal(calls[0].mv_input_count, 2);
  assert.equal(calls[1].mv_input_count, 1);
  assert.ok(done.nodes.find(n => n.id === newId).image);
  await api('/api/node', 'PATCH', { id: 'scene', prompt: 'Changed' });
  skipOutput = true;
  const before = calls.length;
  await api('/api/auto/start', 'POST', { target: newId });
  done = await wait();
  assert.equal(done.autoRun.status, 'blocked');
  assert.equal(calls.length, before + 1);
  assert.ok(done.nodes.find(n => n.id === newId).stale);
  const missing = done.jobs.at(-1);
  fs.writeFileSync(missing.payload.output.path, png);
  assert.equal((await api('/api/jobs/collect', 'POST', { id: missing.id })).status, 200);
  assert.equal(calls.length, before + 1, 'Collection must not rerun Orbit');
  console.log(
    'PASS: fan-in, cycle rejection, two-node auto execution, real file handoff, edit lock, missing-output blocks descendants, collect without rerun',
  );
} finally {
  proc.kill();
  hub.close();
}
