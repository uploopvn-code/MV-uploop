// Topview 3D layout backend. Renders a staged shot's blocking as a real posed 3D frame with the
// topview-3d-cli (tools/topview-3d-builder), to use in place of the browser's mannequin capture as
// the shot's layout reference (lib/stage3d.mjs: n.layout). It never becomes the final keyframe: the
// image model still paints identity from the character sheets; this only pins where each performer
// stands, which way they face and the camera angle — the same role the stage-keeper capture plays.
//
// Coordinates match stage-math.js: x right, z toward the audience, y up, metres; a performer's
// `facing` (degrees, 0 = toward the audience, +90 = screen right) maps to rotation.y in radians with
// the same sign (verified against a real render).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNode, isCharacter } from './nodes.mjs';
import { shotCamera } from '../public/js/stage-math.js';

// The CLI the installer drops into a shared venv (scripts/install.ps1). Override with TOPVIEW3D_CLI.
function cliPath() {
  if (process.env.TOPVIEW3D_CLI) return process.env.TOPVIEW3D_CLI;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const win = path.join(local, 'topview-3d-cli', 'venv', 'Scripts', 'topview-3d-cli.exe');
  if (fs.existsSync(win)) return win;
  const posix = path.join(
    os.homedir(), '.local', 'share', 'topview-3d-cli', 'venv', 'bin', 'topview-3d-cli',
  );
  if (fs.existsSync(posix)) return posix;
  return 'topview-3d-cli'; // hope it is on PATH
}

// The four built-in mannequins (asset list --kind character). We only need a body of the right
// rough age/gender; identity comes from the image model, not from these.
const LIB = {
  man: 'a3d_char_7d220ac359844c80a8faaf0e25478477',
  female: 'a3d_char_30ec53c93eae4173946b38639691ebe0',
  child: 'a3d_char_461b4f4b76ae4b198f439fa4f6f743b6',
  youth: 'a3d_char_de37873a79244fbe8a0660ea08d1b4ab',
};
const STAND = 'a3d_pose_stand-arms-down';

// Which mannequin stands in for a character node: an explicit override wins, else a guess from the
// voice profile (gender + age) and the name.
export function libraryFor(node) {
  const o = node?.topview3d?.libraryId;
  if (o && Object.values(LIB).includes(o)) return o;
  const vp = node?.voiceProfile || {};
  const hay = `${vp.gender || ''} ${vp.age_sound || ''} ${node?.name || ''} ${node?.voice || ''}`.toLowerCase();
  if (/child|kid|\bbé\b|\b[1-9] (year|tuổi)|\b1[0-2] (year|tuổi)/.test(hay)) return LIB.child;
  if (/teen|youth|thiếu niên|adolesc|1[3-9] (year|tuổi)/.test(hay)) return LIB.youth;
  if (/\bmale\b|\bman\b|nam\b|ông|bố|cha/.test(hay) && !/female|woman/.test(hay)) return LIB.man;
  return LIB.female; // woman / elderly / unknown
}

const rad = deg => (Number(deg) || 0) * Math.PI / 180;
// PYTHONUTF8 forces the CLI to print its JSON as UTF-8: without it the Python process uses the
// Windows console codepage (cp1252) and crashes the moment the scene echoes a non-Latin-1 name —
// e.g. a Vietnamese character name like "Bé Mai" — in its output.
const CLI_ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const run = (cli, args, cwd) =>
  JSON.parse(
    execFileSync(cli, args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024, env: CLI_ENV }),
  );

let cachedReady = null; // { ok, error }
// Whether the CLI is installed and its doctor passes. Cached for the process; pass force to recheck.
export function ready(force = false) {
  if (cachedReady && !force) return cachedReady;
  const cli = cliPath();
  try {
    const r = run(cli, ['doctor', '--json']);
    cachedReady = r?.ok ? { ok: true } : { ok: false, error: 'doctor: not ready' };
  } catch (e) {
    cachedReady = { ok: false, error: `topview-3d-cli không chạy được: ${e.message}` };
  }
  return cachedReady;
}

// Build the scene changes for a stage (performers → mannequins) and one camera from the shot's
// framing. Returns { scene, pose, render, camId }.
function specs(stage, spec) {
  const cam = shotCamera(stage, spec); // { pos:[x,y,z], target:[x,y,z], fov, aspect }
  const changes = [];
  const poses = [];
  for (const [i, p] of stage.performers.entries()) {
    const node = getNode(p.id);
    if (!node || !isCharacter(node)) continue;
    const nodeId = `p${i}`;
    changes.push({
      action: 'add_library',
      nodeId,
      kind: 'characters',
      libraryId: libraryFor(node),
      name: (node.code || node.name || nodeId).slice(0, 120),
      position: { x: p.x, y: 0, z: p.z },
      rotation: { x: 0, y: rad(p.facing), z: 0 },
    });
    poses.push({ nodeId, poseId: STAND }); // v1: stand only; identity/pose detail come from the image model
  }
  const camId = 'cam';
  changes.push({
    action: 'add_camera',
    nodeId: camId,
    presetId: 'front-medium',
    name: 'Layout',
    fov: Math.max(12, Math.min(120, cam.fov || 40)),
    view: {
      mode: 'world',
      position: { x: cam.pos[0], y: cam.pos[1], z: cam.pos[2] },
      target: { x: cam.target[0], y: cam.target[1], z: cam.target[2] },
    },
  });
  return {
    scene: { changes },
    pose: { items: poses },
    render: { frames: [0], width: 768, height: 432, cameraNodeId: camId },
    camId,
    cam,
  };
}

