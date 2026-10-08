// The 3D stage of a set on the server: which nodes keep a staged set's marks, the blocking text
// their prompts carry (positions as THIS node's camera sees them), and the capture of that exact
// framing sent as a layout reference. The geometry is public/js/stage-math.js — the same module
// the browser draws and captures with, so text and pictures always agree. The set is whatever
// staged set a node uses (a 3D stage node wired into it or into its location); its framing comes
// from the node itself, so pinning the stage once is all the user does.
import { afterEachChange, db } from './projects.mjs';
import { assetRefs, deps, getNode, imageParents, isCharacter, isSetting } from './nodes.mjs';
import { flagClips, markChildren, markStale } from './staleness.mjs';
import { nodeZone } from './zones.mjs';
import {
  beatSpecs,
  blockingText,
  cameraTextOf,
  colorLegend,
  inFrame,
  isStaged,
  layoutSig,
  setOf,
  shotCamera,
  wiredPeople,
} from '../public/js/stage-math.js';

// A set: a master scene (not one of its angle plates).
export const isSet = n =>
  !!n &&
  !n.terminal &&
  n.kind !== 'setting' &&
  n.role !== 'angle' &&
  (n.role === 'scene' || nodeZone(n) === 'design');
// A shot filmed on a set: a storyboard shot or a lip-sync take (not a group / merged / frame).
export const isShot = n =>
  !!n &&
  !n.terminal &&
  n.kind !== 'setting' &&
  n.kind !== 'music' &&
  ('duration' in n || n.role === 'lipsync') &&
  !['seedance', 'merged', 'frame'].includes(n.role);
export const graph = {
  node: getNode,
  // every wired node but the settings — a 3D stage node (no picture) included
  parents: id =>
    deps(id)
      .map(getNode)
      .filter(s => s && !isSetting(s)),
  isPerson: isCharacter,
  isSet,
  cameraText: id => cameraTextOf(deps(id).map(getNode)),
};
// The shots filmed on this set.
export const shotsAt = setId => db.nodes.filter(n => isShot(n) && setOf(n.id, graph)?.id === setId);
const WIDE = { target: null, size: 'WS', angle: { kind: 'eye', side: 0 } };
// A shot on a staged set: the set, its stage, how its image frames it (`spec`, null for an insert
// the stage plays no part in), whether any of its beats shows the stage (`map`) and whether a beat
// after the opening one does (`later`: the clip cuts to the band) — null off a staged set.
export function staging(n) {
  if (!isShot(n)) return null;
  const set = setOf(n.id, graph);
  if (!isStaged(set)) return null;
  const stage = set.stage3d;
  const specs = beatSpecs(n, stage, graph);
  return {
    set,
    stage,
    spec: specs[0],
    map: specs.some(Boolean),
    later: specs.slice(1).some(Boolean),
  };
}
// What a capture of this shot's framing is filed under: the set, its revision and the framing (a
// capture of another set's stage never passes for this one's).
export const sigOf = st => `${st.set.id}:${layoutSig(st.stage, st.spec)}`;
// Image models take at most this many reference images (Nano Banana, GPT Image: 10): the layout
// capture only goes along when it fits after the shot's own references.
export const LAYOUT_MAX = 10;
// The capture of this shot's exact framing, as a reference to send last — when the shot has one
// for the current stage and it fits.
export function layoutRef(n, st = staging(n)) {
  if (!st?.spec || !n.layout?.asset || n.layout.sig !== sigOf(st)) return null;
  if (assetRefs(n).length + 1 > LAYOUT_MAX) return null;
  return { role: 'layout', asset: n.layout.asset };
}
export const BLOCK_MARK = 'Stage blocking —';
export const LAYOUT_MARK = 'is a 3D blocking sketch';
// The capture's sentence in an image prompt — what a prompt made before / after the capture came
// differs by (madeFromCurrentInputs: the same shot, the same marks).
const CAPTURE_RE = new RegExp(
  `\\s*\\[\\d+\\] \\(the last attached image\\) ${LAYOUT_MARK}[^]*?Mannequin colours:[^.]*\\.`,
  'g',
);
export const withoutCapture = s => String(s || '').replace(CAPTURE_RE, '');
// The blocking lines of a shot's prompts. `cast` is the shot's reference list (castOf): a wired
// performer is named with its image number, anyone else on stage by name. A video filmed from
// references gets the stage map as the audience sees it; one filmed from the keyframe only when
// it cuts to the band later (named without numbers: it is sent one image, the keyframe).
export function stageLines(n, cast, label, fromKeyframe = false) {
  const st = staging(n);
  if (!st) return null;
  // (null for a character deleted since the stage was saved: not named, not described; a name
  // keeps no full stop — the sentence ends at the first one, and so do the patterns that find it)
  const bare = s => String(s).replace(/\./g, '');
  const named = numbered => id => {
    const c = cast.find(x => x.person && x.node?.id === id);
    if (c) return numbered ? `${bare(c.label)} [${c.index}]` : bare(c.label);
    const node = getNode(id);
    return node && isCharacter(node) ? bare(label(node) || 'a performer') : null;
  };
  const labelOf = named(true);
  const ref = layoutRef(n, st);
  const map = (fromKeyframe ? st.later : st.map)
    ? blockingText(st.stage, WIDE, named(!fromKeyframe)).replace(
        'Seen from this camera:',
        'Stage map, as seen from the audience:',
      )
    : '';
  return {
    // the image: the marks as this shot's camera sees them, and the capture of that framing
    image: st.spec
      ? blockingText(st.stage, st.spec, labelOf) +
        (ref
          ? ` [${assetRefs(n).length + 1}] (the last attached image) ${LAYOUT_MARK} of this exact framing: copy only where each performer stands, which way they face and the camera angle — not the grey stage, grid, mannequins or their colours. Mannequin colours: ${colorLegend(st.stage, labelOf)}.`
          : '')
      : '',
    video: map,
  };
}
// The performers a band framing of this shot shows that are not wired to it yet (a wide must hold
// every one of them with their own reference, not invented faces) — as many as fit beside the
// shot's references and its capture in one image request, nearest the middle of the frame first.
export function missingCast(n) {
  const st = staging(n);
  if (!st?.spec || st.spec.target || st.spec.group) return [];
  const wired = new Set(wiredPeople(n.id, graph));
  const room = Math.max(0, LAYOUT_MAX - 1 - imageParents(n).length);
  const add = inFrame(st.stage, shotCamera(st.stage, st.spec))
    .filter(s => !wired.has(s.p.id) && isCharacter(getNode(s.p.id)))
    .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))
    .slice(0, room)
    .map(s => s.p.id);
  // one performer of a band alone would make the node "theirs" (its framing would follow)
  const onStage = st.stage.performers.filter(p => wired.has(p.id)).length;
  return onStage + add.length === 1 && st.stage.performers.length > 1 ? [] : add;
}
// Wire them (after the people already wired, before nothing else changes). Returns how many.
export function wireStageCast(n) {
  const add = missingCast(n);
  for (const id of add) db.edges.push({ source: id, target: n.id });
  return add.length;
}
// What the UI shows on a shot that keeps a staged set's marks (and what the browser captures):
// the set, the framing the tool chose, and whether its capture is current, missing (the browser
// renders it) or left out (no room beside the shot's own references).
export function stagePin(n) {
  const st = staging(n);
  if (!st) return undefined;
  const pin = { setId: st.set.id, setName: st.set.name, map: st.map };
  if (!st.spec) return pin;
  const sig = sigOf(st);
  const fits = assetRefs(n).length + 1 <= LAYOUT_MAX;
  return {
    ...pin,
    size: st.spec.size,
    angle: st.spec.angle,
    target: st.spec.target?.id || null,
    group: st.spec.group || null,
    sig,
    cam: shotCamera(st.stage, st.spec),
    capture: !fits ? 'full' : n.layout?.sig === sig ? 'sent' : 'missing',
    refNo: fits ? assetRefs(n).length + 1 : null,
  };
}

