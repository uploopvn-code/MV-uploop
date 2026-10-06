// Generation jobs: create (image, video, edit), store results, clip nodes, cancel/idle checks.
import { readOutput } from '../media-io.mjs';
import { defaultNaming, outputFor } from '../output-config.mjs';
import { validateBinding } from '../orbit-client.mjs';
import { validateSeedvisBinding } from '../seedvis-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { seedvis } from './config.mjs';
import { imageSize, nearestAspect } from './image-size.mjs';
import { exportVideo } from './library.mjs';
import { storeAsset } from './media.mjs';
import { assetRefs, deps, getNode, isSetting } from './nodes.mjs';
import { db, mediaDir, nextVersion, save } from './projects.mjs';
import { editPrompt, prompts } from './prompts.mjs';
import { providers, seedvisBinding, videoRefLimit } from './providers.mjs';
import { inputsMoved, setImage } from './staleness.mjs';
import { groupPlan, groupProblem, groupReferences, isGroup } from './seedance.mjs';
import { frameProblem, isFrame, isMerged, mergedProblem, mergedReferences } from './merged.mjs';
import { reviewVideoNodeIds } from './auto.mjs';
import { nextSeq, renumberSeq } from './zones.mjs';

export function checkLease(j, b) {
  if (!j || j.status !== 'running' || j.lease !== b.lease)
    throw new Error('Job không còn thuộc phiên worker này.');
}
export async function createJob(req, b) {
  const n = getNode(b.nodeId);
  if (!n) throw new Error('Node không tồn tại');
  if (n.terminal) throw new Error('Node phiên bản chỉ để xem, không tạo tiếp từ nó.');
  if (isSetting(n)) throw new Error('Node cài đặt (style/máy quay) không tạo ảnh/video.');
  const kind = b.kind === 'video' ? 'video' : 'image';
  const count = kind === 'video' ? Math.max(1, Math.min(8, Math.floor(Number(b.count) || 1))) : 1;
  const sv = seedvisBinding(n, kind);
  // The ChatGPT (web) extension runs a node whose image source resolves to "web" — an explicit
  // per-node choice or the project default. Computed here so the edit guard below can allow it.
  const web = !sv && providers(n)[kind].type === 'web';
  // A node has two outputs: its image, which feeds the nodes wired after it, and its video,
  // which becomes its own node in the Video column. So every produced clip shows up there,
  // one node per version, while the image keeps flowing down the graph. (Orbit has no
  // versions and keeps its old inline result.)
  const branch = kind === 'video' && !!sv;
  // A Seedance group films its shots in one render, from its storyboard + reference images.
  const group = isGroup(n);
  if (group) {
    if (kind === 'image')
      throw new Error('Nhóm Seedance dùng ảnh storyboard: bấm "🧩 Dựng storyboard" trong nhóm.');
    if (!sv) throw new Error('Nhóm Seedance chạy qua Seedvis.');
    const problem = groupProblem(n);
    if (problem) throw new Error(problem);
    // A render of this group may already be paid for at Seedvis: check it first. Going ahead
    // anyway is the user's explicit choice (force).
    if (!b.force && reviewVideoNodeIds().has(n.id))
      throw new Error(
        'Nhóm còn tác vụ Seedance chờ kiểm tra (có thể đã làm xong). Bấm "↻ Kiểm tra lại" trong nhóm trước; tạo mới có thể trả tiền hai lần.',
      );
  }
  // A merged scene films its 2–3 frames in one Veo render, from those frames' images.
  const merged = isMerged(n);
  if (merged) {
    if (kind === 'image')
      throw new Error('Phân cảnh ghép không có ảnh riêng: tạo ảnh ở từng khung ở cột ⑥ Sản xuất.');
    if (!sv) throw new Error('Phân cảnh ghép quay bằng Veo qua Seedvis.');
    const problem = mergedProblem(n);
    if (problem) throw new Error(problem);
    // A render of this scene may already be paid for at Seedvis: check it before paying again.
    if (!b.force && reviewVideoNodeIds().has(n.id))
      throw new Error(
        'Phân cảnh ghép còn tác vụ chờ kiểm tra (có thể đã làm xong). Bấm "↻ Kiểm tra lại" trước; tạo mới có thể trả tiền hai lần.',
      );
  }
  // One setup of a merged scene: never a clip of its own; its still needs the Bible's staging.
  if (kind === 'video' && isFrame(n))
    throw new Error('Khung của phân cảnh ghép không quay riêng: quay node phân cảnh ghép ở cột ⑦.');
  if (kind === 'image' && isFrame(n)) {
    const problem = frameProblem(n);
    if (problem) throw new Error(problem);
  }
  // Edit: send this node's own image with "change only this"; the answer replaces the image
  // and the previous one is kept (swap back with /api/node/swap-image).
  const edit =
    kind === 'image' && 'edit' in b
      ? String(b.edit ?? '')
          .trim()
          .slice(0, 2000)
      : null;
  if (edit !== null) {
    if (!edit) throw new Error('Nhập yêu cầu sửa ảnh.');
    if (!n.image) throw new Error('Node chưa có ảnh để sửa. Tạo hoặc tải ảnh trước.');
    if (!sv && !web)
      throw new Error(
        'Sửa ảnh chạy qua Seedvis hoặc ChatGPT (extension). Node này đang dùng Orbit — đổi nguồn tạo ảnh.',
      );
  }
  if (!sv && count > 1)
    throw new Error('Nhiều phiên bản / tách node chỉ hỗ trợ Seedvis. Node này đang dùng Orbit.');
  let verifiedBinding = null;
  if (sv) {
    if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
  } else if (web) {
    // Nothing to validate against a Hub: the browser extension claims the job and runs it.
    if (kind === 'video')
      throw new Error('ChatGPT (extension) chỉ tạo ảnh. Chọn Seedvis hoặc Orbit cho video.');
  } else {
    const binding = n.orbit?.[kind];
    if (!binding) throw new Error('Mở Cài đặt Orbit của node để chọn kịch bản và nick.');
    verifiedBinding = await validateBinding(req, binding);
    if (verifiedBinding.owner !== binding.owner)
      throw new Error(
        'Cấu hình thuộc tài khoản khác. Chọn và lưu lại nick/kịch bản bằng tài khoản hiện tại.',
      );
  }
  const prior = db.jobs.find(
    j => j.nodeId === n.id && j.kind === kind && ['queued', 'running'].includes(j.status),
  );
  if (prior) {
    // Same request already queued: hand it back. An edit and a re-roll are different work,
    // and one must not be passed off as the other.
    if (edit) throw new Error('Node đang có tác vụ tạo ảnh. Đợi xong rồi sửa.');
    if (prior.payload?.edit) throw new Error('Node đang sửa ảnh. Đợi xong rồi tạo lại.');
    return prior;
  }
  // Video can run from the node's own approved image (keyframe), or from the images
  // of the connected parent nodes (videoInput === 'refs'). Once the node has composed
  // its own image, that exact keyframe drives the video — refs only seed it beforehand.
  const videoFromRefs = kind === 'video' && n.videoInput === 'refs' && !n.image;
  if (kind === 'video' && !videoFromRefs && !n.image)
    throw new Error(
      'Cần ảnh của node này trước khi tạo video, hoặc chuyển sang dùng ảnh node nối vào.',
    );
  // Setting-node parents carry text, not images; they never block generation.
  const imgParents = deps(n.id).filter(id => !isSetting(getNode(id)));
  if (!edit && (kind === 'image' || videoFromRefs) && imgParents.some(id => !getNode(id).image))
    throw new Error('Hãy tạo hoặc tải ảnh các node nối vào trước.');
  if (!edit && kind === 'image' && imgParents.some(id => getNode(id).stale))
    throw new Error('Ảnh node nối vào đã thay đổi. Hãy tạo lại trước.');
  if (kind === 'video' && !videoFromRefs && n.stale)
    throw new Error('Ảnh cần cập nhật sau thay đổi đầu vào. Hãy tạo lại hoặc tải ảnh đã duyệt.');
  const references = edit
    ? [{ role: n.id, asset: n.image }]
    : group
      ? groupReferences(n)
      : merged
        ? mergedReferences(n)
        : videoFromRefs
          ? assetRefs(n)
          : kind === 'video'
            ? [{ role: 'keyframe', asset: n.image }]
            : assetRefs(n);
  if (videoFromRefs) {
    if (!references.length)
      throw new Error('Nối ít nhất một node đã có ảnh vào node này để tạo video.');
    const staleParent = references.find(r => getNode(r.role).stale);
    if (staleParent)
      throw new Error(
        'Ảnh node "' + getNode(staleParent.role).name + '" cần cập nhật trước khi tạo video.',
      );
    // Over the video model's reference limit: film from a composed keyframe instead.
    const limit = videoRefLimit(n);
    if (limit !== null && references.length > limit)
      throw new Error(
        `Shot có ${references.length} ảnh tham chiếu, ${providers(n).video.modelName} chỉ nhận tối đa ${limit}. ` +
          'Tạo ảnh khung hình của shot trước (gộp các ảnh tham chiếu), rồi tạo video từ ảnh đó — "▶ Tạo video" tự động làm bước này.',
      );
  }
  const jobId = crypto.randomUUID();
  if (sv) {
    const binding = validateSeedvisBinding(kind, sv);
    if (edit)
      binding.aspectRatio = nearestAspect(imageSize(n.image), binding.model, binding.aspectRatio);
    // The group's shots fill this many seconds (the rest is a still tail to trim).
    if (group) binding.duration = groupPlan(n).D;
    const j = {
      id: jobId,
      nodeId: n.id,
      kind,
      status: 'queued',
      createdAt: new Date().toISOString(),
      payload: {
        seedvis: binding,
        kind,
        count,
        branch,
        prompt: edit ? editPrompt(edit) : prompts(n)[kind],
        edit: !!edit,
        website:
          'Seedvis · ' +
          binding.modelName +
          (edit ? ' · sửa ảnh' : count > 1 ? ' · ' + count + ' bản' : ''),
        aspectRatio: binding.aspectRatio,
        references,
        audio: db.audio,
        timing: { start: n.start || 0, duration: n.duration || 8 },
        nodeId: n.id,
        projectRevision: db.revision,
        inputRev: n.inputRev || 0,
      },
      error: null,
    };
    db.jobs.push(j);
    save();
    return j;
  }
  if (web) {
    // A bare job (no seedvis/orbit payload): the web worker extension claims it via
    // /api/worker/claim, generates on the site, and returns the file to /api/worker/complete.
    const payload = {
      kind,
      // Edit sends the node's own image (in references) with the change to make; otherwise the
      // node's normal image prompt. The extension frames an edit request around this text.
      prompt: edit ? edit : prompts(n)[kind],
      edit: !!edit,
      website: 'ChatGPT (extension)' + (edit ? ' · sửa ảnh' : ''),
      site: 'chatgpt',
      aspectRatio: '16:9',
      references,
      audio: db.audio,
      timing: { start: n.start || 0, duration: n.duration || 8 },
      nodeId: n.id,
      projectRevision: db.revision,
      inputRev: n.inputRev || 0,
    };
    const j = {
      id: jobId,
      nodeId: n.id,
      kind,
      status: 'queued',
      createdAt: new Date().toISOString(),
      payload,
      error: null,
    };
    db.jobs.push(j);
    save();
    return j;
  }
  const output = outputFor(db.outputDirectory, n.outputNaming, n.id, kind, jobId);
  const payload = {
    output,
    orbit: verifiedBinding,
    kind,
    prompt: prompts(n)[kind],
    website: verifiedBinding.scriptName,
    aspectRatio: '16:9',
    references,
    audio: db.audio,
    timing: { start: n.start || 0, duration: n.duration || 8 },
    nodeId: n.id,
    projectRevision: db.revision,
    inputRev: n.inputRev || 0,
  };
  const j = {
    id: jobId,
    nodeId: n.id,
    kind,
    status: 'queued',
    createdAt: new Date().toISOString(),
    payload,
    error: null,
  };
  db.jobs.push(j);
  save();
  return j;
}

