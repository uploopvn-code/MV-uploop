// Director Assistant must preview graph/provider changes before sending writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
for (const id of [
  'assistantToggle',
  'assistantDock',
  'assistantLauncher',
  'assistantCollapse',
  'assistantPanel',
  'assistantConversation',
  'assistantTyping',
  'assistantClearChat',
  'commandPreview',
  'commandApprove',
  'commandCancel',
])
  assert.ok(html.includes(`id="${id}"`), `assistant UI needs ${id}`);
const commandSource = fs.readFileSync(new URL('./public/js/commands.js', import.meta.url), 'utf8');
assert.match(commandSource, /mv-assistant-conversations-v1/, 'chat history is stored per project');
assert.match(commandSource, /history: recentHistory/, 'recent conversation is sent as follow-up context');

const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', hidden: true, disabled: false, dataset: {}, style: {}, focus() {}, click() {}, querySelectorAll: () => [] });
  return elements.get(id);
};
const calls = [];
const writeCalls = () => calls.filter(call => call.options?.method && call.options.method !== 'GET');
const downloads = [];
// The Claude plan the mocked /api/assistant/plan returns, and every /api/assistant/learn body.
let planResponse = null;
const learnCalls = [];
const deleteCalls = [];
const state = {
  activeProjectId: 'project-1',
  projects: [{ id: 'project-1', name: 'Film A' }, { id: 'project-2', name: 'Episode B' }],
  revision: 1,
  edges: [],
  nodes: [
    { id: 'stage', name: 'Main Stage', role: 'stage', zone: 'design' },
    { id: 'shot-1', name: 'Chorus shot 1', zone: 'production' },
    { id: 'shot-2', name: 'Chorus shot 2', zone: 'production' },
    { id: 'close', name: 'Cận mặt', zone: 'production' },
  ],
};
const storage = new Map();
const context = {
  console,
  store: { state },
  $: selector => element(selector),
  api: async (route, options) => {
    calls.push({ route, options });
    if (route.startsWith('/api/projects/package/plan')) return { projects: [{ name: 'Film A', mediaCount: 3 }], mediaCount: 3, bytes: 4096 };
    if (route.startsWith('/api/package/plan')) return { name: 'Film A-2026-10-14.zip', clips: 5, images: 3, steps: 7, bytes: 5 * 1024 ** 2 };
    if (route === '/api/assistant/plan') return planResponse;
    if (route === '/api/state') return state;
    if (route === '/api/assistant/learn') { learnCalls.push(options.body); return { status: 'active' }; }
    if (route === '/api/nodes/delete') { deleteCalls.push(options.body.id); return state; }
    return {};
  },
  triggerDownload: (url, name) => downloads.push({ url, name }),
  refresh: async () => {},
  toast() {},
  esc: value => String(value).replace(/</g, '&lt;'),
  t: key => key,
  getLocale: () => 'vi',
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  document: { querySelectorAll: () => [], addEventListener() {} },
  window: {},
  // a browser always has these; addAssistantMessage scrolls, ids are minted with crypto
  requestAnimationFrame: fn => { if (typeof fn === 'function') fn(); return 0; },
  crypto: { randomUUID: () => `id-${Math.random().toString(16).slice(2)}` },
  // the recipe panel polls the project state (a browser always has timers)
  setInterval: () => 0,
};
vm.createContext(context);
vm.runInContext(commandSource
  .replace(/^import [^;]+;\r?\n/gm, ''), context);

element('#commandInput').value = 'Đổi toàn bộ video Production sang Muse Chat';
let pending = vm.runInContext('runCommand()', context);
assert.equal(element('#commandPreview').hidden, false, 'provider plan is shown');
assert.match(element('#commandPreviewItems').innerHTML, /Chorus shot 1/);
assert.equal(writeCalls().length, 0, 'preview makes no API write');
element('#commandCancel').onclick();
await pending;
assert.equal(writeCalls().length, 0, 'cancel makes no API write');

pending = vm.runInContext('runCommand()', context);
state.revision++;
element('#commandApprove').onclick();
await pending;
assert.equal(writeCalls().length, 0, 'outdated plan is not executed');

