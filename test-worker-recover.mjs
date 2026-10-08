// End-to-end test of late and recovered ChatGPT images (the extension as web worker). A job the
// server gave up on — its heartbeat lapsed, the app restarted, or it failed after the prompt was
// sent — still takes its image under the same lease, lands it only where the node still waits for
// it, and can be fetched again from its ChatGPT conversation by the worker that sent it. No mocks:
// a real server (heartbeat timeout shortened), real HTTP, real PNG files made by ffmpeg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-recover-'));
const data = path.join(tmp, 'data');
const ff = args => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args]);
  if (r.status) throw new Error('ffmpeg: ' + r.stderr);
};
const still = color => {
  const file = path.join(tmp, color + '.png');
  ff(['-f', 'lavfi', '-i', `color=c=${color}:s=64x36`, '-frames:v', '1', file]);
  return fs.readFileSync(file).toString('base64');
};
const RED = still('red');
const BLUE = still('blue');
const PORT = 17784;
const BASE = 'http://127.0.0.1:' + PORT;
const HB_MS = 2000; // the server gives a silent worker up after this (and sweeps this often)
const CAPS = ['image', 'text', 'recover']; // what the current extension claims

let proc,
  errLog = '';
async function start() {
  proc = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      MV_PORT: String(PORT),
      MV_DATA_DIR: data,
      MV_ORBIT_URL: 'http://127.0.0.1:1',
      MV_WORKER_HEARTBEAT_MS: String(HB_MS),
    },
    stdio: 'pipe',
  });
  proc.stderr.on('data', d => (errLog += d));
  let out = '';
  const end = Date.now() + 15000;
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
async function api(p, method = 'GET', body, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    d = text;
  }
  return { status: r.status, data: d };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = async () => (await api('/api/state')).data;
const jobOf = async id => (await state()).jobs.find(j => j.id === id);
const imageOf = async id => (await state()).nodes.find(n => n.id === id).image;
async function until(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Hết giờ chờ: ' + what);
    await sleep(200);
  }
}
const lapsed = id =>
  until('job ' + id + ' mất heartbeat', async () => {
    const j = await jobOf(id);
    return j.status === 'needs_review' && j;
  });

let token;
const authed = (p, body) => api(p, 'POST', body, { Authorization: 'Bearer ' + token });
const claim = async (name, kinds = CAPS) =>
  (await authed('/api/worker/claim', { name, kinds })).data.job;
const complete = (id, lease, base64 = RED) =>
  authed('/api/worker/complete', { id, lease, name: 'chatgpt.png', mime: 'image/png', base64 });
