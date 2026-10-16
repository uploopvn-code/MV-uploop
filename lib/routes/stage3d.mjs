// Routes: the 3D stage of a set. Pinning stores every performer's mark on the set (the scene
// node's `stage3d`) and the captures the editor rendered — the front wide and each shot's own
// framing; every shot that uses the set keeps the marks (lib/stage3d.mjs). A shot added or changed
// later gets its capture from the browser on its own (public/js/stage-keeper.js →
// /api/stage3d/captures): the user pins once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NEXT, body, json } from '../http.mjs';
import { requireIdle } from '../jobs.mjs';
import { storeAsset } from '../media.mjs';
import { getNode, isCharacter, isStageOnly } from '../nodes.mjs';
import { activeId, db, mediaDir, mutate, save } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { isSet, isShot, reconcilePins, shotsAt, sigOf, staging } from '../stage3d.mjs';
import {
  CAMERA_MOVE_KEYS,
  ready as topviewReady,
  renderCameraOnly,
  renderLayout,
  renderPreview,
  stitchPreviews,
} from '../topview3d.mjs';
import { cleanStage, layoutSig } from '../../public/js/stage-math.js';

// A capture as the editor sends it: a JPEG/PNG (base64, a data URL prefix tolerated) of at most
// 5 MB.
const parse = data => {
  const m = String(data || '').match(/^(?:data:(image\/(?:jpeg|png));base64,)?([A-Za-z0-9+/=]+)$/);
  if (!m || m[2].length > 7_000_000) return null;
  const head = Buffer.from(m[2].slice(0, 12), 'base64');
  const mime =
    head[0] === 0xff && head[1] === 0xd8
      ? 'image/jpeg'
      : head.subarray(0, 4).toString('hex') === '89504e47'
        ? 'image/png'
        : null;
  return mime ? { mime, base64: m[2] } : null;
};
const fileOf = a =>
  a?.id && /^[a-f0-9-]+\.(jpg|png)$/.test(a.id) ? path.join(mediaDir, a.id) : null;
// A capture file nothing shows or sends any more is removed (a job that may still be sent — or sent
// again — reads it then).
const used = id =>
  db.nodes.some(
    n =>
      n.image?.id === id ||
      n.prevImage?.id === id ||
      n.layout?.asset?.id === id ||
      n.stage3d?.capture?.id === id,
  ) ||
  db.jobs.some(
    j =>
      !['completed', 'failed'].includes(j.status) &&
      j.payload?.references?.some(r => r.asset?.id === id),
  );
const drop = a => {
  const f = fileOf(a);
  if (f && !used(a.id)) fs.rmSync(f, { force: true });
};
// The new capture in place of the old one: the old asset kept when the picture is the same (a
// job made from it stays current), else a new file; null for no picture.
function replace(old, data, name) {
  const c = parse(data);
  if (!c) return null;
  const f = fileOf(old);
  try {
    if (f && fs.readFileSync(f).equals(Buffer.from(c.base64, 'base64'))) return old;
  } catch {}
  return storeAsset({ ...c, name });
}
const same = (a, b) =>
  !!a &&
  JSON.stringify({ size: a.size, performers: a.performers, dialogue: a.dialogue || null }) ===
    JSON.stringify({ size: b.size, performers: b.performers, dialogue: b.dialogue || null });

