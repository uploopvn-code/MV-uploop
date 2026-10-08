const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(__dirname, '../content-musechat-ui.js'), 'utf8');
const hookSource = fs.readFileSync(path.join(__dirname, '../content-musechat-hook.js'), 'utf8');
function extract(name, next) { const start = source.indexOf(`async function ${name}`); return source.slice(start, source.indexOf(next, start)); }
const prompt = 'Create a video of a dancer.\nCamera moves slowly.';
function fixture(t, { preview = 'img', button = 'label', sendWorks = true, network = false, reset = false, httpStatus = 200, savedSession = '', mediaSource = false } = {}) {
  const dom = new JSDOM(`<main><div id="messages"></div><form><div id="composer"><textarea placeholder="Message"></textarea><input type="file" accept="image/*" multiple hidden><div id="attachments"></div>${button === 'none' ? '' : `<button type="button" ${button === 'label' ? 'aria-label="Send message"' : ''}><svg><path d="M12 19V5m-7 7 7-7 7 7"/></svg></button>`}</div></form></main>`, { url: 'https://muse.ai/', runScripts: 'outside-only' });
  const w = dom.window; t.after(() => w.close());
  let clock = 10000, clicks = 0, enters = 0, requests = 0, changes = 0;
  const realTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms) => realTimeout(() => { clock += ms || 0; fn(); }, 0);
  w.Date.now = () => clock;
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const isButton = this.tagName === 'BUTTON'; const left = isButton ? 470 : 100, top = 400, width = isButton ? 32 : 400;
    return { left, top, width, height: 40, right: left + width, bottom: top + 40 };
  };
  // jsdom has no layout/innerText implementation; use textContent for rendered labels.
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, 'isContentEditable', { get() { return this.hasAttribute('contenteditable') && this.getAttribute('contenteditable') !== 'false'; } });
  w.DataTransfer = class { constructor() { this.files = []; this.items = { add: f => this.files.push(f) }; } };
  if (mediaSource) {
    let objectId = 0;
    w.SourceBuffer = class {
      constructor() { this.updating = false; }
      appendBuffer(data) { this.lastNativeAppend = data; }
    };
    w.MediaSource = class {
      constructor() { this.readyState = 'open'; }
      addSourceBuffer() { return new w.SourceBuffer(); }
    };
    w.URL.createObjectURL = () => `blob:https://muse.ai/tracked-${++objectId}`;
    w.URL.revokeObjectURL = () => {};
  }
  w.fetch = async () => { requests++; return new Response('{}', { status: httpStatus, headers: { 'content-type': 'application/json' } }); };
  w.Request = Request;
  const input = w.document.querySelector('textarea'), picker = w.document.querySelector('input');
  Object.defineProperty(picker, 'files', { value: [], writable: true });
  picker.addEventListener('change', () => {
    if (preview === 'img') w.document.getElementById('attachments').innerHTML = '<img src="blob:https://muse.ai/reference">';
    if (preview === 'background') w.document.getElementById('attachments').innerHTML = '<div style="background-image:url(blob:https://muse.ai/reference)"></div>';
  });
  if (reset) input.addEventListener('input', () => { if (++changes === 1) input.value = ''; });
  const onSend = () => {
    assert.ok(w.__dramaMuseChatActiveJob.sentAt > 0);
    if (network) w.fetch('/api/chat/message', { method: 'POST', body: JSON.stringify({ message: prompt }) });
    if (sendWorks) { const message = w.document.createElement('div'); message.textContent = input.value; message.setAttribute('data-message-author-role', 'user'); w.document.getElementById('messages').appendChild(message); input.value = ''; }
  };
  w.document.querySelector('button')?.addEventListener('click', () => { clicks++; onSend(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { enters++; onSend(); } });
  w.eval(uiSource); if (savedSession) w.sessionStorage.setItem('__dramaMuseChatJob_v13', savedSession); w.eval(hookSource);
  w.eval(extract('museChatDriveUi', '// Download the video inside the page') + extract('museChatIsNewChat', '// Click the'));
  return { w, input, picker, clicks: () => clicks, enters: () => enters, requests: () => requests,
    run: () => w.museChatDriveUi({ queueId: 'job', prompt, images: [{ base64: 'YQ==', filename: 'ref.png', mime: 'image/png' }] }) };
}
function echoPrompt(f) {
  const message = f.w.document.createElement('div');
  message.textContent = prompt;
  message.setAttribute('data-message-author-role', 'user');
  f.w.document.getElementById('messages').appendChild(message);
  return message;
}
test('hidden picker + icon-only button sends exactly once and confirms the transcript', async t => {
  const f = fixture(t, { button: 'icon' }); const result = await f.run();
  assert.equal(result.ok, true, result.detail); assert.equal(f.picker.files.length, 1); assert.equal(f.clicks(), 1); assert.equal(f.enters(), 0);
});
test('CSS background attachment does not block submission', async t => {
  const f = fixture(t, { preview: 'background' }); const result = await f.run(); assert.equal(result.ok, true, result.detail);
});
test('missing preview fills the prompt but never submits without its image', async t => {
  const f = fixture(t, { preview: 'none' }); assert.equal((await f.run()).ok, false); assert.equal(f.input.value, prompt); assert.equal(f.clicks(), 0);
});
test('disabled send button is never bypassed with Enter', async t => {
  const f = fixture(t); f.w.document.querySelector('button').disabled = true;
  assert.equal((await f.run()).ok, false); assert.equal(f.clicks(), 0); assert.equal(f.enters(), 0);
});
test('keyboard-only editor submits once via Enter', async t => {
  const f = fixture(t, { button: 'none' }); const result = await f.run(); assert.equal(result.ok, true, result.detail); assert.equal(f.enters(), 1);
});
test('unconfirmed click keeps observing without a second submit', async t => {
  const f = fixture(t, { sendWorks: false }); const result = await f.run(); assert.equal(result.ok, true); assert.equal(result.pending, true); assert.equal(result.confirmed, false); assert.equal(f.w.__dramaMuseChatActiveJob.queueId, 'job'); assert.equal(f.w.__dramaMuseChatActiveJob.confirmed, false); assert.equal(f.clicks(), 1); assert.equal(f.enters(), 0);
});
test('matching accepted network request confirms send even before transcript rendering', async t => {
  const f = fixture(t, { sendWorks: false, network: true }); const result = await f.run(); assert.equal(result.ok, true, result.detail); assert.equal(f.requests(), 1);
});
test('framework reset during upload is refilled before send', async t => {
  const f = fixture(t, { reset: true }); const result = await f.run(); assert.equal(result.ok, true, result.detail); assert.equal(f.clicks(), 1);
});
test('welcome blocks are not messages, while actual messages and drafts are', async t => {
  const f = fixture(t); const region = f.w.document.getElementById('messages'); region.textContent = 'Welcome '.repeat(50);
  assert.equal(await f.w.museChatIsNewChat(), true); region.innerHTML = '<div data-message-id="old">old</div>';
  assert.equal(await f.w.museChatIsNewChat(), false); region.textContent = ''; f.input.value = 'draft'; assert.equal(await f.w.museChatIsNewChat(), false);
});
test('observer excludes baseline demo and reference blobs but finds extensionless generated video', async t => {
  const f = fixture(t); const messages = f.w.document.getElementById('messages');
  messages.innerHTML = '<video src="https://muse.ai/demo.mp4"></video><a href="blob:https://muse.ai/image">image</a>';
  f.w.__dramaMuseChatArm('job', prompt); f.w.__dramaMuseChatConfirm();
  echoPrompt(f);
  assert.equal(f.w.__dramaMuseChatCaptured, null);
  const card = f.w.document.createElement('div'); const video = f.w.document.createElement('video');
  video.src = '/media/generated'; card.appendChild(video); messages.appendChild(card); f.w.__dramaMuseChatPoll();
  assert.equal(f.w.__dramaMuseChatCaptured.videoUrl, 'https://muse.ai/media/generated');
  f.w.__dramaMuseChatClear(); assert.equal(f.w.sessionStorage.getItem('__dramaMuseChatJob_v13'), null);
});
test('observer finds a Muse player rendered outside the captured conversation root', async t => {
  const f = fixture(t);
  f.w.document.body.insertAdjacentHTML('beforeend', '<div id="player-portal"><video src="https://muse.ai/old.mp4"></video></div>');
  f.w.__dramaMuseChatArm('job', prompt); f.w.__dramaMuseChatConfirm();
  echoPrompt(f);
  f.w.__dramaMuseChatPoll();
  assert.equal(f.w.__dramaMuseChatCaptured, null, 'pre-send portal player must remain excluded');
  const video = f.w.document.createElement('video');
  video.className = 'h-full w-full bg-transparent object-cover';
  video.src = 'blob:https://muse.ai/generated-portal';
  const card = f.w.document.createElement('div'); card.appendChild(video);
  f.w.document.getElementById('player-portal').appendChild(card);
  f.w.__dramaMuseChatPoll();
  assert.equal(f.w.__dramaMuseChatCaptured.videoUrl, 'blob:https://muse.ai/generated-portal');
  const diagnostics = f.w.__dramaMuseChatDiagnostics();
  assert.equal(diagnostics.documentVideos, 2);
  assert.equal(diagnostics.scopedVideos, 0);
  assert.equal(diagnostics.freshVideos, 1);
  assert.equal(diagnostics.freshBlobVideos, 1);
  assert.equal(diagnostics.promptAnchorFound, true);
});
test('observer ignores a pre-existing intro player even when its blob URL changes after arm', async t => {
  const f = fixture(t);
  const intro = f.w.document.createElement('video');
  intro.className = 'muse-intro-player';
  intro.src = 'blob:https://muse.ai/intro-before';
  f.w.document.body.appendChild(intro);
  f.w.__dramaMuseChatArm('job', prompt); f.w.__dramaMuseChatConfirm();
  echoPrompt(f);
  intro.src = 'blob:https://muse.ai/intro-after';
  f.w.__dramaMuseChatPoll();
  assert.equal(f.w.__dramaMuseChatCaptured, null);
});
test('observer ignores a dynamically inserted autoplay landing video', async t => {
  const f = fixture(t);
  f.w.__dramaMuseChatArm('job', prompt); f.w.__dramaMuseChatConfirm();
  echoPrompt(f);
  const intro = f.w.document.createElement('video');
  intro.setAttribute('autoplay', '');
  intro.src = 'blob:https://muse.ai/rotating-home-video';
  f.w.document.body.appendChild(intro);
  f.w.__dramaMuseChatPoll();
  assert.equal(f.w.__dramaMuseChatCaptured, null);
});
test('direct source URL replacing a MediaSource blob is detected by rescan', async t => {
  const f = fixture(t); f.w.__dramaMuseChatArm('job', prompt); f.w.__dramaMuseChatConfirm(); echoPrompt(f);
  const card = f.w.document.createElement('div'); const video = f.w.document.createElement('video'); video.src = 'blob:https://muse.ai/mse';
  card.appendChild(video); f.w.document.getElementById('messages').appendChild(card); f.w.__dramaMuseChatPoll();
  assert.match(f.w.__dramaMuseChatCaptured?.videoUrl || '', /^blob:/, JSON.stringify(f.w.__dramaMuseChatDiagnostics()));
  video.removeAttribute('src'); video.innerHTML = '<source src="https://muse.ai/final.mp4">'; f.w.__dramaMuseChatPoll();
  assert.equal(f.w.__dramaMuseChatCaptured.videoUrl, 'https://muse.ai/final.mp4');
});
test('unrelated HTTP errors do not fail the active job', async t => {
  const f = fixture(t, { httpStatus: 500 }); f.w.__dramaMuseChatArm('job', prompt);
  await f.w.fetch('/api/chat/history', { method: 'GET' }); assert.equal(f.w.__dramaMuseChatActiveJob.confirmed, false); assert.equal(f.w.__dramaMuseChatError, null);
});
async function download(body, type, status = 200, headers = {}) {
  const context = { AbortController, setTimeout, clearTimeout, URL, location: { href: 'https://muse.ai/' }, Uint8Array, btoa,
    fetch: async () => new Response(body, { status, headers: { 'content-type': type, ...headers } }) };
  vm.createContext(context); vm.runInContext(extract('museChatDownload', '// --- MAIN-world functions injected into the Google Vids'), context);
  return context.museChatDownload('https://muse.ai/video');
}
function mp4() { const bytes = new Uint8Array(2048); bytes.set([0x66, 0x74, 0x79, 0x70], 4); return bytes; }
test('download validates MP4 bytes and MIME', async () => { const result = await download(mp4(), 'application/octet-stream'); assert.equal(result.mime, 'video/mp4'); assert.equal(Buffer.from(result.base64, 'base64').length, 2048); });
test('download rejects HTML, playlist, partial file and wrong magic', async () => {
  for (const [body, type, status, headers] of [ ['<html>login</html>', 'text/html'], ['#EXTM3U', 'application/vnd.apple.mpegurl'], [mp4(), 'video/mp4', 206, { 'content-range': 'bytes 0-2047/4096' }], [new Uint8Array(2048), 'video/mp4'] ]) {
    const result = await download(body, type, status, headers); assert.equal(result.base64, undefined); assert.ok(result.detail);
  }
});
test('download preserves WebM instead of labelling it MP4', async () => { const bytes = new Uint8Array(2048); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); assert.equal((await download(bytes, 'video/webm')).mime, 'video/webm'); });
test('MediaSource blob video is recorded from the exact Muse player and returned as WebM', async () => {
  const bytes = new Uint8Array(2048); bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  let playCount = 0, trackStopped = false, ended;
  const track = { stop() { trackStopped = true; } };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const video = {
    currentSrc: 'blob:https://muse.ai/generated', src: 'blob:https://muse.ai/generated',
    readyState: 4, duration: 0.01, currentTime: 0, loop: true, muted: true,
    playbackRate: 1, paused: false,
    getAttribute: name => name === 'src' ? 'blob:https://muse.ai/generated' : null,
    captureStream: () => stream,
    addEventListener(type, fn) { if (type === 'ended') ended = fn; },
    async play() { playCount++; setTimeout(() => ended?.(), 0); },
  };
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('video/webm'); }
    constructor() { this.state = 'inactive'; this.mimeType = 'video/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  const context = {
    AbortController, setTimeout, clearTimeout, URL, Blob, MediaRecorder: Recorder,
    location: { href: 'https://muse.ai/' }, Uint8Array, btoa,
    document: { querySelectorAll: () => [video] },
    fetch: async () => { throw new TypeError('MediaSource blob is not fetchable'); },
  };
  vm.createContext(context);
  vm.runInContext(extract('museChatDownload', '// --- MAIN-world functions injected into the Google Vids'), context);
  const result = await context.museChatDownload('blob:https://muse.ai/generated');
  assert.equal(result.method, 'player-recording');
  assert.equal(result.mime, 'video/webm');
  assert.equal(Buffer.from(result.base64, 'base64').length, bytes.length);
  assert.equal(playCount, 2); // one capture play, then restore the previously playing state
  assert.equal(trackStopped, true);
});
test('MediaSource segments are reconstructed immediately without replaying the player', async t => {
  const f = fixture(t, { mediaSource: true });
  f.w.__dramaMuseChatArm('job', prompt);
  const source = new f.w.MediaSource();
  const url = f.w.URL.createObjectURL(source);
  const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.640028"');
  const bytes = mp4();
  buffer.appendBuffer(new f.w.Uint8Array(bytes).buffer);
  source.readyState = 'ended';
  const video = f.w.document.createElement('video');
  video.src = url;
  f.w.document.getElementById('messages').appendChild(video);
  const result = await f.w.__dramaMuseChatReadObjectUrl(url);
  assert.equal(result.method, 'media-source-segments');
  assert.equal(result.mime, 'video/mp4');
  assert.deepEqual([...result.bytes.slice(4, 8)], [0x66, 0x74, 0x79, 0x70]);
  assert.equal(result.bytes.length, bytes.length);
});
// Run the real orchestration, injected driver, observer and downloader together.
async function runWorker(t, { saveFails = false, temporaryVideo = false, navigates = false, lateVideo = false, editorState = 'normal', neverVideo = false } = {}) {
  const f = fixture(t, { button: 'icon', preview: 'background', sendWorks: !(lateVideo || neverVideo) });
  const newChat = f.w.document.createElement('button'); newChat.setAttribute('aria-label', 'New side chat'); newChat.textContent = '+'; f.w.document.body.appendChild(newChat);
  let closed = false, saved = null, failure = '', reads = 0, driverReturned = false, lateAdded = false, wasPending = false;
  const reports = [];
  f.w.AbortController = AbortController;
  f.w.fetch = async url => {
    reads++;
    if (temporaryVideo && reads === 1) return new Response('not ready', { status: 404 });
    return new Response(mp4(), { headers: { 'content-type': 'video/mp4' } });
  };
  const addVideo = () => {
    const card = f.w.document.createElement('div'); const video = f.w.document.createElement('video'); video.src = '/generated.mp4';
    card.appendChild(video); f.w.document.getElementById('messages').appendChild(card);
  };
  f.w.document.querySelector('main button').addEventListener('click', () => {
    if (editorState === 'disabled') f.input.disabled = true;
    if (editorState === 'removed') f.input.remove();
    if (!lateVideo && !neverVideo) addVideo();
  });
  const context = { console: { log() {} }, Date: f.w.Date,
    trackJob: () => ({}), heartbeat: async () => {}, setInterval: () => 1, clearInterval() {},
    chrome: { tabs: { query: async () => [], create: async () => ({ id: 42 }), get: async () => ({ url: 'https://muse.ai/chat/job' }), update: async () => {}, remove: async () => { closed = true; } } },
    report: message => reports.push(message), MUSECHAT_HOME_URL: 'https://muse.ai/', ensureMuseChatHook: async () => {},
    execMain: async (_tab, fn, args = []) => { const result = await f.w.eval('(' + fn.toString() + ')')(...args); if (fn.name === 'museChatDriveUi') { driverReturned = true; wasPending = !!result.pending; } if (navigates && fn.name === 'museChatDriveUi') throw new Error('Execution context destroyed'); return result; },
    downloadRef: async () => ({ dataUrl: 'data:image/png;base64,YQ==', mime: 'image/png', name: 'ref.png' }),
    sleep: async ms => {
      if (driverReturned && lateVideo && !neverVideo && !lateAdded && ms === 2000) {
        assert.ok(f.w.__dramaMuseChatActiveJob, 'job must remain active after confirmation timeout');
        assert.equal(f.w.__dramaMuseChatActiveJob.confirmed, false);
        lateAdded = true; echoPrompt(f); addVideo();
      }
      await new Promise(resolve => f.w.setTimeout(resolve, ms));
    },
    completeVideo: async (_job, result) => { if (saveFails) throw new Error('Drama server unavailable'); saved = result; },
    fail: async (_job, message) => { failure = message; }, active: new Map(), anyRunning: () => false };
  context.clearMuseChatActive = async () => f.w.__dramaMuseChatClear();
  vm.createContext(context);
  vm.runInContext(extract('startMuseChatJob', 'const clearMuseChatActive') +
    extract('museChatWaitReady', '// Check whether') + extract('museChatIsNewChat', '// Click the') +
    extract('museChatClickNewChat', '// Type the prompt') + extract('museChatDriveUi', '// Download the video inside the page') +
    extract('museChatDownload', '// --- MAIN-world functions injected into the Google Vids'), context);
  await context.startMuseChatJob({ id: 'job', payload: { prompt, references: [{ asset: {} }] } });
  return { closed, saved, failure, reads, reports, wasPending, clicks: f.clicks() };
}
test('whole worker flow sends, observes, downloads, saves, then closes its owned tab', async t => {
  const result = await runWorker(t); assert.equal(result.failure, '', result.failure); assert.equal(result.saved?.mime, 'video/mp4'); assert.equal(result.closed, true); assert.equal(result.clicks, 1);
  assert.ok(result.reports.find(s => s.includes('lưu video')));
});
test('temporarily unavailable video is retried without resubmitting the prompt', async t => {
  const result = await runWorker(t, { temporaryVideo: true }); assert.equal(result.failure, '', result.failure); assert.ok(result.reads >= 2); assert.equal(result.clicks, 1); assert.equal(result.closed, true);
});
test('server save failure preserves the Muse tab and reports the actual failure', async t => {
  const result = await runWorker(t, { saveFails: true }); assert.match(result.failure, /Drama server unavailable/); assert.equal(result.closed, false); assert.equal(result.clicks, 1);
});

