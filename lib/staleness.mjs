// Out-of-date tracking: which images and clips were made from inputs that changed since.
// setImage() is the one way a node gets a new image (generated, edited or uploaded): it keeps
// the previous image, marks what depends on it out of date, and saves it to the library and
// the working folder (library.mjs rememberAndExport).
import { rememberAndExport } from './library.mjs';
import { deps, getNode } from './nodes.mjs';
import { db } from './projects.mjs';

// A node "has a video" when it carries one itself (Orbit) or has produced clip nodes.
// The clip lives in the Video column, but going out of date is still the shot's business:
// that is where the card warns "Đầu vào đã thay đổi".
export const clipsOf = id => db.nodes.filter(t => t.terminal && t.source === id && t.video);
const hasClips = id => clipsOf(id).length > 0;
const hasVideo = n => !!n.video || hasClips(n.id);
// The inputs of a shot's clips just changed: every clip it has is out of date, and the card
// warns until a new one is made. Each clip remembers it, so deleting the newest clip brings
// the warning back when the ones left are old.
export function flagClips(n) {
  // Counted even without clips yet: a job that was running when it moved made its result
  // from the old inputs (see inputsMoved).
  n.inputRev = (n.inputRev || 0) + 1;
  const clips = clipsOf(n.id);
  for (const c of clips) c.outdated = true;
  if (clips.length) n.videoStale = true;
}
// A node's inputs changed: its image, the image kept for "swap back", and its clips all
// predate the change.
export function markStale(n) {
  if (n.image || n.video) n.stale = true;
  if (n.prevImage) n.prevStale = true;
  flagClips(n);
}
export function markChildren(id) {
  for (const n of db.nodes)
    if (!n.terminal && deps(n.id).includes(id)) {
      markStale(n);
      if (n.id !== id) markChildren(n.id);
    }
}
export function markAll() {
  for (const n of db.nodes) if (!n.terminal) markStale(n);
}
// Puts a new image on a node. The one it replaces is kept with its own out-of-date flag, so
// a disappointing edit or re-roll can be swapped back; the clips and the nodes it feeds were
// made from the old image.
export function setImage(n, asset, stale) {
  if (n.image) {
    n.prevImage = n.image;
    n.prevStale = !!n.stale;
  }
  n.image = asset;
  n.stale = !!stale;
  flagClips(n);
  markChildren(n.id);
  rememberAndExport(n);
}
// Did the node's inputs change while this job ran: its keyframe edited, a parent re-rolled,
// an input gone out of date or rewired? A result does not bump the project revision, so
// without this a clip or image made from the old inputs would come back looking fresh.
export const inputsMoved = j =>
  j.payload.inputRev !== undefined && (getNode(j.nodeId)?.inputRev || 0) !== j.payload.inputRev;
