// Job runner: sends queued jobs to Seedvis or Orbit with concurrency limits, reports each
// outcome to the batch runs (lib/auto.mjs), and flags jobs whose worker went silent.
import { prepareInputs } from '../media-io.mjs';
import { executeOrbit, sessionUser } from '../orbit-client.mjs';
import { feedAuto, onAutoJobDone, onAutoJobFailed } from './auto.mjs';
import { directorLLM, seedane, seedvis } from './config.mjs';
import { notify } from './events.mjs';
import { getNode } from './nodes.mjs';
import { prompts } from './prompts.mjs';
import {
  AI_SYSTEM,
  MAX_ATTEMPTS,
  acceptAiRewrite,
  aiUserPrompt,
  diagnose,
  isRejection,
  learn,
  nextStep,
} from './prompt-doctor.mjs';
import { runTurn, workerOnline } from './director-web.mjs';
import { claudeAvailable } from './claude-cli.mjs';
import {
  collectJob,
  createJob,
  isWebImage,
  queueRecover,
  recoverWorkerOn,
  isRecoverableWebJob,
  scheduleRecover,
  seedvisImages,
  seedvisVideo,
  storeSeedvisResults,
  webResultMovedOn,
} from './jobs.mjs';
import { db, mediaDir, save, saveSoon } from './projects.mjs';
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
const queueGroup = j =>
  j.payload?.site ||
  (j.payload?.seedvis ? 'seedvis' : j.payload?.seedane ? 'seedane' : j.payload?.orbit ? 'orbit' : 'web');
// Seedane queues on its own side (a full queue keeps a job QUEUED there), so many can be sent;
// the cap only bounds how many this server polls at once.
const SD_CAP = Math.max(1, Number(process.env.MV_SEEDANE_CONCURRENCY) || 16);
const sdActive = new Set();
// Jobs Seedane may already be making when this server stopped: asked again once per run of the
// server — same Idempotency-Key, so never a second render.
const sdResumed = new Set();
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
  j.executor = j.payload.seedvis ? 'seedvis' : j.payload.seedane ? 'seedane' : 'orbit-direct';
  j.startedAt = new Date().toISOString();
  j.heartbeat = Date.now();
  j.progress = j.payload.seedvis
    ? 'Đang chuẩn bị gửi Seedvis'
    : j.payload.seedane
      ? 'Đang chuẩn bị gửi Seedane'
      : 'Đang kiểm tra Orbit';
  save();
  const heartbeat = setInterval(() => {
    j.heartbeat = Date.now();
    saveSoon(); // cosmetic liveness tick — debounced; the finally block sync-saves at the end
  }, 10000);
  const onProgress = message => {
    j.progress = message;
    j.heartbeat = Date.now();
    saveSoon();
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
      storeSeedvisResults(j, await seedvis.run(j, images, onProgress, saveSoon, video));
    } else if (j.payload.seedane) {
      let images;
      try {
        images = seedvisImages(j); // base64 + file name, same size limits as Seedvis
      } catch (e) {
        e.definite = true;
        throw e;
      }
      storeSeedvisResults(j, await seedane.run(j, images, onProgress, saveSoon));
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
      : j.payload.seedane
        ? e.definite
          ? 'Seedane không tạo được; sửa rồi tạo lại'
          : 'Chưa rõ Seedane đã làm xong chưa — bấm "Kiểm tra lại" (cùng mã, không tạo mới)'
        : 'Cần kiểm tra Orbit trước khi chạy lại';
    onAutoJobFailed(j, e); // a batch run decides whether to queue the shot again
    // Bị BỘ LỌC NỘI DUNG từ chối (khác hẳn lỗi mạng / hết quota): leo thang tự sửa.
    // PHẢI đứng SAU câu progress chung ở trên — đứng trước thì thông báo của thang leo ("Lượt
    // 3/5 — tool sửa prompt…") bị câu chung đè mất, người dùng không bao giờ thấy nó đang làm gì.
    // Chạy nền, không await: bước AI có thể chờ LLM hàng phút. Nó tự save lấy.
    if (j.kind === 'video' && e.definite && isRejection(e.message))
      onVideoRejected(j).catch(err => {
        j.progress = 'Tự sửa prompt lỗi: ' + err.message;
        save();
      });
  } finally {
    clearInterval(heartbeat);
    save();
    // However this job ended — a picture stored, a failure, a re-queue — the open windows must be
    // told. This is the tool's OWN generation path (the server submits to Seedvis/Seedane and
    // stores the file itself), so nothing calls /api/worker/complete to push for us. And the poll
    // cannot stand in: a result deliberately does not bump db.revision, and by the next tick the
    // job is no longer active, so an idle canvas would sit on the old picture until a reload.
    notify('job-finished');
  }
}

