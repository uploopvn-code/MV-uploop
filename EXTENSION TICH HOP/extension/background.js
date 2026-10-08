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

// Verified 2026-10-08: the worker opens this home page, then clicks the "+"
// new-chat button in the sidebar — navigating to a "new thread" URL directly does not
// open a fresh thread, the click is required.
const MUSECHAT_HOME_URL = 'https://muse.ai/';

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
    name: (job.nodeId || 'video') + (out.mime === 'video/webm' ? '.webm' : '.mp4'),
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
async function downloadRef(base, asset, timeoutMs = 60000) {
  const url = asset.url.startsWith('http') ? asset.url : base + asset.url;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('Không tải được ảnh tham chiếu ' + asset.url);
    const buf = new Uint8Array(await r.arrayBuffer());
    const mime = r.headers.get('content-type') || asset.mime || 'image/png';
    return {
      dataUrl: 'data:' + mime + ';base64,' + bytesToBase64(buf),
      mime,
      name: asset.name || asset.id || 'ref.png',
    };
  } catch (e) {
    if (e && e.name === 'AbortError')
      throw new Error('Tải ảnh tham chiếu quá lâu (>' + Math.round(timeoutMs / 1000) + 's): ' + asset.url);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
    const ok = await execMain(tabId, () => !!window.__dramaMuseChatHookInstalled && !!window.__dramaMuseChatUi).catch(
      () => false,
    );
    if (ok) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['content-musechat-ui.js', 'content-musechat-hook.js'],
      });
    } catch {}
    await sleep(600);
  }
  throw new Error('Không khởi tạo được bộ điều khiển Muse. Hãy tải lại extension và kiểm tra đăng nhập.');
}

