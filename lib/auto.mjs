// Batch runs: auto image chain, zone image batch, auto video / retry / missing videos.
import { sessionUser } from '../orbit-client.mjs';
import crypto from 'node:crypto';
import { createJob, madeFromCurrentInputs } from './jobs.mjs';
import { assetRefs, getNode, imageParents, isSetting, isStageOnly } from './nodes.mjs';
import { db, save } from './projects.mjs';
import { providers, videoNeedsKeyframe } from './providers.mjs';
import { lastReq, pump, resumeSeedvis } from './runner.mjs';
import { nodeZone } from './zones.mjs';
import { groupsOf, isGroup } from './seedance.mjs';
import { isFrame, isMerged } from './merged.mjs';

// A node is eligible for auto-video (and retry) when it is a shot (or a merged scene, which
// films its frames in one clip) and its video input is ready: its own composed image, or the
// connected reference images in refs mode. A frame is an image of a merged scene, never filmed.
export function autoVideoEligible(n) {
  if (n.terminal || isSetting(n) || isFrame(n)) return false;
  if (!['production', 'merged'].includes(nodeZone(n))) return false;
  if (providers(n).video.type !== 'seedvis') return false;
  if (n.videoInput === 'refs' && !n.image) {
    const refs = assetRefs(n);
    return refs.length > 0 && !refs.some(r => getNode(r.role).stale);
  }
  return !!n.image && !n.stale;
}
// Nodes in a zone ready to generate an IMAGE via Seedvis and still missing one (or stale):
// text-to-image nodes, or compose nodes whose input images are ready. Used by the per-zone
// "quick image" batch (e.g. generate all characters, or all scenes, at once).
export const IMAGE_ZONES = new Set(['character', 'wardrobe', 'design', 'production', 'lipsync']);
export function imageBatchNodes(zone) {
  return db.nodes.filter(n => {
    if (n.terminal || isSetting(n) || isStageOnly(n)) return false;
    if (nodeZone(n) !== zone) return false;
    // Seedvis (API) and web (ChatGPT extension) nodes run the batch; Orbit nodes don't.
    if (!['seedvis', 'web'].includes(providers(n).image.type)) return false;
    if (imageParents(n).some(p => !p.image || p.stale)) return false;
    // its ChatGPT image is about to be fetched from the conversation: drawing it again would
    // spend a second generation and make that one land nowhere
    if (db.jobs.some(j => j.nodeId === n.id && j.status === 'needs_review' && j.recoverAt))
      return false;
    return !n.image || n.stale; // only fill missing/stale, so a re-run doesn't recharge done ones
  });
}
// Production nodes whose most recent video job failed (so they produced no output branch).
// A node counts as failed only while its LATEST video job is the failed one: a shot that
// failed and was then filmed again is done, and retrying it would pay for an extra clip.
const lastVideoJobs = () => {
  const last = new Map();
  for (const j of db.jobs) if (j.kind === 'video') last.set(j.nodeId, j);
  return [...last.values()];
};
export function failedVideoNodeIds() {
  return lastVideoJobs()
    .filter(j => j.status === 'failed')
    .map(j => j.nodeId);
}
// Seedvis jobs of a shot (or a Seedance group) that may have produced a PAID clip we never
// received — whatever came after them. Checking them again is free (a poll), filming again is not:
// - interrupted ones (needs_review: timed out, the app restarted while it ran);
// - ones an older version stopped while Seedvis was already rendering (cancelled, with a
//   Seedvis id, its last known state not final);
// - of the jobs Seedvis never confirmed receiving (no id): only one whose sending ended with no
//   answer (needs_review, or stopped after a lost reply: maybeSent), only the latest, only while
//   made from the node's current inputs, and never for a node that already has its video. It
//   is re-sent under its own Idempotency-Key: Seedvis hands back the job it has, or makes it
//   once. (A job stopped before any request left — or that Seedvis clearly refused — is not
//   one: re-sending it would simply be a new paid render.)
// For a refs shot still waiting for its keyframe, its keyframe image jobs count too.
const FINAL = ['completed', 'failed'];
const tracked = j => !!(j.remote?.id || j.remote?.pollUrl);
export function uncertainJobs(n) {
  const waitsForKeyframe = !n.image && n.videoInput === 'refs' && videoNeedsKeyframe(n);
  const mine = db.jobs.filter(
    j =>
      j.nodeId === n.id &&
      j.payload?.seedvis &&
      !j.result &&
      !j.conflict &&
      (j.kind === 'video' || (j.kind === 'image' && waitsForKeyframe)),
  );
  const withId = mine.filter(
    j =>
      tracked(j) &&
      (j.status === 'needs_review' ||
        (j.status === 'cancelled' && !FINAL.includes(j.remote?.status))),
  );
  if (hasVideoOutput(n) || groupFilmed(n)) return withId;
  const unsent = mine
    .filter(
      j =>
        !tracked(j) && (j.status === 'needs_review' || (j.status === 'cancelled' && j.maybeSent)),
    )
    .at(-1);
  return unsent && madeFromCurrentInputs(unsent) ? [...withId, unsent] : withId;
}
// Seedvis answered "another request under this key": someone must look on seedvis.com first.
export const hasConflict = n => db.jobs.some(j => j.nodeId === n.id && j.conflict && !j.result);
// Has this node already produced a video (its own, or at least one output branch)?
export const hasVideoOutput = n =>
  !!n.video || db.nodes.some(t => t.terminal && t.source === n.id && t.video);
