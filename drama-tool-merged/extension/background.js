// Drama Tool web worker — MV3 service worker.
//
// It is the "web worker" the Drama Tool server already speaks to:
//   POST /api/worker/claim      -> take one queued job (image/text = ChatGPT, video = Google Vids)
//   POST /api/worker/heartbeat  -> keep the lease alive while generating
//   POST /api/worker/complete   -> hand the finished file/text back
//   POST /api/worker/fail       -> report a failure for review (no auto-retry billing)
// All authed with a Bearer worker token the user pastes into the popup.
//
// TWO INDEPENDENT WORKERS, toggled separately, able to run at the same time:
//   • ChatGPT worker  — claims kinds ['image','text','recover']; one ChatGPT tab per job (up to
//     concChatgpt). A 'recover' job (job.recover.conversationUrl) re-opens the ChatGPT conversation
//     of an earlier image job and collects its image — it never sends a prompt.
//   • Google Vids worker — claims kind ['video'] (only jobs tagged site='googlevids'); drives an
//     already-open Google Vids document tab (serial, concVids). Each is enabled on its own, so you
//     can run just images, just video, or both.
//
// The claim is capacity-aware: each poll asks only for the kinds a currently-enabled, not-full
// worker can take, so an idle video worker never starves busy image slots and vice-versa.
//
// Lifetime: MV3 kills a service worker ~30s after its last extension event or API call (a fetch()
// does not count). A 30s alarm resurrects this one to poll; while any job runs, keepAlive() calls
// an extension API every 20s so the job's port, timers and result are not lost mid-generation.
//
// ChatGPT web state per job: the content script reports when the prompt was SENT and the
// conversation URL (/c/<id>). Both go to the server in heartbeats / complete / fail, so an image
// that arrives late can still be accepted or recovered from that conversation, and a failure
// before the send is reported as safe to re-run (needsReview false).

// CALIBRATE: the URL that opens a fresh empty Muse web chat while logged in.
// Open it once by hand and paste the exact URL here.
const MUSECHAT_NEW_CHAT_URL = 'https://muse.ai/';

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:7788',
  token: '',
  runChatgpt: false, // ChatGPT image/text worker on?
  runVids: false, // Google Vids video worker on?
  runMuseChat: false, // Muse Chat video worker on? (unlimited tabs, one tab per job)
  workerName: 'Drama worker',
  // ChatGPT jobs this account runs at once (one tab each). Kept low: one account answering several
  // image prompts at once tends to reply with text ("wait for the current image") instead.
  concChatgpt: 2,
  concVids: 1, // Google Vids jobs at once (serial; shares the open Vids doc tab)
  // Prepended to every image job prompt so ChatGPT returns a single image and nothing else.
  promptPrefix:
    'Generate one single image based strictly on the description below. ' +
    'Aspect ratio {aspect}. Reply with only the image, no text. Description:\n\n',
  editPrefix:
    'Edit the attached image. Keep everything else exactly the same — same person, framing, ' +
    'colours and lighting — and change only what is described. Reply with only the edited image, ' +
    'no text. Change:\n\n',
};

let cfg = { ...DEFAULTS };
// jobId -> { sub:'chatgpt'|'vids', tabId, sent, conversationUrl, progress } for running jobs
const active = new Map();
let tabPool = []; // free ChatGPT tab ids, reused across jobs
let polling = false;
let pollTimer = null;
let lastMsg = '';
// Set true if a replay was accepted by the server but returned no synchronous preview (the endpoint
// behaved async). Replay is then skipped for the rest of the session so later jobs do not each fire
// a wasted generate; the UI path keeps working. Resets when the service worker restarts.
let gvidsReplaySuspended = false;
// Diagnostic logging to the service-worker console (chrome://extensions → service worker).
const glog = (...a) => {
  try {
    console.log('[gvids]', ...a);
  } catch (_) {}
};

const anyRunning = () => !!(cfg.runChatgpt || cfg.runVids || cfg.runMuseChat);
const activeOf = sub => [...active.values()].filter(x => x.sub === sub).length;
// Vids is serial: every Vids job shares the one open Vids doc tab and the page-world
// __dramaGvids* globals (active job / captured / sample / suppress), so two at once cross-talk.
const concFor = sub =>
  sub === 'vids'
    ? 1
    : sub === 'musechat'
      ? Infinity // Muse Chat: unlimited — every command gets its own tab
      : Math.max(1, Math.min(6, Math.floor(Number(cfg.concChatgpt) || DEFAULTS.concChatgpt)));

// Chrome kills an MV3 service worker ~30s after its last extension event/API call. While any job
// runs, touch a cheap extension API every 20s so the worker (and the job's port, timers and
// result) stays alive; the timer stops itself once no job is active.
let keepAliveTimer = null;
function keepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (!active.size) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      return;
    }
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
}
// Registers a running job (synchronously, so poll() counts the slot) and returns its state.
function trackJob(job, sub) {
  const st = { sub, tabId: null, sent: false, conversationUrl: '', progress: '' };
  active.set(job.id, st);
  keepAlive();
  return st;
}

