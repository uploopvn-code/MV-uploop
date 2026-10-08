// Muse job observer. Captures only this job's new video, never attachment blobs or page demos.
(function () {
  if (window.__dramaMuseChatHookInstalled) return;
  window.__dramaMuseChatHookInstalled = true;
  const KEY = '__dramaMuseChatJob_v13';
  const ui = () => window.__dramaMuseChatUi;
  let baseline = new Set(), baselineElements = new WeakSet(), baselineDom = new WeakSet(), best = null, conversationRoot = null;
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const job = () => window.__dramaMuseChatActiveJob;
  // Muse exposes generated clips as MediaSource blob URLs. Such URLs cannot be
  // fetched as files, so retain the segments appended to their SourceBuffers.
  const objectUrls = new Map();
  const mediaStates = new WeakMap();
  const bufferStates = new WeakMap();
  const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
  const ensureMediaState = source => {
    let state = mediaStates.get(source);
    if (!state) {
      state = { kind: 'media-source', source, buffers: [], total: 0, overflow: false };
      mediaStates.set(source, state);
    }
    return state;
  };
  try {
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = object => {
      const url = originalCreateObjectURL(object);
      if (typeof MediaSource !== 'undefined' && object instanceof MediaSource) {
        objectUrls.set(url, ensureMediaState(object));
      } else if (typeof Blob !== 'undefined' && object instanceof Blob && /^video\//i.test(object.type || '')) {
        objectUrls.set(url, { kind: 'blob', blob: object });
      }
      return url;
    };
    URL.revokeObjectURL = url => {
      objectUrls.delete(String(url));
      return originalRevokeObjectURL(url);
    };
    if (typeof MediaSource !== 'undefined' && MediaSource.prototype?.addSourceBuffer) {
      const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const buffer = originalAddSourceBuffer.call(this, mime);
        const parent = ensureMediaState(this);
        const state = { parent, buffer, mime: String(mime || ''), chunks: [], total: 0 };
        parent.buffers.push(state);
        bufferStates.set(buffer, state);
        return buffer;
      };
    }
    if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype?.appendBuffer) {
      const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (data) {
        const state = bufferStates.get(this);
        if (state && job()?.sentAt && !state.parent.overflow) {
          try {
            const view = data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (state.parent.total + view.byteLength <= MAX_MEDIA_BYTES) {
              const copy = view.slice();
              state.chunks.push(copy);
              state.total += copy.byteLength;
              state.parent.total += copy.byteLength;
            } else {
              state.parent.overflow = true;
              state.chunks.length = 0;
            }
          } catch (_) {}
        }
        return originalAppendBuffer.call(this, data);
      };
    }
  } catch (_) {
    // Player recording remains available if browser prototypes are locked.
  }
  window.__dramaMuseChatReadObjectUrl = async url => {
    const state = objectUrls.get(String(url));
    if (!state) return null;
    if (state.kind === 'blob') {
      return { bytes: new Uint8Array(await state.blob.arrayBuffer()), mime: state.blob.type || '' };
    }
    if (state.overflow) return { error: 'Video MediaSource vượt giới hạn 200 MB.' };
    const player = [...document.querySelectorAll('video')].find(video =>
      video.currentSrc === url || video.src === url || video.getAttribute('src') === url,
    );
    const bufferedEnd = (() => {
      try { return player?.buffered?.length ? player.buffered.end(player.buffered.length - 1) : 0; }
      catch (_) { return 0; }
    })();
    const duration = Number(player?.duration || 0);
    const complete = state.source.readyState === 'ended' ||
      (Number.isFinite(duration) && duration > 0 && bufferedEnd >= duration - 0.15);
    if (!complete || state.buffers.some(item => item.buffer.updating))
      return { pending: true, detail: 'MediaSource vẫn đang nạp dữ liệu video.' };
    const candidates = state.buffers
      .filter(item => /^video\//i.test(item.mime) && item.total > 0)
      .sort((a, b) => b.total - a.total);
    const chosen = candidates[0] || state.buffers.slice().sort((a, b) => b.total - a.total)[0];
    if (!chosen?.chunks?.length) return { pending: true, detail: 'Chưa nhận được segment video.' };
    const bytes = new Uint8Array(chosen.total);
    let offset = 0;
    for (const chunk of chosen.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, mime: chosen.mime.split(';')[0], method: 'media-source-segments' };
  };
  const snapshot = () => job() ? { ...job(), baseline: [...baseline] } : null;
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(snapshot())); } catch (_) {} };
  const scopeHint = region => region ? { id: region.id || '', tag: region.tagName.toLowerCase(), chatId: region.getAttribute('data-chat-id') || '' } : null;
  function regionForJob() {
    if (conversationRoot?.isConnected) return conversationRoot;
    const hint = job()?.scopeHint;
    if (hint?.id) conversationRoot = document.getElementById(hint.id);
    if (!conversationRoot && hint?.chatId) conversationRoot = [...document.querySelectorAll('[data-chat-id]')].find(el => el.getAttribute('data-chat-id') === hint.chatId);
    if (conversationRoot?.isConnected) return conversationRoot;
    const input = ui()?.composer(true);
    if (input) return conversationRoot = ui().scope(input);
    // During generation Muse may remove/disable the composer entirely. Recover
    // only a uniquely identifiable conversation landmark, never the whole page.
    const selector = hint && ['main', 'aside'].includes(hint.tag) ? hint.tag : '[data-chat-id], .chat-container, .chat-panel, .side-chat, [role="dialog"], main';
    const regions = [...document.querySelectorAll(selector)].filter(el => ui()?.visible(el));
    return regions.length === 1 ? (conversationRoot = regions[0]) : null;
  }
  function restore(state) {
    if (!state?.queueId || !state.sentAt || Date.now() - state.sentAt >= 20 * 60 * 1000) return false;
    baseline = new Set(state.baseline || []);
    baselineElements = new WeakSet(document.querySelectorAll('video, video source, a[href]'));
    baselineDom = new WeakSet(document.querySelectorAll('*'));
    const restored = { ...state }; delete restored.baseline;
    window.__dramaMuseChatActiveJob = restored;
    conversationRoot = null; best = null; save();
    return true;
  }
  window.__dramaMuseChatSnapshot = snapshot;
  window.__dramaMuseChatRestore = restore;
  const urlOf = el => el.currentSrc || el.src || el.href || el.getAttribute('src') || el.getAttribute('href') || '';
  const media = root => [...root.querySelectorAll('video, video source, a[href]')];
  const mediaForJob = region => {
    // Muse renders generated cards through a React portal in some layouts. The
    // player can therefore be a sibling of the conversation/composer captured
    // when the prompt was sent. Keep the scoped results first, then inspect the
    // rest of the document while the pre-send URL baseline filters old media.
    const seen = new Set(), results = [];
    for (const el of [...(region ? media(region) : []), ...media(document)]) {
      if (!seen.has(el)) { seen.add(el); results.push(el); }
    }
    return results;
  };
  function arm(queueId, prompt) {
    const existingMedia = media(document);
    baseline = new Set(existingMedia.map(urlOf).filter(Boolean));
    baselineElements = new WeakSet(existingMedia);
    baselineDom = new WeakSet(document.querySelectorAll('*'));
    best = null;
    window.__dramaMuseChatCaptured = null; window.__dramaMuseChatError = null;
    const input = ui()?.composer(true);
    conversationRoot = input ? ui().scope(input) : null;
    window.__dramaMuseChatWarning = null;
    window.__dramaMuseChatActiveJob = { queueId, prompt, sentAt: Date.now(), confirmed: false, requestStarted: false, scopeHint: scopeHint(conversationRoot) };
    save();
  }
  function confirm() { if (job()) { job().confirmed = true; save(); scan(); } }
  function clear() { window.__dramaMuseChatActiveJob = null; conversationRoot = null; try { sessionStorage.removeItem(KEY); } catch (_) {} }
  window.__dramaMuseChatArm = arm;
  window.__dramaMuseChatConfirm = confirm;
  window.__dramaMuseChatClear = clear;
  try {
    restore(JSON.parse(sessionStorage.getItem(KEY) || 'null'));
  } catch (_) {}
  function capture(rawUrl, score, qid) {
    const active = job();
    if (!active?.sentAt || active.queueId !== qid || !rawUrl) return;
    let url;
    try { url = new URL(rawUrl.replace(/\\u0026/g, '&'), location.href).href; } catch (_) { return; }
    if (!/^(https?:|blob:)/.test(url) || /\.(m3u8|mpd)(?:[?#]|$)/i.test(url) || baseline.has(url)) return;
    // A new video in this conversation is itself evidence the send was accepted.
    // Network-only candidates still require a confirmed matching request.
    if (!active.confirmed) {
      if (score < 2) return;
      active.confirmed = true; save();
    }
    if (best && best.score > score) return;
    if (best?.url === url && best.score === score) return;
    best = { url, score };
    window.__dramaMuseChatCaptured = { queueId: qid, videoUrl: url, score };
  }
  function promptAnchor(active) {
    const needle = norm(active?.prompt).slice(0, 120);
    if (!needle) return null;
    const selectors = '[data-message-author-role="user"], [data-role="user"], [data-message-id], article, li, p, span, div';
    const candidates = [...document.querySelectorAll(selectors)].filter(el => {
      if (el.matches('textarea, input, [contenteditable], [data-drama-muse-status]') ||
          el.closest('form, [data-drama-muse-status]')) return false;
      return norm(el.textContent).includes(needle);
    });
    const depth = el => { let value = 0; for (let node = el; node?.parentElement; node = node.parentElement) value++; return value; };
    const role = el => el.matches('[data-message-author-role="user"], [data-role="user"]') ? 1 : 0;
    candidates.sort((a, b) => role(b) - role(a) ||
      norm(a.textContent).length - norm(b.textContent).length || depth(b) - depth(a));
    return candidates[0] || null;
  }
  function followsPrompt(player, active) {
    const anchor = promptAnchor(active);
    if (!anchor || !player || anchor === player || anchor.contains(player)) return false;
    return !!(anchor.compareDocumentPosition(player) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  function scan() {
    const active = job(), input = ui()?.composer(true);
    if (!active?.sentAt) return;
    try {
      if (!active.confirmed && input && !norm(ui().value(input)) && ui().hasMessage(input, active.prompt)) {
        active.confirmed = true; save();
      }
    } catch (_) { /* A transient transcript rerender must not block scanning videos. */ }
    const region = regionForJob();
    for (const el of mediaForJob(region)) {
      if (el.closest('[data-message-author-role="user"], [data-role="user"]')) continue;
      const isPlayer = el.tagName === 'VIDEO' || el.tagName === 'SOURCE';
      const url = urlOf(el);
      // A <video> URL need not have an extension. A generic blob link can be an image.
      if (!isPlayer && !/\.(mp4|webm)(?:[?#]|$)/i.test(url) && !/^video\//i.test(el.type || '')) continue;
      const player = el.tagName === 'SOURCE' ? el.parentElement : el;
      const introContext = [url, player?.id, player?.className, player?.parentElement?.id, player?.parentElement?.className]
        .filter(value => typeof value === 'string').join(' ');
      // Landing/intro players can assign or rotate their blob URL after arm().
      // Exclude the DOM nodes themselves as well as autoplay/hero media; Muse's
      // generated player is a newly inserted non-autoplay <video> in the result card.
      if (
        baselineElements.has(el) || baselineElements.has(player) ||
        player?.hasAttribute?.('autoplay') ||
        player?.closest?.('header, nav, [role="banner"]') ||
        /(?:^|[\s_\-/])(intro|hero|landing|promo|showreel)(?:[\s_\-/]|$)/i.test(introContext)
      ) continue;
      // The definitive ownership check is document order relative to this job's
      // user message. Previous result cards stay before that message even when
      // React recreates their <video> and blob URL after the send.
      if (isPlayer && !followsPrompt(player, active)) continue;
      const explicitResult = player?.closest?.(
        '[data-message-author-role="assistant"], [data-role="assistant"], [data-result], [data-output], [data-generation]'
      );
      if (isPlayer && !explicitResult && player?.parentElement && baselineDom.has(player.parentElement)) continue;
      if (isPlayer && player.error) continue;
      capture(url, /^blob:/.test(url) ? 2 : isPlayer ? 4 : 5, active.queueId);
    }
  }
  window.__dramaMuseChatDiagnostics = () => {
    const region = regionForJob();
    const videos = [...document.querySelectorAll('video')];
    const active = job(), anchor = promptAnchor(active);
    const fresh = videos.filter(video => {
      const url = urlOf(video);
      return url && !baseline.has(url) && !baselineElements.has(video) && !video.hasAttribute('autoplay') &&
        !video.closest('[data-message-author-role="user"], [data-role="user"], header, nav, [role="banner"]') &&
        followsPrompt(video, active);
    });
    return {
      documentVideos: videos.length,
      scopedVideos: region ? region.querySelectorAll('video').length : 0,
      freshVideos: fresh.length,
      freshBlobVideos: fresh.filter(video => /^blob:/.test(urlOf(video))).length,
      promptAnchorFound: !!anchor,
      videoStates: videos.slice(-5).map(video => ({
        baselineUrl: baseline.has(urlOf(video)),
        baselineNode: baselineElements.has(video),
        followsPrompt: followsPrompt(video, active),
        parentWasPresent: !!video.parentElement && baselineDom.has(video.parentElement),
        autoplay: video.hasAttribute('autoplay'),
      })),
    };
  };
  window.__dramaMuseChatPoll = scan;
  const RELEVANT = /message|chat|conversation|generat|render|task/i;
  function context(url, method, body) {
    const active = job();
    if (!active?.sentAt || !RELEVANT.test(url) || !/POST|PUT|PATCH/i.test(method)) return null;
    let text = typeof body === 'string' ? body : '';
    try { text = JSON.stringify(JSON.parse(text)); } catch (_) {}
    const needle = String(active.prompt || '');
    // Match the submitted prompt, not unrelated uploads, telemetry, history or polling.
    if (!needle || (!norm(text).includes(norm(needle)) && !text.includes(JSON.stringify(needle).slice(1, -1)))) return null;
    active.requestStarted = true; save();
    return { queueId: active.queueId, sentAt: active.sentAt };
  }
  function same(ctx) { return ctx && job()?.queueId === ctx.queueId && job()?.sentAt === ctx.sentAt; }
  function response(ctx, ok, status) {
    if (!same(ctx)) return;
    if (!ok) {
      if (status >= 400 && status < 500) window.__dramaMuseChatError = { queueId: ctx.queueId, detail: 'Muse từ chối gửi prompt (HTTP ' + status + ').' };
      else window.__dramaMuseChatWarning = { queueId: ctx.queueId, detail: 'Chưa nhận được xác nhận từ Muse (HTTP ' + status + '); tiếp tục theo dõi video.' };
    } else confirm();
  }
  function inspect(ctx, text) {
    if (!same(ctx) || !job().confirmed) return;
    try {
      const data = JSON.parse(text);
      if (data && (data.error || data.success === false)) {
        const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message || 'Không tạo được video';
        window.__dramaMuseChatError = { queueId: ctx.queueId, detail: String(detail).slice(0, 300) };
        return;
      }
    } catch (_) {}
    // Do not extract arbitrary media URLs from a response body. Some Muse chat
    // responses include earlier conversation assets. The DOM ownership check is
    // required before a URL can become this job's result.
  }
  function inspectMediaResponse(url, response) {
    const active = job();
    if (!active?.sentAt || !response?.ok) return;
    const type = response.headers?.get('content-type') || '';
    // Do not treat an arbitrary media GET as this job's output. Muse loads intro
    // and promotional clips through the same media routes. Result URLs are read
    // only from the matching prompt response (inspect(ctx, ...)) or the new DOM player.
    if (/^video\//i.test(type)) return;
  }
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const request = typeof Request !== 'undefined' && args[0] instanceof Request ? args[0] : null;
    const url = String(request?.url || args[0]?.url || args[0] || '');
    const method = args[1]?.method || request?.method || 'GET';
    let body = args[1]?.body;
    // Clone only text request bodies of active chat writes; do not consume the site's body.
    if (body == null && request && job()?.sentAt && RELEVANT.test(url) && /POST|PUT|PATCH/i.test(method)) {
      try { body = await request.clone().text(); } catch (_) {}
    }
    const ctx = context(url, method, body);
    try {
      const result = await originalFetch.apply(this, args);
      response(ctx, result.ok, result.status);
      inspectMediaResponse(url, result);
      const type = result.headers.get('content-type') || '';
      if (ctx && result.ok && /json|text/.test(type)) result.clone().text().then(text => inspect(ctx, text)).catch(() => {});
      return result;
    } catch (error) {
      // A dropped response is ambiguous; never replay the prompt automatically.
      if (same(ctx)) window.__dramaMuseChatWarning = { queueId: ctx.queueId, detail: 'Mất phản hồi lúc gửi; tiếp tục chờ video, không gửi lại prompt.' };
      throw error;
    }
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dramaRequest = { method, url: String(url) }; return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__dramaRequest || {}, ctx = context(meta.url || '', meta.method || '', body);
    if (ctx || job()?.sentAt) this.addEventListener('loadend', () => {
      if (ctx) {
        response(ctx, this.status >= 200 && this.status < 400, this.status);
        try { inspect(ctx, this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText); } catch (_) {}
      }
    }, { once: true });
    return send.call(this, body);
  };
  let scanPending = false;
  const schedule = () => {
    if (!job()?.sentAt || scanPending) return;
    scanPending = true; setTimeout(() => { scanPending = false; scan(); }, 150);
  };
  new MutationObserver(schedule).observe(document.documentElement || document, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'],
  });
  document.addEventListener('loadeddata', schedule, true);
  document.addEventListener('canplay', schedule, true);
})();
