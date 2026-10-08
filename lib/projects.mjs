// Project store: the workspace file, each project's project.json (load, migrate, save,
// lock), and the currently open project (db).
import { defaultNaming } from '../output-config.mjs';
import { projectFromTemplate, projectTemplate } from '../templates.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { data, isChild, port, root } from './config.mjs';
import { renumberSeq } from './zones.mjs';
import { catalog as seedvisCatalog } from '../seedvis-client.mjs';

// A Seedvis model id valid for this kind (image/video), for the project default model.
export const okSeedvisModel = (kind, id) =>
  !!id && (seedvisCatalog[kind] || []).some(m => m.id === id);

// --- Projects: each lives in data/projects/<id>/ with its own project.json + media/.
export const projectsDir = path.join(data, 'projects');
const workspaceFile = path.join(data, 'workspace.json');
fs.mkdirSync(projectsDir, { recursive: true });
export const projectDir = id => path.join(projectsDir, id);
export const projectDbFile = id => path.join(projectDir(id), 'project.json');
const readWorkspace = () => {
  try {
    return JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  } catch {
    return { active: null, order: [] };
  }
};
export const writeWorkspace = w => {
  fs.writeFileSync(workspaceFile + '.tmp', JSON.stringify(w, null, 2));
  fs.renameSync(workspaceFile + '.tmp', workspaceFile);
};
export function writeProject(id, d) {
  fs.mkdirSync(path.join(projectDir(id), 'media'), { recursive: true });
  fs.writeFileSync(projectDbFile(id), JSON.stringify(d, null, 2));
}
// A sticky app-wide default generation source ("Nguồn mặc định của project"): written whenever
// the user sets a project's default, read when a new project is created so the choice carries
// over. Absent (e.g. a fresh data dir in tests) → nothing imposed, so Seedvis stays the default.
const appDefaultsFile = path.join(data, 'project-defaults.json');
export function readAppDefaults() {
  try {
    return JSON.parse(fs.readFileSync(appDefaultsFile, 'utf8'));
  } catch {
    return {};
  }
}
export function writeAppDefaults(b) {
  const next = readAppDefaults();
  if (['seedvis', 'web', 'orbit', 'musechat'].includes(b?.image)) next.image = b.image;
  if (['seedvis', 'orbit', 'gvids', 'musechat'].includes(b?.video)) next.video = b.video;
  // The default Seedvis model a new node uses when its source is Seedvis.
  if (okSeedvisModel('image', b?.imageModel)) next.imageModel = b.imageModel;
  if (okSeedvisModel('video', b?.videoModel)) next.videoModel = b.videoModel;
  try {
    fs.writeFileSync(appDefaultsFile, JSON.stringify(next, null, 2));
  } catch {}
  return next;
}
// A new project inherits its default source from the project currently open, then the sticky
// app default (the explicit one wins). So setting ChatGPT once carries to every new project.
function inheritedDefaults() {
  const merged = { ...(db?.defaults || {}), ...readAppDefaults() };
  const out = {};
  if (['seedvis', 'web', 'orbit', 'musechat'].includes(merged.image)) out.image = merged.image;
  if (['seedvis', 'orbit', 'gvids', 'musechat'].includes(merged.video)) out.video = merged.video;
  if (okSeedvisModel('image', merged.imageModel)) out.imageModel = merged.imageModel;
  if (okSeedvisModel('video', merged.videoModel)) out.videoModel = merged.videoModel;
  return out;
}

// template: a saved user template to clone from instead of the theme's built-in skeleton.
export function createProjectFiles(name, theme, exportDir = '', template = null) {
  const id = crypto.randomUUID();
  const d = template ? projectFromTemplate(template) : projectTemplate(theme);
  if (name) d.name = String(name).slice(0, 100);
  if (exportDir) d.exportDir = exportDir; // the project's working folder on disk
  const def = inheritedDefaults();
  if (Object.keys(def).length) d.defaults = { ...(d.defaults || {}), ...def };
  writeProject(id, d);
  return id;
}
export let ws;

export let activeId, mediaDir, dbFile, db;
// A clip belongs in the Video column, not on the node that made it. Projects written before
// that (and videos attached by hand) are moved over on load, keeping their file and name.
// Next free version number for a shot's clips: one above the highest, so deleting v1 never
// hands "v3" out a second time (and never overwrites the exported v3 file).
// The source remembers the highest number it handed out, so deleting the newest clip does
// not give its number to the next one either.
export const nextVersion = (nodes, sourceId) =>
  Math.max(
    Number(nodes.find(x => x.id === sourceId)?.lastVersion) || 0,
    ...nodes.filter(x => x.terminal && x.source === sourceId).map(x => Number(x.version) || 0),
  ) + 1;