export async function collectJob(j) {
  storeResult(j, await readOutput(j, Number(process.env.MV_OUTPUT_WAIT_MS || 60000)));
}
function storeResult(j, content) {
  const a = storeAsset(content);
  const n = getNode(j.nodeId);
  j.result = a;
  j.status = 'completed';
  j.completedAt = new Date().toISOString();
  j.resultStale = db.revision !== j.payload.projectRevision;
  if (!n) j.progress = 'Đã nhận file (node nguồn đã bị xóa)';
  else if (j.kind === 'video' && !n.terminal) {
    // Same rule as Seedvis: the clip is its own node; a second render never replaces the first.
    createBranchNode(n.id, a, j.resultStale || inputsMoved(j));
    j.progress = 'Đã tạo node video';
  } else {
    if (j.kind === 'image') setImage(n, a, j.resultStale || inputsMoved(j));
    else {
      n[j.kind] = a;
      n.videoStale = j.resultStale;
    }
    j.progress = 'Đã nhận file vào node';
  }
  save();
}
// A display-only node holding one produced video, wired from the source node. outdated =
// made from inputs that changed while it rendered; the shot's warning follows its newest clip.
export function createBranchNode(sourceId, asset, outdated = false) {
  const src = getNode(sourceId);
  if (!src) return null; // never hang a clip from a node that is gone
  const version = nextVersion(db.nodes, sourceId);
  if (src) src.lastVersion = version;
  const id = 'node-' + crypto.randomUUID();
  db.nodes.push({
    id,
    name: (src?.name || 'Video') + ' · v' + version,
    terminal: true,
    // a group's clips have their own column (⑩ Video Seedance), next to the group
    zone: isGroup(src) ? 'seedance-video' : 'output',
    seq: nextSeq(isGroup(src) ? 'seedance-video' : 'output'),
    source: sourceId,
    sourceSeq: src?.seq || null,
    sourceName: src?.name || '',
    version,
    outdated: !!outdated,
    image: null,
    video: asset,
    prompt: '',
    videoPrompt: '',
    lyric: '',
    start: 0,
    duration: isGroup(src) ? groupPlan(src).D : src?.duration || 8,
    outputNaming: { ...defaultNaming },
  });
  db.edges.push({ source: sourceId, target: id });
  src.videoStale = !!outdated;
  exportVideo(src, asset, version); // save the produced video into the export folder
  return id;
}
// Seedvis returns one result per requested version. Branch jobs turn each into
// its own output node; a single-version job stores into the source node.
// Were this job's images and prompt still the shot's current ones?
export function madeFromCurrentInputs(j) {
  const n = getNode(j.nodeId);
  if (!n || j.payload.prompt !== prompts(n)[j.kind]) return false;
  const refs = j.payload.references || [];
  if (isGroup(n) || isMerged(n)) {
    // a Seedance group (storyboard + references) or a merged scene (its frames): the same
    // images, in the same order — the prompt names them by that order
    const current = isGroup(n) ? groupReferences(n) : mergedReferences(n);
    return (
      refs.length === current.length &&
      refs.every((r, i) => r.role === current[i].role && r.asset?.id === current[i].asset?.id)
    );
  }
  const now = r => (r.role === 'keyframe' ? n.image : getNode(r.role)?.image);
  // the same inputs, no more and no fewer
  const keyframe = refs.length === 1 && refs[0].role === 'keyframe';
  if (!keyframe && refs.length !== assetRefs(n).length) return false;
  return refs.every(r => now(r)?.id === r.asset?.id);
}
export function storeSeedvisResults(j, results) {
  const assets = results.map(storeAsset);
  j.result = assets[0];
  j.resultCount = assets.length;
  j.status = 'completed';
  j.completedAt = new Date().toISOString();
  j.resultStale = db.revision !== j.payload.projectRevision;
  // A job re-checked long after it was sent (an old project): the project has surely been
  // edited since, so judge by what it was made from — same images and same prompt as the
  // shot has now means the clip is current.
  if (j.recheck && j.resultStale) j.resultStale = !madeFromCurrentInputs(j);
  // A clip is always its own node in the Video column, also for a video job saved before that
  // rule (an old project re-checked by "✚ Tạo video còn thiếu").
  if (j.payload.branch || j.kind === 'video') {
    const src = getNode(j.nodeId);
    if (!src) {
      // The shot was deleted while its (stopped) job finished: the clip stays on the job for
      // download — a node wired from a missing shot would break every later wire edit.
      j.progress = 'Đã nhận video (node nguồn đã bị xóa)';
    } else {
      if (db.nodes.length + assets.length > 5000)
        throw new Error('Quá nhiều node. Xóa bớt phiên bản cũ.');
      const outdated = j.resultStale || inputsMoved(j);
      j.branchNodes = assets.map(a => createBranchNode(j.nodeId, a, outdated));
      renumberSeq(db); // keep the Video zone numbered in production order
      j.progress = 'Đã tạo ' + assets.length + ' phiên bản video';
    }
  } else {
    const n = getNode(j.nodeId);
    // The node may have been deleted while a detached (stopped) job finished — keep the
    // result on the job for download, but there is nothing to write back into.
    if (n) {
      if (j.kind === 'image')
        // An edit only touches up the picture it was sent: when the node's inputs had
        // changed, the edited image is still built on the old ones.
        setImage(n, assets[0], (j.payload.edit && n.stale) || j.resultStale || inputsMoved(j));
      else {
        n[j.kind] = assets[0];
        n.videoStale = j.resultStale;
      }
      j.progress = 'Đã nhận file vào node';
    } else {
      j.progress = 'Đã nhận file (node nguồn đã bị xóa)';
    }
  }
  save();
}
// Stops jobs the user asked to halt. A locally-queued job (not yet sent) is cancelled
// outright. A running Seedvis job is detached: flagged cancelRequested so it no longer
// counts as busy (the workflow unlocks at once) while its result is still stored into the
// workflow when it finishes. We also ask Seedvis to cancel it, best-effort: a job still
// queued upstream is stopped and refunded; one already generating (and charged) keeps
// running (Seedvis answers not_cancellable). Returns how many were cancelled / detached.
export function haltJobs(match) {
  const toCancel = [];
  let cancelled = 0,
    detached = 0;
  for (const j of db.jobs) {
    if (!match(j)) continue;
    if (j.status === 'queued' && j.recheck) {
      // a job re-queued to be sent again under its own key: it may have reached Seedvis in
      // an earlier session, so it stays "to check", not "never sent"
      j.status = 'needs_review';
      j.progress = 'Đã dừng trước khi gửi lại; vẫn chờ kiểm tra';
      cancelled++;
    } else if (j.status === 'queued') {
      j.status = 'cancelled';
      j.progress = 'Đã hủy khi dừng (chưa gửi Seedvis)';
      cancelled++;
    } else if (j.status === 'running') {
      j.cancelRequested = true;
      j.progress =
        'Đã tách khỏi khóa workflow; Seedvis còn xếp hàng thì hủy, đang tạo thì chạy tiếp';
      detached++;
      if (j.payload.seedvis && j.remote?.id) toCancel.push(j);
    }
  }
  // Best-effort remote cancel, off the response path.
  for (const j of toCancel)
    seedvis
      .cancel(j)
      .then(r => {
        j.progress =
          r.outcome === 'not_cancellable'
            ? 'Seedvis đang tạo (không hủy được); kết quả sẽ tự thêm vào workflow khi xong'
            : r.ok
              ? 'Seedvis đã hủy (còn xếp hàng), không tính lượt'
              : 'Không gọi được hủy Seedvis; tác vụ chạy tiếp, kết quả vẫn được thêm';
        save();
      })
      .catch(() => {});
  return { cancelled, detached };
}
// Is this window generating right now? The same question requireIdle() asks, for callers that
// want to take another route instead of refusing (creating a project opens a window of its own).
export const isBusy = () =>
  db.autoRun?.status === 'running' ||
  db.autoVideoRun?.status === 'running' ||
  db.autoImageRun?.status === 'running' ||
  db.jobs.some(j => ['queued', 'running'].includes(j.status) && !j.cancelRequested);