// Shots a Seedance group films (they are wired into one), and those it already has filmed.
export const inGroup = n => groupsOf(n.id).length > 0;
const groupFilmed = n => groupsOf(n.id).some(hasVideoOutput);
// Nodes no batch run may film anew: a job of theirs may still bring a paid clip home, or
// Seedvis holds another request under its key. "✚ Tạo video còn thiếu" checks the former.
export const reviewVideoNodeIds = () =>
  new Set(
    db.nodes.filter(n => !n.terminal && (uncertainJobs(n).length || hasConflict(n))).map(n => n.id),
  );
// Every shot of the video column (and every Seedance group) as "✚ Tạo video còn thiếu"
// handles it — so an old project picks up where it stopped:
// - recheck: every job that may have been paid for, also on shots that have a clip (another
//   version comes home) and on Seedance groups;
// - film: shots with no clip, not in a Seedance group, nothing to check, ready — never
//   filmed, failed or stopped. A refs shot whose keyframe is being re-checked waits in the run;
// - blocked: a 409 conflict — someone must look on seedvis.com before the shot is filmed.
// A Seedance group is never filmed from here: a group render is the user's call.
export function missingVideoPlan() {
  const recheck = [],
    film = [],
    blocked = [];
  for (const n of db.nodes) {
    // A merged scene is filmed like a shot; its frames are images, never filmed on their own.
    // A lip-sync take's Omni jobs are re-checked here too (a paid clip must come home), but a take
    // is never filmed by this button: autoVideoEligible covers the shot columns only.
    const shot =
      !n.terminal &&
      !isSetting(n) &&
      !isFrame(n) &&
      ['production', 'merged', 'lipsync'].includes(nodeZone(n));
    if (!shot && !isGroup(n)) continue;
    // already on its way
    if (db.jobs.some(j => j.nodeId === n.id && ['queued', 'running'].includes(j.status))) continue;
    const jobs = uncertainJobs(n);
    recheck.push(...jobs);
    if (!shot || inGroup(n) || hasVideoOutput(n)) continue;
    if (hasConflict(n)) {
      blocked.push(n);
      continue;
    }
    if (jobs.every(j => j.kind === 'image') && autoVideoEligible(n)) film.push(n);
  }
  return { recheck, film, blocked };
}
// What the "✚ Tạo video còn thiếu" button counts: the shots without any video it covers, and
// the jobs to check again on nodes that have one (or on Seedance groups).
export function missingVideoIds() {
  const { recheck, film } = missingVideoPlan();
  const ids = new Set([...film.map(n => n.id), ...recheck.map(j => j.nodeId)]);
  const missing = [...ids].filter(id => {
    const n = getNode(id);
    return !isGroup(n) && !hasVideoOutput(n) && !groupFilmed(n);
  });
  return { missing, recheckOnly: ids.size - missing.length };
}
// Note for the run message: how many of these shots exceed their video model's reference
// limit and will get a keyframe image composed first.
export const keyframeNote = nodes => {
  const k = nodes.filter(n => !n.image && n.videoInput === 'refs' && videoNeedsKeyframe(n)).length;
  return k
    ? ' · ' + k + ' shot tạo ảnh khung hình trước (quá giới hạn ảnh tham chiếu của model video)'
    : '';
};
// A shot whose Seedvis job fails outright is queued again inside the same run, up to this
// many times, before it is reported as an error (Seedvis failures are often transient).
const AUTO_RETRIES = Math.max(0, Number(process.env.MV_AUTO_RETRIES ?? 3) || 0);
// Starts an auto-video run over the given node ids.
// recheck: uncertain Seedvis jobs to check again as part of the run (see missingVideoPlan).
export function startAutoVideoRun(req, ids, versions, message, recheck = []) {
  const vr = (db.autoVideoRun = {
    id: crypto.randomUUID(),
    status: 'running',
    versions,
    pending: ids,
    total: ids.length,
    errors: [],
    message,
    baseMessage: message,
    maxRetries: AUTO_RETRIES,
    attempts: {}, // "<nodeId>:<kind>" → jobs created for it in this run
    retried: 0, // failed attempts that were queued again
  });
  for (const j of recheck) {
    // Part of the run: if Seedvis reports it failed, the run films the shot again.
    j.autoVideoId = vr.id;
    j.recheck = true;
    vr.attempts[j.nodeId + ':' + j.kind] = 1;
    delete j.cancelRequested;
    if (j.remote?.id || j.remote?.pollUrl) resumeSeedvis(j);
    else {
      // Never confirmed as received: the same request again under the same Idempotency-Key
      // (the job id) — Seedvis hands back the job it already has instead of a second one.
      j.status = 'queued';
      j.error = null;
      j.progress = 'Gửi lại cùng mã chống trùng: Seedvis trả lại tác vụ cũ nếu đã nhận';
    }
  }
  save();
  pump(req);
}

