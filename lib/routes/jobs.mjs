// Routes: create/collect/cancel jobs and the Orbit worker bridge.
import crypto from 'node:crypto';
import { NEXT, body, json, requireWorker } from '../http.mjs';
import { notify } from '../events.mjs';
import { onAutoJobDone, onAutoJobFailed } from '../auto.mjs';
import {
  autoProtectedIds,
  checkLease,
  collectJob,
  createBranchNode,
  createJob,
  isWebImage,
  jobResultStale,
  isRecoverableWebJob,
  queueRecover,
  recoverWorkerOn,
  requireIdle,
  scheduleRecover,
  webResultMovedOn,
} from '../jobs.mjs';
import { storeAsset } from '../media.mjs';
import { getNode } from '../nodes.mjs';
import { db, livePorts, save, saveSoon } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { onVideoRejected, pump, resumeSeedvis } from '../runner.mjs';
import { isRejection } from '../prompt-doctor.mjs';
import { inputsMoved, setImage } from '../staleness.mjs';

// How many ChatGPT (web worker) jobs may run at once across all connected workers. Each
// extension also throttles itself per account (default 3 tabs); raise this for more accounts.
const WEB_CAP = Math.max(1, Number(process.env.MV_WORKER_CONCURRENCY) || 12);
// Muse Chat opens a browser tab per job. The limit is per worker/account (the extension sends
// a stable profile id as its effective worker name), so several Muse accounts can run 10 each.
const MUSECHAT_CAP = Math.max(1, Number(process.env.MV_MUSECHAT_CONCURRENCY) || 10);
const queueGroupName = value => String(value || '').trim() === 'gvids' ? 'googlevids' : String(value || '').trim();

