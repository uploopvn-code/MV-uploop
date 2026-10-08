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
  ZONES: [
    { id: 'character', label: 'Nhân vật' },
    { id: 'wardrobe', label: 'Trang phục' },
    { id: 'design', label: 'Bối cảnh' },
    { id: 'output', label: 'Video' },
  ],
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

// A short horizontal drag is confined to the source zone and does not change its zone.
context.store.state.nodes = [{ id: 'a', zone: 'character', name: 'Nhân vật' }];
context.store.state.edges = [];
context.store['mv-canvas-v2'] = null;
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

// --- The two-lane time strip under the canvas (public/js/render.js) -----------------------------
// Lane A = luồng phủ cảnh (⑥), lane B = câu hát nhép (⑪). The real zones.js runs here, so the
// strip is driven by the same nodeStream / nodeTime the server mirrors.
const load = (file, ctx) => {
  vm.createContext(ctx);
  vm.runInContext(
    fs
      .readFileSync(new URL('./public/js/' + file, import.meta.url), 'utf8')
      .replace(/^import [^;]+;\r?\n/gm, '')
      .replace(/^import [^;]+\{[^}]*\}[^;]*;\r?\n/gms, '')
      .replace(/^export /gm, ''),
    ctx,
  );
  return ctx;
};
const zonesCtx = load('zones.js', {
  console,
  Math,
  JSON,
  store: { state: { nodes: [], edges: [] } },
});
const nodeStream = vm.runInContext('nodeStream', zonesCtx);
const nodeTime = vm.runInContext('nodeTime', zonesCtx);
const STREAM_LABEL = vm.runInContext('STREAM_LABEL', zonesCtx);
// A real project's shape: ⑥ tiles the song, ⑪ runs 7–10 s takes alongside — and two takes whose
// cuts run into each other, which the strip has to SHOW rather than hide.
const graph = {
  name: 'MV thử',
  jobs: [],
  edges: [],
  nodes: [
    { id: 'm', kind: 'music', zone: 'audio', name: 'Bài hát', audioDuration: 30 },
    { id: 'a1', zone: 'production', name: 'Shot 001 — Verse', start: 0, duration: 8.15 },
    { id: 'a2', zone: 'production', name: 'Shot 002 — Verse', start: 8.15, duration: 9.288 },
    { id: 'a3', zone: 'production', name: 'Shot 003 — Chorus', start: 17.438, duration: 6.362 },
    {
      id: 'b1',
      zone: 'lipsync',
      role: 'lipsync',
      name: 'LS 001',
      clipStart: 2,
      clipEnd: 9.2,
      lyric: 'Hubo un tiempo',
    },
    {
      id: 'b2',
      zone: 'lipsync',
      role: 'lipsync',
      name: 'LS 002',
      clipStart: 9,
      clipEnd: 16.5,
      lyric: 'hablaba con Dios',
    },
    { id: 'ch', zone: 'character', name: 'Ca sĩ' },
    {
      id: 'c1',
      zone: 'output',
      terminal: true,
      source: 'a1',
      name: 'Shot 001 v1',
      start: 0,
      duration: 8.15,
    },
  ],
};
const painted = {};
const renderCtx = load('render.js', {
  console,
  Math,
  JSON,
  Number,
  String,
  store: { state: graph },
  nodeStream,
  nodeTime,
  esc: s => String(s ?? ''),
  paint: (sel, html) => (painted[sel] = html),
  $: () => ({ classList: { toggle() {} }, style: {} }),
  api: async () => graph,
  workflowBusy: () => false,
  renderGraph() {},
  suppressNodeClick: false,
  loadDirector() {},
  renderGallery() {},
  renderJobs() {},
  renderProjects() {},
  inspect() {},
  upload() {},
  orbitStatus: null,
  paintDefaults() {},
  showOrbit() {},
  keepCaptures() {},
  document: { querySelectorAll: () => [] },
});
const strip = vm.runInContext('timelineStrip', renderCtx);
let html = strip();
assert.equal((html.match(/class="lane-row"/g) || []).length, 2, 'two lanes: luồng A and luồng B');
assert.match(html, /class="lane a"/);
assert.match(html, /class="lane b"/);
assert.equal((html.match(/data-node="a\d"/g) || []).length, 3, 'lane A holds the three shots');
assert.equal((html.match(/data-node="b\d"/g) || []).length, 2, 'lane B holds the two takes');
assert.ok(!/data-node="ch"/.test(html), 'an asset has no time, so no block');
assert.ok(!/data-node="c1"/.test(html), 'a clip is not a second block of its own source');
// Blocks are placed by time over the song's length (30 s), not spread evenly.
assert.match(html, /data-node="a2"[^>]*left:27\.167%/, 'shot 2 starts at 8.15 of 30 s');
assert.match(html, /data-node="a2"[^>]*width:30\.960%/, 'and is 9.288 s wide');
assert.match(html, /data-node="b1"[^>]*left:6\.667%/, 'take 1 starts at 2 s');
assert.match(html, /data-node="b1"[^>]*top:2px/, 'first take in the lane’s first row');
// The second take's cut runs into the first: it drops a row and is outlined, with a warning.
assert.match(html, /class="blk over" data-node="b2"/, 'the overlapping take is marked');
assert.match(html, /data-node="b2"[^>]*top:26px/, 'and offset onto the second row');
assert.match(html, /chồng thời gian/, 'its tooltip says the blocks overlap');
assert.match(html, /class="lane b" style="height:52px"/, 'lane B grew for the second row');
assert.match(html, /class="lane a" style="height:28px"/, 'lane A stayed one row: its shots tile');
assert.match(html, /<span>0:00<\/span>/);
assert.match(html, /<span>0:30<\/span>/, 'the scale ends at the song length');
assert.match(html, /LS 001|Hubo un tiempo/, 'a take block is labelled by its line');
// Nothing timed yet (a fresh project): the strip paints nothing instead of an empty frame.
graph.nodes = [{ id: 'ch', zone: 'character', name: 'Ca sĩ' }];
assert.equal(strip(), '');
// render() paints the strip into the markup that used to be `hidden` and never filled.
graph.nodes = [{ id: 'a1', zone: 'production', name: 'Shot 001', start: 0, duration: 8 }];
vm.runInContext('render', renderCtx)();
assert.match(painted['#timelineTrack'], /class="lane a"/, 'render() fills #timelineTrack');

console.log(
  'PASS: node drag at 200%, pan, cursor-anchored zoom, wire drop sends correct edge, layout ' +
    'persistence, the two-lane time strip (luồng A / luồng B placed by time, overlap offset and ' +
    'marked, empty project paints nothing)',
);