async function startMuseChatJob(job) {
  const st = trackJob(job, 'musechat'); // reserve a slot synchronously so poll() counts it
  const hb = setInterval(() => heartbeat(job, st).catch(() => {}), 10000);
  let tabId = null;
  let completed = false;
  const queueId = job.id;
  try {
    // GUARANTEE: every video job gets its OWN brand-new tab. Tabs are never reused between
    // jobs and the user's current tab is never touched — every automation call below targets
    // ONLY the tabId created here.
    const [userTab] = await chrome.tabs
      .query({ active: true, currentWindow: true })
      .catch(() => []);
    const userTabId = userTab && userTab.id;
    report('Muse chat: mở tab mới riêng cho job ' + queueId.slice(0, 8) + '…');
    const tab = await chrome.tabs.create({ url: MUSECHAT_HOME_URL, active: false });
    tabId = tab.id;
    st.tabId = tabId;
    console.log(
      '[Drama Tool · Muse Chat] job ' +
        queueId.slice(0, 8) +
        ' → TAB MỚI #' +
        tabId +
        ' (tab bạn đang dùng #' +
        userTabId +
        ' không bị đụng tới)',
    );
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
        window.__dramaMuseChatActiveJob = { queueId: qid, sentAt: 0 };
      },
      [queueId],
    );

    // Ensure we're in a brand-new chat BEFORE pushing image + prompt.
    // If not, force-click the "+" (aria-label="New side chat") button, then verify.
    // NOTE: the tab "complete" event fires before the muse.ai SPA boots — without waiting,
    // the check below would see an empty unrendered page and wrongly skip the "+" click.
    report('Muse chat: chờ trang load xong…');
    const ready = await execMain(tabId, museChatWaitReady).catch(() => null);
    if (!ready || !ready.ok) {
      await clearMuseChatActive(tabId);
      throw new Error(
        'Muse chat (chờ trang): ' + ((ready && ready.detail) || 'trang không load xong.'),
      );
    }
    report('Muse chat: kiểm tra thread mới…');
    let isNew = false; // Always explicitly create a fresh conversation for this job.
    if (!isNew) {
      report('Muse chat: mở thread mới (bấm nút +)…');
      const nth = await execMain(tabId, museChatClickNewChat).catch(() => null);
      if (!nth || !nth.ok) {
        await clearMuseChatActive(tabId);
        throw new Error(
          'Muse chat (mở thread mới): ' + ((nth && nth.detail) || 'không bấm được nút + tạo chat mới.'),
        );
      }
      // The click may navigate (SPA) — reinstall the hook, then re-check until the
      // new empty chat appears.
      await ensureMuseChatHook(tabId);
      const t0 = Date.now();
      isNew = false;
      while (Date.now() - t0 < 20000) {
        await sleep(1500);
        isNew = await execMain(tabId, museChatIsNewChat).catch(() => false);
        if (isNew) break;
      }
      if (!isNew) {
        await clearMuseChatActive(tabId);
        throw new Error(
          'Muse chat (mở thread mới): đã bấm nút + nhưng vẫn không thấy thread mới (vẫn còn tin nhắn cũ).',
        );
      }
      report('Muse chat: đã ở thread mới.');
    }

    const refs = job.payload.references || [];
    if (refs.length) report('Muse chat: tải ' + refs.length + ' ảnh tham chiếu…');
    const images = [];
    for (const ref of refs) {
      try {
        const r = await downloadRef(job.__base, ref.asset);
        images.push({ base64: r.dataUrl.split(',')[1], mime: r.mime, filename: r.name });
      } catch (e) {
        throw new Error('Muse chat (ảnh tham chiếu): ' + e.message);
      }
    }

    report('Muse chat: gửi prompt' + (images.length ? ' + ảnh tham chiếu' : '') + '…');
    await execMain(tabId, qid => {
      window.__dramaMuseChatActiveJob = { queueId: qid, sentAt: 0 };
      window.__dramaMuseChatCaptured = null;
      window.__dramaMuseChatError = null;
    }, [queueId]);
    const driveArgs = [{ queueId, prompt: String(job.payload.prompt || ''), images }];
    // Do not replay an ambiguous send: it can create a second paid generation.
    let lastStage = '';
    const stageTimer = setInterval(() => {
      execMain(tabId, () => window.__dramaMuseChatStage || '').then(stage => {
        if (stage && stage !== lastStage) { lastStage = stage; st.progress = stage; report('Muse chat: ' + stage + '…'); }
      }).catch(() => {});
    }, 2000);
    let drive;
    try { drive = await execMain(tabId, museChatDriveUi, driveArgs); }
    catch (error) {
      // Full navigation can destroy the executeScript promise after a successful send.
      // The hook stores the send marker in this tab's sessionStorage before submission.
      await ensureMuseChatHook(tabId);
      for (let i = 0; i < 15; i++) {
        drive = await execMain(tabId, qid => {
          window.__dramaMuseChatPoll?.();
          const active = window.__dramaMuseChatActiveJob;
          return active?.queueId === qid && active.sentAt
            ? { ok: true, attempted: true, confirmed: !!active.confirmed, pending: !active.confirmed,
                sentAt: active.sentAt, conversationUrl: location.href, watchState: window.__dramaMuseChatSnapshot() } : null;
        }, [queueId]).catch(() => null);
        if (drive) break;
        await sleep(1000);
      }
      if (!drive) throw new Error('Trang chuyển hướng khi gửi; chưa xác nhận kết quả. ' + error.message);
    }
    finally { clearInterval(stageTimer); }
    if (!drive || !drive.ok) {
      await clearMuseChatActive(tabId);
      throw new Error(
        'Muse chat (gửi prompt): ' +
          ((drive && drive.detail) || 'không điều khiển được giao diện chat.'),
      );
    }
    st.sent = true;
    st.conversationUrl = drive.conversationUrl || (await chrome.tabs.get(tabId)).url;
    const sentAt = drive.sentAt || Date.now();
    // Carry the pre-send video baseline through a navigation/reinstalled hook.
    // Never turn an attempted send into a confirmed send just to resume polling.
    const watchState = drive.watchState || await execMain(tabId, () => window.__dramaMuseChatSnapshot?.()).catch(() => null);
    st.progress = drive.pending ? 'đã bấm gửi; tiếp tục chờ video từ Muse' : 'đã gửi, đang chờ video';
    report('Muse chat: ' + st.progress);
    await execMain(tabId, message => window.__dramaMuseChatUi?.status(message), [st.progress]).catch(() => {});
    const TIMEOUT = 10 * 60 * 1000;
    const t0 = sentAt;
    let beat = 0, downloadError = '';
    const downloadAttempts = new Map();
    for (;;) {
      if (Date.now() - t0 > TIMEOUT) throw new Error(downloadError || 'Chưa thấy video sau 10 phút kể từ khi bấm gửi. Giữ tab để kiểm tra, không tự gửi lại prompt.');
      let s = null;
      try {
        s = await execMain(
          tabId,
          (qid, state) => {
            // SPA navigation wipes page-world state — re-arm this job's marker if it's gone,
            // preserving the original send timestamp whenever we still have it.
            if (!window.__dramaMuseChatHookInstalled) return { hookMissing: true };
            const j = window.__dramaMuseChatActiveJob;
            if ((!j || j.queueId !== qid) && state) window.__dramaMuseChatRestore?.(state);
            window.__dramaMuseChatPoll?.();
            const c = window.__dramaMuseChatCaptured;
            const e = window.__dramaMuseChatError;
            return {
              // Only accept the capture whose queueId matches THIS job — the correct video id.
              captured: c && c.queueId === qid ? c.videoUrl : '',
              score: c?.score || 0,
              error: e && e.queueId === qid ? e.detail : '',
              diagnostics: window.__dramaMuseChatDiagnostics?.() || null,
            };
          },
          [queueId, watchState],
        );
      } catch (e) {
        // Most likely the tab is mid-navigation (chat apps often navigate right after send).
        // Only treat it as fatal if the tab is actually gone.
        const alive = await chrome.tabs.get(tabId).catch(() => null);
        if (!alive) throw new Error('Muse chat (chờ video): tab đã bị đóng.');
        await sleep(2000);
        continue;
      }
      if (s && s.hookMissing) {
        // Hook was wiped by a navigation before the content script re-ran — reinstall it.
        await ensureMuseChatHook(tabId);
        await sleep(1000);
        continue;
      }
      if (s && s.error) {
        await clearMuseChatActive(tabId);
        throw new Error(s.error);
      }
      if (s?.captured && Date.now() - (downloadAttempts.get(s.captured) || 0) > 12000) {
        downloadAttempts.set(s.captured, Date.now());
        report('Muse chat: tải video…');
        await execMain(tabId, () => window.__dramaMuseChatUi?.status('đang tải video')).catch(() => {});
        const dl = await execMain(tabId, museChatDownload, [s.captured]).catch(error => ({ detail: error.message }));
        if (dl?.base64) {
          st.progress = 'lưu video vào Drama Tool';
          report('Muse chat: lưu video vào Drama Tool…');
          await execMain(tabId, () => window.__dramaMuseChatUi?.status('đang lưu video vào Drama Tool')).catch(() => {});
          await completeVideo(job, { base64: dl.base64, mime: dl.mime });
          completed = true;
          report('✓ xong video ' + queueId.slice(0, 8));
          return;
        }
        downloadError = 'Muse chat (tải video): ' + (dl?.detail || 'Không đọc được file video.');
        // Keep observing the reply for a direct file link; a blob may be a MediaSource.
        report(downloadError + ' — tiếp tục chờ file hoàn chỉnh…');
      }
      if (Date.now() - t0 > TIMEOUT) {
        await clearMuseChatActive(tabId);
        throw new Error('Muse chat (chờ video): quá thời gian chờ (10 phút).');
      }
      if (Date.now() - beat > 15000) {
        beat = Date.now();
        const seconds = Math.round((Date.now() - t0) / 1000);
        st.progress = s?.diagnostics?.freshVideos
          ? 'đã thấy ' + s.diagnostics.freshVideos + ' player video, đang đọc dữ liệu… ' + seconds + 's'
          : 'đang chờ video… ' + seconds + 's';
        report('Muse chat: ' + st.progress);
        await execMain(tabId, progress => window.__dramaMuseChatUi?.status(progress), [st.progress]).catch(() => {});
      }
      await sleep(2000);
    }
  } catch (e) {
    if (tabId !== null) await execMain(tabId, detail => window.__dramaMuseChatUi?.status(detail, true), [e.message]).catch(() => {});
    await fail(job, e.message).catch(() => {});
    report('✗ ' + e.message + (tabId !== null ? ' — giữ tab Muse để kiểm tra.' : ''), true);
  } finally {
    clearInterval(hb);
    active.delete(job.id);
    if (typeof tabId === 'number') {
      await clearMuseChatActive(tabId);
      // Keep a failed job visible for diagnosis; close only after the server saved its video.
      try {
        if (completed) await chrome.tabs.remove(tabId);
        console.log(
          '[Drama Tool · Muse Chat] job ' + queueId.slice(0, 8) + (completed ? ' → đã đóng tab #' : ' → giữ tab lỗi #') + tabId,
        );
      } catch {}
    }
    if (anyRunning()) poll();
  }
}
const clearMuseChatActive = tabId =>
  execMain(tabId, () => {
    if (window.__dramaMuseChatClear) window.__dramaMuseChatClear();
    else window.__dramaMuseChatActiveJob = null;
  }).catch(() => {});

