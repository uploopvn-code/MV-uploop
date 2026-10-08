// Generation jobs: create (image, video, edit), store results, clip nodes, cancel/idle checks.
import { readOutput } from '../media-io.mjs';
import { defaultNaming, outputFor } from '../output-config.mjs';
import { validateBinding } from '../orbit-client.mjs';
import { takesVideo, validateSeedvisBinding } from '../seedvis-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { seedvis } from './config.mjs';
import { imageSize, nearestAspect } from './image-size.mjs';
import { exportVideo } from './library.mjs';
import { storeAsset } from './media.mjs';
import { assetRefs, getNode, imageParents, isLipsync, isSetting, isStageOnly } from './nodes.mjs';
import { ensureLipsyncInput, lipsyncSig } from './lipsync.mjs';
import { db, mediaDir, nextVersion, save, vocalTasks } from './projects.mjs';
import { editPrompt, prompts } from './prompts.mjs';
import { providers, seedvisBinding, videoRefLimit } from './providers.mjs';
import { inputsMoved, setImage } from './staleness.mjs';
import { groupPlan, groupProblem, groupReferences, isGroup } from './seedance.mjs';
import { frameProblem, isFrame, isMerged, mergedProblem, mergedReferences } from './merged.mjs';
import { reviewVideoNodeIds } from './auto.mjs';
import { layoutRef, withoutCapture } from './stage3d.mjs';
import { nextSeq, renumberSeq } from './zones.mjs';

// The images an image job sends: the wired references, then — for a shot on a staged set — the
// 3D capture of its framing (the prompt names it as the last image).
const imageRefs = n => {
  const layout = layoutRef(n);
  return layout ? [...assetRefs(n), layout] : assetRefs(n);
};