// A stable random id per install (= per browser profile = per account), so several profiles
// running this extension count as distinct workers in the app even with the same name.
let workerId = '';
let migrated = false;
async function loadCfg() {
  cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (!migrated) {
    migrated = true;
    // Migrate a pre-0.3 install (single "running" ChatGPT worker + "concurrency").
    const legacy = await chrome.storage.local.get(['running', 'concurrency', 'migratedV3']);
    if (!legacy.migratedV3) {
      const patch = { migratedV3: true };
      if (legacy.running === true) patch.runChatgpt = true;
      if (Number(legacy.concurrency)) patch.concChatgpt = Number(legacy.concurrency);
      await chrome.storage.local.set(patch);
      cfg = { ...cfg, ...patch };
    }
  }
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
const effName = () => (cfg.workerName || 'Drama') + ' #' + workerId;
function report(msg, isError = false) {
  lastMsg = String(msg || '');
  return chrome.storage.local.set({
    status: lastMsg,
    statusAt: Date.now(),
    statusError: !!isError,
    activeChatgpt: activeOf('chatgpt'),
    activeVids: activeOf('vids'),
    activeMuseChat: activeOf('musechat'),
  });
}

// ---- worker HTTP protocol -------------------------------------------------
const apiBase = () => String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
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
// Each call names the kinds this worker can run right now; the server only hands over a job whose
// kind is in that list. The claimed job carries the window address it came from.
const claim = (base, kinds, sites) =>
  api(base, '/api/worker/claim', {
    name: effName(),
    kinds,
    ...(sites && sites.length ? { sites } : {}),
  }).then(d => {
    if (d.job) d.job.__base = base;
    return d.job || null;
  });
// st (a ChatGPT job's state) adds what the server needs to keep a late image recoverable: the
// latest progress line, whether the prompt was sent, and the conversation URL.
const heartbeat = (job, st) =>
  api(job.__base, '/api/worker/heartbeat', {
    id: job.id,
    lease: job.lease,
    name: effName(),
    ...(st && {
      progress: st.progress || undefined,
      sent: !!st.sent,
      conversationUrl: st.conversationUrl || undefined,
    }),
  });
// A finished result is precious (the generation was already spent), so a network error or 5xx
// (server busy or restarting) is retried with backoff; a 4xx is a definite "no" (lease gone).
const COMPLETE_RETRY_S = [2, 5, 15, 30, 60];
async function sendComplete(job, body) {
  for (let i = 0; ; i++) {
    try {
      return await api(job.__base, '/api/worker/complete', {
        id: job.id,
        lease: job.lease,
        ...body,
      });
    } catch (e) {
      if ((e.status && e.status < 500) || i >= COMPLETE_RETRY_S.length) throw e;
      report(`gửi kết quả lỗi (${e.message}) — thử lại sau ${COMPLETE_RETRY_S[i]}s…`, true);
      await sleep(COMPLETE_RETRY_S[i] * 1000);
    }
  }
}
const complete = (job, out, st) =>
  sendComplete(job, {
    name: (job.nodeId || 'chatgpt') + extFor(out.mime),
    mime: out.mime,
    base64: out.base64,
    conversationUrl: (st && st.conversationUrl) || undefined,
  });
const completeText = (job, text) =>
  sendComplete(job, {
    name: (job.nodeId || 'director') + '.txt',
    text: String(text || ''),
  });
const completeVideo = (job, out) =>
  sendComplete(job, {
    name: (job.nodeId || 'googlevids') + '.mp4',
    mime: out.mime || 'video/mp4',
    base64: out.base64,
  });
// needsReview = the prompt was sent: the site may still deliver (and has spent a generation), so
// the server keeps the job for review / recovery. Not sent = nothing happened there, safe to
// re-run. Without st (Google Vids) it stays the old always-review behaviour.
const fail = (job, error, st, replyText) =>
  api(job.__base, '/api/worker/fail', {
    id: job.id,
    lease: job.lease,
    error: String(error).slice(0, 2000),
    needsReview: st ? !!st.sent : true,
    ...(st && {
      conversationUrl: st.conversationUrl || undefined,
      replyText: replyText ? String(replyText).slice(0, 2000) : undefined,
    }),
  });

const extFor = mime => (mime === 'image/webp' ? '.webp' : mime === 'image/jpeg' ? '.jpg' : '.png');

// Verifies the base URL + token without claiming a job: a heartbeat for a non-existent job gets
// past auth (401 = bad token) and is then rejected by the lease check (auth was fine).
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
// The image type from the bytes themselves (a 200 challenge / error page is not an image).
const sniffMime = b =>
  b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    ? 'image/png'
    : b[0] === 0xff && b[1] === 0xd8
      ? 'image/jpeg'
      : b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57
        ? 'image/webp'
        : null;
async function fetchImageAsBase64(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('Không tải được ảnh kết quả (HTTP ' + r.status + ')');
  const buf = new Uint8Array(await r.arrayBuffer());
  const mime = sniffMime(buf);
  if (!mime) throw new Error('Kết quả tải về không phải ảnh (trang lỗi hoặc cần xác minh)');
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
  let id = null;
  while (tabPool.length && id == null) {
    const t = tabPool.shift();
    try {
      await chrome.tabs.get(t);
      id = t;
    } catch {} // tab was closed; drop it
  }
  await savePool();
  if (id == null)
    id = (await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false })).id;
  // Memory Saver must not discard a worker tab mid-job (that cuts the port and loses the image).
  await chrome.tabs.update(id, { autoDiscardable: false }).catch(() => {});
  return id;
}
async function releaseTab(id) {
  if (id == null) return;
  try {
    await chrome.tabs.get(id);
  } catch {
    return; // gone
  }
  if (tabPool.length >= concFor('chatgpt')) {
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
  throw new Error('Tab tải quá lâu');
}
// accept(href, doc) rejects a ping from the document the tab is leaving (e.g. the previous job's
// conversation still answering right after the navigation started): every content script answers
// with its own document id.
async function ensureContentReady(tabId, accept = () => true, timeout = 20000) {
  const end = Date.now() + timeout;
  let injected = false;
  let wrongHref = '';
  while (Date.now() < end) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (res && res.ready) {
        if (accept(String(res.href || ''), res.doc)) return;
        wrongHref = String(res.href || '');
      }
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
  if (wrongHref) throw new Error('Tab ChatGPT không mở đúng trang (' + wrongHref + ')');
  throw new Error('Content script ChatGPT chưa sẵn sàng (đã đăng nhập chưa?)');
}
// Navigate a worker tab and wait for a content script answering from the new document (not the
// one it showed before, even when that was the same URL).
async function openChatgpt(tabId, url, accept) {
  const before = await chrome.tabs
    .sendMessage(tabId, { type: 'ping' })
    .then(r => r && r.doc)
    .catch(() => null);
  await chrome.tabs.update(tabId, { url });
  await waitTabComplete(tabId);
  await ensureContentReady(tabId, (href, doc) => (!before || doc !== before) && accept(href));
}

// The conversation URL in a chatgpt.com href (query/hash dropped), or '' if it is not one.
const CONV_RE = /^https:\/\/chatgpt\.com\/(?:g\/[\w-]+\/)?c\/[0-9a-f-]{36}$/;
const convUrl = href => {
  const u = String(href || '').split(/[?#]/)[0];
  return CONV_RE.test(u) ? u : '';
};
const freshChat = href => !convUrl(href); // a new chat, not the previous job's conversation

const say = (st, p) => {
  st.progress = String(p || '').slice(0, 200);
  report(p);
};

// Prompts sent to one ChatGPT account within seconds of each other tend to get a text reply
// instead of an image, so sends are spaced SEND_GAP_MS apart across all worker tabs.
const SEND_GAP_MS = 15000;
let lastStartAt = 0;
async function waitSendTurn(st) {
  const at = Math.max(Date.now(), lastStartAt + SEND_GAP_MS);
  lastStartAt = at; // reserved before awaiting, so parallel jobs line up one gap apart
  const wait = at - Date.now();
  if (wait > 0) {
    say(st, `chờ lượt gửi (giãn cách ${Math.ceil(wait / 1000)}s)…`);
    await sleep(wait);
  }
}

// Watchdogs: a frozen or silent tab must not hold a job (and its slot) forever — set past the
// content script's own worst case (uploads ~2.5 min + 8 min after the send + the download), so
// its precise error (and what ChatGPT answered) is the one reported.
const IMAGE_WATCHDOG_MS = 13 * 60 * 1000; // generate / collect
const TEXT_WATCHDOG_MS = 12 * 60 * 1000; // Director text (reasoning models think for minutes)

// Runs one command ({cmd:'generate'|'collect'|'ask'}) in a ChatGPT tab over a Port and settles
// with the final {done} message. Every message may also carry `sent` (the prompt was submitted)
// and `href` (the page URL, /c/<id> once ChatGPT names the conversation); both are recorded on
// st and the first of each is pushed to the server at once (st.beat) rather than at the next
// 10s tick. An error rejects with .replyText (what ChatGPT answered instead, if known); whether
// it happened after the send is read from st.sent by the caller.
function runInTab(tabId, jobId, cmd, st, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: 'job:' + jobId });
    let settled = false;
    let watchdog = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try {
        port.disconnect();
      } catch {}
      fn(arg);
    };
    const failWith = (message, replyText) => {
      const e = new Error(message);
      if (replyText) e.replyText = String(replyText);
      done(reject, e);
    };
    watchdog = setTimeout(
      () => failWith(`Quá thời gian chờ ChatGPT (${Math.round(timeoutMs / 60000)} phút)`),
      timeoutMs,
    );
    port.onMessage.addListener(msg => {
      if (!msg || settled) return;
      let news = false;
      if (msg.sent && !st.sent) {
        st.sent = true;
        news = true;
      }
      // the content script's final word that the prompt never went out (the composer still holds
      // it, no conversation started): nothing was spent, the job is safe to run again
      if (msg.done && msg.error && msg.sent === false) st.sent = false;
      const c = convUrl(msg.href);
      if (c && !st.conversationUrl) {
        st.conversationUrl = c;
        news = true;
      }
      if (msg.progress) say(st, msg.progress);
      if (news && st.beat) st.beat();
      if (msg.done) {
        if (msg.error) failWith(msg.error, msg.replyText);
        else done(resolve, msg);
      }
    });
    port.onDisconnect.addListener(() => failWith('Mất kết nối tới tab ChatGPT'));
    try {
      port.postMessage(cmd);
    } catch {
      failWith('Mất kết nối tới tab ChatGPT');
    }
  });
}
// A {done} image result as {base64, mime}: a URL the page could not read is fetched here.
async function toImage(out) {
  if (out.imageUrl && !out.base64) out = await fetchImageAsBase64(out.imageUrl);
  if (!out.base64 || !out.mime) throw new Error('Không lấy được ảnh kết quả');
  return { base64: out.base64, mime: out.mime };
}

function buildPrompt(jobPayload) {
  if (jobPayload.edit) return (cfg.editPrefix || DEFAULTS.editPrefix) + (jobPayload.prompt || '');
  const prefix = (cfg.promptPrefix || DEFAULTS.promptPrefix).replace(
    '{aspect}',
    jobPayload.aspectRatio || '16:9',
  );
  return prefix + (jobPayload.prompt || '');
}

