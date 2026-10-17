// End-to-end test for the push channel (/api/events): the UI holds one open connection and the
// server sends it a line the moment the graph changes or a worker hands in a result, so a finished
// image/video shows up without waiting for a poll. No mocks — a real server, a real SSE connection
// over HTTP, a real worker claim/complete with a real MP4.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-events-'));
// A real (tiny) MP4: a valid ISO-BMFF ftyp box.
const mp4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);
const PORT = 17801;
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
  return { status: r.status, data };
}

// A real (1x1) PNG, what the Seedvis stand-in hands back.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=',
  'base64',
);
// Seedvis itself, over real HTTP on this machine: the tool's OWN generation path (the server polls
// the API and stores the file), which is not the worker path tested below — and the one a user
// actually waits on in front of the canvas.
const SV_KEY = 'sv-events-key-1234';
const SV_PORT = 17802;
const SV_API = 'http://127.0.0.1:' + SV_PORT + '/api/v1';
const svJobs = new Map();
const seedvisMock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/cdn/')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(png);
  }
  if (req.headers.authorization !== 'Bearer ' + SV_KEY)
    return send(401, { error: { code: 'unauthorized', message: 'Invalid key' } });
  if (req.url === '/api/v1/account/info') return send(200, { data: { balance: 7, plan: 'Pro' } });
  if (req.url === '/api/v1/models') return send(200, { data: [{ id: 'GEM_PIX_2' }] });
  const life = (id, j) => ({
    id,
    status: j.status,
    is_final: j.status === 'completed',
    next: j.status === 'completed'
      ? { action: 'done' }
      : { action: 'poll', url: SV_API + '/developer/generations/' + id + '?wait=0', after_seconds: 1 },
    outputs:
      j.status === 'completed'
        ? [{ type: 'image', url: 'http://127.0.0.1:' + SV_PORT + '/cdn/' + id + '_0' }]
        : [],
    references: [],
  });
  const poll = req.url.match(/^\/api\/v1\/developer\/generations\/([\w-]+)\?wait=0$/);
  if (poll && req.method === 'GET') {
    const j = svJobs.get(poll[1]);
    if (!j) return send(404, { error: { code: 'not_found', message: 'Generation not found' } });
    j.polls = (j.polls || 0) + 1;
    j.status = j.polls >= 2 ? 'completed' : 'processing';
    return send(200, { success: true, data: life(poll[1], j) });
  }
  if (req.method === 'POST') {
    const id = req.headers['idempotency-key'];
    if (!svJobs.has(id)) svJobs.set(id, { status: 'queued' });
    return send(202, life(id, svJobs.get(id)));
  }
  send(404, {});
});
await new Promise(r => seedvisMock.listen(SV_PORT, '127.0.0.1', r));

const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    SEEDVIS_API_KEY: '',
    MV_PORT: String(PORT),
    MV_DATA_DIR: dir,
    MV_SEEDVIS_URL: SV_API,
    MV_SEEDVIS_POLL_MS: '30',
  },
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

// Opens the stream the browser's EventSource would open and collects the events it receives.
async function openStream() {
  const ac = new AbortController();
  const r = await fetch(BASE + '/api/events', { signal: ac.signal });
  assert.equal(r.status, 200, 'luồng sự kiện phải mở được');
  assert.match(
    r.headers.get('content-type') || '',
    /text\/event-stream/,
    'phải là text/event-stream',
  );
  const events = [];
  let buffer = '';
  (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        // SSE frames are separated by a blank line; keep the trailing partial frame in the buffer.
        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const frame of frames) {
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          if (name) events.push(name);
        }
      }
    } catch {} // the abort below ends the read
  })();
  return { events, close: () => ac.abort() };
}

// Waits for the stream to receive `n` events, or gives up — so the test fails on a missing push
// instead of hanging.
async function waitForEvents(stream, n, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (stream.events.length >= n) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`${label}: chờ ${n} sự kiện, chỉ nhận ${stream.events.length}`);
}

