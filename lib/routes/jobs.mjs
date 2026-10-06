// Routes: create/collect/cancel jobs and the Orbit worker bridge.
import crypto from 'node:crypto';
import { NEXT, body, json, requireWorker } from '../http.mjs';
import { onAutoJobDone, onAutoJobFailed } from '../auto.mjs';
import { checkLease, collectJob, createBranchNode, createJob, requireIdle } from '../jobs.mjs';
import { storeAsset } from '../media.mjs';
import { getNode } from '../nodes.mjs';
import { db, livePorts, save } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { pump, resumeSeedvis } from '../runner.mjs';
import { inputsMoved, setImage } from '../staleness.mjs';

// How many ChatGPT (web worker) jobs may run at once across all connected workers. Each
// extension also throttles itself per account (default 3 tabs); raise this for more accounts.
const WEB_CAP = Math.max(1, Number(process.env.MV_WORKER_CONCURRENCY) || 12);

export async function handle(req, res, p, u) {
  if (p === '/api/jobs' && req.method === 'POST') {
    if (db.autoRun?.status === 'running' || db.autoVideoRun?.status === 'running')
      throw new Error('Đang chạy tự động. Dừng chuỗi trước khi chạy riêng.');
    const j = await createJob(req, await body(req));
    pump(req);
    return json(res, 201, { job: j });
  }
  if (p === '/api/jobs/collect' && req.method === 'POST') {
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    if (
      !j ||
      !['needs_review', 'script_completed'].includes(j.status) ||
      !(j.payload.output || j.payload.seedvis)
    )
      throw new Error('Tác vụ chưa thể nhận file');
    requireIdle();
    if (j.payload.seedvis) resumeSeedvis(j);
    else await collectJob(j);
    return json(res, 200, publicState());
  }
  if (p === '/api/jobs/cancel' && req.method === 'POST') {
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    if (!j || j.status !== 'queued') throw new Error('Chỉ hủy được job chưa chạy.');
    j.status = 'cancelled';
    save();
    return json(res, 200, { ok: true });
  }
  // Every window the worker should pull from. One extension serves them all, so the real
  // ChatGPT ceiling is its own tab count, not a per-window number. Lives under /api/worker/
  // because only that prefix is reachable from the extension's origin.
  if (p === '/api/worker/windows' && req.method === 'GET') {
    requireWorker(req);
    return json(res, 200, { ports: livePorts().map(w => w.port) });
  }
  if (p === '/api/worker/claim' && req.method === 'POST') {
    requireWorker(req);
    const b = await body(req);
    const name = String(b.name || 'Web worker').slice(0, 100);
    const now = Date.now();
    db.workers = db.workers || {};
    db.workers[name] = now; // several browsers/accounts can each be a worker
    db.worker = { name, lastSeen: now };
    // Web worker jobs run concurrently up to WEB_CAP (unlike Orbit, which is serial). Only
    // bare jobs (no seedvis/orbit payload) are the web worker's; Seedvis/Orbit run on their
    // own and don't count here. find()+set is synchronous, so two parallel claims never grab
    // the same job.
    // A worker says which kinds it can run (image, text for the Director agent). Old extensions
    // send nothing → they only take image jobs, so a director text job never lands on one that
    // would choke on it.
    const caps = Array.isArray(b.kinds) && b.kinds.length ? b.kinds : ['image'];
    const bare = x => !x.payload.orbit && !x.payload.seedvis;
    const runningWeb = db.jobs.filter(x => x.status === 'running' && bare(x)).length;
    const j =
      runningWeb >= WEB_CAP
        ? null
        : db.jobs.find(x => x.status === 'queued' && bare(x) && caps.includes(x.kind));
    if (j) {
      j.status = 'running';
      j.startedAt = new Date().toISOString();
      j.heartbeat = now;
      j.lease = crypto.randomUUID();
    }
    save();
    return json(res, 200, { job: j || null });
  }
  if (p === '/api/worker/heartbeat' && req.method === 'POST') {
    requireWorker(req);
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    checkLease(j, b);
    const now = Date.now();
    j.heartbeat = now;
    // The heartbeat carries the worker name so liveness stays fresh even when the worker's
    // slots are full (it is not claiming then).
    if (b.name) {
      db.workers = db.workers || {};
      db.workers[String(b.name).slice(0, 100)] = now;
    }
    if (db.worker) db.worker.lastSeen = now;
    save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/worker/complete' && req.method === 'POST') {
    requireWorker(req);
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    checkLease(j, b);
    // A director text turn returns a STRING, not a file: no media, no node to attach to.
    // The /api/director/agent request that enqueued it is polling db.jobs for this result.
    if (j.kind === 'text') {
      j.status = 'completed';
      j.result = { text: String(b.text ?? '').slice(0, 200000) };
      j.completedAt = new Date().toISOString();
      save();
      return json(res, 200, { ok: true });
    }
    if (!String(b.mime).startsWith(j.kind + '/')) throw new Error('Worker trả về sai loại file');
    const a = storeAsset(b);
    j.status = 'completed';
    j.result = a;
    j.completedAt = new Date().toISOString();
    const n = getNode(j.nodeId);
    j.resultStale = db.revision !== j.payload.projectRevision;
    if (!n) j.progress = 'Đã nhận file (node nguồn đã bị xóa)';
    else if (j.kind === 'video' && !n.terminal)
      // a clip is its own node, whoever rendered it
      createBranchNode(n.id, a, j.resultStale || inputsMoved(j));
    // An edit only touches up the image it was sent, so a node already stale stays stale.
    else if (j.kind === 'image')
      setImage(n, a, (j.payload.edit && n.stale) || j.resultStale || inputsMoved(j));
    else {
      n[j.kind] = a;
      n.videoStale = j.resultStale;
    }
    // The worker path bypasses the runner, so advance any auto image chain here and pump the
    // next job (launch() ignores this bare job; feedAuto queues the chain's next node).
    onAutoJobDone(j);
    save();
    pump();
    return json(res, 200, { ok: true, asset: a });
  }
  if (p === '/api/worker/fail' && req.method === 'POST') {
    requireWorker(req);
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    checkLease(j, b);
    j.status = b.needsReview ? 'needs_review' : 'failed';
    j.error = String(b.error || 'Worker failed').slice(0, 2000);
    onAutoJobFailed(j, { message: j.error }); // a failed node blocks its auto image chain
    save();
    pump();
    return json(res, 200, { ok: true });
  }
  return NEXT;
}
