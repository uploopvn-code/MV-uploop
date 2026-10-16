// DNA giọng nói: sáu thành phần trên node nhân vật ghép thành câu "Voice lock" mà MỌI đường
// render đọc — shot thường, phân cảnh ghép và nhóm Seedance. Không có nó thì mỗi lần render
// model tự nghĩ một giọng khác, và giọng nhân vật không đồng nhất giữa các clip.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { voiceOf } from './director.mjs';

// Hàm ghép là thuần: kiểm trực tiếp.
assert.equal(
  voiceOf({
    gender: 'Male',
    age_sound: 'Late 30s',
    timbre: 'low and dry',
    accent: 'Saigon',
    pacing: 'slow',
    emotional_baseline: 'controlled irritation',
  }),
  'Male, Late 30s; timbre: low and dry; accent: Saigon; pacing: slow; baseline: controlled irritation',
  'sáu thành phần ghép đúng khuôn của import',
);
assert.equal(voiceOf({}), '', 'rỗng thì không ghép ra gì');
assert.equal(voiceOf('Male, gravelly'), 'Male, gravelly', 'chuỗi tự viết giữ nguyên');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-voice-'));
const PORT = 17802;
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

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  let st = (await api('/api/state')).data;
  const singer = st.nodes.find(n => n.role === 'character' || n.zone === 'character');
  assert.ok(singer, 'project mẫu có nhân vật');
  const shot = st.nodes.find(n => 'duration' in n && !n.terminal);
  assert.ok(shot, 'và có shot');

  // Nối nhân vật vào shot — khoá giọng chỉ gắn cho shot mà nhân vật đó có mặt.
  let r0 = await api('/api/edges', 'PUT', {
    edges: st.edges.concat([{ source: singer.id, target: shot.id }]),
  });
  assert.equal(r0.status, 200, JSON.stringify(r0.data));
  st = r0.data;

  // Chưa có DNA giọng → không có khoá giọng nào trong prompt video.
  assert.ok(
    !/Voice lock/.test(st.nodes.find(n => n.id === shot.id).resolvedPrompts.video || ''),
    'chưa gắn DNA thì không có Voice lock',
  );

  // Gắn DNA giọng bằng sáu thành phần.
  let r = await api('/api/node', 'PATCH', {
    id: singer.id,
    code: 'NV1',
    voiceProfile: {
      gender: 'Female',
      age_sound: 'Early 30s',
      timbre: 'bright, a little brittle',
      accent: 'Southern Vietnamese (Saigon)',
      pacing: 'quick when deflecting',
      emotional_baseline: 'defensive cheerfulness',
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const saved = r.data.nodes.find(n => n.id === singer.id);
  assert.equal(saved.voiceProfile.timbre, 'bright, a little brittle', 'giữ bản có cấu trúc để sửa');
  assert.match(
    saved.voice,
    /^Female, Early 30s; timbre: bright, a little brittle; accent: Southern Vietnamese \(Saigon\); pacing: quick when deflecting; baseline: defensive cheerfulness$/,
    'ghép thành chuỗi khoá giọng',
  );

  // Khoá giọng phải xuất hiện trong prompt video của shot nhân vật này nói.
  r = await api('/api/node', 'PATCH', { id: shot.id, lyric: 'NV1: "Em về rồi."' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const withVoice = r.data.nodes.find(n => n.id === shot.id).resolvedPrompts.video;
  assert.match(
    withVoice,
    /Voice lock for NV1: Female, Early 30s; timbre: bright/,
    'shot có khoá giọng',
  );

  // Sửa một thành phần → chuỗi khoá đổi theo (đồng nhất ở mọi clip sau đó).
  r = await api('/api/node', 'PATCH', {
    id: singer.id,
    voiceProfile: { ...saved.voiceProfile, timbre: 'warm and low' },
  });
  assert.match(
    r.data.nodes.find(n => n.id === singer.id).voice,
    /timbre: warm and low/,
    'sửa một thành phần thì khoá giọng đổi theo',
  );

  // Tự viết cả câu thì nó thắng sáu ô.
  r = await api('/api/node', 'PATCH', { id: singer.id, voice: 'Female, husky, almost a whisper' });
  assert.equal(
    r.data.nodes.find(n => n.id === singer.id).voice,
    'Female, husky, almost a whisper',
    'chuỗi tự viết thắng',
  );
  assert.match(
    r.data.nodes.find(n => n.id === shot.id).resolvedPrompts.video,
    /Voice lock for NV1: Female, husky, almost a whisper\./,
    'và prompt dùng đúng chuỗi tự viết',
  );

  // Xuất Bible giữ được DNA để import lại không mất.
  const ex = await api('/api/export');
  assert.equal(ex.status, 200);
  const ch = (ex.data.bible.assets || []).find(a => a.key && a.role === 'character');
  assert.ok(ch && ch.voice_profile, 'Bible xuất ra mang theo voice_profile');

  console.log(
    'PASS: DNA giọng nói — ghép sáu thành phần đúng khuôn, lưu cả bản cấu trúc lẫn chuỗi, khoá giọng vào prompt video của shot, sửa một thành phần thì khoá đổi theo, chuỗi tự viết thắng, và Bible xuất ra giữ được DNA',
  );
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