export function requireIdle() {
  if (isBusy()) throw new Error('Đợi tác vụ hoàn tất hoặc dừng chuỗi trước khi sửa workflow.');
}
// Everything that makes it unsafe to point `db` at another project: a chain running, a job
// queued or running, and a job that was stopped but is still generating at Seedvis — its paid
// result has to land in the project that ordered it. Wider than isBusy() on purpose.
export const holdsProject = () =>
  isBusy() || db.jobs.some(j => ['queued', 'running'].includes(j.status));
// Switching, replacing or importing the open project while a stopped job still runs at
// Seedvis would store its paid clip into the wrong project, or lose it: wait for it.
export function requireNoRunningJobs() {
  requireIdle();
  const running = db.jobs.filter(j => ['queued', 'running'].includes(j.status)).length;
  if (running)
    throw new Error(
      `Còn ${running} tác vụ Seedvis đang chạy ngầm sau khi Dừng. Đợi xong rồi đổi hoặc dựng lại project.`,
    );
}
export function seedvisImages(j) {
  return j.payload.references.map(ref => {
    if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(ref.asset.id))
      throw new Error('Ảnh tham chiếu không hợp lệ.');
    // Named after the node's blueprint key, so anyone (or any API that passes file names
    // along) can tell which reference is which.
    const slug =
      String(
        getNode(ref.role)?.assetKey ||
          (ref.role === 'keyframe' && isGroup(getNode(j.nodeId)) ? 'storyboard' : ref.role),
      )
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'ref';
    return {
      data: fs.readFileSync(path.join(mediaDir, ref.asset.id)).toString('base64'),
      file_name: slug + '-' + ref.asset.id,
    };
  });
}