test('rejected prompt HTTP request is reported rather than waiting for a video', async t => {
  const f = fixture(t, { network: true, sendWorks: false, httpStatus: 429 });
  const result = await f.run(); assert.equal(result.ok, false); assert.match(result.detail, /HTTP 429/); assert.equal(f.requests(), 1);
});
test('confirmed job and old-video baseline survive document navigation', async t => {
  const f = fixture(t); f.w.document.getElementById('messages').innerHTML = '<video src="https://muse.ai/old.mp4"></video>';
  f.w.__dramaMuseChatArm('job', prompt); f.w.__dramaMuseChatConfirm();
  const savedSession = f.w.sessionStorage.getItem('__dramaMuseChatJob_v13');
  const restored = fixture(t, { savedSession });
  restored.w.document.getElementById('messages').innerHTML = '<video src="https://muse.ai/old.mp4"></video><div data-message-author-role="user">' + prompt + '</div><div><video src="https://muse.ai/new.mp4"></video></div>';
  restored.w.__dramaMuseChatPoll(); assert.equal(restored.w.__dramaMuseChatCaptured.videoUrl, 'https://muse.ai/new.mp4');
});
test('navigation destroying the send promise recovers without a second send', async t => {
  const result = await runWorker(t, { navigates: true }); assert.equal(result.failure, '', result.failure); assert.equal(result.clicks, 1); assert.equal(result.closed, true); assert.ok(result.saved);
});

