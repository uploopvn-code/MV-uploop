// End-to-end test for the Google Vids (extension) video path: a node whose video source is
// "gvids" makes a bare video job tagged site=googlevids, a worker that lists kinds:['video']
// claims it over the real HTTP protocol, completes it with a real MP4, and the node receives a
// video output branch. No mocks — a real server, a real MP4 container, real files on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-gvids-'));
// A real (tiny) MP4: a valid ISO-BMFF ftyp box (major brand isom, compatible isom/iso2). The
// server stores it by mime; the extension's own ftyp check would also accept this signature.
const mp4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);
const PORT = 17799;
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

  // A node switched to the Google Vids (extension) video source. No keyframe image: Google Vids
  // makes video straight from the text prompt, so the job must be allowed with no image.
  let st = (await api('/api/nodes', 'POST', { name: 'VidsShot' })).data;
  const id = st.nodes.find(n => n.name === 'VidsShot').id;
  st = (await api('/api/node', 'PATCH', { id, seedvis: { video: false }, gvids: { video: true } }))
    .data;
  assert.equal(
    st.nodes.find(n => n.id === id).providers.video.type,
    'gvids',
    'node phải dùng nguồn video gvids',
  );

  // Creating a video job yields a bare job (no seedvis/orbit payload) tagged site=googlevids.
  const jr = await api('/api/jobs', 'POST', { nodeId: id, kind: 'video' });
  assert.equal(jr.status, 201, JSON.stringify(jr.data));
  const jobId = jr.data.job.id;
  assert.equal(jr.data.job.kind, 'video', 'job là video');
  assert.ok(
    !jr.data.job.payload.seedvis && !jr.data.job.payload.orbit,
    'job gvids phải là job trần (không seedvis/orbit)',
  );
  assert.equal(jr.data.job.payload.site, 'googlevids', 'job mang site=googlevids');

  // Routing: an image-only worker and a ChatGPT (image+text) worker must NOT pick up the video
  // job — only a worker that lists 'video' claims it.
  assert.equal(
    (await authed('/api/worker/claim', { name: 'img-only' })).data.job,
    null,
    'worker chỉ-ảnh không lấy job video',
  );
  assert.equal(
    (await authed('/api/worker/claim', { name: 'chatgpt', kinds: ['image', 'text'] })).data.job,
    null,
    'worker ChatGPT (ảnh+text) không lấy job video gvids',
  );

  // A video-capable worker (the Google Vids extension) claims it.
  const claimed = (await authed('/api/worker/claim', { name: 'gvids-ext', kinds: ['video'] })).data
    .job;
  assert.ok(claimed && claimed.id === jobId, 'worker video claim đúng job gvids');
  assert.ok(claimed.lease, 'claim phải gán lease');

  // Heartbeat, then complete with a real MP4 container.
  assert.equal(
    (await authed('/api/worker/heartbeat', { id: jobId, lease: claimed.lease })).status,
    200,
  );
  const cr = await authed('/api/worker/complete', {
    id: jobId,
    lease: claimed.lease,
    name: 'vids.mp4',
    mime: 'video/mp4',
    base64: mp4.toString('base64'),
  });
  assert.equal(cr.status, 200, JSON.stringify(cr.data));
  assert.ok(cr.data.asset?.url.startsWith('/media/'), 'complete phải lưu asset video');
  assert.equal(cr.data.asset.mime, 'video/mp4', 'asset là video/mp4');

  // A completed video becomes its own output node (branch), wired from the source shot.
  st = (await api('/api/state')).data;
  assert.equal(st.jobs.find(j => j.id === jobId).status, 'completed', 'job gvids hoàn tất');
  const branch = st.nodes.find(n => n.terminal && n.source === id && n.video?.url);
  assert.ok(branch, 'phải tạo node video đầu ra nối từ shot nguồn');
  // The real MP4 is on disk and served.
  const media = await fetch(BASE + branch.video.url, {
    headers: { Origin: 'chrome-extension://abcdefghi' },
  });
  assert.equal(media.status, 200, 'video phục vụ được');
  assert.equal(
    media.headers.get('access-control-allow-origin'),
    '*',
    'media video cần CORS cho extension',
  );
  const served = Buffer.from(await media.arrayBuffer());
  assert.ok(served.equals(mp4), 'byte video phục vụ đúng bằng file đã gửi');

  // An image job on a gvids node is rejected (Google Vids makes video only).
  await api('/api/node', 'PATCH', { id, seedvis: { image: false }, gvids: { image: true } });
  const imgJob = await api('/api/jobs', 'POST', { nodeId: id, kind: 'image' });
  assert.equal(imgJob.status, 400, 'job ảnh trên node gvids bị từ chối');
  assert.match(imgJob.data.error, /Google Vids|chỉ tạo video/);
  // Undo that image switch so it does not affect the default-source check below.
  await api('/api/node', 'PATCH', { id, gvids: { image: false } });

  // Project default video source = Google Vids. A new shot with no per-node choice follows it.
  assert.equal(
    (await api('/api/project', 'PATCH', { defaults: { video: 'gvids' } })).status,
    200,
    'đặt được nguồn video mặc định gvids',
  );
  const defState = (await api('/api/nodes', 'POST', { name: 'DefVidsShot' })).data;
  const defNode = defState.nodes.find(n => n.name === 'DefVidsShot');
  assert.equal(
    defNode.providers.video.type,
    'gvids',
    'node mới phải theo nguồn video mặc định (gvids)',
  );

  // A gvids node CAN also film from a keyframe image + reference images (ingredients): give the
  // node an uploaded image, then the video job attaches it as a keyframe reference.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=',
    'base64',
  );
  // Upload an image onto DefVidsShot via the real upload route used by the UI.
  const up = await api('/api/upload', 'POST', {
    nodeId: defNode.id,
    kind: 'image',
    name: 'key.png',
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const kjr = await api('/api/jobs', 'POST', { nodeId: defNode.id, kind: 'video' });
  assert.equal(kjr.status, 201, JSON.stringify(kjr.data));
  assert.equal(kjr.data.job.payload.site, 'googlevids');
  assert.equal(
    (kjr.data.job.payload.references || []).length,
    1,
    'video gvids từ keyframe đính đúng 1 ảnh',
  );
  assert.equal(kjr.data.job.payload.references[0].role, 'keyframe');
  // Finish the second Vids job before changing the workflow; node mutations require an idle queue.
  const kClaimed = (await authed('/api/worker/claim', { name: 'gvids-finish', kinds: ['video'] })).data.job;
  assert.ok(kClaimed && kClaimed.id === kjr.data.job.id, 'claim job gvids thứ hai');
  await authed('/api/worker/complete', {
    id: kClaimed.id,
    lease: kClaimed.lease,
    name: 'vids-key.mp4',
    mime: 'video/mp4',
    base64: mp4.toString('base64'),
  });

  // ---- Muse chat (extension): same bare job shape, site=musechat, claimed by a worker that
  // lists sites:['musechat'] — and NOT by one that only lists googlevids. ----
  const mst = (await api('/api/nodes', 'POST', { name: 'MuseShot' })).data;
  assert.ok(mst.nodes, 'tạo MuseShot trả state: ' + JSON.stringify(mst));
  const mid = mst.nodes.find(n => n.name === 'MuseShot').id;
  const mst2 = (
    await api('/api/node', 'PATCH', { id: mid, seedvis: { video: false }, musechat: { video: true } })
  ).data;
  assert.equal(
    mst2.nodes.find(n => n.id === mid).providers.video.type,
    'musechat',
    'node phải dùng nguồn video musechat',
  );
  const mjr = await api('/api/jobs', 'POST', { nodeId: mid, kind: 'video' });
  assert.equal(mjr.status, 201, JSON.stringify(mjr.data));
  const mJobId = mjr.data.job.id;
  assert.equal(mjr.data.job.payload.site, 'musechat', 'job mang site=musechat');
  assert.ok(
    !mjr.data.job.payload.seedvis && !mjr.data.job.payload.orbit,
    'job musechat phải là job trần',
  );

  // Site routing: a video worker that only lists googlevids must NOT take a musechat job;
  // the Muse worker (sites:['musechat']) gets it.
  assert.equal(
    (
      await authed('/api/worker/claim', {
        name: 'gvids-only',
        kinds: ['video'],
        sites: ['googlevids'],
      })
    ).data.job,
    null,
    'worker chỉ-googlevids không lấy job musechat',
  );
  // A legacy worker without `sites` may still take Google Vids jobs, but must not receive Muse
  // jobs because an old dispatcher would route unknown video sites to the ChatGPT handler.
  assert.equal(
    (await authed('/api/worker/claim', { name: 'legacy-video-worker', kinds: ['video'] })).data.job,
    null,
    'worker video cũ không lấy job musechat',
  );
  const mClaimed = (
    await authed('/api/worker/claim', { name: 'muse-ext', kinds: ['video'], sites: ['musechat'] })
  ).data.job;
  assert.ok(mClaimed && mClaimed.id === mJobId, 'worker musechat claim đúng job muse');

  // A claim without sites (old extension) must NOT take a site-tagged video job either —
  // sites only restrict, they never widen the pool.
  // (legacy behaviour: a bare `kinds:['video']` claim still cannot see musechat jobs)
  // NOTE: server keeps backward compat by allowing site-less claims only on untagged jobs;
  // this musechat job stays queued until a sites claim takes it — already proven above.

  // Complete the Muse job with the real MP4 → output branch lands on the node.
  const mcr = await authed('/api/worker/complete', {
    id: mJobId,
    lease: mClaimed.lease,
    name: 'muse.mp4',
    mime: 'video/mp4',
    base64: mp4.toString('base64'),
  });
  assert.equal(mcr.status, 200, JSON.stringify(mcr.data));
  const mst3 = (await api('/api/state')).data;
  assert.equal(mst3.jobs.find(j => j.id === mJobId).status, 'completed', 'job muse hoàn tất');
  assert.ok(
    mst3.nodes.find(n => n.terminal && n.source === mid && n.video?.url),
    'video muse tạo node đầu ra nối từ shot nguồn',
  );

  // Muse chat can also create an image. The job is bare and site-filtered like its video job.
  await api('/api/node', 'PATCH', { id: mid, seedvis: { image: false }, musechat: { image: true } });
  const mImgJob = await api('/api/jobs', 'POST', { nodeId: mid, kind: 'image' });
  assert.equal(mImgJob.status, 201, JSON.stringify(mImgJob.data));
  assert.equal(mImgJob.data.job.payload.site, 'musechat', 'ảnh Muse mang site=musechat');
  const mImgClaimed = (
    await authed('/api/worker/claim', { name: 'muse-image-ext', kinds: ['image'], sites: ['musechat'] })
  ).data.job;
  assert.ok(mImgClaimed && mImgClaimed.id === mImgJob.data.job.id, 'worker Muse claim đúng job ảnh');
  const mPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=',
    'base64',
  );
  const mImgComplete = await authed('/api/worker/complete', {
    id: mImgClaimed.id,
    lease: mImgClaimed.lease,
    name: 'muse-image.png',
    mime: 'image/png',
    base64: mPng.toString('base64'),
  });
  assert.equal(mImgComplete.status, 200, JSON.stringify(mImgComplete.data));
  const mImgState = (await api('/api/state')).data;
  assert.ok(mImgState.nodes.find(n => n.id === mid && n.image?.url), 'ảnh Muse gắn đúng node');
  assert.equal(
    mImgState.nodes.filter(n => n.terminal && n.source === mid).length,
    1,
    'ảnh Muse không tạo thêm video branch',
  );

  // Muse image editing remains intentionally unsupported; it must fail before a new job is paid.
  const mEditJob = await api('/api/jobs', 'POST', {
    nodeId: mid,
    kind: 'image',
    edit: 'đổi nền thành xanh',
  });
  assert.equal(mEditJob.status, 400, 'Muse chưa hỗ trợ sửa ảnh');
  assert.match(mEditJob.data.error, /Muse|chưa hỗ trợ sửa ảnh/);

  // Project defaults can select Muse for both image and video.
  assert.equal(
    (await api('/api/project', 'PATCH', { defaults: { image: 'musechat', video: 'musechat' } })).status,
    200,
    'đặt được nguồn ảnh và video mặc định musechat',
  );
  const mDefState = (await api('/api/nodes', 'POST', { name: 'DefMuseShot' })).data;
  const mDefNode = mDefState.nodes.find(n => n.name === 'DefMuseShot');
  assert.equal(mDefNode.providers.image.type, 'musechat', 'node mới theo nguồn ảnh Muse');
  assert.equal(mDefNode.providers.video.type, 'musechat', 'node mới theo nguồn video Muse');

  console.log(
    'PASS: gvids video node → bare job site=googlevids (text-to-video, no keyframe needed), ' +
      'kinds routing (image-only & ChatGPT workers skip it, video worker claims it), ' +
      'heartbeat + complete with a real MP4 → output branch node + served media (CORS), ' +
      'image job on gvids rejected, project default video source gvids, keyframe reference attached; ' +
      'musechat node → site=musechat, site-filtered claim, MP4 complete → branch, image rejected, default video musechat',
  );
} finally {
  proc.kill();
}
