import { orderGraph } from './graph.mjs';
import { prepareInputs, readOutput } from './media-io.mjs';
import { defaultNaming, validateDirectory, validatePattern, outputFor } from './output-config.mjs';
import {
  inspectOrbit,
  loginOrbit,
  logoutOrbit,
  validateBinding,
  executeOrbit,
  sessionUser,
} from './orbit-client.mjs';
import {
  catalog as seedvisCatalog,
  createSeedvis,
  defaultSeedvis,
  validateSeedvisBinding,
  videoDuration,
} from './seedvis-client.mjs';
import { projectTemplate, themes, themeLabel } from './templates.mjs';
import { MASTER_PROMPT, buildGraph } from './director.mjs';
import { createDirectorLLM } from './director-llm.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.MV_DATA_DIR || path.join(root, 'data');
const port = Number(process.env.MV_PORT || 7788);
// Worker token and Seedvis key stay at the data root, shared by every project.
const tokenFile = path.join(data, 'worker-token.txt');
fs.mkdirSync(data, { recursive: true });
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'));
const workerToken = fs.readFileSync(tokenFile, 'utf8').trim();
const seedvis = createSeedvis(data);
const directorLLM = createDirectorLLM(data);
const suffix =
  ', clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm.';

// --- Projects: each lives in data/projects/<id>/ with its own project.json + media/.
const projectsDir = path.join(data, 'projects');
const workspaceFile = path.join(data, 'workspace.json');
fs.mkdirSync(projectsDir, { recursive: true });
const projectDir = id => path.join(projectsDir, id);
const projectDbFile = id => path.join(projectDir(id), 'project.json');
const readWorkspace = () => {
  try {
    return JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  } catch {
    return { active: null, order: [] };
  }
};
const writeWorkspace = w => {
  fs.writeFileSync(workspaceFile + '.tmp', JSON.stringify(w, null, 2));
  fs.renameSync(workspaceFile + '.tmp', workspaceFile);
};
function writeProject(id, d) {
  fs.mkdirSync(path.join(projectDir(id), 'media'), { recursive: true });
  fs.writeFileSync(projectDbFile(id), JSON.stringify(d, null, 2));
}
function createProjectFiles(name, theme) {
  const id = crypto.randomUUID();
  const d = projectTemplate(theme);
  if (name) d.name = String(name).slice(0, 100);
  writeProject(id, d);
  return id;
}
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
let ws = readWorkspace();
ws.order = (ws.order || []).filter(id => fs.existsSync(projectDbFile(id)));
if (!ws.order.length) {
  const id = createProjectFiles(null, 'music');
  ws = { active: id, order: [id] };
}
if (!ws.order.includes(ws.active)) ws.active = ws.order[0];
writeWorkspace(ws);

let activeId, mediaDir, dbFile, db;
// Workflow zones: Nhân vật → Bối cảnh → Style/Máy quay → Sản xuất → Video.
const ZONES = ['character', 'design', 'setup', 'production', 'output'];
const CHARACTER_IDS = new Set(['singer', 'char', 'character']);
const defaultZone = n =>
  n.terminal
    ? 'output'
    : n.kind === 'setting'
      ? 'setup'
      : 'duration' in n
        ? 'production'
        : n.role === 'character' || CHARACTER_IDS.has(n.id)
          ? 'character'
          : 'design';
const nodeZone = n => (ZONES.includes(n.zone) ? n.zone : defaultZone(n));
// Sequence numbers restart per zone, so each zone is numbered 1, 2, 3…
const nextSeq = zone =>
  db.nodes.reduce((m, n) => (nodeZone(n) === zone ? Math.max(m, n.seq || 0) : m), 0) + 1;
// Order within a zone for numbering: by current seq, output by source then version.
const seqKey = n =>
  nodeZone(n) === 'output' ? (n.sourceSeq || 999) * 1000 + (n.version || 0) : n.seq || 9999;