pending = vm.runInContext('runCommand()', context);
element('#commandApprove').onclick();
await pending;
assert.equal(calls.filter(call => call.route === '/api/node').length, 2, 'approve changes only non-closeup Production shots');

element('#commandInput').value = 'Nối Main Stage vào các shot Chorus';
pending = vm.runInContext('runCommand()', context);
assert.match(element('#commandPreviewItems').innerHTML, /Main Stage → Chorus shot 2/);
assert.equal(calls.filter(call => call.route === '/api/edges').length, 0);
element('#commandApprove').onclick();
await pending;
const edgeCall = calls.find(call => call.route === '/api/edges');
assert.equal(edgeCall.options.body.edges.length, 2, 'approved graph plan adds two connections');
element('#commandInput').value = 'Đóng gói dự án';
pending = vm.runInContext('runCommand()', context);
await new Promise(setImmediate);
assert.match(element('#commandPreviewItems').innerHTML, /Film A/);
assert.equal(downloads.length, 0, 'packaging needs approval');
element('#commandCancel').onclick();
await pending;
assert.equal(downloads.length, 0, 'cancel does not download');
pending = vm.runInContext('runCommand()', context);
await new Promise(setImmediate);
element('#commandApprove').onclick();
await pending;
assert.match(downloads[0].url, /scope=all/, 'plain command packages all projects');
element('#commandInput').value = 'Đóng gói dự án hiện tại';
pending = vm.runInContext('runCommand()', context);
await new Promise(setImmediate);
element('#commandApprove').onclick();
await pending;
assert.match(downloads[1].url, /scope=current/, 'current scope is explicit');
element('#commandInput').value = 'Zip 1 project này';
pending = vm.runInContext('runCommand()', context);
await new Promise(setImmediate);
element('#commandApprove').onclick();
await pending;
assert.match(downloads[2].url, /scope=current/, 'natural singular phrase selects one project');
element('#commandInput').value = 'Sao lưu project Episode B thành zip';
pending = vm.runInContext('runCommand()', context);
await new Promise(setImmediate);
element('#commandApprove').onclick();
await pending;
assert.match(downloads[3].url, /scope=project&id=project-2/, 'project name selects the right project');
element('#commandInput').value = 'Đóng gói tất cả project thành 1 file zip';
pending = vm.runInContext('runCommand()', context);
await new Promise(setImmediate);
element('#commandApprove').onclick();
await pending;
assert.match(downloads[4].url, /scope=all/, 'one ZIP file does not mean one project');
element('#commandInput').value = 'Đóng gói tất cả 1 project';
await vm.runInContext('runCommand()', context);
assert.equal(downloads.length, 5, 'conflicting scope does not download');
assert.match(element('#commandResult').textContent, /command.packageScopeConflict/);
// Gói GIAO HÀNG (video + ảnh theo node, folder nhom/) — khác backup project; tải từ /api/package.
element('#commandInput').value = 'Đóng gói dữ liệu để giao hàng';
pending = vm.runInContext('runCommand()', context);
await new Promise(setImmediate);
element('#commandApprove').onclick();
await pending;
assert.equal(downloads[5].url, '/api/package', 'gói giao hàng tải từ /api/package, không phải backup');
assert.match(downloads[5].name, /\.zip$/, 'tên gói có .zip');
// A successful Claude plan asks whether to remember it; only a YES calls /api/assistant/learn,
// so the same request can replay at 0 token next time.
const panel = element('#commandPreview');
const panelTitle = element('#commandPreviewTitle');
// Drive the two sequential prompts by waiting for the panel to actually show each one, rather
// than guessing how many microtasks the run takes between them.
const untilPanel = async match => {
  for (let i = 0; i < 200; i++) {
    await new Promise(setImmediate);
    if (!panel.hidden && String(panelTitle.textContent).includes(match)) return true;
  }
  throw new Error(`Không thấy lời nhắc chứa “${match}”`);
};
// revision must match the live state: earlier tests bumped state.revision, and the plan route
// guards on it, so read it fresh each time instead of hard-coding 1.
const claudePlan = () => ({
  source: 'claude', summary: 'Đổi nhà cung cấp cho Chorus shot 1', preview: ['Chorus shot 1 → Muse Chat'],
  actions: [{ type: 'set_provider', provider: 'musechat', nodeIds: ['shot-1'] }],
  projectId: state.activeProjectId, revision: state.revision, planId: 'plan-123', learnable: true,
});

