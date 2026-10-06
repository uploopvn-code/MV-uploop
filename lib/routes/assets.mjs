// Routes: reference library (pull, clear, import folder, inspect folder).
import { validateDirectory } from '../../output-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { NEXT, body, json } from '../http.mjs';
import { requireIdle } from '../jobs.mjs';
import {
  exportRoot,
  folderLibrary,
  forgetLibrary,
  importFolder,
  libraryNodes,
  pullAssetImages,
} from '../library.mjs';
import { activeId, db, mutate, projectDbFile, ws } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { flagClips, markChildren } from '../staleness.mjs';

export async function handle(req, res, p, u) {
  // Take the images of this film's characters / scenes / costumes rendered in other
  // projects after this one was built (nodes that still have no image).
  if (p === '/api/assets/pull' && req.method === 'POST') {
    requireIdle();
    const pulled = pullAssetImages();
    if (pulled) mutate();
    return json(res, 200, { ...publicState(), pulled });
  }
  // Working folders: what reference images a folder already holds, plus the folders of the
  // other projects (sources to bring a library in from).
  if (p === '/api/folders/inspect' && req.method === 'GET') {
    const dir = validateDirectory(u.searchParams.get('dir'));
    const lib = folderLibrary(dir);
    const sources = ws.order
      .filter(id => id !== activeId)
      .map(id => {
        try {
          const d = JSON.parse(fs.readFileSync(projectDbFile(id), 'utf8'));
          const images = d.exportDir ? folderLibrary(d.exportDir).size : 0;
          return images ? { id, name: d.name, exportDir: d.exportDir, images } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return json(res, 200, {
      dir,
      exists: fs.existsSync(dir),
      images: lib.size,
      keys: [...lib.keys()].slice(0, 200),
      sources,
    });
  }
  // Start fresh: drop the images attached to the library nodes (characters, costumes,
  // scenes, angles). The files stay in the project's media and in the working folder.
  if (p === '/api/assets/clear' && req.method === 'POST') {
    requireIdle();
    let cleared = 0;
    for (const n of libraryNodes())
      if (n.image) {
        n.image = null;
        n.stale = false;
        n.prevImage = null; // starting fresh: no swap back to an image from before
        n.prevStale = false;
        flagClips(n);
        markChildren(n.id);
        cleared++;
      }
    // …and forget them, so the next build does not re-attach the same images.
    if (cleared) {
      forgetLibrary();
      mutate();
    }
    return json(res, 200, { ...publicState(), cleared });
  }
  // Bring another folder's reference images (thu-vien/…) into this project's folder + nodes.
  if (p === '/api/assets/import-folder' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const src = validateDirectory(b.dir);
    if (!fs.existsSync(src)) throw new Error('Thư mục nguồn không tồn tại.');
    if (path.resolve(src) === path.resolve(exportRoot()))
      throw new Error('Đó chính là thư mục của project này.');
    const r = importFolder(src);
    if (r.attached) mutate();
    return json(res, 200, { ...publicState(), ...r });
  }
  return NEXT;
}