// --- Out of date --------------------------------------------------------------------------------
// A shot's picture is out of date when the marks IT sees change: its set, its framing, or where
// the performers in its frame stand / face — by id, so renaming someone or a capture arriving
// (the same marks, now also as a picture) does not count. Its clips are out of date when the stage
// map they were filmed with changes.
// (an insert the stage plays no part in has none: pinning or unpinning its set changes nothing)
const keyOf = st => {
  if (!st?.spec) return '';
  const id = x => (isCharacter(getNode(x)) ? x : null);
  return `${st.set.id}|${blockingText(st.stage, st.spec, id)}`;
};
// the stage map exactly when the node's video prompt carries it (lib/prompts.mjs, stageLines)
const mapOf = (n, st) => {
  if (!st || n.role === 'lipsync') return '';
  const fromKeyframe = 'duration' in n && !(n.videoInput === 'refs' && !n.image);
  if (!(fromKeyframe ? st.later : st.map)) return '';
  const id = x => (isCharacter(getNode(x)) ? x : null);
  return blockingText(st.stage, WIDE, id);
};
// Run after every change (whatever route made it): marks the shots whose marks moved out of date.
// A shot that newly joins a staged set (or is new) gets the band it shows wired in — once: a
// performer the user unwires later stays unwired. The first run on an old project only takes
// note. Returns the shots marked that already had a picture or a clip, and how many wires it added.
export function reconcilePins() {
  const marked = [];
  let wired = 0;
  for (const n of db.nodes) {
    if (!isShot(n)) {
      delete n.pinKey;
      delete n.pinMap;
      continue;
    }
    let st = staging(n);
    const was = n.pinKey;
    const joined =
      st && (was === undefined ? !n.image && !n.video : !was.startsWith(st.set.id + '|'));
    const added = joined ? wireStageCast(n) : 0;
    if (added) {
      wired += added;
      st = staging(n);
    }
    const key = keyOf(st),
      map = mapOf(n, st);
    if (was !== undefined && was !== key) {
      if (n.image || n.video) marked.push(n);
      markStale(n);
      markChildren(n.id);
    } else if (n.pinMap !== undefined && n.pinMap !== map) flagClips(n);
    n.pinKey = key;
    n.pinMap = map;
  }
  return { marked, wired };
}
afterEachChange(reconcilePins);
// Takes note of the marks every shot sees, where it has none noted yet (a project opened for the
// first time since this existed) — so the first change made to it already tells which pictures it
// ages. Nothing is wired or aged here.
export function notePins() {
  for (const n of db.nodes)
    if (isShot(n) && n.pinKey === undefined) {
      const st = staging(n);
      n.pinKey = keyOf(st);
      n.pinMap = mapOf(n, st);
    }
}
