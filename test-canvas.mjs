import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const coreState = { jobs: [{ status: 'running', kind: 'image' }] };
const coreContext = vm.createContext({ store: { state: coreState } });
vm.runInContext(
  fs
    .readFileSync(new URL('./public/js/core.js', import.meta.url), 'utf8')
    .replace(/^import [^;]+;\r?\n/gm, '')
    .replace(/^export /gm, ''),
  coreContext,
);
assert.equal(
  vm.runInContext('workflowBusy()', coreContext),
  false,
  'a single job does not lock the workflow',
);
assert.equal(
  vm.runInContext('workflowProcessing()', coreContext),
  true,
  'the UI still shows processing',
);
coreState.autoImageRun = { status: 'running', pending: ['shot-4'] };
coreState.edges = [{ source: 'scene-1', target: 'shot-4' }];
assert.equal(
  vm.runInContext('workflowBusy()', coreContext),
  true,
  'an automatic chain keeps its structural lock',
);
assert.equal(
  vm.runInContext('workflowNodeLocked("scene-1")', coreContext),
  true,
  'a parent of an active shot is protected',
);
assert.equal(
  vm.runInContext('workflowNodeLocked("unrelated")', coreContext),
  false,
  'unrelated nodes remain editable',
);
const events = {},
  store = {};
const node = { style: {}, dataset: { graphId: 'a' } };
const svg = { innerHTML: '' },
  // applyGraphView ghi biến --graph-z để nhãn cột chống-scale; stub style phải có setProperty.
  canvas = {
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
  },
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
    // The current layout key. It is bumped whenever a column is added (v3 = the "Kịch bản"
    // column), which deliberately drops pixel positions saved under the older keys.
    getItem: k => (k === 'mv-canvas-v4' ? JSON.stringify(saved) : null),
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
  zoneLayout: (hidden = new Set()) =>
    Object.fromEntries(
      context.store.state.nodes
        .filter(n => !hidden.has(n.id))
        .map((n, i) => [n.id, { x: (n.zone === 'seedance' ? 2 : 0) * 300 + 20, y: 74 + i * 285 }]),
    ),
  setTimeout: f => f(),
  requestAnimationFrame: f => f(),
  store: { state: { edges: [], nodes: [] }, selected: null, dirty: false },
  $: s => els[s] || {},
  // applyGraphView báo 'graphviewchange' để hướng dẫn đo lại ô khoanh vùng.
  CustomEvent: class {
    constructor(type) {
      this.type = type;
    }
  },
  document: {
    addEventListener() {},
    dispatchEvent() {},
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
context.store['mv-canvas-v4'] = null;
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
assert.ok(store['mv-canvas-v4']);

// Wheel controls: normal wheel remains native scrolling; Shift moves horizontally; Ctrl zooms
// around the cursor instead of handing the gesture to browser page zoom.
let prevented = 0;
const wheel = extra => ({
  clientX: 400,
  clientY: 300,
  deltaY: 120,
  deltaX: 0,
  preventDefault: () => prevented++,
  ...extra,
});
const scrollBefore = viewport.scrollLeft || 0;
events.wheel(wheel({}));
assert.equal(prevented, 0, 'normal wheel is not intercepted');
events.wheel(wheel({ shiftKey: true }));
assert.equal(prevented, 1, 'Shift wheel is intercepted for horizontal canvas travel');
assert.equal(viewport.scrollLeft, scrollBefore + 120);
const zoomBefore = view().z;
events.wheel(wheel({ ctrlKey: true }));
assert.equal(prevented, 2, 'Ctrl wheel is intercepted for canvas zoom');
assert.ok(view().z < zoomBefore, 'positive wheel delta zooms out');

// Collapsing a Seedance group is presentation-only: its member cards disappear while the group
// remains as the compact control point. The graph edges and stored node data stay intact.
context.store.state.nodes = [
  { id: 'group', role: 'seedance', zone: 'seedance', name: 'Seedance 01' },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: 'shot-' + i,
    zone: 'production',
    name: 'Shot ' + i,
  })),
];
context.store.state.edges = Array.from({ length: 10 }, (_, i) => ({
  source: 'shot-' + i,
  target: 'group',
}));
vm.runInContext("collapsedSeedanceGroups.add('group')", context);
const compact = vm.runInContext('displayLayout()', context);
assert.equal(
  Object.keys(compact.positions).length,
  1,
  'collapsed group hides all ten member cards',
);
assert.ok(compact.positions.group, 'the Seedance card remains as the compact block');
assert.match(
  vm.runInContext('nodeMarkup(store.state.nodes[0], { x: 620, y: 74 })', context),
  /▶ Mở 10 shot/,
);
vm.runInContext("collapsedSeedanceGroups.delete('group')", context);
assert.equal(
  Object.keys(vm.runInContext('displayLayout().positions', context)).length,
  11,
  'expanding restores all member cards',
);

