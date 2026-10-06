// Drama Tool ChatGPT worker — MV3 service worker.
//
// It is the "web worker" the Drama Tool server already speaks to:
//   POST /api/worker/claim      -> take one queued job (image, site = chatgpt)
//   POST /api/worker/heartbeat  -> keep the lease alive while generating
//   POST /api/worker/complete   -> hand the finished image back (base64)
//   POST /api/worker/fail       -> report a failure for review (no auto-retry billing)
// All of that is authed with a Bearer worker token the user pastes into the popup.
//
// Parallelism: this worker runs up to `concurrency` jobs at once (default 3), each in its own
// ChatGPT tab. Run several browser profiles / ChatGPT accounts, each with this extension, for
// more throughput — the server allows several web jobs at once (MV_WORKER_CONCURRENCY).
//
// Lifetime: MV3 kills idle service workers. A 30s alarm resurrects this one to poll; while a
// job runs we hold a Port to its tab and heartbeat every 10s, both of which keep it alive.

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:7788',
  token: '',
  running: false,
  workerName: 'ChatGPT extension',
  concurrency: 3, // ChatGPT jobs this account runs at once (one tab each)
  // Prepended to every job prompt so ChatGPT returns a single image and nothing else.
  // {aspect} is replaced with the job's aspect ratio.
  promptPrefix:
    'Generate one single image based strictly on the description below. ' +
    'Aspect ratio {aspect}. Reply with only the image, no text. Description:\n\n',
  // Prepended for an edit job: the current image is attached; change only what is described.
  editPrefix:
    'Edit the attached image. Keep everything else exactly the same — same person, framing, ' +
    'colours and lighting — and change only what is described. Reply with only the edited image, ' +
    'no text. Change:\n\n',
};

let cfg = { ...DEFAULTS };
const active = new Map(); // jobId -> { tabId } for jobs currently running
let tabPool = []; // free ChatGPT tab ids, reused across jobs
let polling = false;
let pollTimer = null;
let lastMsg = '';

const clampConc = () => Math.max(1, Math.min(6, Math.floor(Number(cfg.concurrency) || 3)));

// A stable random id per install (= per browser profile = per ChatGPT account), so several
// profiles running this extension count as distinct workers in the app even with the same name.
let workerId = '';
async function loadCfg() {
  cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (!workerId) {
    let { clientId } = await chrome.storage.local.get('clientId');
    if (!clientId) {
      clientId = Math.random().toString(36).slice(2, 8);
      await chrome.storage.local.set({ clientId });
    }
    workerId = clientId;
  }
  return cfg;
}
const effName = () => (cfg.workerName || 'ChatGPT') + ' #' + workerId;
function report(msg, isError = false) {
  lastMsg = String(msg || '');
  const text = active.size ? `${active.size} job đang chạy · ${lastMsg}` : lastMsg;
  return chrome.storage.local.set({ status: text, statusAt: Date.now(), statusError: !!isError });
}

// ---- worker HTTP protocol -------------------------------------------------
const apiBase = () => String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
// Each open project is its own window, its own server, its own port — and its own queue. One
// extension serves all of them, so every call names the window it is talking to instead of a
// single configured address.
async function api(base, path, bodyObj) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (cfg.token || '') },
    body: JSON.stringify(bodyObj || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || 'HTTP ' + r.status);
    e.status = r.status;
    throw e;
  }
  return data;
}
const claim = base =>
  // We can run image jobs (ChatGPT image gen) and text jobs (the Director agent: type a prompt,
  // scrape the reply). The server only hands a text job to a worker that lists 'text'.
  api(base, '/api/worker/claim', { name: effName(), kinds: ['image', 'text'] }).then(d => {
    // The lease, the reference images and the finished file all belong to the window that
    // handed the job over, so the job carries that address with it.
    if (d.job) d.job.__base = base;
    return d.job || null;
  });
const heartbeat = job =>
  api(job.__base, '/api/worker/heartbeat', { id: job.id, lease: job.lease, name: effName() });
