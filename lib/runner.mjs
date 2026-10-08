// Job runner: sends queued jobs to Seedvis or Orbit with concurrency limits, reports each
// outcome to the batch runs (lib/auto.mjs), and flags jobs whose worker went silent.
import { prepareInputs } from '../media-io.mjs';
import { executeOrbit, sessionUser } from '../orbit-client.mjs';
import { feedAuto, onAutoJobDone, onAutoJobFailed } from './auto.mjs';
import { seedvis } from './config.mjs';
import {
  collectJob,
  isWebImage,
  queueRecover,
  recoverWorkerOn,
  scheduleRecover,
  seedvisImages,
  seedvisVideo,
  storeSeedvisResults,
  webResultMovedOn,
} from './jobs.mjs';
import { db, mediaDir, save } from './projects.mjs';
import { CAP, acquire as acquireSlot, release as releaseSlot } from './sv-slots.mjs';

// Seedvis handles its own queue, so we submit every ready job at once (push max) instead
// of trickling them. Its account runs 16 generations at a time and holds 32 more waiting,
// so 48 of our jobs can sit there; we submit up to that and let Seedvis queue them.
// Tune with MV_SEEDVIS_CONCURRENCY. Orbit stays serial.
const SV_CAP = Math.max(1, Number(process.env.MV_SEEDVIS_CONCURRENCY) || 48);
const svActive = new Set();
let orbitBusy = false;
export let lastReq = null;
let pumping = false,
  pumpAgain = false;
// Nothing in this window finishes while it is waiting on slots held by another window, so a
// job that found the account full needs its own wake-up. One timer at a time.
let slotTimer = null;
function waitForSlot() {
  if (slotTimer) return;
  slotTimer = setTimeout(() => {
    slotTimer = null;
    pump(lastReq);
  }, 5000);
  slotTimer.unref?.();
}

// Executes one queued job to completion (Seedvis or Orbit), storing its result
// or, for branch jobs, spawning output nodes.
async function runJob(req, j) {
  j.status = 'running';
  j.executor = j.payload.seedvis ? 'seedvis' : 'orbit-direct';
  j.startedAt = new Date().toISOString();
  j.heartbeat = Date.now();
  j.progress = j.payload.seedvis ? 'Đang chuẩn bị gửi Seedvis' : 'Đang kiểm tra Orbit';
  save();
  const heartbeat = setInterval(() => {
    j.heartbeat = Date.now();
    save();
  }, 10000);
  const onProgress = message => {
    j.progress = message;
    j.heartbeat = Date.now();
    save();
  };
  try {
    if (j.payload.seedvis) {
      let images, video;
      try {
        images = seedvisImages(j);
        video = seedvisVideo(j); // a lip-sync take's source video, else null
      } catch (e) {
        e.definite = true; // the inputs could not be read: nothing was sent
        throw e;
      }
      storeSeedvisResults(j, await seedvis.run(j, images, onProgress, save, video));
    } else {
      await prepareInputs(j, mediaDir);
      save();
      await executeOrbit(req, j, onProgress);
      j.progress = 'Đang chờ file đầu ra';
      save();
      await collectJob(j);
    }
    onAutoJobDone(j);
  } catch (e) {
    // Stopped by the user: mark cancelled and don't count it as a run error.
    if (e.aborted) {
      j.status = 'cancelled';
      j.progress = 'Đã dừng theo yêu cầu';
      return; // finally clears the heartbeat and saves
    }
    // The account stayed full for the whole retry window. 422 on the create call means
    // Seedvis built nothing, so the job goes back in the queue instead of failing — a busy
    // account is a reason to wait. Bounded, so an account that is full for good still
    // surfaces as an error rather than spinning for ever.
    if (e.requeue && (j.queueWaits = (j.queueWaits || 0) + 1) <= 20) {
      j.status = 'queued';
      j.error = null;
      j.progress = `Hàng chờ Seedvis đầy, sẽ gửi lại (lần ${j.queueWaits})`;
      waitForSlot();
      return; // finally clears the heartbeat and saves
    }
    // `definite`: Seedvis rejected or failed the job, so nothing is pending remotely.
    j.status = e.definite ? 'failed' : 'needs_review';
    j.error = e.message;
    if (e.conflict) j.conflict = true; // Seedvis has another request under this key
    j.progress = j.payload.seedvis
      ? e.definite
        ? 'Seedvis không tạo được; sửa rồi tạo lại'
        : 'Cần kiểm tra lại trạng thái Seedvis, không tạo mới'
      : 'Cần kiểm tra Orbit trước khi chạy lại';
    onAutoJobFailed(j, e); // a batch run decides whether to queue the shot again
  } finally {
    clearInterval(heartbeat);
    save();
  }
}