// Renumbers each zone to 1..n. Output follows production order (source then
// version); other zones keep the current seq order (fractional seq lets the UI
// insert a node at a chosen position before this tidies it back to integers).
function renumberSeq(d) {
  const key = (n, z) =>
    z === 'output' ? (n.sourceSeq || 999) * 1000 + (n.version || 0) : (n.seq ?? 9999);
  for (const z of ZONES)
    d.nodes
      .filter(n => nodeZone(n) === z)
      .sort((a, b) => key(a, z) - key(b, z))
      .forEach((n, i) => (n.seq = i + 1));
}
// Brings an older or freshly loaded project up to the current shape.
function normalize(d) {
  d.outputDirectory ??= path.join(root, 'results');
  d.theme ??= 'music';
  for (const n of d.nodes) if (n.kind !== 'setting') n.outputNaming ??= { ...defaultNaming };
  renumberSeq(d);
  d.edges ??= [
    { source: 'singer', target: 'scene' },
    { source: 'stage', target: 'scene' },
    ...['wide', 'medium', 'close'].map(target => ({ source: 'scene', target })),
  ];
  for (const run of [d.autoRun, d.autoVideoRun])
    if (run?.status === 'running') {
      run.status = 'stopped';
      run.message = 'Đã khởi động lại. Kiểm tra tác vụ cũ trước khi chạy tiếp.';
    }
  // Never silently resubmit a possibly successful action after a restart.
  for (const j of d.jobs || [])
    if (j.status === 'running') {
      j.status = 'needs_review';
      j.error = 'Ứng dụng đã khởi động lại. Kiểm tra trước khi tạo lại.';
    }
  return d;
}
function save() {
  fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(dbFile + '.tmp', dbFile);
}
function loadProject(id) {
  activeId = id;
  mediaDir = path.join(projectDir(id), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  dbFile = projectDbFile(id);
  db = normalize(JSON.parse(fs.readFileSync(dbFile, 'utf8')));
  save();
}
const projectList = () =>
  ws.order.map(id => {
    try {
      const d = JSON.parse(fs.readFileSync(projectDbFile(id), 'utf8'));
      return { id, name: d.name, theme: d.theme || 'music' };
    } catch {
      return { id, name: '(lỗi đọc project)', theme: '' };
    }
  });
loadProject(ws.active);
const getNode = id => db.nodes.find(n => n.id === id);
const deps = id => db.edges.filter(e => e.target === id).map(e => e.source);
// Style / camera config nodes: wired into the graph but carry text, not media.
const isSetting = n => n?.kind === 'setting';
const settingLabel = { style: 'Style', camera: 'Camera' };
// Text contributed by the setting nodes connected into `n`.
function settingText(n) {
  return deps(n.id)
    .map(getNode)
    .filter(s => isSetting(s) && s.config?.trim())
    .map(s => (settingLabel[s.settingType] || 'Setting') + ': ' + s.config.trim())
    .join(' ');
}
function markChildren(id) {
  for (const n of db.nodes)
    if (!n.terminal && deps(n.id).includes(id)) {
      if (n.image || n.video) n.stale = true;
      if (n.id !== id) markChildren(n.id);
    }
}
function markAll() {
  for (const n of db.nodes) if (!n.terminal && (n.image || n.video)) n.stale = true;
}
function prompts(n) {
  if (isSetting(n)) return { image: '', video: '' };
  const f = db.fields,
    common = `${f.identity}. ${f.wardrobe}. ${f.instrument}.`,
    stage = `${f.stage}. ${f.lighting}.`;
  const size = {
    wide: 'Wide shot, full body and stage environment',
    medium: 'Medium shot, waist-up singer',
    close: 'Close-up three-quarter view, face and microphone',
  };
  const hasRefs = assetRefs(n).length > 0;
  // Music template keeps its tailored prompts; other themes use a generic builder.
  const generated = ['singer', 'stage', 'scene', 'wide', 'medium', 'close'].includes(n.id)
    ? n.id === 'singer'
      ? `${common} Neutral reference portrait and clear face, realistic skin texture, no text.`
      : n.id === 'stage'
        ? `${stage} Wide establishing shot of the empty stage, no singer, no text.`
        : n.id === 'scene'
          ? `Place the referenced singer in the referenced stage, preserve identity, outfit and instrument. ${common} ${stage} Wide shot, physically coherent scale, 16:9, photorealistic.`
          : `${size[n.id] || 'Compose the connected reference images into one coherent photograph'}. Preserve the referenced singer and scene. ${common} ${stage} Photorealistic concert still, 16:9, no text.`
    : hasRefs
      ? `Compose the connected reference images into one coherent shot for "${n.name}". Preserve the referenced subjects. ${common} ${stage} 16:9, no text.`
      : `${n.name}. ${common} ${stage} Clear reference frame, 16:9, no text.`;
  const pace = f.bpm
    ? `Steady ${f.bpm} BPM, natural breathing pauses.`
    : 'Natural breathing and restrained motion; align phrasing to the supplied audio.';
  const movement =
    n.id === 'wide'
      ? 'Slow dolly-in'
      : n.id === 'medium'
        ? 'Gentle push-in'
        : n.id === 'close'
          ? 'Very slow push-in, stable face'
          : 'Smooth, motivated camera move';
  let video = `Pace: ${pace} Prompt Video: ${movement}. Preserve the approved keyframe, identity, clothing and lighting. Subtle emotional performance.${n.lyric ? ' mouth articulates: ' + JSON.stringify(n.lyric) + '.' : ''}${suffix}`;
  // Append style / camera text from connected setting nodes.
  const settings = settingText(n);
  const withSettings = s => (settings ? s + ' ' + settings : s);
  return {
    image: withSettings(n.prompt || generated),
    video: withSettings(n.videoPrompt || video),
  };
}
// Seedvis is the default generator; a node keeps Orbit when it already has an Orbit
// binding or was explicitly switched to Orbit (seedvis[kind] === false).
function seedvisBinding(n, kind) {
  const s = n.seedvis?.[kind];
  if (s === false) return null;
  if (s) return s;
  return n.orbit?.[kind] ? null : defaultSeedvis[kind];
}
function providers(n) {
  const out = {};
  for (const kind of ['image', 'video']) {
    const s = seedvisBinding(n, kind);
    out[kind] = s
      ? {
          type: 'seedvis',
          ...validateSeedvisBinding(kind, s),
          ...(kind === 'video' ? { duration: videoDuration(s.model, n.duration) } : {}),
        }
      : { type: 'orbit' };
  }
  return out;
}
const assetRefs = n =>
  deps(n.id)
    .filter(id => !isSetting(getNode(id)))
    .map(id => ({ role: id, asset: getNode(id).image }))
    .filter(r => r.asset);
function publicState() {
  return {
    ...db,
    worker: db.worker ? { ...db.worker, online: Date.now() - db.worker.lastSeen < 20000 } : null,
    seedvisConfigured: seedvis.configured(),
    seedvisCatalog,
    seedvisDefaults: defaultSeedvis,
    activeProjectId: activeId,
    projects: projectList(),
    themes,
    nodes: db.nodes.map(n => ({
      ...n,
      videoInput: n.videoInput === 'refs' ? 'refs' : 'self',
      zone: nodeZone(n),
      resolvedPrompts: prompts(n),
      references: assetRefs(n),
      providers: providers(n),
    })),
  };
}
function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}
async function body(req) {
  let chunks = [],
    size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 150 * 1024 * 1024) throw new Error('File quá lớn. Giới hạn 100 MB cho một file.');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function requireWorker(req) {
  if (req.headers.authorization !== 'Bearer ' + workerToken)
    throw Object.assign(new Error('Worker authentication required'), { status: 401 });
}
function storeAsset(b) {
  const types = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
  };
  const ext = types[b.mime];
  if (!ext) throw new Error('Định dạng chưa hỗ trợ. Dùng PNG/JPG/WebP, MP4/WebM hoặc MP3/WAV/M4A.');
  const bytes = Buffer.from(b.base64 || '', 'base64');
  if (!bytes.length || bytes.length > 100 * 1024 * 1024)
    throw new Error('File trống hoặc lớn hơn 100 MB.');
  const id = crypto.randomUUID() + '.' + ext;
  fs.writeFileSync(path.join(mediaDir, id), bytes);
  return { id, url: '/media/' + id, mime: b.mime, name: String(b.name || id).slice(0, 200) };
}
function mutate() {
  renumberSeq(db);
  db.revision++;
  save();
}
// Replaces the active project's graph with a built one (keeps audio/fields/output).
function applyGraph(graph) {
  db.nodes = graph.nodes;
  db.edges = graph.edges;
  if (graph.name) db.name = graph.name;
  if (graph.theme && themes.some(t => t.id === graph.theme)) db.theme = graph.theme;
  db.autoRun = null;
  db.autoVideoRun = null;
  db.jobs = [];
  normalize(db);
  mutate();
}
function checkLease(j, b) {
  if (!j || j.status !== 'running' || j.lease !== b.lease)
    throw new Error('Job không còn thuộc phiên worker này.');
}
async function createJob(req, b) {
  const n = getNode(b.nodeId);
  if (!n) throw new Error('Node không tồn tại');
  if (n.terminal) throw new Error('Node phiên bản chỉ để xem, không tạo tiếp từ nó.');
  if (isSetting(n)) throw new Error('Node cài đặt (style/máy quay) không tạo ảnh/video.');
  const kind = b.kind === 'video' ? 'video' : 'image';
  const count = kind === 'video' ? Math.max(1, Math.min(8, Math.floor(Number(b.count) || 1))) : 1;
  // Branch mode: each produced version becomes its own output node.
  const branch = kind === 'video' && (b.branch === true || count > 1);
  const sv = seedvisBinding(n, kind);
  if (!sv && (count > 1 || branch))
    throw new Error('Nhiều phiên bản / tách node chỉ hỗ trợ Seedvis. Node này đang dùng Orbit.');
  let verifiedBinding = null;
  if (sv) {
    if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
  } else {
    const binding = n.orbit?.[kind];
    if (!binding) throw new Error('Mở Cài đặt Orbit của node để chọn kịch bản và nick.');
    verifiedBinding = await validateBinding(req, binding);
    if (verifiedBinding.owner !== binding.owner)
      throw new Error(
        'Cấu hình thuộc tài khoản khác. Chọn và lưu lại nick/kịch bản bằng tài khoản hiện tại.',
      );
  }
  const prior = db.jobs.find(
    j => j.nodeId === n.id && j.kind === kind && ['queued', 'running'].includes(j.status),
  );
  if (prior) return prior;
  // Video can run from the node's own approved image (keyframe), or from the images
  // of the connected parent nodes (videoInput === 'refs'). Once the node has composed
  // its own image, that exact keyframe drives the video — refs only seed it beforehand.
  const videoFromRefs = kind === 'video' && n.videoInput === 'refs' && !n.image;
  if (kind === 'video' && !videoFromRefs && !n.image)
    throw new Error(
      'Cần ảnh của node này trước khi tạo video, hoặc chuyển sang dùng ảnh node nối vào.',
    );
  // Setting-node parents carry text, not images; they never block generation.
  const imgParents = deps(n.id).filter(id => !isSetting(getNode(id)));
  if ((kind === 'image' || videoFromRefs) && imgParents.some(id => !getNode(id).image))
    throw new Error('Hãy tạo hoặc tải ảnh các node nối vào trước.');
  if (kind === 'image' && imgParents.some(id => getNode(id).stale))
    throw new Error('Ảnh node nối vào đã thay đổi. Hãy tạo lại trước.');
  if (kind === 'video' && !videoFromRefs && n.stale)
    throw new Error('Ảnh cần cập nhật sau thay đổi đầu vào. Hãy tạo lại hoặc tải ảnh đã duyệt.');
  const references = videoFromRefs
    ? assetRefs(n)
    : kind === 'video'
      ? [{ role: 'keyframe', asset: n.image }]
      : assetRefs(n);
  if (videoFromRefs) {
    if (!references.length)
      throw new Error('Nối ít nhất một node đã có ảnh vào node này để tạo video.');
    const staleParent = references.find(r => getNode(r.role).stale);
    if (staleParent)
      throw new Error(
        'Ảnh node "' + getNode(staleParent.role).name + '" cần cập nhật trước khi tạo video.',
      );
  }
  const jobId = crypto.randomUUID();
  if (sv) {
    const binding = validateSeedvisBinding(kind, sv);
    const j = {
      id: jobId,
      nodeId: n.id,
      kind,
      status: 'queued',
      createdAt: new Date().toISOString(),
      payload: {
        seedvis: binding,
        kind,
        count,
        branch,
        prompt: prompts(n)[kind],
        website: 'Seedvis · ' + binding.modelName + (count > 1 ? ' · ' + count + ' bản' : ''),
        aspectRatio: binding.aspectRatio,
        references,
        audio: db.audio,
        timing: { start: n.start || 0, duration: n.duration || 8 },
        nodeId: n.id,
        projectRevision: db.revision,
      },
      error: null,
    };
    db.jobs.push(j);
    save();
    return j;
  }
  const output = outputFor(db.outputDirectory, n.outputNaming, n.id, kind, jobId);
  const payload = {
    output,
    orbit: verifiedBinding,
    kind,
    prompt: prompts(n)[kind],
    website: verifiedBinding.scriptName,
    aspectRatio: '16:9',
    references,
    audio: db.audio,
    timing: { start: n.start || 0, duration: n.duration || 8 },
    nodeId: n.id,
    projectRevision: db.revision,
  };
  const j = {
    id: jobId,
    nodeId: n.id,
    kind,
    status: 'queued',
    createdAt: new Date().toISOString(),
    payload,
    error: null,
  };
  db.jobs.push(j);
  save();
  return j;
}

