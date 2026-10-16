// Recipes: a whole production run the tool executes by itself, step by step, with stops —
// script studio (+ build) → images per zone → videos per zone → zip — and remembers, so the
// next "run everything" never goes through an LLM for the steering (the writing inside the
// studio still does).
//
// Learned the hard way on the script studio, applied here from the start: every long loop
// checks the stop flag BETWEEN steps, every run has its own id (an old run that comes back
// sees another id and stays silent), and a run cut off by an app restart is marked at the
// step it was on so "Tiếp tục" redoes that step instead of hanging on "running" forever.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildZip } from '../zip.mjs';
import { imageBatchNodes, startAutoVideoRun, videoBatchPlan, videoOutputCount } from './auto.mjs';
import { claudeAvailable } from './claude-cli.mjs';
import { data, directorLLM, seedvis } from './config.mjs';
import { workerOnline } from './director-web.mjs';
import { haltJobs, isBusy } from './jobs.mjs';
import { exportRoot } from './library.mjs';
import { assetRefs, getNode } from './nodes.mjs';
import { buildPackage, packageName } from './package.mjs';
import { db, mediaDir, recipeTasks, save } from './projects.mjs';
import { providers } from './providers.mjs';
import { DEFAULT_RECIPES, ZONE_VI, matchRecipe, normalizeSteps, stepLabel } from './recipe-def.mjs';
import { buildFromStudio, startStudioRun } from './routes/script.mjs';
import { pump } from './runner.mjs';

// --- the library: built-in recipes + the ones learned from the assistant ---------------------
const file = path.join(data, 'recipes.json');
const readUser = () => {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
};
const writeUser = rows => {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(rows, null, 2));
  fs.renameSync(file + '.tmp', file);
};
export const listRecipes = () => [...DEFAULT_RECIPES, ...readUser()];
export const findRecipe = id => listRecipes().find(r => r.id === id) || null;
// The recipe a request names (zero tokens), if any.
export const recipeFor = request => matchRecipe(request, listRecipes());
// Remember a recipe under its trigger phrases. The same steps learned again only gain the new
// phrases — one recipe, many ways to ask for it.
export function saveRecipe({ name, triggers, steps }) {
  const norm = normalizeSteps(steps);
  const trig = [
    ...new Set(
      (Array.isArray(triggers) ? triggers : [])
        .map(t => String(t || '').trim().slice(0, 120))
        .filter(Boolean),
    ),
  ].slice(0, 8);
  if (!trig.length) throw new Error('Quy trình cần ít nhất một câu kích hoạt.');
  const rows = readUser();
  const sig = JSON.stringify(norm);
  const same = rows.find(r => JSON.stringify(r.steps) === sig);
  if (same) {
    same.triggers = [...new Set([...same.triggers, ...trig])].slice(0, 12);
    writeUser(rows);
    return same;
  }
  const rec = {
    id: crypto.randomUUID(),
    name: String(name || 'Quy trình của tôi').slice(0, 100),
    triggers: trig,
    steps: norm,
    builtin: false,
    createdAt: new Date().toISOString(),
  };
  writeUser([...rows, rec]);
  return rec;
}
export function deleteRecipe(id) {
  const rows = readUser();
  const next = rows.filter(r => r.id !== id);
  if (next.length === rows.length) throw new Error('Chỉ xoá được quy trình của bạn.');
  writeUser(next);
}

// --- the runner ------------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
// Still this run, still going (the stop flag and "another run started" in one check).
const live = id => db.recipeRun?.id === id && db.recipeRun.status === 'running';

