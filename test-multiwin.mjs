// Two projects open at once, in two real server processes, against one mock Seedvis account.
// Proves the thing the window model promises: each project orders its own work and neither
// waits on the other's queue — the only shared limit is the provider's own capacity.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const MAIN = 17900,
  API = 'http://127.0.0.1:17902/api/v1',
  KEY = 'sk-multiwin',
  CAP = 2; // small on purpose: overlap past the cap is then obvious
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=',
  'base64',
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-multiwin-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-mw-work-'));

// --- mock Seedvis: one account, counting how many generations are open at the same moment
let inFlight = 0,
  maxInFlight = 0,
  hold = false; // true → generations never finish, so a window stays busy on purpose
const jobs = new Map();
const lifecycle = (id, j) => ({
  id,
  status: j.status,
  is_final: ['completed', 'failed'].includes(j.status),
  next: ['completed', 'failed'].includes(j.status)
    ? { action: 'done' }
    : { action: 'poll', url: API + '/developer/generations/' + id + '?wait=0', after_seconds: 1 },
  outputs:
    j.status === 'completed' ? [{ type: 'image', url: 'http://127.0.0.1:17902/cdn/' + id }] : [],
  references: [],
});
const mock = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith('/__hold/')) {
    hold = req.url.endsWith('1');
    return send(200, { hold });
  }
  if (req.url.startsWith('/cdn/')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(png);
  }
  if (req.headers.authorization !== 'Bearer ' + KEY)
    return send(401, { error: { code: 'unauthorized', message: 'Invalid key' } });
  if (req.url === '/api/v1/account/info') return send(200, { data: { balance: 1, plan: 'Pro' } });
  if (req.url === '/api/v1/models') return send(200, { data: [{ id: 'GEM_PIX_2' }] });
  const poll = req.url.match(/^\/api\/v1\/developer\/generations\/([\w-]+)\?wait=0$/);
  if (poll && req.method === 'GET') {
    const j = jobs.get(poll[1]);
    if (!j) return send(404, { error: { code: 'not_found', message: 'gone' } });
    // Finish on the 3rd poll so jobs genuinely overlap and the cap is measurable.
    j.polls = (j.polls || 0) + 1;
    if (!hold && j.polls >= 3 && j.status !== 'completed') {
      j.status = 'completed';
      inFlight--;
    } else if (j.status === 'queued') j.status = 'processing';
    return send(200, { success: true, data: lifecycle(poll[1], j) });
  }
  if (req.method === 'POST') {
    const id = req.headers['idempotency-key'];
    if (jobs.has(id)) return send(202, lifecycle(id, jobs.get(id)));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    jobs.set(id, { status: 'queued' });
    return send(202, lifecycle(id, jobs.get(id)));
  }
  send(404, {});
});
await new Promise(r => mock.listen(17902, '127.0.0.1', r));

