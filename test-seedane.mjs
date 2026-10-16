// Seedane (desktop tool, LAN API) as a generation source: Dola video, Muse image/video.
//
// Always: the request body the app sends (the contract in Seedane's API-SERVER.md) and how a node
// resolves to a Seedane source — pure, no network.
// SEEDANE_LIVE=1: the whole path for REAL against the running Seedane — this app's server, a node
// set to Seedane, POST /v1/jobs, polling, the file downloaded into the node. It spends a real
// Dola render (2.0, 10 s, text-to-video) and asks Muse for one image, so it is not in `npm test`.
// The token comes from MV_SEEDANE_TOKEN or the app's own data dir (seedane-token.txt).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildBody } from './lib/seedane-client.mjs';

// --- the body: Dola video ------------------------------------------------------------------------
const dola = buildBody(
  {
    id: 'j1',
    kind: 'video',
    payload: {
      seedane: { platform: 'dola', model: '2.0', account: '', duration: 8 },
      prompt: 'A lamp glows in a dark hallway.',
      aspectRatio: '9:16',
      count: 2,
    },
  },
  [{ data: 'iVBORw0KGgo', file_name: 'abuela-1234.png' }],
);
assert.deepEqual(dola, {
  platform: 'dola',
  model: '2.0',
  duration_sec: 8, // Seedane rounds up to 10 itself
  count: 2,
  prompt: 'A lamp glows in a dark hallway.',
  aspect_ratio: '9:16',
  reference_images: ['data:image/png;base64,iVBORw0KGgo'],
});
// --- Muse image, a named account, a jpg reference -------------------------------------------------
const muse = buildBody(
  {
    id: 'j2',
    kind: 'image',
    payload: {
      seedane: { platform: 'muse', account: 'Muse #1' },
      prompt: 'Portrait',
      aspectRatio: '16:9',
      count: 3,
    },
  },
  [{ data: '/9j/4AAQ', file_name: 'ref.jpg' }],
);
assert.deepEqual(muse, {
  platform: 'muse',
  kind: 'image',
  prompt: 'Portrait',
  aspect_ratio: '16:9',
  reference_images: ['data:image/jpeg;base64,/9j/4AAQ'],
  account: 'Muse #1',
});
assert.equal('count' in muse, false, 'Muse has no count');
assert.equal('reference_images' in buildBody({ id: 'x', kind: 'video', payload: { seedane: { platform: 'dola' }, prompt: 'p', aspectRatio: '16:9' } }, []), false, 'no refs → text-to-video');