// The server answers a late image with applied:false when its node already moved on.
const reportImageDone = (job, res) =>
  report(
    '✓ xong ' +
      job.id.slice(0, 8) +
      (res && res.applied === false ? ' (node đã đổi — ảnh chỉ lưu ở job)' : ''),
  );

// ---- one ChatGPT job (image, Director text, or recover = collect a late image) ----
async function startChatgptJob(job) {
  const st = trackJob(job, 'chatgpt'); // reserve a slot synchronously so poll() counts it
  st.beat = () => heartbeat(job, st).catch(() => {});
  const hb = setInterval(() => st.beat && st.beat(), 10000);
  try {
    const site = job.payload.site || 'chatgpt';
    if (site !== 'chatgpt') throw new Error('Chưa hỗ trợ site: ' + site);

    if (job.recover) {
      // The prompt went out in an earlier run; this one only re-opens that conversation and
      // collects its newest generated image. Never send anything here.
      st.sent = true;
      st.conversationUrl = convUrl(job.recover.conversationUrl);
      if (job.kind !== 'image' || !st.conversationUrl)
        throw new Error('Job lấy lại ảnh thiếu link cuộc trò chuyện ChatGPT hợp lệ');
      const convId = st.conversationUrl.split('/c/')[1];
      say(st, 'mở lại cuộc trò chuyện ChatGPT để lấy ảnh…');
      st.tabId = await acquireTab();
      await openChatgpt(st.tabId, st.conversationUrl, href => href.includes('/c/' + convId));
      const out = await runInTab(st.tabId, job.id, { cmd: 'collect' }, st, IMAGE_WATCHDOG_MS);
      reportImageDone(job, await complete(job, await toImage(out), st));
      return;
    }

    if (job.kind === 'text') {
      say(st, 'mở ChatGPT…');
      st.tabId = await acquireTab();
      await openChatgpt(st.tabId, 'https://chatgpt.com/', freshChat);
      await waitSendTurn(st);
      say(st, 'hỏi ChatGPT (Đạo diễn)…');
      const out = await runInTab(
        st.tabId,
        job.id,
        { cmd: 'ask', prompt: job.payload.prompt || '' },
        st,
        TEXT_WATCHDOG_MS,
      );
      if (!out.text || !String(out.text).trim()) throw new Error('ChatGPT không trả về nội dung');
      await completeText(job, out.text);
      report('✓ xong ' + job.id.slice(0, 8));
      return;
    }
    if (job.kind !== 'image') throw new Error('Worker ChatGPT chỉ tạo ảnh hoặc chạy Đạo diễn');

    say(st, 'tải ' + (job.payload.references || []).length + ' ảnh tham chiếu…');
    const images = [];
    for (const ref of job.payload.references || [])
      images.push(await downloadRef(job.__base, ref.asset));

    say(st, 'mở ChatGPT…');
    st.tabId = await acquireTab();
    await openChatgpt(st.tabId, 'https://chatgpt.com/', freshChat);
    await waitSendTurn(st);

    say(st, 'tạo ảnh trên ChatGPT…');
    const out = await runInTab(
      st.tabId,
      job.id,
      { cmd: 'generate', prompt: buildPrompt(job.payload), images },
      st,
      IMAGE_WATCHDOG_MS,
    );
    reportImageDone(job, await complete(job, await toImage(out), st));
  } catch (e) {
    // No more beats from here: one landing after the fail would revive the job on the server.
    clearInterval(hb);
    st.beat = null;
    // st.sent decides needsReview: after the send the image may still arrive in the conversation
    // (the server keeps the job and can re-queue it as a recover); before it, safe to re-run.
    // Land the send + conversation URL on the server first (the immediate beat may still be in
    // flight when the content script reported `sent` only in its final error).
    if (st.sent) await heartbeat(job, st).catch(() => {});
    await fail(job, e.message, st, e.replyText).catch(() => {});
    report('✗ ' + e.message, true);
  } finally {
    clearInterval(hb);
    active.delete(job.id);
    await releaseTab(st.tabId);
    if (anyRunning()) poll();
  }
}

// ---- Google Vids video job ------------------------------------------------
// Google Vids makes video inside a video DOCUMENT (the creation panel lives in the editor), and the
// user asked for a brand-new document per render. The worker keeps ONE tab of its own and, for each
// job, navigates it to mint a fresh doc — so it never hijacks a doc the user is editing and never
// piles up tabs. The old doc stays saved in the user's Drive (that is the "new doc per render"
// choice). The signed 1080p preview URL is read from the generate response, so clips never need to
// be kept in the doc.
let vidsWorkerTabId = null; // the worker's own Vids tab, reused across jobs

async function waitForDocUrl(tabId, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let t;
    try {
      t = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (/\/videos(?:\/u\/\d+)?\/d\//.test(t.url || '')) {
      try {
        await waitTabComplete(tabId, 25000);
      } catch {}
      await sleep(1500); // let the editor settle
      return true;
    }
    await sleep(600);
  }
  return false;
}

// Create a BRAND-NEW Google Vids document for this job and return its tab id, or null if it cannot
// reach a /d/ document (e.g. not logged into Google). Tries the Google-editors /create convention
// first, then falls back to clicking "start a new video" on the gallery.
async function createFreshVidsDoc() {
  let tabId = vidsWorkerTabId;
  if (tabId != null) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      tabId = null;
    }
  }
  if (tabId == null) {
    const t = await chrome.tabs.create({
      url: 'https://docs.google.com/videos/u/0/',
      active: false,
    });
    tabId = t.id;
  }
  vidsWorkerTabId = tabId;

  // Strategy 1: the /create convention (fast if Vids supports it, like Docs/Slides/Sheets).
  try {
    await chrome.tabs.update(tabId, { url: 'https://docs.google.com/videos/create' });
    if (await waitForDocUrl(tabId, 12000)) {
      glog('new doc via /create', tabId);
      return tabId;
    }
  } catch (e) {
    glog('/create error', String((e && e.message) || e));
  }

  // Strategy 2: open the gallery and click the "start a new video" card (+ any blank-template step).
  try {
    await chrome.tabs.update(tabId, { url: 'https://docs.google.com/videos/u/0/' });
    await waitTabComplete(tabId, 60000);
    await sleep(1500);
    const clicked = await execMain(tabId, async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const vis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 20 &&
          r.height > 20 &&
          s.visibility !== 'hidden' &&
          s.display !== 'none' &&
          Number(s.opacity || '1') > 0.05
        );
      };
      const lbl = el =>
        [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText, el.textContent]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
      const clickables = () =>
        [
          ...document.querySelectorAll(
            "button,[role='button'],a,[role='link'],[role='listitem'],[jsaction],div[role='button']",
          ),
        ].filter(vis);
      let el = clickables().find(e =>
        /bắt đầu một video mới|tạo video mới|new video|blank video|video trống/.test(lbl(e)),
      );
      if (!el)
        el = clickables().find(
          e =>
            e.querySelector('svg,img') != null &&
            /^\+?$/.test((e.innerText || '').replace(/\s/g, '')) &&
            e.getBoundingClientRect().top < window.innerHeight * 0.7,
        );
      if (!el) return { ok: false, detail: 'no new-video card' };
      el.click();
      await sleep(1600);
      for (let i = 0; i < 3; i++) {
        const blank = clickables().find(e =>
          /blank|trống|để trống|empty|bắt đầu từ đầu|from scratch/.test(lbl(e)),
        );
        if (blank) {
          blank.click();
          await sleep(1200);
          break;
        }
        await sleep(600);
      }
      return { ok: true, detail: lbl(el).slice(0, 40) };
    }).catch(e => ({ ok: false, detail: String((e && e.message) || e) }));
    glog('gallery click', JSON.stringify(clicked));
    if (await waitForDocUrl(tabId, 30000)) {
      glog('new doc via gallery click', tabId);
      return tabId;
    }
  } catch (e) {
    glog('gallery-create error', String((e && e.message) || e));
  }
  return null;
}
// Run a self-contained function in the page's MAIN world and get its return value.
async function execMain(tabId, func, args = []) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args,
  });
  return res && res[0] ? res[0].result : null;
}
async function ensureGvidsTabReady(tabId) {
  await waitTabComplete(tabId, 60000);
  for (let i = 0; i < 6; i++) {
    const ok = await execMain(tabId, () => !!window.__dramaGvidsHookInstalled).catch(() => false);
    if (ok) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['content-gvids-hook.js'],
      });
    } catch {}
    await sleep(500);
  }
  // Proceed regardless; the hook may install moments later as the SPA settles.
}