test('late video after the 30s send-confirmation timeout is downloaded and saved', async t => {
  const result = await runWorker(t, { lateVideo: true });
  assert.equal(result.wasPending, true); assert.equal(result.failure, '', result.failure);
  assert.equal(result.saved?.mime, 'video/mp4'); assert.equal(result.clicks, 1); assert.equal(result.closed, true);
});
test('late video is collected while Muse disables the editor', async t => {
  const result = await runWorker(t, { lateVideo: true, editorState: 'disabled' });
  assert.equal(result.wasPending, true); assert.equal(result.failure, '', result.failure); assert.ok(result.saved); assert.equal(result.clicks, 1);
});
test('late video is collected when Muse removes the editor', async t => {
  const result = await runWorker(t, { lateVideo: true, editorState: 'removed' });
  assert.equal(result.wasPending, true); assert.equal(result.failure, '', result.failure); assert.ok(result.saved); assert.equal(result.clicks, 1);
});
test('navigation after an unconfirmed send continues watching the same job', async t => {
  const result = await runWorker(t, { lateVideo: true, navigates: true });
  assert.equal(result.failure, '', result.failure); assert.ok(result.saved); assert.equal(result.clicks, 1);
});
test('unconfirmed send cannot turn an existing sample video into a result', async t => {
  const f = fixture(t); f.w.document.getElementById('messages').innerHTML = '<video src="https://muse.ai/sample.mp4"></video>';
  f.w.__dramaMuseChatArm('job', prompt); f.input.disabled = true;
  f.w.__dramaMuseChatPoll(); assert.equal(f.w.__dramaMuseChatActiveJob.confirmed, false); assert.equal(f.w.__dramaMuseChatCaptured, null);
  // An image blob added after the send is also not a generated clip.
  f.w.document.getElementById('messages').insertAdjacentHTML('beforeend', '<a href="blob:https://muse.ai/image2">reference</a>');
  f.w.__dramaMuseChatPoll(); assert.equal(f.w.__dramaMuseChatCaptured, null);
});
test('pending session restores with no editor, retains baseline, and captures only new video', async t => {
  const f = fixture(t); f.w.document.getElementById('messages').innerHTML = '<video src="https://muse.ai/old.mp4"></video>';
  f.w.__dramaMuseChatArm('job', prompt);
  const savedSession = f.w.sessionStorage.getItem('__dramaMuseChatJob_v13');
  const restored = fixture(t, { savedSession }); restored.input.remove();
  restored.w.document.getElementById('messages').innerHTML = '<video src="https://muse.ai/old.mp4"></video><div data-message-author-role="user">' + prompt + '</div>';
  restored.w.__dramaMuseChatPoll(); assert.equal(restored.w.__dramaMuseChatActiveJob.confirmed, false);
  restored.w.document.getElementById('messages').insertAdjacentHTML('beforeend', '<div><video src="https://muse.ai/new.mp4"></video></div>');
  restored.w.__dramaMuseChatPoll(); assert.equal(restored.w.__dramaMuseChatCaptured.videoUrl, 'https://muse.ai/new.mp4');
});
test('no-result job waits the full video deadline, keeps tab open, and never resends', async t => {
  const result = await runWorker(t, { neverVideo: true }); assert.match(result.failure, /10 phút/); assert.equal(result.closed, false); assert.equal(result.saved, null); assert.equal(result.clicks, 1);
});