const complete = (job, out) =>
  api(job.__base, '/api/worker/complete', {
    id: job.id,
    lease: job.lease,
    name: (job.nodeId || 'chatgpt') + extFor(out.mime),
    mime: out.mime,
    base64: out.base64,
  });
// A text job returns a string, not a file: the server stores job.result.text.
const completeText = (job, text) =>
  api(job.__base, '/api/worker/complete', {
    id: job.id,
    lease: job.lease,
    name: (job.nodeId || 'director') + '.txt',
    text: String(text || ''),
  });
const fail = (job, error) =>
  api(job.__base, '/api/worker/fail', {
    id: job.id,
    lease: job.lease,
    error: String(error).slice(0, 2000),
    needsReview: true,
  });

const extFor = mime => (mime === 'image/webp' ? '.webp' : mime === 'image/jpeg' ? '.jpg' : '.png');

// Verifies the base URL + token without claiming a job: a heartbeat for a non-existent job
// gets past auth (401 = bad token) and is then rejected by the lease check (auth was fine).
async function testConnection() {
  try {
    const r = await fetch(apiBase() + '/api/worker/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (cfg.token || '') },
      body: JSON.stringify({ id: '__probe__', lease: '__probe__' }),
    });
    if (r.status === 401) return { ok: false, message: 'Token sai hoặc thiếu.' };
    if (r.ok || r.status === 400) return { ok: true, message: 'Kết nối OK — token hợp lệ.' };
    return { ok: false, message: 'Máy chủ trả lỗi ' + r.status + '.' };
  } catch (e) {
    return {
      ok: false,
      message: 'Không gọi được máy chủ: ' + e.message + ' (Drama Tool đã chạy chưa?)',
    };
  }
}

// ---- base64 helpers (no FileReader in a service worker) --------------------
function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
async function downloadRef(base, asset) {
  // Media is per project, so a reference must be fetched from the window that owns the job —
  // the same path on another window is a different image, or missing.
  const url = asset.url.startsWith('http') ? asset.url : base + asset.url;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Không tải được ảnh tham chiếu ' + asset.url);
  const buf = new Uint8Array(await r.arrayBuffer());
  const mime = r.headers.get('content-type') || asset.mime || 'image/png';
  return {
    dataUrl: 'data:' + mime + ';base64,' + bytesToBase64(buf),
    mime,
    name: asset.name || asset.id || 'ref.png',
  };
}
// Downloads the generated image the content script pointed us at (cross-origin, so the
// service worker fetches it with the extension's host permissions).
async function fetchImageAsBase64(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('Không tải được ảnh kết quả (HTTP ' + r.status + ')');
  let mime = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) mime = 'image/png';
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!buf.length) throw new Error('Ảnh kết quả rỗng');
  return { base64: bytesToBase64(buf), mime };
}

// ---- ChatGPT tab pool -----------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function loadPool() {
  const { tabPool: saved } = await chrome.storage.local.get('tabPool');
  tabPool = Array.isArray(saved) ? saved : [];
}
const savePool = () => chrome.storage.local.set({ tabPool });
async function acquireTab() {
  while (tabPool.length) {
    const id = tabPool.shift();
    try {
      await chrome.tabs.get(id);
      await savePool();
      return id;
    } catch {} // tab was closed; drop it
  }
  await savePool();
  const t = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
  return t.id;
}
async function releaseTab(id) {
  if (id == null) return;
  try {
    await chrome.tabs.get(id);
  } catch {
    return; // gone
  }
  if (tabPool.length >= clampConc()) {
    try {
      await chrome.tabs.remove(id);
    } catch {}
  } else {
    tabPool.push(id);
    await savePool();
  }
}
async function waitTabComplete(tabId, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return;
    await sleep(400);
  }
  throw new Error('Tab ChatGPT tải quá lâu');
}
// Content scripts are declared in the manifest, but a page open before install (or an odd SPA
// state) may have none: inject on demand, then ping until it answers.
async function ensureContentReady(tabId, timeout = 20000) {
  const end = Date.now() + timeout;
  let injected = false;
  while (Date.now() < end) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (res && res.ready) return;
    } catch {
      if (!injected) {
        injected = true;
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content-chatgpt.js'],
          });
        } catch {}
      }
    }
    await sleep(400);
  }
  throw new Error('Content script ChatGPT chưa sẵn sàng (đã đăng nhập chưa?)');
}