// Start a recipe: a saved one by id, or steps written by the assistant (`learn` remembers them
// under `triggers` once the run completes). One recipe at a time.
export function startRecipe({ recipeId, steps, name, triggers, auto = false, learn = false }, req = null) {
  const cur = db.recipeRun;
  if (cur && ['running', 'paused'].includes(cur.status))
    throw new Error('Đang có quy trình chạy dở — bấm Tiếp tục hoặc Dừng nó trước.');
  const rec = recipeId ? findRecipe(recipeId) : null;
  if (recipeId && !rec) throw new Error('Quy trình không tồn tại.');
  const list = normalizeSteps(rec ? rec.steps : steps);
  const run = (db.recipeRun = {
    id: crypto.randomUUID(),
    recipeId: rec?.id || '',
    name: String(rec?.name || name || 'Quy trình').slice(0, 100),
    steps: list,
    labels: list.map(stepLabel),
    step: 0,
    status: 'running',
    auto: !!auto,
    label: 'Bắt đầu',
    error: '',
    redo: false,
    startedAt: now(),
    log: [],
    zip: null,
    learn:
      !rec && learn
        ? { name: String(name || '').slice(0, 100), triggers: Array.isArray(triggers) ? triggers : [] }
        : null,
  });
  save();
  launch(run.id, req);
  return run;
}
// After a stop (confirm), or to redo the step that failed / was cut off by a restart.
export function continueRecipe(req = null) {
  const run = db.recipeRun;
  if (!run || !['paused', 'failed'].includes(run.status))
    throw new Error('Không có quy trình đang chờ xác nhận hay chờ chạy lại.');
  if (!run.redo) run.step++;
  run.redo = false;
  run.error = '';
  run.status = 'running';
  save();
  launch(run.id, req);
  return run;
}
// Stop the recipe AND the batch it started (the studio run, the image or video batch): one
// button means stop everything, not "stop steering but keep spending".
export function stopRecipe() {
  const run = db.recipeRun;
  if (!run || !['running', 'paused', 'failed'].includes(run.status)) return run;
  run.status = 'stopped';
  run.label = 'Đã dừng';
  for (const r of [db.autoImageRun, db.autoVideoRun])
    if (r?.status === 'running') {
      r.pending = [];
      r.status = 'stopped';
      r.message = 'Đã dừng theo quy trình';
    }
  haltJobs(
    j =>
      ['image', 'video'].includes(j.kind) &&
      ['queued', 'running'].includes(j.status) &&
      (j.autoImageId || j.autoVideoId),
  );
  for (const n of db.nodes)
    if (n.kind === 'script' && n.run?.status === 'running')
      n.run = { ...n.run, status: 'stopped', label: 'Đã dừng' };
  recipeTasks.delete(run.id);
  save();
  return run;
}
function launch(id, req) {
  let task;
  task = (async () => {
    try {
      await loop(id, req);
    } finally {
      if (recipeTasks.get(id) === task) recipeTasks.delete(id);
      save();
    }
  })();
  recipeTasks.set(id, task);
}
async function loop(id, req) {
  const run = db.recipeRun;
  while (live(id) && run.step < run.steps.length) {
    const st = run.steps[run.step];
    run.label = stepLabel(st);
    run.stepAt = now();
    save();
    if (st.type === 'confirm') {
      if (run.auto) {
        run.log.push({ step: run.step, note: 'tự qua (chạy hết)', at: now() });
        run.step++;
        continue;
      }
      run.status = 'paused';
      run.label = st.text;
      save();
      return;
    }
    let note;
    try {
      note = await doStep(st, id, req);
    } catch (e) {
      if (!live(id)) return;
      run.status = 'failed';
      run.error = e.message;
      run.redo = true; // "Tiếp tục" retries this very step
      save();
      return;
    }
    if (!live(id)) return;
    run.log.push({ step: run.step, note: note || '', at: now() });
    run.step++;
    save();
  }
  if (!live(id)) return;
  run.status = 'done';
  run.label = 'Xong';
  if (run.learn) {
    try {
      const rec = saveRecipe({ ...run.learn, steps: run.steps });
      run.learned = { id: rec.id, name: rec.name, triggers: rec.triggers };
    } catch (e) {
      run.learnError = e.message;
    }
    run.learn = null;
  }
  save();
}
const doStep = (st, id, req) =>
  st.type === 'script'
    ? stepScript(st, id)
    : st.type === 'images'
      ? stepImages(st, id, req)
      : st.type === 'videos'
        ? stepVideos(st, id, req)
        : stepPackage();
// A batch may not start on top of another: wait for the queue (and the earlier batch) first.
async function waitIdle(id) {
  while (live(id) && isBusy()) await sleep(1000);
}

// The LLM the studio runs on: the node's own choice when it is available, else whatever is —
// API key, Claude Code (the plan), the ChatGPT extension.
const viaOk = v =>
  v === 'api'
    ? directorLLM.configured()
    : v === 'claude'
      ? claudeAvailable()
      : v === 'web'
        ? workerOnline()
        : false;