test('UI confirmation exception after clicking keeps the observation job alive', async t => {
  const f = fixture(t, { sendWorks: false });
  f.w.document.querySelector('button').addEventListener('click', () => {
    f.input.value = '';
    f.w.__dramaMuseChatUi.hasMessage = () => { throw new Error('transcript rerendered'); };
  });
  const result = await f.run(); assert.equal(result.ok, true); assert.equal(result.pending, true);
  assert.equal(f.w.__dramaMuseChatActiveJob.queueId, 'job'); assert.equal(f.clicks(), 1);
  echoPrompt(f);
  f.w.document.getElementById('messages').insertAdjacentHTML('beforeend', '<div><video src="https://muse.ai/late.mp4"></video></div>');
  f.w.__dramaMuseChatPoll(); assert.equal(f.w.__dramaMuseChatCaptured.videoUrl, 'https://muse.ai/late.mp4');
});
test('ambiguous HTTP 500 after sending keeps watching for a late video', async t => {
  const f = fixture(t, { sendWorks: false, network: true, httpStatus: 500 });
  const result = await f.run(); assert.equal(result.ok, true); assert.equal(result.pending, true);
  assert.equal(f.w.__dramaMuseChatError, null); assert.ok(f.w.__dramaMuseChatWarning);
  echoPrompt(f);
  f.w.document.getElementById('messages').insertAdjacentHTML('beforeend', '<div><video src="https://muse.ai/late500.mp4"></video></div>');
  f.w.__dramaMuseChatPoll(); assert.equal(f.w.__dramaMuseChatCaptured.videoUrl, 'https://muse.ai/late500.mp4'); assert.equal(f.clicks(), 1);
});
test('a recreated previous video before the current prompt is never captured', async t => {
  const f = fixture(t); const messages = f.w.document.getElementById('messages');
  messages.innerHTML = '<div id="old-card"><video src="blob:https://muse.ai/old-a"></video></div>';
  f.w.__dramaMuseChatArm('job', prompt); f.w.__dramaMuseChatConfirm();
  messages.querySelector('#old-card').innerHTML = '<video src="blob:https://muse.ai/old-b"></video>';
  echoPrompt(f);
  f.w.__dramaMuseChatPoll();
  assert.equal(f.w.__dramaMuseChatCaptured, null);
  messages.insertAdjacentHTML('beforeend', '<div class="new-result"><div><video src="blob:https://muse.ai/new-result"></video></div></div>');
  f.w.__dramaMuseChatPoll();
  assert.equal(f.w.__dramaMuseChatCaptured.videoUrl, 'blob:https://muse.ai/new-result');
});
