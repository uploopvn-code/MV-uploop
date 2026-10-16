// Project store: the workspace file, each project's project.json (load, migrate, save,
// lock), and the currently open project (db).
import { defaultNaming } from '../output-config.mjs';
import { projectFromTemplate, projectTemplate } from '../templates.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { data, isChild, port, root } from './config.mjs';
import { compactJobs } from './job-history.mjs';
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
  if (['seedvis', 'web', 'orbit', 'musechat', 'seedane-muse'].includes(b?.image)) next.image = b.image;
  if (['seedvis', 'orbit', 'gvids', 'musechat', 'seedane-dola', 'seedane-muse'].includes(b?.video)) next.video = b.video;
  // The default Seedvis model a new node uses when its source is Seedvis.
  if (okSeedvisModel('image', b?.imageModel)) next.imageModel = b.imageModel;
  if (okSeedvisModel('video', b?.videoModel)) next.videoModel = b.videoModel;
  // Frame shape sticks app-wide too: someone who works in 9:16 should not have to set it again
  // on every new project. (Kept as a plain list here to avoid importing aspect.mjs → a cycle.)
  if (['16:9', '9:16', '1:1', '4:3', '3:4'].includes(b?.aspect)) next.aspect = b.aspect;
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
  if (['seedvis', 'web', 'orbit', 'musechat', 'seedane-muse'].includes(merged.image)) out.image = merged.image;
  if (['seedvis', 'orbit', 'gvids', 'musechat', 'seedane-dola', 'seedane-muse'].includes(merged.video)) out.video = merged.video;
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
// Script-studio runs in flight (lib/routes/script.mjs), keyed by script node id.
export const scriptTasks = new Map();
// Recipe runs in flight (lib/recipes.mjs), keyed by run id.
export const recipeTasks = new Map();
// Brings an older or freshly loaded project up to the current shape.
export function normalize(d) {
  d.outputDirectory ??= path.join(root, 'results');
  d.theme ??= 'music';
  d.revision = Number(d.revision) || 0; // a monotone counter the UI polls to skip redundant renders
  for (const n of d.nodes) if (n.kind !== 'setting') n.outputNaming ??= { ...defaultNaming };
  d.edges ??= [];
  // ⓪ START: node Kịch bản và node Nhạc mở đầu một dự án nên đứng cùng cột đầu tiên. Dự án cũ
  // lưu node nhạc ở cột Âm thanh (hợp lệ, nên nodeZone không tự lùi về mặc định) — chuyển tay.
  // Cột này từng mang id 'script'; id đó giờ không còn trong ZONES nên cũng gom về đây.
  for (const n of d.nodes)
    if ((n.kind === 'music' && n.zone === 'audio') || n.zone === 'script') n.zone = 'start';
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
  // A script-studio run cut off by a restart (the user reopened the app mid-run) never finishes:
  // left as "running" it showed step 2 forever with nothing behind it. Fail it at the station it
  // was on — the stations already done are kept, so "run on from the failed step" picks up there.
  for (const n of d.nodes)
    if (n.kind === 'script' && n.run?.status === 'running' && !scriptTasks.has(n.id))
      n.run = {
        ...n.run,
        status: 'failed',
        error:
          'Ứng dụng đã khởi động lại khi xưởng đang chạy. Các bước đã xong vẫn giữ — bấm ' +
          '"Chạy tiếp từ bước lỗi".',
        failedAt: n.run.key && n.run.key !== 'qc' ? n.run.key : '',
      };
  // A recipe run cut off by a restart: paused at the step it was on, to be redone on "Tiếp tục".
  if (d.recipeRun?.status === 'running' && !recipeTasks.has(d.recipeRun.id))
    d.recipeRun = {
      ...d.recipeRun,
      status: 'paused',
      redo: true,
      error:
        'Ứng dụng đã khởi động lại giữa bước này. Bấm Tiếp tục để chạy lại bước đó (các bước ' +
        'đã xong vẫn giữ).',
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
  // "Ảnh đầu vào cho video" từng có nghĩa "refs CHO TỚI KHI node có ảnh, sau đó dùng keyframe",
  // nên mọi shot do blueprint dựng đều mang 'refs' dù thực tế nó quay bằng keyframe. Giờ cờ này
  // đúng nghĩa đen, nên shot cũ nào ĐÃ có ảnh phải chuyển về 'self' — nếu không chúng lặng lẽ
  // đổi hành vi. Chạy một lần cho mỗi project. (Phân cảnh ghép luôn quay từ các frame của nó.)
  if (!d.videoInputMigrated) {
    for (const n of d.nodes)
      if (
        !n.terminal &&
        'duration' in n &&
        n.image &&
        n.videoInput === 'refs' &&
        n.zone !== 'merged'
      )
        n.videoInput = 'self';
    d.videoInputMigrated = true;
  }
  // Old job history carries the prompt it was sent with; nothing reads those any more.
  compactJobs(d);
  return d;
}
// A synchronous pause, for the retry below: save() is sync and callers rely on that.
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// save() rewrites the whole project file, so a session that renders for hours would otherwise
// keep rewriting a growing job history. Compact on every save, not only on load: it is one
// pass over the job list, next to nothing beside the stringify of the whole project.
// A debounced save for the high-frequency, NON-critical writes (job heartbeat / progress ticks):
// these fire several times a second during a render batch, and losing the last progress line on a
// crash is harmless. Real graph edits still go through the synchronous save() so they persist at
// once. A following save() flushes (and cancels) any pending soon-save.
let soonTimer = null;
export function saveSoon(ms = 500) {
  if (soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = null;
    try {
      save();
    } catch {}
  }, ms);
}
export function save() {
  if (soonTimer) {
    clearTimeout(soonTimer);
    soonTimer = null;
  }
  compactJobs(db);
  // Minified, not pretty-printed: the file is ~20–30% smaller and stringify is faster. It still
  // parses the same, and old pretty-printed files on disk load fine.
  fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db));
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
// The project switcher only needs each project's name + theme, but reading every project.json to
// get them parsed ~19 MB on every /api/state (≈70 ms). A project's name/theme only changes when it
// is saved, so cache them keyed by the file's mtime: an unchanged project costs one stat, and the
// currently-open project is read straight from the in-memory db. lockOwner() stays live (a small
// .lock read) so "open in another window" is always current.
const projectMetaCache = new Map(); // id -> { mtimeMs, name, theme }
export const projectList = () =>
  ws.order.map(id => {
    try {
      if (id === activeId) return { id, name: db.name, theme: db.theme || 'music', window: null };
      const file = projectDbFile(id);
      const mtimeMs = fs.statSync(file).mtimeMs;
      let meta = projectMetaCache.get(id);
      if (!meta || meta.mtimeMs !== mtimeMs) {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        meta = { mtimeMs, name: d.name, theme: d.theme || 'music' };
        projectMetaCache.set(id, meta);
      }
      return { id, name: meta.name, theme: meta.theme, window: lockOwner(id)?.port || null };
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