async function collectJob(j) {
  storeResult(j, await readOutput(j, Number(process.env.MV_OUTPUT_WAIT_MS || 60000)));
}
function storeResult(j, content) {
  const a = storeAsset(content);
  const n = getNode(j.nodeId);
  j.result = a;
  j.status = 'completed';
  j.completedAt = new Date().toISOString();
  j.resultStale = db.revision !== j.payload.projectRevision;
  n[j.kind] = a;
  if (j.kind === 'image') {
    n.stale = j.resultStale;
    markChildren(n.id);
  } else n.videoStale = j.resultStale;
  j.progress = 'Đã nhận file vào node';
  save();
}
// A display-only node holding one produced video, wired from the source node.
function createBranchNode(sourceId, asset) {
  const src = getNode(sourceId);
  const version = db.nodes.filter(x => x.terminal && x.source === sourceId).length + 1;
  const id = 'node-' + crypto.randomUUID();
  db.nodes.push({
    id,
    name: (src?.name || 'Video') + ' · v' + version,
    terminal: true,
    zone: 'output',
    seq: nextSeq('output'),
    source: sourceId,
    sourceSeq: src?.seq || null,
    sourceName: src?.name || '',
    version,
    image: null,
    video: asset,
    prompt: '',
    videoPrompt: '',
    lyric: '',
    start: 0,
    duration: src?.duration || 8,
    outputNaming: { ...defaultNaming },
  });
  db.edges.push({ source: sourceId, target: id });
  return id;
}
// Seedvis returns one result per requested version. Branch jobs turn each into
// its own output node; a single-version job stores into the source node.
function storeSeedvisResults(j, results) {
  const assets = results.map(storeAsset);
  j.result = assets[0];
  j.resultCount = assets.length;
  j.status = 'completed';
  j.completedAt = new Date().toISOString();
  j.resultStale = db.revision !== j.payload.projectRevision;
  if (j.payload.branch) {
    if (db.nodes.length + assets.length > 300)
      throw new Error('Quá nhiều node. Xóa bớt phiên bản cũ.');
    j.branchNodes = assets.map(a => createBranchNode(j.nodeId, a));
    renumberSeq(db); // keep the Video zone numbered in production order
    j.progress = 'Đã tạo ' + assets.length + ' phiên bản video';
  } else {
    const n = getNode(j.nodeId);
    n[j.kind] = assets[0];
    if (j.kind === 'image') {
      n.stale = j.resultStale;
      markChildren(n.id);
    } else n.videoStale = j.resultStale;
    j.progress = 'Đã nhận file vào node';
  }
  save();
}
function requireIdle() {
  if (
    db.autoRun?.status === 'running' ||
    db.autoVideoRun?.status === 'running' ||
    db.jobs.some(j => ['queued', 'running'].includes(j.status))
  )
    throw new Error('Đợi tác vụ hoàn tất hoặc dừng chuỗi trước khi sửa workflow.');
}
function seedvisImages(j) {
  return j.payload.references.map(ref => {
    if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(ref.asset.id))
      throw new Error('Ảnh tham chiếu không hợp lệ.');
    return {
      data: fs.readFileSync(path.join(mediaDir, ref.asset.id)).toString('base64'),
      file_name: ref.role + '-' + ref.asset.id,
    };
  });
}
// Seedvis jobs run concurrently (up to this cap); Orbit runs one at a time.
const SV_CAP = Math.max(1, Number(process.env.MV_SEEDVIS_CONCURRENCY) || 3);
const svActive = new Set();
let orbitBusy = false;
let lastReq = null;
let pumping = false,
  pumpAgain = false;

