// The state object sent to the browser.
import { catalog as seedvisCatalog, defaultSeedvis } from '../seedvis-client.mjs';
import { themes } from '../templates.mjs';
import { GENRES } from './master-prompts.mjs';
import { missingVideoIds, uncertainJobs } from './auto.mjs';
import { groupInfo, isGroup } from './seedance.mjs';
import { isMerged, mergedInfo } from './merged.mjs';
import { isSettled } from './job-history.mjs';
import { NODE_CAP, NODE_WARN } from './limits.mjs';
import { stages } from './script-studio.mjs';
import { studioKind } from './studio-kind.mjs';
import { data, isChild, mainPort, port, seedane, seedvis } from './config.mjs';
import { assetRefs, imageParents, isStageOnly, settingParents } from './nodes.mjs';
import { notePins, stagePin } from './stage3d.mjs';
import { activeId, db, projectList } from './projects.mjs';
import { prompts } from './prompts.mjs';
import { mixedRoom, providers, videoNeedsKeyframe, videoRefLimit } from './providers.mjs';
import { openWindowList } from './windows.mjs';
import { listTemplates } from './user-templates.mjs';
import { nodeZone } from './zones.mjs';

// /api/state is fetched every 4 seconds and carries the project's whole job history. The
// prompt each job was sent with is the single biggest thing in it — measured in a real
// 243-node project here, 825 KB of a 2.29 MB file — and no part of the page reads it. So a
// settled job's prompt is left off the wire. Everything else stays: the queue rows and the
// node badges read the rest of the payload, and job-history.mjs is what decides when a
// payload stops being needed on disk at all.
function statePayload(j) {
  if (!j.payload || !isSettled(j) || !('prompt' in j.payload)) return j.payload;
  // A settled job's prompt (~825 KB over a 243-node project) is dead weight on the wire — nothing on
  // the page reads it once the job is done. The reference list IS kept: a re-check / re-run and the
  // inspector still read which images a settled job used. (App is localhost, so gzip would only add
  // CPU for no bandwidth gain; cutting bytes at the source is the real win.)
  const { prompt, ...rest } = j.payload;
  return rest;
}