async function startVidsJob(job) {
  trackJob(job, 'vids');
  const hb = setInterval(() => heartbeat(job).catch(() => {}), 10000);
  let tabId = null;
  try {
    report('Google Vids: tạo một video mới…');
    tabId = await createFreshVidsDoc();
    if (tabId == null)
      throw new Error(
        'Không mở được video Google Vids mới. Hãy đăng nhập Google trong trình duyệt này rồi thử lại.',
      );
    active.set(job.id, { sub: 'vids', tabId });
    report('Google Vids: chuẩn bị…');
    const images = [];
    for (const ref of job.payload.references || []) {
      try {
        const r = await downloadRef(job.__base, ref.asset);
        images.push({ base64: r.dataUrl.split(',')[1], mime: r.mime, filename: r.name });
      } catch {}
    }
    const out = await generateVideo(tabId, job, images);
    if (!out.base64) throw new Error('Không lấy được video từ Google Vids');
    await completeVideo(job, out);
    report('✓ xong video ' + job.id.slice(0, 8));
  } catch (e) {
    await fail(job, e.message).catch(() => {});
    report('✗ ' + e.message, true);
  } finally {
    clearInterval(hb);
    active.delete(job.id);
    // Clear the page-world active-job marker on every exit — including when an execMain call itself
    // rejected (tab navigated/closed) and generateVideo threw before its own cleanup ran — so the
    // capture hook does not keep reading responses for a dead job.
    if (typeof tabId === 'number') await clearGvidsActive(tabId);
    if (anyRunning()) poll();
  }
}

// Matches the "8-second" → ~10s normalisation gvidsDriveUi does inside the page, for the prompt
// the replay path sends (Google Vids clips are ~10s).
function normalizeVidsDuration(text) {
  return String(text || '')
    .replace(
      /\b(?:an?\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine)\s*-\s*seconds?\b/gi,
      'a 10-second',
    )
    .replace(
      /\b(?:an?\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine)\s+seconds?\b/gi,
      '10 seconds',
    )
    .replace(/\ba\s+a\s+10-second\b/gi, 'a 10-second');
}

async function generateVideo(tabId, job, images) {
  await ensureGvidsTabReady(tabId);
  const queueId = job.id;
  const hasImages = Array.isArray(images) && images.length;
  const rawPrompt = String(job.payload.prompt || '');
  glog(
    'start job',
    job.id.slice(0, 8),
    'tab',
    tabId,
    'hasImages',
    !!hasImages,
    'replaySuspended',
    gvidsReplaySuspended,
    'promptLen',
    rawPrompt.length,
  );
  // Mark the job active for the page-world capture hook and clear any previous result.
  await execMain(
    tabId,
    qid => {
      window.__dramaGvidsCaptured = null;
      window.__dramaGvidsError = null;
      window.__dramaGvidsActiveJob = { queueId: qid };
    },
    [queueId],
  );

  // Fast path — replay a previously learned generate request with the new prompt, which skips UI
  // automation entirely. Text-to-video only: a job with reference images still goes through the UI
  // (replay cannot attach a freshly Scotty-uploaded image). Falls back to the UI if no sample has
  // been learned yet (the warm-up job) or the replay does not take.
  let usedReplay = false;
  let tagPrompt = null; // set on the UI path so a later replay can swap the prompt exactly
  if (!hasImages && rawPrompt && !gvidsReplaySuspended) {
    const sample = await execMain(tabId, () => {
      const s = window.__dramaGvidsSample;
      return s && Array.isArray(s.bodyJson) ? s : null;
    }).catch(() => null);
    glog(
      'replay check: sampleFound',
      !!sample,
      sample ? '(hasPromptText ' + !!sample.promptText + ')' : '',
    );
    if (sample) {
      report('Google Vids: replay API (nhanh)…');
      // started:false means the request was rejected/never sent (safe to fall back to the UI);
      // started:true means the server accepted it (a render may be running) so we must NOT fire a
      // second generate via the UI.
      const rep = await execMain(tabId, gvidsReplay, [
        sample,
        normalizeVidsDuration(rawPrompt),
        queueId,
      ]).catch(e => ({ ok: false, started: false, detail: String((e && e.message) || e) }));
      glog('replay result', JSON.stringify(rep));
      if (rep && rep.refused) {
        await clearGvidsActive(tabId);
        throw new Error('Google Vids từ chối yêu cầu (REQUEST_REFUSED / chính sách nội dung).');
      }
      if (rep && rep.ok) {
        usedReplay = true; // preview is already in __dramaGvidsCaptured; the poll loop downloads it
        report('Google Vids: đã gửi replay, tải video…');
      } else if (rep && rep.started) {
        // Accepted but no synchronous preview: commit to the poll loop (never double-fire via UI)
        // and suspend replay for the session so later jobs do not each waste a generate.
        usedReplay = true;
        gvidsReplaySuspended = true;
        report('Google Vids: đã gửi replay (chờ async; tắt replay cho phiên này)…');
      } else {
        report(
          'Google Vids: replay chưa dùng được (' +
            ((rep && rep.detail) || '?') +
            '), chuyển sang giao diện…',
        );
      }
    }
  }

  // UI path — the original automation, and the warm-up that teaches the hook a replay sample.
  if (!usedReplay) {
    report('Google Vids: điền prompt, đặt 1080p, bấm Tạo…');
    const drive = await execMain(tabId, gvidsDriveUi, [{ prompt: rawPrompt, images }]);
    glog('UI drive result', JSON.stringify(drive));
    if (!drive || !drive.ok) {
      await clearGvidsActive(tabId);
      throw new Error(
        'Google Vids: ' +
          ((drive && drive.detail) ||
            'không điều khiển được giao diện. Mở sẵn một video và bảng tạo video rồi thử lại.'),
      );
    }
    tagPrompt = (drive && drive.promptSet) || null;
  }

  glog('kicked via', usedReplay ? 'REPLAY' : 'UI', '— waiting for preview…');
  report('Google Vids: đang dựng video…');
  const TIMEOUT = 8 * 60 * 1000;
  const t0 = Date.now();
  let beat = 0;
  while (Date.now() - t0 < TIMEOUT) {
    const s = await execMain(
      tabId,
      (qid, tp) => {
        // Tag the freshly-learned sample with the exact prompt we typed, so a later replay swaps it.
        try {
          if (tp && window.__dramaGvidsSample && !window.__dramaGvidsSample.promptText)
            window.__dramaGvidsSample.promptText = tp;
        } catch (_) {}
        const c = window.__dramaGvidsCaptured;
        const e = window.__dramaGvidsError;
        let scan = '';
        try {
          const els = document.querySelectorAll(
            '[class*="Failedvideogeneration" i],[role="alert"],[class*="ErrorBanner" i],[class*="snackbar" i],[class*="toast" i]',
          );
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width < 10 || r.height < 5) continue;
            const t = (el.innerText || el.textContent || '').trim();
            if (
              /giới hạn|quota|không thể tạo|thử lại sau|failed|limit|exhausted|đạt đến giới hạn/i.test(
                t,
              )
            ) {
              scan = t.slice(0, 180);
              break;
            }
          }
        } catch (_) {}
        return {
          captured: c && c.queueId === qid ? c.previewUrl : '',
          error: e && e.queueId === qid ? e.detail : '',
          scan,
        };
      },
      [queueId, tagPrompt],
    );
    if (s && s.error) {
      glog('error signal', s.error);
      await clearGvidsActive(tabId);
      throw new Error(s.error);
    }
    if (s && s.scan) {
      glog('DOM error banner', s.scan);
      await clearGvidsActive(tabId);
      throw new Error('Google Vids báo lỗi: ' + s.scan);
    }
    if (s && s.captured) {
      glog('preview captured', String(s.captured).slice(0, 90));
      await clearGvidsActive(tabId);
      report('Google Vids: tải video 1080p…');
      const dl = await execMain(tabId, gvidsDownload, [s.captured]);
      glog(
        'download',
        dl && dl.base64 ? 'ok ' + (dl.size || '') + 'B' : 'FAIL ' + (dl && dl.detail),
      );
      if (!dl || !dl.base64)
        throw new Error((dl && dl.detail) || 'Không tải được video 1080p từ Google Vids.');
      return { base64: dl.base64, mime: dl.mime || 'video/mp4' };
    }
    if (Date.now() - beat > 10000) {
      beat = Date.now();
      report('Google Vids: đang dựng… ' + Math.round((Date.now() - t0) / 1000) + 's');
    }
    await sleep(2000);
  }
  glog('TIMEOUT after 8 min — no preview captured (via', usedReplay ? 'REPLAY' : 'UI', ')');
  await clearGvidsActive(tabId);
  throw new Error('Quá thời gian chờ Google Vids dựng video (8 phút).');
}
const clearGvidsActive = tabId =>
  execMain(tabId, () => {
    window.__dramaGvidsActiveJob = null;
  }).catch(() => {});