// A ChatGPT conversation page (also inside a GPT), without its query string.
const CONVERSATION = /^https:\/\/chatgpt\.com\/(?:g\/[\w-]+\/)?c\/[0-9a-f-]{36}(?=$|[?#])/i;
const MUSE_CONVERSATION = /^https:\/\/muse\.ai\/(?:[^\s?#]+)?(?:\?[^\s#]*)?$/i;
// What a ChatGPT worker reports about the site, so a late image can be found again: its progress
// line, that the prompt went out, and the conversation it is in.
function noteWeb(j, b) {
  if (b.progress) j.progress = String(b.progress).slice(0, 200);
  if (b.sent && !j.web?.sentAt) j.web = { ...j.web, sentAt: new Date().toISOString() };
  const site = j.payload?.site;
  const url = (site === 'musechat' ? MUSE_CONVERSATION : CONVERSATION)
    .exec(String(b.conversationUrl || ''))?.[0];
  if (url && !j.web?.conversationUrl) {
    j.web = { ...j.web, conversationUrl: url };
    // No new chat was opened between two jobs: which image there is whose cannot be told.
    const others = db.jobs.filter(o => o !== j && o.web?.conversationUrl === url);
    if (others.length) for (const o of [j, ...others]) o.web.shared = true;
  }
  if (b.replyText) j.web = { ...j.web, replyText: String(b.replyText).slice(0, 2000) };
}

export async function handle(req, res, p, u) {
  if (p === '/api/jobs/group/pause' && req.method === 'POST') {
    const b = await body(req);
    const group = queueGroupName(b.group);
    if (!['musechat', 'seedvis', 'googlevids', 'orbit'].includes(group)) throw new Error('Nhóm provider không hợp lệ.');
    db.queuePauses ??= {};
    db.queuePauses[group] = true;
    save();
    return json(res, 200, publicState());
  }
  if (p === '/api/jobs/group/resume' && req.method === 'POST') {
    const b = await body(req);
    const group = queueGroupName(b.group);
    db.queuePauses ??= {};
    delete db.queuePauses[group];
    save();
    pump(req);
    return json(res, 200, publicState());
  }
  if (p === '/api/jobs/group/retry' && req.method === 'POST') {
    const b = await body(req);
    const group = queueGroupName(b.group);
    if (!['musechat', 'seedvis', 'googlevids', 'orbit', 'web'].includes(group))
      throw new Error('Nhóm provider không hợp lệ.');
    const failed = db.jobs.filter(j => {
      if (j.status !== 'failed') return false;
      const site = j.payload?.site || (j.payload?.seedvis ? 'seedvis' : j.payload?.orbit ? 'orbit' : 'web');
      return site === group;
    });
    if (!failed.length) return json(res, 200, { ...publicState(), retried: 0 });
    for (const j of failed) {
      j.status = 'queued';
      j.error = null;
      j.warning = null;
      j.cancelRequested = false;
      j.progress = 'Đã xếp lại theo nhóm provider';
      j.retryCount = (j.retryCount || 0) + 1;
      j.updatedAt = new Date().toISOString();
    }
    save();
    pump(req);
    return json(res, 200, { ...publicState(), retried: failed.length });
  }
  if (p === '/api/jobs' && req.method === 'POST') {
    const input = await body(req);
    if (autoProtectedIds().has(input.nodeId))
      throw new Error('Node này đang thuộc chuỗi tự động hoặc là đầu vào của nó. Chọn node khác để chạy riêng.');
    const j = await createJob(req, input);
    pump(req);
    return json(res, 201, { job: j });
  }
  if (p === '/api/jobs/collect' && req.method === 'POST') {
    const b = await body(req),
      j = db.jobs.find(j => j.id === b.id);
    // A ChatGPT image: the extension opens its conversation again and takes the image there —
    // only while an extension that can do it is on (else the job would just sit in the queue).
    if (j && isRecoverableWebJob(j) && j.status === 'needs_review') {
      if (!recoverWorkerOn(j.worker, 60000, j.payload.site))
        throw new Error(
          'Chưa thấy extension ' + (j.payload.site === 'musechat' ? 'Muse' : 'ChatGPT') + ' có thể lấy lại kết quả' +
            (j.worker ? ' (worker "' + j.worker + '")' : '') +
            ' đang bật. Bật đúng worker trong extension rồi bấm lại.',
        );
      queueRecover(j);
      save();
      return json(res, 200, publicState());
    }
    if (
      !j ||
      !['needs_review', 'script_completed'].includes(j.status) ||
      !(j.payload.output || j.payload.seedvis || j.payload.seedane)
    )
      throw new Error('Tác vụ chưa thể nhận file');
    // Seedane: ask again under the same Idempotency-Key — it hands back the same job, never a
    // second render.
    if (j.payload.seedane) {
      j.status = 'queued';
      j.error = null;
      j.progress = 'Hỏi lại Seedane (cùng mã, không tạo mới)';
      save();
      pump(req);
      return json(res, 200, publicState());
    }
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
    db.workerMeta ??= {};
    db.workerMeta[name] = {
      workerId: name,
      sites,
      kinds: caps,
      museEnabled: sites.includes('musechat'),
      updatedAt: now,
    };
    // when this worker last asked for work it can recover ChatGPT images with (a Vids-only or old
    // extension under the same name cannot: a recover queued for it would wait forever)
    if (caps.includes('recover')) (db.recoverWorkers = db.recoverWorkers || {})[name] = now;
    const bare = x => !x.payload.orbit && !x.payload.seedvis && !x.payload.seedane;
    const runningWeb = db.jobs.filter(x => x.status === 'running' && bare(x)).length;
    const runningMuseChat = db.jobs.filter(
      x =>
        x.status === 'running' &&
        bare(x) &&
        x.payload?.site === 'musechat' &&
        x.worker === name,
    ).length;
    // Soft round-robin/load balancing across online Muse accounts: a worker may claim while
    // it is tied for the lowest active Muse count, so a fast-polling account cannot consume the
    // whole queue while another connected account is idle. The hard cap below remains per worker.
    const museWorkers = Object.entries(db.workerMeta || {})
      .filter(([id, meta]) => meta.museEnabled && now - Number(db.workers?.[id] || 0) < 20000)
      .map(([id]) => id);
    const activeMuseByWorker = id => db.jobs.filter(x => x.status === 'running' && x.worker === id && x.payload?.site === 'musechat').length;
    const minMuseActive = museWorkers.length ? Math.min(...museWorkers.map(activeMuseByWorker)) : runningMuseChat;
    // A recover (fetch a ChatGPT image from its conversation) goes only to a worker that says it
    // can — an older one would send the prompt again — and that is logged in to the same ChatGPT
    // account, i.e. the worker that sent it. Recovers go first: their image already exists.
    const fits = x => {
      if (db.queuePauses?.[String(x.payload?.site || '')]) return false;
      if (x.recover) return caps.includes('recover') && (!x.worker || x.worker === name) &&
        (x.payload?.site === 'musechat' ? sites.includes('musechat') : !sites.length || sites.includes('chatgpt'));
      // An account that hit ChatGPT's attachment limit must not immediately reclaim the same
      // job. The exclusion stays with the job, so each limited profile is tried at most once.
      if (Array.isArray(x.excludedWorkers) && x.excludedWorkers.includes(name)) return false;
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
      db.jobs.find(
        x =>
          x.status === 'queued' &&
          bare(x) &&
          !!x.recover === rec &&
          fits(x) &&
          (x.payload?.site !== 'musechat' || (runningMuseChat < MUSECHAT_CAP && runningMuseChat <= minMuseActive)),
      );
    const j = runningWeb >= WEB_CAP ? null : pick(true) || pick(false);
    if (j) {
      j.status = 'running';
      j.startedAt = new Date().toISOString();
      j.heartbeat = now;
      j.lease = crypto.randomUUID(); // a recover too: the first run's lease stops counting
      j.worker = name;
      j.workerCaps = caps;
      if (j.recover) j.progress = 'Extension đang mở lại cuộc trò chuyện ' +
        (j.payload.site === 'musechat' ? 'Muse' : 'ChatGPT') + ' để lấy ' + (j.kind === 'video' ? 'video' : 'ảnh');
      else if (j.handoffCount) {
        j.progress = `Đã chuyển job sang tài khoản "${name}", đang tải ảnh tham chiếu`;
        j.warning = null;
      }
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
    let reconnected = false;
    if (j.status !== 'running') {
      j.status = 'running';
      j.error = null;
      delete j.recoverAt;
      j.progress = 'Extension đã kết nối lại, đang chờ ảnh ChatGPT';
      reconnected = true;
    }
    noteWeb(j, b);
    // A plain liveness tick is debounced (fires every 10 s per job); a real reconnect is persisted
    // at once.
    if (reconnected) save();
    else saveSoon();
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
    const movedOn = j.late && j.kind === 'image' ? webResultMovedOn(j) : null;
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
      notify('worker-complete');
      pump();
      return json(res, 200, { ok: true, asset: a, applied: false });
    }
    const n = getNode(j.nodeId);
    j.resultStale = jobResultStale(j);
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
    // The image/video is on the node now. A result does NOT bump db.revision (an assistant plan
    // waiting for approval compares revisions and would be thrown away), so the open windows only
    // learn about it from this push.
    notify('worker-complete');
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
    // ChatGPT attachment quotas belong to one signed-in account. If no prompt was submitted,
    // return the job to the queue and exclude only that account so another browser profile can
    // pick it up. Never hand off after send, because that could spend the same generation twice.
    const handoff = !!(
      b.retryOtherWorker &&
      !sent &&
      isWebImage(j) &&
      j.payload?.site === 'chatgpt' &&
      Array.isArray(j.payload?.references) &&
      j.payload.references.length
    );
    if (handoff) {
      const limitedWorker = String(j.worker || b.name || '').slice(0, 100);
      j.excludedWorkers = [
        ...new Set([...(Array.isArray(j.excludedWorkers) ? j.excludedWorkers : []), limitedWorker]),
      ].filter(Boolean).slice(-20);
      j.handoffCount = (j.handoffCount || 0) + 1;
      j.warning = j.error;
      j.error = null;
      j.status = 'queued';
      j.progress = limitedWorker
        ? `Tài khoản "${limitedWorker}" đã hết lượt đính kèm; đang chờ tài khoản ChatGPT khác`
        : 'Tài khoản hiện tại đã hết lượt đính kèm; đang chờ tài khoản ChatGPT khác';
      j.updatedAt = new Date().toISOString();
      j.worker = null;
      j.workerCaps = null;
      j.startedAt = null;
      j.heartbeat = null;
      delete j.lease;
      save();
      pump();
      return json(res, 200, { ok: true, status: j.status, handedOff: true });
    }
    j.status = sent ? 'needs_review' : 'failed';
    if (sent && isRecoverableWebJob(j)) {
      j.late = true;
      scheduleRecover(j, 90000);
    }
    onAutoJobFailed(j, { message: j.error }); // a failed node blocks its auto image chain
    // Video chạy qua extension (Google Vids / Muse / ChatGPT) hỏng ở ĐÂY, không đi qua runJob,
    // nên bác sĩ prompt phải được gọi ở cả hai đường. Chỉ khi `failed`: `needs_review` nghĩa là
    // trang web đã nhận prompt và có thể đã tốn một lượt — chạy lại lúc đó là tốn tiền hai lần.
    // KHÔNG await: bước AI của thang leo có thể chờ LLM hàng phút, mà extension đang đứng chờ
    // chính response này. Chạy nền, tự save lấy.
    if (j.kind === 'video' && j.status === 'failed' && isRejection(j.error))
      onVideoRejected(j).catch(e => {
        j.progress = 'Tự sửa prompt lỗi: ' + e.message;
        save();
      });
    save();
    notify('worker-fail'); // the windows show the node's error without waiting for a poll
    pump();
    return json(res, 200, { ok: true, status: j.status });
  }
  return NEXT;
}