let stream = null;
try {
  await ready();
  const token = fs.readFileSync(path.join(dir, 'worker-token.txt'), 'utf8').trim();
  const authed = (p, body) =>
    api(p, 'POST', body, { Authorization: 'Bearer ' + token });

  stream = await openStream();

  // 1. A graph edit (mutate) pushes an event to the open window.
  const made = await api('/api/nodes', 'POST', { name: 'PushShot' });
  const id = made.data.nodes.find(n => n.name === 'PushShot').id;
  await waitForEvents(stream, 1, 'thêm node phải đẩy sự kiện');
  assert.equal(stream.events[0], 'change', 'tên sự kiện là "change"');

  // 2. A worker result pushes an event too. This is the case the poll CANNOT see: a result does
  //    not bump db.revision (an assistant plan waiting for approval compares revisions), so
  //    without the push an idle window would never learn the video landed.
  await api('/api/node', 'PATCH', { id, seedvis: { video: false }, gvids: { video: true } });
  const revisionBefore = (await api('/api/revision')).data.revision;
  const jobId = (await api('/api/jobs', 'POST', { nodeId: id, kind: 'video' })).data.job.id;
  const claimed = (await authed('/api/worker/claim', { name: 'ext', kinds: ['video'] })).data.job;
  assert.ok(claimed && claimed.id === jobId, 'worker claim được job video');
  const before = stream.events.length;
  const done = await authed('/api/worker/complete', {
    id: jobId,
    lease: claimed.lease,
    name: 'push.mp4',
    mime: 'video/mp4',
    base64: mp4.toString('base64'),
  });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  await waitForEvents(stream, before + 1, 'worker nộp kết quả phải đẩy sự kiện');

  // The result really is on the graph (a video gets its own branch node) …
  const after = await api('/api/state');
  const branch = after.data.nodes.find(n => n.source === id && n.video);
  assert.ok(branch, 'video phải thành node nhánh');
  // … while the revision is unchanged, which is exactly why the push is needed.
  assert.equal(
    (await api('/api/revision')).data.revision,
    revisionBefore,
    'kết quả worker KHÔNG được tăng revision (kế hoạch trợ lý so revision để huỷ)',
  );

  // 2b. The SAME must hold for the tool's own generation path (Seedvis): the server submits, polls
  //     and stores the image itself, so no worker ever calls /api/worker/complete. Without a push
  //     here the window is blind — the result does not bump the revision, and by the next poll the
  //     job is no longer active, so nothing ever tells the canvas the picture arrived (F5 did).
  assert.equal((await api('/api/seedvis/key', 'POST', { key: SV_KEY })).data.configured, true);
  const svNode = (await api('/api/nodes', 'POST', { name: 'SeedvisShot' })).data.nodes.find(
    n => n.name === 'SeedvisShot',
  ).id;
  assert.equal(
    (
      await api('/api/node', 'PATCH', {
        id: svNode,
        seedvis: { image: { model: 'GEM_PIX_2', aspectRatio: '16:9', upscale: 'none' } },
      })
    ).status,
    200,
  );
  const svRevisionBefore = (await api('/api/revision')).data.revision;
  const svLastDoneBefore = (await api('/api/revision')).data.lastDone;
  const svBefore = stream.events.length;
  const svJob = await api('/api/jobs', 'POST', { nodeId: svNode, kind: 'image' });
  assert.equal(svJob.status, 201, JSON.stringify(svJob.data));
  // the job's own events (queued → running) may or may not land; what must land is one AFTER it
  // finished, and the image must be on the node by then.
  for (let i = 0; i < 200; i++) {
    const j = (await api('/api/state')).data.jobs.find(x => x.id === svJob.data.job.id);
    if (!['queued', 'running'].includes(j.status)) {
      assert.equal(j.status, 'completed', j.error);
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  const withImage = (await api('/api/state')).data.nodes.find(n => n.id === svNode);
  assert.ok(withImage.image, 'ảnh Seedvis phải nằm trên node');
  await waitForEvents(stream, svBefore + 1, 'ảnh Seedvis xong phải đẩy sự kiện');
  assert.equal(
    (await api('/api/revision')).data.revision,
    svRevisionBefore,
    'và vẫn KHÔNG tăng revision (kế hoạch trợ lý so revision để huỷ)',
  );
  // The poll's safety net, for a window whose push connection was missed: the heartbeat carries
  // when the last job finished, which is the only thing in it that moved.
  const beat = (await api('/api/revision')).data;
  assert.ok(beat.lastDone, 'nhịp /api/revision nói job vừa xong lúc nào');
  assert.equal(beat.active, 0, 'và lúc này không còn job chạy — nhịp cũ sẽ mù ở đây');
  assert.ok(
    beat.lastDone > svLastDoneBefore,
    `mốc job xong phải tiến (${svLastDoneBefore} → ${beat.lastDone})`,
  );
  const render = fs.readFileSync(new URL('./public/js/render.js', import.meta.url), 'utf8');
  assert.match(render, /lastDone/, 'và poll của trình duyệt đọc mốc đó');

  // 3. A second window gets its own stream, and both are served.
  const second = await openStream();
  await api('/api/nodes', 'POST', { name: 'SecondWindow' });
  await waitForEvents(second, 1, 'cửa sổ thứ hai cũng nhận đẩy');
  second.close();

  // 4. A closed connection is dropped, and the server keeps working for the rest.
  await new Promise(r => setTimeout(r, 300));
  const stillOk = await api('/api/nodes', 'POST', { name: 'AfterClose' });
  assert.equal(stillOk.status, 201, 'server vẫn phục vụ sau khi một luồng đóng');
  await waitForEvents(stream, stream.events.length + 1, 'luồng còn lại vẫn nhận đẩy');

  console.log(
    'PASS: push channel — /api/events là text/event-stream, thêm node đẩy "change", worker nộp kết quả đẩy sự kiện DÙ revision không đổi (video vào node nhánh), ảnh Seedvis do chính tool tạo cũng đẩy sự kiện khi xong, nhịp /api/revision mang mốc job xong để poll làm lưới an toàn, nhiều cửa sổ cùng nhận, đóng một luồng không ảnh hưởng luồng khác',
  );
} catch (e) {
  console.error('FAIL:', e.message);
  if (errLog) console.error('server stderr:\n' + errLog);
  process.exitCode = 1;
} finally {
  stream?.close();
  proc.kill();
  seedvisMock.close();
  await new Promise(r => setTimeout(r, 300));
  fs.rmSync(dir, { recursive: true, force: true });
}
