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
};
let connected;
const context = {
  console,
  Math,
  JSON,
  localStorage: { setItem: (k, v) => (store[k] = v) },
  toast() {},
  render() {},
  setTimeout: f => f(),
  graphView: { x: 0, y: 0, z: 2 },
  savedPositions: { a: { x: 30, y: 40 }, b: { x: 300, y: 40 } },
  gesture: null,
  suppressNodeClick: false,
  selectedEdge: null,
  connectSource: null,
  state: { edges: [] },
  $: s => els[s],
  document: {
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
const code = fs
  .readFileSync(new URL('./public/app.js', import.meta.url), 'utf8')
  .split(/(?=function persistCanvas\(\)\s*\{)/)[1];
vm.runInContext(code, context);
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
assert.equal(context.savedPositions.a.x, 50);
assert.equal(context.savedPositions.a.y, 50);
const background = { closest: () => null };
events.pointerdown(evt(100, 100, background));
events.pointermove(evt(160, 130, background));
await events.pointerup(evt(160, 130, background));
assert.equal(context.graphView.x, 60);
assert.equal(context.graphView.y, 30);
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
assert.ok(store['mv-canvas-v1']);
console.log(
  'PASS: node drag at 200%, pan, cursor-anchored zoom, wire drop sends correct edge, layout persistence',
);
