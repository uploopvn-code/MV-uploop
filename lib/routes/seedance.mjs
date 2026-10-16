// Routes: Seedance groups (several shots filmed in one Seedance render).
import { NEXT, body, json } from '../http.mjs';
import { requireIdle } from '../jobs.mjs';
import { mutate } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { isGroup, makeGroups, resplitGroups } from '../seedance.mjs';
import { startAutoVideoRun, uncertainJobs } from '../auto.mjs';
import { seedane, seedvis } from '../config.mjs';
import { getNode } from '../nodes.mjs';

export async function handle(req, res, p, u) {
  // Splits the shots that are in no group yet into groups (≤ the model's longest render, within
  // its image limit; several scenes may share one render). Change a group afterwards by wiring
  // shots in or out. With { resplit: true }, first drops the groups no render was spent on yet,
  // so the whole timeline is re-split under the current algorithm (rendered groups are kept).
  if (p === '/api/seedance/groups' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const created = b.resplit ? resplitGroups(b.model) : makeGroups(b.model);
    mutate();
    return json(res, 200, { ...publicState(), created });
  }
  // A group render Seedvis may already have made (timed out, the app restarted, a lost
  // reply): check it again for free — or re-send it under its own key — before any new render.
  if (p === '/api/seedance/recheck' && req.method === 'POST') {
    requireIdle();
    const g = getNode((await body(req)).id);
    if (!isGroup(g)) throw new Error('Không phải nhóm Seedance.');
    const jobs = uncertainJobs(g);
    if (!jobs.length) throw new Error('Nhóm không có tác vụ nào chờ kiểm tra.');
    // Only the generator whose jobs are being re-checked needs to be configured.
    if (jobs.some(j => j.payload?.seedvis) && !seedvis.configured())
      throw new Error('Nhập API key Seedvis trong Kết nối web.');
    if (jobs.some(j => j.payload?.seedane) && !seedane.configured())
      throw new Error('Nhập token Seedane trong Kết nối web → Seedane.');
    const where = jobs.some(j => j.payload?.seedane) ? 'Seedane' : 'Seedvis';
    startAutoVideoRun(
      req,
      [],
      1,
      `Kiểm tra lại ${jobs.length} tác vụ của ${g.name} với ${where} (có thể đã làm xong, không tạo trùng)`,
      jobs,
    );
    return json(res, 200, publicState());
  }
  return NEXT;
}
