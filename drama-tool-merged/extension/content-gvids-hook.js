// Drama Tool Google Vids worker — page-world capture hook (runs in MAIN world at document_start
// on docs.google.com). It hooks window.fetch and XMLHttpRequest so it can read the signed 1080p
// MP4 preview URL out of Google Vids' own GenAI responses — a URL that only appears inside a
// response body, so webRequest alone cannot see it.
//
// It is a passthrough until the service worker marks a job active by setting
//   window.__dramaGvidsActiveJob = { queueId }
// (done with chrome.scripting.executeScript, which is the only way to write a MAIN-world global
// from the extension). While a job is active, a captured preview URL is stashed in
//   window.__dramaGvidsCaptured = { queueId, previewUrl }
// and a generate-time failure in
//   window.__dramaGvidsError = { queueId, detail }
// The service worker polls those two globals back the same way. No chrome.* here — MAIN world
// has none; no network calls to the app either (the worker owns all HTTP).
//
// It also remembers the shape of the last real "generate" request (url + headers + protobuf body)
// in
//   window.__dramaGvidsSample = { url, headers, bodyJson, promptText }
// so the worker can REPLAY it with a new prompt — the fast path that skips UI automation. Reading
// the outgoing request here needs no extra permission (we are already in the page), unlike
// chrome.webRequest. The worker sets window.__dramaGvidsSuppressSampleUntil = <ts> around its own
// replay so that request is not re-learned as a sample.

(function () {
  if (window.__dramaGvidsHookInstalled) return;
  window.__dramaGvidsHookInstalled = true;
  window.__dramaGvidsActiveJob = window.__dramaGvidsActiveJob || null;
  window.__dramaGvidsCaptured = window.__dramaGvidsCaptured || null;
  window.__dramaGvidsError = window.__dramaGvidsError || null;
  window.__dramaGvidsSample = window.__dramaGvidsSample || null;

  let lastQueueId = '';
  const seen = new Set();

  function activeJob() {
    const j = window.__dramaGvidsActiveJob;
    if (!j || !j.queueId) return null;
    if (j.queueId !== lastQueueId) {
      // A fresh job: forget the preview URLs seen for the previous one.
      lastQueueId = j.queueId;
      seen.clear();
    }
    return j;
  }

  function findPreviewUrl(value) {
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
  }

  // Only responses that plausibly carry a generation result or its preview are inspected, and
  // only while a job is active, so ordinary Docs traffic is untouched.
  const RELEVANT =
    /appsgenaiserver|googleusercontent|usercontent\.google|batchexecute|generat|operation|preview|video|flix/i;

  function report(url, ok, status, text) {
    const job = activeJob();
    if (!job) return;
    if (!ok && /appsgenaiserver|generat|flix/i.test(url)) {
      const refused = /REQUEST_REFUSED|violat(?:e|ion)|policy|safety/i.test(text || '');
      window.__dramaGvidsError = {
        queueId: job.queueId,
        detail: refused
          ? 'Google Vids từ chối yêu cầu (REQUEST_REFUSED / chính sách nội dung).'
          : 'HTTP ' + status + ': ' + String(text || '').slice(0, 180),
      };
      console.log('[Drama Tool · Google Vids] ⚠️ Lỗi generate:', status, String(text || '').slice(0, 120));
      return;
    }
    const previewUrl = findPreviewUrl(text);
    if (!previewUrl || seen.has(previewUrl)) return;
    seen.add(previewUrl);
    window.__dramaGvidsCaptured = { queueId: job.queueId, previewUrl };
    console.log('[Drama Tool · Google Vids] 🎬 Bắt được URL preview:', previewUrl.slice(0, 90));
  }

  // A real Google Vids "generate" request — the only thing worth learning as a replay sample.
  const GEN = /appsgenaiserver.*generate|\/v1\/genai\/generate|\/flix\/generate/i;
  function suppressed() {
    return (
      window.__dramaGvidsSuppressSampleUntil &&
      Date.now() < Number(window.__dramaGvidsSuppressSampleUntil)
    );
  }
  // Remember a generate request so the worker can re-fire it with a new prompt. Only a protobuf
  // JSON-array body is replayable; any other body shape is ignored (worker falls back to the UI).
  function stashSample(url, headers, bodyRaw) {
    try {
      let json = null;
      try {
        json = JSON.parse(bodyRaw);
      } catch (_) {}
      if (!Array.isArray(json)) return;
      window.__dramaGvidsSample = {
        url,
        headers: headers || {},
        bodyJson: json,
        at: Date.now(),
        promptText: '',
      };
      console.log('[Drama Tool · Google Vids] 🧬 Đã học mẫu replay từ request generate:', String(url).slice(0, 80));
    } catch (_) {}
  }

  // 1. fetch — learn the generate REQUEST (replay sample) and inspect the RESPONSE (preview URL)
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const req = typeof Request !== 'undefined' && args[0] instanceof Request ? args[0] : null;
    const url =
      typeof args[0] === 'string' ? args[0] : req ? req.url : args[0] && args[0].url ? args[0].url : '';
    const opts = args[1] || {};
    const method = String(opts.method || (req && req.method) || 'GET').toUpperCase();
    if (method === 'POST' && GEN.test(url) && !suppressed()) {
      try {
        const headers = {};
        if (req && req.headers) req.headers.forEach((v, k) => (headers[k] = v));
        if (opts.headers instanceof Headers) opts.headers.forEach((v, k) => (headers[k] = v));
        else if (opts.headers && typeof opts.headers === 'object') Object.assign(headers, opts.headers);
        let body = opts.body;
        if (body == null && req) {
          try {
            body = await req.clone().text();
          } catch (_) {}
        }
        if (typeof body === 'string') stashSample(url, headers, body);
      } catch (_) {}
    }
    const resp = await origFetch.apply(this, args);
    try {
      if (activeJob() && RELEVANT.test(url)) {
        resp
          .clone()
          .text()
          .then(t => report(url, resp.ok, resp.status, t))
          .catch(() => {});
      }
    } catch (_) {}
    return resp;
  };

  // 2. XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__gvidsUrl = url;
    this.__gvidsHeaders = {};
    return origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (h, v) {
    try {
      (this.__gvidsHeaders || (this.__gvidsHeaders = {}))[h] = v;
    } catch (_) {}
    return origSetHeader.apply(this, [h, v]);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__gvidsUrl || '';
    if (GEN.test(url) && typeof body === 'string' && !suppressed())
      stashSample(url, this.__gvidsHeaders || {}, body);
    if (RELEVANT.test(url)) {
      this.addEventListener(
        'loadend',
        () => {
          try {
            if (activeJob())
              report(url, !(this.status >= 400), this.status, String(this.responseText || ''));
          } catch (_) {}
        },
        { once: true },
      );
    }
    return origSend.apply(this, [body]);
  };

  console.log('[Drama Tool · Google Vids] Hook bắt preview đã sẵn sàng.');
})();