// Runs one generation over a Port to the tab's content script. The open port also keeps this
// service worker alive for the whole (possibly long) generation.
function generateInTab(tabId, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: 'job:' + payload.jobId });
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {}
      fn(arg);
    };
    port.onMessage.addListener(msg => {
      if (msg.progress) onProgress(msg.progress);
      else if (msg.done) {
        if (msg.error) done(reject, new Error(msg.error));
        else done(resolve, { imageUrl: msg.imageUrl, base64: msg.base64, mime: msg.mime });
      }
    });
    port.onDisconnect.addListener(() => done(reject, new Error('Mất kết nối tới tab ChatGPT')));
    port.postMessage({ cmd: 'generate', prompt: payload.prompt, images: payload.images });
  });
}

function buildPrompt(jobPayload) {
  // An edit attaches the current image and changes only what is asked; a plain job describes a
  // new image to generate.
  if (jobPayload.edit) return (cfg.editPrefix || DEFAULTS.editPrefix) + (jobPayload.prompt || '');
  const prefix = (cfg.promptPrefix || DEFAULTS.promptPrefix).replace(
    '{aspect}',
    jobPayload.aspectRatio || '16:9',
  );
  return prefix + (jobPayload.prompt || '');
}

// A text turn (Director agent): type the prompt into ChatGPT and scrape the reply text.
function askInTab(tabId, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: 'job:' + payload.jobId });
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {}
      fn(arg);
    };
    port.onMessage.addListener(msg => {
      if (msg.progress) onProgress(msg.progress);
      else if (msg.done) {
        if (msg.error) done(reject, new Error(msg.error));
        else done(resolve, { text: msg.text || '' });
      }
    });
    port.onDisconnect.addListener(() => done(reject, new Error('Mất kết nối tới tab ChatGPT')));
    port.postMessage({ cmd: 'ask', prompt: payload.prompt });
  });
}

// ---- one job --------------------------------------------------------------
async function startJob(job) {
  active.set(job.id, {}); // reserve a slot synchronously so poll() counts it
  const hb = setInterval(() => heartbeat(job).catch(() => {}), 10000);
  let tabId = null;
  try {
    const site = job.payload.site || 'chatgpt';
    if (site !== 'chatgpt') throw new Error('Chưa hỗ trợ site: ' + site);

    // Text turn (Director agent): no reference images, no image prefix — just ask and scrape.
    if (job.kind === 'text') {
      report('mở ChatGPT…');
      tabId = await acquireTab();
      active.set(job.id, { tabId });
      await chrome.tabs.update(tabId, { url: 'https://chatgpt.com/' });
      await waitTabComplete(tabId);
      await ensureContentReady(tabId);
      report('hỏi ChatGPT (Đạo diễn)…');
      const out = await askInTab(tabId, { jobId: job.id, prompt: job.payload.prompt || '' }, p =>
        report(p),
      );
      if (!out.text || !out.text.trim()) throw new Error('ChatGPT không trả về nội dung');
      await completeText(job, out.text);
      report('✓ xong ' + job.id.slice(0, 8));
      return; // the finally below still releases the tab and re-polls
    }
    if (job.kind !== 'image') throw new Error('Worker này chỉ tạo ảnh hoặc chạy Đạo diễn');

    report('tải ' + (job.payload.references || []).length + ' ảnh tham chiếu…');
    const images = [];
    for (const ref of job.payload.references || [])
      images.push(await downloadRef(job.__base, ref.asset));

    report('mở ChatGPT…');
    tabId = await acquireTab();
    active.set(job.id, { tabId });
    await chrome.tabs.update(tabId, { url: 'https://chatgpt.com/' });
    await waitTabComplete(tabId);
    await ensureContentReady(tabId);

    report('tạo ảnh trên ChatGPT…');
    let out = await generateInTab(
      tabId,
      { jobId: job.id, prompt: buildPrompt(job.payload), images },
      p => report(p),
    );
    if (out.imageUrl && !out.base64) out = await fetchImageAsBase64(out.imageUrl);
    if (!out.base64 || !out.mime) throw new Error('Không lấy được ảnh kết quả');

    await complete(job, out);
    report('✓ xong ' + job.id.slice(0, 8));
  } catch (e) {
    await fail(job, e.message).catch(() => {});
    report('✗ ' + e.message, true);
  } finally {
    clearInterval(hb);
    active.delete(job.id);
    await releaseTab(tabId);
    if (cfg.running) poll();
  }
}

