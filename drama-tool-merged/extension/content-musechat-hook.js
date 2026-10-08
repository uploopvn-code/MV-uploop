// Drama Tool Muse-Chat worker — page-world hook (runs in MAIN world at document_start on
// muse.ai). It watches the web chat for the finished video of the active job and reports it back.
//
// The service worker marks a job active by setting
//   window.__dramaMuseChatActiveJob = { queueId }
// While a job is active, the first NEW playable video URL that appears in the chat is stashed in
//   window.__dramaMuseChatCaptured = { queueId, videoUrl }
// and a generation-time failure in
//   window.__dramaMuseChatError = { queueId, detail }
// The service worker polls those globals back. No chrome.* here — MAIN world has none.
//
// DESIGN NOTE (per requirement): every command runs in its OWN tab with NO tab reuse and NO
// concurrency cap, so one tab == one job. Captures are still keyed by queueId as a safety net.

(function () {
  if (window.__dramaMuseChatHookInstalled) return;
  window.__dramaMuseChatHookInstalled = true;
  window.__dramaMuseChatActiveJob = window.__dramaMuseChatActiveJob || null;
  window.__dramaMuseChatCaptured = window.__dramaMuseChatCaptured || null;
  window.__dramaMuseChatError = window.__dramaMuseChatError || null;

  let lastQueueId = '';
  const seen = new Set();

  function activeJob() {
    const j = window.__dramaMuseChatActiveJob;
    if (!j || !j.queueId) return null;
    if (j.queueId !== lastQueueId) {
      lastQueueId = j.queueId;
      seen.clear();
    }
    return j;
  }

  function cleanUrl(u) {
    return String(u || '')
      .replace(/\\u0026/g, '&')
      .trim();
  }

  function findVideoUrl(value) {
    if (!value) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value || {});
    let m = text.match(/https?:\/\/[^\s"'\\]+\.(?:mp4|webm)(?:\?[^\s"'\\]*)?/i);
    if (m) return cleanUrl(m[0]);
    m = text.match(/blob:https?:\/\/[^\s"'\\]+/i);
    if (m) return cleanUrl(m[0]);
    return '';
  }

  function capture(url, via) {
    const job = activeJob();
    if (!job || !url || seen.has(url)) return;
    seen.add(url);
    window.__dramaMuseChatCaptured = { queueId: job.queueId, videoUrl: url };
    console.log('[Drama Tool · Muse Chat] 🎬 Bắt được video (' + via + '):', url.slice(0, 90));
  }

  function fail(detail) {
    const job = activeJob();
    if (!job) return;
    window.__dramaMuseChatError = { queueId: job.queueId, detail: String(detail).slice(0, 300) };
    console.log('[Drama Tool · Muse Chat] ⚠️ Lỗi:', detail);
  }

  // 1. Network responses: the chat backend may return the video file URL in JSON.
  const RELEVANT = /message|chat|conversation|media|video|generat|attach|upload/i;
  function inspectResponse(url, ok, status, text) {
    const job = activeJob();
    if (!job || !RELEVANT.test(url)) return;
    if (!ok && /message|conversation|chat/i.test(url)) {
      fail('Muse chat báo lỗi HTTP ' + status + ': ' + String(text || '').slice(0, 120));
      return;
    }
    const v = findVideoUrl(text);
    if (v) capture(v, 'network');
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const req = typeof Request !== 'undefined' && args[0] instanceof Request ? args[0] : null;
      const url =
        typeof args[0] === 'string' ? args[0] : req ? req.url : args[0] && args[0].url ? args[0] : '';
      if (activeJob() && RELEVANT.test(url)) {
        resp
          .clone()
          .text()
          .then(t => inspectResponse(url, resp.ok, resp.status, t))
          .catch(() => {});
      }
    } catch (_) {}
    return resp;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mcUrl = url;
    return origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__mcUrl || '';
    if (RELEVANT.test(url)) {
      this.addEventListener(
        'loadend',
        () => {
          try {
            if (activeJob())
              inspectResponse(
                url,
                !(this.status >= 400),
                this.status,
                String(this.responseText || ''),
              );
          } catch (_) {}
        },
        { once: true },
      );
    }
    return origSend.apply(this, [body]);
  };

  // 2. DOM watch: the assistant's reply renders the video as <video> or a download link.
  // Only elements that appear AFTER the job went active are candidates.
  function scanNode(root) {
    const job = activeJob();
    if (!job || window.__dramaMuseChatCaptured) return;
    const els = [];
    try {
      if (root instanceof HTMLVideoElement) els.push(root);
      if (root.querySelectorAll) {
        els.push(...root.querySelectorAll('video'));
        els.push(...root.querySelectorAll('a[href]'));
        els.push(...root.querySelectorAll('source[src]'));
      }
    } catch (_) {}
    for (const el of els) {
      const u =
        cleanUrl(el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('href') || '');
      if (!u) continue;
      if (/\.mp4(\?|$)/i.test(u) || /\.webm(\?|$)/i.test(u) || /^blob:/i.test(u)) {
        capture(u, 'dom');
        return;
      }
    }
  }

  const observer = new MutationObserver(muts => {
    if (!activeJob() || window.__dramaMuseChatCaptured) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          scanNode(n);
          if (window.__dramaMuseChatCaptured) return;
        }
      }
    }
  });
  try {
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
  } catch (_) {}

  console.log('[Drama Tool · Muse Chat] Hook đã sẵn sàng.');
})();