// --- MAIN-world functions injected into the Muse chat tab (must be self-contained) ---
// Wait until the muse.ai SPA has actually rendered. Chrome's tab "complete" event fires
// before the React app boots — checking for messages too early sees an empty page and
// wrongly concludes it's a new chat. We wait for the "+" button (sidebar rendered) as the
// boot signal, then give the conversation content a moment to catch up.
async function museChatWaitReady() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    let plus = null;
    try {
      plus =
        document.querySelector('[aria-label="New side chat"]') ||
        [...document.querySelectorAll('button, [role="button"]')].find(el => {
          try {
            const r = el.getBoundingClientRect();
            return (el.textContent || '').trim() === '+' && r.width >= 16 && r.height >= 16;
          } catch (_) {
            return false;
          }
        }) ||
        null;
    } catch (_) {}
    if (plus || window.__dramaMuseChatUi?.composer()) {
      await sleep(3000); // let the conversation content catch up with the shell
      return { ok: true };
    }
    await sleep(1000);
  }
  return { ok: false, detail: 'Trang muse.ai load quá lâu (không thấy nút + tạo chat).' };
}
// Check whether the main conversation area is a fresh/empty chat (no messages yet).
// Used BEFORE pushing the reference image + prompt: we must never send into an old thread.
// Called after explicitly clicking New side chat; require a ready, empty composer.
async function museChatIsNewChat() {
  const ui = window.__dramaMuseChatUi;
  if (!ui) return false;
  const input = ui.composer();
  if (!input || ui.value(input).trim()) return false;
  // Inspect only the conversation containing the composer. Welcome text and
  // navigation cards are not messages, regardless of their size or position.
  const scope = ui.scope(input);
  return ![...scope.querySelectorAll('[data-message-id], [data-message-author-role], [role="log"] > *, .chat-message, .message-row')]
    .some(el => ui.visible(el) && !el.contains(input));
}
// Click the "+" new-chat button in the sidebar to open a fresh thread.
// (Navigating to a "new thread" URL directly does not work — the click is required.)
async function museChatClickNewChat() {
  const visible = el => {
    if (!el) return false;
    let r, s;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      return false;
    }
    try {
      s = getComputedStyle(el);
    } catch (_) {
      s = null;
    }
    if (r.width < 16 || r.height < 16) return false;
    if (s && (s.visibility === 'hidden' || s.display === 'none')) return false;
    return true;
  };
  const labelOf = el => {
    try {
      return [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.innerText,
        el.textContent,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    } catch (_) {
      return '';
    }
  };
  try {
    // 1. EXACT selector first (verified on the real UI).
    let btn = document.querySelector('button[aria-label="New side chat"]');
    if (!btn) btn = document.querySelector('[aria-label="New side chat"]');
    if (btn && visible(btn)) {
      btn.click();
      return { ok: true, detail: 'đã bấm nút + (New side chat)' };
    }
    // 2. Fallback: heuristic search near the "Side chats" heading.
    let anchorBox = null;
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.trim() === 'Side chats') {
          const heading = node.parentElement;
          anchorBox = (heading && heading.closest('div')) || (heading && heading.parentElement);
          break;
        }
      }
    } catch (_) {}
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    let bestBtn = null,
      bestScore = -Infinity;
    for (const el of buttons) {
      const text = (el.textContent || '').trim();
      const label = labelOf(el);
      let score = 0;
      if (text === '+') score += 60;
      if (/new chat|chat mới|đoạn chat mới|new thread|new side chat|tạo.*chat|create.*chat/i.test(label))
        score += 50;
      if (anchorBox && anchorBox.contains(el)) score += 30;
      const r = el.getBoundingClientRect();
      if (r.width < 60 && r.height < 60) score += 10; // small icon button, not a big CTA
      if (score > bestScore) {
        bestScore = score;
        bestBtn = el;
      }
    }
    if (!bestBtn || bestScore < 40) {
      return { ok: false, detail: 'Không tìm thấy nút + tạo chat mới trong sidebar.' };
    }
    bestBtn.click();
    return { ok: true, detail: 'đã bấm nút + (tìm theo heuristic)' };
  } catch (err) {
    return { ok: false, detail: String((err && err.message) || err) };
  }
}
// Type the prompt, attach the reference image, send — exactly like doing it by hand.
// CALIBRATE the selectors below against the real logged-in muse.ai chat page.
async function museChatDriveUi(job) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ui = window.__dramaMuseChatUi;
  if (!ui) return { ok: false, detail: 'Chưa khởi tạo bộ điều khiển Muse.' };
  const until = async (fn, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = fn(); if (result) return result; await sleep(300); }
    return null;
  };
  let stage = 'chờ ô nhập';
  const setStage = value => { stage = value; ui.status(value); };
  let attempted = false, armedState = null;
  const normalize = value => String(value || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  const fillPrompt = async prompt => {
    setStage('điền prompt');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const editor = ui.composer();
      if (!editor) { await sleep(300); continue; }
      if (normalize(ui.value(editor)) !== normalize(prompt)) {
        editor.focus();
        if (editor.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection.removeAllRanges(); selection.addRange(range);
          // Some editors return false from execCommand despite accepting the edit.
          try { document.execCommand('insertText', false, prompt); } catch (_) {}
          if (normalize(ui.value(editor)) !== normalize(prompt)) {
            const allowed = editor.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: prompt,
            }));
            if (allowed && normalize(ui.value(editor)) !== normalize(prompt)) editor.textContent = prompt;
          }
        } else {
          const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (!setter) throw new Error('Ô nhập không hỗ trợ điền văn bản.');
          setter.call(editor, prompt);
        }
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: prompt }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Confirm against the current node, after the framework has re-rendered.
      await sleep(400);
      const current = ui.composer();
      if (current && normalize(ui.value(current)) === normalize(prompt)) return current;
    }
    throw new Error('Không giữ được prompt trong ô nhập sau khi giao diện cập nhật.');
  };
  try {
    const prompt = String(job.prompt || '').trim();
    if (!prompt) throw new Error('Job không có prompt.');
    let input = await until(() => ui.composer());
    if (!input) throw new Error('Không tìm thấy ô nhập của chat mới.');
    let attachmentReady = null;
    const images = job.images || [];
    if (images.length) {
      setStage('tải ảnh tham chiếu');
      const scope = ui.scope(input);
      const findFile = () => {
        const candidates = [...document.querySelectorAll('input[type="file"]')]
          .filter(el => !el.disabled && (!el.accept || /image|png|jpg|jpeg|webp|\*/i.test(el.accept)));
        return candidates.find(el => scope.contains(el)) || (candidates.length === 1 ? candidates[0] : null);
      };
      let picker = findFile(); // File inputs are normally hidden; do not filter by visibility.
      if (!picker) {
        const attach = [...scope.querySelectorAll('button, [role="button"]')]
          .filter(ui.visible).find(el => !/new.*chat/i.test(ui.label(el)) &&
            (/attach|upload|đính kèm|thêm ảnh/i.test(ui.label(el)) || ui.label(el).trim() === '+'));
        if (attach) attach.click();
        picker = await until(findFile, 5000);
      }
      if (!picker) throw new Error('Không tìm thấy ô tải ảnh trong chat; chưa gửi prompt.');
      if (images.length > 1 && !picker.multiple)
        throw new Error('Ô tải ảnh chỉ nhận một ảnh; job có ' + images.length + ' ảnh.');
      const dt = new DataTransfer();
      for (const ref of images) {
        if (!ref.base64) throw new Error('Ảnh tham chiếu rỗng.');
        const bytes = Uint8Array.from(atob(ref.base64), c => c.charCodeAt(0));
        dt.items.add(new File([bytes], ref.filename || 'reference.png', { type: ref.mime || 'image/png' }));
      }
      const before = ui.attachmentTokens(input);
      let previewSince = 0;
      picker.files = dt.files;
      picker.dispatchEvent(new Event('input', { bubbles: true }));
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      attachmentReady = () => {
        const current = ui.composer();
        if (!current || ui.busy(current)) { previewSince = 0; return false; }
        const region = ui.scope(current);
        const added = [...ui.attachmentTokens(current)].filter(token => !before.has(token));
        const filenames = images.every(ref => ref.filename && (region.innerText || region.textContent || '').includes(ref.filename));
        if (!added.length && !filenames) { previewSince = 0; return false; }
        if (!previewSince) previewSince = Date.now();
        return Date.now() - previewSince >= 900;
      };
    }
    // Fill the prompt independently of preview detection: Muse may render attachments
    // as background thumbnails, while replacing the editor during upload.
    input = await fillPrompt(prompt);
    if (attachmentReady) {
      setStage('chờ ảnh đính kèm sẵn sàng');
      if (!await until(attachmentReady, 60000))
        throw new Error('Prompt đã điền, nhưng chưa xác nhận được ảnh đính kèm; chưa bấm gửi.');
      input = await fillPrompt(prompt);
    }
    setStage('chờ nút gửi');
    const controlStart = Date.now();
    const control = await until(() => {
      input = ui.composer();
      if (!input || normalize(ui.value(input)) !== normalize(prompt) || ui.busy(input)) return null;
      const found = ui.sendControl(input);
      if (found) return found.disabled ? null : found;
      // Keyboard-only editors handle Enter themselves. Never use this while a
      // recognized send control is disabled, and never follow a click with Enter.
      return Date.now() - controlStart >= 5000 ? { enter: true } : null;
    }, 45000);
    if (!control) throw new Error('Nút gửi vẫn bị khóa hoặc ảnh vẫn đang tải sau 45 giây.');
    window.__dramaMuseChatArm(job.queueId, prompt);
    armedState = window.__dramaMuseChatSnapshot();
    attempted = true;
    setStage(control.enter ? 'gửi bằng Enter' : 'bấm gửi prompt');
    if (control.button) control.button.click();
    else {
      input.focus();
      const event = type => new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true,
      });
      if (input.dispatchEvent(event('keydown'))) input.dispatchEvent(event('keypress'));
      input.dispatchEvent(event('keyup'));
    }
    setStage('xác nhận tin nhắn đã gửi');
    const sent = await until(() => {
      const error = window.__dramaMuseChatError;
      if (error?.queueId === job.queueId) throw new Error(error.detail);
      const active = window.__dramaMuseChatActiveJob;
      if (active?.queueId === job.queueId && active.confirmed) return true;
      const current = ui.composer();
      if (current && !normalize(ui.value(current)) && ui.hasMessage(current, prompt)) {
        window.__dramaMuseChatConfirm(); return true;
      }
      return false;
    }, 30000);
    // A missing echo/request match is not a rejected send. Muse may render a
    // shortened prompt or use a transport the hook cannot inspect. Keep watching.
    if (!sent) setStage('đã bấm gửi; đang chờ Muse tạo video, không gửi lại prompt');
    return {
      ok: true, attempted, confirmed: !!sent, pending: !sent,
      sentAt: window.__dramaMuseChatActiveJob.sentAt, conversationUrl: location.href,
      watchState: window.__dramaMuseChatSnapshot(),
    };
  } catch (error) {
    const detail = stage + ': ' + error.message;
    // A UI/rendering error after clicking must not cancel an in-flight generation.
    // Only a definite rejection from this prompt request is terminal here.
    if (attempted && armedState && window.__dramaMuseChatError?.queueId !== job.queueId) {
      ui.status('đã bấm gửi; tiếp tục theo dõi video dù chưa đọc được xác nhận');
      return { ok: true, attempted, pending: true, confirmed: false, sentAt: armedState.sentAt,
        conversationUrl: location.href, watchState: window.__dramaMuseChatSnapshot() || armedState };
    }
    ui.status(detail, true);
    return { ok: false, attempted, detail };
  }
}

