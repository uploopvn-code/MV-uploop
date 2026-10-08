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
// Small real images of known shapes (encoded with Pillow), to check an edit keeps the shape.
const IMG = {
  JPG_4x3:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDLooorkOoKKKKACiiigAooooAKKKKACiiigD//2Q==',
  PNG_3x4:
    'iVBORw0KGgoAAAANSUhEUgAAAB4AAAAoCAIAAABmcd1FAAAAPklEQVR4nO3QMREAMAjAQIoulFRJ5bOHmaF3eQEZct6t2JFL3TA9+BocAg4Bh4BDwCHgEHAIOAQcAg6BP4c0RScBXjHJn8kAAAAASUVORK5CYII=',
  WEBP_9x16:
    'UklGRjwAAABXRUJQVlA4IDAAAADQAgCdASoSACAAPtFiqk+oJaOiKAgBABoJZwAAPaOgAP7kAX+kulyG/wTTYvLgAAA=',
  WEBPL_1x1: 'UklGRh4AAABXRUJQVlA4TBEAAAAvF8AFAAdQreKVp/+BiOh/AAA=',
};
const KEY = 'sv-test-key-1234';
const API = 'http://127.0.0.1:17794/api/v1';
let submits = [],
  polls = 0,
  cancels = [],
  cancellable = true, // false → Seedvis replies 409 not_cancellable (already generating)
  mode = 'ok',
  holdVideo = false, // true → video jobs stay processing, images still finish
  holdImage = false, // true → image jobs submitted now stay processing until released
  failBudget = 0,
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
    ? {
        error: j.cancelled
          ? { code: 'cancelled', message: 'Cancelled by user' }
          : { code: 'content_policy', message: 'Prompt bị từ chối' },
      }
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
  const cancel = req.url.match(
    /^\/api\/v1\/(?:developer\/generations\/([\w-]+)\/cancel|google\/v1beta\/operations\/([\w-]+):cancel)$/,
  );
  if (cancel && req.method === 'POST') {
    const id = cancel[1] || cancel[2];
    cancels.push(id);
    if (!cancellable)
      return send(409, { error: { code: 'not_cancellable', message: 'already processing' } });
    const j = jobs.get(id);
    if (j && j.status === 'queued') {
      j.status = 'failed';
      j.cancelled = true;
      inFlight--;
    }
    return send(200, {
      success: true,
      data: { id, cancellation: { outcome: 'cancelled', cancelled_outputs: 1 } },
    });
  }
  const poll = req.url.match(/^\/api\/v1\/developer\/generations\/([\w-]+)\?wait=0$/);
  if (poll && req.method === 'GET') {
    polls++;
    const j = jobs.get(poll[1]);
    if (!j) return send(404, { error: { code: 'not_found', message: 'Generation not found' } });
    j.pollCount = (j.pollCount || 0) + 1;
    // Finish on the 2nd poll so parallel jobs overlap (and concurrency is observable).
    if (mode !== 'stuck' && !(holdVideo && j.kind === 'video') && !j.held) {
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
    if (mode === 'drop') return req.socket.destroy();
    const kind = req.url.includes('/google/') ? 'image' : 'video';
    // Like Seedvis: the same Idempotency-Key hands back the job it already has.
    // (a different body under a used key is refused: 409 idempotency_conflict)
    if (jobs.has(id) && jobs.get(id).raw !== raw)
      return send(409, { error: { code: 'idempotency_conflict', message: 'different body' } });
    if (jobs.has(id))
      return kind === 'image'
        ? send(202, lifecycle(id, jobs.get(id)))
        : send(202, { success: true, status: 202, data: lifecycle(id, jobs.get(id)) });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const refs = b.reference_images || b.referenceImages || b.images || (b.image ? [b.image] : []);
    // failBudget: fail the next N submissions outright (transient failures), then succeed.
    const failThis = mode === 'fail' || failBudget > 0;
    if (failBudget > 0) failBudget--;
    jobs.set(id, {
      status: 'queued',
      kind,
      refs,
      count: b.count || 1,
      mode: b.mode,
      failNext: failThis,
      held: holdImage && kind === 'image',
      raw,
    });
    // 'noid': the job is created but the answer carries no id to follow (a lost reply).
    if (mode === 'noid')
      return send(202, { success: true, status: 202, data: { status: 'queued', is_final: false } });
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

  // Project default MODEL: a node whose source is Seedvis but which has not chosen a model uses
  // the project's default model (not only the built-in one), for both image and video. An invalid
  // model id is ignored. Then reset to the built-in defaults for the rest of the suite.
  assert.equal(
    (
      await api('/api/project', 'PATCH', {
        defaults: {
          image: 'seedvis',
          video: 'seedvis',
          imageModel: 'NARWHAL',
          videoModel: 'seedance_2.5',
        },
      })
    ).status,
    200,
  );
  st = (await api('/api/state')).data;
  assert.equal(
    st.defaults.imageModel,
    'NARWHAL',
    'the default image model is stored on the project',
  );
  assert.equal(st.defaults.videoModel, 'seedance_2.5', 'and the default video model');
  const wideP = st.nodes.find(n => n.id === 'wide').providers;
  assert.equal(wideP.image.model, 'NARWHAL', 'a node inherits the project default image model');
  assert.equal(
    wideP.video.model,
    'seedance_2.5',
    'a node inherits the project default video model',
  );
  await api('/api/project', 'PATCH', { defaults: { imageModel: 'not-a-model' } });
  assert.equal(
    (await api('/api/state')).data.defaults.imageModel,
    'NARWHAL',
    'an invalid default model id is rejected',
  );
  await api('/api/project', 'PATCH', {
    defaults: { imageModel: 'GEM_PIX_2', videoModel: 'Veo-3.1' },
  });
  assert.equal(
    (await api('/api/state')).data.nodes.find(n => n.id === 'scene').providers.image.model,
    'GEM_PIX_2',
    'default model reset to the built-in for the rest of the suite',
  );

  // Edit: the node's OWN image goes out with "change only this"; the answer replaces it and
  // the previous image is kept, so a disappointing edit can be swapped back.
  const original = s.nodes.find(n => n.id === 'scene').image;
  const originalBytes = Buffer.from(
    await (await fetch('http://127.0.0.1:17793' + original.url)).arrayBuffer(),
  );
  r = await api('/api/jobs', 'POST', {
    nodeId: 'scene',
    kind: 'image',
    edit: 'make the sky darker',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.job.payload.website, /sửa ảnh/);
  ({ s, j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  const sentEdit = submits.at(-1).body;
  assert.equal(sentEdit.mode, 'image-to-image');
  assert.equal(sentEdit.reference_images.length, 1, 'only the image being edited is sent');
  assert.ok(
    Buffer.from(sentEdit.reference_images[0].data, 'base64').equals(originalBytes),
    'and it is the node’s current image, not its inputs',
  );
  assert.match(
    sentEdit.input,
    /^Edit the attached image\. Change only this: make the sky darker\. Keep everything else exactly as it is/,
  );
  const edited = s.nodes.find(n => n.id === 'scene');
  assert.notEqual(edited.image.url, original.url, 'the new image replaced the old one');
  assert.equal(edited.prevImage.url, original.url, 'the old one is kept');
  r = await api('/api/node/swap-image', 'POST', { id: 'scene' });
  assert.equal(r.data.nodes.find(n => n.id === 'scene').image.url, original.url, 'swapped back');
  r = await api('/api/node/swap-image', 'POST', { id: 'scene' });
  assert.equal(r.data.nodes.find(n => n.id === 'scene').image.url, edited.image.url, 'and forward');
  assert.equal(
    (await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image', edit: '  ' })).status,
    400,
    'an empty request is refused',
  );
  assert.equal(
    (await api('/api/jobs', 'POST', { nodeId: 'wide', kind: 'image', edit: 'x' })).status,
    400,
    'no image yet, nothing to edit',
  );
  const nodeNow = async id => (await api('/api/state')).data.nodes.find(n => n.id === id);
  // An edit only touches up the picture it is sent: when the node's inputs had changed, the
  // edited image is still built on the old ones, so the warning stays.
  await api('/api/upload', 'POST', {
    nodeId: 'singer',
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  assert.equal((await nodeNow('scene')).stale, true, 'a new singer image outdates scene');
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image', edit: 'add rain' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal((await nodeNow('scene')).stale, true, 'the edit keeps the warning');
  // A real re-roll clears it. The image it replaces keeps its own flag: swapping back to it
  // brings the warning back, swapping forward clears it again.
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal((await nodeNow('scene')).stale, false, 're-rolled from the new inputs');
  r = await api('/api/node/swap-image', 'POST', { id: 'scene' });
  assert.equal(
    r.data.nodes.find(n => n.id === 'scene').stale,
    true,
    'the older image is out of date',
  );
  r = await api('/api/node/swap-image', 'POST', { id: 'scene' });
  assert.equal(r.data.nodes.find(n => n.id === 'scene').stale, false, 'and the newer one is not');
  // An edit keeps the image's own shape: it asks for the model ratio closest to the picture,
  // not the node's 16:9 default (that would crop or pad it).
  for (const [base64, mime, want] of [
    [IMG.JPG_4x3, 'image/jpeg', '4:3'],
    [IMG.PNG_3x4, 'image/png', '3:4'],
    [IMG.WEBP_9x16, 'image/webp', '9:16'],
    [IMG.WEBPL_1x1, 'image/webp', '1:1'],
  ]) {
    await api('/api/upload', 'POST', { nodeId: 'scene', mime, base64 });
    r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image', edit: 'add rain' });
    ({ j } = await settle(r.data.job.id));
    assert.equal(j.status, 'completed', j.error);
    assert.equal(submits.at(-1).body.aspect_ratio, want, mime + ' edited as ' + want);
  }
  // A parent re-rolled while a child's image renders: the child comes back out of date.
  holdImage = true;
  const sentBefore = submits.length;
  const wideJob = (await api('/api/jobs', 'POST', { nodeId: 'wide', kind: 'image' })).data.job;
  for (let i = 0; i < 300 && submits.length === sentBefore; i++)
    await new Promise(res => setTimeout(res, 10));
  holdImage = false;
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  for (const mj of jobs.values()) mj.held = false;
  ({ j } = await settle(wideJob.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal((await nodeNow('wide')).stale, true, 'made from the old scene');
  // A re-roll asked while an edit is still running is refused, not answered with the edit.
  mode = 'stuck';
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image', edit: 'add fog' });
  const fogId = r.data.job.id;
  r = await api('/api/jobs', 'POST', { nodeId: 'scene', kind: 'image' });
  assert.equal(r.status, 400, 'not handed the edit job');
  assert.match(r.data.error, /đang sửa ảnh/);
  mode = 'ok';
  ({ j } = await settle(fogId));
  assert.equal(j.status, 'completed', j.error);
  await api('/api/upload', 'POST', {
    nodeId: 'scene',
    mime: 'image/png',
    base64: png.toString('base64'),
  });

  // Video: Veo 3.1 with the shot's image as the single keyframe, always sent at the
  // model's longest duration (8s) so the edit has head and tail to trim.
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
  // The clip becomes its own node in the Video column; the shot keeps its image output.
  const made = s.nodes.find(t => t.terminal && t.source === 'wide' && t.video);
  assert.ok(made, 'a video node was created for the shot');
  assert.equal(made.video.mime, 'video/mp4');
  assert.equal(made.version, 1);
  assert.ok(!s.nodes.find(n => n.id === 'wide').video, 'the clip is not pinned on the shot');
  assert.ok(
    s.edges.some(e => e.source === 'wide' && e.target === made.id),
    'wired from the shot it came from',
  );

  // Seedance takes reference_images and a numeric duration — its longest (30s), not the
  // shot's 12s.
  await api('/api/node', 'PATCH', {
    id: 'wide',
    duration: 12,
    seedvis: { video: { model: 'seedance_2.5', aspectRatio: '16:9' } },
  });
  r = await api('/api/jobs', 'POST', { nodeId: 'wide', kind: 'video' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal(submits.at(-1).body.duration, 30);
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
  assert.ok(s.nodes.some(t => t.terminal && t.source === clip && t.video));

  // Two connected images → Veo multi-image-to-video (referenceImages).
  g = (await api('/api/state')).data;
  await api('/api/edges', 'PUT', { edges: [...g.edges, { source: 'wide', target: clip }] });
  r = await api('/api/jobs', 'POST', { nodeId: clip, kind: 'video' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal(submits.at(-1).body.mode, 'multi-image-to-video');
  assert.equal(submits.at(-1).body.referenceImages.length, 2);

  // Once a refs-mode shot has composed its own image, video uses that exact keyframe
  // (one image, keyframe-prefixed), not the connected parent images.
  await api('/api/node', 'PATCH', {
    id: clip,
    seedvis: { image: { model: 'GEM_PIX_2', aspectRatio: '16:9' } },
  });
  r = await api('/api/jobs', 'POST', { nodeId: clip, kind: 'image' });
  ({ s, j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.ok(s.nodes.find(n => n.id === clip).image, 'shot now has its own image');
  r = await api('/api/jobs', 'POST', { nodeId: clip, kind: 'video' });
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  assert.equal(submits.at(-1).body.mode, 'image-to-video');
  assert.ok(
    submits.at(-1).body.image.file_name.startsWith('keyframe-'),
    'uses the shot own keyframe, not the parent refs',
  );

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
  // The frame is edited while the shot's video still renders: the clip that arrives
  // afterwards was filmed from the frame before the edit, so the shot stays flagged.
  const K = await mkNode('Shot sửa khi đang quay');
  holdVideo = true;
  const kv = (await api('/api/jobs', 'POST', { nodeId: K, kind: 'video' })).data.job.id;
  r = await api('/api/jobs', 'POST', { nodeId: K, kind: 'image', edit: 'make it night' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  holdVideo = false;
  ({ s, j } = await settle(kv));
  assert.equal(j.status, 'completed', j.error);
  assert.equal(s.nodes.find(n => n.id === K).videoStale, true, 'clip made from the old frame');
  assert.equal(s.nodes.find(n => n.terminal && n.source === K).outdated, true);

  // Push max: more than the old cap of 3 submit at once (Seedvis queues the rest).
  const many = [];
  for (let i = 0; i < 5; i++) many.push(await mkNode('Đẩy luồng ' + i));
  maxInFlight = 0;
  const manyJobs = [];
  for (const id of many)
    manyJobs.push((await api('/api/jobs', 'POST', { nodeId: id, kind: 'video' })).data.job.id);
  for (const id of manyJobs) await settle(id);
  assert.ok(maxInFlight >= 4, 'many jobs run in parallel (maxInFlight=' + maxInFlight + ')');

  // --- Quick image batch per zone: generate images for all ready nodes in a zone at once.
  const settleImg = async () => {
    for (let i = 0; i < 300; i++) {
      const run = (await api('/api/state')).data.autoImageRun;
      if (run && run.status !== 'running') return run;
      await new Promise(x => setTimeout(x, 50));
    }
    throw new Error('image batch timed out');
  };
  const C1 = (await api('/api/nodes', 'POST', { name: 'Nhân vật 1' })).data.nodes.at(-1).id;
  const C2 = (await api('/api/nodes', 'POST', { name: 'Nhân vật 2' })).data.nodes.at(-1).id;
  await api('/api/node', 'PATCH', { id: C1, zone: 'character' });
  await api('/api/node', 'PATCH', { id: C2, zone: 'character' });
  r = await api('/api/auto/images/start', 'POST', { zone: 'character' });
  assert.equal(r.status, 200);
  const imgRun = await settleImg();
  assert.equal(imgRun.status, 'completed', JSON.stringify(imgRun.errors));
  s = (await api('/api/state')).data;
  assert.ok(
    s.nodes.find(n => n.id === C1).image && s.nodes.find(n => n.id === C2).image,
    'both character nodes got images',
  );
  // Re-running the same zone finds nothing missing → rejected.
  assert.equal((await api('/api/auto/images/start', 'POST', { zone: 'character' })).status, 400);
  // An invalid zone is rejected.
  assert.equal((await api('/api/auto/images/start', 'POST', { zone: 'setup' })).status, 400);

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
  const branchesBefore = branchesOf((await api('/api/state')).data).length;
  r = await api('/api/auto/video/start', 'POST', { target: A, versions: 2 });
  assert.equal(r.status, 200);
  let run = await settleAuto();
  assert.equal(run.status, 'completed', JSON.stringify(run.errors));
  s = (await api('/api/state')).data;
  let branches = branchesOf(s);
  assert.equal(branches.length, branchesBefore + 2, 'two versions → two more output nodes');
  assert.ok(branches.every(n => n.video && n.terminal && n.video.mime === 'video/mp4'));
  assert.ok(branches.every(n => s.edges.some(e => e.source === A && e.target === n.id)));
  // A clip node feeds nothing and is fed only by its shot.
  r = await api('/api/edges', 'PUT', {
    edges: [...s.edges, { source: branches[0].id, target: 'wide' }],
  });
  assert.equal(r.status, 400, 'no wire out of a clip node');
  assert.match(r.data.error, /không nối ra node khác/);
  r = await api('/api/edges', 'PUT', {
    edges: [...s.edges, { source: 'scene', target: branches[0].id }],
  });
  assert.equal(r.status, 400, 'no foreign wire into a clip node');
  assert.match(r.data.error, /chỉ nhận dây từ shot/);
  r = await api('/api/edges', 'PUT', { edges: s.edges });
  assert.equal(r.status, 200, 'the existing wires still save');
  branches = branches.slice(-2); // the two this run produced

  // Download several videos as one ZIP named by shot.
  const zr = await fetch('http://127.0.0.1:17793/api/videos/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: branches.map(n => n.id) }),
  });
  assert.equal(zr.status, 200);
  assert.match(zr.headers.get('content-type'), /zip/);
  assert.match(zr.headers.get('content-disposition') || '', /attachment/);
  const zbuf = Buffer.from(await zr.arrayBuffer());
  assert.equal(zbuf.subarray(0, 4).toString('hex'), '504b0304', 'starts with the ZIP magic');
  assert.equal(zbuf.readUInt16LE(zbuf.length - 12), 2, 'archive has two entries');
  for (const b of branches)
    assert.ok(
      zbuf.toString('latin1').includes('_v' + b.version + '.mp4'),
      'entry named by its own version v' + b.version,
    );
  assert.deepEqual(
    branches.map(b => b.version),
    [branchesBefore + 1, branchesBefore + 2],
    'versions continue after the clips the shot already had',
  );
  // Empty / unknown selection is rejected.
  const zbad = await fetch('http://127.0.0.1:17793/api/videos/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(zbad.status, 400);

  // The video serves inline for playback, but ?dl=<name> forces a download.
  const vurl = 'http://127.0.0.1:17793' + branches[0].video.url;
  let dls = await fetch(vurl);
  assert.equal(dls.headers.get('content-type'), 'video/mp4');
  assert.ok(!dls.headers.get('content-disposition'), 'plain fetch plays inline');
  await dls.arrayBuffer();
  dls = await fetch(vurl + '?dl=' + encodeURIComponent('01_Cảnh — A_v1.mp4'));
  assert.match(dls.headers.get('content-disposition') || '', /attachment/);
  assert.match(dls.headers.get('content-disposition') || '', /filename\*=UTF-8''/);
  await dls.arrayBuffer();

  // Re-run adds more versions (keeps the old ones).
  r = await api('/api/auto/video/start', 'POST', { target: A, versions: 1 });
  assert.equal(r.status, 200);
  await settleAuto();
  s = (await api('/api/state')).data;
  assert.equal(branchesOf(s).length, branchesBefore + 3, 'rerun adds a version');

  // Auto-video is scoped to the production zone: a character/scene node with its own
  // image is never auto-filmed, even when targeted directly.
  const charNode = await mkNode('Nhân vật có ảnh');
  await api('/api/node', 'PATCH', { id: charNode, zone: 'character' });
  r = await api('/api/auto/video/start', 'POST', { target: charNode, versions: 1 });
  assert.equal(r.status, 400, 'character-zone node is not eligible for auto video');

  // Failed video jobs can be re-run in one command (auto-video retry).
  const F = await mkNode('Shot lỗi');
  mode = 'fail';
  r = await api('/api/auto/video/start', 'POST', { target: F, versions: 1 });
  assert.equal(r.status, 200);
  await settleAuto();
  s = (await api('/api/state')).data;
  assert.ok(
    s.jobs.some(j => j.nodeId === F && j.kind === 'video' && j.status === 'failed'),
    'the video job failed',
  );
  // Retry now succeeds: produces an output branch and clears the failed job.
  mode = 'ok';
  r = await api('/api/auto/video/retry', 'POST', { versions: 1 });
  assert.equal(r.status, 200);
  const retryRun = await settleAuto();
  assert.equal(retryRun.status, 'completed', JSON.stringify(retryRun.errors));
  s = (await api('/api/state')).data;
  assert.ok(
    s.nodes.some(n => n.terminal && n.source === F && n.video),
    'retry produced a video',
  );
  assert.ok(
    !s.jobs.some(j => j.nodeId === F && j.kind === 'video' && j.status === 'failed'),
    'failed job cleared after retry',
  );
  // Nothing left to retry.
  assert.equal((await api('/api/auto/video/retry', 'POST', {})).status, 400);
  // A shot whose video failed and was then filmed by hand is done: retry must not pay for an
  // extra clip of it.
  const Gx = await mkNode('Shot lỗi rồi làm lại tay');
  mode = 'fail';
  await api('/api/auto/video/start', 'POST', { target: Gx, versions: 1 });
  await settleAuto();
  mode = 'ok';
  r = await api('/api/jobs', 'POST', { nodeId: Gx, kind: 'video' });
  ({ s } = await settle(r.data.job.id));
  assert.ok(
    s.nodes.some(n => n.terminal && n.source === Gx && n.video),
    'filmed by hand',
  );
  assert.equal(
    (await api('/api/auto/video/retry', 'POST', {})).status,
    400,
    'its latest video job succeeded, so nothing is left to retry',
  );

  // Transient failures are retried automatically inside the run, up to 3 times per shot:
  // the first two submissions fail, the third succeeds, and the run still completes.
  const R1 = await mkNode('Shot lỗi tạm thời');
  failBudget = 2;
  r = await api('/api/auto/video/start', 'POST', { target: R1, versions: 1 });
  assert.equal(r.status, 200);
  const retriedRun = await settleAuto();
  assert.equal(retriedRun.status, 'completed', JSON.stringify(retriedRun.errors));
  assert.equal(retriedRun.retried, 2, 'two automatic retries');
  assert.match(retriedRun.message, /chạy lại 2 lượt/);
  s = (await api('/api/state')).data;
  assert.deepEqual(
    s.jobs.filter(j => j.nodeId === R1 && j.kind === 'video').map(j => j.status),
    ['retried', 'retried', 'completed'],
    'failed attempts stay listed as retried',
  );
  assert.ok(
    s.nodes.some(n => n.terminal && n.source === R1 && n.video),
    'video produced on the third attempt',
  );
  assert.ok(
    !s.jobs.some(j => j.nodeId === R1 && j.status === 'failed'),
    'nothing left as failed for the manual retry',
  );
  // After 1 + 3 attempts the shot is reported as failed and offered to the manual retry.
  const R2 = await mkNode('Shot lỗi mãi');
  failBudget = 10;
  r = await api('/api/auto/video/start', 'POST', { target: R2, versions: 1 });
  assert.equal(r.status, 200);
  const exhausted = await settleAuto();
  failBudget = 0;
  assert.equal(exhausted.status, 'blocked');
  assert.equal(exhausted.retried, 3);
  assert.match(exhausted.errors[0], /đã thử 4 lần/);
  assert.match(exhausted.message, /tối đa 3 lần/);
  s = (await api('/api/state')).data;
  assert.deepEqual(
    s.jobs.filter(j => j.nodeId === R2 && j.kind === 'video').map(j => j.status),
    ['retried', 'retried', 'retried', 'failed'],
    '1 attempt + 3 retries, last one failed',
  );
  assert.equal(
    (await api('/api/auto/video/retry', 'POST', { versions: 1 })).status,
    200,
    'the exhausted shot is offered to the manual retry',
  );
  await settleAuto();

  // Over the video model's reference limit (Veo: 3): a refs-mode shot with 4 image parents
  // reports it, cannot film directly, and the auto run composes its keyframe first.
  const refNodes = [];
  for (let i = 0; i < 4; i++) refNodes.push(await mkNode('Tham chiếu ' + i));
  let g2 = (await api('/api/nodes', 'POST', { name: 'Shot 4 tham chiếu' })).data;
  const big = g2.nodes.at(-1).id;
  await api('/api/node', 'PATCH', {
    id: big,
    videoInput: 'refs',
    seedvis: {
      video: { model: 'Veo-3.1', aspectRatio: '16:9' },
      image: { model: 'GEM_PIX_2', aspectRatio: '16:9' },
    },
  });
  g2 = (await api('/api/state')).data;
  await api('/api/edges', 'PUT', {
    edges: [...g2.edges, ...refNodes.map(source => ({ source, target: big }))],
  });
  s = (await api('/api/state')).data;
  const bn = s.nodes.find(n => n.id === big);
  assert.equal(bn.imageInputs, 4, 'four image inputs');
  assert.equal(bn.settingInputs, 0, 'no style/camera input');
  assert.equal(bn.videoRefLimit, 3, 'Veo takes 3 reference images');
  assert.equal(bn.videoNeedsKeyframe, true, 'over the limit → keyframe first');
  r = await api('/api/jobs', 'POST', { nodeId: big, kind: 'video' });
  assert.equal(r.status, 400, 'direct video over the limit is refused');
  assert.match(r.data.error, /khung hình/);
  // The auto run queues the keyframe image (all 4 refs) first, then films from it.
  r = await api('/api/auto/video/start', 'POST', { target: big, versions: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.autoVideoRun.message, /khung hình/);
  const bigRun = await settleAuto();
  assert.equal(bigRun.status, 'completed', JSON.stringify(bigRun.errors));
  s = (await api('/api/state')).data;
  assert.ok(s.nodes.find(n => n.id === big).image, 'keyframe composed');
  const kf = s.jobs.find(j => j.nodeId === big && j.kind === 'image');
  assert.equal(kf.status, 'completed');
  assert.equal(kf.payload.references.length, 4, 'keyframe used all 4 refs');
  const vj = s.jobs.find(j => j.nodeId === big && j.kind === 'video');
  assert.equal(vj.payload.references.length, 1, 'video filmed from the single keyframe');
  assert.ok(
    s.nodes.some(n => n.terminal && n.source === big && n.video),
    'video produced after the keyframe',
  );
  // Within the limit (3 refs) the refs go straight into the video request.
  g2 = (await api('/api/state')).data;
  await api('/api/edges', 'PUT', {
    edges: g2.edges.filter(e => !(e.target === big && e.source === refNodes[3])),
  });
  s = (await api('/api/state')).data;
  assert.equal(s.nodes.find(n => n.id === big).imageInputs, 3);
  assert.equal(s.nodes.find(n => n.id === big).videoNeedsKeyframe, false);

  // "Dừng" actually stops: a running (stuck) job is aborted and the workflow unlocks.
  mode = 'stuck';
  const G = await mkNode('Shot kẹt');
  const stuckId = (await api('/api/jobs', 'POST', { nodeId: G, kind: 'video' })).data.job.id;
  await new Promise(res => setTimeout(res, 150));
  assert.equal(
    (await api('/api/state')).data.jobs.find(j => j.id === stuckId).status,
    'running',
    'job is running',
  );
  // While running, editing is blocked.
  assert.equal((await api('/api/node', 'PATCH', { id: G, name: 'x' })).status, 400);
  // Press stop → editing is allowed again immediately (the job is detached/aborted).
  // No auto-run is active here (the job came from the node's own button): stop must still
  // work and report what it did, so the UI can keep its "Dừng" button enabled for this case.
  const stopR = await api('/api/auto/video/stop', 'POST', {});
  assert.equal(stopR.status, 200);
  assert.deepEqual(
    stopR.data.stopped,
    { cancelled: 0, detached: 1 },
    'stop reports the detached running job',
  );
  assert.equal(
    (await api('/api/node', 'PATCH', { id: G, name: 'Đã sửa sau khi dừng' })).status,
    200,
    'stop unlocks editing',
  );
  // The aborted job settles to cancelled.
  let stuck;
  for (let i = 0; i < 100; i++) {
    stuck = (await api('/api/state')).data.jobs.find(j => j.id === stuckId);
    if (stuck.status === 'cancelled') break;
    await new Promise(res => setTimeout(res, 30));
  }
  assert.equal(stuck.status, 'cancelled', 'stop cancels the running job');
  // Stop also asked Seedvis to cancel the upstream job (refunds it if still queued).
  for (let i = 0; i < 50 && !cancels.length; i++) await new Promise(res => setTimeout(res, 20));
  assert.ok(cancels.length >= 1, 'server called the Seedvis cancel endpoint');

  // If Seedvis cannot cancel (already generating), the job keeps running and its result
  // is still stored into the workflow when it finishes — not discarded.
  cancellable = false;
  mode = 'stuck';
  const H = await mkNode('Shot không hủy được');
  const hId = (await api('/api/jobs', 'POST', { nodeId: H, kind: 'video' })).data.job.id;
  await new Promise(res => setTimeout(res, 150));
  await api('/api/auto/video/stop', 'POST', {}); // 409 not_cancellable → stays running
  // Creating a project no longer waits on this one — each project is its own ordering
  // system — but it must not move THIS window: the clip still being generated has to land in
  // the project that ordered it. So the new project opens in a window of its own.
  const activeBefore = (await api('/api/state')).data.name;
  r = await api('/api/projects', 'POST', {
    name: 'X',
    theme: 'music',
    exportDir: path.join(dir, 'x'),
  });
  assert.equal(r.status, 201);
  assert.ok(r.data.opened?.url, 'project mới mở ở cửa sổ riêng');
  assert.equal(r.data.name, activeBefore, 'cửa sổ này vẫn giữ project có clip đang chạy ngầm');
  // Switching this window is still refused, for exactly that reason.
  assert.match(
    (await api('/api/projects/switch', 'POST', { id: r.data.opened.id })).data.error,
    /chạy ngầm/,
  );
  await api('/api/projects/close-window', 'POST', { id: r.data.opened.id });
  // Editing is unlocked even though the job still runs in the background.
  assert.equal((await api('/api/node', 'PATCH', { id: H, name: 'Sửa khi chạy nền' })).status, 200);
  // The generation finishes → its video lands on the node.
  mode = 'ok';
  const { s: hs, j: hj } = await settle(hId);
  assert.equal(hj.status, 'completed', 'uncancellable job completes');
  assert.ok(
    hs.nodes.some(t => t.terminal && t.source === H && t.video),
    'finished video is stored into the workflow',
  );
  // The same, but the shot is deleted before the clip arrives: the clip stays on the job and
  // no node hangs from a missing shot (that wire used to blank the page and lock edits).
  mode = 'stuck';
  const X = await mkNode('Shot sẽ bị xóa');
  const xId = (await api('/api/jobs', 'POST', { nodeId: X, kind: 'video' })).data.job.id;
  await new Promise(res => setTimeout(res, 150));
  await api('/api/auto/video/stop', 'POST', {});
  assert.equal((await api('/api/nodes/delete', 'POST', { id: X })).status, 200);
  mode = 'ok';
  const { s: xs, j: xj } = await settle(xId);
  assert.equal(xj.status, 'completed');
  assert.ok(xj.result, 'the clip is kept on the job for download');
  assert.ok(!xs.nodes.some(n => n.source === X), 'no clip node for a deleted shot');
  assert.ok(!xs.edges.some(e => e.source === X || e.target === X), 'no dangling wire');
  assert.equal(
    (await api('/api/edges', 'PUT', { edges: xs.edges })).status,
    200,
    'wires still save',
  );
  cancellable = true;
  mode = 'ok';

  // An old project, opened again: "✚ Tạo video còn thiếu" covers every shot without a clip,
  // whatever stopped it, and never pays twice for one Seedvis may already have rendered.
  // R: its job timed out (needs_review), Seedvis finished it meanwhile → checked again.
  mode = 'stuck';
  const R = await mkNode('Shot chờ xử lý');
  ({ j } = await settle(
    (await api('/api/jobs', 'POST', { nodeId: R, kind: 'video' })).data.job.id,
  ));
  assert.equal(j.status, 'needs_review');
  assert.ok(j.remote.id, 'Seedvis gave it an id');
  mode = 'ok';
  r = await api('/api/auto/video/start', 'POST', { target: R, versions: 1 });
  assert.equal(r.status, 400, '"▶ Tạo video" never films it a second time');
  assert.match(r.data.error, /chờ xử lý/);
  // N: Seedvis never confirmed it (the reply carried no id) → sent again under the SAME
  // Idempotency-Key, so Seedvis hands back the job it has.
  mode = 'noid';
  const N = await mkNode('Shot chưa xác nhận gửi');
  const nJob = (await api('/api/jobs', 'POST', { nodeId: N, kind: 'video' })).data.job.id;
  ({ j } = await settle(nJob));
  assert.equal(j.status, 'needs_review');
  assert.ok(!j.remote?.id);
  // RP: like R, but its prompt was changed after the job left: its clip is out of date.
  mode = 'stuck';
  const RP = await mkNode('Shot chờ xử lý, đã sửa prompt');
  ({ j } = await settle(
    (await api('/api/jobs', 'POST', { nodeId: RP, kind: 'video' })).data.job.id,
  ));
  assert.equal(j.status, 'needs_review');
  await api('/api/node', 'PATCH', { id: RP, videoPrompt: 'a different camera move' });
  // F2: its last job failed → filmed again. M2: never filmed → filmed.
  mode = 'reject';
  const F2 = await mkNode('Shot lỗi cũ');
  ({ j } = await settle(
    (await api('/api/jobs', 'POST', { nodeId: F2, kind: 'video' })).data.job.id,
  ));
  assert.equal(j.status, 'failed');
  mode = 'ok';
  const M2 = await mkNode('Shot chưa có video');
  s = (await api('/api/state')).data;
  for (const id of [R, N, F2, M2])
    assert.ok(s.missingVideo.includes(id), 'counted on the button: ' + id);
  // Only shots whose job has a Seedvis id are polled; every other missing one is one POST.
  const lastVideo = id => s.jobs.filter(x => x.nodeId === id && x.kind === 'video').at(-1);
  const polledOnly = s.missingVideo.filter(
    id => lastVideo(id)?.status === 'needs_review' && lastVideo(id).remote?.id,
  ).length;
  const videoPosts = () => submits.filter(x => !x.url.includes('/google/')).length;
  const videoJobs = () => [...jobs.values()].filter(x => x.kind === 'video').length;
  const [postsBefore, jobsBefore, missingBefore] = [
    videoPosts(),
    videoJobs(),
    s.missingVideo.length,
  ];
  r = await api('/api/auto/video/missing', 'POST', { versions: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.autoVideoRun.message, /kiểm tra lại/);
  run = await settleAuto();
  assert.equal(run.status, 'completed', run.message);
  s = (await api('/api/state')).data;
  for (const id of [R, N, F2, M2])
    assert.ok(
      s.nodes.some(n => n.terminal && n.source === id && n.video),
      'the shot has its clip: ' + id,
    );
  // Clips that come home from an old job: current when made from the shot's current images
  // and prompt (R, although the project changed meanwhile), out of date otherwise (RP).
  const clipOf = id => s.nodes.find(n => n.terminal && n.source === id);
  assert.equal(clipOf(R).outdated, false, 'R: same inputs, no false warning');
  assert.equal(s.nodes.find(n => n.id === R).videoStale, false);
  assert.equal(clipOf(RP).outdated, true, 'RP: made from the old prompt');
  assert.equal(s.nodes.find(n => n.id === RP).videoStale, true);
  assert.equal(videoPosts() - postsBefore, missingBefore - polledOnly, 'R was only polled');
  assert.equal(submits.filter(x => x.id === nJob).length, 2, 'N re-sent under its own key');
  assert.equal(
    videoJobs() - jobsBefore,
    missingBefore - polledOnly - 1,
    'Seedvis made no second job for R or N',
  );
  assert.ok(!s.missingVideo.some(id => [R, N, F2, M2].includes(id)), 'nothing left missing');
  // Refused before sending (more reference images than the model takes): a plain failure,
  // not "check Seedvis" — nothing is pending there, so it is filmed again later.
  const refs11 = [];
  for (let i = 0; i < 11; i++) refs11.push(await mkNode('Ảnh tham chiếu ' + i));
  const T11 = await mkNode('Quá nhiều ảnh');
  st = (await api('/api/state')).data;
  r = await api('/api/edges', 'PUT', {
    edges: [...st.edges, ...refs11.map(source => ({ source, target: T11 }))],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ({ j } = await settle(
    (await api('/api/jobs', 'POST', { nodeId: T11, kind: 'image' })).data.job.id,
  ));
  assert.equal(j.status, 'failed', 'not needs_review');
  assert.match(j.error, /tối đa 10/);

  // More old-project shapes — none may be paid for twice.
  // W1: an old job interrupted while Seedvis rendered it, then a NEWER job that failed. The
  //     old one is still checked (its clip comes home); the newer failure hides nothing.
  mode = 'stuck';
  const W1 = await mkNode('Shot lỗi sau tác vụ treo');
  ({ j } = await settle(
    (await api('/api/jobs', 'POST', { nodeId: W1, kind: 'video' })).data.job.id,
  ));
  assert.equal(j.status, 'needs_review');
  mode = 'reject';
  ({ j } = await settle(
    (await api('/api/jobs', 'POST', { nodeId: W1, kind: 'video' })).data.job.id,
  ));
  assert.equal(j.status, 'failed');
  // W2: an old version's "Dừng" marked a job cancelled while Seedvis was already rendering it.
  // W3: Seedvis no longer knows an old job id at all (404): filmed again.
  mode = 'stuck';
  const W2 = await mkNode('Shot bị dừng bởi bản cũ');
  const w2Job = (await api('/api/jobs', 'POST', { nodeId: W2, kind: 'video' })).data.job.id;
  ({ j } = await settle(w2Job));
  const W3 = await mkNode('Shot có mã Seedvis đã mất');
  const w3Job = (await api('/api/jobs', 'POST', { nodeId: W3, kind: 'video' })).data.job.id;
  ({ s } = await settle(w3Job));
  // Rewrite those two jobs on disk the way older versions left them, then reload the project.
  const pFile = path.join(dir, 'projects', s.activeProjectId, 'project.json');
  const disk = JSON.parse(fs.readFileSync(pFile, 'utf8'));
  Object.assign(
    disk.jobs.find(x => x.id === w2Job),
    {
      status: 'cancelled',
      aborted: true,
      progress: 'Đã dừng theo yêu cầu',
      remote: { ...disk.jobs.find(x => x.id === w2Job).remote, status: 'processing' },
    },
  );
  disk.jobs.find(x => x.id === w3Job).remote.id = 'gone-' + w3Job;
  disk.jobs.find(x => x.id === w3Job).remote.pollUrl = null;
  fs.writeFileSync(pFile, JSON.stringify(disk));
  r = await api('/api/projects', 'POST', {
    name: 'Tạm',
    theme: 'music',
    exportDir: path.join(dir, 'tam'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await api('/api/projects/switch', 'POST', { id: s.activeProjectId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // M2: has a clip, but its latest job was interrupted → checked too (another version comes).
  mode = 'stuck';
  const aStuck = (await api('/api/jobs', 'POST', { nodeId: M2, kind: 'video' })).data.job.id;
  ({ s } = await settle(aStuck));
  assert.ok(s.recheckVideo >= 1, 'a shot with a clip and a job to check is counted apart');
  // D: the connection died while sending and the user pressed Dừng before the retry:
  //    unknown whether Seedvis took it → "to check", never "never sent".
  mode = 'drop';
  const D = await mkNode('Shot mất kết nối khi gửi');
  const dJob = (await api('/api/jobs', 'POST', { nodeId: D, kind: 'video' })).data.job.id;
  await new Promise(res => setTimeout(res, 400));
  await api('/api/auto/video/stop', 'POST', {});
  ({ s, j } = await settle(dJob));
  assert.equal(j.status, 'needs_review', 'not "cancelled": it may have reached Seedvis');
  // Release W1's and W2's renders at "Seedvis", then run "✚".
  mode = 'ok';
  for (const id of [w2Job]) if (jobs.has(id)) jobs.get(id).pollCount = 5;
  const postsFor = id =>
    submits.filter(x => x.id && s.jobs.find(y => y.id === x.id)?.nodeId === id).length;
  s = (await api('/api/state')).data;
  const postsBefore2 = Object.fromEntries([W1, W2, W3, D].map(id => [id, postsFor(id)]));
  const clipsBefore = s.nodes.filter(n => n.terminal && n.source === M2).length;
  r = await api('/api/auto/video/missing', 'POST', { versions: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  run = await settleAuto();
  s = (await api('/api/state')).data;
  const clipOfShot = id => s.nodes.some(n => n.terminal && n.source === id && n.video);
  for (const id of [W1, W2, W3, D]) assert.ok(clipOfShot(id), 'the shot has its clip: ' + id);
  assert.equal(
    postsFor(W1),
    postsBefore2[W1],
    'W1: the hidden old job was polled, nothing re-sent',
  );
  assert.equal(
    postsFor(W2),
    postsBefore2[W2],
    'W2: the old stopped job was polled, nothing re-sent',
  );
  assert.equal(postsFor(W3), postsBefore2[W3] + 1, 'W3: Seedvis lost it (404) → filmed once more');
  assert.equal(
    submits.filter(x => x.id === dJob).length >= 2,
    true,
    'D: re-sent under its own key',
  );
  assert.equal(
    s.nodes.filter(n => n.terminal && n.source === M2).length,
    clipsBefore + 1,
    'M2: the interrupted version came home too',
  );

  // Output nodes are terminal: cannot generate from them, and can be deleted.
  const term = branchesOf(s)[0].id;
  r = await api('/api/jobs', 'POST', { nodeId: term, kind: 'video' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /phiên bản/);
  r = await api('/api/nodes/delete', 'POST', { id: term });
  assert.equal(r.status, 200);
  assert.ok(!r.data.nodes.some(n => n.id === term));
  assert.ok(!r.data.edges.some(e => e.target === term));
  assert.equal(branchesOf(r.data).length, branchesBefore + 2, 'one version node removed');

  // --- Seedance groups: consecutive shots filmed in ONE Seedance render, from a storyboard.
  // A fresh project: scene → wide, medium (10 s), close (5 s); stage → S4, S5 (10 s), S6 (23 s).
  r = await api('/api/projects', 'POST', {
    name: 'Seedance',
    theme: 'music',
    exportDir: path.join(dir, 'seedance-folder'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  for (const id of ['singer', 'stage', 'scene', 'wide', 'medium', 'close'])
    await api('/api/upload', 'POST', {
      nodeId: id,
      mime: 'image/png',
      base64: png.toString('base64'),
    });
  for (const [id, duration] of [
    ['wide', 10],
    ['medium', 10],
    ['close', 5],
  ])
    await api('/api/node', 'PATCH', { id, duration });
  const S4 = await mkNode('S4'),
    S5 = await mkNode('S5'),
    S6 = await mkNode('S6');
  for (const [id, duration] of [
    [S4, 10],
    [S5, 10],
    [S6, 23],
  ])
    await api('/api/node', 'PATCH', { id, duration });
  st = (await api('/api/state')).data;
  r = await api('/api/edges', 'PUT', {
    edges: [...st.edges, ...[S4, S5, S6].map(target => ({ source: 'stage', target }))],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('/api/seedance/groups', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // A group fills toward 30 s across scene changes (scene + stage may share one render), and
  // ends only before the next shot would pass 30 s: {wide,medium,close}=25 s, then {S4,S5}=20 s,
  // then the 23 s S6 on its own.
  assert.equal(r.data.created.length, 3, 'two 30 s-capped runs, then the long shot');
  const groupOf = (s, id) => s.nodes.find(n => n.id === id);
  const membersOf = (s, id) =>
    s.edges.filter(e => e.target === id).map(e => groupOf(s, e.source).name);
  const [G1, G2, G3] = r.data.created;
  assert.deepEqual(membersOf(r.data, G1).sort(), ['Cận cảnh', 'Toàn cảnh', 'Trung cảnh'].sort());
  assert.deepEqual(membersOf(r.data, G2).sort(), ['S4', 'S5']);
  assert.deepEqual(membersOf(r.data, G3), ['S6']);
  let grp = groupOf(r.data, G1);
  assert.equal(grp.zone, 'seedance');
  assert.equal(grp.seedance.model, 'seedance_2.5');
  assert.deepEqual([grp.seedance.total, grp.seedance.D], [25, 25]);
  assert.deepEqual([groupOf(r.data, G3).seedance.total, groupOf(r.data, G3).seedance.D], [23, 25]);
  // The prompt: each shot keeps its own length, a hard cut at each timecode, the storyboard
  // is image 1, and the seconds left over are a still tail to trim.
  let gp = grp.resolvedPrompts.video;
  assert.match(gp, /^Create a 25-second cinematic photorealistic video/);
  assert.match(gp, /Image 1 is the storyboard: panels 1–3/);
  assert.match(gp, /Shot 1 \(0–10s\): .+\nShot 2 \(10–20s\): .+\nShot 3 \(20–25s\): /);
  assert.match(
    gp,
    /Image 3: the opening frame of shot 1/,
    'at least 3 images: no first/last-frame mode',
  );
  assert.doesNotMatch(gp, /hold on the last shot/, 'no tail when the shots fill the render');
  assert.match(
    groupOf(r.data, G3).resolvedPrompts.video,
    /23–25s: hold on the last shot with only subtle natural movement/,
  );
  // No storyboard yet: refused. A group never makes an image of its own.
  r = await api('/api/jobs', 'POST', { nodeId: G1, kind: 'video' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /storyboard/);
  assert.equal((await api('/api/jobs', 'POST', { nodeId: G1, kind: 'image' })).status, 400);
  // The storyboard (the browser composes it from the keyframes; here a ready image) → render.
  await api('/api/upload', 'POST', {
    nodeId: G1,
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  r = await api('/api/jobs', 'POST', { nodeId: G1, kind: 'video' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ({ s, j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  const sentGroup = submits.at(-1).body;
  assert.equal(sentGroup.model, 'seedance_2.5');
  assert.equal(sentGroup.duration, 25, 'the shots’ total, not the model maximum (30)');
  assert.equal(sentGroup.reference_images.length, 3, 'storyboard + scene + a keyframe');
  assert.match(sentGroup.reference_images[0].file_name, /^storyboard-/);
  assert.equal(sentGroup.prompt, gp);
  const gClip = s.nodes.find(n => n.terminal && n.source === G1);
  assert.ok(gClip?.video, 'the clip lands in the Video column, wired from the group');
  assert.equal(gClip.duration, 25);
  assert.equal(gClip.zone, 'seedance-video', 'a group clip goes to ⑩ Video Seedance, not ⑧ Video');
  // Shots wired into a group are its business: "✚" and "▶" never film them one by one.
  assert.deepEqual(s.missingVideo, [], 'no grouped shot counted as missing');
  r = await api('/api/auto/video/missing', 'POST', { versions: 1 });
  assert.equal(r.status, 400, 'and none filmed one by one: ' + JSON.stringify(r.data));
  r = await api('/api/auto/video/start', 'POST', { versions: 1 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /thuộc nhóm Seedance/);
  // A group clip saved in ⑧ Video (before the Seedance column existed) moves there on open.
  {
    const id = s.activeProjectId;
    const file = path.join(dir, 'projects', id, 'project.json');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.nodes.find(n => n.id === gClip.id).zone = 'output';
    fs.writeFileSync(file, JSON.stringify(disk));
    const other = s.projects.find(x => x.id !== id).id;
    assert.equal((await api('/api/projects/switch', 'POST', { id: other })).status, 200);
    r = await api('/api/projects/switch', 'POST', { id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.nodes.find(n => n.id === gClip.id).zone, 'seedance-video');
  }
  // A shot's new keyframe outdates the storyboard (rebuild it) and the group's clip.
  r = await api('/api/upload', 'POST', {
    nodeId: 'medium',
    mime: 'image/png',
    base64: IMG.PNG_3x4,
  });
  grp = groupOf(r.data, G1);
  assert.equal(grp.stale, true, 'storyboard out of date');
  assert.equal(grp.videoStale, true, 'clip out of date');
  r = await api('/api/jobs', 'POST', { nodeId: G1, kind: 'video' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /dựng lại|Dựng storyboard/);
  // Rebuilt and filmed again: current. Then a changed line outdates the group's clip.
  await api('/api/upload', 'POST', {
    nodeId: G1,
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  ({ s } = await settle(
    (await api('/api/jobs', 'POST', { nodeId: G1, kind: 'video' })).data.job.id,
  ));
  assert.equal(groupOf(s, G1).videoStale, false);
  r = await api('/api/node', 'PATCH', { id: 'wide', lyric: 'a new line' });
  assert.equal(groupOf(r.data, G1).videoStale, true, 'the group films that line too');
  assert.match(groupOf(r.data, G1).resolvedPrompts.video, /Line: "a new line"\./);
  assert.doesNotMatch(groupOf(r.data, G1).resolvedPrompts.video, /\\"/, 'no escaped quotes');
  // The Seedance column holds the groups only.
  assert.equal((await api('/api/node', 'PATCH', { id: 'wide', zone: 'seedance' })).status, 400);
  assert.equal((await api('/api/node', 'PATCH', { id: G1, zone: 'production' })).status, 400);
  // A shot moved in the timeline reorders the group: its storyboard no longer matches.
  r = await api('/api/node', 'PATCH', { id: 'close', seq: 1 });
  assert.match(groupOf(r.data, G1).seedance.problem, /Thứ tự hoặc danh sách shot/);
  assert.equal(groupOf(r.data, G1).stale, true);
  assert.equal((await api('/api/jobs', 'POST', { nodeId: G1, kind: 'video' })).status, 400);
  // A group render that timed out may be done at Seedvis: no new render until it is checked
  // (free); "↻ Kiểm tra lại" brings the clip home without sending anything.
  for (const id of [S4, S5])
    // wiring the stage into them earlier outdated their keyframes
    await api('/api/upload', 'POST', {
      nodeId: id,
      mime: 'image/png',
      base64: png.toString('base64'),
    });
  await api('/api/upload', 'POST', {
    nodeId: G2,
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  mode = 'stuck';
  r = await api('/api/jobs', 'POST', { nodeId: G2, kind: 'video' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'needs_review');
  mode = 'ok';
  r = await api('/api/jobs', 'POST', { nodeId: G2, kind: 'video' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /chờ kiểm tra/);
  const groupPosts = submits.filter(x => x.body.model === 'seedance_2.5').length;
  r = await api('/api/seedance/recheck', 'POST', { id: G2 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  run = await settleAuto();
  s = (await api('/api/state')).data;
  assert.ok(
    s.nodes.some(n => n.terminal && n.source === G2 && n.video),
    'the render came home',
  );
  assert.equal(
    submits.filter(x => x.body.model === 'seedance_2.5').length,
    groupPosts,
    'nothing sent again',
  );
  // Every shot is in a group now.
  r = await api('/api/seedance/groups', 'POST', {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /đã thuộc một nhóm/);
  // Seedance 2.0 Fast renders up to 15 s: the 23 s group no longer fits.
  r = await api('/api/node', 'PATCH', {
    id: G3,
    seedvis: { video: { model: 'seedance_2.0_fast', aspectRatio: '16:9' } },
  });
  assert.match(groupOf(r.data, G3).seedance.problem, /quá 15 giây/);

  // "Chia lại": re-split the whole timeline but keep any group a render was spent on. G1 and G2
  // have clips, so they survive; only the unrendered 23 s G3 is dropped and its S6 re-grouped.
  const groupIds = (await api('/api/state')).data.nodes
    .filter(n => n.zone === 'seedance')
    .map(n => n.id);
  assert.deepEqual(groupIds.sort(), [G1, G2, G3].sort(), 'three groups before re-split');
  r = await api('/api/seedance/groups', 'POST', { resplit: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created.length, 1, 'only the freed S6 is re-grouped');
  const [G3b] = r.data.created;
  assert.notEqual(G3b, G3, 'the unrendered group was dropped and replaced');
  assert.ok(
    r.data.nodes.some(n => n.id === G1),
    'rendered G1 kept',
  );
  assert.ok(
    r.data.nodes.some(n => n.id === G2),
    'rendered G2 kept',
  );
  assert.ok(!r.data.nodes.some(n => n.id === G3), 'unrendered G3 dropped');
  assert.deepEqual(membersOf(r.data, G3b), ['S6'], 'S6 re-grouped on its own');
  assert.ok(
    r.data.nodes.some(n => n.terminal && n.source === G1 && n.video),
    'G1 keeps its clip',
  );
  assert.ok(
    r.data.nodes.some(n => n.terminal && n.source === G2 && n.video),
    'G2 keeps its clip',
  );

  // --- A group that cuts between locations: the prompt names each shot's own scene image, so
  // Seedance films the right place at each cut (not "one continuous scene").
  r = await api('/api/projects', 'POST', {
    name: 'Đa cảnh',
    theme: 'film',
    exportDir: path.join(dir, 'multi-folder'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sheetId = async name =>
    (await api('/api/nodes', 'POST', { kind: 'scene', name })).data.nodes.find(n => n.name === name)
      .id;
  const SA = await sheetId('Phòng khách'),
    SB = await sheetId('Ban công');
  const shotId = async name =>
    (await api('/api/nodes', 'POST', { name })).data.nodes.find(n => n.name === name).id;
  const shotA = await shotId('Trong phòng'),
    shotB = await shotId('Ngoài ban công');
  for (const id of [SA, SB])
    await api('/api/upload', 'POST', {
      nodeId: id,
      mime: 'image/png',
      base64: png.toString('base64'),
    });
  for (const id of [shotA, shotB]) await api('/api/node', 'PATCH', { id, duration: 10 });
  st = (await api('/api/state')).data;
  r = await api('/api/edges', 'PUT', {
    edges: [...st.edges, { source: SA, target: shotA }, { source: SB, target: shotB }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // keyframes AFTER wiring, so the new scene input does not leave them stale
  for (const id of [shotA, shotB])
    await api('/api/upload', 'POST', {
      nodeId: id,
      mime: 'image/png',
      base64: png.toString('base64'),
    });
  r = await api('/api/seedance/groups', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const MG = r.data.created.find(id => {
    const mem = r.data.edges.filter(e => e.target === id).map(e => e.source);
    return mem.includes(shotA) && mem.includes(shotB);
  });
  assert.ok(MG, 'the two scene shots share one render');
  const mp = groupOf(r.data, MG).resolvedPrompts.video;
  assert.match(mp, /consecutive shots may be set in different locations/);
  const loc1 = mp.match(/Shot 1 \(0–10s\):[^\n]*? Location: image (\d+)\./);
  const loc2 = mp.match(/Shot 2 \(10–20s\):[^\n]*? Location: image (\d+)\./);
  assert.ok(loc1 && loc2, 'each shot names the image of its own location');
  assert.notEqual(loc1[1], loc2[1], 'different scenes are cited as different images');

  // Over Seedvis's 20 MB-per-image inline cap: the render fails for free (nothing sent), with a
  // clear error, instead of being rejected after the credit is spent.
  await api('/api/upload', 'POST', {
    nodeId: MG,
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  st = (await api('/api/state')).data;
  const bigRef = path.join(
    dir,
    'projects',
    st.activeProjectId,
    'media',
    st.nodes.find(n => n.id === SA).image.id,
  );
  fs.writeFileSync(bigRef, Buffer.alloc(21 * 1024 * 1024, 7)); // 21 MiB > the 20 MiB per-image cap
  const submitsBeforeBig = submits.filter(x => x.body.model === 'seedance_2.5').length;
  r = await api('/api/jobs', 'POST', { nodeId: MG, kind: 'video' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ({ j } = await settle(r.data.job.id));
  assert.equal(j.status, 'failed', j.error);
  assert.match(j.error, /20 MB/);
  assert.equal(
    submits.filter(x => x.body.model === 'seedance_2.5').length,
    submitsBeforeBig,
    'nothing sent when an image is over the size cap',
  );

  // --- Merged scenes: one shot written as 2–3 camera setups, filmed as ONE Veo clip.
  r = await api('/api/projects', 'POST', {
    name: 'Ghép',
    theme: 'film',
    exportDir: path.join(dir, 'merged-folder'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const bible = {
    project: { title: 'Ashford' },
    assets: [
      {
        key: 'eleanor',
        role: 'character',
        name: 'Eleanor',
        code: 'NV1',
        prompt: 'model sheet',
        identity_label: 'the auburn-haired woman',
        back_view: 'her auburn bun and charcoal shoulder',
        voice_profile: { gender: 'Female', age_sound: 'Late 30s', timbre: 'low and slow' },
      },
      {
        key: 'vivienne',
        role: 'character',
        name: 'Vivienne',
        code: 'NV3',
        prompt: 'model sheet',
        identity_label: 'the platinum-blonde woman',
        back_view: 'her platinum hair and bare shoulder',
        voice_profile: { gender: 'Female', age_sound: 'Late 30s', timbre: 'bright and brittle' },
      },
      {
        key: 'scene_study',
        role: 'scene',
        name: 'Thư phòng',
        prompt: 'the study',
        conversation: {
          place: 'The study from image 1 at night',
          two_shot: 'from the bookcase side of the room',
          left: {
            anchor: 'standing at the window end of the long desk',
            background: 'the rain-streaked arched windows',
            light: 'warm firelight on her face',
          },
          right: {
            anchor: 'standing in front of the marble fireplace',
            background: 'the marble fireplace and gilt portrait',
            light: 'firelight rims her hair',
          },
        },
      },
    ],
    styles: [{ key: 'style_main', name: 'Style', prompt: 'Cinematic 35mm noir' }],
    audio: [{ key: 'aud_rain', name: 'Mưa', prompt: 'rain on the windows, the fire crackling' }],
    shots: [
      {
        name: 'Cảnh 01 — Di chúc',
        start: 0,
        uses: ['eleanor', 'vivienne', 'scene_study', 'style_main', 'aud_rain'],
        style: 'style_main',
        audio: 'aud_rain',
        sides: { left: 'eleanor', right: 'vivienne' },
        setups: [
          {
            framing: 'ots_a',
            dialogue: 'Vivienne: "He changed the will, Eleanor."',
            audio_delivery: 'coolly, bright and brittle',
          },
          { framing: 'ots_b', dialogue: 'Eleanor: "I know."', audio_delivery: 'low and slow' },
          {
            framing: 'two_shot',
            dialogue: 'Vivienne: "Then you leave with nothing."',
            action: 'takes one step toward NV1',
          },
        ],
      },
    ],
  };
  r = await api('/api/director/build', 'POST', { blueprint: bible });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = r.data;
  const mergedNode = st.nodes.find(n => n.zone === 'merged');
  assert.ok(mergedNode, 'a shot with "setups" builds a node in the merged column');
  assert.equal(mergedNode.duration, 8, 'a Veo clip is 8 seconds');
  const frameNodes = st.nodes.filter(n => n.role === 'frame').sort((a, b) => a.frameNo - b.frameNo);
  assert.equal(frameNodes.length, 3, 'one frame node per camera setup');
  assert.deepEqual(
    frameNodes.map(n => n.framing),
    ['ots_a', 'ots_b', 'two_shot'],
  );
  assert.ok(
    frameNodes.every(n => n.zone === 'production'),
    'frames are images in the production column',
  );
  // Every frame is wired from [1] the location, [2] the person on the left, [3] on the right,
  // and feeds the merged node — that wire order is what the still prompt names.
  const idOf = name => st.nodes.find(n => n.name === name).id;
  const parentsOf = (s, id) => s.edges.filter(e => e.target === id).map(e => e.source);
  assert.deepEqual(parentsOf(st, frameNodes[0].id), [
    idOf('Thư phòng'),
    idOf('Eleanor'),
    idOf('Vivienne'),
  ]);
  assert.deepEqual(
    parentsOf(st, mergedNode.id).filter(id => frameNodes.some(f => f.id === id)),
    frameNodes.map(f => f.id),
  );
  // The over-the-shoulder still: the listener's back fills one third, the speaker is sharp
  // on their own side, and the light is the one the Bible gives that side of the room.
  const frameA = frameNodes[0].resolvedPrompts.image;
  assert.match(frameA, /The study from image 1 at night\./);
  assert.match(
    frameA,
    /Over-the-shoulder close-up: the auburn-haired woman from image 2 seen from behind, her auburn bun and charcoal shoulder out of focus, filling the left third/,
  );
  assert.match(
    frameA,
    /The platinum-blonde woman from image 3 in sharp focus right of centre, .*looking frame left at the other woman, not into the lens/,
  );
  assert.match(
    frameA,
    /Behind her the marble fireplace and gilt portrait; firelight rims her hair\./,
  );
  assert.match(frameA, /Each woman appears once/);
  const frameB = frameNodes[1].resolvedPrompts.image;
  assert.match(
    frameB,
    /Reverse over-the-shoulder close-up: the platinum-blonde woman from image 3/,
  );
  assert.match(frameB, /The auburn-haired woman from image 2 in sharp focus left of centre/);
  const frameC = frameNodes[2].resolvedPrompts.image;
  assert.match(frameC, /Medium two-shot from the bookcase side of the room, eye level/);
  assert.match(frameC, /The auburn-haired woman from image 2 at frame left/);
  assert.match(frameC, /The platinum-blonde woman from image 3 at frame right/);
  // The clip's prompt: 8 seconds split by how long each line takes (5 / 2 / 5 words → 3/2/3 s).
  const cut = mergedNode.resolvedPrompts.video;
  assert.match(cut, /The 3 attached images are the 3 camera setups of one conversation/);
  assert.match(cut, /NV1 is always on the left of frame, NV3 always on the right/);
  assert.match(cut, /3 shots with clean hard cuts at 00:03 and 00:05/);
  assert.match(
    cut,
    /\[00:00-00:03\] Shot A\. NV3, the platinum-blonde woman, says coolly, bright and brittle: "He changed the will, Eleanor\." Only NV3 speaks; NV1's face stays turned away, lips closed\./,
  );
  assert.match(
    cut,
    /\[00:03-00:05\] Hard cut to shot B\. NV1, the auburn-haired woman, says low and slow: "I know\."/,
  );
  assert.match(
    cut,
    /\[00:05-00:08\] Hard cut to the medium two-shot\. NV3, on the right, takes one step toward NV1 and says: "Then you leave with nothing\." Only NV3 speaks; NV1, on the left, does not move, lips closed\./,
  );
  assert.match(cut, /Voice lock for NV3: Female, Late 30s; timbre: bright and brittle\./);
  assert.match(
    cut,
    /Room sound runs unbroken across the cuts: rain on the windows, the fire crackling\./,
  );
  assert.match(cut, /no subtitles, no captions, no on-screen text/);
  // A merged scene has no image of its own, and its frames are never filmed on their own.
  r = await api('/api/jobs', 'POST', { nodeId: mergedNode.id, kind: 'image' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /tạo ảnh ở từng khung/);
  st = (await api('/api/state')).data;
  assert.ok(
    !st.missingVideo.includes(frameNodes[0].id),
    'a frame is an image of the merged scene, never a shot to film',
  );
  // The merged column holds merged scenes only, and they stay in it.
  r = await api('/api/node', 'PATCH', { id: frameNodes[0].id, zone: 'merged' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Phân cảnh ghép/);
  // Without the frame images there is nothing to send.
  r = await api('/api/jobs', 'POST', { nodeId: mergedNode.id, kind: 'video' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /chưa có ảnh/);
  // Film it: ONE Veo render, the three frames attached as reference images (Ingredients).
  for (const f of frameNodes)
    await api('/api/upload', 'POST', {
      nodeId: f.id,
      kind: 'image',
      mime: 'image/png',
      base64: png.toString('base64'),
    });
  st = (await api('/api/state')).data;
  assert.ok(
    st.missingVideo.includes(mergedNode.id),
    'with its frames ready, "✚ Tạo video còn thiếu" covers the merged scene itself',
  );
  assert.ok(!frameNodes.some(f => st.missingVideo.includes(f.id)), 'and still never its frames');
  submits = [];
  r = await api('/api/jobs', 'POST', { nodeId: mergedNode.id, kind: 'video' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ({ s, j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  const mergedSent = submits.find(x => x.body.mode === 'multi-image-to-video');
  assert.ok(mergedSent, 'several images go as Ingredients, not as a first/last frame');
  assert.equal(mergedSent.body.model, 'Veo-3.1');
  assert.equal(mergedSent.body.duration, '8s');
  assert.equal(mergedSent.body.referenceImages.length, 3, 'one image per camera setup');
  assert.match(mergedSent.body.prompt, /00:05-00:08/);
  const mergedClip = s.nodes.find(n => n.terminal && n.source === mergedNode.id);
  assert.ok(mergedClip, 'the clip of a merged scene is a node of its own');
  assert.equal(mergedClip.zone, 'output', 'it goes to ⑧ Video, beside the shot clips');
  assert.equal(mergedClip.duration, 8);
  // A frame is never a clip of its own, whatever the request says.
  r = await api('/api/jobs', 'POST', { nodeId: frameNodes[0].id, kind: 'video' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /không quay riêng/);
  // A line the person facing the camera cannot say blocks the render; so does a line nobody
  // in frame can say; a long line only warns. Changing a frame's line flags the clip.
  const mergedOf = s => s.nodes.find(n => n.id === mergedNode.id);
  r = await api('/api/node', 'PATCH', {
    id: frameNodes[0].id,
    lyric: 'Eleanor: "He changed the will."',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(mergedOf(r.data).merged.problem, /người quay mặt về máy/);
  assert.ok(mergedOf(r.data).videoStale, 'the clip was cut from another line');
  r = await api('/api/node', 'PATCH', { id: frameNodes[0].id, lyric: '"He changed the will."' });
  assert.match(mergedOf(r.data).merged.problem, /Tên: /);
  r = await api('/api/node', 'PATCH', {
    id: frameNodes[0].id,
    lyric:
      'Vivienne: "He changed the will last month and you knew it all along, did you not, my dear Eleanor?"',
  });
  assert.equal(mergedOf(r.data).merged.problem, '');
  assert.match(mergedOf(r.data).merged.warning, /từ\/giây/);
  r = await api('/api/node', 'PATCH', {
    id: frameNodes[0].id,
    lyric: 'Vivienne: "He changed the will, Eleanor."',
  });
  assert.equal(mergedOf(r.data).merged.warning, '');
  assert.equal(mergedOf(r.data).merged.problem, '');

  // A merged scene can render with any Seedvis video model, not only Veo: switch it to Omni
  // Flash and the next render goes out as that model, with the frames in Omni Flash's own
  // "images" field and no duration (Omni Flash takes none).
  await api('/api/node', 'PATCH', {
    id: mergedNode.id,
    seedvis: { video: { model: 'Omni-Flash', aspectRatio: '16:9', upscale: null } },
  });
  submits = [];
  r = await api('/api/jobs', 'POST', { nodeId: mergedNode.id, kind: 'video' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ({ s, j } = await settle(r.data.job.id));
  assert.equal(j.status, 'completed', j.error);
  const omniSent = submits.find(x => x.body.model === 'Omni-Flash');
  assert.ok(omniSent, 'a merged scene can render with Omni Flash, not only Veo');
  assert.equal(omniSent.body.mode, 'multi-image-to-video');
  assert.equal(omniSent.body.images.length, 3, 'the frames go in Omni Flash’s images field');
  assert.ok(!('duration' in omniSent.body), 'Omni Flash sends no duration field');

  // The key never reaches the browser state.
  assert.ok(!JSON.stringify((await api('/api/state')).data).includes(KEY));
  const projRoot = path.join(dir, 'projects');
  const projJson = fs
    .readdirSync(projRoot)
    .map(id => fs.readFileSync(path.join(projRoot, id, 'project.json'), 'utf8'))
    .join('');
  assert.ok(!projJson.includes(KEY));
  console.log(
    'PASS: key setup, image-to-image (Nano Banana), Veo/Seedance video, idempotency key, reject/fail without resend, video from connected node (refs, single+multi), timeout resume, provider switch, concurrency (push max), zone image batch, auto-video versions+branch+rerun+delete, retry failed videos (latest job only), edit image + swap (staleness kept per image, shape kept, edit vs re-roll), clip after an edit stays flagged, old project: missing videos re-checked (polled or same Idempotency-Key) or filmed, never paid twice, refusal before sending is a plain failure, hidden/stopped/lost old jobs re-checked before any new render, Seedance groups (fill toward 30 s across scenes, capped by length + images, timeline + still tail, storyboard + refs, exact duration, multi-location prompt names the scene image per shot, over-size references fail for free, staleness, column guard, re-split keeps rendered groups), merged scenes (setups → frame nodes + one Veo clip, still prompt per setup, 8 s split by line length, frames never filmed alone, column guard), deleted shot keeps its clip on the job, key not exposed',
  );
} finally {
  proc.kill();
  mock.close();
}