// --- a job made by the real server: a shot with no image goes out without the keyframe sentence ---
// Seedane is pointed at a closed port, so the job is really created and then cannot be delivered.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-seedane-off-'));
  const PORT = 17824;
  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      MV_PORT: String(PORT),
      MV_DATA_DIR: d,
      MV_ORBIT_URL: 'http://127.0.0.1:1',
      MV_SEEDANE_URL: 'http://127.0.0.1:9',
      MV_SEEDANE_TOKEN: 'offline-test-token-123',
    },
    stdio: 'pipe',
  });
  const call = async (p, method = 'GET', b) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  try {
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    let r = await call('/api/nodes', 'POST', { name: 'No-image shot' });
    const id = r.data.nodes.find(n => n.name === 'No-image shot').id;
    await call('/api/node', 'PATCH', {
      id,
      zone: 'production',
      duration: 8,
      videoPrompt: 'A lamp glows in a dark hallway.',
      seedvis: { video: false },
      seedane: { video: { platform: 'dola', model: '2.5' } },
    });
    const node = (await call('/api/state')).data.nodes.find(n => n.id === id);
    assert.equal(node.providers.video.type, 'seedane');
    assert.match(node.resolvedPrompts.video, /^The attached image is the first frame/, 'the preview stays keyframe-style');
    r = await call('/api/jobs', 'POST', { nodeId: id, kind: 'video' });
    assert.ok(r.status < 300, 'Dola films a shot with no image (text-to-video): ' + JSON.stringify(r.data)?.slice(0, 200));
    const job = (await call('/api/state')).data.jobs.find(j => j.nodeId === id);
    assert.ok(job.payload.seedane, 'a Seedane job');
    assert.equal(job.payload.references.length, 0, 'nothing attached');
    assert.ok(!/attached image is the first frame/i.test(job.payload.prompt), 'no keyframe sentence: ' + job.payload.prompt.slice(0, 120));
    assert.match(job.payload.prompt, /A lamp glows in a dark hallway/);
    // the closed port: the job ends "check again", never "failed" (Seedane may have it)
    let j2;
    for (let i = 0; i < 100; i++) {
      j2 = (await call('/api/state')).data.jobs.find(j => j.nodeId === id);
      if (['needs_review', 'failed'].includes(j2.status)) break;
      await new Promise(r2 => setTimeout(r2, 300));
    }
    assert.equal(j2.status, 'needs_review', 'unreachable Seedane → check later: ' + j2.error);
    assert.match(j2.error, /Không kết nối được Seedane/);

    // --- a Seedance group can film on Seedane · Dola instead of Seedvis ------------------------
    // short shots with keyframes → one group → set its source to Dola 2.0 → one Seedane Dola job.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=';
    await call('/api/nodes/delete', 'POST', { id }); // the no-image shot above would otherwise join the group
    for (const s of (await call('/api/state')).data.nodes.filter(n => n.zone === 'production' && !n.terminal)) {
      await call('/api/node', 'PATCH', { id: s.id, duration: 4, videoPrompt: 'Scene ' + s.name });
      await call('/api/upload', 'POST', { nodeId: s.id, kind: 'image', name: 'k.png', mime: 'image/png', base64: png });
    }
    r = await call('/api/seedance/groups', 'POST', { resplit: true });
    const grp = (await call('/api/state')).data.nodes.find(n => n.role === 'seedance');
    assert.ok(grp, 'nhóm Seedance được tạo');
    assert.equal(grp.seedance.source, 'seedvis', 'mặc định nhóm chạy Seedvis');
    // switch the group to Dola 2.0
    await call('/api/node', 'PATCH', {
      id: grp.id,
      seedvis: { video: false },
      seedane: { video: { platform: 'dola', model: '2.0' } },
    });
    const g2 = (await call('/api/state')).data.nodes.find(n => n.id === grp.id);
    assert.equal(g2.seedance.source, 'dola', 'nhóm chuyển sang Dola');
    assert.equal(g2.seedance.dolaModel, '2.0');
    assert.equal(g2.providers.video.type, 'seedane');
    assert.equal(g2.videoRefLimit, 9, 'Dola 2.0 nhận 9 ảnh tham chiếu');
    // the storyboard is composed in the browser; here just give the group an image to stand in
    await call('/api/upload', 'POST', { nodeId: grp.id, kind: 'image', name: 'board.png', mime: 'image/png', base64: png });
    // film the group → a Seedane Dola job carrying the storyboard, the whole-group length
    r = await call('/api/jobs', 'POST', { nodeId: grp.id, kind: 'video' });
    assert.ok(r.status < 300, 'nhóm quay qua Dola: ' + JSON.stringify(r.data)?.slice(0, 200));
    const gjob = (await call('/api/state')).data.jobs.find(j => j.nodeId === grp.id);
    assert.ok(gjob.payload.seedane && gjob.payload.seedane.platform === 'dola', 'job Seedane Dola');
    assert.equal(gjob.payload.seedane.duration, 15, 'độ dài cả nhóm (3×4=12 → bậc Dola 15)');
    assert.ok(gjob.payload.references.length >= 1, 'gửi kèm storyboard + ảnh tham chiếu');
  } finally {
    srv.kill();
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}

if (process.env.SEEDANE_LIVE !== '1') {
  console.log(
    'PASS: Seedane — body Dola/Muse đúng hợp đồng API-SERVER.md; shot chưa có ảnh gửi Dola không kèm câu "ảnh khung đầu"; ' +
      'Seedane không tới được → job chờ kiểm tra lại, không báo hỏng (chạy thật: SEEDANE_LIVE=1)',
  );
  process.exit(0);
}

// --- LIVE ------------------------------------------------------------------------------------------
const token =
  process.env.MV_SEEDANE_TOKEN ||
  fs.readFileSync(path.join(os.homedir(), 'MV-Director-data', 'seedane-token.txt'), 'utf8').trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-seedane-'));
