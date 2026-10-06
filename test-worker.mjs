// End-to-end test for the web worker path (the ChatGPT extension is one such worker):
// a node set to the "web" source makes a bare job, the worker claims/completes it over the
// real HTTP protocol, and the node receives the image. No mocks — a real server, real files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-worker-'));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=',
  'base64',
);
const PORT = 17795;
const BASE = 'http://127.0.0.1:' + PORT;

async function api(p, method = 'GET', body, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}

const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: String(PORT), MV_DATA_DIR: dir },
  stdio: 'pipe',
});
let errLog = '';
proc.stderr.on('data', d => (errLog += d));
async function ready() {
  let out = '';
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const chunk = await new Promise(r => {
      const t = setTimeout(() => r(null), 500);
      proc.stdout.once('data', d => {
        clearTimeout(t);
        r(String(d));
      });
    });
    if (chunk) out += chunk;
    if (out.includes('ready')) return;
  }
  throw new Error('Server không khởi động. stderr:\n' + errLog);
}

try {
  await ready();
  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const authed = (p, body, extra = {}) =>
    api(p, 'POST', body, { Authorization: 'Bearer ' + token, ...extra });

  // A new node, switched to the ChatGPT (web) image source.
  let st = (await api('/api/nodes', 'POST', { name: 'WebNode' })).data;
  const id = st.nodes.find(n => n.name === 'WebNode').id;
  st = (await api('/api/node', 'PATCH', { id, seedvis: { image: false }, web: { image: true } }))
    .data;
  assert.equal(
    st.nodes.find(n => n.id === id).providers.image.type,
    'web',
    'node phải dùng nguồn web',
  );

  // Creating a job yields a bare job (no seedvis/orbit payload) for the worker queue.
  const jr = await api('/api/jobs', 'POST', { nodeId: id, kind: 'image' });
  assert.equal(jr.status, 201);
  const jobId = jr.data.job.id;
  assert.ok(!jr.data.job.payload.seedvis && !jr.data.job.payload.orbit, 'job web phải là job trần');
  assert.equal(jr.data.job.payload.site, 'chatgpt');

  // Auth is required: a wrong token is rejected.
  assert.equal(
    (await api('/api/worker/claim', 'POST', { name: 'x' }, { Authorization: 'Bearer wrong' }))
      .status,
    401,
  );

  // The extension's origin (chrome-extension://…) must NOT be blocked on worker routes.
  const claimRes = await api(
    '/api/worker/claim',
    'POST',
    { name: 'ext' },
    { Authorization: 'Bearer ' + token, Origin: 'chrome-extension://abcdefgh' },
  );
  assert.notEqual(claimRes.status, 403, 'route worker không được chặn theo Origin');
  assert.equal(claimRes.status, 200);
  const claimed = claimRes.data.job;
  assert.ok(claimed && claimed.id === jobId, 'claim phải nhận đúng job web');
  assert.ok(claimed.lease, 'claim phải gán lease');

  // Heartbeat, then complete with a real PNG.
  assert.equal(
    (await authed('/api/worker/heartbeat', { id: jobId, lease: claimed.lease })).status,
    200,
  );
  const cr = await authed('/api/worker/complete', {
    id: jobId,
    lease: claimed.lease,
    name: 'web.png',
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  assert.equal(cr.status, 200);
  assert.ok(cr.data.asset?.url.startsWith('/media/'), 'complete phải lưu asset');

  // The node now holds the image and the job is completed.
  st = (await api('/api/state')).data;
  const doneNode = st.nodes.find(n => n.id === id);
  assert.ok(doneNode.image?.url, 'node phải nhận được ảnh');
  assert.equal(st.jobs.find(j => j.id === jobId).status, 'completed');

  // ---- edit that image through the ChatGPT extension (web source) ----
  const edr = await api('/api/jobs', 'POST', {
    nodeId: id,
    kind: 'image',
    edit: 'make the background darker',
  });
  assert.equal(edr.status, 201, JSON.stringify(edr.data));
  const editJob = edr.data.job;
  assert.ok(!editJob.payload.seedvis && !editJob.payload.orbit, 'sửa ảnh web là job trần');
  assert.equal(editJob.payload.edit, true, 'payload đánh dấu edit');
  assert.equal(editJob.payload.prompt, 'make the background darker', 'prompt = yêu cầu sửa');
  assert.equal(editJob.payload.references.length, 1, 'đính đúng ảnh đang có của node');
  const ec = (await authed('/api/worker/claim', { name: 'ext' })).data.job;
  assert.ok(ec && ec.id === editJob.id, 'worker claim đúng job sửa ảnh');
  await authed('/api/worker/complete', {
    id: ec.id,
    lease: ec.lease,
    name: 'edited.png',
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  const edNode = (await api('/api/state')).data.nodes.find(n => n.id === id);
  assert.ok(edNode.image?.url, 'node có ảnh mới sau sửa');
  assert.ok(edNode.prevImage, 'ảnh cũ được giữ để đổi lại');

  // The media the worker downloads for references is served with a CORS header for the extension.
  const media = await fetch(BASE + doneNode.image.url, {
    headers: { Origin: 'chrome-extension://abcdefghi' },
  });
  assert.equal(media.status, 200);
  assert.equal(
    media.headers.get('access-control-allow-origin'),
    '*',
    'media cần CORS cho extension',
  );

  // CORS preflight on a worker route is answered.
  const pre = await fetch(BASE + '/api/worker/claim', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);

  // Nothing left to claim.
  assert.equal(
    (await authed('/api/worker/claim', { name: 'ext' })).data.job,
    null,
    'hết job để claim',
  );

  // ---- two independent web jobs run concurrently (MV_WORKER_CONCURRENCY > 1) ----
  let ps = (await api('/api/nodes', 'POST', { name: 'ParA' })).data;
  const paId = ps.nodes.find(n => n.name === 'ParA').id;
  ps = (await api('/api/nodes', 'POST', { name: 'ParB' })).data;
  const pbId = ps.nodes.find(n => n.name === 'ParB').id;
  for (const nid of [paId, pbId])
    await api('/api/node', 'PATCH', { id: nid, seedvis: { image: false }, web: { image: true } });
  const jaId = (await api('/api/jobs', 'POST', { nodeId: paId, kind: 'image' })).data.job.id;
  const jbId = (await api('/api/jobs', 'POST', { nodeId: pbId, kind: 'image' })).data.job.id;
  const c1 = (await authed('/api/worker/claim', { name: 'acc1' })).data.job;
  const c2 = (await authed('/api/worker/claim', { name: 'acc2' })).data.job;
  assert.ok(c1 && c2 && c1.id !== c2.id, 'hai claim phải nhận hai job khác nhau (song song)');
  const twoRunning = (await api('/api/state')).data.jobs.filter(j => [jaId, jbId].includes(j.id));
  assert.ok(
    twoRunning.every(j => j.status === 'running'),
    'cả hai job web chạy đồng thời',
  );
  assert.ok((await api('/api/state')).data.worker.count >= 2, 'state phải báo >= 2 worker');
  for (const c of [c1, c2])
    await authed('/api/worker/complete', {
      id: c.id,
      lease: c.lease,
      name: 'par.png',
      mime: 'image/png',
      base64: png.toString('base64'),
    });

  // ---- auto image chain over two web nodes (dependency order + reference hand-off) ----
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let cs = (await api('/api/nodes', 'POST', { name: 'ChainA' })).data;
  const aId = cs.nodes.find(n => n.name === 'ChainA').id;
  cs = (await api('/api/nodes', 'POST', { name: 'ChainB' })).data;
  const bId = cs.nodes.find(n => n.name === 'ChainB').id;
  for (const nid of [aId, bId])
    await api('/api/node', 'PATCH', { id: nid, seedvis: { image: false }, web: { image: true } });
  const edges0 = (await api('/api/state')).data.edges;
  assert.equal(
    (await api('/api/edges', 'PUT', { edges: [...edges0, { source: aId, target: bId }] })).status,
    200,
  );
  assert.equal((await api('/api/auto/start', 'POST', { target: bId })).status, 200);

  // Act as the worker: claim + complete each queued job until the chain finishes. The chain
  // advances only because /api/worker/complete now calls onAutoJobDone + pump.
  let chainRefs = 0;
  for (let i = 0; i < 40; i++) {
    const s = (await api('/api/state')).data;
    if (s.autoRun?.status !== 'running') break;
    const c = await authed('/api/worker/claim', { name: 'ext' });
    if (c.data.job) {
      chainRefs = Math.max(chainRefs, (c.data.job.payload.references || []).length);
      await authed('/api/worker/complete', {
        id: c.data.job.id,
        lease: c.data.job.lease,
        name: 'chain.png',
        mime: 'image/png',
        base64: png.toString('base64'),
      });
    } else await sleep(120);
  }
  const chainState = (await api('/api/state')).data;
  assert.equal(chainState.autoRun.status, 'completed', 'chuỗi ảnh web phải hoàn tất');
  assert.ok(chainState.nodes.find(n => n.id === aId).image?.url, 'ChainA phải có ảnh');
  assert.ok(chainState.nodes.find(n => n.id === bId).image?.url, 'ChainB phải có ảnh');
  assert.equal(chainRefs, 1, 'ChainB phải nhận 1 ảnh tham chiếu (ảnh của ChainA)');

  // ChatGPT (web) makes images only: a video job is rejected.
  await api('/api/node', 'PATCH', { id, seedvis: { video: false }, web: { video: true } });
  const vj = await api('/api/jobs', 'POST', { nodeId: id, kind: 'video' });
  assert.equal(vj.status, 400);
  assert.match(vj.data.error, /ChatGPT|chỉ tạo ảnh/);

  // ---- worker token endpoint + project default source + auto with the web default ----
  const wi = (await api('/api/worker-info')).data;
  assert.equal(wi.token, token, '/api/worker-info phải trả đúng worker token cho UI');
  assert.ok(String(wi.url).includes(String(PORT)), 'worker-info có url máy chủ');

  // Default image source = ChatGPT (web). A brand-new node with no per-node choice follows it.
  assert.equal((await api('/api/project', 'PATCH', { defaults: { image: 'web' } })).status, 200);
  const defState = (await api('/api/nodes', 'POST', { name: 'DefNode' })).data;
  const defId = defState.nodes.find(n => n.name === 'DefNode').id;
  assert.equal(
    defState.nodes.find(n => n.id === defId).providers.image.type,
    'web',
    'node mới phải theo nguồn mặc định (web)',
  );

  // Drains a running batch/chain by acting as the worker.
  const drain = async which => {
    for (let i = 0; i < 40; i++) {
      const s = (await api('/api/state')).data;
      if ((which === 'chain' ? s.autoRun : s.autoImageRun)?.status !== 'running') return s;
      const c = await authed('/api/worker/claim', { name: 'drain' });
      if (c.data.job)
        await authed('/api/worker/complete', {
          id: c.data.job.id,
          lease: c.data.job.lease,
          name: 'd.png',
          mime: 'image/png',
          base64: png.toString('base64'),
        });
      else await sleep(120);
    }
    return (await api('/api/state')).data;
  };

  // Regression: the auto chain must NOT demand Orbit when nodes follow the web default.
  assert.equal(
    (await api('/api/auto/start', 'POST', { target: defId })).status,
    200,
    'chuỗi với nguồn mặc định web không được đòi Orbit',
  );
  let after = await drain('chain');
  assert.equal(after.autoRun.status, 'completed', 'chuỗi web (mặc định) phải hoàn tất');
  assert.ok(after.nodes.find(n => n.id === defId).image?.url, 'DefNode phải nhận ảnh');

  // Regression: the per-zone batch must NOT demand a Seedvis key for web nodes.
  const bState = (await api('/api/nodes', 'POST', { name: 'BatchNode' })).data;
  const batchId = bState.nodes.find(n => n.name === 'BatchNode').id;
  assert.equal(
    (await api('/api/auto/images/start', 'POST', { zone: 'production' })).status,
    200,
    'batch khu vực web không được đòi key Seedvis',
  );
  after = await drain('batch');
  assert.equal(after.autoImageRun.status, 'completed', 'batch khu vực web phải hoàn tất');
  assert.ok(after.nodes.find(n => n.id === batchId).image?.url, 'BatchNode phải nhận ảnh');

  // Switch the default back to Seedvis: a newer node resolves to seedvis again.
  await api('/api/project', 'PATCH', { defaults: { image: 'seedvis' } });
  const defState2 = (await api('/api/nodes', 'POST', { name: 'DefNode2' })).data;
  assert.equal(
    defState2.nodes.find(n => n.name === 'DefNode2').providers.image.type,
    'seedvis',
    'đổi mặc định về seedvis thì node mới dùng seedvis',
  );

  // New projects inherit the default source: set web, create a project, a fresh node follows it.
  await api('/api/project', 'PATCH', { defaults: { image: 'web' } });
  const inh = await api('/api/projects', 'POST', {
    name: 'Kế thừa',
    exportDir: path.join(dir, 'inherit'),
  });
  assert.equal(inh.status, 201, JSON.stringify(inh.data));
  const inhNode = (await api('/api/nodes', 'POST', { name: 'InhNode' })).data.nodes.find(
    n => n.name === 'InhNode',
  );
  assert.equal(
    inhNode.providers.image.type,
    'web',
    'project mới kế thừa nguồn mặc định (ChatGPT/web)',
  );

  // ---- Director agent via the extension (web LLM, no API key) ----
  // Register the worker as online (the agent refuses web mode when no worker has checked in).
  await authed('/api/worker/claim', { name: 'director-ext', kinds: ['image', 'text'] });
  // Stage "script": the agent request enqueues an ephemeral text job and blocks until it is done.
  const scriptP = api('/api/director/agent', 'POST', {
    stage: 'script',
    idea: 'Một người mẹ phát hiện con gái giấu bí mật',
    via: 'web',
  });
  let tjob = null;
  for (let i = 0; i < 50 && !tjob; i++) {
    tjob = (await api('/api/state')).data.jobs.find(
      j => j.kind === 'text' && j.status === 'queued',
    );
    if (!tjob) await sleep(80);
  }
  assert.ok(tjob, 'agent web phải xếp một job text');
  assert.equal(tjob.payload.site, 'chatgpt');
  assert.match(tjob.payload.prompt, /KỊCH BẢN/, 'job text mang system prompt viết kịch bản');
  // An image-only worker (old extension: no kinds) must NOT pick up the director text job.
  assert.ok(
    !(await authed('/api/worker/claim', { name: 'img-only' })).data.job,
    'worker chỉ-ảnh không lấy job text',
  );
  // A text-capable worker claims it and returns the reply text.
  const tc = (await authed('/api/worker/claim', { name: 'director-ext', kinds: ['image', 'text'] }))
    .data.job;
  assert.ok(tc && tc.id === tjob.id, 'worker text claim đúng job Đạo diễn');
  await authed('/api/worker/complete', {
    id: tc.id,
    lease: tc.lease,
    text: 'KỊCH BẢN GIẢ LẬP — Cảnh 1: người mẹ mở ngăn kéo.',
  });
  const sr = await scriptP;
  assert.equal(sr.status, 200, JSON.stringify(sr.data));
  assert.equal(sr.data.stage, 'script');
  assert.match(sr.data.script, /GIẢ LẬP/, 'agent trả về text do worker scrape');
  assert.ok(
    !(await api('/api/state')).data.jobs.some(j => j.kind === 'text'),
    'job text ephemeral được dọn sau khi đọc',
  );

  // Stage "blueprint": worker returns a JSON blueprint (ChatGPT often wraps it in a fence).
  await authed('/api/worker/claim', { name: 'director-ext', kinds: ['image', 'text'] });
  const bpP = api('/api/director/agent', 'POST', {
    stage: 'blueprint',
    script: 'KỊCH BẢN đã duyệt: hai người trong phòng.',
    via: 'web',
  });
  let bj = null;
  for (let i = 0; i < 50 && !bj; i++) {
    bj = (await api('/api/state')).data.jobs.find(j => j.kind === 'text' && j.status === 'queued');
    if (!bj) await sleep(80);
  }
  assert.ok(bj, 'blueprint stage xếp job text');
  const bc = (await authed('/api/worker/claim', { name: 'director-ext', kinds: ['text'] })).data
    .job;
  assert.ok(bc && bc.id === bj.id);
  const bpReply =
    'Đây là blueprint:\n```json\n' +
    JSON.stringify({ project: { name: 'Web BP' }, shots: [{ name: 'S1' }, { name: 'S2' }] }) +
    '\n```';
  await authed('/api/worker/complete', { id: bc.id, lease: bc.lease, text: bpReply });
  const br = await bpP;
  assert.equal(br.status, 200, JSON.stringify(br.data));
  assert.equal(br.data.stage, 'blueprint');
  assert.match(br.data.blueprint, /Web BP/, 'blueprint parse từ reply có fence ```json');
  assert.ok(br.data.summary.includes('2 shot'), 'summary đếm shot: ' + br.data.summary);

  console.log(
    'PASS: web-node bare job, extension claim/heartbeat/complete, origin exemption + CORS media, preflight, concurrent web jobs (cap>1) + multi-worker count, auto image chain across web nodes (reference hand-off), video rejected, worker-info token, project default source (auto chain + zone batch run via web default, no Orbit/Seedvis key demanded, new project inherits default source), edit image via extension (edit payload + current image attached, prevImage kept), Director agent via extension (text job: caps routing, script + blueprint stages, ephemeral cleanup)',
  );
} finally {
  proc.kill();
}
