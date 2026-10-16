// Khuôn hình của project: MỘT cài đặt áp cho mọi ảnh và video — tham số gửi model LẪN nội dung
// prompt. Trước đây '16:9' bị ghi cứng ở 4 chỗ (seedvis mặc định, payload job của từng worker,
// node nhóm Seedance, và trong câu prompt), nên một phim dọc vẫn ra ảnh ngang.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-aspect-'));
const PORT = 17801;
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    MV_PORT: String(PORT),
    MV_ORBIT_URL: 'http://127.0.0.1:1',
    MV_DATA_DIR: dir,
  },
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

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }

  // Mặc định là 16:9 ngang.
  let st = await state();
  const shot = st.nodes.find(n => 'duration' in n && !n.terminal);
  assert.ok(shot, 'project mẫu có shot');
  assert.match(shot.resolvedPrompts.image, /16:9 horizontal/, 'prompt mặc định là 16:9 ngang');

  // Một node tự chọn model Seedvis → mang aspectRatio riêng; đây chính là chỗ từng lệch.
  let r = await api('/api/node', 'PATCH', {
    id: shot.id,
    seedvis: { image: { model: 'GEM_PIX_2', aspectRatio: '16:9', upscale: 'none' } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(
    r.data.nodes.find(n => n.id === shot.id).seedvis.image.aspectRatio,
    '16:9',
    'node giữ lựa chọn riêng',
  );

  // Đổi khuôn hình project sang dọc.
  r = await api('/api/project', 'PATCH', { defaults: { aspect: '9:16' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = r.data;
  assert.equal(st.defaults.aspect, '9:16', 'project nhớ khuôn hình');

  // 1) Node đã có lựa chọn riêng PHẢI đi theo — nếu không thì vẫn lệch như cũ.
  assert.equal(
    st.nodes.find(n => n.id === shot.id).seedvis.image.aspectRatio,
    '9:16',
    'node có binding riêng cũng được cập nhật theo project',
  );
  // 2) Ảnh/video đã tạo thuộc khuôn cũ → phải bị đánh dấu làm lại.
  const withMedia = st.nodes.filter(n => !n.terminal && (n.image || n.video));
  assert.ok(
    withMedia.every(n => n.stale),
    'media khuôn cũ bị đánh dấu cần làm lại',
  );
  // 3) Nội dung prompt cũng đổi theo, không chỉ tham số gửi model.
  const after = st.nodes.find(n => n.id === shot.id);
  assert.match(after.resolvedPrompts.image, /9:16 vertical/, 'prompt nói 9:16 dọc');
  assert.ok(!/16:9/.test(after.resolvedPrompts.image), 'không còn 16:9 sót trong prompt');

  // 4) Node tạo MỚI sau khi đổi cũng theo khuôn mới.
  r = await api('/api/nodes', 'POST', { role: 'character', name: 'NV mới' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const fresh = r.data.nodes.at(-1);
  assert.equal(fresh.providers.image.aspectRatio ?? '9:16', '9:16', 'node mới theo khuôn project');

  // 5) Tỉ lệ lạ bị bỏ qua, không làm hỏng cài đặt.
  r = await api('/api/project', 'PATCH', { defaults: { aspect: '7:3' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.defaults.aspect, '9:16', 'tỉ lệ không hợp lệ bị bỏ qua');

  // 6) Quay lại 16:9 thì prompt cũng quay lại.
  r = await api('/api/project', 'PATCH', { defaults: { aspect: '16:9' } });
  assert.match(
    r.data.nodes.find(n => n.id === shot.id).resolvedPrompts.image,
    /16:9 horizontal/,
    'đổi lại thì prompt theo ngay',
  );

  console.log(
    'PASS: khuôn hình project — mặc định 16:9, đổi sang 9:16 thì node có binding riêng cũng theo, media khuôn cũ bị đánh dấu làm lại, nội dung prompt đổi theo (không sót 16:9), node mới kế thừa, tỉ lệ không hợp lệ bị bỏ qua, đổi lại áp ngay',
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