// Model video từ chối dựng shot này. Đếm số lần LIÊN TIẾP trên node (một lần chạy được sẽ xoá
// bộ đếm, xem lib/jobs.mjs). Đủ REJECTS_BEFORE_FIX lần thì soi prompt, sửa phần an toàn + phần
// logic, ghi bài học cho agent viết kịch bản, rồi chạy lại — tối đa MAX_FIX_ROUNDS vòng, nên
// một node tốn thêm nhiều nhất 2 lượt credit chứ không đốt vô hạn.
// Bước AI chạy bằng gì: API key nếu có, không thì extension ChatGPT nếu đang bật. Không có cả
// hai thì bỏ qua bước này và nói rõ — im lặng ở đây sẽ bị hiểu là "tool không chạy".
// Thứ tự: API key nếu đã cấu hình → Claude Code (gói Pro/Max trên máy, không cần mở tab nào) →
// extension ChatGPT đang bật.
const llmVia = () =>
  directorLLM.configured() ? 'api' : claudeAvailable() ? 'claude' : workerOnline() ? 'web' : '';

export async function onVideoRejected(j) {
  const n = getNode(j.nodeId);
  if (!n) return;
  n.rejects = (n.rejects || 0) + 1;
  const step = nextStep(n.rejects);
  if (!step) {
    j.progress =
      `Đã thử ${MAX_ATTEMPTS} lượt (gửi lại, tool sửa, AI viết lại, gộp lưới ảnh) mà vẫn bị từ chối — cần xem tay. ` +
      'Thường là ẢNH tham chiếu bị chặn chứ không phải chữ (mặt người thật trong ảnh).';
    return;
  }
  const note = what => {
    n.fixLog = [
      ...(n.fixLog || []),
      { at: new Date().toISOString(), attempt: n.rejects + 1, step: step.kind, changes: what },
    ].slice(-12);
  };
  const rerun = async msg => {
    j.progress = `Lượt ${n.rejects + 1}/${MAX_ATTEMPTS} — ${msg}`;
    // Chuỗi tự động (onAutoJobFailed chạy TRƯỚC bác sĩ) đã nhận việc gửi lại shot này: nó sẽ
    // tạo job mới, và job đó sinh prompt từ node nên mang sẵn bản sửa. Bác sĩ mà tạo thêm một
    // job nữa là gửi trùng — tính tiền hai lần cho cùng một shot.
    if (j.status === 'retried') {
      j.progress += ' (chuỗi tự động sẽ gửi lại với prompt mới)';
      save();
      return;
    }
    save();
    try {
      await createJob(lastReq, { nodeId: n.id, kind: 'video', count: 1 }, { allowStale: true });
    } catch (err) {
      j.progress += ' Không chạy lại được: ' + err.message;
    }
  };

  // Bước 1 — gửi lại nguyên văn, không đụng gì vào prompt.
  if (step.kind === 'retry') {
    note(['gửi lại nguyên văn, chưa sửa gì']);
    return rerun(step.label);
  }

  let text = '';
  try {
    text = prompts(n).video || '';
  } catch {
    return; // node hỏng thì không sửa mò
  }

  // Bước 2 — tool sửa bằng luật cứng. Không tìm ra lỗi nào thì leo thẳng lên bước AI, đừng
  // tiêu một lượt để gửi lại y hệt.
  let kind = step.kind;
  if (kind === 'fix') {
    const found = diagnose(text, n.promptFix || {});
    if (found.length) {
      const fix = { ...(n.promptFix || {}) };
      for (const f of found) {
        fix[f.key] = true;
        if (f.key === 'dropExclusive') fix.voices = f.speakers;
      }
      n.promptFix = fix;
      learn(found); // sổ học dùng chung mọi project
      note(found.map(f => f.what));
      return rerun(step.label + ': ' + found.map(f => f.what).join('; '));
    }
    kind = 'ai';
  }

  // Bước 3 — AI viết lại. Chỉ đổi cách viết; acceptAiRewrite bỏ bản nào đánh mất câu thoại.
  if (kind === 'ai') {
    const via = llmVia();
    if (!via) {
      j.progress =
        'Tool sửa rồi mà vẫn bị từ chối. Bước tiếp theo cần AI viết lại, nhưng chưa có API key ' +
        'LLM và cũng không có extension ChatGPT đang bật — bật một trong hai rồi chạy lại.';
      save();
      return;
    }
    let out = '';
    try {
      out = await runTurn(via, AI_SYSTEM, aiUserPrompt(text, j.error));
    } catch (e) {
      j.progress = 'AI viết lại thất bại: ' + e.message;
      save();
      return;
    }
    const ok = acceptAiRewrite(text, out);
    if (!ok) {
      j.progress =
        'AI đã viết lại nhưng bản mới làm mất câu thoại (hoặc dài bất thường) nên bị bỏ — giữ prompt cũ.';
      save();
      return;
    }
    n.promptFix = { ...(n.promptFix || {}), aiPrompt: ok };
    note(['AI viết lại prompt (' + ok.length + ' ký tự)']);
    return rerun('AI đã viết lại prompt');
  }

  // Bước 4 — gộp ảnh tham chiếu thành một lưới. Chưa dựng: nói thẳng thay vì im lặng.
  j.progress =
    'Tool sửa và AI viết lại đều chưa qua. Bước cuối (gộp ảnh thành lưới) chưa bật — ' +
    'xem lại ẢNH tham chiếu, thường chính ảnh mới là thứ bị chặn.';
  save();
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
          if (isRecoverableWebJob(j)) {
            j.late = true;
            j.error =
              'Extension ngừng báo tiến độ (trình duyệt hoặc extension bị tắt/ngủ). Kết quả có thể vẫn đang tạo; extension gửi về muộn thì tool vẫn nhận.';
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
            const movedOn = j.kind === 'image' ? webResultMovedOn(j) : null;
            if (movedOn) {
              delete j.recoverAt;
              j.progress = 'Không tự lấy lại ảnh: ' + movedOn;
            } else if (recoverWorkerOn(j.worker, 60000, j.payload.site)) queueRecover(j);
            else {
              const wait = `Chờ extension "${j.worker}" kết nối lại để tự lấy kết quả ${j.payload.site === 'musechat' ? 'Muse' : 'ChatGPT'}`;
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
            'Extension chưa nhận việc lấy lại kết quả — bấm "Kiểm tra lại" khi extension bật.';
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
    const j = db.jobs.find(
      j =>
        j.status === 'queued' &&
        j.payload.seedvis &&
        !svActive.has(j.id) &&
        !db.queuePauses?.[queueGroup(j)],
    );
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
  for (const j of db.jobs)
    if (
      j.status === 'needs_review' &&
      j.payload?.seedane &&
      j.seedaneId &&
      !j.cancelRequested &&
      !sdResumed.has(j.id)
    ) {
      sdResumed.add(j.id);
      j.status = 'queued';
      j.progress = 'Hỏi lại Seedane sau khi khởi động lại (cùng mã, không tạo mới)';
    }
  while (sdActive.size < SD_CAP) {
    const j = db.jobs.find(
      j =>
        j.status === 'queued' &&
        j.payload.seedane &&
        !sdActive.has(j.id) &&
        !db.queuePauses?.[queueGroup(j)],
    );
    if (!j) break;
    sdActive.add(j.id);
    runJob(lastReq, j).finally(() => {
      sdActive.delete(j.id);
      pump(lastReq);
    });
  }
  if (!orbitBusy) {
    const owner = sessionUser(lastReq)?.email || null;
    const j =
      owner &&
      db.jobs.find(
        j =>
          j.status === 'queued' &&
          j.payload.orbit &&
          j.payload.orbit.owner === owner &&
          !db.queuePauses?.[queueGroup(j)],
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
    saveSoon();
  }, 10000);
  try {
    storeSeedvisResults(
      j,
      await seedvis.resume(j, message => {
        j.progress = message;
        j.heartbeat = Date.now();
        saveSoon();
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
    notify('job-finished'); // re-reading an interrupted job lands a picture the same way
    pump(lastReq); // a batch run waiting on this job moves on
  }
}