// late: also a job the server gave up on while its worker may still deliver (j.late: a ChatGPT
// image whose heartbeat lapsed, the app restarted, or the prompt was sent and then it failed),
// and one queued to be fetched from its conversation that no worker has taken yet. The lease
// still names that one run: a recover gets a new lease when claimed.
export function checkLease(j, b, { late = false } = {}) {
  const ok =
    j &&
    b.lease &&
    j.lease === b.lease &&
    !j.result &&
    (j.status === 'running' ||
      (late && j.late && (j.status === 'needs_review' || (j.status === 'queued' && j.recover))));
  if (!ok) throw new Error('Job không còn thuộc phiên worker này.');
}
// A ChatGPT (extension) image job: a bare image job, no Seedvis/Orbit payload.
export const isWebImage = j => j.kind === 'image' && !j.payload.seedvis && !j.payload.orbit;
// Does the node still wait for this late ChatGPT image? null = yes, else why not: it is gone,
// has another image than when the job was made, or a newer job of the same kind took over.
export function webResultMovedOn(j) {
  const n = getNode(j.nodeId);
  if (!n) return 'node nguồn đã bị xóa';
  const base = j.payload.baseImageId; // undefined on jobs made before it was recorded
  if (base === undefined ? !!n.image : (n.image?.id || null) !== base) return 'node đã có ảnh khác';
  if (
    db.jobs.some(
      o =>
        o !== j &&
        o.nodeId === j.nodeId &&
        o.kind === j.kind &&
        o.createdAt > j.createdAt &&
        ['queued', 'running', 'completed'].includes(o.status),
    )
  )
    return 'node đã có tác vụ mới hơn';
  return null;
}
// After `ms`, the runner opens the job's ChatGPT conversation again to fetch the image (async on
// ChatGPT: it often lands after the extension stopped waiting). Twice at most on its own, only
// with the worker that sent it (same ChatGPT account) able to, and only while the node still
// waits for it; after that the "Lấy lại ảnh" button. A conversation two jobs shared is skipped:
// whose image is the newest one there cannot be told.
export function scheduleRecover(j, ms) {
  delete j.recoverAt;
  if (!isWebImage(j) || !j.web?.conversationUrl || j.web.shared) return;
  if (!j.workerCaps?.includes('recover') || (j.recover?.tries || 0) >= 2) return;
  if (webResultMovedOn(j)) return;
  j.recoverAt = Date.now() + ms;
  j.progress = 'ChatGPT có thể vẫn đang vẽ: tool sẽ tự mở lại cuộc trò chuyện để lấy ảnh';
}
// Queues a ChatGPT image job to be fetched from its conversation: the extension opens that page
// and takes the newest image there, never sending the prompt again. Until a worker takes it,
// the first run's late result is still accepted (same lease).
// Has a worker that can recover ChatGPT images (that one by name, else any) asked for work in the
// last `ms`?
export function recoverWorkerOn(name, ms) {
  const seen = db.recoverWorkers || {};
  const now = Date.now();
  return name ? now - (seen[name] || 0) < ms : Object.values(seen).some(t => now - t < ms);
}
export function queueRecover(j) {
  if (!isWebImage(j) || j.status !== 'needs_review')
    throw new Error('Chỉ lấy lại được ảnh ChatGPT đang chờ kiểm tra.');
  const url = j.web?.conversationUrl;
  if (!url)
    throw new Error(
      'Tác vụ không có link cuộc trò chuyện ChatGPT. Tải ảnh từ ChatGPT rồi dùng "↑ Tải ảnh" ở node.',
    );
  j.status = 'queued';
  j.late = true;
  j.recover = { conversationUrl: url, tries: (j.recover?.tries || 0) + 1, queuedAt: Date.now() };
  delete j.recoverAt;
  j.error = null;
  j.progress =
    'Chờ extension' +
    (j.worker ? ' "' + j.worker + '"' : '') +
    ' mở lại cuộc trò chuyện ChatGPT để lấy ảnh (không tạo lại)';
}
export async function createJob(req, b) {
  const n = getNode(b.nodeId);
  if (!n) throw new Error('Node không tồn tại');
  if (n.terminal) throw new Error('Node phiên bản chỉ để xem, không tạo tiếp từ nó.');
  if (isSetting(n)) throw new Error('Node cài đặt (style/máy quay) không tạo ảnh/video.');
  if (isStageOnly(n))
    throw new Error(
      'Node sân khấu 3D chỉ giữ vị trí đã ghim, không tạo ảnh — nối nó vào các shot (hoặc vào bối cảnh của chúng).',
    );
  const kind = b.kind === 'video' ? 'video' : 'image';
  const count = kind === 'video' ? Math.max(1, Math.min(8, Math.floor(Number(b.count) || 1))) : 1;
  const sv = seedvisBinding(n, kind);
  // The ChatGPT (web) extension runs a node whose image source resolves to "web" — an explicit
  // per-node choice or the project default. Computed here so the edit guard below can allow it.
  const web = !sv && providers(n)[kind].type === 'web';
  // Muse Chat (extension) runs image and video nodes through the browser with the user's Muse session.
  const mc = !sv && providers(n)[kind].type === 'musechat';
  // Google Vids (extension) runs a video node whose source resolves to "gvids": the browser
  // extension drives Google Vids with the user's Google session. Video only.
  const gv = !sv && providers(n)[kind].type === 'gvids';
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
  // A merged scene films its 2–3 frames in one Seedvis clip, from those frames' images (any
  // video model that takes that many reference images — Veo, Omni Flash, Seedance).
  const merged = isMerged(n);
  if (merged) {
    if (kind === 'image')
      throw new Error('Phân cảnh ghép không có ảnh riêng: tạo ảnh ở từng khung ở cột ⑥ Sản xuất.');
    if (!sv) throw new Error('Phân cảnh ghép quay qua Seedvis — đặt nguồn video = Seedvis.');
    const problem = mergedProblem(n);
    if (problem) throw new Error(problem);
    // A render of this scene may already be paid for at Seedvis: check it before paying again.
    if (!b.force && reviewVideoNodeIds().has(n.id))
      throw new Error(
        'Phân cảnh ghép còn tác vụ chờ kiểm tra (có thể đã làm xong). Bấm "↻ Kiểm tra lại" trước; tạo mới có thể trả tiền hai lần.',
      );
  }
  // A lip-sync take films one sung line with Omni Flash video-to-video: its keyframe + the
  // isolated vocal of that line, muxed into the source video (built when the job is made, so it
  // always matches the take's current keyframe and cut). No reference images go with it.
  const lipsyncVideo = isLipsync(n) && kind === 'video';
  if (lipsyncVideo) {
    if (!sv) throw new Error('Take lip-sync quay qua Seedvis · Omni Flash (video-to-video).');
    if (!takesVideo(sv.model))
      throw new Error('Take lip-sync cần model nhận video đầu vào: chọn Omni Flash.');
    if (!n.image)
      throw new Error('Take lip-sync cần ảnh khung (ca sĩ) trước: bấm Tạo ảnh hoặc tải ảnh.');
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
    if (!sv && !web && !mc)
      throw new Error(
        'Sửa ảnh chạy qua Seedvis, ChatGPT (extension) hoặc Muse chat (extension). Node này đang dùng Orbit — đổi nguồn tạo ảnh.',
      );
    if (mc) throw new Error('Muse chat (extension) chưa hỗ trợ sửa ảnh; dùng tạo ảnh mới hoặc ChatGPT/Seedvis.');
  }
  if (!sv && count > 1)
    throw new Error('Nhiều phiên bản / tách node chỉ hỗ trợ Seedvis. Node này đang dùng Orbit.');
  let verifiedBinding = null;
  if (sv) {
    if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
  } else if (web) {
    // Nothing to validate against a Hub: the browser extension claims the job and runs it.
    if (kind === 'video')
      throw new Error(
        'ChatGPT (extension) chỉ tạo ảnh. Chọn Seedvis, Google Vids hoặc Orbit cho video.',
      );
  } else if (mc) {
    // Muse Chat runs through the browser extension for both image and video.
  } else if (gv) {
    // Google Vids runs in the browser extension too; nothing to validate against a Hub.
    if (kind === 'image')
      throw new Error(
        'Google Vids (extension) chỉ tạo video. Chọn Seedvis, ChatGPT hoặc Orbit cho ảnh.',
      );
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
  // Google Vids and Muse Chat make video straight from a text prompt, so they need no keyframe
  // image (a keyframe/reference image is optional). Every other video source needs an image first.
  if (kind === 'video' && !videoFromRefs && !n.image && !gv && !mc)
    throw new Error(
      'Cần ảnh của node này trước khi tạo video, hoặc chuyển sang dùng ảnh node nối vào.',
    );
  // Setting-node parents carry text, not images, and a 3D stage node only its marks: neither
  // blocks generation.
  const imgParents = imageParents(n).map(p => p.id);
  if (!edit && (kind === 'image' || videoFromRefs) && imgParents.some(id => !getNode(id).image))
    throw new Error('Hãy tạo hoặc tải ảnh các node nối vào trước.');
  if (!edit && kind === 'image' && imgParents.some(id => getNode(id).stale))
    throw new Error('Ảnh node nối vào đã thay đổi. Hãy tạo lại trước.');
  if (kind === 'video' && !videoFromRefs && n.image && n.stale)
    throw new Error('Ảnh cần cập nhật sau thay đổi đầu vào. Hãy tạo lại hoặc tải ảnh đã duyệt.');
  const references = lipsyncVideo
    ? []
    : edit
      ? [{ role: n.id, asset: n.image }]
      : group
        ? groupReferences(n)
        : merged
          ? mergedReferences(n)
          : videoFromRefs
            ? assetRefs(n)
            : kind === 'video'
              ? n.image
                ? [{ role: 'keyframe', asset: n.image }]
                : assetRefs(n)
              : imageRefs(n);
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
    const input = lipsyncVideo ? await ensureLipsyncInput(n) : null;
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
        // a lip-sync take's source video (keyframe + vocal) and what it was cut from
        ...(input ? { inputVideo: { id: input.id, name: input.name }, lsSig: lipsyncSig(n) } : {}),
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
      // the node's image when asked: a late result lands only if it is still the same
      baseImageId: n.image?.id || null,
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
  if (gv) {
    // A bare video job the Google Vids browser extension claims via /api/worker/claim. The
    // extension drives Google Vids in a tab (prompt + optional reference/ingredient images),
    // captures the 1080p preview and returns the MP4 to /api/worker/complete.
    const payload = {
      kind,
      prompt: prompts(n)[kind],
      website: 'Google Vids (extension)',
      site: 'googlevids',
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
  if (mc) {
    // A bare Muse Chat browser job can create either an image or a video.
    const payload = {
      kind,
      prompt: prompts(n)[kind],
      website: 'Muse chat (extension)',
      site: 'musechat',
      aspectRatio: '16:9',
      references,
      audio: db.audio,
      timing: { start: n.start || 0, duration: n.duration || 8 },
      nodeId: n.id,
      projectRevision: db.revision,
      inputRev: n.inputRev || 0,
      baseImageId: n.image?.id || null,
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
  // a group's clips have their own column (⑩ Video Seedance), next to the group; a lip-sync
  // take's clips too (⑫ Video lip-sync), carrying the song time they belong at
  const take = isLipsync(src);
  const zone = isGroup(src) ? 'seedance-video' : take ? 'lipsync-video' : 'output';
  db.nodes.push({
    id,
    name: (src?.name || 'Video') + ' · v' + version,
    terminal: true,
    zone,
    seq: nextSeq(zone),
    source: sourceId,
    sourceSeq: src?.seq || null,
    sourceName: src?.name || '',
    version,
    outdated: !!outdated,
    image: null,
    video: asset,
    prompt: '',
    videoPrompt: '',
    lyric: take ? src.lyric || '' : '',
    start: take ? src.clipStart || 0 : 0,
    duration: isGroup(src)
      ? groupPlan(src).D
      : take
        ? Math.round((src.clipEnd - src.clipStart) * 1000) / 1000
        : src?.duration || 8,
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
// (A 3D capture that arrived since — or went — is not a change: the same marks, as a picture. The
// prompt is compared without its sentence and the references without it.)
export function madeFromCurrentInputs(j) {
  const n = getNode(j.nodeId);
  if (!n || withoutCapture(j.payload.prompt) !== withoutCapture(prompts(n)[j.kind])) return false;
  // a lip-sync take: the same keyframe, vocal track and cut as its source video was made from
  if (isLipsync(n) && j.kind === 'video') return j.payload.lsSig === lipsyncSig(n);
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
  const sent = refs.filter(r => r.role !== 'layout');
  const keyframe = sent.length === 1 && sent[0].role === 'keyframe';
  if (!keyframe && sent.length !== assetRefs(n).length) return false;
  return sent.every(r => now(r)?.id === r.asset?.id);
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
    if (j.status === 'queued' && j.recover) {
      // a ChatGPT image waiting to be fetched from its conversation: it may still be there
      j.status = 'needs_review';
      j.progress = 'Đã dừng trước khi lấy lại ảnh; vẫn bấm "Lấy lại ảnh" được';
      cancelled++;
    } else if (j.status === 'queued' && j.recheck) {
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
  db.jobs.some(
    j =>
      ['queued', 'running'].includes(j.status) &&
      !j.cancelRequested &&
      // (a ChatGPT image waiting to be fetched from its conversation changes nothing until it
      // lands, and its landing checks the node did not move on)
      !(j.status === 'queued' && j.recover),
  );
export function requireIdle() {
  if (isBusy()) throw new Error('Đợi tác vụ hoàn tất hoặc dừng chuỗi trước khi sửa workflow.');
}
// Everything that makes it unsafe to point `db` at another project: a chain running, a job
// queued or running, and a job that was stopped but is still generating at Seedvis — its paid
// result has to land in the project that ordered it. Wider than isBusy() on purpose.
export const holdsProject = () =>
  isBusy() ||
  // a vocal separation / auto-storyboard run writes into this project's media for minutes without
  // a job of its own — do not point db elsewhere or delete the folder under it
  vocalTasks.size > 0 ||
  db.jobs.some(j => ['queued', 'running'].includes(j.status));
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
// Seedvis takes reference images inline: at most 20 MiB each and 40 MiB in one request (its
// documented limits). A group that fills 30 s across several scenes can approach these, so the
// total is checked as the images are read — an over-limit render fails for free (definite:
// nothing is sent) instead of being rejected by Seedvis after the credit is spent.
const MAX_REF_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // a source video (video-to-video), inline
const asMB = n => (n / (1024 * 1024)).toFixed(1);
// A lip-sync take's source video, inline as a data URL — null for every other job.
export function seedvisVideo(j) {
  const v = j.payload.inputVideo;
  if (!v) return null;
  if (!/^[a-f0-9-]+\.mp4$/.test(v.id)) throw new Error('Video nguồn không hợp lệ.');
  const bytes = fs.readFileSync(path.join(mediaDir, v.id));
  if (bytes.length > MAX_VIDEO_BYTES)
    throw new Error(`Video nguồn nặng ${asMB(bytes.length)} MB, quá 100 MB mỗi lượt của Seedvis.`);
  return 'data:video/mp4;base64,' + bytes.toString('base64');
}
export function seedvisImages(j) {
  let total = 0;
  return j.payload.references.map(ref => {
    if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(ref.asset.id))
      throw new Error('Ảnh tham chiếu không hợp lệ.');
    const bytes = fs.readFileSync(path.join(mediaDir, ref.asset.id));
    if (bytes.length > MAX_REF_BYTES)
      throw new Error(
        `Ảnh tham chiếu "${ref.asset.name || ref.asset.id}" nặng ${asMB(bytes.length)} MB, quá 20 MB mỗi ảnh của Seedvis. Tạo lại ảnh này nhẹ hơn rồi thử lại.`,
      );
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES)
      throw new Error(
        `Tổng ảnh gửi đi ${asMB(total)} MB, quá 40 MB mỗi lượt của Seedvis. Bớt shot trong nhóm, hoặc tạo ảnh khung cho các shot để dùng ít ảnh tham chiếu hơn.`,
      );
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
      data: bytes.toString('base64'),
      file_name: slug + '-' + ref.asset.id,
    };
  });
}