export async function handle(req, res, p) {
  if (p === '/api/stage3d' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const set = getNode(b.sceneId);
    if (!isSet(set)) throw new Error('Chỉ dàn dựng 3D trên node bối cảnh (cảnh toàn).');
    const stage = cleanStage(b.stage, id => isCharacter(getNode(id)));
    const prev = set.stage3d;
    const users = shotsAt(set.id); // (who used the set before: clearing it frees their captures)
    const old = { capture: prev?.capture, layouts: [] };
    // The revision moves only when a mark does — saving the same stage again keeps every capture
    // current — and never back (a capture of an older stage can never pass for a new one).
    const rev = same(prev, stage) ? prev.rev : (prev?.rev || 0) + 1;
    // (a 3D stage node pinned before nodes said so stays one)
    if (isStageOnly(set)) set.stageNode = true;
    set.stage3d = { ...stage, rev };
    if (!stage.performers.length) {
      for (const s of users)
        if (s.layout) {
          old.layouts.push(s.layout.asset);
          delete s.layout;
        }
    } else {
      const wide =
        replace(old.capture, b.wide, `${set.name} — 3D toàn cảnh`) ||
        (rev === prev?.rev ? old.capture : null);
      if (wide) set.stage3d.capture = wide;
    }
    // Each shot's capture, kept only when it is the framing the server computes for that shot
    // on this stage (the editor and the server share the geometry, so they always agree).
    let kept = 0;
    for (const c of Array.isArray(b.captures) ? b.captures : []) {
      const s = getNode(c?.shotId);
      const st = staging(s);
      if (!st?.spec || st.set !== set || c.key !== layoutSig({ rev: 0 }, st.spec)) continue;
      const asset = replace(s.layout?.asset, c.image, `${s.name} — 3D`);
      if (!asset) continue;
      if (s.layout?.asset && s.layout.asset !== asset) old.layouts.push(s.layout.asset);
      s.layout = { asset, sig: sigOf(st) };
      kept++;
    }
    // The shots whose marks changed (and what was made from them) are out of date — not those
    // that only got a capture of the same marks; a shot that joins the stage gets the band it shows
    // wired in (each with their own reference).
    const { marked, wired } = reconcilePins();
    if (old.capture && set.stage3d.capture !== old.capture) drop(old.capture);
    for (const a of old.layouts) drop(a);
    mutate();
    const now = shotsAt(set.id);
    const state = publicState();
    state.stage3dSummary = {
      performers: stage.performers.length,
      shots: now.length,
      // the shots framed on this stage (an insert of an object is not)
      staged: now.filter(s => staging(s)?.spec).length,
      captures: kept,
      wired,
      stale: marked.length,
    };
    return json(res, 200, state);
  }
  // The captures the browser rendered on its own for shots whose framing has none yet (a shot
  // added, re-imported or edited since the stage was pinned): [{ sig, shotIds, image }] — one
  // picture for every shot of the same framing. Taken only while `sig` is still that shot's
  // framing on the current stage; nothing else changes (no revision bump — a job running now stays
  // current — and nothing goes out of date: the same marks, now also as a picture), so it runs
  // while the queue works.
  if (p === '/api/stage3d/captures' && req.method === 'POST') {
    const b = await body(req);
    if (b.projectId !== activeId) throw new Error('Project đã đổi — tải lại trang.');
    const gone = [];
    let stored = 0;
    for (const c of (Array.isArray(b.captures) ? b.captures : []).slice(0, 200)) {
      let asset = null;
      for (const id of (Array.isArray(c?.shotIds) ? c.shotIds : []).slice(0, 200)) {
        const s = getNode(id);
        const st = staging(s);
        if (!st?.spec || c.sig !== sigOf(st) || s.layout?.sig === c.sig) continue;
        asset ||= replace(s.layout?.asset, c.image, `${s.name} — 3D`);
        if (!asset) break;
        if (s.layout?.asset && s.layout.asset !== asset) gone.push(s.layout.asset);
        s.layout = { asset, sig: c.sig };
        stored++;
      }
    }
    for (const a of gone) drop(a);
    if (stored) save();
    const state = publicState();
    state.stage3dStored = stored;
    return json(res, 200, state);
  }
  // A shot's OWN 3D marks, overriding the scene's shared blocking for just that khung hình. Saving
  // marks sets node.stage3d; clear:true removes it so the shot inherits the scene again. The scene's
  // 3D blocking stays the default for every other shot. No browser capture is stored here — the
  // layout image/video is rendered on request with Topview (it reads these marks via staging()).
  if (p === '/api/stage3d/shot' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const n = getNode(b.shotId);
    if (!isShot(n)) throw new Error('Chỉ dàn dựng 3D riêng trên node khung hình (shot).');
    const old = n.layout?.asset;
    if (b.clear) {
      delete n.stage3d;
    } else {
      const stage = cleanStage(b.stage, id => isCharacter(getNode(id)));
      if (!stage.performers.length)
        throw new Error('Cần ít nhất 1 nhân vật để dàn dựng riêng cho shot (hoặc clear để về theo cảnh).');
      const prev = n.stage3d;
      const rev = same(prev, stage) ? prev.rev : (prev?.rev || 0) + 1;
      n.stage3d = { ...stage, rev };
    }
    // The shot's own marks changed, so its picture/clip is out of date; reconcile ages it and keeps
    // the staleness bookkeeping in step. Drop a layout capture nothing points at any more.
    const { marked } = reconcilePins();
    const st = staging(n);
    if (n.layout && (!st || n.layout.sig !== sigOf(st))) {
      if (old) old && drop(old);
      delete n.layout;
    }
    mutate();
    const state = publicState();
    state.stage3dShot = {
      shotId: n.id,
      override: !!n.stage3d,
      performers: n.stage3d?.performers?.length || 0,
      staged: !!staging(n)?.spec,
      stale: marked.length,
    };
    return json(res, 200, state);
  }
  // Render every staged shot's layout reference with the topview-3d-cli (real posed 3D) instead of
  // the browser's mannequin capture. Fills the same n.layout slot, keyed by the same sig, so the
  // image job and the stage-keeper treat it exactly like a browser capture. Slow: one headless
  // render per shot, so it runs only on request and only while the queue is idle.
  if (p === '/api/stage3d/topview' && req.method === 'POST') {
    requireIdle();
    const r = topviewReady();
    if (!r.ok) throw new Error(r.error || 'topview-3d-cli chưa sẵn sàng.');
    const b = await body(req);
    const set = getNode(b.sceneId);
    if (!isSet(set)) throw new Error('Chỉ dựng layout 3D trên node bối cảnh (cảnh toàn).');
    const shots = (b.shotId ? [getNode(b.shotId)] : shotsAt(set.id)).filter(s => staging(s)?.spec);
    if (!shots.length) throw new Error('Chưa có shot nào được dàn dựng khung hình (cảnh hoặc shot chỉ định).');
    const gone = [];
    const errors = [];
    let done = 0;
    for (const s of shots) {
      const st = staging(s);
      try {
        const png = renderLayout(st);
        const asset = replace(s.layout?.asset, png.base64, `${s.name} — 3D Topview`);
        if (!asset) continue;
        if (s.layout?.asset && s.layout.asset !== asset) gone.push(s.layout.asset);
        s.layout = { asset, sig: sigOf(st) };
        done++;
      } catch (e) {
        errors.push(`${s.name}: ${String(e.message || e).slice(0, 200)}`);
      }
    }
    for (const a of gone) drop(a);
    if (done) save();
    const state = publicState();
    state.topview3d = { done, total: shots.length, errors: errors.slice(0, 10) };
    return json(res, 200, state);
  }
  // Render a 3D PREVIEW VIDEO (camera-move clip) of a staged shot — or, with cluster:true, of every
  // staged shot of the set stitched into one mp4. The clip is stored and attached as the node's
  // video. Slow (one headless render per frame), so it only runs on request while the queue is idle.
  if (p === '/api/stage3d/topview-video' && req.method === 'POST') {
    requireIdle();
    const r = topviewReady();
    if (!r.ok) throw new Error(r.error || 'topview-3d-cli chưa sẵn sàng.');
    const b = await body(req);
    const set = getNode(b.sceneId);
    if (!isSet(set)) throw new Error('Chỉ dựng video 3D trên node bối cảnh (cảnh toàn).');
    const move = CAMERA_MOVE_KEYS.includes(b.move) ? b.move : 'orbit';
    const seconds = Math.max(1, Math.min(6, Number(b.seconds) || 2.5));
    const allStaged = shotsAt(set.id).filter(s => staging(s)?.spec);
    if (!allStaged.length) throw new Error('Set này chưa có shot nào được dàn dựng khung hình.');
    const picks = b.cluster
      ? allStaged
      : b.shotId
        ? [getNode(b.shotId)].filter(s => staging(s)?.spec)
        : [allStaged[0]];
    if (!picks.length) throw new Error('Không tìm thấy shot để render.');
    const clips = [];
    const errors = [];
    const tmp = f => path.join(os.tmpdir(), f);
    try {
      for (const s of picks) {
        try {
          const f = tmp(`tv3dpv-${crypto.randomUUID()}.mp4`);
          renderPreview(staging(s), f, { move, seconds });
          clips.push({ shot: s, file: f });
        } catch (e) {
          errors.push(`${s.name}: ${String(e.message || e).slice(0, 200)}`);
        }
      }
      let out;
      if (b.cluster && clips.length) {
        const comb = tmp(`tv3dpv-cat-${crypto.randomUUID()}.mp4`);
        try {
          stitchPreviews(clips.map(c => c.file), comb);
          const asset = storeAsset({
            mime: 'video/mp4',
            base64: fs.readFileSync(comb).toString('base64'),
            name: `${set.name} — 3D preview cụm (${clips.length} cảnh)`,
          });
          set.video = asset;
          out = { combined: asset.url, clips: clips.length };
        } finally {
          fs.rmSync(comb, { force: true });
        }
      } else {
        for (const c of clips) {
          const asset = storeAsset({
            mime: 'video/mp4',
            base64: fs.readFileSync(c.file).toString('base64'),
            name: `${c.shot.name} — 3D preview`,
          });
          c.shot.video = asset;
          c.shot.videoStale = false;
        }
        out = { clips: clips.map(c => ({ shot: c.shot.name, url: c.shot.video.url })) };
      }
      if (clips.length) save();
      const state = publicState();
      state.topview3dVideo = { move, seconds, ...out, errors: errors.slice(0, 10) };
      return json(res, 200, state);
    } finally {
      for (const c of clips) fs.rmSync(c.file, { force: true });
    }
  }
  // Camera-only 3D preview: a camera move over an EMPTY stage (no people), just to plan the camera
  // trajectory. No marks, no staging — the clip attaches to the chosen node's video. topview has no
  // scene geometry, so this shows the move itself, not the scene content.
  if (p === '/api/stage3d/topview-camera' && req.method === 'POST') {
    requireIdle();
    const r = topviewReady();
    if (!r.ok) throw new Error(r.error || 'topview-3d-cli chưa sẵn sàng.');
    const b = await body(req);
    const n = getNode(b.shotId || b.sceneId);
    if (!n || n.terminal || n.kind === 'setting')
      throw new Error('Cần một node khung hình hoặc bối cảnh để gắn video quỹ đạo máy.');
    const move = CAMERA_MOVE_KEYS.includes(b.move) ? b.move : 'orbit';
    const seconds = Math.max(1, Math.min(6, Number(b.seconds) || 2.5));
    const framing = ['wide', 'medium', 'close'].includes(b.framing) ? b.framing : 'medium';
    const f = path.join(os.tmpdir(), `tv3dcam-${crypto.randomUUID()}.mp4`);
    try {
      renderCameraOnly(f, { move, seconds, framing });
      const asset = storeAsset({
        mime: 'video/mp4',
        base64: fs.readFileSync(f).toString('base64'),
        name: `${n.name} — quỹ đạo máy 3D (${move})`,
      });
      n.video = asset;
      n.videoStale = false;
      save();
      const state = publicState();
      state.topview3dCamera = { nodeId: n.id, move, seconds, framing, url: asset.url };
      return json(res, 200, state);
    } finally {
      fs.rmSync(f, { force: true });
    }
  }
  return NEXT;
}
