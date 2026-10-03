// Seedvis integration against a local mock of the Seedvis API.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-seedvis-')),
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=',
    'base64',
  ),
  mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(16)]);
const KEY = 'sv-test-key-1234';
const API = 'http://127.0.0.1:17794/api/v1';
let submits = [],
  polls = 0,
  mode = 'ok',
  inFlight = 0,
  maxInFlight = 0;
const jobs = new Map();
const lifecycle = (id, j) => ({
  id,
  status: j.status,
  is_final: ['completed', 'failed'].includes(j.status),
  mode: j.mode,
  next: ['completed', 'failed'].includes(j.status)
    ? { action: 'done' }
    : { action: 'poll', url: API + '/developer/generations/' + id + '?wait=0', after_seconds: 1 },
  outputs:
    j.status === 'completed'
      ? Array.from({ length: j.count || 1 }, (_, k) => ({
          type: j.kind,
          url: 'http://localhost:17794/cdn/' + id + '_' + k,
        }))
      : [],
  references: j.refs.map((_, index) => ({ field: 'reference_images', index })),
  ...(j.status === 'failed'
    ? { error: { code: 'content_policy', message: 'Prompt bị từ chối' } }
    : {}),
});
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/cdn/')) {
    assert.equal(req.headers.authorization, undefined, 'Key must not go to another host');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const jid = req.url.slice(5).split('_')[0];
    return res.end(jobs.get(jid).kind === 'video' ? mp4 : png);
  }
  if (req.headers.authorization !== 'Bearer ' + KEY)
    return send(401, { error: { code: 'unauthorized', message: 'Invalid key' } });
  if (req.url === '/api/v1/account/info') return send(200, { data: { balance: 42, plan: 'Pro' } });
  if (req.url === '/api/v1/models')
    return send(200, { data: [{ id: 'GEM_PIX_2' }, { id: 'Veo-3.1' }] });
  const poll = req.url.match(/^\/api\/v1\/developer\/generations\/([\w-]+)\?wait=0$/);
  if (poll && req.method === 'GET') {
    polls++;
    const j = jobs.get(poll[1]);
    j.pollCount = (j.pollCount || 0) + 1;
    // Finish on the 2nd poll so parallel jobs overlap (and concurrency is observable).
    if (mode !== 'stuck') {
      if (j.pollCount >= 2) {
        if (j.status === 'queued' || j.status === 'processing') inFlight--;
        j.status = j.failNext ? 'failed' : 'completed';
      } else j.status = 'processing';
    }
    return send(200, { success: true, data: lifecycle(poll[1], j) });
  }
  if (req.method === 'POST') {
    const b = JSON.parse(raw),
      id = req.headers['idempotency-key'];
    submits.push({ url: req.url, body: b, id });
    if (mode === 'reject') return send(400, { errors: { 'reference_images[0]': 'not an image' } });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const kind = req.url.includes('/google/') ? 'image' : 'video';
    const refs = b.reference_images || b.referenceImages || b.images || (b.image ? [b.image] : []);
    jobs.set(id, {
      status: 'queued',
      kind,
      refs,
      count: b.count || 1,
      mode: b.mode,
      failNext: mode === 'fail',
    });
    return kind === 'image'
      ? send(202, lifecycle(id, jobs.get(id)))
      : send(202, { success: true, status: 202, data: lifecycle(id, jobs.get(id)) });
  }
  send(404, {});
});
await new Promise(r => mock.listen(17794, '127.0.0.1', r));
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    SEEDVIS_API_KEY: '',
    MV_PORT: '17793',
    MV_ORBIT_URL: 'http://127.0.0.1:1',
    MV_SEEDVIS_URL: API,
    MV_SEEDVIS_POLL_MS: '30',
    MV_SEEDVIS_TIMEOUT_MS: '1500',
    MV_DATA_DIR: dir,
  },
  stdio: 'pipe',
});
async function api(p, method = 'GET', body) {
  const r = await fetch('http://127.0.0.1:17793' + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json(), text: '' };
}
async function settle(jobId) {
  for (let i = 0; i < 200; i++) {
    const s = (await api('/api/state')).data,
      j = s.jobs.find(j => j.id === jobId);
    if (!['queued', 'running'].includes(j.status)) return { s, j };
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Timed out');
}
try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });
  // No key yet: generation is refused before anything is sent.
  for (const id of ['singer', 'stage'])
    await api('/api/upload', 'POST', {
      nodeId: id,
      mime: 'image/png',
      base64: png.toString('base64'),
    });
  let r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /API key Seedvis/);
  assert.equal((await api('/api/seedvis/key', 'POST', { key: 'bad' })).status, 400);
  const status = (await api('/api/seedvis/key', 'POST', { key: KEY })).data;
  assert.equal(status.configured, true);
  assert.equal(status.account.balance, 42);
  assert.deepEqual(status.available, ['GEM_PIX_2', 'Veo-3.1']);
  assert.equal(status.keyHint, '…1234');

  // Image: scene gets both references, Nano Banana Pro by default.
  let st = (await api('/api/state')).data;
  assert.equal(st.nodes.find(n => n.id === 'scene').providers.image.model, 'GEM_PIX_2');
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image' });
  assert.equal(r.status, 201);
  let { s, j } = await settle(r.data.job.id);
  assert.equal(j.status, 'completed', j.error);
  assert.equal(submits.length, 1);
  assert.equal(submits[0].url, '/api/v1/google/v1beta/interactions');
  assert.equal(submits[0].id, j.id, 'Idempotency-Key is the job id');
  assert.equal(submits[0].body.model, 'GEM_PIX_2');
  assert.equal(submits[0].body.mode, 'image-to-image');
  assert.equal(submits[0].body.aspect_ratio, '16:9');
  assert.equal(submits[0].body.reference_images.length, 2);
  assert.equal(Buffer.from(submits[0].body.reference_images[0].data, 'base64').equals(png), true);
  assert.equal(j.remote.used, 2);
  assert.ok(s.nodes.find(n => n.id === 'scene').image);

  // Video: Veo 3.1 with the shot's image as the single keyframe, duration mapped to 8s.
  await api('/api/upload', 'POST', {
    nodeId: 'wide',
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  r = await api('/api/node', 'PATCH', {
    id: 'wide',
    seedvis: { video: { model: 'Veo-3.1', aspectRatio: '9:16', upscale: '1080p' } },
  });
  assert.equal(r.status, 200);
  r = await api('/api/jobs', 'POST', { nodeId: 'wide', kind: 'video' });
  ({ s, j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  const v = submits.at(-1);
  assert.equal(v.url, '/api/v1/developer/generations');
  assert.equal(v.body.model, 'Veo-3.1');
  assert.equal(v.body.mode, 'image-to-video');
  assert.equal(v.body.duration, '8s');
  assert.equal(v.body.aspect_ratio, '9:16');
  assert.equal(v.body.upscale_video, '1080p');
  assert.ok(v.body.image.data && !v.body.reference_images);
  assert.equal(s.nodes.find(n => n.id === 'wide').video.mime, 'video/mp4');

  // Seedance takes reference_images and a numeric duration.
  await api('/api/node', 'PATCH', {
    id: 'wide',
    duration: 12,
    seedvis: { video: { model: 'seedance_2.5', aspectRatio: '16:9' } },
  });
  r = await api('/api/jobs', 'POST', { nodeId: 'wide', kind: 'video' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal(submits.at(-1).body.duration, 10);
  assert.equal(submits.at(-1).body.reference_images.length, 1);

  // Video from a connected node's image (refs mode): no own image needed; the image
  // sent is the parent's (file_name prefixed with the parent id), not this node's keyframe.
  let g = (await api('/api/nodes', 'POST', { name: 'Clip ban nhạc' })).data;
  const clip = g.nodes.at(-1).id;
  await api('/api/edges', 'PUT', { edges: [...g.edges, { source: 'scene', target: clip }] });
  r = await api('/api/jobs', 'POST', { nodeId: clip, kind: 'video' });
  assert.equal(r.status, 400, 'self mode without own image is rejected');
  await api('/api/node', 'PATCH', {
    id: clip,
    videoInput: 'refs',
    seedvis: { video: { model: 'Veo-3.1', aspectRatio: '16:9' } },
  });
  r = await api('/api/jobs', 'POST', { nodeId: clip, kind: 'video' });
  ({ s, j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal(submits.at(-1).body.mode, 'image-to-video');
  assert.ok(submits.at(-1).body.image.file_name.startsWith('scene-'), 'uses the parent image');
  assert.ok(s.nodes.find(n => n.id === clip).video);

  // Two connected images → Veo multi-image-to-video (referenceImages).
  g = (await api('/api/state')).data;
  await api('/api/edges', 'PUT', { edges: [...g.edges, { source: 'wide', target: clip }] });
  r = await api('/api/jobs', 'POST', { nodeId: clip, kind: 'video' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal(submits.at(-1).body.mode, 'multi-image-to-video');
  assert.equal(submits.at(-1).body.referenceImages.length, 2);

  // A rejected request is a definite failure; a failed job too. Neither is resent.
  mode = 'reject';
  await api('/api/node', 'PATCH', { id: 'scene', prompt: 'p2' });
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'failed');
  assert.match(j.error, /reference_images\[0\]/);
  mode = 'fail';
  const before = submits.length;
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'failed');
  assert.match(j.error, /Prompt bị từ chối/);
  assert.equal(submits.length, before + 1);

  // Timeout leaves the job for review; "Kiểm tra lại" polls the same job, never resubmits.
  mode = 'stuck';
  await api('/api/node', 'PATCH', { id: 'scene', prompt: 'p3' });
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'needs_review');
  assert.ok(j.remote.pollUrl);
  const sent = submits.length;
  mode = 'ok';
  assert.equal((await api('/api/jobs/collect', 'POST', { id: j.id })).status, 200);
  ({ s, j } = await settle(j.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal(submits.length, sent, 'Resume must not resubmit');

  // Switching a node to Orbit keeps Seedvis out of it.
  r = await api('/api/node', 'PATCH', { id: 'stage', seedvis: { image: false } });
  assert.equal(r.data.nodes.find(n => n.id === 'stage').providers.image.type, 'orbit');

  // --- Concurrency: two Seedvis video jobs run in parallel, not one after another.
  mode = 'ok';
  const mkNode = async name => {
    const st0 = (await api('/api/nodes', 'POST', { name })).data;
    const nid = st0.nodes.at(-1).id;
    await api('/api/upload', 'POST', {
      nodeId: nid,
      kind: 'image',
      mime: 'image/png',
      base64: png.toString('base64'),
    });
    return nid;
  };
  const A = await mkNode('Shot A');
  const B = await mkNode('Shot B');
  maxInFlight = 0;
  const ja = (await api('/api/jobs', 'POST', { nodeId: A, kind: 'video' })).data.job.id;
  const jb = (await api('/api/jobs', 'POST', { nodeId: B, kind: 'video' })).data.job.id;
  await settle(ja);
  await settle(jb);
  assert.ok(maxInFlight >= 2, 'two Seedvis jobs overlapped (maxInFlight=' + maxInFlight + ')');

  // --- Auto video run, 2 versions, scoped to node A → 2 output branch nodes.
  const nap = ms => new Promise(r => setTimeout(r, ms));
  const settleAuto = async () => {
    for (let i = 0; i < 300; i++) {
      const run = (await api('/api/state')).data.autoVideoRun;
      if (run && run.status !== 'running') return run;
      await nap(50);
    }
    throw new Error('auto video timed out');
  };
  const branchesOf = s => s.nodes.filter(n => n.terminal && n.source === A);
  r = await api('/api/auto/video/start', 'POST', { target: A, versions: 2 });
  assert.equal(r.status, 200);
  let run = await settleAuto();
  assert.equal(run.status, 'completed', JSON.stringify(run.errors));
  s = (await api('/api/state')).data;
  let branches = branchesOf(s);
  assert.equal(branches.length, 2, 'two versions → two output nodes');
  assert.ok(branches.every(n => n.video && n.terminal && n.video.mime === 'video/mp4'));
  assert.ok(branches.every(n => s.edges.some(e => e.source === A && e.target === n.id)));

  // Re-run adds more versions (keeps the old ones).
  r = await api('/api/auto/video/start', 'POST', { target: A, versions: 1 });
  assert.equal(r.status, 200);
  await settleAuto();
  s = (await api('/api/state')).data;
  assert.equal(branchesOf(s).length, 3, 'rerun adds a version');

  // Output nodes are terminal: cannot generate from them, and can be deleted.
  const term = branchesOf(s)[0].id;
  r = await api('/api/jobs', 'POST', { nodeId: term, kind: 'video' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /phiên bản/);
  r = await api('/api/nodes/delete', 'POST', { id: term });
  assert.equal(r.status, 200);
  assert.ok(!r.data.nodes.some(n => n.id === term));
  assert.ok(!r.data.edges.some(e => e.target === term));
  assert.equal(branchesOf(r.data).length, 2);

  // The key never reaches the browser state.
  assert.ok(!JSON.stringify((await api('/api/state')).data).includes(KEY));
  const projRoot = path.join(dir, 'projects');
  const projJson = fs
    .readdirSync(projRoot)
    .map(id => fs.readFileSync(path.join(projRoot, id, 'project.json'), 'utf8'))
    .join('');
  assert.ok(!projJson.includes(KEY));
  console.log(
    'PASS: key setup, image-to-image (Nano Banana), Veo/Seedance video, idempotency key, reject/fail without resend, video from connected node (refs, single+multi), timeout resume, provider switch, concurrency, auto-video versions+branch+rerun+delete, key not exposed',
  );
} finally {
  proc.kill();
  mock.close();
}