// ---- Muse Chat video job ----------------------------------------------------
// Automates the Muse web chat (https://muse.ai) exactly like doing it by hand: open a fresh
// chat tab, type the prompt, attach the reference image, send, wait for the video reply,
// download the MP4, hand it back.
//
// UNLIMITED TABS, ONE TAB PER COMMAND: every job opens its OWN background chat tab and closes
// it when done. No tab pool, no concurrency cap — the poll loop claims a musechat job whenever
// the worker is on. Each tab downloads only the video whose queueId matches its own job.
async function ensureMuseChatHook(tabId) {
  await waitTabComplete(tabId, 60000);
  for (let i = 0; i < 8; i++) {
    const ok = await execMain(tabId, () => !!window.__dramaMuseChatHookInstalled).catch(
      () => false,
    );
    if (ok) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['content-musechat-hook.js'],
      });
    } catch {}
    await sleep(600);
  }
  // Proceed regardless; the document_start content script usually installed it already.
}

async function startMuseChatJob(job) {
  const st = trackJob(job, 'musechat'); // reserve a slot synchronously so poll() counts it
  const hb = setInterval(() => heartbeat(job).catch(() => {}), 10000);
  let tabId = null;
  const queueId = job.id;
  try {
    report('Muse chat: mở tab riêng cho job ' + queueId.slice(0, 8) + '…');
    const tab = await chrome.tabs.create({ url: MUSECHAT_NEW_CHAT_URL, active: false });
    tabId = tab.id;
    st.tabId = tabId;
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: false });
    } catch {}

    await ensureMuseChatHook(tabId);

    // Mark this job active for the page-world hook and clear any previous result.
    await execMain(
      tabId,
      qid => {
        window.__dramaMuseChatCaptured = null;
        window.__dramaMuseChatError = null;
        window.__dramaMuseChatActiveJob = { queueId: qid };
      },
      [queueId],
    );

    const images = [];
    for (const ref of job.payload.references || []) {
      try {
        const r = await downloadRef(job.__base, ref.asset);
        images.push({ base64: r.dataUrl.split(',')[1], mime: r.mime, filename: r.name });
      } catch {}
    }

    report('Muse chat: gửi prompt' + (images.length ? ' + ảnh tham chiếu' : '') + '…');
    const drive = await execMain(tabId, museChatDriveUi, [
      { prompt: String(job.payload.prompt || ''), images },
    ]);
    if (!drive || !drive.ok) {
      await clearMuseChatActive(tabId);
      throw new Error(
        'Muse chat: ' + ((drive && drive.detail) || 'không điều khiển được giao diện chat.'),
      );
    }

    report('Muse chat: đang chờ video…');
    const TIMEOUT = 10 * 60 * 1000;
    const t0 = Date.now();
    let beat = 0;
    for (;;) {
      const s = await execMain(
        tabId,
        qid => {
          const c = window.__dramaMuseChatCaptured;
          const e = window.__dramaMuseChatError;
          return {
            // Only accept the capture whose queueId matches THIS job — the correct video id.
            captured: c && c.queueId === qid ? c.videoUrl : '',
            error: e && e.queueId === qid ? e.detail : '',
          };
        },
        [queueId],
      );
      if (s && s.error) {
        await clearMuseChatActive(tabId);
        throw new Error(s.error);
      }
      if (s && s.captured) {
        await clearMuseChatActive(tabId);
        report('Muse chat: tải video…');
        const dl = await execMain(tabId, museChatDownload, [s.captured]);
        if (!dl || !dl.base64)
          throw new Error((dl && dl.detail) || 'Không tải được video từ Muse chat.');
        await completeVideo(job, { base64: dl.base64, mime: dl.mime || 'video/mp4' });
        report('✓ xong video ' + queueId.slice(0, 8));
        return;
      }
      if (Date.now() - t0 > TIMEOUT) {
        await clearMuseChatActive(tabId);
        throw new Error('Quá thời gian chờ Muse tạo video (10 phút).');
      }
      if (Date.now() - beat > 15000) {
        beat = Date.now();
        report('Muse chat: đang chờ… ' + Math.round((Date.now() - t0) / 1000) + 's');
      }
      await sleep(2000);
    }
  } catch (e) {
    await fail(job, e.message).catch(() => {});
    report('✗ ' + e.message, true);
  } finally {
    clearInterval(hb);
    active.delete(job.id);
    if (typeof tabId === 'number') {
      await clearMuseChatActive(tabId);
      // Each command owns its tab: close it so tabs never pile up.
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
    if (anyRunning()) poll();
  }
}
const clearMuseChatActive = tabId =>
  execMain(tabId, () => {
    window.__dramaMuseChatActiveJob = null;
  }).catch(() => {});

// --- MAIN-world functions injected into the Muse chat tab (must be self-contained) ---
// Type the prompt, attach the reference image, send — exactly like doing it by hand.
// CALIBRATE the selectors below against the real logged-in muse.ai chat page.
async function museChatDriveUi(job) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 20 &&
      r.height > 10 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none' &&
      Number(s.opacity || '1') > 0.05
    );
  };
  const labelOf = el =>
    [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      el.innerText,
      el.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  try {
    const promptText = String(job.prompt || '');
    if (!promptText) return { ok: false, detail: 'Job không có prompt.' };

    // 1. Composer: the big text input near the bottom of the chat.
    const cands = [
      ...document.querySelectorAll(
        'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]',
      ),
    ].filter(visible);
    let input = null;
    let best = -Infinity;
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      const label = labelOf(el);
      let score = 0;
      if (r.top > window.innerHeight * 0.55) score += 40; // composer lives near the bottom
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) score += 20;
      if (r.width > 200 && r.height >= 30 && r.height < 300) score += 10;
      if (/search|tìm|tim/i.test(label)) score -= 80;
      if (score > best) {
        best = score;
        input = el;
      }
    }
    if (!input || best < 10)
      return { ok: false, detail: 'Không tìm thấy ô chat trên muse.ai (đã đăng nhập chưa?).' };

    // 2. Attach the reference image first (so it rides along with the prompt).
    if (Array.isArray(job.images) && job.images.length) {
      try {
        const files = [];
        for (const ref of job.images.slice(0, 4)) {
          if (!ref.base64) continue;
          const bstr = atob(ref.base64);
          const u8 = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
          files.push(
            new File([u8], ref.filename || 'ref.jpg', { type: ref.mime || 'image/jpeg' }),
          );
        }
        if (files.length) {
          const attachBtn = [...document.querySelectorAll('button, [role="button"]')]
            .filter(visible)
            .find(el => /attach|đính kèm|dinh kem|upload|\+/.test(labelOf(el)));
          if (attachBtn) {
            attachBtn.click();
            await sleep(800);
          }
          const dt = new DataTransfer();
          for (const f of files) dt.items.add(f);
          const fileInput = [...document.querySelectorAll('input[type="file"]')].find(visible);
          if (fileInput) {
            try {
              fileInput.multiple = true;
            } catch (_) {}
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            await sleep(1500);
          } else {
            const dropTarget = input.closest('form') || input.parentElement || document.body;
            for (const type of ['dragenter', 'dragover', 'drop']) {
              dropTarget.dispatchEvent(
                new DragEvent(type, {
                  dataTransfer: dt,
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                }),
              );
              await sleep(300);
            }
            await sleep(1200);
          }
        }
      } catch (_) {}
    }

    // 3. Type the prompt.
    input.focus();
    if (input.isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, promptText);
    } else {
      const proto =
        input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, promptText);
      else input.value = promptText;
    }
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }),
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(600);

    // 4. Send: the send button near the composer, else Enter.
    const inputRect = input.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
      el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    );
    let sendBtn = null;
    best = -Infinity;
    for (const el of buttons) {
      const r = el.getBoundingClientRect();
      const label = labelOf(el);
      let score = 0;
      if (/gửi|gui|send/.test(label)) score += 80;
      if (el.querySelector('svg')) score += 10; // send buttons are usually icon-only
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (
        cx >= inputRect.left - 20 &&
        cx <= inputRect.right + 120 &&
        cy >= inputRect.top - 80 &&
        cy <= inputRect.bottom + 40
      )
        score += 30;
      if (/stop|dừng|dung|cancel|hủy|huy/.test(label)) score -= 100;
      if (score > best) {
        best = score;
        sendBtn = el;
      }
    }
    if (sendBtn && best >= 40) {
      sendBtn.click();
    } else {
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }),
      );
    }
    await sleep(2000);
    return { ok: true, detail: 'prompt đã gửi' };
  } catch (err) {
    return { ok: false, detail: String((err && err.message) || err) };
  }
}

