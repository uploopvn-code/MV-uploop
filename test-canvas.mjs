import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const events = {},
  store = {};
const node = { style: {}, dataset: { graphId: 'a' } };
const svg = { innerHTML: '' },
  canvas = { style: {} },
  viewport = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
    addEventListener: (n, f) => (events[n] = f),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
const els = {
  '.graph-scroll': viewport,
  '#graphCanvas': canvas,
  '#graphCanvas .wires': svg,
  '#zoomValue': { textContent: '' },
  '#zoomIn': {},
  '#zoomOut': {},
  '#fitCanvas': {},
  '#arrangeZones': {},
};
let connected;
// The canvas module restores its view and node positions from localStorage.
const saved = {
  view: { x: 0, y: 0, z: 2 },
  positions: { a: { x: 30, y: 40 }, b: { x: 300, y: 40 } },
};
const context = {
  console,
  Math,
  JSON,
  localStorage: {
    getItem: k => (k === 'mv-canvas-v2' ? JSON.stringify(saved) : null),
    setItem: (k, v) => (store[k] = v),
  },
  // What public/js/canvas.js imports from the other modules.
  toast() {},
  render() {},
  workflowBusy: () => false,
  card: () => '',
  hasVideoPort: () => false,
  videosOf: () => [],
  shownClip: () => null,
  showClip: () => null,
  esc: s => String(s),
  paint: () => true,
  ZONES: [],
  CLIP_ZONES: ['output', 'seedance-video'],
  ZONE_W: 300,
  zoneLayout: () => ({}),
  setTimeout: f => f(),
  requestAnimationFrame: f => f(),
  store: { state: { edges: [], nodes: [] }, selected: null, dirty: false },
  $: s => els[s] || {},
  document: {
    addEventListener() {},
    querySelector: () => node,
    querySelectorAll: () => [],
    elementFromPoint: () => ({
      closest: () => ({ dataset: { portIn: 'b' }, classList: { add() {}, remove() {} } }),
    }),
  },
  api: async (url, options) => {
    connected = options.body.edges;
    return { edges: connected };
  },
};
vm.createContext(context);
// Run the module as a script: its imports are the stubs above (a new import in canvas.js
// needs a stub here). Git may check the file out with CRLF line ends.
const code = fs
  .readFileSync(new URL('./public/js/canvas.js', import.meta.url), 'utf8')
  .replace(/^import [^;]+;\r?\n/gm, '')
  .replace(/^export /gm, '');
vm.runInContext(code, context);
// Module-level const/let are not properties of the context: read them through the script.
const view = () => vm.runInContext('graphView', context);
const positions = () => vm.runInContext('savedPositions', context);
const evt = (x, y, target) => ({
  button: 0,
  clientX: x,
  clientY: y,
  pointerId: 1,
  target,
  preventDefault() {},
});
const header = { closest: s => (s === '.graph-node' ? node : s === '.node-top' ? {} : null) };
events.pointerdown(evt(100, 100, header));
events.pointermove(evt(140, 120, header));
await events.pointerup(evt(140, 120, header));
assert.equal(positions().a.x, 50);
assert.equal(positions().a.y, 50);
const background = { closest: () => null };
events.pointerdown(evt(100, 100, background));
events.pointermove(evt(160, 130, background));
await events.pointerup(evt(160, 130, background));
assert.equal(view().x, 60);
assert.equal(view().y, 30);
const before = context.worldPoint(400, 300);
context.zoomAt(0.5, 400, 300);
const after = context.worldPoint(400, 300);
assert.equal(before.x, after.x);
assert.equal(before.y, after.y);
const port = { dataset: { portOut: 'a' } },
  target = { closest: s => (s === '[data-port-in],[data-port-out]' ? port : node) };
events.pointerdown(evt(100, 100, target));
events.pointermove(evt(300, 200, target));
await events.pointerup(evt(300, 200, target));
await new Promise(r => setImmediate(r));
assert.equal(connected[0].source, 'a');
assert.equal(connected[0].target, 'b');
assert.ok(store['mv-canvas-v2']);
console.log(
  'PASS: node drag at 200%, pan, cursor-anchored zoom, wire drop sends correct edge, layout persistence',
);
