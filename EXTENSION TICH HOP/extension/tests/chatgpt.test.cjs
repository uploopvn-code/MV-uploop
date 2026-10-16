const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../content-chatgpt.js'), 'utf8');
const start = source.indexOf('function setNativeValue');
const end = source.indexOf('// The prompt is out only when', start);
const helpers = source.slice(start, end);

function setup(t) {
  const dom = new JSDOM('<main><form><div id="prompt-textarea" contenteditable="true"></div></form></main>', {
    url: 'https://chatgpt.com/', runScripts: 'outside-only',
  });
  const w = dom.window; t.after(() => w.close());
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() {
      if (this.querySelectorAll?.('p').length)
        return [...this.querySelectorAll(':scope > p')].map(p => p.textContent).join('\n');
      return this.textContent;
    },
    set(value) { this.textContent = value; }, configurable: true,
  });
  w.document.execCommand = () => false;
  w.DataTransfer = class {
    constructor() { this.data = new Map(); }
    setData(type, value) { this.data.set(type, value); }
  };
  w.ClipboardEvent = class extends w.Event {
    constructor(type, options = {}) { super(type, options); this.clipboardData = options.clipboardData; }
  };
  let sleepCount = 0, replaced = false;
  const context = {
    window: w, document: w.document, InputEvent: w.InputEvent, Event: w.Event,
    ClipboardEvent: w.ClipboardEvent, DataTransfer: w.DataTransfer,
    currentEditor: () => w.document.querySelector('#prompt-textarea'),
    sleep: async () => {
      sleepCount++;
      if (!replaced && sleepCount === 4) {
        replaced = true;
        const next = w.document.createElement('div');
        next.id = 'prompt-textarea'; next.contentEditable = 'true';
        w.document.querySelector('#prompt-textarea').replaceWith(next);
      }
    },
  };
  vm.createContext(context); vm.runInContext(helpers, context);
  return { w, context, replaced: () => replaced };
}

test('ChatGPT prompt is refilled when upload rerenders the composer', async t => {
  const { context, replaced } = setup(t);
  const prompt = 'Create one cinematic image.\nKeep the same character.';
  const editor = await context.fillPromptStable(prompt, { check() {} });
  assert.equal(replaced(), true);
  assert.equal(context.normalizedEditorText(context.editorValue2(editor)), context.normalizedEditorText(prompt));
  assert.equal(editor.isConnected, true);
});

test('contenteditable fallback creates line-preserving paragraphs and updates the value', async t => {
  const { context } = setup(t);
  const editor = context.currentEditor();
  await context.setEditorText(editor, 'Line one\nLine two');
  assert.equal(editor.querySelectorAll('p').length, 2);
  assert.equal(context.normalizedEditorText(context.editorValue2(editor)), 'Line one Line two');
});

test('persistent blob thumbnails are accepted after the attachment bar is stable', async t => {
  const dom = new JSDOM(
    '<main><form><div id="prompt-textarea" contenteditable="true"></div>' +
    '<img src="blob:https://chatgpt.com/ref-1"><img src="blob:https://chatgpt.com/ref-2">' +
    '<img src="blob:https://chatgpt.com/ref-3"></form></main>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only' },
  );
  const w = dom.window; t.after(() => w.close());
  const fnStart = source.indexOf('async function waitUploadsReady');
  const fnEnd = source.indexOf('async function clickSend', fnStart);
  let polls = 0;
  const context = {
    window: w, document: w.document, getComputedStyle: w.getComputedStyle.bind(w), Date,
    EDITOR: ['#prompt-textarea'],
    TURN_ANY: '[data-testid^="conversation-turn-"], [data-turn-key], [data-message-author-role]',
    currentEditor: () => w.document.querySelector('#prompt-textarea'),
    srcOf: img => img.src,
    composerUploadThumbs: () => [...w.document.querySelectorAll('form img')],
    sleep: async () => { polls++; },
  };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  await context.waitUploadsReady(3, { check() {} });
  assert.ok(polls >= 3);
});

