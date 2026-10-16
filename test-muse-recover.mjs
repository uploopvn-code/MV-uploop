// Local HTTP regression: reuse a Muse conversation for an image and retry an uncertain
// Muse video three times before saving it, without creating another paid render.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-muse-recover-'));
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
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body, method = body ? 'POST' : 'GET', token = '') {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
async function ok(route, body, method, token) {
  const r = await api(route, body, method, token);
  assert.ok(r.status < 300, route + ': ' + JSON.stringify(r.data));
  return r.data;
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    try { const result = await check(); if (result) return result; } catch {}
    await pause(40);
  }
  throw new Error('Timed out: ' + log);
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=';
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(16)]).toString('base64');
try {
  await until(async () => (await api('/api/state')).status === 200);
  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const worker = (route, body) => ok(route, body, 'POST', token);
  const claim = () => worker('/api/worker/claim', {
    name: 'muse-recovery-test', kinds: ['image', 'video', 'recover'], sites: ['musechat'],
  }).then(r => r.job);
  await ok('/api/project', { defaults: { image: 'musechat', video: 'musechat' } }, 'PATCH');
  const imageState = await ok('/api/nodes', { name: 'Muse image', kind: 'character' });
  const imageNode = imageState.nodes.find(n => n.name === 'Muse image').id;
  const imageJob = (await ok('/api/jobs', { nodeId: imageNode, kind: 'image' })).job;
  assert.equal(imageJob.payload.site, 'musechat');
  let active = await claim();
  assert.equal(active.id, imageJob.id);
  const imageUrl = 'https://muse.ai/chat/image-test';
  await worker('/api/worker/heartbeat', { id: active.id, lease: active.lease, name: 'muse-recovery-test', sent: true, conversationUrl: imageUrl });
  await worker('/api/worker/fail', { id: active.id, lease: active.lease, needsReview: true, error: 'Image pending', conversationUrl: imageUrl });
  let state = await ok('/api/state');
  assert.equal(state.jobs.find(j => j.id === imageJob.id).web.conversationUrl, imageUrl);
  await ok('/api/jobs/collect', { id: imageJob.id });
  active = await claim();
  assert.equal(active.id, imageJob.id);
  assert.equal(active.recover.conversationUrl, imageUrl);
  await worker('/api/worker/complete', { id: active.id, lease: active.lease, name: 'muse.png', mime: 'image/png', base64: png });
  state = await ok('/api/state');
  assert.ok(state.nodes.find(n => n.id === imageNode).image?.url);

  const videoState = await ok('/api/nodes', { name: 'Muse shot' });
  const videoNode = videoState.nodes.find(n => n.name === 'Muse shot').id;
  await ok('/api/node', { id: videoNode, zone: 'production' }, 'PATCH');
  await ok('/api/upload', { nodeId: videoNode, kind: 'image', name: 'keyframe.png', mime: 'image/png', base64: png });
  const videoJob = (await ok('/api/jobs', { nodeId: videoNode, kind: 'video' })).job;
  active = await claim();
  assert.equal(active.id, videoJob.id);
  const videoUrl = 'https://muse.ai/chat/video-test';
  await worker('/api/worker/heartbeat', { id: active.id, lease: active.lease, name: 'muse-recovery-test', sent: true, conversationUrl: videoUrl });
  await worker('/api/worker/fail', { id: active.id, lease: active.lease, needsReview: true, error: 'Video pending', conversationUrl: videoUrl });
  const run = await ok('/api/auto/video/missing', { versions: 1 });
  assert.equal(run.autoVideoRun.status, 'running');
  for (let attempt = 1; attempt <= 3; attempt++) {
    active = await until(claim);
    assert.equal(active.id, videoJob.id, 'must reopen the old Muse job');
    assert.equal(active.recover.conversationUrl, videoUrl);
    assert.equal(active.recover.tries, attempt);
    if (attempt < 3) {
      await worker('/api/worker/fail', { id: active.id, lease: active.lease, needsReview: true, error: 'Still pending' });
    } else {
      await worker('/api/worker/complete', { id: active.id, lease: active.lease, name: 'result.mp4', mime: 'video/mp4', base64: mp4 });
    }
  }
  state = await until(async () => {
    const s = await ok('/api/state');
    return s.autoVideoRun.status === 'completed' ? s : null;
  });
  assert.equal(state.jobs.filter(j => j.nodeId === videoNode && j.kind === 'video').length, 1);
  assert.ok(state.nodes.some(n => n.terminal && n.source === videoNode && n.video));

  const unresolvedState = await ok('/api/nodes', { name: 'Muse unresolved' });
  const unresolvedNode = unresolvedState.nodes.find(n => n.name === 'Muse unresolved').id;
  await ok('/api/node', { id: unresolvedNode, zone: 'production' }, 'PATCH');
  await ok('/api/upload', { nodeId: unresolvedNode, kind: 'image', name: 'keyframe.png', mime: 'image/png', base64: png });
  const unresolvedJob = (await ok('/api/jobs', { nodeId: unresolvedNode, kind: 'video' })).job;
  active = await claim();
  assert.equal(active.id, unresolvedJob.id);
  const unresolvedUrl = 'https://muse.ai/chat/unresolved-test';
  await worker('/api/worker/heartbeat', { id: active.id, lease: active.lease, name: 'muse-recovery-test', sent: true, conversationUrl: unresolvedUrl });
  await worker('/api/worker/fail', { id: active.id, lease: active.lease, needsReview: true, error: 'Still rendering', conversationUrl: unresolvedUrl });
  await ok('/api/auto/video/missing', { versions: 1 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    active = await until(claim);
    assert.equal(active.id, unresolvedJob.id);
    assert.equal(active.recover.tries, attempt);
    await worker('/api/worker/fail', { id: active.id, lease: active.lease, needsReview: true, error: 'No result yet' });
  }
  state = await until(async () => {
    const s = await ok('/api/state');
    return s.autoVideoRun.status === 'blocked' ? s : null;
  });
  assert.equal(state.jobs.filter(j => j.nodeId === unresolvedNode && j.kind === 'video').length, 1,
    'three unsuccessful checks must not create a duplicate video');
  assert.match(state.autoVideoRun.message, /3 lần/);
  console.log('PASS: Muse image and video recover from saved links; three checks reuse one job and stop safely when unresolved');
} finally {
  proc.kill();
}
