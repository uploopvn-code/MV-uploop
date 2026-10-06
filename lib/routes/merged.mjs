// Routes: merged scenes (2–3 camera setups of one conversation filmed as one Veo clip).
import { NEXT, body, json } from '../http.mjs';
import { requireIdle } from '../jobs.mjs';
import { publicState } from '../public-state.mjs';
import { FRAMINGS, frameCast, frames, isMerged } from '../merged.mjs';
import { startAutoVideoRun, uncertainJobs } from '../auto.mjs';
import { seedvis } from '../config.mjs';
import { getNode, isSetting } from '../nodes.mjs';
import { db, mutate } from '../projects.mjs';
import { flagClips, markStale } from '../staleness.mjs';

export async function handle(req, res, p) {
  // A render Seedvis may already have made (timed out, the app restarted, a lost reply):
  // check it again for free — or re-send it under its own key — before any new render.
  if (p === '/api/merged/recheck' && req.method === 'POST') {
    requireIdle();
    if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
    const m = getNode((await body(req)).id);
    if (!isMerged(m)) throw new Error('Không phải phân cảnh ghép.');
    const jobs = uncertainJobs(m);
    if (!jobs.length) throw new Error('Phân cảnh ghép không có tác vụ nào chờ kiểm tra.');
    startAutoVideoRun(
      req,
      [],
      1,
      `Kiểm tra lại ${jobs.length} tác vụ của ${m.name} với Seedvis (có thể đã làm xong, không tạo trùng)`,
      jobs,
    );
    return json(res, 200, publicState());
  }
  // The 2D staging editor saves a whole scene at once: which person is on the left/right (the
  // edge order into every frame), each frame's camera framing, the location's staging text, and
  // the marker layout. The prompt is not written here — framePrompt()/mergedPrompt() rebuild it
  // live from these fields; we only mark what changed stale so the user re-renders the stills.
  if (p === '/api/merged/staging' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const m = getNode(b.id);
    if (!isMerged(m)) throw new Error('Không phải phân cảnh ghép.');
    const list = frames(m);
    if (list.length < 2) throw new Error('Phân cảnh ghép cần ít nhất 2 khung để dàn dựng.');
    const base = frameCast(list[0]);
    const place = base.place;
    const str = (v, n = 500) => String(v ?? '').slice(0, n);

    // sides: rebuild the [place, left, right] image edges of every frame in the chosen order,
    // keeping the 180-degree axis identical across all frames. Must be the scene's two people.
    let sidesChanged = false;
    if (b.sides && b.sides.left && b.sides.right) {
      const people = new Set([base.left?.node.id, base.right?.node.id].filter(Boolean));
      if (b.sides.left === b.sides.right || !people.has(b.sides.left) || !people.has(b.sides.right))
        throw new Error('Trái/phải phải là đúng hai nhân vật của cảnh.');
      sidesChanged = base.left?.node.id !== b.sides.left;
      if (sidesChanged)
        for (const f of list) {
          const fc = frameCast(f);
          if (!fc.place) continue;
          const order = [fc.place.id, b.sides.left, b.sides.right];
          // keep any setting edges into the frame; replace the image edges in the new order
          const others = db.edges.filter(e => e.target !== f.id || isSetting(getNode(e.source)));
          db.edges = [...others, ...order.map(source => ({ source, target: f.id }))];
        }
    }

    // per-frame camera framing (ots_a / ots_b / two_shot)
    const want = new Map((Array.isArray(b.frames) ? b.frames : []).map(x => [x.id, x.framing]));
    const framingChanged = new Set();
    for (const f of list) {
      const fr = want.get(f.id);
      if (fr && FRAMINGS.includes(fr) && fr !== f.framing) {
        f.framing = fr;
        framingChanged.add(f.id);
      }
    }

    // location staging text, stored on the scene (place) node
    let stagingChanged = false;
    if (b.staging && place) {
      const side = x => ({
        anchor: str(x?.anchor),
        background: str(x?.background),
        light: str(x?.light),
      });
      const next = {
        place: str(b.staging.place),
        two_shot: str(b.staging.two_shot),
        left: side(b.staging.left),
        right: side(b.staging.right),
      };
      stagingChanged = JSON.stringify(next) !== JSON.stringify(place.staging || null);
      if (stagingChanged) place.staging = next;
    }

    // marker layout — only for redrawing the editor, never read by the prompt
    if (b.blocking && typeof b.blocking === 'object') {
      const pt = p => (p && typeof p === 'object' ? { x: clamp01(p.x), y: clamp01(p.y) } : null);
      m.blocking = { left: pt(b.blocking.left), right: pt(b.blocking.right) };
    }

    // A still's prompt changes when sides or the staging text change (whole scene) or when a
    // frame's own framing changes (that frame). Mark those stills stale and the clip out of date.
    for (const f of list)
      if (sidesChanged || stagingChanged || framingChanged.has(f.id)) markStale(f);
    if (sidesChanged || stagingChanged || framingChanged.size) flagClips(m);
    mutate();
    return json(res, 200, publicState());
  }
  return NEXT;
}
const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0));