export function publicState() {
  notePins(); // (a project's first look: what each shot's stage marks are, before anything changes)
  const videoGaps = missingVideoIds();
  const now = Date.now();
  // Several browsers/accounts can each be a web worker; count the ones seen recently.
  const workerCount = Object.values(db.workers || {}).filter(t => now - t < 20000).length;
  const workerAccounts = Object.entries(db.workers || {}).map(([id, seen]) => ({
    ...(db.workerMeta?.[id] || {}),
    workerId: id,
    provider:
      db.workerMeta?.[id]?.museEnabled ||
      db.jobs.some(j => j.worker === id && j.payload?.site === 'musechat')
        ? 'musechat'
        : 'extension',
    concurrencyLimit:
      db.workerMeta?.[id]?.museEnabled ||
      db.jobs.some(j => j.worker === id && j.payload?.site === 'musechat')
        ? 10
        : null,
    online: now - seen < 20000,
    lastSeen: seen,
    active: db.jobs.filter(j => j.status === 'running' && j.worker === id).length,
    activeJobs: db.jobs
      .filter(j => j.status === 'running' && j.worker === id)
      .map(j => ({ id: j.id, nodeId: j.nodeId, kind: j.kind, progress: j.progress || '' }))
      .slice(0, 20),
    museActive: db.jobs.filter(
      j => j.status === 'running' && j.worker === id && j.payload?.site === 'musechat',
    ).length,
    queuedMuse: db.jobs.filter(j => j.status === 'queued' && j.payload?.site === 'musechat').length,
  }));
  return {
    ...db,
    // Backfill the normalized project key for jobs created by older versions without mutating
    // the persisted queue. New jobs already carry this field at creation time.
    jobs: db.jobs.map(j => ({
      ...j,
      projectId: j.projectId || activeId,
      payload: statePayload(j),
    })),
    // How full the project is. Clips and Seedance groups are results, not workflow nodes, so
    // they do not count — same rule the "add node" route enforces.
    nodeBudget: {
      used: db.nodes.filter(n => !n.terminal && !isGroup(n)).length,
      cap: NODE_CAP,
      warn: NODE_WARN,
    },
    worker: db.worker ? { ...db.worker, online: workerCount > 0, count: workerCount } : null,
    workerAccounts,
    seedvisConfigured: seedvis.configured(),
    seedaneConfigured: seedane.configured(),
    // Shots "✚ Tạo video còn thiếu" covers (film or re-check): the button shows this count.
    missingVideo: videoGaps.missing,
    recheckVideo: videoGaps.recheckOnly,
    seedvisCatalog,
    seedvisDefaults: defaultSeedvis,
    activeProjectId: activeId,
    projects: projectList(),
    // This server's window (main or secondary) and the secondary windows it has opened.
    window: { child: isChild, port, mainPort },
    openWindows: openWindowList(),
    dataDir: data,
    themes,
    // Thể loại để nhóm thư viện skill trong tab Đạo diễn.
    promptGenres: GENRES,
    templates: listTemplates(),
    nodes: db.nodes.map(n => ({
      ...n,
      // Stable studio-facing identifiers. Legacy UUID `id` remains the internal graph key.
      studioId: n.terminal
        ? `render-${n.source || n.id}`
        : n.role === 'scene' || n.zone === 'design'
          ? `scene-${n.id}`
          : n.zone === 'production' || n.zone === 'merged' || n.zone === 'lipsync'
            ? `shot-${n.id}`
            : `asset-${n.id}`,
      assetId: !n.terminal ? `asset-${n.id}` : undefined,
      sceneId: n.role === 'scene' || n.zone === 'design' ? `scene-${n.id}` : undefined,
      shotId:
        !n.terminal && ['production', 'merged', 'lipsync'].includes(nodeZone(n))
          ? `shot-${n.id}`
          : undefined,
      renderId: n.terminal ? `render-${n.id}` : undefined,
      versionLabel: n.version ? `v${Number(n.version) || 1}` : undefined,
      videoInput: ['refs', 'mix'].includes(n.videoInput) ? n.videoInput : 'self',
      // Chế độ 'mix': nhân vật nào được tick gửi kèm ảnh khung, và còn tick thêm được mấy người.
      videoRefPick: Array.isArray(n.videoRefPick) ? n.videoRefPick : [],
      mixedRoom: 'duration' in n ? mixedRoom(n) : undefined,
      zone: nodeZone(n),
      resolvedPrompts: prompts(n),
      references: assetRefs(n),
      providers: providers(n),
      imageInputs: imageParents(n).length,
      settingInputs: settingParents(n).length,
      videoRefLimit: videoRefLimit(n),
      videoNeedsKeyframe: videoNeedsKeyframe(n),
      // A Seedance group: its shots on the timeline, the images sent, the render length.
      seedance: isGroup(n) ? groupInfo(n) : undefined,
      // A merged scene: its frames in cut order with their seconds, and what still blocks it.
      merged: isMerged(n) ? { ...mergedInfo(n), uncertain: uncertainJobs(n).length } : undefined,
      // A screenplay node: the stations of the mode it is set to, so the inspector can list
      // them (and offer "run on from here") without duplicating their labels in the browser.
      // A wired music node switches the studio to its MV stations.
      runStages:
        n.kind === 'script'
          ? stages(n.mode === 'full' ? 'full' : 'fast', studioKind(n)).map(s => [s.key, s.label])
          : undefined,
      studioKind: n.kind === 'script' ? studioKind(n) : undefined,
      // A shot keeping a staged set's marks: the set, the framing the tool chose, its capture.
      stagePin: stagePin(n),
      stageOnly: isStageOnly(n) || undefined,
    })),
  };
}