// The runner reports each finished job here, so the batch run it belongs to moves on. A late
// ChatGPT image counts too: it moves the chain past its node (once) and restarts the chain it
// had stopped; one that no longer landed in its node (applied false) moves no chain. A zone
// batch that ended waiting for it counts again.
export function onAutoJobDone(j) {
  const run = db.autoRun;
  if (
    j.applied !== false &&
    j.autoRunId &&
    run?.id === j.autoRunId &&
    run.order[run.index] === j.nodeId
  ) {
    run.index++;
    if (run.status === 'blocked' && run.blockedBy === j.id) {
      run.status = 'running';
      run.message = 'Ảnh ChatGPT về muộn: chạy tiếp chuỗi';
    }
  }
  const ir = db.autoImageRun;
  if (j.autoImageId && ir?.id === j.autoImageId && ir.status === 'blocked') settleImageRun(ir);
}
// The end of a zone image batch: what came back, what is still out (a ChatGPT image not back
// yet, a job to check), what failed.
function settleImageRun(ir) {
  const mine = db.jobs.filter(x => x.autoImageId === ir.id);
  const done = mine.filter(x => x.status === 'completed').length;
  const waiting = mine.filter(x => ['needs_review', 'queued', 'running'].includes(x.status)).length;
  const errors = [
    ...ir.errors,
    ...mine
      .filter(x => x.status === 'failed')
      .map(x => (getNode(x.nodeId)?.name || x.nodeId) + ': ' + x.error),
  ];
  ir.status = errors.length || waiting ? 'blocked' : 'completed';
  ir.message =
    (waiting
      ? `Xong ${done}/${ir.total} ảnh · ${waiting} ảnh chưa về (ảnh ChatGPT: tự lấy lại, hoặc bấm "Lấy lại ảnh" ở hàng đợi)`
      : errors.length
        ? 'Một số ảnh lỗi'
        : 'Đã tạo xong ảnh của khu vực') + (errors.length ? ': ' + errors.join(' · ') : '');
}
// …and each failed one: the image chain stops; the video run queues the shot again while
// its retry budget lasts, otherwise lists it as an error.
export function onAutoJobFailed(j, e) {
  if (j.autoRunId && db.autoRun?.id === j.autoRunId) {
    db.autoRun.status = 'blocked';
    db.autoRun.message = e.message;
    db.autoRun.blockedBy = j.id; // a late ChatGPT image of it restarts the chain
  }
  if (j.autoVideoId && db.autoVideoRun?.id === j.autoVideoId) {
    const vr = db.autoVideoRun;
    // A re-checked job that turned out failed: film the shot only once nothing else can still
    // bring its clip home (another job of it being checked, or a clip that already came).
    const shot = getNode(j.nodeId);
    if (
      j.recheck &&
      j.kind === 'video' &&
      (!shot ||
        isGroup(shot) || // a Seedance render is the user's call
        isMerged(shot) || // so is a merged scene: a re-check never turns into a new render
        inGroup(shot) || // its group films it
        hasConflict(shot) ||
        hasVideoOutput(shot) ||
        db.jobs.some(
          o =>
            o !== j &&
            o.nodeId === j.nodeId &&
            o.autoVideoId === vr.id &&
            ['queued', 'running'].includes(o.status),
        ))
    )
      return;
    const tries = vr.attempts?.[j.nodeId + ':' + j.kind] || 1;
    const budget = vr.maxRetries ?? 0;
    if (j.status === 'failed' && tries <= budget && vr.status === 'running') {
      // A definite failure: queue the shot again, keeping this attempt in the list as
      // "retried". An uncertain outcome (needs_review) is never re-sent — the generation
      // may still be running upstream and a resend could bill it twice.
      j.status = 'retried';
      j.progress = `Lỗi lần ${tries}/${budget + 1} — tự xếp chạy lại`;
      vr.retried = (vr.retried || 0) + 1;
      vr.message = (vr.baseMessage || vr.message) + ` · đã tự chạy lại ${vr.retried} lượt lỗi`;
      // A video shot was removed from pending when its job was created; a keyframe image
      // job's shot is still pending and feedAuto queues the next attempt by itself.
      if (j.kind === 'video' && !vr.pending.includes(j.nodeId)) vr.pending.push(j.nodeId);
    } else if (j.kind === 'video') {
      vr.errors.push(
        (getNode(j.nodeId)?.name || j.nodeId) +
          ': ' +
          e.message +
          (tries > 1 ? ` (đã thử ${tries} lần)` : ''),
      );
    }
    // An exhausted keyframe image job is reported by feedAuto when it drops the shot.
  }
}