// Executes one queued job to completion (Seedvis or Orbit), storing its result
// or, for branch jobs, spawning output nodes.
async function runJob(req, j) {
  j.status = 'running';
  j.executor = j.payload.seedvis ? 'seedvis' : 'orbit-direct';
  j.startedAt = new Date().toISOString();
  j.heartbeat = Date.now();
  j.progress = j.payload.seedvis ? 'Đang chuẩn bị gửi Seedvis' : 'Đang kiểm tra Orbit';
  save();
  const heartbeat = setInterval(() => {
    j.heartbeat = Date.now();
    save();
  }, 10000);
  const onProgress = message => {
    j.progress = message;
    j.heartbeat = Date.now();
    save();
  };
  try {
    if (j.payload.seedvis) {
      storeSeedvisResults(j, await seedvis.run(j, seedvisImages(j), onProgress, save));
    } else {
      await prepareInputs(j, mediaDir);
      save();
      await executeOrbit(req, j, onProgress);
      j.progress = 'Đang chờ file đầu ra';
      save();
      await collectJob(j);
    }
    if (j.autoRunId && db.autoRun?.id === j.autoRunId) db.autoRun.index++;
  } catch (e) {
    // `definite`: Seedvis rejected or failed the job, so nothing is pending remotely.
    j.status = e.definite ? 'failed' : 'needs_review';
    j.error = e.message;
    j.progress = j.payload.seedvis
      ? e.definite
        ? 'Seedvis không tạo được; sửa rồi tạo lại'
        : 'Cần kiểm tra lại trạng thái Seedvis, không tạo mới'
      : 'Cần kiểm tra Orbit trước khi chạy lại';
    if (j.autoRunId && db.autoRun?.id === j.autoRunId) {
      db.autoRun.status = 'blocked';
      db.autoRun.message = e.message;
    }
    if (j.autoVideoId && db.autoVideoRun?.id === j.autoVideoId)
      db.autoVideoRun.errors.push((getNode(j.nodeId)?.name || j.nodeId) + ': ' + e.message);
  } finally {
    clearInterval(heartbeat);
    save();
  }
}

