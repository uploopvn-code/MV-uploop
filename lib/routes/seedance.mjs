// Routes: Seedance groups (several shots filmed in one Seedance render).
import { NEXT, body, json } from '../http.mjs';
import { requireIdle } from '../jobs.mjs';
import { mutate } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { isGroup, makeGroups } from '../seedance.mjs';
import { startAutoVideoRun, uncertainJobs } from '../auto.mjs';
import { seedvis } from '../config.mjs';
import { getNode } from '../nodes.mjs';

export async function handle(req, res, p, u) {
  // Splits the shots that are in no group yet into groups (≤ the model's longest render, one
  // location, within its image limit). Change a group afterwards by wiring shots in or out.
  if (p === '/api/seedance/groups' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const created = makeGroups(b.model);
    mutate();
    return json(res, 200, { ...publicState(), created });
  }
  // A group render Seedvis may already have made (timed out, the app restarted, a lost
  // reply): check it again for free — or re-send it under its own key — before any new render.
  if (p === '/api/seedance/recheck' && req.method === 'POST') {
    requireIdle();
    if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
    const g = getNode((await body(req)).id);
    if (!isGroup(g)) throw new Error('Không phải nhóm Seedance.');
    const jobs = uncertainJobs(g);
    if (!jobs.length) throw new Error('Nhóm không có tác vụ nào chờ kiểm tra.');
    startAutoVideoRun(
      req,
      [],
      1,
      `Kiểm tra lại ${jobs.length} tác vụ của ${g.name} với Seedvis (có thể đã làm xong, không tạo trùng)`,
      jobs,
    );
    return json(res, 200, publicState());
  }
  return NEXT;
}
