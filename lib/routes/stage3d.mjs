// Routes: the 3D stage of a set. Pinning stores every performer's mark on the set (the scene
// node's `stage3d`) and the captures the editor rendered — the front wide and each shot's own
// framing; every shot that uses the set keeps the marks (lib/stage3d.mjs). A shot added or changed
// later gets its capture from the browser on its own (public/js/stage-keeper.js →
// /api/stage3d/captures): the user pins once.
import fs from 'node:fs';
import path from 'node:path';
import { NEXT, body, json } from '../http.mjs';
import { requireIdle } from '../jobs.mjs';
import { storeAsset } from '../media.mjs';
import { getNode, isCharacter, isStageOnly } from '../nodes.mjs';
import { activeId, db, mediaDir, mutate, save } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { isSet, reconcilePins, shotsAt, sigOf, staging } from '../stage3d.mjs';
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
  JSON.stringify({ size: a.size, performers: a.performers }) ===
    JSON.stringify({ size: b.size, performers: b.performers });

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
  return NEXT;
}
