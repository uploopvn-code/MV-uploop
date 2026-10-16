// "Dùng ảnh hiện tại": chấp nhận ảnh đã cũ của shot để dựng storyboard mà không render lại.
// Nhóm Seedance báo đúng shot nào chặn (chưa có ảnh / ảnh cũ) để UI mở thẳng và cho ép dùng ảnh.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-keep-'));
const PORT = 17829;
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: String(PORT), MV_ORBIT_URL: 'http://127.0.0.1:1', MV_DATA_DIR: dir },
  stdio: 'pipe',
});
const api = async (p, method = 'GET', b) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const state = async () => (await api('/api/state')).data;
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=';
const up = async id => (await api('/api/upload', 'POST', { nodeId: id, mime: 'image/png', base64: PNG })).data;
const mk = async (name, patch = {}, kind) => {
  const s = await api('/api/nodes', 'POST', { name, kind });
  const id = s.data.nodes.find(n => n.name === name).id;
  if (Object.keys(patch).length) await api('/api/node', 'PATCH', { id, ...patch });
  return id;
};

try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  // drop the template production shots so the group is only ours
  for (const s of (await state()).nodes.filter(n => n.zone === 'production' && !n.terminal))
    await api('/api/node', 'PATCH', { id: s.id, duration: 4 }), await up(s.id);

  // a character + two shots wired to it, each with its own keyframe
  const c = await mk('Nhân vật', {}, 'character');
  await up(c);
  const shots = [];
  for (let i = 1; i <= 2; i++) {
    const s = await mk('Shot ' + i, { zone: 'production', duration: 4 });
    const st = await state();
    await api('/api/edges', 'PUT', { edges: [...st.edges, { source: c, target: s }] });
    await up(s);
    shots.push(s);
  }
  // re-render the character → every shot wired to it goes stale
  await up(c);
  let st = await state();
  assert.ok(
    shots.every(id => st.nodes.find(n => n.id === id).stale),
    'cả hai shot thành ảnh cũ sau khi đổi nhân vật',
  );

  await api('/api/seedance/groups', 'POST', { resplit: true });
  let g = (await state()).nodes.find(n => n.role === 'seedance');
  assert.ok(g, 'nhóm Seedance được tạo');
  // the group lists the blocking shots: ours are stale (have an image), the template shots missing
  const staleIds = g.seedance.staleShots.map(s => s.id);
  assert.ok(
    shots.every(id => staleIds.includes(id)),
    'nhóm chỉ ra đúng các shot ảnh cũ: ' + JSON.stringify(g.seedance.staleShots),
  );
  assert.match(g.seedance.problem, /ảnh đã cũ|chưa có ảnh/, 'có thông báo chặn');

  // keep the current images (no re-render): the stale flag is cleared
  const r = await api('/api/node/keep-image', 'POST', { ids: shots });
  assert.equal(r.status, 200, JSON.stringify(r.data)?.slice(0, 150));
  st = await state();
  assert.ok(
    shots.every(id => !st.nodes.find(n => n.id === id).stale),
    'ép dùng ảnh hiện tại → hết cờ ảnh cũ',
  );
  g = st.nodes.find(n => n.role === g.id || n.id === g.id);
  assert.deepEqual(g.seedance.staleShots, [], 'nhóm không còn shot ảnh cũ');
  // the two shots no longer block; only the template shots (truly imageless) remain, if any
  assert.ok(
    !g.seedance.staleShots.length,
    'storyboard không còn bị chặn bởi ảnh cũ',
  );

  // keeping a node that is not stale is refused (nothing to keep)
  assert.equal((await api('/api/node/keep-image', 'POST', { ids: shots })).status, 400);

  console.log(
    'PASS: nhóm Seedance chỉ đúng shot chặn (ảnh cũ / chưa có ảnh); "Dùng ảnh hiện tại" gỡ cờ ảnh cũ ' +
      'để dựng storyboard mà không render lại',
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