test('file attachment quota toast stops upload immediately for account handoff', async t => {
  const dom = new JSDOM(
    '<main><form><div id="prompt-textarea" contenteditable="true"></div></form></main>' +
      '<div data-sonner-toast>You\'ve reached the limit for file attachments. Try again Oct 9, 10:17 AM</div>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only' },
  );
  const w = dom.window;
  t.after(() => w.close());
  const fnStart = source.indexOf('async function waitUploadsReady');
  const fnEnd = source.indexOf('async function clickSend', fnStart);
  let sleeps = 0;
  const context = {
    window: w,
    document: w.document,
    getComputedStyle: w.getComputedStyle.bind(w),
    Date,
    currentEditor: () => w.document.querySelector('#prompt-textarea'),
    srcOf: img => img.src,
    composerUploadThumbs: () => [],
    sleep: async () => {
      sleeps++;
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(fnStart, fnEnd), context);
  await assert.rejects(
    context.waitUploadsReady(1, { check() {} }),
    /reached the limit for file attachments/,
  );
  assert.equal(sleeps, 1, 'phải dừng ngay ở lần kiểm tra đầu tiên, không chờ timeout 90 giây');
});

test('attachment bar outside the form no longer blocks prompt entry', async t => {
  const dom = new JSDOM(
    '<main><div id="composer-shell"><div data-testid="composer-attachment-bar">' +
    '<img src="blob:https://chatgpt.com/ref"></div>' +
    '<form><div id="prompt-textarea" contenteditable="true"></div><input id="upload-files" type="file"></form>' +
    '</div></main>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only' },
  );
  const w = dom.window; t.after(() => w.close());
  const fnStart = source.indexOf('async function waitUploadsReady');
  const fnEnd = source.indexOf('async function clickSend', fnStart);
  let polls = 0;
  const context = {
    window: w, document: w.document, getComputedStyle: w.getComputedStyle.bind(w), Date,
    TURN_ANY: '[data-testid^="conversation-turn-"], [data-turn-key], [data-message-author-role]',
    currentEditor: () => w.document.querySelector('#prompt-textarea'),
    srcOf: img => img.src,
    composerUploadThumbs: () => [...w.document.querySelectorAll('[data-testid="composer-attachment-bar"] img')],
    sleep: async () => { polls++; },
  };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  await context.waitUploadsReady(1, { check() {} });
  assert.ok(polls >= 3);
});

test('upload gate never sends when fewer reference thumbnails appear', async t => {
  const dom = new JSDOM(
    '<main><form><div id="prompt-textarea" contenteditable="true"></div>' +
    '<img src="blob:https://chatgpt.com/only-one"></form></main>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only' },
  );
  const w = dom.window; t.after(() => w.close());
  const fnStart = source.indexOf('async function waitUploadsReady');
  const fnEnd = source.indexOf('async function clickSend', fnStart);
  let now = 0;
  const context = {
    window: w, document: w.document, getComputedStyle: w.getComputedStyle.bind(w),
    Date: { now: () => now },
    TURN_ANY: '[data-testid^="conversation-turn-"], [data-turn-key], [data-message-author-role]',
    currentEditor: () => w.document.querySelector('#prompt-textarea'),
    srcOf: img => img.src,
    composerUploadThumbs: () => [...w.document.querySelectorAll('form img')],
    sleep: async ms => { now += ms; },
  };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  await assert.rejects(
    context.waitUploadsReady(2, { check() {} }),
    /đã thấy 1\/2.*chưa gửi prompt/,
  );
});

