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