// Download the video inside the page (reuses the logged-in session), return base64.
async function museChatDownload(videoUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const encode = bytes => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const identify = bytes => {
    const mp4 = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    return mp4 ? 'video/mp4' : webm ? 'video/webm' : '';
  };
  const recordBlobPlayer = async url => {
    if (typeof window !== 'undefined')
      window.__dramaMuseChatUi?.status('đã thấy video; đang lấy dữ liệu từ trình phát Muse');
    const sameUrl = video => {
      try {
        return video.currentSrc === url.href || video.src === url.href ||
          video.getAttribute('src') === videoUrl;
      } catch (_) { return false; }
    };
    // Exact shape seen on Muse, plus a generic fallback for future class changes.
    const videos = [...document.querySelectorAll(
      'video.h-full.w-full.bg-transparent.object-cover, video[src^="blob:https://muse.ai/"], video',
    )];
    const video = videos.find(sameUrl);
    if (!video) throw new Error('Đã thấy URL blob nhưng không còn tìm thấy thẻ video tương ứng.');
    const deadline = Date.now() + 30000;
    while (
      Date.now() < deadline &&
      (video.readyState < 2 || !Number.isFinite(video.duration) || video.duration <= 0)
    ) await new Promise(resolve => setTimeout(resolve, 250));
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error('Video blob chưa có thời lượng để thu lại.');
    if (duration > 180) throw new Error('Video blob dài hơn giới hạn thu 3 phút.');
    const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(message)), ms);
      Promise.resolve(promise).then(
        value => { clearTimeout(timeout); resolve(value); },
        error => { clearTimeout(timeout); reject(error); },
      );
    });
    const capture = video.captureStream || video.mozCaptureStream;
    if (typeof capture !== 'function' || typeof MediaRecorder === 'undefined')
      throw new Error('Trình duyệt không hỗ trợ thu video blob từ trình phát Muse.');
    const stream = capture.call(video);
    if (!stream?.getVideoTracks?.().length)
      throw new Error('Trình phát Muse chưa cung cấp track video.');
    const mimeCandidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const mimeType = mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 8_000_000,
    });
    const chunks = [];
    const previous = {
      currentTime: video.currentTime,
      loop: video.loop,
      muted: video.muted,
      playbackRate: video.playbackRate,
      paused: video.paused,
    };
    let stopTimer = null;
    try {
      const finished = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => {
          if (event.data?.size) chunks.push(event.data);
        };
        recorder.onerror = event => reject(event.error || new Error('MediaRecorder báo lỗi.'));
        recorder.onstop = resolve;
      });
      video.loop = false;
      video.playbackRate = 1;
      try { video.currentTime = 0; } catch (_) {}
      recorder.start(500);
      await withTimeout(video.play(), 8000, 'Trình phát không bắt đầu trong 8 giây.');
      stopTimer = setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, Math.ceil((duration + 2) * 1000));
      video.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, { once: true });
      await withTimeout(
        finished,
        Math.ceil((duration + 10) * 1000),
        'MediaRecorder không kết thúc đúng hạn.',
      );
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length < 1024) throw new Error('Bản thu từ video blob không có đủ dữ liệu.');
      if (bytes.length > 200 * 1024 * 1024)
        throw new Error('Bản thu video vượt giới hạn truyền 200 MB của worker.');
      const mime = identify(bytes);
      if (!mime) throw new Error('Bản thu từ trình phát không phải WebM/MP4 hợp lệ.');
      return { base64: encode(bytes), mime, size: bytes.length, method: 'player-recording' };
    } finally {
      if (stopTimer) clearTimeout(stopTimer);
      if (recorder.state !== 'inactive') recorder.stop();
      for (const track of stream.getTracks()) track.stop();
      video.loop = previous.loop;
      video.muted = previous.muted;
      video.playbackRate = previous.playbackRate;
      try { video.currentTime = previous.currentTime; } catch (_) {}
      if (!previous.paused) video.play().catch(() => {});
    }
  };
  try {
    const url = new URL(videoUrl, location.href);
    if (!/^(https?:|blob:)$/.test(url.protocol)) throw new Error('URL video không hợp lệ.');
    if (url.protocol === 'blob:' && typeof window !== 'undefined' && window.__dramaMuseChatReadObjectUrl) {
      const tracked = await window.__dramaMuseChatReadObjectUrl(url.href);
      if (tracked?.pending) return { detail: tracked.detail || 'MediaSource chưa nạp xong.' };
      if (tracked?.error) throw new Error(tracked.error);
      if (tracked?.bytes) {
        const bytes = tracked.bytes instanceof Uint8Array
          ? tracked.bytes
          : new Uint8Array(tracked.bytes);
        const mime = identify(bytes);
        if (mime) {
          return {
            base64: encode(bytes), mime, size: bytes.length,
            method: tracked.method || 'tracked-object-url',
          };
        }
        // Separate audio/video SourceBuffers may not form a standalone file.
        // Fall through to player recording in that case.
      }
    }
    try {
      const fetchController = url.protocol === 'blob:' ? new AbortController() : controller;
      const blobTimer = url.protocol === 'blob:'
        ? setTimeout(() => fetchController.abort(), 5000)
        : null;
      let response;
      try {
        response = await fetch(url.href, { credentials: 'include', signal: fetchController.signal });
      } finally {
        if (blobTimer) clearTimeout(blobTimer);
      }
      if (!response.ok) throw new Error('Tải video báo HTTP ' + response.status + '.');
      const type = (response.headers.get('content-type') || '').split(';')[0];
      if (/text\/|json|mpegurl|dash\+xml|image\//i.test(type))
        throw new Error('URL trả về ' + type + ', chưa phải file video.');
      const length = Number(response.headers.get('content-length') || 0);
      if (length > 200 * 1024 * 1024)
        throw new Error('Video vượt giới hạn truyền 200 MB của worker.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 200 * 1024 * 1024)
        throw new Error('Video vượt giới hạn truyền 200 MB của worker.');
      if (bytes.length < 1024) throw new Error('File video chưa đủ dữ liệu.');
      if (length && !response.headers.get('content-encoding') && bytes.length !== length)
        throw new Error('File tải về chưa đủ dung lượng.');
      if (response.status === 206) {
        const range = (response.headers.get('content-range') || '').match(/^bytes 0-(\d+)\/(\d+)$/);
        if (!range || Number(range[1]) + 1 !== Number(range[2]) || bytes.length !== Number(range[2]))
          throw new Error('Máy chủ mới trả về một phần video.');
      }
      const mime = identify(bytes);
      if (!mime) throw new Error('Dữ liệu tải về không phải MP4/WebM.');
      return { base64: encode(bytes), mime, size: bytes.length, method: 'direct-fetch' };
    } catch (error) {
      // A MediaSource blob is not fetchable as a file. Record exactly one pass
      // from the generated <video> element instead.
      if (url.protocol === 'blob:') return await recordBlobPlayer(url);
      throw error;
    }
  } catch (error) {
    return { detail: error.name === 'AbortError' ? 'Tải video quá 45 giây; sẽ thử lại.' : error.message };
  } finally { clearTimeout(timer); }
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