test('intermediate asset is ignored until the ChatGPT turn is finished and idle', async () => {
  const fnStart = source.indexOf('async function waitForImage');
  const fnEnd = source.indexOf('\n})();', fnStart);
  let now = 10000, stateReads = 0, downloads = 0;
  const context = {
    Date: { now: () => now }, Set, IMAGE_POLL_MS: 1500,
    blocker: () => '', jobError: message => new Error(message),
    first: () => null, EDITOR: [], USER_TURN: '[data-turn="user"]',
    document: { querySelector: () => null },
    convState: async () => {
      stateReads++;
      return { assets: ['sediment://result'], text: '', idle: stateReads >= 3, finished: stateReads >= 3 };
    },
    last: items => items[items.length - 1],
    downloadAsset: async () => { downloads++; return { base64: 'result-image', mime: 'image/png' }; },
    domImages: () => [], srcOf: () => '', isStreaming: () => true,
    imgToResult: async () => { throw new Error('DOM path should not run'); },
    sleep: async ms => { now += ms; },
  };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  const job = { sentAt: now, check() {}, cid: () => 'conversation', say() {} };
  const result = await context.waitForImage(job, {
    before: [], refs: new Set(), timeout: 60000, refuseAfter: 20000,
    timeoutMsg: 'timeout', noImageMsg: 'no image',
  });
  assert.equal(result.base64, 'result-image');
  assert.equal(downloads, 1);
  assert.equal(stateReads, 3);
  assert.ok(now - job.sentAt <= 3000);
});

test('93 percent image generation screen is still in progress', () => {
  const dom = new JSDOM('<main><section id="turn">One last tweak... <span>93%</span></section></main>');
  const w = dom.window;
  const fnStart = source.indexOf('function imageGenerationInProgress');
  const fnEnd = source.indexOf('// Early exits', fnStart);
  const context = { document: w.document, assistantTurn: () => w.document.querySelector('#turn') };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  assert.equal(context.imageGenerationInProgress(), true);
  w.document.querySelector('#turn').textContent = 'Image created';
  assert.equal(context.imageGenerationInProgress(), false);
  w.close();
});

test('completed progress and image-viewer sliders do not look like active generation', () => {
  const dom = new JSDOM(
    '<main><section id="turn">Image created' +
    '<div role="progressbar" aria-valuenow="100"></div>' +
    '<input aria-valuenow="50"></section></main>',
    { pretendToBeVisual: true },
  );
  const w = dom.window;
  const progress = w.document.querySelector('[role="progressbar"]');
  progress.getClientRects = () => [{ width: 100, height: 8 }];
  const fnStart = source.indexOf('function imageGenerationInProgress');
  const fnEnd = source.indexOf('// Early exits', fnStart);
  const context = {
    document: w.document,
    getComputedStyle: w.getComputedStyle.bind(w),
    assistantTurn: () => w.document.querySelector('#turn'),
  };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  assert.equal(context.imageGenerationInProgress(), false);
  progress.setAttribute('aria-valuenow', '93');
  assert.equal(context.imageGenerationInProgress(), true);
  w.close();
});

test('rate-limited API immediately falls back to the completed generated DOM image', async () => {
  const fnStart = source.indexOf('async function waitForImage');
  const fnEnd = source.indexOf('\n})();', fnStart);
  let now = 20000, stateReads = 0, domReads = 0;
  const generated = { complete: true, naturalWidth: 1024 };
  const context = {
    Date: { now: () => now }, Set, IMAGE_POLL_MS: 1500,
    blocker: () => '', jobError: message => new Error(message),
    first: () => null, EDITOR: [], USER_TURN: '[data-turn="user"]',
    document: { querySelector: () => null },
    convState: async () => { stateReads++; throw { status: 429, retryAfter: 30000, message: 'HTTP 429' }; },
    last: items => items[items.length - 1], downloadAsset: async () => { throw new Error('API asset unavailable'); },
    domImages: () => [generated], srcOf: () => 'https://files.oaiusercontent.com/generated.png',
    isStreaming: () => false, imageGenerationInProgress: () => false,
    imgToResult: async () => { domReads++; return { base64: 'final-image', mime: 'image/png' }; },
    sleep: async ms => { now += ms; },
  };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  const job = { sentAt: now, check() {}, cid: () => 'conversation', say() {} };
  const result = await context.waitForImage(job, {
    before: [], refs: new Set(), timeout: 60000, refuseAfter: 20000,
    timeoutMsg: 'timeout', noImageMsg: 'no image',
  });
  assert.equal(result.base64, 'final-image');
  assert.equal(stateReads, 1);
  assert.equal(domReads, 1);
  assert.equal(now - job.sentAt, 1500);
});

