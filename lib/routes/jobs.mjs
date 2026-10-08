// Routes: create/collect/cancel jobs and the Orbit worker bridge.
import crypto from 'node:crypto';
import { NEXT, body, json, requireWorker } from '../http.mjs';
import { onAutoJobDone, onAutoJobFailed } from '../auto.mjs';
import {
  checkLease,
  collectJob,
  createBranchNode,
  createJob,
  isWebImage,
  queueRecover,
  recoverWorkerOn,
  requireIdle,
  scheduleRecover,
  webResultMovedOn,
} from '../jobs.mjs';
import { storeAsset } from '../media.mjs';
import { getNode } from '../nodes.mjs';
import { db, livePorts, save } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { pump, resumeSeedvis } from '../runner.mjs';
import { inputsMoved, setImage } from '../staleness.mjs';

// How many ChatGPT (web worker) jobs may run at once across all connected workers. Each
// extension also throttles itself per account (default 3 tabs); raise this for more accounts.
const WEB_CAP = Math.max(1, Number(process.env.MV_WORKER_CONCURRENCY) || 12);

// A ChatGPT conversation page (also inside a GPT), without its query string.
const CONVERSATION = /^https:\/\/chatgpt\.com\/(?:g\/[\w-]+\/)?c\/[0-9a-f-]{36}(?=$|[?#])/i;
// What a ChatGPT worker reports about the site, so a late image can be found again: its progress
// line, that the prompt went out, and the conversation it is in.
function noteWeb(j, b) {
  if (b.progress) j.progress = String(b.progress).slice(0, 200);
  if (b.sent && !j.web?.sentAt) j.web = { ...j.web, sentAt: new Date().toISOString() };
  const url = CONVERSATION.exec(String(b.conversationUrl || ''))?.[0];
  if (url && !j.web?.conversationUrl) {
    j.web = { ...j.web, conversationUrl: url };
    // No new chat was opened between two jobs: which image there is whose cannot be told.
    const others = db.jobs.filter(o => o !== j && o.web?.conversationUrl === url);
    if (others.length) for (const o of [j, ...others]) o.web.shared = true;
  }
  if (b.replyText) j.web = { ...j.web, replyText: String(b.replyText).slice(0, 2000) };
}

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
    // A ChatGPT image: the extension opens its conversation again and takes the image there —
    // only while an extension that can do it is on (else the job would just sit in the queue).
    if (j && isWebImage(j) && j.status === 'needs_review') {
      if (!recoverWorkerOn(j.worker, 60000))
        throw new Error(
          'Chưa thấy extension ChatGPT (bản 0.4.0 trở lên' +
            (j.worker ? ', tên "' + j.worker + '"' : '') +
            ') đang bật. Bật worker ChatGPT trong extension rồi bấm lại.',
        );
      queueRecover(j);
      save();
      return json(res, 200, publicState());
    }
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
    // Fetching a ChatGPT image again: its conversation stays, and so does the button.
    if (j.recover) {
      j.status = 'needs_review';
      j.progress = 'Đã hủy lấy lại ảnh; bấm "Lấy lại ảnh" để thử lại';
    } else j.status = 'cancelled';
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
    const caps = Array.isArray(b.kinds) && b.kinds.length ? b.kinds.map(String) : ['image'];
    const sites = Array.isArray(b.sites) ? b.sites.map(String).filter(Boolean) : [];
    // when this worker last asked for work it can recover ChatGPT images with (a Vids-only or old
    // extension under the same name cannot: a recover queued for it would wait forever)
    if (caps.includes('recover')) (db.recoverWorkers = db.recoverWorkers || {})[name] = now;
    const bare = x => !x.payload.orbit && !x.payload.seedvis;
    const runningWeb = db.jobs.filter(x => x.status === 'running' && bare(x)).length;
    // A recover (fetch a ChatGPT image from its conversation) goes only to a worker that says it
    // can — an older one would send the prompt again — and that is logged in to the same ChatGPT
    // account, i.e. the worker that sent it. Recovers go first: their image already exists.
    const fits = x => {
      if (x.recover) return caps.includes('recover') && (!x.worker || x.worker === name);
      if (!caps.includes(x.kind)) return false;
      const site = String(x.payload?.site || '');
      // A site-filtered worker must only receive jobs for one of its declared sites.
      // This applies to image and video jobs alike; unknown/untagged jobs stay for legacy workers.
      if (sites.length) return sites.includes(site);
      // A legacy worker without `sites` must never receive a Muse job.
      if (site === 'musechat') return false;
      return true;
    };
    const pick = rec =>
      db.jobs.find(x => x.status === 'queued' && bare(x) && !!x.recover === rec && fits(x));
    const j = runningWeb >= WEB_CAP ? null : pick(true) || pick(false);
    if (j) {
      j.status = 'running';
      j.startedAt = new Date().toISOString();
      j.heartbeat = now;
      j.lease = crypto.randomUUID(); // a recover too: the first run's lease stops counting
      j.worker = name;
      j.workerCaps = caps;
      if (j.recover) j.progress = 'Extension đang mở lại cuộc trò chuyện ChatGPT để lấy ảnh';
    }
    save();
    return json(res, 200, { job: j || null });
  }
  if (p === '/api/worker/heartbeat' && req.method === 'POST') {
    requireWorker(req);
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    checkLease(j, b, { late: true });
    const now = Date.now();
    j.heartbeat = now;
    // The heartbeat carries the worker name so liveness stays fresh even when the worker's
    // slots are full (it is not claiming then).
    if (b.name) {
      db.workers = db.workers || {};
      db.workers[String(b.name).slice(0, 100)] = now;
    }
    if (db.worker) db.worker.lastSeen = now;
    // Its worker is back (the browser slept, or this app restarted): the job runs on. It stays
    // late, so its image still lands only if the node has not moved on meanwhile.
    if (j.status !== 'running') {
      j.status = 'running';
      j.error = null;
      delete j.recoverAt;
      j.progress = 'Extension đã kết nối lại, đang chờ ảnh ChatGPT';
    }
    noteWeb(j, b);
    save();
    return json(res, 200, { ok: true, status: j.status });
  }
  if (p === '/api/worker/complete' && req.method === 'POST') {
    requireWorker(req);
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    // The same result again (the extension retries when an answer got lost): stored only once.
    if (j && b.lease && j.lease === b.lease && j.status === 'completed')
      return json(res, 200, {
        ok: true,
        asset: j.result,
        applied: j.applied !== false,
        duplicate: true,
      });
    checkLease(j, b, { late: true });
    noteWeb(j, b);
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
    // A late ChatGPT image lands only while the node still waits for it; otherwise it stays on
    // the job, to download from the queue.
    const movedOn = j.late ? webResultMovedOn(j) : null;
    j.status = 'completed';
    j.result = a;
    j.completedAt = new Date().toISOString();
    j.error = null;
    delete j.recoverAt;
    if (movedOn) {
      j.applied = false;
      j.progress = `Ảnh ChatGPT về muộn, không ghi vào node (${movedOn}): tải ở hàng đợi nếu cần`;
      onAutoJobDone(j); // moves no chain, but a zone batch counts it as back
      save();
      pump();
      return json(res, 200, { ok: true, asset: a, applied: false });
    }
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
    if (j.late && n) j.progress = 'Ảnh ChatGPT về muộn, đã ghi vào node';
    // The worker path bypasses the runner, so advance any auto image chain here and pump the
    // next job (launch() ignores this bare job; feedAuto queues the chain's next node).
    onAutoJobDone(j);
    save();
    pump();
    return json(res, 200, { ok: true, asset: a, applied: true });
  }
  if (p === '/api/worker/fail' && req.method === 'POST') {
    requireWorker(req);
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    checkLease(j, b, { late: true });
    noteWeb(j, b);
    // The first run reporting in after a fetch of its image was queued: that one brings it.
    if (j.status === 'queued') {
      save();
      return json(res, 200, { ok: true, status: j.status });
    }
    j.error = String(b.error || 'Worker failed').slice(0, 2000);
    // Sent: the site got the prompt (it may still deliver, and a generation is spent), so the
    // job waits for review — a ChatGPT image for its late result or a fetch from its
    // conversation. Not sent: nothing happened there, it is safe to run again. An older
    // extension always says needsReview; a recover only opened what was sent before.
    // A worker that reports the send itself is believed when it says the prompt never went out
    // and no conversation was recorded (nothing spent: safe to re-run); an older one is not.
    const knows = j.workerCaps?.includes('recover');
    const sent = !!(
      j.recover ||
      b.needsReview ||
      j.web?.conversationUrl ||
      (!knows && j.web?.sentAt)
    );
    j.status = sent ? 'needs_review' : 'failed';
    if (sent && isWebImage(j)) {
      j.late = true;
      scheduleRecover(j, 90000);
    }
    onAutoJobFailed(j, { message: j.error }); // a failed node blocks its auto image chain
    save();
    pump();
    return json(res, 200, { ok: true, status: j.status });
  }
  return NEXT;
}