function liftVideos(d) {
  for (const n of d.nodes.filter(x => x.video && !x.terminal && x.kind !== 'setting')) {
    // It takes the next free number. The clips the shot already has keep theirs: their
    // files in the video folder are named after them (…_v1.mp4), so renumbering would
    // leave the app and the folder disagreeing.
    const version = nextVersion(d.nodes, n.id);
    d.nodes.push({
      id: 'node-' + crypto.randomUUID(),
      name: n.name + ' · v' + version,
      terminal: true,
      zone: 'output',
      source: n.id,
      sourceSeq: n.seq || null,
      sourceName: n.name || '',
      version,
      outdated: !!n.videoStale,
      image: null,
      video: n.video,
      prompt: '',
      videoPrompt: '',
      lyric: '',
      start: 0,
      duration: n.duration || 8,
      outputNaming: { ...defaultNaming },
    });
    d.edges = d.edges || [];
    d.edges.push({ source: n.id, target: d.nodes.at(-1).id });
    n.video = null; // the warning (videoStale) stays: it is about the shot, not the file
    n.lastVersion = version;
  }
  // Clips saved before each one tracked its own staleness: the shot's flag says whether its
  // newest clip is out of date, and an older clip is at least as old.
  for (const c of d.nodes)
    if (c.terminal && c.outdated === undefined)
      c.outdated = !!d.nodes.find(x => x.id === c.source)?.videoStale;
}
// Music nodes whose vocal separation is running in this process right now → its promise
// (lib/routes/music.mjs sets and removes them), so normalize() only fails the ones a restart
// really cut off, and an import can wait for a separation still running.
export const vocalTasks = new Map();
// Brings an older or freshly loaded project up to the current shape.
export function normalize(d) {
  d.outputDirectory ??= path.join(root, 'results');
  d.theme ??= 'music';
  for (const n of d.nodes) if (n.kind !== 'setting') n.outputNaming ??= { ...defaultNaming };
  d.edges ??= [];
  liftVideos(d);
  // A Seedance group's clips live in their own column (made before it existed: moved there).
  const groups = new Set(d.nodes.filter(n => n.role === 'seedance').map(n => n.id));
  for (const n of d.nodes)
    if (n.terminal && groups.has(n.source) && n.zone !== 'seedance-video')
      n.zone = 'seedance-video';
  // A lip-sync take's clips live in their own column too.
  const takes = new Set(d.nodes.filter(n => n.role === 'lipsync').map(n => n.id));
  for (const n of d.nodes)
    if (n.terminal && takes.has(n.source) && n.zone !== 'lipsync-video') n.zone = 'lipsync-video';
  // A vocal separation cut off by a restart never reports back: say so instead of "running".
  for (const n of d.nodes)
    if (n.kind === 'music' && n.vocalTask?.status === 'running' && !vocalTasks.has(n.id))
      n.vocalTask = {
        status: 'failed',
        error: 'Ứng dụng đã khởi động lại khi đang tách vocal. Bấm tách lại.',
      };
  renumberSeq(d);
  d.edges ??= [
    { source: 'singer', target: 'scene' },
    { source: 'stage', target: 'scene' },
    ...['wide', 'medium', 'close'].map(target => ({ source: 'scene', target })),
  ];
  // Drop edges that point to a node that no longer exists — a dangling edge would make
  // reference-resolution throw and 500 the whole state (blank page).
  const ids = new Set(d.nodes.map(n => n.id));
  d.edges = d.edges.filter(e => ids.has(e.source) && ids.has(e.target));
  for (const run of [d.autoRun, d.autoVideoRun, d.autoImageRun])
    if (run?.status === 'running') {
      run.status = 'stopped';
      run.message = 'Đã khởi động lại. Kiểm tra tác vụ cũ trước khi chạy tiếp.';
    }
  // Never silently resubmit a possibly successful action after a restart. A ChatGPT image stays
  // late (lib/jobs.mjs): its extension can still hand it in under the same lease, and with its
  // conversation known it is fetched from there in a minute (the rest of scheduleRecover's
  // checks run when it is due; this module cannot import lib/jobs.mjs).
  for (const j of d.jobs || [])
    if (j.status === 'running') {
      j.status = 'needs_review';
      j.error = 'Ứng dụng đã khởi động lại. Kiểm tra trước khi tạo lại.';
      if (j.kind === 'image' && !j.payload?.seedvis && !j.payload?.orbit) {
        j.late = true;
        j.error =
          'Ứng dụng đã khởi động lại khi ChatGPT đang tạo ảnh. Extension gửi ảnh về muộn thì tool vẫn nhận.';
        if (
          j.web?.conversationUrl &&
          !j.web.shared &&
          j.workerCaps?.includes('recover') &&
          (j.recover?.tries || 0) < 2
        ) {
          j.recoverAt = Date.now() + 60000;
          j.progress = 'ChatGPT có thể vẫn đang vẽ: tool sẽ tự mở lại cuộc trò chuyện để lấy ảnh';
        }
      }
    }
  return d;
}
// A synchronous pause, for the retry below: save() is sync and callers rely on that.
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function save() {
  fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
  // Windows refuses to replace a file another process has open, and every other window reads
  // every project.json to list the projects — so a save can collide with a reader that holds
  // the file for the length of one read. The replace stays atomic; it just waits its turn.
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(dbFile + '.tmp', dbFile);
    } catch (e) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(5);
    }
  }
}
// A project may be open in one window (server process) at a time: two servers writing the
// same project.json would clobber each other. The lock names the owning process + port; a
// lock whose process no longer exists is ignored.
const lockFile = id => path.join(projectDir(id), '.lock');
export const pidAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
export function lockOwner(id) {
  try {
    const l = JSON.parse(fs.readFileSync(lockFile(id), 'utf8'));
    return l.pid !== process.pid && pidAlive(l.pid) ? l : null;
  } catch {
    return null;
  }
}
// Every window alive right now, this one included. Read straight from the per-project .lock
// files rather than the workspace file, so a secondary window can answer too — and rather
// than lockOwner(), which hides our own lock on purpose.
export function livePorts() {
  const seen = new Map();
  if (activeId) seen.set(port, { id: activeId, port });
  try {
    for (const id of fs.readdirSync(projectsDir)) {
      try {
        const l = JSON.parse(fs.readFileSync(lockFile(id), 'utf8'));
        if (l.port && !seen.has(l.port) && pidAlive(l.pid)) seen.set(l.port, { id, port: l.port });
      } catch {}
    }
  } catch {}
  return [...seen.values()];
}
function acquireLock(id) {
  const other = lockOwner(id);
  if (other)
    throw new Error(
      `Project đang mở ở cửa sổ khác (cổng ${other.port}). Dùng cửa sổ đó, hoặc đóng nó rồi thử lại.`,
    );
  fs.writeFileSync(
    lockFile(id),
    JSON.stringify({ pid: process.pid, port, at: new Date().toISOString() }),
  );
}
export function releaseLock(id) {
  try {
    if (JSON.parse(fs.readFileSync(lockFile(id), 'utf8')).pid === process.pid)
      fs.unlinkSync(lockFile(id));
  } catch {}
}
export function loadProject(id) {
  if (id !== activeId) acquireLock(id); // throws when another window owns it
  if (activeId && activeId !== id) releaseLock(activeId);
  activeId = id;
  mediaDir = path.join(projectDir(id), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  dbFile = projectDbFile(id);
  db = normalize(JSON.parse(fs.readFileSync(dbFile, 'utf8')));
  save();
}
export const projectList = () =>
  ws.order.map(id => {
    try {
      const d = JSON.parse(fs.readFileSync(projectDbFile(id), 'utf8'));
      // window: the port of the other window this project is open in, if any.
      return { id, name: d.name, theme: d.theme || 'music', window: lockOwner(id)?.port || null };
    } catch {
      return { id, name: '(lỗi đọc project)', theme: '', window: null };
    }
  });
// Bookkeeping that follows every change of the graph, whichever route made it (lib/stage3d.mjs:
// the shots whose stage marks changed go out of date). Registered by the module that needs it.
const followers = [];
export const afterEachChange = f => followers.push(f);
export function mutate() {
  renumberSeq(db);
  for (const f of followers) f();
  db.revision++;
  save();
}

// Opens the workspace at start-up: migrates the legacy single-project layout, makes sure
// a project exists, then opens the start project (retrying while an old lock clears).
export async function initWorkspace() {
  // One-time migration of the legacy single-project layout.
  const legacyDb = path.join(data, 'project.json');
  if (fs.existsSync(legacyDb) && !fs.existsSync(workspaceFile)) {
    const id = crypto.randomUUID();
    fs.mkdirSync(projectDir(id), { recursive: true });
    fs.renameSync(legacyDb, projectDbFile(id));
    const legacyMedia = path.join(data, 'media');
    if (fs.existsSync(legacyMedia)) fs.renameSync(legacyMedia, path.join(projectDir(id), 'media'));
    writeWorkspace({ active: id, order: [id] });
  }
  ws = readWorkspace();
  ws.order = (ws.order || []).filter(id => fs.existsSync(projectDbFile(id)));
  if (!ws.order.length) {
    const id = createProjectFiles(null, 'music');
    ws = { active: id, order: [id] };
  }
  if (!ws.order.includes(ws.active)) ws.active = ws.order[0];
  if (process.env.MV_PROJECT && ws.order.includes(process.env.MV_PROJECT))
    ws.active = process.env.MV_PROJECT;
  if (!isChild) writeWorkspace(ws);
  // Open the start project. A lock still held by a window that is shutting down (e.g. right
  // after a restart) clears within seconds, so retry briefly before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      loadProject(ws.active);
      break;
    } catch (e) {
      if (attempt >= 16) {
        console.error(e.message);
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
}