// ---- poll loop ------------------------------------------------------------
// The windows to pull from. The configured address is only a way in: it reports every window
// alive right now, so opening another project mid-run needs no setting change. An app too old
// to answer (or a window that just closed) falls back to the configured address alone.
let ring = 0;
async function bases() {
  const entry = apiBase();
  try {
    const r = await fetch(entry + '/api/worker/windows', {
      headers: { Authorization: 'Bearer ' + (cfg.token || '') },
    });
    if (r.ok) {
      const ports = (await r.json()).ports || [];
      const list = ports.map(p => 'http://127.0.0.1:' + p);
      if (list.length) return list;
    }
  } catch {}
  return [entry];
}

async function poll() {
  if (!cfg.running || polling) return;
  polling = true;
  try {
    const list = await bases();
    // One pass per free tab, and each pass starts one window further along, so a project with
    // a hundred queued shots cannot starve the ones beside it. The real ChatGPT ceiling is
    // clampConc() here — this account's tabs — not any single window's setting.
    while (cfg.running && active.size < clampConc()) {
      let job = null,
        errors = 0,
        last = '';
      for (let i = 0; i < list.length && !job; i++) {
        try {
          job = await claim(list[(ring + i) % list.length]);
        } catch (e) {
          errors++;
          last = e.message;
        }
      }
      ring = (ring + 1) % list.length;
      if (errors === list.length) {
        report('Lỗi kết nối: ' + last, true);
        break;
      }
      if (!job) break;
      startJob(job); // not awaited: run in parallel, fill the next slot
    }
    if (!active.size) report(`Đang chờ job… (${list.length} cửa sổ)`);
  } finally {
    polling = false;
  }
  scheduleSoon();
}
function scheduleSoon(ms = 5000) {
  clearTimeout(pollTimer);
  if (cfg.running) pollTimer = setTimeout(poll, ms);
}

async function start() {
  await loadCfg();
  await loadPool();
  chrome.alarms.create('poll', { periodInMinutes: 0.5 }); // 30s wake-up if the worker was killed
  report('Worker đã bật');
  poll();
}
async function stop() {
  await loadCfg();
  chrome.alarms.clear('poll');
  clearTimeout(pollTimer);
  report('Worker đã tắt');
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'poll') loadCfg().then(() => cfg.running && poll());
});
chrome.runtime.onStartup.addListener(() => loadCfg().then(() => cfg.running && start()));
chrome.runtime.onInstalled.addListener(() => loadCfg().then(() => cfg.running && start()));

// ---- popup messages -------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await loadCfg();
    if (msg.type === 'getStatus') {
      const s = await chrome.storage.local.get(['status', 'statusAt', 'statusError']);
      sendResponse({ cfg, active: active.size, ...s });
    } else if (msg.type === 'setConfig') {
      await chrome.storage.local.set(msg.cfg || {});
      await loadCfg();
      sendResponse({ ok: true, cfg });
    } else if (msg.type === 'start') {
      await chrome.storage.local.set({ running: true });
      await start();
      sendResponse({ ok: true });
    } else if (msg.type === 'stop') {
      await chrome.storage.local.set({ running: false });
      await stop();
      sendResponse({ ok: true });
    } else if (msg.type === 'testConnection') {
      sendResponse(await testConnection());
    } else sendResponse({ ok: false, error: 'unknown message' });
  })();
  return true; // async sendResponse
});

loadCfg().then(() => cfg.running && start());