// Collapsed canvas Groups keep their external graph flow: an edge between members of two
// Groups is drawn between the two compact cards. Only edges wholly inside one Group disappear.
context.store.state.nodes = [
  { id: 'a', zone: 'character', name: 'A' },
  { id: 'b', zone: 'character', name: 'B' },
  { id: 'c', zone: 'production', name: 'C' },
  { id: 'd', zone: 'production', name: 'D' },
];
context.store.state.edges = [
  { source: 'a', target: 'b' },
  { source: 'a', target: 'c' },
];
vm.runInContext(
  `canvasGroups = [
  { id: 'g-a', members: ['a', 'b'], collapsed: true, position: { x: 20, y: 74 } },
  { id: 'g-b', members: ['c', 'd'], collapsed: true, position: { x: 620, y: 74 } }
]`,
  context,
);
const grouped = vm.runInContext('globalThis.grouped = displayLayout()', context);
const groupedWires = vm.runInContext(
  'wiresMarkup({ ...grouped.positions, ...grouped.proxyPositions }, e => grouped.proxyGroupByNode[e.source] && grouped.proxyGroupByNode[e.source] === grouped.proxyGroupByNode[e.target])',
  context,
);
assert.doesNotMatch(
  groupedWires,
  /data-edge-source="a" data-edge-target="b"/,
  'an internal Group wire is hidden',
);
assert.match(
  groupedWires,
  /data-edge-source="a" data-edge-target="c"/,
  'an external wire remains between compact Groups',
);
vm.runInContext('canvasGroups = []', context);

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
const playedClips = [];
const playedOffsets = [];
// The preview now plays on a SONG CLOCK (rAF loop), not a per-clip montage. These mocks give the
// video/audio elements the small amount of state that loop reads, and `testNow` is the clock the
// loop reads through performance.now(); the rAF mock steps it on each frame (see below).
let testNow = 0;
let rafFirst = true; // the first frame plays at the cursor; later frames step the clock
const previewPlayer = {
  _src: '',
  readyState: 1,
  paused: true,
  muted: false,
  currentTime: 0,
  // A real <video> resets (pauses, seeks to 0) when its src changes — so the loop replays the new
  // clip. The mock mirrors that so playback switches clips the way the browser does.
  get src() {
    return this._src;
  },
  set src(v) {
    if (v !== this._src) {
      this._src = v;
      this.paused = true;
      this.currentTime = 0;
      this.readyState = 1;
    }
  },
  getAttribute(a) {
    return a === 'src' ? this._src : null;
  },
  setAttribute() {},
  pause() {
    this.paused = true;
  },
  play() {
    this.paused = false;
    playedClips.push(this._src);
    playedOffsets.push(this.currentTime);
    return Promise.resolve();
  },
};
const previewAudio = {
  src: '',
  muted: false,
  currentTime: 0,
  getAttribute(a) {
    return a === 'src' ? this.src : null;
  },
  setAttribute(a, v) {
    if (a === 'src') this.src = v;
  },
  removeAttribute() {
    this.src = '';
  },
  pause() {},
  play() {
    return Promise.resolve();
  },
};
const previewPanel = { hidden: true, scrollIntoView() {} };
const previewLabel = { textContent: '' };
const previewEls = {
  '#timelinePlayer': previewPlayer,
  '#timelinePreviewAudio': previewAudio,
  '#timelinePreview': previewPanel,
  '#timelinePreviewLabel': previewLabel,
};
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
  $: selector => previewEls[selector] || { classList: { toggle() {} }, style: {} },
  api: async () => graph,
  workflowBusy: () => false,
  workflowProcessing: () => false,
  toast() {},
  refresh: async () => {},
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
// The song-clock playback loop reads performance.now() and drives itself with requestAnimationFrame.
// Here the clock only moves when the rAF mock steps it: the FIRST frame runs at the cursor, each
// later frame advances the song by 2 s, so a finite number of frames covers the whole timeline.
renderCtx.performance = { now: () => testNow };
renderCtx.requestAnimationFrame = cb => {
  if (!rafFirst) testNow += 2000;
  rafFirst = false;
  cb();
  return 1;
};
renderCtx.cancelAnimationFrame = () => {};
const playPreview = async (arg = '') => {
  testNow = 0;
  rafFirst = true;
  previewPlayer.paused = true;
  previewPlayer.currentTime = 0;
  await vm.runInContext(`playTimelinePreview(${arg})`, renderCtx);
};
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
// A rendered lip-sync clip is anchored on the Omni cut it was MADE FROM, not on the take's current
// cut: re-cutting the take (adding a lead-in moves clipStart earlier) must not slide the finished
// video off the song — that shifted the picture by exactly the lead-in that was added.
graph.nodes.push({
  id: 'lsc1',
  zone: 'lipsync-video',
  terminal: true,
  source: 'b1',
  version: 1,
  start: 2, // the cut this video was rendered from
  duration: 7.2,
  video: { url: '/media/ls-take1.mp4' },
});
html = strip();
assert.match(html, /data-node="b1"[^>]*left:6\.667%/, 'the rendered take sits at its own cut (2 s)');
assert.match(html, /data-node="b1"[^>]*width:24\.000%/, 'and is as long as the video it holds');
graph.nodes.find(n => n.id === 'b1').clipStart = 0.5; // re-cut: 1.5 s of lead-in added at the front
html = strip();
assert.match(
  html,
  /data-node="b1"[^>]*left:6\.667%/,
  'after a re-cut the finished video stays on its own cut, not the take’s new start',
);
// A position/trim saved against an OLDER cut must not pin it either — that pinned the picture at
// the old lyric mark while the new video carries a lead-in, so it came in exactly that much late.
Object.assign(graph.nodes.find(n => n.id === 'lsc1'), {
  timelineStart: 3.66,
  trimIn: 1.5,
  timelineSegments: [{ id: 'lsc1', position: 3.66, inPoint: 1.5, outPoint: 7.2 }],
});
html = strip();
assert.match(
  html,
  /data-node="b1"[^>]*left:6\.667%/,
  'a stale saved position never pins a lip-sync clip off its own cut',
);
assert.match(html, /data-node="b1"[^>]*width:24\.000%/, 'and it keeps the whole rendered video');
graph.nodes.find(n => n.id === 'b1').clipStart = 2;
graph.nodes = graph.nodes.filter(n => n.id !== 'lsc1');
// Real render jobs create terminal output nodes. The source shot may have no video field.
graph.nodes.find(n => n.id === 'c1').video = { url: '/media/verse-v1.mp4' };
graph.nodes.find(n => n.id === 'c1').version = 1;
graph.nodes.push({
  id: 'c2',
  zone: 'output',
  terminal: true,
  source: 'a1',
  version: 2,
  video: { url: '/media/verse-v2.mp4' },
});
graph.nodes.push({
  id: 'c3',
  zone: 'output',
  terminal: true,
  source: 'a2',
  version: 1,
  video: { url: '/media/second.mp4' },
});
html = strip();
assert.match(html, /src="\/media\/verse-v2\.mp4"/, 'timeline shows the latest output version');
assert.doesNotMatch(html, /src="\/media\/verse-v1\.mp4"/, 'an older version is not duplicated');
assert.match(html, /src="\/media\/second\.mp4"/, 'a second rendered shot is visible');
graph.nodes.find(n => n.id === 'a1').timelineClipId = 'c1';
html = strip();
assert.match(
  html,
  /src="\/media\/verse-v1\.mp4"/,
  'a persisted canvas choice replaces the newest version on timeline',
);
assert.doesNotMatch(
  html,
  /src="\/media\/verse-v2\.mp4"/,
  'the unselected version is not duplicated on timeline',
);
graph.nodes.find(n => n.id === 'a1').timelineClipId = 'c2';
await playPreview();
assert.deepEqual(
  playedClips,
  ['/media/verse-v2.mp4', '/media/second.mp4'],
  'preview shows each shot at its own song-time, in order',
);
assert.equal(previewPanel.hidden, false, 'preview player opens');
playedClips.length = 0;
await playPreview('"a2"');
assert.deepEqual(playedClips, ['/media/second.mp4'], 'clicking a thumbnail starts at that shot');
const secondVersion = graph.nodes.find(n => n.id === 'c2');
Object.assign(secondVersion, { timelineStart: 3, trimIn: 1.25, trimOut: 6.75 });
html = strip();
assert.match(html, /id="timelineRuler"/, 'timeline has a draggable ruler');
assert.match(html, /data-playhead/, 'timeline has a playhead marker');
assert.match(html, /data-trim="in"/, 'video clips have an In handle');
assert.match(html, /data-trim="out"/, 'video clips have an Out handle');
assert.match(
  html,
  /data-node="a1"[^>]*left:10\.000%/,
  'position edit moves the clip to three seconds',
);
assert.match(
  html,
  /data-node="a1"[^>]*width:18\.333%/,
  'In/Out edit shortens the visible clip to 5.5 seconds',
);
vm.runInContext('setTimelineCursor(5)', renderCtx);
playedClips.length = 0;
playedOffsets.length = 0;
await playPreview();
assert.equal(playedClips[0], '/media/verse-v2.mp4');
assert.equal(playedOffsets[0], 3.25, 'playback seeks to In point plus playhead offset');
renderCtx.crypto = { randomUUID: () => 'unit' };
renderCtx.api = async (url, options) => {
  if (url === '/api/node') secondVersion.timelineSegments = options.body.timelineSegments;
  return graph;
};
vm.runInContext('setTimelineCursor(5)', renderCtx);
await vm.runInContext('splitTimelineAtCursor()', renderCtx);
assert.equal(
  JSON.stringify(secondVersion.timelineSegments.map(s => [s.inPoint, s.outPoint])),
  JSON.stringify([
    [1.25, 3.25],
    [3.25, 6.75],
  ]),
  'split at playhead creates two adjacent source ranges',
);
assert.equal(
  (strip().match(/data-node="a1"/g) || []).length,
  2,
  'both cut segments appear on the timeline',
);
await vm.runInContext('removeTimelineSegment()', renderCtx);
assert.equal(
  secondVersion.timelineSegments.length,
  1,
  'removing a segment does not delete the video',
);
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