test('completed generated DOM image wins when ChatGPT API status stays busy', async () => {
  const fnStart = source.indexOf('async function waitForImage');
  const fnEnd = source.indexOf('\n})();', fnStart);
  let now = 30000, stateReads = 0, domReads = 0;
  const generated = { complete: true, naturalWidth: 1536 };
  const context = {
    Date: { now: () => now }, Set, IMAGE_POLL_MS: 1500,
    blocker: () => '', jobError: message => new Error(message),
    first: () => null, EDITOR: [], USER_TURN: '[data-turn="user"]',
    document: { querySelector: () => null },
    convState: async () => {
      stateReads++;
      return { assets: ['sediment://result'], text: '', idle: false, finished: false };
    },
    last: items => items[items.length - 1],
    downloadAsset: async () => { throw new Error('API must wait while status is busy'); },
    domImages: () => [generated],
    srcOf: () => 'https://files.oaiusercontent.com/completed.png',
    isStreaming: () => true,
    imageGenerationInProgress: () => false,
    imgToResult: async () => {
      domReads++;
      return { base64: 'completed-image', mime: 'image/png' };
    },
    sleep: async ms => { now += ms; },
  };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  const job = { sentAt: now, check() {}, cid: () => 'conversation', say() {} };
  const result = await context.waitForImage(job, {
    before: [], refs: new Set(), timeout: 60000, refuseAfter: 20000,
    timeoutMsg: 'timeout', noImageMsg: 'no image',
  });
  assert.equal(result.base64, 'completed-image');
  assert.equal(stateReads, 2);
  assert.equal(domReads, 1);
  assert.equal(now - job.sentAt, 1500);
});

test('labelled generated-image gallery is conclusive even with stale progress UI', async () => {
  const fnStart = source.indexOf('async function waitForImage');
  const fnEnd = source.indexOf('\n})();', fnStart);
  let now = 40000, reads = 0;
  const generated = {
    complete: true,
    naturalWidth: 1672,
    closest: selector =>
      selector.includes('generated-image-gallery') && selector.includes('generated-image-preview')
        ? { dataset: { testid: 'generated-image-gallery' } }
        : null,
  };
  const context = {
    Date: { now: () => now }, Set, IMAGE_POLL_MS: 1500,
    blocker: () => '', jobError: message => new Error(message),
    first: () => null, EDITOR: [], USER_TURN: '[data-turn="user"]',
    document: { querySelector: () => null },
    convState: async () => ({ assets: [], text: '', idle: false, finished: false }),
    last: items => items[items.length - 1],
    downloadAsset: async () => { throw new Error('no API asset'); },
    domImages: () => [generated],
    srcOf: () => 'blob:https://chatgpt.com/final-generated-image',
    isStreaming: () => true,
    imageGenerationInProgress: () => true,
    imgToResult: async () => {
      reads++;
      return { base64: 'gallery-image', mime: 'image/png' };
    },
    sleep: async ms => { now += ms; },
  };
  vm.createContext(context); vm.runInContext(source.slice(fnStart, fnEnd), context);
  const job = { sentAt: now, check() {}, cid: () => 'conversation', say() {} };
  const result = await context.waitForImage(job, {
    before: [], refs: new Set(), timeout: 60000, refuseAfter: 20000,
    timeoutMsg: 'timeout', noImageMsg: 'no image',
  });
  assert.equal(result.base64, 'gallery-image');
  assert.equal(reads, 1);
  assert.equal(now - job.sentAt, 1500);
});