// Creates queued jobs from the active auto-runs. Image auto-run stays serial (one
// job in flight, driven by dependencies); video auto-run enqueues every ready node.
export async function feedAuto() {
  const owner = sessionUser(lastReq)?.email || null;
  const run = db.autoRun;
  if (run?.status === 'running' && (!run.owner || run.owner === owner)) {
    const inFlight = db.jobs.some(
      j => j.autoRunId === run.id && ['queued', 'running'].includes(j.status),
    );
    if (!inFlight) {
      while (run.index < run.order.length) {
        const node = getNode(run.order[run.index]);
        // (gone: deleted while the chain was stopped, before a late image restarted it)
        if (!node || (node.image && !node.stale)) {
          run.index++;
          continue;
        }
        break;
      }
      if (run.index === run.order.length) {
        run.status = 'completed';
        run.message = 'Đã nhận đủ ảnh của chuỗi';
        save();
      } else {
        try {
          const j = await createJob(lastReq, { nodeId: run.order[run.index], kind: 'image' });
          j.autoRunId = run.id;
          save();
        } catch (e) {
          run.status = 'blocked';
          run.message = e.message;
          save();
        }
      }
    }
  }
  const vr = db.autoVideoRun;
  if (vr?.status === 'running') {
    for (const id of [...vr.pending]) {
      const n = getNode(id);
      // Over the video model's reference limit (e.g. Veo: 3) and no keyframe yet: queue the
      // shot's own image first (the image model takes up to 10 refs) and keep the shot
      // pending; its video job is created on a later pass, once the keyframe has landed.
      if (n && !n.image && n.videoInput === 'refs' && videoNeedsKeyframe(n)) {
        const img = [...db.jobs]
          .reverse()
          .find(j => j.nodeId === id && j.kind === 'image' && j.autoVideoId === vr.id);
        if (img && ['queued', 'running'].includes(img.status)) continue;
        // a ChatGPT image on its way back (the tool re-opens that conversation): keep waiting
        if (img && img.recoverAt) continue;
        if (img && img.status !== 'retried') {
          // The keyframe job ended without an image (failed for good / cancelled / needs
          // review): drop the shot and report it once.
          const tries = vr.attempts?.[id + ':image'] || 1;
          vr.pending = vr.pending.filter(x => x !== id);
          vr.errors.push(
            n.name +
              ': ảnh khung hình không tạo được (' +
              (img.error || img.status) +
              ')' +
              (tries > 1 ? ` (đã thử ${tries} lần)` : ''),
          );
          save();
          continue;
        }
        try {
          const j = await createJob(lastReq, { nodeId: id, kind: 'image' });
          j.autoVideoId = vr.id;
          vr.attempts ??= {};
          vr.attempts[id + ':image'] = (vr.attempts[id + ':image'] || 0) + 1;
          save();
        } catch (e) {
          vr.pending = vr.pending.filter(x => x !== id);
          vr.errors.push(n.name + ': ' + e.message);
          save();
        }
        continue;
      }
      try {
        const j = await createJob(lastReq, {
          nodeId: id,
          kind: 'video',
          count: vr.versions,
          branch: true,
        });
        j.autoVideoId = vr.id;
        vr.attempts ??= {};
        vr.attempts[id + ':video'] = (vr.attempts[id + ':video'] || 0) + 1;
        vr.pending = vr.pending.filter(x => x !== id);
        save();
      } catch (e) {
        vr.pending = vr.pending.filter(x => x !== id);
        vr.errors.push((getNode(id)?.name || id) + ': ' + e.message);
        save();
      }
    }
    const active = db.jobs.some(
      j => j.autoVideoId === vr.id && ['queued', 'running'].includes(j.status),
    );
    if (!vr.pending.length && !active) {
      vr.status = vr.errors.length ? 'blocked' : 'completed';
      const retryNote = vr.retried ? ` · đã tự chạy lại ${vr.retried} lượt lỗi` : '';
      vr.message = vr.errors.length
        ? `Một số node vẫn lỗi (đã tự thử lại tối đa ${vr.maxRetries ?? 0} lần): ` +
          vr.errors.join(' · ') +
          retryNote
        : 'Đã tạo xong các phiên bản video' + retryNote;
      save();
    }
  }
  // Parallel image batch for one zone (Nhân vật / Bối cảnh …): enqueue every ready node.
  const ir = db.autoImageRun;
  if (ir?.status === 'running') {
    for (const id of [...ir.pending]) {
      try {
        const j = await createJob(lastReq, { nodeId: id, kind: 'image' });
        j.autoImageId = ir.id;
        ir.pending = ir.pending.filter(x => x !== id);
        save();
      } catch (e) {
        ir.pending = ir.pending.filter(x => x !== id);
        ir.errors.push((getNode(id)?.name || id) + ': ' + e.message);
        save();
      }
    }
    const active = db.jobs.some(
      j => j.autoImageId === ir.id && ['queued', 'running'].includes(j.status),
    );
    if (!ir.pending.length && !active) {
      settleImageRun(ir);
      save();
    }
  }
}
