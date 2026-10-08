// Keeps every staged node's 3D capture current without the user opening the editor: after each
// new state, the nodes whose framing has no capture yet (a shot added, re-imported or edited since
// the stage was pinned — `stagePin.capture === 'missing'`, decided by the server) are rendered
// offscreen, one picture per framing, and sent to /api/stage3d/captures. three.js loads only when
// there is something to capture.
import { store } from './store.js';
import { api } from './core.js';

let busy = null; // the capture run under way
let seen = null; // the state last looked at
let off = false; // no WebGL here: the shots keep their blocking text only
// project + node → the framing the server was sent for it (and answered): never sent twice — a
// framing it refused stays refused until the node's framing changes
const tried = new Map();

export function keepCaptures(render) {
  const state = store.state;
  if (off || busy || !state?.nodes || state === seen) return;
  // the editor holds a stage not pinned yet; it captures everything itself when it pins
  if (document.getElementById('s3d')) return;
  seen = state;
  const project = state.activeProjectId;
  const byId = new Map(state.nodes.map(n => [n.id, n]));
  const todo = new Map(); // set + framing → { stage, cam, sig, shotIds }
  for (const n of state.nodes) {
    const pin = n.stagePin;
    if (pin?.capture !== 'missing' || tried.get(project + '|' + n.id) === pin.sig) continue;
    const stage = byId.get(pin.setId)?.stage3d;
    if (!stage?.performers?.length) continue;
    const key = pin.setId + '|' + pin.sig;
    if (!todo.has(key)) todo.set(key, { stage, cam: pin.cam, sig: pin.sig, shotIds: [] });
    todo.get(key).shotIds.push(n.id);
  }
  if (!todo.size) return;
  busy = run([...todo.values()], project, render).finally(() => {
    busy = null;
    // what changed while this run worked (a newer state) is looked at now
    keepCaptures(render);
  });
}
async function run(list, project, render) {
  let images;
  try {
    const { captureFramings } = await import('./stage-scene.js');
    images = await captureFramings(list);
  } catch (e) {
    off = true;
    console.warn('3D capture unavailable — shots keep their blocking text only.', e);
    return;
  }
  if (store.state?.activeProjectId !== project) return;
  try {
    store.state = await api('/api/stage3d/captures', {
      method: 'POST',
      body: {
        projectId: project,
        captures: list.map((c, i) => ({ sig: c.sig, shotIds: c.shotIds, image: images[i] })),
      },
    });
    for (const c of list) for (const id of c.shotIds) tried.set(project + '|' + id, c.sig);
    render();
  } catch (e) {
    console.warn('3D captures not stored:', e.message);
  }
}
// Resolves once every capture under way is stored (a run started by the last one included) —
// awaited before an image job is sent, so a node just added or edited goes out with its capture.
export async function capturesReady() {
  while (busy) await busy;
}