// Download the video inside the page (reuses the logged-in session), return base64.
async function museChatDownload(videoUrl) {
  try {
    for (let i = 0; i < 6; i++) {
      try {
        const r = await fetch(videoUrl, { credentials: 'include' });
        if (r.ok) {
          const buf = new Uint8Array(await r.arrayBuffer());
          if (buf.length < 10000) {
            await new Promise(rr => setTimeout(rr, 4000));
            continue; // URL exists but the file is not ready yet
          }
          let bin = '';
          const chunk = 0x8000;
          for (let k = 0; k < buf.length; k += chunk)
            bin += String.fromCharCode.apply(null, buf.subarray(k, k + chunk));
          const mime = videoUrl.includes('.webm') ? 'video/webm' : 'video/mp4';
          return { base64: btoa(bin), mime, size: buf.length };
        }
      } catch (_) {}
      await new Promise(rr => setTimeout(rr, 4000));
    }
    return { detail: 'Không tải được video (URL chưa sẵn sàng sau nhiều lần thử).' };
  } catch (err) {
    return { detail: String((err && err.message) || err) };
  }
}

// --- MAIN-world functions injected into the Google Vids tab (must be self-contained) ---
// Drives the Vids creation UI: open the Video-AI panel, attach reference images, type the prompt,
// pick 1080p, click Generate. Ported from the user's Google Vids tool; returns {ok, detail}. It
// does NOT wait for the video — the capture hook + the worker poll do that.
async function gvidsDriveUi(job) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 20 &&
      rect.height > 10 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity || '1') > 0.05
    );
  };
  const labelOf = el =>
    [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      el.innerText,
      el.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  const findPromptInput = () => {
    const sidebar = document.querySelector(
      '[class*="SidebarContent"], [class*="CreationView"], [class*="Videogensidebar"]',
    );
    const root = sidebar || document;
    const candidates = [
      ...root.querySelectorAll(
        "textarea, input[type='text'], [contenteditable='true'], [role='textbox']",
      ),
    ].filter(visible);
    let best = null;
    let bestScore = -Infinity;
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const label = labelOf(el);
      let score = 0;
      if (/mô tả|mo ta|describe|prompt|câu lệnh|cau lenh|nhập|nhap/.test(label)) score += 80;
      if (el.tagName === 'TEXTAREA') score += 30;
      if (el.isContentEditable || el.getAttribute('role') === 'textbox') score += 15;
      if (sidebar && sidebar.contains(el)) score += 50;
      if (rect.left > window.innerWidth * 0.5) score += 25;
      if (rect.height > 25 && rect.height < 300) score += 10;
      if (/tìm|search|trình đơn|menu/.test(label)) score -= 80;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  };
  const openVideoAiPanel = async () => {
    const iconBtn = document.querySelector(
      '[class*="VideoGenerationIconButton"], [class*="VideoGenerationIcon"]',
    );
    if (iconBtn && visible(iconBtn)) {
      iconBtn.click();
      await sleep(1200);
      return true;
    }
    const controls = [...document.querySelectorAll("button, [role='button'], a")].filter(visible);
    const target = controls.find(el =>
      /video ai|đoạn video|do ai tạo|ai tạo|tạo bằng ai|tạo video/.test(labelOf(el)),
    );
    if (target) {
      target.click();
      await sleep(1200);
      return true;
    }
    return false;
  };
  const setPromptValue = (el, value) => {
    el.focus();
    if (el.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, value);
    } else {
      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const findGenerateButton = promptEl => {
    const direct = document.querySelector(
      'button.collapsiblePromptBoxGenerateButton, button[aria-label="Tạo"]:not([role="tab"]), [role="button"][aria-label="Tạo"]:not([role="tab"])',
    );
    if (
      direct &&
      visible(direct) &&
      !direct.disabled &&
      direct.getAttribute('aria-disabled') !== 'true'
    )
      return direct;
    const promptRect = promptEl.getBoundingClientRect();
    const buttons = [...document.querySelectorAll("button, [role='button']")].filter(
      el =>
        visible(el) &&
        !el.disabled &&
        el.getAttribute('aria-disabled') !== 'true' &&
        el.getAttribute('role') !== 'tab',
    );
    let best = null;
    let bestScore = -Infinity;
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      const label = labelOf(btn);
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      let score = 0;
      if (btn.classList.contains('collapsiblePromptBoxGenerateButton')) score += 150;
      if (/(^|\s)(tạo|tao|generate|create|send|submit)(\s|$)/.test(label)) score += 70;
      if (
        /huỷ|hủy|cancel|chia sẻ|share|phát|play|chỉnh sửa|edit|hình đại diện|thành phần|asset|avatar|thư viện/.test(
          label,
        )
      )
        score -= 100;
      if (centerX >= promptRect.left && centerX <= promptRect.right + 40) score += 20;
      if (centerY >= promptRect.top - 30 && centerY <= promptRect.bottom + 80) score += 35;
      if (rect.left > promptRect.right - 130) score += 25;
      if (rect.left > window.innerWidth * 0.65) score += 15;
      if (rect.width <= 70 && rect.height <= 70) score += 15;
      if (btn.querySelector('svg')) score += 8;
      if (score > bestScore) {
        best = btn;
        bestScore = score;
      }
    }
    return bestScore > 10 ? best : null;
  };
  const attachImages = async (imageRefs, promptEl) => {
    if (!Array.isArray(imageRefs) || !imageRefs.length) return { ok: false, detail: 'no images' };
    const diag = [];
    try {
      const files = [];
      for (const ref of imageRefs.slice(0, 10)) {
        if (!ref.base64) continue;
        const bstr = atob(ref.base64);
        const u8 = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
        files.push(
          new File([u8], ref.filename || 'character.jpg', {
            type: ref.mime || 'image/jpeg',
            lastModified: Date.now(),
          }),
        );
      }
      if (!files.length) return { ok: false, detail: 'no valid files' };
      const container = promptEl
        ? promptEl.closest(
            '[class*="CreationView"], [class*="DragDropContainer"], [class*="sidebar"], [role="region"]',
          ) ||
          promptEl.parentElement?.parentElement ||
          document.body
        : document.body;
      const fileInputs = Array.from(document.querySelectorAll("input[type='file']"));
      const scored = fileInputs
        .map(inp => {
          const accept = String(inp.getAttribute('accept') || '').toLowerCase();
          let s = 0;
          if (container.contains(inp)) s += 100;
          if (/image|png|jpe?g|webp/.test(accept)) s += 60;
          if (!inp.disabled) s += 10;
          return { inp, s };
        })
        .sort((a, b) => b.s - a.s);
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      const preferred = scored[0]?.inp;
      if (preferred) {
        try {
          preferred.multiple = true;
        } catch (_) {}
        preferred.files = dt.files;
        preferred.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        preferred.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        diag.push('file-input x' + files.length);
      } else {
        container.dispatchEvent(
          new DragEvent('dragenter', {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
        container.dispatchEvent(
          new DragEvent('dragover', {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
        container.dispatchEvent(
          new DragEvent('drop', {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
        diag.push('drag-drop x' + files.length);
      }
      await sleep(1000);
      for (let c = 0; c < 3; c++) {
        const agree = Array.from(document.querySelectorAll("button, [role='button']"))
          .filter(visible)
          .find(b => /tôi đồng ý|toi dong y|i agree|agree|đồng ý|chấp nhận/i.test(labelOf(b)));
        if (agree) {
          agree.click();
          diag.push('consent');
          await sleep(1000);
          break;
        }
        await sleep(500);
      }
      await sleep(1500);
      return { ok: true, detail: diag.join(',') };
    } catch (err) {
      return { ok: false, detail: String(err && err.message) };
    }
  };
  const ensure1080p = async () => {
    try {
      const uiLabel = el =>
        `${el?.getAttribute?.('aria-label') || ''} ${el?.getAttribute?.('title') || ''} ${
          el?.getAttribute?.('data-value') || ''
        } ${el?.innerText || el?.textContent || ''}`
          .replace(/\s+/g, ' ')
          .trim();
      const is1080 = t =>
        /(?:^|\b)1080\s*p(?:\b|$)|full\s*hd|fhd|1920\s*[x×]\s*1080/i.test(t || '');
      const is720 = t => /(?:^|\b)720\s*p(?:\b|$)|1280\s*[x×]\s*720/i.test(t || '');
      const isSel = el =>
        el?.getAttribute?.('aria-checked') === 'true' ||
        el?.getAttribute?.('aria-selected') === 'true' ||
        el?.getAttribute?.('data-selected') === 'true' ||
        el?.classList?.contains('selected') ||
        el?.classList?.contains('checked');
      const controls = () =>
        Array.from(
          document.querySelectorAll(
            'button, [role="button"], [role="menuitemradio"], [role="radio"], [role="option"], [role="menuitem"], [aria-label], [data-value]',
          ),
        ).filter(el => visible(el) && el.getAttribute('aria-disabled') !== 'true' && !el.disabled);
      const clickControl = async el => {
        if (!el) return;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        try {
          el.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }),
          );
        } catch (_) {}
        try {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        } catch (_) {}
        try {
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        } catch (_) {}
        el.click();
        await sleep(500);
      };
      const settingsButton = () =>
        controls().find(el =>
          /generation settings|video generation settings|cài đặt tạo video|thiết lập tạo video/i.test(
            uiLabel(el),
          ),
        ) || controls().find(el => is720(uiLabel(el)) || is1080(uiLabel(el)));
      if (controls().some(el => is1080(uiLabel(el)) && isSel(el))) return;
      const initial = settingsButton();
      if (initial && is1080(uiLabel(initial))) return;
      if (initial) await clickControl(initial);
      const cur720 = controls().find(
        el => is720(uiLabel(el)) && el.matches('button, [role="button"]'),
      );
      if (cur720) await clickControl(cur720);
      const option = controls()
        .filter(el => is1080(uiLabel(el)) && !is720(uiLabel(el)))
        .sort((a, b) => {
          const score = el =>
            (el.matches(
              '[role="menuitemradio"], [role="radio"], [role="option"], [role="menuitem"]',
            )
              ? 100
              : 0) +
            (isSel(el) ? 60 : 0) +
            (/^\s*1080\s*p(?:\s*hd)?\s*$/i.test(uiLabel(el)) ? 40 : 0);
          return score(b) - score(a);
        })[0];
      if (option && !isSel(option)) await clickControl(option);
    } catch (_) {}
  };

  try {
    let promptText = String(job.prompt || '');
    if (!promptText) return { ok: false, detail: 'Job không có prompt.' };
    let input = findPromptInput();
    if (!input) {
      await openVideoAiPanel();
      input = findPromptInput();
    }
    if (!input)
      return {
        ok: false,
        detail:
          'Không tìm thấy ô nhập prompt — hãy mở một video và bảng tạo video trong Google Vids.',
      };
    let attachDetail = '';
    if (Array.isArray(job.images) && job.images.length) {
      const a = await attachImages(job.images, input);
      attachDetail = a && a.detail ? a.detail : '';
      input = findPromptInput() || input;
    }
    // Normalise a shot's "8-second" phrasing to Google Vids' ~10s clips.
    promptText = promptText
      .replace(
        /\b(?:an?\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine)\s*-\s*seconds?\b/gi,
        'a 10-second',
      )
      .replace(
        /\b(?:an?\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine)\s+seconds?\b/gi,
        '10 seconds',
      )
      .replace(/\ba\s+a\s+10-second\b/gi, 'a 10-second');
    setPromptValue(input, promptText);
    await ensure1080p();
    const button = findGenerateButton(input);
    if (!button) return { ok: false, detail: 'Không tìm thấy nút Tạo. (' + attachDetail + ')' };
    button.click();
    // promptText is exactly what Google Vids will carry in its generate payload, so the worker can
    // tag the learned replay sample with it and swap it out exactly on a later replay.
    return { ok: true, detail: 'attached=' + attachDetail, promptSet: promptText };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

// Downloads the signed 1080p MP4 with the page's Google session, verifies it is a real video, and
// returns it as base64. A freshly captured preview URL can 404 for a moment while Vids finalises
// the render, so it retries. Self-contained (runs in the page's MAIN world).
async function gvidsDownload(previewUrl) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const toB64 = buf => {
    const b = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < b.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const r = await fetch(previewUrl, { credentials: 'include' });
      if (r.ok) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength >= 200000) {
          const bytes = new Uint8Array(buf);
          const head = new TextDecoder('latin1').decode(bytes.slice(0, 64)).toLowerCase();
          if (head.includes('ftyp') || (bytes[0] === 0x1a && bytes[1] === 0x45)) {
            const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
            return {
              base64: toB64(buf),
              mime: ct && ct.startsWith('video/') ? ct : 'video/mp4',
              size: buf.byteLength,
            };
          }
        }
      }
    } catch (_) {}
    await sleep(2000);
  }
  return { detail: 'Không tải được video 1080p (URL chưa sẵn sàng sau nhiều lần thử).' };
}

// Replays a captured Google Vids generate request with a new prompt — the fast path that skips UI
// automation. Self-contained (runs in the page's MAIN world, with the page's live Google session).
// It locates the prompt inside the captured protobuf payload (by the exact prompt the warm-up typed
// if known, else the single longest free-text string), swaps in the new prompt, and re-fires the
// request. A signed preview URL in the synchronous response is written straight to
// window.__dramaGvidsCaptured; otherwise the capture hook picks up the later async preview. A
// content refusal goes to window.__dramaGvidsError. Returns {ok, previewUrl, refused, detail}.
async function gvidsReplay(sample, newPrompt, queueId) {
  const findPreviewUrl = value => {
    if (!value) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value || {});
    let m = text.match(/https:\/\/contribution-rt\.usercontent\.google\.com\/download\?[^"'\s\\]+/);
    if (m) return m[0].replace(/\\u0026/g, '&');
    m = text.match(
      /https:\/\/[a-zA-Z0-9_.-]*googleusercontent\.com\/[^\s"'\\]*(?:download|\.mp4)[^\s"'\\]*/,
    );
    if (m) return m[0].replace(/\\u0026/g, '&');
    m = text.match(/https:\/\/[^\s"'\\]+\.(?:mp4|webm)[^\s"'\\]*/);
    if (m) return m[0].replace(/\\u0026/g, '&');
    return '';
  };
  try {
    if (!sample || !Array.isArray(sample.bodyJson) || !sample.url)
      return { ok: false, detail: 'no-sample' };
    const payload = JSON.parse(JSON.stringify(sample.bodyJson));
    const old = sample.promptText ? String(sample.promptText) : '';

    // 1) Exact swap: replace every string node equal to the prompt the warm-up typed.
    let replaced = 0;
    const swapExact = node => {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (typeof node[i] === 'string') {
            if (old && node[i] === old) {
              node[i] = newPrompt;
              replaced++;
            }
          } else if (node[i] && typeof node[i] === 'object') swapExact(node[i]);
        }
      } else if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) {
          if (typeof node[k] === 'string') {
            if (old && node[k] === old) {
              node[k] = newPrompt;
              replaced++;
            }
          } else if (node[k] && typeof node[k] === 'object') swapExact(node[k]);
        }
      }
    };
    swapExact(payload);

    // 2) Fallback: swap the single longest free-text string (that is the prompt for text-to-video).
    if (!replaced) {
      const looksText = s =>
        typeof s === 'string' &&
        s.length >= 10 &&
        /\s/.test(s) &&
        !/^https?:\/\//i.test(s) &&
        !/^[A-Za-z0-9_\-=]{40,}$/.test(s);
      let best = null;
      let bestLen = 0;
      const scan = node => {
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i++) {
            const v = node[i];
            if (looksText(v)) {
              if (v.length > bestLen) {
                best = { p: node, k: i };
                bestLen = v.length;
              }
            } else if (v && typeof v === 'object') scan(v);
          }
        } else if (node && typeof node === 'object') {
          for (const k of Object.keys(node)) {
            const v = node[k];
            if (looksText(v)) {
              if (v.length > bestLen) {
                best = { p: node, k };
                bestLen = v.length;
              }
            } else if (v && typeof v === 'object') scan(v);
          }
        }
      };
      scan(payload);
      if (best) {
        best.p[best.k] = newPrompt;
        replaced++;
      }
    }
    if (!replaced) return { ok: false, detail: 'prompt-not-located' };

    // Resend with the page's live session; drop headers the fetch layer forbids.
    const blocked = n => {
      const l = String(n || '').toLowerCase();
      return (
        l === 'cookie' ||
        l === 'host' ||
        l === 'origin' ||
        l === 'referer' ||
        l === 'content-length' ||
        l === 'accept-encoding' ||
        l === 'connection' ||
        l.startsWith('sec-')
      );
    };
    const headers = {};
    for (const [n, v] of Object.entries(sample.headers || {}))
      if (!blocked(n) && v != null) headers[n] = String(v);
    if (!Object.keys(headers).some(n => n.toLowerCase() === 'content-type'))
      headers['Content-Type'] = 'application/json+protobuf';

    // Guard only our own request from being re-learned as a sample; cleared the instant the fetch
    // settles so a later real generate (e.g. the UI fallback after a stale-token replay) is learned.
    window.__dramaGvidsSuppressSampleUntil = Date.now() + 15000;
    let resp;
    try {
      resp = await window.fetch(sample.url, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(payload),
      });
    } finally {
      window.__dramaGvidsSuppressSampleUntil = 0;
    }
    const raw = await resp.text().catch(() => '');
    if (/REQUEST_REFUSED|violat(?:e|ion)|policy|safety/i.test(raw)) {
      if (queueId)
        window.__dramaGvidsError = {
          queueId,
          detail: 'Google Vids từ chối yêu cầu (REQUEST_REFUSED / chính sách nội dung).',
        };
      return { ok: false, started: true, refused: true, detail: 'refused' };
    }
    // A non-2xx means the generate was NOT started (bad/expired token, transient error) — safe to
    // fall back to the UI. resp.ok means the server ACCEPTED it and a render may now be running and
    // billed, so the caller must commit and never fire a second generate.
    if (!resp.ok)
      return {
        ok: false,
        started: false,
        detail: 'HTTP ' + resp.status + ': ' + raw.slice(0, 180),
      };
    // This generate endpoint long-polls and returns the signed preview URL in its own response.
    const previewUrl = findPreviewUrl(raw);
    if (!previewUrl) return { ok: false, started: true, detail: 'no-preview-in-response' };
    if (queueId) window.__dramaGvidsCaptured = { queueId, previewUrl };
    return { ok: true, started: true, previewUrl, detail: 'preview-in-response' };
  } catch (err) {
    return { ok: false, detail: String((err && err.message) || err) };
  }
}

// ---- dispatch -------------------------------------------------------------
function startJob(job) {
  const site = job.payload && job.payload.site;
  const isVids = job.kind === 'video' && site === 'googlevids';
  const isMuseChat = job.kind === 'video' && site === 'musechat';
  if (isMuseChat) startMuseChatJob(job);
  else if (isVids) startVidsJob(job);
  else startChatgptJob(job);
}

// ---- poll loop ------------------------------------------------------------
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
  if (!anyRunning() || polling) return;
  polling = true;
  try {
    const list = await bases();
    // Fill every free slot of every enabled worker, narrowing the claimed kinds to what actually
    // has capacity so an idle video worker never starves busy image slots (and vice-versa).
    while (anyRunning()) {
      const kinds = [];
      const sites = []; // which video sites this extension may take right now
      // 'recover' = collect a late image from its saved ChatGPT conversation (no new prompt).
      if (cfg.runChatgpt && activeOf('chatgpt') < concFor('chatgpt'))
        kinds.push('image', 'text', 'recover');
      // The Vids worker creates its own fresh document per job, so it can claim video jobs without a
      // doc tab already being open. Serial: only claim its site while it has a free slot.
      if (cfg.runVids && activeOf('vids') < concFor('vids')) sites.push('googlevids');
      // Muse Chat: unlimited tabs, one tab per command — always room for its own site.
      if (cfg.runMuseChat) sites.push('musechat');
      if (sites.length) kinds.push('video');
      if (!kinds.length) break;

      let job = null,
        errors = 0,
        last = '';
      for (let i = 0; i < list.length && !job; i++) {
        try {
          job = await claim(list[(ring + i) % list.length], kinds, sites);
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
    if (!active.size) {
      const on = [
        cfg.runChatgpt && 'ChatGPT',
        cfg.runVids && 'Google Vids',
        cfg.runMuseChat && 'Muse Chat',
      ]
        .filter(Boolean)
        .join(' + ');
      report(`Đang chờ job… (${on || 'tắt'} · ${(await bases()).length} cửa sổ)`);
    }
  } finally {
    polling = false;
  }
  scheduleSoon();
}
function scheduleSoon(ms = 5000) {
  clearTimeout(pollTimer);
  if (anyRunning()) pollTimer = setTimeout(poll, ms);
}

async function applyRunning() {
  await loadCfg();
  if (anyRunning()) {
    chrome.alarms.create('poll', { periodInMinutes: 0.5 }); // 30s wake-up if the worker was killed
    await loadPool();
    poll();
  } else {
    // Jobs already running still finish (keepAlive holds the worker); the alarm is dropped once
    // they are done (see onAlarm).
    if (!active.size) chrome.alarms.clear('poll');
    clearTimeout(pollTimer);
    report('Đã tắt cả hai worker');
  }
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== 'poll') return;
  loadCfg().then(() => {
    if (anyRunning()) poll();
    else if (!active.size) chrome.alarms.clear('poll');
  });
});
chrome.runtime.onStartup.addListener(() => loadCfg().then(() => anyRunning() && applyRunning()));
chrome.runtime.onInstalled.addListener(() => loadCfg().then(() => anyRunning() && applyRunning()));

// ---- popup messages -------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await loadCfg();
    if (msg.type === 'getStatus') {
      const s = await chrome.storage.local.get([
        'status',
        'statusAt',
        'statusError',
        'activeChatgpt',
        'activeVids',
        'activeMuseChat',
      ]);
      sendResponse({ cfg, active: active.size, ...s });
    } else if (msg.type === 'setConfig') {
      await chrome.storage.local.set(msg.cfg || {});
      await loadCfg();
      sendResponse({ ok: true, cfg });
    } else if (msg.type === 'setWorker') {
      // { worker:'chatgpt'|'vids'|'musechat', on:boolean } — toggle one worker without touching the others.
      const key =
        msg.worker === 'vids'
          ? 'runVids'
          : msg.worker === 'musechat'
            ? 'runMuseChat'
            : 'runChatgpt';
      await chrome.storage.local.set({ [key]: !!msg.on });
      await applyRunning();
      sendResponse({ ok: true, cfg });
    } else if (msg.type === 'testConnection') {
      sendResponse(await testConnection());
    } else if (msg.type === 'openVids') {
      try {
        const tabs = await chrome.tabs.query({ url: ['https://docs.google.com/videos/*'] });
        if (tabs && tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
        else await chrome.tabs.create({ url: 'https://docs.google.com/videos' });
      } catch {}
      sendResponse({ ok: true });
    } else sendResponse({ ok: false, error: 'unknown message' });
  })();
  return true; // async sendResponse
});

loadCfg().then(() => anyRunning() && applyRunning());