// A running job whose worker stopped sending heartbeats is left for review, never re-sent:
// it may still be generating, and a second run could be billed twice. A ChatGPT image stays
// late: its worker can still hand it in (same lease), or it is fetched from its conversation.
const HB_MS = Number(process.env.MV_WORKER_HEARTBEAT_MS) || 90000;
export function watchWorkerHeartbeats() {
  setInterval(
    () => {
      let changed = false;
      const now = Date.now();
      for (const j of db.jobs) {
        if (j.status === 'running' && now - j.heartbeat > HB_MS) {
          j.status = 'needs_review';
          if (isWebImage(j)) {
            j.late = true;
            j.error =
              'Extension ngừng báo tiến độ (trình duyệt hoặc extension bị tắt/ngủ). Ảnh có thể vẫn đang tạo trên ChatGPT: extension gửi về muộn thì tool vẫn nhận.';
            scheduleRecover(j, 30000);
          } else
            j.error = 'Worker mất kết nối. Kiểm tra website trước khi tạo lại để tránh chạy trùng.';
          // a worker job reports to its batch run here (the runner's own jobs do in runJob)
          if (!j.payload.seedvis && !j.payload.orbit) onAutoJobFailed(j, { message: j.error });
          changed = true;
        }
        // Due to be fetched from its ChatGPT conversation: queued for the worker that sent it,
        // once that worker is online, unless the node moved on while it waited.
        if (j.status === 'needs_review' && j.recoverAt && now >= j.recoverAt) {
          try {
            const movedOn = webResultMovedOn(j);
            if (movedOn) {
              delete j.recoverAt;
              j.progress = 'Không tự lấy lại ảnh: ' + movedOn;
            } else if (recoverWorkerOn(j.worker, 60000)) queueRecover(j);
            else {
              const wait = `Chờ extension "${j.worker}" kết nối lại để tự lấy ảnh ChatGPT`;
              if (j.progress === wait) continue;
              j.progress = wait;
            }
          } catch (e) {
            delete j.recoverAt;
            j.progress = e.message;
          }
          changed = true;
        }
      }
      // A recover no worker took within 3 minutes (the extension went off) goes back to review,
      // where the button can queue it again.
      for (const j of db.jobs)
        if (j.status === 'queued' && j.recover && now - (j.recover.queuedAt || now) > 180000) {
          j.status = 'needs_review';
          j.progress =
            'Extension chưa nhận việc lấy lại ảnh — bấm "Lấy lại ảnh" khi extension bật.';
          changed = true;
        }
      if (changed) save();
    },
    Math.min(10000, HB_MS),
  ).unref();
}

// Launches queued jobs within the concurrency limits.
function launch() {
  while (svActive.size < SV_CAP) {
    const j = db.jobs.find(j => j.status === 'queued' && j.payload.seedvis && !svActive.has(j.id));
    if (!j) break;
    // The Seedvis account is shared by every open window, so a slot is taken from the common
    // pool before anything is sent. With the account full the job simply stays queued and is
    // retried on the next pump: waiting costs nothing, a rejected request costs a run.
    const slot = acquireSlot(j.id);
    if (slot === null) {
      j.progress = `Chờ chỗ trống của tài khoản Seedvis (dùng chung mọi cửa sổ, ${CAP} chỗ)`;
      save();
      waitForSlot();
      break;
    }
    svActive.add(j.id);
    runJob(lastReq, j).finally(() => {
      releaseSlot(slot);
      svActive.delete(j.id);
      pump(lastReq);
    });
  }
  if (!orbitBusy) {
    const owner = sessionUser(lastReq)?.email || null;
    const j =
      owner &&
      db.jobs.find(
        j => j.status === 'queued' && j.payload.orbit && j.payload.orbit.owner === owner,
      );
    if (j) {
      orbitBusy = true;
      runJob(lastReq, j).finally(() => {
        orbitBusy = false;
        pump(lastReq);
      });
    }
  }
}

// Serialized planner: feeds the auto-runs then launches jobs. Re-invoked after each
// job settles. The lock keeps two invocations from launching the same job.
export async function pump(req) {
  if (req && sessionUser(req)) lastReq = req;
  else if (!lastReq) lastReq = req;
  if (process.env.MV_RUNNER_DISABLED === '1') return;
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      await feedAuto();
      launch();
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

// Re-reads an interrupted Seedvis job (timeout, restart) without resubmitting.
export async function resumeSeedvis(j) {
  j.status = 'running';
  j.heartbeat = Date.now();
  j.error = null;
  save();
  const heartbeat = setInterval(() => {
    j.heartbeat = Date.now();
    save();
  }, 10000);
  try {
    storeSeedvisResults(
      j,
      await seedvis.resume(j, message => {
        j.progress = message;
        j.heartbeat = Date.now();
        save();
      }),
    );
  } catch (e) {
    // Stopped while being checked: Seedvis may still deliver it, so it stays one to check
    // (its Seedvis id is kept), and stopping never makes the run film the shot again.
    if (e.aborted && j.cancelRequested) {
      j.status = 'cancelled';
      j.progress = 'Đã dừng theo yêu cầu; còn kiểm tra lại được';
      return;
    }
    j.status = e.definite ? 'failed' : 'needs_review';
    j.error = e.message;
    onAutoJobFailed(j, e); // re-checked by a batch run: a failed shot is filmed again
  } finally {
    clearInterval(heartbeat);
    save();
    pump(lastReq); // a batch run waiting on this job moves on
  }
}
