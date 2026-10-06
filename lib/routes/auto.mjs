// Routes: batch image and video runs.
import { orderGraph } from '../../graph.mjs';
import { inspectOrbit, validateBinding } from '../../orbit-client.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  IMAGE_ZONES,
  autoVideoEligible,
  failedVideoNodeIds,
  imageBatchNodes,
  keyframeNote,
  inGroup,
  missingVideoPlan,
  reviewVideoNodeIds,
  startAutoVideoRun,
} from '../auto.mjs';
import { seedvis } from '../config.mjs';
import { NEXT, body, json } from '../http.mjs';
import { haltJobs, requireIdle } from '../jobs.mjs';
import { deps, getNode, isSetting } from '../nodes.mjs';
import { db, save } from '../projects.mjs';
import { providers, seedvisBinding } from '../providers.mjs';
import { publicState } from '../public-state.mjs';
import { isGroup } from '../seedance.mjs';
import { isMerged } from '../merged.mjs';
import { pump } from '../runner.mjs';

export async function handle(req, res, p, u) {
  if (p === '/api/auto/start' && req.method === 'POST') {
    requireIdle();
    const b = await body(req),
      // Output nodes hold a finished video; setting nodes carry text; a Seedance group and a
      // merged scene have no image of their own (their frames do). Skip them all.
      order = orderGraph(db.nodes, db.edges, b.target || null).filter(
        id =>
          !getNode(id).terminal &&
          !isSetting(getNode(id)) &&
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
        throw new Error(n.name + ': dùng Nhận file hoặc chạy riêng để xử lý tác vụ trước.');
      const type = providers(n).image.type;
      if (type === 'seedvis') {
        if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
        continue;
      }
      if (type === 'web') continue; // ChatGPT extension: no Hub binding to validate
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
    if (!zone) throw new Error('Chọn khu vực hợp lệ (Nhân vật / Bối cảnh / Sản xuất).');
    const eligible = imageBatchNodes(zone);
    if (!eligible.length)
      throw new Error('Khu vực này không có node nào cần/đủ điều kiện tạo ảnh.');
    // Only the Seedvis nodes in the batch need an API key; a ChatGPT (web) batch does not.
    if (eligible.some(n => providers(n).image.type === 'seedvis') && !seedvis.configured())
      throw new Error('Nhập API key Seedvis trong Kết nối web.');
    db.autoImageRun = {
      id: crypto.randomUUID(),
      status: 'running',
      zone,
      pending: eligible.map(n => n.id),
      total: eligible.length,
      errors: [],
      message: 'Đang tạo ảnh song song cho ' + eligible.length + ' node',
    };
    save();
    pump(req);
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
    const eligible = ready.filter(n => !review.has(n.id));
    if (!eligible.length)
      throw new Error(
        ready.length
          ? 'Shot còn tác vụ chờ xử lý (Seedvis có thể vẫn đang tạo hoặc đã xong). Bấm "✚ Tạo video còn thiếu" để kiểm tra lại mà không tạo trùng.'
          : !b.target && db.nodes.some(n => autoVideoEligible(n) && inGroup(n))
            ? 'Các shot sẵn sàng đều thuộc nhóm Seedance: quay chúng bằng nhóm ở cột ⑨ Seedance.'
            : 'Không có node nào sẵn ảnh để tạo video bằng Seedvis.',
      );
    startAutoVideoRun(
      req,
      eligible.map(n => n.id),
      versions,
      'Đang tạo video song song cho ' + eligible.length + ' node' + keyframeNote(eligible),
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
      n => failed.has(n.id) && !review.has(n.id) && !inGroup(n) && autoVideoEligible(n),
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
    if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
    const b = await body(req);
    const versions = Math.max(1, Math.min(8, Math.floor(Number(b.versions) || 1)));
    // Old projects too: shots whose job may be done at Seedvis are checked, not re-made.
    const { recheck, film, blocked } = missingVideoPlan();
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