const env = {
  ...process.env,
  SEEDVIS_API_KEY: '',
  MV_ORBIT_URL: 'http://127.0.0.1:1',
  MV_DATA_DIR: dir,
  MV_SEEDVIS_URL: API,
  MV_SEEDVIS_CONCURRENCY: String(CAP),
  MV_SEEDVIS_POLL_MS: '60',
};
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...env, MV_PORT: String(MAIN) },
  stdio: 'pipe',
});
const call = async (port, p, method = 'GET', body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}` + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const api = (p, m, b) => call(MAIN, p, m, b);
const settled = async (port, want) => {
  for (let i = 0; i < 400; i++) {
    const s = (await call(port, '/api/state')).data;
    const live = s.jobs.filter(j => ['queued', 'running'].includes(j.status));
    const done = s.jobs.filter(j => j.status === 'completed');
    if (!live.length && done.length >= want) return s;
    await new Promise(r => setTimeout(r, 100));
  }
  const s = (await call(port, '/api/state')).data;
  assert.fail(
    `cổng ${port} chưa xong: ` + s.jobs.map(j => j.status + '/' + (j.error || '')).join(', '),
  );
};

try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });
  await api('/api/seedvis/key', 'POST', { key: KEY });
  const token = (await api('/api/worker-info')).data.token;

  // Two projects, each with its own working folder.
  const a = fs.mkdtempSync(path.join(work, 'A-'));
  const b = fs.mkdtempSync(path.join(work, 'B-'));
  let r = await api('/api/projects', 'POST', { name: 'A', theme: 'music', exportDir: a });
  assert.equal(r.status, 201);
  const idA = r.data.projects.find(p => p.name === 'A').id;
  r = await api('/api/projects', 'POST', { name: 'B', theme: 'music', exportDir: b });
  assert.equal(r.status, 201);
  const idB = r.data.projects.find(p => p.name === 'B').id;

  // Back to A in this window, B in a window of its own: two processes, two queues.
  await api('/api/projects/switch', 'POST', { id: idA });
  const win = await api('/api/projects/open-window', 'POST', { id: idB });
  assert.equal(win.status, 200, 'cửa sổ thứ hai mở được');
  const portB = Number(new URL(win.data.opened.url).port);
  assert.notEqual(portB, MAIN);

  // The extension finds every window from whichever one it was given, so the jobs of a
  // project in a secondary window are reachable at all.
  assert.equal((await call(MAIN, '/api/worker/windows')).status, 401, 'cần token worker');
  const wins = await call(MAIN, '/api/worker/windows', 'GET', undefined, {
    Authorization: 'Bearer ' + token,
  });
  assert.equal(wins.status, 200);
  assert.ok(wins.data.ports.includes(MAIN), 'liệt kê cửa sổ chính');
  assert.ok(wins.data.ports.includes(portB), 'liệt kê cửa sổ phụ');
  // A secondary window answers the same question, so the extension may be pointed at either.
  const winsB = await call(portB, '/api/worker/windows', 'GET', undefined, {
    Authorization: 'Bearer ' + token,
  });
  assert.deepEqual([...winsB.data.ports].sort(), [...wins.data.ports].sort());

  // Both projects order work at the same moment. Neither waits for the other.
  const shots = ['singer', 'stage']; // text-to-image nodes: no parent image needed
  const queued = [];
  for (const nodeId of shots) {
    queued.push(call(MAIN, '/api/jobs', 'POST', { nodeId, kind: 'image' }));
    queued.push(call(portB, '/api/jobs', 'POST', { nodeId, kind: 'image' }));
  }
  for (const q of await Promise.all(queued))
    assert.equal(q.status, 201, 'xếp job: ' + JSON.stringify(q.data));

  const stateA = await settled(MAIN, shots.length);
  const stateB = await settled(portB, shots.length);
  for (const [label, s] of [
    ['A', stateA],
    ['B', stateB],
  ]) {
    const bad = s.jobs.filter(j => j.status !== 'completed');
    assert.equal(bad.length, 0, `project ${label} còn job hỏng: ` + JSON.stringify(bad[0] || {}));
  }

  // The point of the whole exercise: 6 jobs from two processes, and the account never had
  // more than its own capacity open at once.
  assert.ok(
    maxInFlight <= CAP,
    `tài khoản Seedvis bị đẩy quá sức chứa: ${maxInFlight} > ${CAP} (trần dùng chung không hoạt động)`,
  );
  assert.ok(maxInFlight > 0, 'không có job nào thực sự gửi đi');
  // Slots are handed back, so the pool is not leaked after a run.
  const slots = fs.existsSync(path.join(dir, 'seedvis-slots'))
    ? fs.readdirSync(path.join(dir, 'seedvis-slots'))
    : [];
  assert.equal(slots.length, 0, 'slot chưa được nhả: ' + slots.join(', '));

  // Creating a project while this window is still generating must not be refused: it opens
  // in a window of its own instead, and the running project stays put.
  await fetch('http://127.0.0.1:17902/__hold/1'); // this job will not finish on its own
  await call(MAIN, '/api/jobs', 'POST', { nodeId: 'singer', kind: 'image' });
  for (
    let i = 0;
    i < 100 && !(await api('/api/state')).data.jobs.some(j => j.status === 'running');
    i++
  )
    await new Promise(r => setTimeout(r, 50));
  const c = fs.mkdtempSync(path.join(work, 'C-'));
  const made = await api('/api/projects', 'POST', { name: 'C', theme: 'music', exportDir: c });
  assert.equal(made.status, 201, 'tạo project khi đang bận');
  assert.ok(made.data.opened?.url, 'project mới mở ở cửa sổ riêng');
  assert.equal(made.data.name, 'A', 'cửa sổ này vẫn giữ project đang chạy');
  await fetch('http://127.0.0.1:17902/__hold/0'); // let the held job finish
  await settled(MAIN, 1);
  await api('/api/projects/close-window', 'POST', { id: made.data.opened.id }).catch(() => {});
  await api('/api/projects/close-window', 'POST', { id: idB }).catch(() => {});

  console.log(
    'PASS: hai project chạy song song ở hai process, trần Seedvis dùng chung đúng sức chứa tài khoản, slot được nhả, extension tìm được mọi cửa sổ từ bất kỳ cổng nào, tạo project khi đang bận mở cửa sổ riêng thay vì bị từ chối',
  );
} finally {
  proc.kill();
  mock.close();
}