function pickVia(n) {
  for (const v of [n.via, 'api', 'claude', 'web']) if (v && viaOk(v)) return v;
  throw new Error('Không có LLM nào sẵn sàng (API key, Claude Code hay extension ChatGPT).');
}
async function stepScript(st, id) {
  const scripts = db.nodes.filter(n => n.kind === 'script');
  if (!scripts.length)
    throw new Error('Chưa có node Kịch bản — thêm node Kịch bản và nhập ý tưởng trước.');
  const n = scripts.find(x => String(x.brief?.idea || '').trim() || x.run) || scripts[0];
  await waitIdle(id);
  if (!live(id)) return '';
  // Already written and built (an earlier run, or the step being redone after a restart): keep
  // the result — rerunning the studio would wipe it and spend the tokens again.
  if (n.run?.status === 'done') {
    if (n.run.built) return `kịch bản "${n.name}" đã chạy xong từ trước — dùng kết quả có sẵn`;
    await buildFromStudio(n);
    n.run = { ...n.run, built: true, label: 'Xong · đã dựng graph' };
    save();
    return 'dựng graph từ kết quả kịch bản có sẵn';
  }
  const from = n.run?.status === 'failed' && n.run.failedAt ? n.run.failedAt : '';
  startStudioRun(n, { mode: st.mode, via: pickVia(n), from, restart: !from, autoBuild: true });
  const runId = n.run.id;
  while (live(id) && n.run?.id === runId && n.run.status === 'running') await sleep(1000);
  if (!live(id)) {
    if (n.run?.id === runId && n.run.status === 'running')
      n.run = { ...n.run, status: 'stopped', label: 'Đã dừng' };
    return '';
  }
  if (n.run?.id !== runId) throw new Error('Xưởng kịch bản bị một lượt khác chạy đè.');
  if (n.run.status !== 'done')
    throw new Error(
      'Xưởng kịch bản ' + (n.run.status === 'stopped' ? 'bị dừng.' : 'lỗi: ' + n.run.error),
    );
  if (n.run.buildError) throw new Error('Chưa dựng được graph: ' + n.run.buildError);
  const t = n.run.tokens;
  return `${n.run.total} bước${t?.turns ? `, ${t.in + t.out} token` : ''}; đã dựng graph`;
}
// One zone image batch exactly as the ⚡ zone button starts it, then wait for it to settle.
async function stepImages(st, id, req) {
  const notes = [];
  for (const zone of st.zones) {
    await waitIdle(id);
    if (!live(id)) return '';
    const eligible = imageBatchNodes(zone);
    if (!eligible.length) {
      notes.push(`${ZONE_VI[zone]}: không có node cần ảnh`);
      continue;
    }
    if (eligible.some(n => providers(n).image.type === 'seedvis') && !seedvis.configured())
      throw new Error('Nhập API key Seedvis trong Kết nối web.');
    const ir = (db.autoImageRun = {
      id: crypto.randomUUID(),
      status: 'running',
      zone,
      pending: eligible.map(n => n.id),
      total: eligible.length,
      errors: [],
      message: 'Đang tạo ảnh song song cho ' + eligible.length + ' node',
      attempts: {},
      maxRetries: 3,
    });
    save();
    pump(req);
    for (;;) {
      if (!live(id)) return '';
      const cur = db.autoImageRun;
      if (!cur || cur.id !== ir.id) break;
      const open = db.jobs.some(
        j => j.autoImageId === ir.id && ['queued', 'running'].includes(j.status),
      );
      if (cur.status !== 'running' && !open) break;
      await sleep(1000);
    }
    const cur = db.autoImageRun;
    const made = eligible.filter(n => getNode(n.id)?.image).length;
    notes.push(
      `${ZONE_VI[zone]}: ${made}/${eligible.length} ảnh` +
        (cur?.errors?.length ? ` · lỗi: ${cur.errors.slice(0, 3).join(' · ')}` : ''),
    );
    if (!made)
      throw new Error(`Không tạo được ảnh nào ở khu ${ZONE_VI[zone]}: ${cur?.message || ''}`);
  }
  return notes.join('; ');
}
// One zone video batch as the ▶ zone button starts it (any provider, one version), then wait.
async function stepVideos(st, id, req) {
  const notes = [];
  for (const zone of st.zones) {
    await waitIdle(id);
    if (!live(id)) return '';
    const { ready } = videoBatchPlan(zone, st.provider || null, 1, false, {});
    if (!ready.length) {
      notes.push(`${ZONE_VI[zone]}: không có node cần video`);
      continue;
    }
    if (ready.some(n => providers(n).video.type === 'seedvis') && !seedvis.configured())
      throw new Error('Nhập API key Seedvis trong Kết nối web.');
    for (const n of ready) if (!n.image && assetRefs(n).length) n.videoInput = 'refs';
    save();
    startAutoVideoRun(
      req,
      ready.map(n => n.id),
      1,
      `Quy trình: tạo video khu ${ZONE_VI[zone]} (${ready.length} node)`,
    );
    const vrId = db.autoVideoRun.id;
    for (;;) {
      if (!live(id)) return '';
      const vr = db.autoVideoRun;
      if (!vr || vr.id !== vrId) break;
      const open = db.jobs.some(
        j => j.autoVideoId === vrId && ['queued', 'running'].includes(j.status),
      );
      if (vr.status !== 'running' && !open) break;
      await sleep(1000);
    }
    const vr = db.autoVideoRun;
    const made = ready.filter(n => videoOutputCount(getNode(n.id)) > 0).length;
    notes.push(
      `${ZONE_VI[zone]}: ${made}/${ready.length} video` +
        (vr?.errors?.length ? ` · lỗi: ${vr.errors.slice(0, 3).join(' · ')}` : ''),
    );
    if (!made)
      throw new Error(`Không tạo được video nào ở khu ${ZONE_VI[zone]}: ${vr?.message || ''}`);
  }
  return notes.join('; ');
}
// The delivery zip (the same one the 📦 button downloads), written next to the project's
// exports so it exists as a file whether or not a browser is watching.
function stepPackage() {
  const { files, clips } = buildPackage(db, mediaDir);
  const zip = buildZip(files);
  const dir = exportRoot();
  fs.mkdirSync(dir, { recursive: true });
  const name = packageName(db);
  fs.writeFileSync(path.join(dir, name), zip);
  db.recipeRun.zip = { name, dir, bytes: zip.length, clips };
  return `${name} (${(zip.length / 1048576).toFixed(1)} MB, ${clips} clip) → ${dir}`;
}
