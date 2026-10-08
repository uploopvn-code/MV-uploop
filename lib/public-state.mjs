// The state object sent to the browser.
import { catalog as seedvisCatalog, defaultSeedvis } from '../seedvis-client.mjs';
import { themes } from '../templates.mjs';
import { missingVideoIds, uncertainJobs } from './auto.mjs';
import { groupInfo, isGroup } from './seedance.mjs';
import { isMerged, mergedInfo } from './merged.mjs';
import { data, isChild, mainPort, port, seedvis } from './config.mjs';
import { assetRefs, imageParents, isStageOnly, settingParents } from './nodes.mjs';
import { notePins, stagePin } from './stage3d.mjs';
import { activeId, db, projectList } from './projects.mjs';
import { prompts } from './prompts.mjs';
import { providers, videoNeedsKeyframe, videoRefLimit } from './providers.mjs';
import { openWindowList } from './windows.mjs';
import { listTemplates } from './user-templates.mjs';
import { nodeZone } from './zones.mjs';

export function publicState() {
  notePins(); // (a project's first look: what each shot's stage marks are, before anything changes)
  const videoGaps = missingVideoIds();
  const now = Date.now();
  // Several browsers/accounts can each be a web worker; count the ones seen recently.
  const workerCount = Object.values(db.workers || {}).filter(t => now - t < 20000).length;
  return {
    ...db,
    worker: db.worker ? { ...db.worker, online: workerCount > 0, count: workerCount } : null,
    seedvisConfigured: seedvis.configured(),
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
    templates: listTemplates(),
    nodes: db.nodes.map(n => ({
      ...n,
      videoInput: n.videoInput === 'refs' ? 'refs' : 'self',
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
      // A shot keeping a staged set's marks: the set, the framing the tool chose, its capture.
      stagePin: stagePin(n),
      stageOnly: isStageOnly(n) || undefined,
    })),
  };
}