// Creates queued jobs from the active auto-runs. Image auto-run stays serial (one
// job in flight, driven by dependencies); video auto-run enqueues every ready node.
async function feedAuto() {
  const owner = sessionUser(lastReq)?.email || null;
  const run = db.autoRun;
  if (run?.status === 'running' && (!run.owner || run.owner === owner)) {
    const inFlight = db.jobs.some(
      j => j.autoRunId === run.id && ['queued', 'running'].includes(j.status),
    );
    if (!inFlight) {
      while (run.index < run.order.length) {
        const node = getNode(run.order[run.index]);
        if (node.image && !node.stale) {
          run.index++;
          continue;
        }
        break;
      }
      if (run.index === run.order.length) {
        run.status = 'completed';
        run.message = 'Đã nhận đủ ảnh của chuỗi';
        save();
      } else {
        try {
          const j = await createJob(lastReq, { nodeId: run.order[run.index], kind: 'image' });
          j.autoRunId = run.id;
          save();
        } catch (e) {
          run.status = 'blocked';
          run.message = e.message;
          save();
        }
      }
    }
  }
  const vr = db.autoVideoRun;
  if (vr?.status === 'running') {
    for (const id of [...vr.pending]) {
      try {
        const j = await createJob(lastReq, {
          nodeId: id,
          kind: 'video',
          count: vr.versions,
          branch: true,
        });
        j.autoVideoId = vr.id;
        vr.pending = vr.pending.filter(x => x !== id);
        save();
      } catch (e) {
        vr.pending = vr.pending.filter(x => x !== id);
        vr.errors.push((getNode(id)?.name || id) + ': ' + e.message);
        save();
      }
    }
    const active = db.jobs.some(
      j => j.autoVideoId === vr.id && ['queued', 'running'].includes(j.status),
    );
    if (!vr.pending.length && !active) {
      vr.status = vr.errors.length ? 'blocked' : 'completed';
      vr.message = vr.errors.length
        ? 'Một số node lỗi: ' + vr.errors.join(' · ')
        : 'Đã tạo xong các phiên bản video';
      save();
    }
  }
}

// Launches queued jobs within the concurrency limits.
function launch() {
  while (svActive.size < SV_CAP) {
    const j = db.jobs.find(j => j.status === 'queued' && j.payload.seedvis && !svActive.has(j.id));
    if (!j) break;
    svActive.add(j.id);
    runJob(lastReq, j).finally(() => {
      svActive.delete(j.id);
      pump(lastReq);
    });
  }
  if (!orbitBusy) {
    const owner = sessionUser(lastReq)?.email || null;
    const j =
      owner &&
      db.jobs.find(
        j => j.status === 'queued' && j.payload.orbit && j.payload.orbit.owner === owner,
      );
    if (j) {
      orbitBusy = true;
      runJob(lastReq, j).finally(() => {
        orbitBusy = false;
        pump(lastReq);
      });
    }
  }
}