// Build the throwaway topview project for a staged shot: init, place the mannequins, pose them, and
// add the base camera at the shot's framing. Returns the cli, the project dir, the base camera
// (pos/target/fov) and the camera node id. The caller renders and then removes the dir.
function buildProject(st) {
  if (!st?.spec || !st.stage?.performers?.length)
    throw new Error('Shot này không có khung dàn dựng để render.');
  const cli = cliPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv3d-'));
  const write = (name, data) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(data));
    return f;
  };
  const { scene, pose, camId, cam } = specs(st.stage, st.spec);
  run(cli, ['project', 'init', dir, '--force']);
  run(cli, ['node', 'batch', dir, write('scene.json', scene)]);
  if (pose.items.length) run(cli, ['pose', 'batch', dir, write('pose.json', pose)]);
  return { cli, dir, write, camId, cam };
}

// Render the 3D blocking of one staged shot. `st` is lib/stage3d.mjs staging(n); returns a PNG
// { mime, base64 } or throws.
export function renderLayout(st) {
  const { cli, dir, write, camId } = buildProject(st);
  try {
    const res = run(cli, [
      'render', dir, write('render.json', { frames: [0], width: 768, height: 432, cameraNodeId: camId }),
    ]);
    const framePath = res?.result?.frames?.[0]?.path;
    if (!framePath || !fs.existsSync(framePath))
      throw new Error('render không trả về khung hình.');
    return { mime: 'image/png', base64: fs.readFileSync(framePath).toString('base64') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Camera-move presets (3D preview video) -----------------------------------------------------
// topview has static camera presets only, so a move is just the base camera (the shot's framing)
// sampled along a path. Each preset maps t in [0,1] → a world camera { position, target }, animating
// around the base view `c` = { pos:[x,y,z], target:[x,y,z], fov }. The director picks one per scene.
const V = (a) => ({ x: a[0], y: a[1], z: a[2] });
const lerp = (a, b, t) => a + (b - a) * t;
export const CAMERA_MOVES = {
  // slow arc around the subjects, keeping them centred — the classic "turntable" previz look
  orbit: { name: 'Orbit quanh cảnh', fn: (c, t) => orbitPos(c, (t - 0.5) * 70) },
  arc_left: { name: 'Lia vòng sang trái', fn: (c, t) => orbitPos(c, lerp(0, -55, t)) },
  arc_right: { name: 'Lia vòng sang phải', fn: (c, t) => orbitPos(c, lerp(0, 55, t)) },
  dolly_in: { name: 'Dolly tiến vào', fn: (c, t) => towardTarget(c, lerp(1, 0.55, t)) },
  pull_back: { name: 'Kéo lùi mở rộng', fn: (c, t) => towardTarget(c, lerp(0.7, 1.15, t)) },
  push_in: { name: 'Đẩy nhẹ vào mặt', fn: (c, t) => towardTarget(c, lerp(1, 0.78, t)) },
  crane_up: { name: 'Cẩu nâng lên', fn: (c, t) => ({ position: { x: c.pos[0], y: c.pos[1] + lerp(0, 1.4, t), z: c.pos[2] }, target: V(c.target) }) },
  reveal: { name: 'Mở cảnh (lùi + nâng)', fn: (c, t) => raised(towardTarget(c, lerp(0.8, 1.15, t)), lerp(0, 0.9, t)) },
};
export const CAMERA_MOVE_KEYS = Object.keys(CAMERA_MOVES);
function orbitPos(c, deg) {
  const T = c.target, P = c.pos;
  const vx = P[0] - T[0], vz = P[2] - T[2];
  const r = Math.hypot(vx, vz) || 0.01;
  const a0 = Math.atan2(vx, vz);
  const a = a0 + rad(deg);
  return { position: { x: T[0] + r * Math.sin(a), y: P[1], z: T[2] + r * Math.cos(a) }, target: V(T) };
}
function towardTarget(c, s) {
  const T = c.target, P = c.pos;
  return { position: { x: T[0] + (P[0] - T[0]) * s, y: T[1] + (P[1] - T[1]) * s, z: T[2] + (P[2] - T[2]) * s }, target: V(T) };
}
const raised = (m, dy) => ({ position: { ...m.position, y: m.position.y + dy }, target: m.target });

// Render a short 3D preview CLIP of one staged shot: the camera follows `move` (a CAMERA_MOVES key)
// around the shot's framing. Writes an mp4 to `outFile` with ffmpeg. Returns { file, frames, seconds }.
// Per-frame render (~1.4 s/frame) is slow but needs no motion assets and reuses the exact framing.
export function renderPreview(st, outFile, { move = 'orbit', seconds = 2.5, fps = 12, width = 640 } = {}) {
  const preset = CAMERA_MOVES[move] || CAMERA_MOVES.orbit;
  const height = Math.round((width * 9) / 16);
  const n = Math.max(2, Math.min(96, Math.round(seconds * fps)));
  const { cli, dir, write, camId, cam } = buildProject(st);
  const seq = fs.mkdtempSync(path.join(os.tmpdir(), 'tv3dseq-'));
  try {
    for (let i = 0; i < n; i++) {
      const view = preset.fn(cam, n === 1 ? 0 : i / (n - 1)) || orbitPos(cam, 0);
      run(cli, ['node', 'batch', dir, write('upd.json', {
        changes: [{ action: 'update', nodeId: camId, view: { mode: 'world', ...view } }],
      })]);
      const res = run(cli, ['render', dir, write('r.json', { frames: [0], width, height, cameraNodeId: camId })]);
      const fp = res?.result?.frames?.[0]?.path;
      if (!fp || !fs.existsSync(fp)) throw new Error('render không trả về khung hình.');
      fs.copyFileSync(fp, path.join(seq, `frame-${String(i).padStart(4, '0')}.png`));
    }
    ffmpeg([
      '-y', '-framerate', String(fps), '-i', path.join(seq, 'frame-%04d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile,
    ]);
    if (!fs.existsSync(outFile)) throw new Error('ffmpeg không tạo được mp4.');
    return { file: outFile, frames: n, seconds: n / fps };
  } finally {
    fs.rmSync(seq, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Concatenate several preview clips (a cluster of scenes) into one mp4, re-encoding so clips of
// different sizes still join cleanly. Returns outFile.
export function stitchPreviews(files, outFile) {
  const list = files.filter(f => f && fs.existsSync(f));
  if (!list.length) throw new Error('Không có video preview nào để ghép.');
  if (list.length === 1) {
    fs.copyFileSync(list[0], outFile);
    return outFile;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv3dcat-'));
  try {
    const listFile = path.join(dir, 'list.txt');
    fs.writeFileSync(listFile, list.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    // normalise each to the same codec/pix_fmt first so concat never produces a black/again-stitch
    ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile]);
    if (!fs.existsSync(outFile)) throw new Error('ffmpeg concat thất bại.');
    return outFile;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Render a CAMERA-ONLY preview: a camera move over an EMPTY stage (no characters) — just the floor,
// so the clip shows the camera TRAJECTORY and speed as a reference, not scene content (topview has no
// scene geometry to show). Bypasses staging() entirely, so it never touches a shot's image prompt.
export function renderCameraOnly(outFile, { move = 'orbit', seconds = 2.5, fps = 12, width = 640, framing = 'medium' } = {}) {
  const preset = CAMERA_MOVES[move] || CAMERA_MOVES.orbit;
  const height = Math.round((width * 9) / 16);
  const n = Math.max(2, Math.min(96, Math.round(seconds * fps)));
  const dist = { wide: 7, medium: 5, close: 3.2 }[framing] || 5;
  const cam = { pos: [0, 1.5, dist], target: [0, 1.0, 0], fov: framing === 'close' ? 35 : 45 };
  const cli = cliPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv3dcam-'));
  const seq = fs.mkdtempSync(path.join(os.tmpdir(), 'tv3dcamseq-'));
  const write = (name, data) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(data));
    return f;
  };
  try {
    run(cli, ['project', 'init', dir, '--force']);
    run(cli, ['node', 'batch', dir, write('s.json', {
      changes: [{
        action: 'add_camera', nodeId: 'cam', presetId: 'front-medium', fov: cam.fov,
        view: { mode: 'world', position: V(cam.pos), target: V(cam.target) },
      }],
    })]);
    for (let i = 0; i < n; i++) {
      const view = preset.fn(cam, n === 1 ? 0 : i / (n - 1)) || orbitPos(cam, 0);
      run(cli, ['node', 'batch', dir, write('u.json', {
        changes: [{ action: 'update', nodeId: 'cam', view: { mode: 'world', ...view } }],
      })]);
      const res = run(cli, ['render', dir, write('r.json', { frames: [0], width, height, cameraNodeId: 'cam' })]);
      const fp = res?.result?.frames?.[0]?.path;
      if (!fp || !fs.existsSync(fp)) throw new Error('render không trả về khung hình.');
      fs.copyFileSync(fp, path.join(seq, `frame-${String(i).padStart(4, '0')}.png`));
    }
    ffmpeg([
      '-y', '-framerate', String(fps), '-i', path.join(seq, 'frame-%04d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile,
    ]);
    if (!fs.existsSync(outFile)) throw new Error('ffmpeg không tạo được mp4.');
    return { file: outFile, frames: n, seconds: n / fps };
  } finally {
    fs.rmSync(seq, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ffmpeg(args) {
  const bin = process.env.FFMPEG || 'ffmpeg';
  execFileSync(bin, args, { stdio: 'ignore', maxBuffer: 16 * 1024 * 1024 });
}
