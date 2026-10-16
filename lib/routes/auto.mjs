// Routes: batch image and video runs.
import { orderGraph } from '../../graph.mjs';
import { inspectOrbit, validateBinding } from '../../orbit-client.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  IMAGE_ZONES,
  VIDEO_ZONES,
  autoVideoEligible,
  failedVideoNodeIds,
  imageBatchNodes,
  imageRecheckJobs,
  keyframeNote,
  inGroup,
  missingVideoPlan,
  reviewVideoNodeIds,
  startAutoVideoRun,
  videoBatchPlan,
  videoOutputCount,
} from '../auto.mjs';
import { seedvis } from '../config.mjs';
import { NEXT, body, json } from '../http.mjs';
import { haltJobs, isWebImage, requireIdle } from '../jobs.mjs';
import { assetRefs, deps, getNode, isSetting, isStageOnly } from '../nodes.mjs';
import { db, save } from '../projects.mjs';
import { providers, seedvisBinding } from '../providers.mjs';
import { publicState } from '../public-state.mjs';
import { isGroup } from '../seedance.mjs';
import { isMerged } from '../merged.mjs';
import { resumeSeedvis, pump } from '../runner.mjs';

export async function handle(req, res, p, u) {
  if (p === '/api/auto/start' && req.method === 'POST') {
    requireIdle();
    const b = await body(req),
      // Output nodes hold a finished video; setting nodes carry text; a 3D stage node only its
      // marks; a Seedance group and a merged scene have no image of their own (their frames do).
      // Skip them all.
      order = orderGraph(db.nodes, db.edges, b.target || null).filter(
        id =>
          !getNode(id).terminal &&
          !isSetting(getNode(id)) &&
          !isStageOnly(getNode(id)) &&
          !isGroup(getNode(id)) &&
          !isMerged(getNode(id)),
      ),
      rerun = new Set();
    for (const id of order) {
      const n = getNode(id);
      if (!n.image || n.stale || deps(id).some(id => rerun.has(id))) rerun.add(id);
    }
    // Only true Orbit nodes make the chain require a Hub login + a writable output folder. Use
    // the resolved provider so a node following the project default (ChatGPT/Seedvis) counts too,
    // not just nodes with an explicit per-node choice.
    const needOrbit = [...rerun].some(id => providers(getNode(id)).image.type === 'orbit');
    const info = needOrbit ? await inspectOrbit(req) : null;
    if (info && !info.authenticated) throw new Error(info.message);
    for (const id of rerun) {
      const n = getNode(id);
      const ambiguous = [...db.jobs].reverse().find(j => j.nodeId === id && j.kind === 'image');
      if (ambiguous?.status === 'needs_review')
        throw new Error(
          n.name +
            (isWebImage(ambiguous)
              ? ': ảnh web chưa về. Bấm "Lấy lại ảnh" ở hàng đợi, hoặc chạy riêng node để tạo lại.'
              : ': dùng Nhận file hoặc chạy riêng để xử lý tác vụ trước.'),
        );
      const type = providers(n).image.type;
      if (type === 'seedvis') {
        if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
        continue;
      }
      if (type === 'web' || type === 'musechat') continue; // browser workers need no Orbit binding
      const binding = await validateBinding(req, n.orbit?.image);
      if (binding.owner !== n.orbit.image.owner)
        throw new Error('Chọn lại tài khoản chạy node ' + n.name);
    }
    if (needOrbit) {
      fs.mkdirSync(db.outputDirectory, { recursive: true });
      fs.accessSync(db.outputDirectory, fs.constants.W_OK);
    }
    db.autoRun = {
      id: crypto.randomUUID(),
      owner: info?.user.email || null,
      status: 'running',
      order,
      index: 0,
      message: 'Chạy lần lượt; dùng lại ảnh còn hợp lệ',
      attempts: {},
      maxRetries: 3,
    };
    save();
    pump(req);
    return json(res, 200, publicState());
  }
  if (p === '/api/auto/stop' && req.method === 'POST') {
    if (db.autoRun?.status === 'running') {
      db.autoRun.status = 'stopped';
      db.autoRun.message = 'Đã dừng chuỗi tạo ảnh';
    }
    if (db.autoImageRun?.status === 'running') {
      db.autoImageRun.pending = [];
      db.autoImageRun.status = 'stopped';
      db.autoImageRun.message = 'Đã dừng tạo ảnh khu vực';
    }
    // Cancel queued image jobs and detach any running one so the workflow unlocks.
    const stopped = haltJobs(j => j.kind === 'image' && ['queued', 'running'].includes(j.status));
    save();
    return json(res, 200, { ...publicState(), stopped });
  }
  // Quick image batch: generate images for all ready nodes in one zone, in parallel.
  if (p === '/api/auto/images/start' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const zone = IMAGE_ZONES.has(b.zone) ? b.zone : null;
    if (!zone) throw new Error('Chọn khu vực hợp lệ (Nhân vật / Bối cảnh / Sản xuất / Lip-sync).');
    const eligible = imageBatchNodes(zone);
    // Node đã có ảnh chờ Seedvis/Seedane trả về (hết giờ chờ): KHÔNG tạo mới (sẽ trừ tiền lần nữa)
    // mà kiểm lại — lấy ảnh đã xong về miễn phí. Đây mới là thứ chặn "không có node đủ điều kiện":
    // trước đây batch loại chúng và báo trống dù node thật sự chưa có ảnh.
    const recheck = imageRecheckJobs(zone);
    if (!eligible.length && !recheck.length)
      throw new Error(
        'Khu vực này không có node nào cần tạo ảnh (các node đã có ảnh hoặc đang chờ xử lý).',
      );
    // Only the Seedvis nodes in the batch need an API key; a ChatGPT (web) batch does not.
    if (eligible.some(n => providers(n).image.type === 'seedvis') && !seedvis.configured())
      throw new Error('Nhập API key Seedvis trong Kết nối web.');
    // Kiểm lại (resume) các job đang chờ — cùng mã, không render lại. Chạy độc lập với lượt tạo
    // mới: lấy về ảnh Seedvis đã xong, rồi batch sau (hoặc lần bấm sau) sẽ thấy node còn thiếu.
    for (const jb of recheck) resumeSeedvis(jb);
    if (eligible.length) {
      db.autoImageRun = {
        id: crypto.randomUUID(),
        status: 'running',
        zone,
        pending: eligible.map(n => n.id),
        total: eligible.length,
        errors: [],
        message: 'Đang tạo ảnh song song cho ' + eligible.length + ' node',
        attempts: {},
        maxRetries: 3,
      };
    }
    save();
    pump(req);
    const state = publicState();
    state.imageBatchSummary = {
      created: eligible.length,
      rechecked: recheck.length,
      zone,
      message:
        (eligible.length ? `Đang tạo ảnh cho ${eligible.length} node. ` : '') +
        (recheck.length
          ? `Đang kiểm lại ${recheck.length} ảnh đang chờ Seedvis (không tạo trùng) — ảnh đã xong sẽ về node, bấm lại để tạo phần còn thiếu.`
          : ''),
    };
    return json(res, 200, state);
  }
  // Per-zone video batch: generate videos for all ready nodes in one zone, any provider.
  if (p === '/api/auto/video/zone/start' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const zone = VIDEO_ZONES.has(b.zone) ? b.zone : null;
    if (!zone) throw new Error('Chọn khu vực hợp lệ (Sản xuất / Phân cảnh ghép / Hát nhép).');
    const providerFilter = b.provider || null;
    const allowStale = b.allowStale === true;
    const excludeCloseups = b.excludeCloseups === true;
    const versions = Math.max(1, Math.min(8, Math.floor(Number(b.versions) || 1)));
    const { ready, skipped } = videoBatchPlan(zone, providerFilter, versions, allowStale, { excludeCloseups });
    if (!ready.length) {
      const reasons = {
        not_renderable: 'node không quay video riêng', closeup: 'shot cận mặt bị loại',
        has_video: `đã đủ ${versions} phiên bản video`, provider: 'khác provider đang chọn',
        unsupported_provider: 'provider không hỗ trợ video', no_image: 'chưa có ảnh riêng hoặc ảnh tham chiếu',
        needs_keyframe: 'take lip-sync cần ảnh khung', stale: 'ảnh cũ cần xác nhận sử dụng',
      };
      const counts = {};
      for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1;
      const detail = Object.entries(counts).map(([reason, count]) => `${count} ${reasons[reason]}`).join('; ');
      throw new Error('Khu vực này không có node nào đủ điều kiện tạo video. ' + (detail || 'Khu vực chưa có node.'));
    }
    if (ready.some(n => providers(n).video.type === 'seedvis') && !seedvis.configured())
      throw new Error('Nhập API key Seedvis trong Kết nối web.');
    const label = providerFilter
      ? { seedvis: 'Seedvis', musechat: 'Muse Chat', gvids: 'Google Vids', orbit: 'Orbit' }[
          providerFilter
        ] || providerFilter
      : 'tất cả nguồn';
    const missingVersions = ready.reduce(
      (total, n) => total + Math.max(0, versions - videoOutputCount(n)),
      0,
    );
    // A zone render may be requested before a composed/keyframe image exists. If connected
    // image parents are available, make refs-mode explicit so the job builder sends them (or
    // composes a keyframe first when the provider limit is exceeded).
    for (const n of ready) {
      if (!n.image && assetRefs(n).length) n.videoInput = 'refs';
    }
    save();
    startAutoVideoRun(
      req,
      ready.map(n => n.id),
      versions,
      `Đang bổ sung ${missingVersions} video (${label}) để ${ready.length} node đạt ${versions} phiên bản` +
        keyframeNote(ready),
      [],
      { allowStale },
    );
    return json(res, 200, publicState());
  }
  if (p === '/api/auto/video/start' && req.method === 'POST') {
    requireIdle();
    if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
    const b = await body(req);
    const versions = Math.max(1, Math.min(8, Math.floor(Number(b.versions) || 1)));
    // Eligible: production-zone (Sản xuất video) Seedvis nodes whose video input is
    // already ready. Character/scene asset nodes are never auto-filmed, even with an image.
    // Shots wired into a Seedance group are filmed by their group, not one by one here.
    const review = reviewVideoNodeIds();
    const ready = db.nodes.filter(
      n => autoVideoEligible(n) && (b.target ? n.id === b.target : !inGroup(n)),
    );
    const eligible = ready.filter(n => !review.has(n.id) && videoOutputCount(n) < versions);
    if (!eligible.length)
      throw new Error(
        ready.length && ready.every(n => videoOutputCount(n) >= versions)
          ? `Mọi node đã có đủ ${versions} phiên bản video.`
          : ready.length
          ? 'Shot còn tác vụ chờ xử lý (Seedvis có thể vẫn đang tạo hoặc đã xong). Bấm "✚ Tạo video còn thiếu" để kiểm tra lại mà không tạo trùng.'
          : !b.target && db.nodes.some(n => autoVideoEligible(n) && inGroup(n))
            ? 'Các shot sẵn sàng đều thuộc nhóm Seedance: quay chúng bằng nhóm ở cột ⑨ Seedance.'
            : 'Không có node nào sẵn ảnh để tạo video bằng Seedvis.',
      );
    startAutoVideoRun(
      req,
      eligible.map(n => n.id),
      versions,
      `Đang bổ sung video để ${eligible.length} node đạt ${versions} phiên bản` + keyframeNote(eligible),
    );
    return json(res, 200, publicState());
  }
  if (p === '/api/auto/video/stop' && req.method === 'POST') {
    if (db.autoVideoRun?.status === 'running') {
      db.autoVideoRun.pending = [];
      db.autoVideoRun.status = 'stopped';
      db.autoVideoRun.message = 'Đã dừng tạo video';
    }
    // Cancel queued video jobs and detach any running one so the workflow unlocks.
    const stopped = haltJobs(j => j.kind === 'video' && ['queued', 'running'].includes(j.status));
    save();
    return json(res, 200, { ...publicState(), stopped });
  }
  if (p === '/api/auto/video/retry' && req.method === 'POST') {
    requireIdle();
    if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
    const b = await body(req);
    const versions = Math.max(1, Math.min(8, Math.floor(Number(b.versions) || 1)));
    // Only the production nodes whose last video job failed and are still ready to film — and
    // with no older job that may have been paid for (those go through "✚", checked first).
    const failed = new Set(failedVideoNodeIds());
    const review = reviewVideoNodeIds();
    const eligible = db.nodes.filter(
      n =>
        failed.has(n.id) &&
        !review.has(n.id) &&
        !inGroup(n) &&
        autoVideoEligible(n) &&
        videoOutputCount(n) < versions,
    );
    if (!eligible.length) throw new Error('Không có video lỗi để chạy lại.');
    // Clear the failed video jobs we are retrying so the queue is clean for the new run.
    const retryIds = new Set(eligible.map(n => n.id));
    db.jobs = db.jobs.filter(
      j => !(j.kind === 'video' && j.status === 'failed' && retryIds.has(j.nodeId)),
    );
    startAutoVideoRun(
      req,
      eligible.map(n => n.id),
      versions,
      'Chạy lại video cho ' + eligible.length + ' node lỗi',
    );
    return json(res, 200, publicState());
  }
  // Fill in the gaps: production nodes that are ready but still have no video (not failed).
  if (p === '/api/auto/video/missing' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const versions = Math.max(1, Math.min(8, Math.floor(Number(b.versions) || 1)));
    // Old projects too: shots whose job may be done at Seedvis are checked, not re-made.
    const { recheck, film, blocked } = missingVideoPlan();
    if ([...recheck, ...film].some(item => item.payload?.seedvis ||
      (!item.payload && providers(item).video.type === 'seedvis')) && !seedvis.configured())
      throw new Error('Nhập API key Seedvis trong Kết nối web.');
    const blockedNote = blocked.length
      ? ` · ${blocked.length} shot cần xem trên seedvis.com trước (${blocked.map(n => n.name).join(', ')}): Seedvis đã có tác vụ khác cùng mã`
      : '';
    if (!recheck.length && !film.length)
      throw new Error('Mọi shot đã có video. Không có gì còn thiếu.' + blockedNote);
    const filmNew = film.filter(n => !recheck.some(j => j.nodeId === n.id));
    const checked = new Set(recheck.map(j => j.nodeId)).size;
    startAutoVideoRun(
      req,
      film.map(n => n.id),
      versions,
      'Tạo video còn thiếu: ' +
        filmNew.length +
        ' shot tạo mới' +
        (recheck.length
          ? ` · ${checked} shot kiểm tra lại ${recheck.length} tác vụ với Seedvis (có thể đã làm xong, không tạo trùng)`
          : '') +
        keyframeNote(filmNew) +
        blockedNote,
      recheck,
    );
    return json(res, 200, publicState());
  }
  return NEXT;
}
