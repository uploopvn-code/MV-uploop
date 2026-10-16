// Regression for area rendering: exercise the actual route, queue payload and worker handoff.
// Uses an isolated project and local worker responses; no paid provider requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-zone-video-'));
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: String(port), MV_DATA_DIR: dir, SEEDVIS_API_KEY: '', MV_PROJECT: '', MV_PARENT_PID: '' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
proc.stdout.on('data', d => { log += d; });
proc.stderr.on('data', d => { log += d; });
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function api(route, body, method = body ? 'POST' : 'GET', headers = {}) {
  const r = await fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
async function ok(route, body, method) {
  const r = await api(route, body, method);
  assert.ok(r.status < 300, route + ': ' + JSON.stringify(r.data));
  return r.data;
}
async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    const value = await fn();
    if (value) return value;
    await pause();
  }
  throw new Error('Timed out: ' + log);
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=';
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(16)]).toString('base64');
const upload = (id, kind = 'image') => ok('/api/upload', {
  nodeId: id, kind, name: kind === 'image' ? 'ref.png' : 'clip.mp4',
  mime: kind === 'image' ? 'image/png' : 'video/mp4', base64: kind === 'image' ? png : mp4,
});
async function node(name, patch = {}, kind) {
  const s = await ok('/api/nodes', { name, kind });
  const id = s.nodes.find(n => n.name === name).id;
  if (Object.keys(patch).length) await ok('/api/node', { id, ...patch }, 'PATCH');
  return id;
}
const options = { zone: 'production', provider: 'musechat', versions: 1 };
try {
  await waitFor(async () => {
    try { return (await api('/api/state')).status === 200; } catch { return false; }
  });
  await ok('/api/project', { defaults: { video: 'musechat' } }, 'PATCH');
  const refs = [];
  for (let i = 0; i < 4; i++) {
    const id = await node('Reference ' + i, {}, 'character');
    await upload(id);
    refs.push(id);
  }
  const style = await node('Style', {}, 'setting');
  const camera = await node('Camera', {}, 'setting');
  const shot = await node('Shot 6 — four references', { zone: 'production', videoInput: 'refs' });
  const self = await node('Default self — no keyframe', { zone: 'production' });
  const empty = await node('No input images', { zone: 'production' });
  const filmed = await node('Already filmed', { zone: 'production' });
  await upload(filmed);
  await upload(filmed, 'video');
  let s = await ok('/api/state');
  await ok('/api/edges', { edges: [...s.edges,
    ...[...refs, style, camera].map(source => ({ source, target: shot })),
    { source: refs[0], target: self },
  ] }, 'PUT');
  s = await ok('/api/state');
  assert.equal(s.nodes.find(n => n.id === shot).references.length, 4);
  assert.ok(s.nodes.find(n => n.id === shot).references.every(r => r.asset && !r.image));
  assert.equal(s.nodes.find(n => n.id === self).videoInput, 'self');

  const started = await api('/api/auto/video/zone/start', options);
  assert.equal(started.status, 200, 'area must accept {role, asset} references: ' + JSON.stringify(started.data));
  assert.equal(started.data.autoVideoRun.total, 2, 'include refs and self shots; skip empty and completed');
  const queued = await waitFor(async () => {
    const state = await ok('/api/state');
    return state.jobs.filter(j => j.autoVideoId === started.data.autoVideoRun.id).length === 2 && state;
  });
  assert.deepEqual(queued.autoVideoRun.errors, []);
  const jobs = queued.jobs.filter(j => j.autoVideoId === started.data.autoVideoRun.id);
  assert.ok(jobs.every(j => j.status === 'queued' && j.kind === 'video' && j.payload.site === 'musechat'));
  assert.deepEqual(jobs.find(j => j.nodeId === shot).payload.references.map(r => r.role), refs);
  assert.equal(jobs.find(j => j.nodeId === self).payload.references[0].role, refs[0]);
  assert.ok(!jobs.some(j => j.nodeId === empty || j.nodeId === filmed));
  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const worker = (route, body) => api(route, body, 'POST', { Authorization: 'Bearer ' + token });
  for (let i = 0; i < jobs.length; i++) {
    const claim = await worker('/api/worker/claim', { name: 'isolated-muse', kinds: ['video'], sites: ['musechat'] });
    assert.equal(claim.status, 200);
    assert.ok(jobs.some(j => j.id === claim.data.job?.id));
    assert.ok(claim.data.job.payload.references.every(r => r.asset));
    const done = await worker('/api/worker/complete', {
      id: claim.data.job.id, lease: claim.data.job.lease, name: 'result.mp4', mime: 'video/mp4', base64: mp4,
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
  }
  await waitFor(async () => (await ok('/api/state')).autoVideoRun.status === 'completed');
  const repeated = await api('/api/auto/video/zone/start', options);
  assert.equal(repeated.status, 400, 'completed output branches are skipped on repeat');
  assert.match(repeated.data.error, /đã đủ 1 phiên bản/);
  assert.match(repeated.data.error, /chưa có ảnh riêng hoặc ảnh tham chiếu/);

  // The selector is a TARGET TOTAL, not a provider result count. Muse creates one file per
  // browser job, so the coordinator must keep each source pending until v3 exists.
  const v3 = await api('/api/auto/video/zone/start', { ...options, versions: 3 });
  assert.equal(v3.status, 200, JSON.stringify(v3.data));
  assert.equal(v3.data.autoVideoRun.total, 3, 'three sources currently have one version each');
  assert.equal(v3.data.autoVideoRun.totalVersions, 6, 'each source is missing exactly two files');
  for (let i = 0; i < 6; i++) {
    const claim = await waitFor(async () => {
      const candidate = await worker('/api/worker/claim', { name: 'isolated-muse', kinds: ['video'], sites: ['musechat'] });
      return candidate.data.job ? candidate : null;
    });
    const done = await worker('/api/worker/complete', {
      id: claim.data.job.id, lease: claim.data.job.lease, name: `result-v3-${i}.mp4`,
      mime: 'video/mp4', base64: mp4,
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
  }
  const v3State = await waitFor(async () => {
    const state = await ok('/api/state');
    return state.autoVideoRun.status === 'completed' && state;
  });
  for (const id of [shot, self]) {
    const clips = v3State.nodes.filter(n => n.terminal && n.source === id && n.video);
    assert.equal(clips.length, 3, 'Muse must produce v1, v2 and v3 as separate jobs');
    assert.deepEqual(clips.map(n => n.version).sort(), [1, 2, 3]);
  }
  assert.equal(
    Number(!!v3State.nodes.find(n => n.id === filmed).video) +
      v3State.nodes.filter(n => n.terminal && n.source === filmed && n.video).length,
    3,
    'an attached v1 receives only the two missing versions',
  );

  // Confirmed old images must reach the job builder, while normal single-node rendering
  // keeps its stale-image guard. Editing a parent makes its existing image stale.
  const oldOwn = await node('Old keyframe', { zone: 'production' });
  await upload(oldOwn);
  await ok('/api/node', { id: oldOwn, prompt: 'Changed after keyframe upload' }, 'PATCH');
  await ok('/api/node', { id: refs[0], prompt: 'Changed after reference upload' }, 'PATCH');
  const oldRefs = await node('Old reference', { zone: 'production' });
  s = await ok('/api/state');
  await ok('/api/edges', { edges: [...s.edges, { source: refs[0], target: oldRefs }] }, 'PUT');
  assert.equal((await api('/api/jobs', { nodeId: oldOwn, kind: 'video' })).status, 400);
  const unconfirmed = await api('/api/auto/video/zone/start', options);
  assert.equal(unconfirmed.status, 400, 'old keyframes AND old referenced images need confirmation');
  assert.match(unconfirmed.data.error, /ảnh cũ cần xác nhận/);
  const confirmed = await api('/api/auto/video/zone/start', { ...options, allowStale: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.autoVideoRun.total, 2);
  const oldState = await waitFor(async () => {
    const state = await ok('/api/state');
    assert.deepEqual(state.autoVideoRun.errors, [], 'confirmed stale inputs must not fail in createJob');
    return state.jobs.filter(j => j.autoVideoId === confirmed.data.autoVideoRun.id).length === 2 && state;
  });
  const oldJobs = oldState.jobs.filter(j => j.autoVideoId === confirmed.data.autoVideoRun.id);
  assert.equal(oldJobs.find(j => j.nodeId === oldOwn).payload.references[0].role, 'keyframe');
  assert.equal(oldJobs.find(j => j.nodeId === oldRefs).payload.references[0].asset.id,
    oldState.nodes.find(n => n.id === refs[0]).image.id);
  assert.equal(oldState.nodes.find(n => n.id === oldOwn).stale, true, 'approval does not clear the stale flag');
  assert.equal(oldState.nodes.find(n => n.id === refs[0]).stale, true);
  await ok('/api/auto/video/stop', {});

  // Exercise the actual UI handler with a stale parent (the shot itself has no stale flag).
  const controls = new Map();
  const $ = selector => {
    if (!controls.has(selector)) controls.set(selector, { value: '', checked: false });
    return controls.get(selector);
  };
  $('#videoZone').value = 'production';
  $('#videoProvider').value = 'musechat';
  $('#videoVersions').value = '1';
  const requests = [], confirmations = [], notices = [];
  const uiState = { state: { nodes: [
    { id: 'ref', image: { id: 'old' }, stale: true, zone: 'character' },
    { id: 'shot', zone: 'production', references: [{ role: 'ref', asset: { id: 'old' } }], providers: { video: { type: 'musechat' } } },
  ] } };
  let confirmResult = true;
  vm.runInNewContext(fs.readFileSync(new URL('./public/js/auto.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, ''), {
    $, store: uiState, window: {}, t: key => key, capturesReady: async () => {}, render: () => {},
    toast: (message, error) => { notices.push({ message, error }); },
    confirm: message => { confirmations.push(message); return confirmResult; },
    api: async (route, request) => { requests.push({ route, ...request }); return uiState.state; },
  });
  await $('#autoVideoZoneStart').onclick();
  assert.deepEqual(notices, [{ message: 'render.zoneVideosStarted', error: undefined }]);
  assert.equal(confirmations.length, 2, 'general confirmation and stale-reference confirmation');
  assert.match(confirmations[1], / 1 /);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.allowStale, true);
  assert.equal(requests[0].body.onlyWithImage, false);
  confirmResult = false;
  await $('#autoVideoZoneStart').onclick();
  assert.equal(requests.length, 1, 'cancel sends no new render request');

  console.log('PASS: area route → Muse queue → worker → v1/v2/v3 target totals, references and stale confirmation');
} finally {
  if (proc.exitCode === null) {
    const exited = once(proc, 'exit');
    proc.kill();
    await exited;
  }
}