// Serialized planner: feeds the auto-runs then launches jobs. Re-invoked after each
// job settles. The lock keeps two invocations from launching the same job.
async function pump(req) {
  if (req && sessionUser(req)) lastReq = req;
  else if (!lastReq) lastReq = req;
  if (process.env.MV_RUNNER_DISABLED === '1') return;
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      await feedAuto();
      launch();
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

// Re-reads an interrupted Seedvis job (timeout, restart) without resubmitting.
async function resumeSeedvis(j) {
  j.status = 'running';
  j.heartbeat = Date.now();
  j.error = null;
  save();
  const heartbeat = setInterval(() => {
    j.heartbeat = Date.now();
    save();
  }, 10000);
  try {
    storeSeedvisResults(
      j,
      await seedvis.resume(j, message => {
        j.progress = message;
        j.heartbeat = Date.now();
        save();
      }),
    );
  } catch (e) {
    j.status = e.definite ? 'failed' : 'needs_review';
    j.error = e.message;
  } finally {
    clearInterval(heartbeat);
    save();
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin))
      return json(res, 403, { error: 'Origin not allowed' });
    const u = new URL(req.url, `http://127.0.0.1:${port}`),
      p = u.pathname;
    if (p === '/api/orbit' && req.method === 'GET') {
      const info = await inspectOrbit(req);
      if (info.authenticated) pump(req);
      return json(res, 200, info);
    }
    if (p === '/api/orbit/login' && req.method === 'POST')
      return json(res, 200, await loginOrbit(req, res, await body(req)));
    if (p === '/api/orbit/logout' && req.method === 'POST')
      return json(res, 200, await logoutOrbit(req, res));
    if (p === '/api/state' && req.method === 'GET') {
      pump(req);
      return json(res, 200, publicState());
    }
    if (p === '/api/seedvis' && req.method === 'GET') return json(res, 200, await seedvis.status());
    if (p === '/api/seedvis/key' && req.method === 'POST') {
      const b = await body(req);
      if (b.key) seedvis.saveKey(b.key);
      else seedvis.removeKey();
      return json(res, 200, await seedvis.status());
    }
    if (p === '/api/project' && req.method === 'PATCH') {
      requireIdle();
      const b = await body(req);
      const outputDirectory =
        'outputDirectory' in b ? validateDirectory(b.outputDirectory) : db.outputDirectory;
      if (b.fields) {
        if (b.fields.bpm && (!Number.isFinite(Number(b.fields.bpm)) || Number(b.fields.bpm) <= 0))
          throw new Error('BPM phải là số dương.');
        for (const key of Object.keys(db.fields))
          if (key in b.fields) db.fields[key] = String(b.fields[key]).slice(0, 5000);
        if (
          db.fields.bpm &&
          (!Number.isFinite(Number(db.fields.bpm)) || Number(db.fields.bpm) <= 0)
        )
          throw new Error('BPM phải là số dương.');
        markAll();
      }
      db.outputDirectory = outputDirectory;
      if ('website' in b) db.website = String(b.website).slice(0, 500);
      if ('name' in b) db.name = String(b.name).slice(0, 100);
      if ('theme' in b && themes.some(t => t.id === b.theme)) db.theme = b.theme;
      mutate();
      return json(res, 200, publicState());
    }
    if (p === '/api/projects' && req.method === 'GET')
      return json(res, 200, { active: activeId, projects: projectList(), themes });
    if (p === '/api/projects' && req.method === 'POST') {
      requireIdle();
      const b = await body(req);
      const theme = themes.some(t => t.id === b.theme) ? b.theme : 'music';
      const id = createProjectFiles(b.name, theme);
      ws.order.push(id);
      ws.active = id;
      writeWorkspace(ws);
      loadProject(id);
      return json(res, 201, publicState());
    }
    if (p === '/api/projects/switch' && req.method === 'POST') {
      requireIdle();
      const b = await body(req);
      if (!ws.order.includes(b.id)) throw new Error('Project không tồn tại.');
      ws.active = b.id;
      writeWorkspace(ws);
      loadProject(b.id);
      return json(res, 200, publicState());
    }
    if (p === '/api/projects/delete' && req.method === 'POST') {
      requireIdle();
      const b = await body(req);
      if (!ws.order.includes(b.id)) throw new Error('Project không tồn tại.');
      if (ws.order.length === 1) throw new Error('Phải còn ít nhất một project.');
      fs.rmSync(projectDir(b.id), { recursive: true, force: true });
      ws.order = ws.order.filter(x => x !== b.id);
      if (ws.active === b.id) ws.active = ws.order[0];
      writeWorkspace(ws);
      loadProject(ws.active);
      return json(res, 200, publicState());
    }
    if (p === '/api/director' && req.method === 'GET')
      return json(res, 200, { masterPrompt: MASTER_PROMPT, llm: directorLLM.status() });
    if (p === '/api/director/llm' && req.method === 'POST')
      return json(res, 200, { llm: directorLLM.save(await body(req)) });
    if (p === '/api/director/build' && req.method === 'POST') {
      requireIdle();
      const b = await body(req);
      applyGraph(buildGraph(b.blueprint));
      return json(res, 200, publicState());
    }
    if (p === '/api/director/auto' && req.method === 'POST') {
      requireIdle();
      const b = await body(req);
      if (!directorLLM.configured()) throw new Error('Chưa cấu hình API key LLM cho Đạo diễn.');
      const song = String(b.song || '').slice(0, 20000);
      if (!song.trim()) throw new Error('Nhập tên bài hát / lời / link để chạy.');
      const text = await directorLLM.complete(
        MASTER_PROMPT,
        'BẮT ĐẦU: ' +
          song +
          '\n\nChỉ trả về đúng khối JSON blueprint theo schema đã mô tả, không thêm chữ nào ngoài khối JSON.',
      );
      applyGraph(buildGraph(text));
      return json(res, 200, publicState());
    }
    if (p === '/api/node' && req.method === 'PATCH') {
      requireIdle();
      const b = await body(req),
        n = getNode(b.id);
      if (!n) throw new Error('Node không tồn tại');
      const next = { ...n };
      if ('name' in b) {
        next.name = String(b.name).trim().slice(0, 100);
        if (!next.name) throw new Error('Tên node không được trống.');
      }
      if (b.outputNaming) {
        next.outputNaming = { ...n.outputNaming };
        for (const kind of ['image', 'video'])
          if (kind in b.outputNaming)
            next.outputNaming[kind] = validatePattern(b.outputNaming[kind], kind);
      }
      if ('orbit' in b) {
        next.orbit = { ...n.orbit };
        for (const kind of ['image', 'video'])
          if (kind in b.orbit)
            next.orbit[kind] =
              b.orbit[kind] === null ? null : await validateBinding(req, b.orbit[kind]);
      }
      if (b.seedvis) {
        next.seedvis = { ...n.seedvis };
        for (const kind of ['image', 'video'])
          if (kind in b.seedvis)
            next.seedvis[kind] =
              b.seedvis[kind] === false
                ? false
                : b.seedvis[kind] === null
                  ? null
                  : validateSeedvisBinding(kind, b.seedvis[kind]);
      }
      if ('videoInput' in b) next.videoInput = b.videoInput === 'refs' ? 'refs' : 'self';
      // Output nodes stay in the output zone; others move between design/production.
      if ('zone' in b && ZONES.includes(b.zone) && !n.terminal) {
        const z = b.zone === 'output' ? 'production' : b.zone;
        if (z !== nodeZone(n)) {
          next.zone = z;
          if (!('seq' in b)) next.seq = nextSeq(z); // fresh number in the new zone
        }
      }
      if ('seq' in b) {
        const v = Math.floor(Number(b.seq));
        if (!Number.isFinite(v) || v < 1 || v > 9999) throw new Error('Số thứ tự không hợp lệ.');
        // Land just before the node currently at position v; mutate() then
        // renumbers the zone back to clean integers, so typing v moves it there.
        next.seq = v - 0.5;
      }
      if ('config' in b && isSetting(n)) next.config = String(b.config).slice(0, 5000);
      for (const k of ['prompt', 'videoPrompt', 'lyric'])
        if (k in b) next[k] = String(b[k]).slice(0, 20000);
      for (const k of ['start', 'duration'])
        if (k in b) {
          const v = Number(b[k]);
          if (!Number.isFinite(v) || v < 0 || (k === 'duration' && v === 0))
            throw new Error('Thời lượng không hợp lệ');
          next[k] = v;
        }
      const imageChanged = next.prompt !== n.prompt;
      const configChanged = isSetting(n) && next.config !== n.config;
      const changed = JSON.stringify(n) !== JSON.stringify(next);
      Object.assign(n, next);
      if (changed && n.video) n.videoStale = true;
      // A style/camera change or an image-prompt change invalidates children.
      if (imageChanged || configChanged) {
        if (n.image) n.stale = true;
        markChildren(n.id);
      }
      if (changed) mutate();
      return json(res, 200, publicState());
    }
    if (p === '/api/upload' && req.method === 'POST') {
      requireIdle();
      const b = await body(req);
      if (b.nodeId !== 'audio' && !getNode(b.nodeId)) throw new Error('Node không tồn tại');
      const kind = b.nodeId === 'audio' ? 'audio' : b.kind === 'video' ? 'video' : 'image';
      if (!String(b.mime).startsWith(kind + '/')) throw new Error('Loại file không khớp');
      const a = storeAsset(b);
      if (b.nodeId === 'audio') {
        db.audio = a;
        db.audioDuration = Number.isFinite(b.duration) ? b.duration : null;
      } else {
        const n = getNode(b.nodeId);
        n[kind] = a;
        if (kind === 'image') {
          n.stale = false;
          if (n.video) n.videoStale = true;
          markChildren(n.id);
        } else n.videoStale = false;
      }
      mutate();
      return json(res, 200, publicState());
    }
    if (p === '/api/jobs' && req.method === 'POST') {
      if (db.autoRun?.status === 'running' || db.autoVideoRun?.status === 'running')
        throw new Error('Đang chạy tự động. Dừng chuỗi trước khi chạy riêng.');
      const j = await createJob(req, await body(req));
      pump(req);
      return json(res, 201, { job: j });
    }

    if (p === '/api/nodes' && req.method === 'POST') {
      requireIdle();
      const b = await body(req);
      if (db.nodes.length >= 100) throw new Error('Giới hạn 100 node/project.');
      const node =
        b.kind === 'setting'
          ? {
              id: 'node-' + crypto.randomUUID(),
              kind: 'setting',
              settingType: b.settingType === 'camera' ? 'camera' : 'style',
              zone: 'design',
              seq: nextSeq('design'),
              name: String(b.name || (b.settingType === 'camera' ? 'Máy quay' : 'Style')).slice(
                0,
                100,
              ),
              config: String(b.config || '').slice(0, 5000),
            }
          : {
              id: 'node-' + crypto.randomUUID(),
              name: String(b.name || 'Ảnh mới').slice(0, 100),
              zone: 'production',
              seq: nextSeq('production'),
              prompt: '',
              videoPrompt: '',
              lyric: '',
              start: 0,
              duration: 8,
              image: null,
              video: null,
              outputNaming: { ...defaultNaming },
            };
      db.nodes.push(node);
      mutate();
      return json(res, 201, publicState());
    }
    if (p === '/api/nodes/delete' && req.method === 'POST') {
      requireIdle();
      const b = await body(req),
        n = getNode(b.id);
      if (!n) throw new Error('Node không tồn tại');
      if (!String(n.id).startsWith('node-'))
        throw new Error('Chỉ xóa được node bạn thêm hoặc node phiên bản video.');
      db.nodes = db.nodes.filter(x => x.id !== n.id);
      db.edges = db.edges.filter(e => e.source !== n.id && e.target !== n.id);
      for (const x of db.nodes) if (!x.terminal && (x.image || x.video)) markChildren(x.id);
      mutate();
      return json(res, 200, publicState());
    }
    if (p === '/api/edges' && req.method === 'PUT') {
      requireIdle();
      const b = await body(req);
      if (!Array.isArray(b.edges)) throw new Error('Danh sách nối không hợp lệ');
      const edges = b.edges.map(e => ({ source: String(e.source), target: String(e.target) }));
      if (new Set(edges.map(e => e.source + '>' + e.target)).size !== edges.length)
        throw new Error('Đường nối trùng');
      orderGraph(db.nodes, edges);
      const changed = db.nodes.filter(
        n =>
          JSON.stringify(deps(n.id)) !==
          JSON.stringify(edges.filter(e => e.target === n.id).map(e => e.source)),
      );
      db.edges = edges;
      for (const n of changed) {
        if (n.image) n.stale = true;
        markChildren(n.id);
      }
      mutate();
      return json(res, 200, publicState());
    }
    if (p === '/api/auto/start' && req.method === 'POST') {
      requireIdle();
      const b = await body(req),
        // Output nodes hold a finished video; setting nodes carry text. Skip both.
        order = orderGraph(db.nodes, db.edges, b.target || null).filter(
          id => !getNode(id).terminal && !isSetting(getNode(id)),
        ),
        rerun = new Set();
      for (const id of order) {
        const n = getNode(id);
        if (!n.image || n.stale || deps(id).some(id => rerun.has(id))) rerun.add(id);
      }
      const needOrbit = [...rerun].some(id => !seedvisBinding(getNode(id), 'image'));
      const info = needOrbit ? await inspectOrbit(req) : null;
      if (info && !info.authenticated) throw new Error(info.message);
      for (const id of rerun) {
        const n = getNode(id);
        const ambiguous = [...db.jobs].reverse().find(j => j.nodeId === id && j.kind === 'image');
        if (ambiguous?.status === 'needs_review')
          throw new Error(n.name + ': dùng Nhận file hoặc chạy riêng để xử lý tác vụ trước.');
        if (seedvisBinding(n, 'image')) {
          if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
          continue;
        }
        const binding = await validateBinding(req, n.orbit?.image);
        if (binding.owner !== n.orbit.image.owner)
          throw new Error('Chọn lại tài khoản chạy node ' + n.name);
      }
      if (needOrbit) {
        fs.mkdirSync(db.outputDirectory, { recursive: true });
        fs.accessSync(db.outputDirectory, fs.constants.W_OK);
      }
      db.autoRun = {
        id: crypto.randomUUID(),
        owner: info?.user.email || null,
        status: 'running',
        order,
        index: 0,
        message: 'Chạy lần lượt; dùng lại ảnh còn hợp lệ',
      };
      save();
      pump(req);
      return json(res, 200, publicState());
    }
    if (p === '/api/auto/stop' && req.method === 'POST') {
      if (db.autoRun?.status === 'running') {
        db.autoRun.status = 'stopped';
        db.autoRun.message =
          'Dừng sau node hiện tại; không hủy tác vụ đang chạy trên Orbit/Seedvis';
        save();
      }
      return json(res, 200, publicState());
    }
    if (p === '/api/auto/video/start' && req.method === 'POST') {
      requireIdle();
      if (!seedvis.configured()) throw new Error('Nhập API key Seedvis trong Kết nối web.');
      const b = await body(req);
      const versions = Math.max(1, Math.min(8, Math.floor(Number(b.versions) || 1)));
      // Eligible: production-zone (Sản xuất video) Seedvis nodes whose video input is
      // already ready. Character/scene asset nodes are never auto-filmed, even with an image.
      const eligible = db.nodes.filter(n => {
        if (n.terminal || isSetting(n)) return false;
        if (nodeZone(n) !== 'production') return false;
        if (b.target && n.id !== b.target) return false;
        if (providers(n).video.type !== 'seedvis') return false;
        // A shot with its own composed image uses that keyframe; refs only seed it before then.
        if (n.videoInput === 'refs' && !n.image) {
          const refs = assetRefs(n);
          return refs.length > 0 && !refs.some(r => getNode(r.role).stale);
        }
        return !!n.image && !n.stale;
      });
      if (!eligible.length) throw new Error('Không có node nào sẵn ảnh để tạo video bằng Seedvis.');
      db.autoVideoRun = {
        id: crypto.randomUUID(),
        status: 'running',
        versions,
        pending: eligible.map(n => n.id),
        total: eligible.length,
        errors: [],
        message: 'Đang tạo video song song cho ' + eligible.length + ' node',
      };
      save();
      pump(req);
      return json(res, 200, publicState());
    }
    if (p === '/api/auto/video/stop' && req.method === 'POST') {
      if (db.autoVideoRun?.status === 'running') {
        // Stop enqueuing more; jobs already sent to Seedvis keep running.
        db.autoVideoRun.pending = [];
        db.autoVideoRun.status = 'stopped';
        db.autoVideoRun.message = 'Dừng; không hủy tác vụ đã gửi Seedvis';
        save();
      }
      return json(res, 200, publicState());
    }
    if (p === '/api/jobs/collect' && req.method === 'POST') {
      const b = await body(req),
        j = db.jobs.find(j => j.id === b.id);
      if (
        !j ||
        !['needs_review', 'script_completed'].includes(j.status) ||
        !(j.payload.output || j.payload.seedvis)
      )
        throw new Error('Tác vụ chưa thể nhận file');
      requireIdle();
      if (j.payload.seedvis) resumeSeedvis(j);
      else await collectJob(j);
      return json(res, 200, publicState());
    }
    if (p === '/api/jobs/cancel' && req.method === 'POST') {
      const b = await body(req),
        j = db.jobs.find(j => j.id === b.id);
      if (!j || j.status !== 'queued') throw new Error('Chỉ hủy được job chưa chạy.');
      j.status = 'cancelled';
      save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/worker/claim' && req.method === 'POST') {
      requireWorker(req);
      const b = await body(req);
      db.worker = { name: String(b.name || 'Web worker').slice(0, 100), lastSeen: Date.now() };
      const j = db.jobs.some(j => j.status === 'running')
        ? null
        : db.jobs.find(j => j.status === 'queued' && !j.payload.orbit && !j.payload.seedvis);
      if (j) {
        j.status = 'running';
        j.startedAt = new Date().toISOString();
        j.heartbeat = Date.now();
        j.lease = crypto.randomUUID();
      }
      save();
      return json(res, 200, { job: j || null });
    }
    if (p === '/api/worker/heartbeat' && req.method === 'POST') {
      requireWorker(req);
      const b = await body(req),
        j = db.jobs.find(j => j.id === b.id);
      checkLease(j, b);
      j.heartbeat = Date.now();
      if (db.worker) db.worker.lastSeen = Date.now();
      save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/worker/complete' && req.method === 'POST') {
      requireWorker(req);
      const b = await body(req),
        j = db.jobs.find(j => j.id === b.id);
      checkLease(j, b);
      if (!String(b.mime).startsWith(j.kind + '/')) throw new Error('Worker trả về sai loại file');
      const a = storeAsset(b);
      j.status = 'completed';
      j.result = a;
      j.completedAt = new Date().toISOString();
      const n = getNode(j.nodeId);
      n[j.kind] = a;
      n.stale = db.revision !== j.payload.projectRevision;
      j.resultStale = n.stale;
      if (j.kind === 'image') {
        if (n.video) n.videoStale = true;
        markChildren(n.id);
      } else {
        n.videoStale = n.stale;
        n.stale = false;
      }
      save();
      return json(res, 200, { ok: true, asset: a });
    }
    if (p === '/api/worker/fail' && req.method === 'POST') {
      requireWorker(req);
      const b = await body(req),
        j = db.jobs.find(j => j.id === b.id);
      checkLease(j, b);
      j.status = b.needsReview ? 'needs_review' : 'failed';
      j.error = String(b.error || 'Worker failed').slice(0, 2000);
      save();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/export' && req.method === 'GET') {
      const shots = db.nodes.map(n => ({
        shotId: n.id,
        start: n.start,
        duration: n.duration,
        lyric: n.lyric,
        prompts: prompts(n),
        references: assetRefs(n),
        image: n.image,
        video: n.video,
        stale: !!n.stale,
      }));
      return json(res, 200, {
        project: db.name,
        edges: db.edges,
        version: 2,
        timingStatus: 'manual_unverified',
        audio: db.audio,
        fields: db.fields,
        shots,
      });
    }
    if (p.startsWith('/media/') && req.method === 'GET') {
      const name = p.slice(7);
      if (!/^[a-f0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|m4a|ogg)$/.test(name))
        return json(res, 404, { error: 'Not found' });
      const file = path.join(mediaDir, name);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
      const ext = path.extname(name),
        mime = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.webp': 'image/webp',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.m4a': 'audio/mp4',
          '.ogg': 'audio/ogg',
        }[ext];
      const size = fs.statSync(file).size;
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      res.setHeader('Content-Type', mime);
      res.setHeader('Accept-Ranges', 'bytes');
      if (range) {
        const start = Number(range[1]),
          end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': size });
        fs.createReadStream(file).pipe(res);
      }
      return;
    }
    if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(p)) {
      const file = p === '/' ? 'index.html' : p.slice(1);
      res.writeHead(200, {
        'Content-Type': file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : 'text/css; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(path.join(root, 'public', file)).pipe(res);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, e.status || 400, { error: e.message });
  }
});
setInterval(() => {
  let changed = false;
  for (const j of db.jobs)
    if (j.status === 'running' && Date.now() - j.heartbeat > 90000) {
      j.status = 'needs_review';
      j.error = 'Worker mất kết nối. Kiểm tra website trước khi tạo lại để tránh chạy trùng.';
      changed = true;
    }
  if (changed) save();
}, 10000).unref();
server.listen(port, '127.0.0.1', () => console.log(`MV Director ready: http://127.0.0.1:${port}`));
