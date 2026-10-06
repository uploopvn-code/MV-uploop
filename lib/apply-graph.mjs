// Applies a director-built graph to the open project, reusing library images.
import { themes } from '../templates.mjs';
import {
  keepLibraryImages,
  pullAssetImages,
  pullFromFolder,
  reuseLibraryImages,
} from './library.mjs';
import { db, mutate, normalize } from './projects.mjs';

// Replaces the active project's graph with a built one (keeps audio/fields/output).
export function applyGraph(graph) {
  // Keep this project's character/scene images (keyed by blueprint key) before replacing the
  // graph, then re-attach them to the new sequence so shared assets are not regenerated.
  keepLibraryImages(db.nodes);
  db.nodes = graph.nodes;
  db.edges = graph.edges;
  db.graphReused = reuseLibraryImages(db.nodes); // surfaced to the UI so it can report how many assets were reused
  db.film = graph.film || null; // sequences of one film share their assets across projects
  db.graphReusedFolder = pullFromFolder(); // reference images already in the working folder
  // With a working folder, that folder is the single source: a new sequence must not
  // silently inherit another project's renders. Bringing them in is an explicit action
  // (the dialog after creating the project, or the buttons in the Đạo diễn tab).
  db.graphReusedOther = db.exportDir ? 0 : pullAssetImages();
  db.graphWarnings = graph.warnings || []; // non-fatal wiring problems (e.g. costume without character)
  if (graph.name) db.name = graph.name;
  if (graph.theme && themes.some(t => t.id === graph.theme)) db.theme = graph.theme;
  db.autoRun = null;
  db.autoVideoRun = null;
  db.autoImageRun = null;
  db.jobs = [];
  normalize(db);
  mutate();
}