async function webNode(name) {
  const st = (await api('/api/nodes', 'POST', { name })).data;
  const id = st.nodes.find(n => n.name === name).id;
  await api('/api/node', 'PATCH', { id, seedvis: { image: false }, web: { image: true } });
  return id;
}
async function newJob(nodeId) {
  const r = await api('/api/jobs', 'POST', { nodeId, kind: 'image' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.job;
}

try {
  await start();
  token = fs.readFileSync(path.join(data, 'worker-token.txt'), 'utf8').trim();

  // ---- 1. heartbeat lapse → late; the same lease revives it; its image lands; once only ----
  const n1 = await webNode('Trễ heartbeat');
  const j1 = await newJob(n1);
  assert.equal(j1.payload.baseImageId, null, 'job web ghi lại ảnh node lúc tạo (chưa có)');
  const c1 = await claim('ext');
  assert.equal(c1?.id, j1.id);
  const lapse1 = await lapsed(j1.id);
  assert.equal(lapse1.late, true, 'mất heartbeat: job ChatGPT thành "về muộn"');
  assert.equal(lapse1.lease, c1.lease, 'giữ lease để nhận ảnh muộn');
  const hb1 = await authed('/api/worker/heartbeat', { id: j1.id, lease: c1.lease, name: 'ext' });
  assert.equal(hb1.status, 200, JSON.stringify(hb1.data));
  assert.equal(hb1.data.status, 'running', 'heartbeat cùng lease hồi sinh job');
  assert.equal((await jobOf(j1.id)).status, 'running');
  const done1 = await complete(j1.id, c1.lease, RED);
  assert.equal(done1.status, 200, JSON.stringify(done1.data));
  assert.equal(done1.data.applied, true, 'ảnh muộn ghi vào node còn chờ nó');
  assert.equal((await imageOf(n1)).id, done1.data.asset.id);
  // The extension retries a complete whose answer got lost: stored once, never applied twice.
  const dup = await complete(j1.id, c1.lease, BLUE);
  assert.equal(dup.status, 200, JSON.stringify(dup.data));
  assert.equal(dup.data.duplicate, true);
  assert.equal(dup.data.asset.id, done1.data.asset.id, 'trả lại đúng asset đã lưu');
  let node = (await state()).nodes.find(n => n.id === n1);
  assert.equal(node.image.id, done1.data.asset.id, 'complete lần hai không đổi ảnh node');
  assert.ok(!node.prevImage, 'không áp ảnh hai lần');

  // ---- 2. the node moved on: the late image is kept on the job, the node keeps its image ----
  const n2 = await webNode('Đã đi tiếp');
  const a2 = await newJob(n2);
  const ca2 = await claim('ext');
  assert.equal(ca2?.id, a2.id);
  await lapsed(a2.id);
  const b2 = await newJob(n2);
  assert.notEqual(b2.id, a2.id, 'tạo lại node sau khi job cũ chờ kiểm tra');
  const cb2 = await claim('ext');
  assert.equal(cb2?.id, b2.id);
  const doneB2 = await complete(b2.id, cb2.lease, BLUE);
  assert.equal(doneB2.data.applied, true);
  const lateA2 = await complete(a2.id, ca2.lease, RED);
  assert.equal(lateA2.status, 200, JSON.stringify(lateA2.data));
  assert.equal(lateA2.data.applied, false, 'node đã đi tiếp: không ghi đè');
  assert.equal((await imageOf(n2)).id, doneB2.data.asset.id, 'node giữ ảnh của job mới');
  const a2After = await jobOf(a2.id);
  assert.equal(a2After.status, 'completed');
  assert.equal(a2After.result.id, lateA2.data.asset.id, 'ảnh muộn vẫn giữ trên job để tải');
  assert.match(a2After.progress, /không ghi vào node/);

  // ---- 3. failed after send → fetched again from its conversation by the same worker ----
  const n3 = await webNode('Lấy lại ảnh');
  const r3 = await newJob(n3);
  const cr3 = await claim('ext-r');
  assert.equal(cr3?.id, r3.id);
  const conv = 'https://chatgpt.com/c/' + crypto.randomUUID();
  const hb3 = await authed('/api/worker/heartbeat', {
    id: r3.id,
    lease: cr3.lease,
    name: 'ext-r',
    progress: 'Đã gửi prompt, chờ ChatGPT vẽ',
    sent: true,
    conversationUrl: conv + '?model=gpt-5',
  });
  assert.equal(hb3.status, 200, JSON.stringify(hb3.data));
  const f3 = await authed('/api/worker/fail', {
    id: r3.id,
    lease: cr3.lease,
    error: 'ChatGPT không trả ảnh',
    needsReview: true,
    conversationUrl: conv,
    replyText: 'Đang tạo hình ảnh…',
  });
  assert.equal(f3.status, 200, JSON.stringify(f3.data));
  assert.equal(f3.data.status, 'needs_review', 'đã gửi prompt: chờ kiểm tra, không chạy lại');
  let j3 = await jobOf(r3.id);
  assert.equal(j3.web.conversationUrl, conv, 'lưu link cuộc trò chuyện (bỏ query)');
  assert.ok(j3.web.sentAt, 'ghi lúc đã gửi prompt');
  assert.equal(j3.web.replyText, 'Đang tạo hình ảnh…');
  assert.equal(j3.late, true);
  assert.ok(j3.recoverAt > Date.now() + 60000, 'tự lấy lại sau ~90 s');
  const col = await api('/api/jobs/collect', 'POST', { id: r3.id });
  assert.equal(col.status, 200, JSON.stringify(col.data));
  j3 = col.data.jobs.find(j => j.id === r3.id);
  assert.equal(j3.status, 'queued', '"Lấy lại ảnh" xếp job lấy lại ngay');
  assert.deepEqual(
    { ...j3.recover, queuedAt: 0 },
    { conversationUrl: conv, tries: 1, queuedAt: 0 },
  );
  assert.equal(j3.recoverAt, undefined);
  assert.equal(
    await claim('ext-r', ['image', 'text']),
    null,
    'extension cũ (không recover) không nhận',
  );
  assert.equal(await claim('ext-khac'), null, 'worker khác (tài khoản ChatGPT khác) không nhận');
  const cr3b = await claim('ext-r');
  assert.equal(cr3b?.id, r3.id, 'đúng worker đã gửi nhận job lấy lại');
  assert.deepEqual(
    { ...cr3b.recover, queuedAt: 0 },
    { conversationUrl: conv, tries: 1, queuedAt: 0 },
    'job mang link để mở lại',
  );
  assert.notEqual(cr3b.lease, cr3.lease, 'lấy lại cấp lease mới');
  assert.equal((await complete(r3.id, cr3.lease)).status, 400, 'lease cũ không còn hiệu lực');
  const done3 = await complete(r3.id, cr3b.lease, BLUE);
  assert.equal(done3.status, 200, JSON.stringify(done3.data));
  assert.equal(done3.data.applied, true);
  assert.equal((await imageOf(n3)).id, done3.data.asset.id, 'ảnh lấy lại ghi vào node');

  // ---- 3b. the extension went quiet after sending: fetched again on its own (~30 s later) ----
  const n3b = await webNode('Tự lấy lại');
  const r3b = await newJob(n3b);
  const c3b = await claim('ext-auto');
  assert.equal(c3b?.id, r3b.id);
  const conv3b = 'https://chatgpt.com/g/g-abc123-drama/c/' + crypto.randomUUID();
  await authed('/api/worker/heartbeat', {
    id: r3b.id,
    lease: c3b.lease,
    name: 'ext-auto',
    sent: true,
    conversationUrl: conv3b,
  });
  const lapse3b = await lapsed(r3b.id);
  assert.ok(lapse3b.recoverAt, 'mất heartbeat sau khi gửi: hẹn tự lấy lại');
  // The worker keeps polling (online) without that job: the tool queues the fetch for it.
  const auto3b = await until('tự xếp job lấy lại', () => claim('ext-auto'), 50000);
  assert.equal(auto3b.id, r3b.id);
  assert.deepEqual(
    { ...auto3b.recover, queuedAt: 0 },
    { conversationUrl: conv3b, tries: 1, queuedAt: 0 },
  );
  const done3b = await complete(r3b.id, auto3b.lease, RED);
  assert.equal(done3b.data.applied, true, 'ảnh tự lấy lại ghi vào node');

  // ---- 4. failed before the prompt was sent: plain "failed", safe to run again ----
  const n4 = await webNode('Chưa gửi');
  const j4 = await newJob(n4);
  const c4 = await claim('ext');
  assert.equal(c4?.id, j4.id);
  const f4 = await authed('/api/worker/fail', {
    id: j4.id,
    lease: c4.lease,
    error: 'Chưa đăng nhập ChatGPT',
    needsReview: false,
  });
  assert.equal(f4.data.status, 'failed');
  const j4After = await jobOf(j4.id);
  assert.equal(j4After.status, 'failed', 'lỗi trước khi gửi → failed');
  assert.ok(!j4After.late);

  // ---- 5. an auto chain stopped by a lapse runs on when the late image lands ----
  const chA = await webNode('Chuỗi A');
  const chB = await webNode('Chuỗi B');
  const edges = (await state()).edges;
  assert.equal(
    (await api('/api/edges', 'PUT', { edges: [...edges, { source: chA, target: chB }] })).status,
    200,
  );
  const auto = await api('/api/auto/start', 'POST', { target: chB });
  assert.equal(auto.status, 200, JSON.stringify(auto.data));
  const qa = await until('job của Chuỗi A', async () =>
    (await state()).jobs.find(j => j.nodeId === chA && j.status === 'queued'),
  );
  const cqa = await claim('ext');
  assert.equal(cqa?.id, qa.id);
  await lapsed(qa.id);
  assert.equal((await state()).autoRun.status, 'blocked', 'mất heartbeat báo cho chuỗi');
  await authed('/api/worker/heartbeat', { id: qa.id, lease: cqa.lease, name: 'ext' });
  assert.equal((await complete(qa.id, cqa.lease)).data.applied, true);
  const qb = await until('chuỗi chạy tiếp sang Chuỗi B', async () =>
    (await state()).jobs.find(j => j.nodeId === chB && j.status === 'queued'),
  );
  assert.equal((await state()).autoRun.status, 'running');
  const cqb = await claim('ext');
  assert.equal(cqb?.id, qb.id);
  await complete(qb.id, cqb.lease);
  const chainEnd = await until('chuỗi hoàn tất', async () => {
    const run = (await state()).autoRun;
    return run.status !== 'running' && run;
  });
  assert.equal(chainEnd.status, 'completed', chainEnd.message);

  // ---- 6. zone batch: ends saying which ChatGPT images are not back, then counts them in ----
  assert.equal((await api('/api/project', 'PATCH', { defaults: { image: 'web' } })).status, 200);
  await webNode('Khu vực 1');
  await webNode('Khu vực 2');
  const zb = await api('/api/auto/images/start', 'POST', { zone: 'production' });
  assert.equal(zb.status, 200, JSON.stringify(zb.data));
  const outstanding = [];
  let first = true;
  const batchEnd = await until('batch khu vực kết thúc', async () => {
    const run = (await state()).autoImageRun;
    if (run.status !== 'running') return run;
    const c = await claim('ext');
    if (!c) return null;
    if (first) await complete(c.id, c.lease);
    else {
      const f = await authed('/api/worker/fail', {
        id: c.id,
        lease: c.lease,
        error: 'ChatGPT không trả ảnh',
        needsReview: true,
      });
      assert.equal(f.data.status, 'needs_review');
      outstanding.push(c);
    }
    first = false;
    return null;
  });
  assert.ok(outstanding.length >= 1, 'batch có ít nhất một ảnh chưa về');
  assert.equal(batchEnd.status, 'blocked', 'không báo "Đã tạo xong" khi còn ảnh chưa về');
  assert.match(batchEnd.message, /chưa về/, batchEnd.message);
  for (const c of outstanding) assert.equal((await complete(c.id, c.lease)).data.applied, true);
  const batchAfter = (await state()).autoImageRun;
  assert.equal(batchAfter.status, 'completed', batchAfter.message);
  assert.equal(batchAfter.message, 'Đã tạo xong ảnh của khu vực');

  // ---- 7. app restart while ChatGPT draws: late, revived by the old lease, image lands ----
  const n7 = await webNode('Khởi động lại');
  const j7 = await newJob(n7);
  const c7 = await claim('ext');
  assert.equal(c7?.id, j7.id);
  proc.kill();
  await new Promise(r => proc.once('exit', r));
  await start();
  const j7After = await jobOf(j7.id);
  assert.equal(j7After.status, 'needs_review', 'khởi động lại: không gửi lại');
  assert.equal(j7After.late, true);
  assert.equal(j7After.lease, c7.lease);
  const hb7 = await authed('/api/worker/heartbeat', { id: j7.id, lease: c7.lease, name: 'ext' });
  assert.equal(hb7.data.status, 'running', 'heartbeat lease cũ hồi sinh sau khởi động lại');
  const done7 = await complete(j7.id, c7.lease, BLUE);
  assert.equal(done7.data.applied, true);
  assert.equal((await imageOf(n7)).id, done7.data.asset.id);

  console.log(
    'PASS: late ChatGPT images — heartbeat lapse keeps the lease (late) and a heartbeat revives it, late complete applies, duplicate complete is stored once, a node that moved on keeps its image (result kept on the job), fail after send keeps the conversation URL and "Lấy lại ảnh" queues a recover only the same recover-capable worker claims under a new lease (old lease refused), a lapse after send is re-queued as a recover on its own while its worker is online, fail before send is plain failed, an auto chain stopped by a lapse runs on when the late image lands, a zone batch reports images not back yet then completes when they land, a restart keeps the job late and its old lease revives it',
  );
} finally {
  proc?.kill();
}