const PORT = 17823;
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: String(PORT), MV_DATA_DIR: dir, MV_ORBIT_URL: 'http://127.0.0.1:1', MV_SEEDANE_TOKEN: '' },
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
const settle = async (test, ms) => {
  for (let i = 0; i < ms / 2000; i++) {
    const v = await test();
    if (v) return v;
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
};
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/state`)).ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  // the token goes in through the app's own route, and the status reads Seedane live
  let r = await api('/api/seedane', 'POST', { url: 'http://127.0.0.1:8787', token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true, 'Seedane health: ' + JSON.stringify(r.data));
  assert.equal(r.data.configured, true);
  assert.ok(r.data.accounts?.dola?.ready > 0, 'Dola có nick sẵn sàng: ' + JSON.stringify(r.data.accounts));
  assert.ok(!JSON.stringify(r.data).includes(token), 'status never echoes the token');
  console.log(`Seedane ${r.data.version} · Dola ${r.data.accounts.dola.ready} nick · Muse ${r.data.accounts.muse.ready} nick`);

  // SEEDANE_ONLY=muse: skip the Dola render (it spends a real Dola run)
  if (process.env.SEEDANE_ONLY !== 'muse') {
  // a shot set to Seedane · Dola 2.0, no image → text-to-video
  r = await api('/api/nodes', 'POST', { name: 'Seedane test shot' });
  const id = r.data.nodes.find(n => n.name === 'Seedane test shot').id;
  await api('/api/node', 'PATCH', {
    id,
    zone: 'production',
    duration: 8,
    videoPrompt:
      'A small warm table lamp glows on a wooden bedside table in a dark bedroom at night; the camera slowly pushes in. No people, no text.',
    seedvis: { video: false },
    seedane: { video: { platform: 'dola', model: '2.0' } },
  });
  let n = (await state()).nodes.find(x => x.id === id);
  assert.equal(n.providers.video.type, 'seedane');
  assert.equal(n.providers.video.platform, 'dola');
  r = await api('/api/jobs', 'POST', { nodeId: id, kind: 'video' });
  assert.ok(r.status < 300, 'job nhận: ' + JSON.stringify(r.data)?.slice(0, 300));
  const jobId = r.data.job?.id || (await state()).jobs.find(j => j.nodeId === id)?.id;
  const done = await settle(async () => {
    const j = (await state()).jobs.find(x => x.id === jobId);
    if (j?.progress) process.stdout.write(`\r  ${j.status} · ${String(j.progress).slice(0, 90).padEnd(90)}`);
    return ['completed', 'failed', 'needs_review'].includes(j?.status) ? j : null;
  }, 25 * 60 * 1000);
  process.stdout.write('\n');
  assert.ok(done, 'Dola xong trong 25 phút');
  assert.equal(done.status, 'completed', 'Dola: ' + done.error);
  assert.ok(done.seedaneId?.startsWith('seedane-'), 'mã job Seedane lưu trên job');
  const st = await state();
  const clip = st.nodes.find(x => x.terminal && x.source === id && x.video);
  assert.ok(clip, 'video về thành node trong cột Video');
  const bytes = fs.statSync(path.join(dir, 'projects', st.activeProjectId, 'media', clip.video.id)).size;
  assert.ok(bytes > 10000, 'file video thật: ' + bytes + ' bytes');
  console.log(`PASS live Dola: ${clip.video.name} · ${(bytes / 1048576).toFixed(1)} MB · ${done.payload.website}`);
  }

  // Muse image through Seedane: done if a Muse nick is logged in there, else a clear failure
  r = await api('/api/nodes', 'POST', { kind: 'character', name: 'Seedane Muse test' });
  const cid = r.data.nodes.find(x => x.name === 'Seedane Muse test').id;
  await api('/api/node', 'PATCH', {
    id: cid,
    desc: 'An elderly woman with silver hair in a cream cardigan, fictional character',
    seedvis: { image: false },
    seedane: { image: { platform: 'muse' } },
  });
  r = await api('/api/jobs', 'POST', { nodeId: cid, kind: 'image' });
  assert.ok(r.status < 300, JSON.stringify(r.data)?.slice(0, 300));
  const mj = await settle(async () => {
    const j = (await state()).jobs.find(x => x.nodeId === cid);
    return ['completed', 'failed', 'needs_review'].includes(j?.status) ? j : null;
  }, 10 * 60 * 1000);
  assert.ok(mj, 'Muse trả lời');
  if (mj.status === 'completed') {
    const st2 = await state();
    const img = st2.nodes.find(x => x.id === cid).image;
    assert.ok(img, 'ảnh Muse vào node');
    const file = path.join(dir, 'projects', st2.activeProjectId, 'media', img.id);
    const size = fs.statSync(file).size;
    assert.ok(size > 5000, 'file ảnh thật: ' + size + ' bytes');
    if (process.env.SEEDANE_KEEP) fs.copyFileSync(file, path.join(process.env.SEEDANE_KEEP, 'muse-' + img.id));
    console.log(`PASS live Muse: ảnh về node · ${img.mime || ''} · ${(size / 1024).toFixed(0)} KB · ${mj.payload.website} · ${mj.seedaneId}`);
  } else {
    assert.match(mj.error, /Seedane/, 'lỗi nói rõ là từ Seedane: ' + mj.error);
    if (process.env.SEEDANE_ONLY === 'muse') assert.fail('Muse không ra ảnh: ' + mj.error);
    console.log('Muse chưa chạy được (đúng nếu Seedane chưa có nick Muse): ' + mj.error);
  }
} finally {
  proc.kill();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