// Decline saving → the plan runs but nothing is learned.
context.store.state = state; // earlier quick-command tests may have replaced store.state
learnCalls.length = 0;
planResponse = claudePlan();
element('#commandInput').value = 'Đổi video Chorus shot 1 sang Muse Chat';
pending = vm.runInContext('runAssistant()', context);
await untilPanel('Đổi nhà cung cấp'); // the run confirmation
element('#commandApprove').onclick();
await untilPanel('Lưu ghi nhớ'); // the save prompt appears only after the run succeeds
element('#commandCancel').onclick();
await pending;
assert.equal(learnCalls.length, 0, 'từ chối lưu → không gọi /api/assistant/learn');

// Accept saving a non-portable plan → saved for this project only, no scope prompt.
context.store.state = state; // runAssistant reset store.state via /api/node; restore it for the next plan
learnCalls.length = 0;
planResponse = claudePlan();
element('#commandInput').value = 'Đổi video Chorus shot 1 sang Muse Chat';
pending = vm.runInContext('runAssistant()', context);
await untilPanel('Đổi nhà cung cấp');
element('#commandApprove').onclick();
await untilPanel('Lưu ghi nhớ');
element('#commandApprove').onclick();
await pending;
assert.equal(learnCalls.length, 1, 'đồng ý lưu → gọi /api/assistant/learn đúng một lần');
assert.equal(learnCalls[0].planId, 'plan-123', 'lưu kèm planId của kế hoạch vừa chạy');
assert.equal(learnCalls[0].scope, 'project', 'kế hoạch không mang đi được → lưu riêng project, không hỏi phạm vi');

// A portable plan asks whether to use it across all projects; approving the extra prompt saves global.
context.store.state = state;
learnCalls.length = 0;
planResponse = { ...claudePlan(), portable: true };
element('#commandInput').value = 'Đổi video Chorus shot 1 sang Muse Chat';
pending = vm.runInContext('runAssistant()', context);
await untilPanel('Đổi nhà cung cấp');
element('#commandApprove').onclick(); // approve the run
await untilPanel('Lưu ghi nhớ');
element('#commandApprove').onclick(); // yes, remember
await untilPanel('MỌI project'); // the scope prompt only shows for portable plans
element('#commandApprove').onclick(); // yes, use it everywhere
await pending;
assert.equal(learnCalls.length, 1, 'kế hoạch mang đi được vẫn chỉ gọi learn một lần');
assert.equal(learnCalls[0].scope, 'global', 'đồng ý phạm vi → lưu dùng chung mọi project');

// Delete node: the assistant may remove a node after the user approves the preview (not learnable).
context.store.state = state;
deleteCalls.length = 0;
learnCalls.length = 0;
planResponse = {
  source: 'claude', summary: 'Xóa node Extra', preview: ['⚠️ XÓA 1 node: Extra'],
  actions: [{ type: 'delete_node', nodeIds: ['node-extra'] }],
  projectId: state.activeProjectId, revision: state.revision, planId: 'p-del', learnable: false,
};
element('#commandInput').value = 'Xóa node Extra';
pending = vm.runInContext('runAssistant()', context);
await untilPanel('Xóa node Extra');
element('#commandApprove').onclick();
await pending;
assert.deepEqual(deleteCalls, ['node-extra'], 'duyệt xóa → gọi /api/nodes/delete đúng node');
assert.equal(learnCalls.length, 0, 'xóa node không phải lệnh học → không hỏi lưu bộ nhớ');

console.log('PASS: Director Assistant graph/provider and project-package preview, cancel and approve');
console.log('PASS: successful plan offers to remember (0-token replay), saving only on approval');
console.log('PASS: assistant can delete a node after approval, without offering to remember it');
