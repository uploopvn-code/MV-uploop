const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const start = source.indexOf('async function loadPool');
const end = source.indexOf('async function waitTabComplete', start);
const tabFunctions = source.slice(start, end);
const wakeStart = source.indexOf('let museWakeChain');
const wakeEnd = source.indexOf('async function ensureMuseChatHook', wakeStart);
const museWakeFunctions = source.slice(wakeStart, wakeEnd);
const failStart = source.indexOf('const isAttachmentLimit');
const failEnd = source.indexOf('const extFor', failStart);
const failFunctions = source.slice(failStart, failEnd);

test('ChatGPT closes legacy tabs and creates a fresh tab for every job', async () => {
  const removed = [];
  const created = [];
  let nextId = 100;
  const context = {
    tabPool: [],
    Promise,
    chrome: {
      storage: {
        local: {
          get: async () => ({ tabPool: [10, 11] }),
          set: async value => assert.equal(JSON.stringify(value), JSON.stringify({ tabPool: [] })),
        },
      },
      tabs: {
        create: async options => {
          created.push(options);
          return { id: nextId++ };
        },
        update: async () => {},
        remove: async id => removed.push(id),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(tabFunctions, context);

  await context.loadPool();
  const first = await context.acquireTab();
  const second = await context.acquireTab();
  await context.releaseTab(first);
  await context.releaseTab(second);

  assert.equal(
    JSON.stringify(created),
    JSON.stringify([
      { url: 'https://chatgpt.com/', active: false },
      { url: 'https://chatgpt.com/', active: false },
    ]),
  );
  assert.equal(first, 100);
  assert.equal(second, 101);
  assert.deepEqual(removed, [10, 11, 100, 101]);
});

test('Muse foreground wake-ups are serialized and restore the selected tab', async () => {
  let active = 7;
  const updates = [];
  const context = {
    Promise,
    sleep: async ms => assert.equal(ms, 250),
    chrome: {
      tabs: {
        query: async () => [{ id: active }],
        update: async (id, options) => {
          assert.equal(options.active, true);
          active = id;
          updates.push(id);
        },
        get: async id => ({ id }),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(museWakeFunctions, context);

  await Promise.all([context.wakeMuseTab(42), context.wakeMuseTab(43)]);

  assert.deepEqual(updates, [42, 7, 43, 7]);
  assert.equal(active, 7);
});

test('ChatGPT attachment limit requests another account only before prompt send', async () => {
  const payloads = [];
  const context = {
    effName: () => 'Drama worker #limited',
    api: async (base, route, body) => {
      payloads.push({ base, route, body });
      return { ok: true };
    },
  };
  vm.createContext(context);
  vm.runInContext(
    failFunctions + '; this.testAttachmentLimit = isAttachmentLimit; this.testFail = fail;',
    context,
  );

  const message =
    "ChatGPT báo lỗi tải ảnh: You've reached the limit for file attachments. Try again Oct 9, 10:17 AM";
  assert.equal(context.testAttachmentLimit(message), true);
  assert.equal(context.testAttachmentLimit('Ảnh tham chiếu chưa tải đủ'), false);

  const job = { id: 'job-1', lease: 'lease-1', __base: 'http://127.0.0.1:17777' };
  await context.testFail(job, message, { sent: false });
  await context.testFail(job, message, { sent: true });
  await context.testFail(job, 'Lỗi mạng', { sent: false });

  assert.equal(payloads[0].body.retryOtherWorker, true);
  assert.equal(payloads[0].body.name, 'Drama worker #limited');
  assert.equal(payloads[1].body.retryOtherWorker, false, 'đã gửi prompt thì không chuyển tài khoản');
  assert.equal(payloads[2].body.retryOtherWorker, false, 'lỗi thường không chuyển tài khoản');
});

