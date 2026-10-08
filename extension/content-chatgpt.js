// Drama Tool ChatGPT worker — content script (runs inside chatgpt.com).
//
// The service worker drives this over a Port named 'job:<jobId>' with one command:
//   { cmd:'generate', prompt, images } — start a fresh chat, attach the reference images, type and
//       send the prompt, then wait for the generated image;
//   { cmd:'collect' } — the tab is already on a conversation whose prompt went out in an earlier run:
//       send nothing, just fetch the newest generated image of that conversation;
//   { cmd:'ask', prompt } — the Director agent: send a text prompt and scrape the reply.
// It posts { progress } at least every 10 s (each Port message keeps the MV3 service worker alive),
// { progress, sent:true, href } once the prompt is submitted, { progress, href } when the
// conversation URL (/c/<uuid>) appears, and finally { done:true, base64, mime } |
// { done:true, imageUrl } | { done:true, text } | { done:true, error, sent, href, replyText }.
//
// The image is read from the page's own backend API (GET /backend-api/conversation/<id>), not from
// the DOM: ChatGPT renders images as a background task that finishes long after the Stop button is
// gone, and its DOM changes often. The DOM is only a fallback when that API keeps failing.

(() => {
  if (window.__dramaChatGPTWorker) return;
  window.__dramaChatGPTWorker = true;

  // A timer armed inside another timer's callback is "chained", and Chrome throttles the chained
  // timers of a tab hidden for 5+ minutes (the worker tab is never focused) to one wake-up a minute.
  // Arming every timer from a MessageChannel task keeps it unchained, so polls keep their rhythm.
  const sleep = ms =>
    new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        setTimeout(resolve, ms);
      };
      ch.port2.postMessage(0);
    });
  const first = sels => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const last = list => list[list.length - 1];
  const srcOf = img => img.currentSrc || img.src || '';
  const jobError = (msg, extra) => Object.assign(new Error(msg), extra);
  async function waitFor(fn, timeout, msg) {
    const end = Date.now() + timeout;
    for (;;) {
      if (!alive()) throw new Error(DEAD);
      let v;
      try {
        v = fn();
      } catch {
        v = null;
      }
      if (v) return v;
      if (Date.now() > end) throw new Error(msg || 'Hết thời gian chờ phần tử');
      await sleep(350);
    }
  }

  // Chrome invalidates this content script's context when the extension is reloaded or updated,
  // while a job may still be running here (a reply can take minutes). After that every chrome.*
  // or port call throws "Extension context invalidated". alive() tells whether the context is
  // still valid; post() swallows a send to a dead port so it never becomes an uncaught rejection.
  // The server then recovers the job from its conversation URL (cmd 'collect').
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  const post = (port, obj) => {
    try {
      port.postMessage(obj);
    } catch {}
  };
  const DEAD = 'Extension được tải lại — dừng job cũ trong tab này.';
  // This document's id: after a navigation the service worker waits for a NEW one to answer, so a
  // page being left (even the same URL) is never taken for the page it asked for.
  const DOC = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'ping') {
      try {
        sendResponse({ ready: true, href: location.href, doc: DOC });
      } catch {}
    }
  });

  chrome.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith('job:')) return;
    const job = newJob(port);
    port.onDisconnect.addListener(() => (job.gone = true));
    port.onMessage.addListener(async msg => {
      let run;
      if (msg && msg.cmd === 'generate') run = runGeneration;
      else if (msg && msg.cmd === 'collect') run = runCollect;
      else if (msg && msg.cmd === 'ask') run = runAsk;
      else return;
      job.keepAlive();
      try {
        post(port, { done: true, ...(await run(msg, job)) });
      } catch (e) {
        const out = {
          done: true,
          error: e?.message || String(e),
          sent: e?.sent ?? job.sent,
          href: job.href(),
        };
        if (e?.replyText) out.replyText = e.replyText;
        post(port, out);
      } finally {
        job.ended = true;
      }
    });
  });

  // ---- selectors ----------------------------------------------------------
  const EDITOR = ['#prompt-textarea', 'main form [contenteditable="true"]', 'main form textarea'];
  const SEND = [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Gửi" i]',
  ];
  const NEWCHAT = [
    'a[data-testid="create-new-chat-button"]',
    'button[data-testid="create-new-chat-button"]',
    'button[aria-label*="New chat" i]',
    'a[aria-label*="New chat" i]',
  ];
  // Any conversation turn: 2026 layouts (conversation-turn-N / data-turn-key) and the older one.
  const TURN_ANY =
    '[data-testid^="conversation-turn-"], [data-turn-key], [data-message-author-role]';
  const USER_TURN =
    '[data-turn="user"], [data-message-author-role="user"], [data-user-message-bubble]';
  const LOGIN = '[data-testid="login-button"]';
  // A conversation path: /c/<uuid>, or /g/<gizmo or project>/c/<uuid>.
  const CONV_RE =
    /^\/(?:g\/[\w-]+\/)?c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const convPath = () => {
    const m = CONV_RE.exec(location.pathname);
    return m ? m[0] : '';
  };
  const POLL_MS = 5000;

  // ---- per-job state ------------------------------------------------------
  // What was sent, the conversation it went to, and a keep-alive that re-posts the last progress
  // line whenever nothing was posted for 8 s (a quiet Port lets Chrome kill the service worker).
  function newJob(port) {
    const job = {
      sent: false,
      sentAt: 0,
      conv: '',
      gone: false,
      ended: false,
      t0: Date.now(),
      last: 'bắt đầu',
      lastPost: Date.now(),
    };
    job.post = obj => {
      job.lastPost = Date.now();
      post(port, obj);
    };
    job.say = (text, extra) => {
      job.last = text;
      const secs = Math.round((Date.now() - job.t0) / 1000);
      job.post({ progress: text + ' · ' + secs + 's', ...extra });
    };
    job.href = () => {
      const p = job.conv || convPath();
      return p ? location.origin + p : location.href;
    };
    job.check = () => {
      if (!alive()) throw new Error(DEAD);
      if (job.gone) throw new Error('Extension đã ngắt kết nối với tab — dừng job.');
    };
    job.markSent = () => {
      job.sent = true;
      job.sentAt = Date.now();
      job.say('đã gửi prompt', { sent: true, href: location.href });
    };
    // The conversation id, locked to the first /c/<uuid> seen and reported once as href.
    job.cid = () => {
      if (!job.conv) {
        const p = convPath();
        if (!p) return '';
        job.conv = p;
        job.say('đã có cuộc trò chuyện', { href: location.origin + p });
      }
      return CONV_RE.exec(job.conv)[1];
    };
    job.keepAlive = async () => {
      while (!job.ended && !job.gone && alive()) {
        await sleep(2000);
        if (!job.ended && Date.now() - job.lastPost >= 8000) job.say(job.last);
      }
    };
    return job;
  }

  // ---- steps --------------------------------------------------------------
  async function runGeneration({ prompt, images }, job) {
    images = images || [];
    await ensureLoggedIn();
    // Signed out, the page still shows an (anonymous) composer: the session endpoint knows better.
    // Any other failure here is left to the wait loop, which retries.
    const signedOut = await accessToken(true).then(
      () => false,
      e => !!e.noSession,
    );
    if (signedOut) throw new Error('Chưa đăng nhập ChatGPT. Hãy đăng nhập trong tab này.');
    await newChatIfNeeded(job);
    let editor = await waitForComposer();

    if (images.length) {
      job.say('đính ' + images.length + ' ảnh tham chiếu');
      await attachImages(images, editor);
      await waitUploadsReady(images.length, job);
      editor = currentEditor() || editor; // the composer can re-render after an upload
    }

    job.check();
    job.say('nhập prompt');
    await setEditorText(editor, prompt);
    await sleep(250);

    const before = domImages().map(srcOf);
    job.check(); // never send once the extension has let go of this job
    job.say('gửi');
    await clickSend(editor);
    await waitForSubmittedPrompt(editor, job);
    job.markSent();

    const refs = new Set(
      images
        .map(im => String(im.dataUrl || ''))
        .map(s => s.slice(s.indexOf(',') + 1))
        .filter(Boolean),
    );
    return waitForImage(job, {
      before,
      refs,
      timeout: 480000,
      refuseAfter: 20000,
      timeoutMsg: 'ChatGPT chưa trả ảnh sau 480s — ảnh có thể vẫn đang tạo trong cuộc trò chuyện',
      noImageMsg: 'ChatGPT trả lời mà không có ảnh (từ chối, hết lượt tạo ảnh hoặc cần xác minh)',
    });
  }

  // Recover the image of a conversation whose prompt was sent earlier. Nothing is typed or sent.
  async function runCollect(msg, job) {
    // The prompt went out in the original run, so every error here is reported as sent: the job
    // stays reviewable instead of being re-run (which would spend another generation).
    job.sent = true;
    job.say('mở lại cuộc trò chuyện');
    await waitFor(() => first(EDITOR) || document.querySelector(TURN_ANY), 30000).catch(() => {});
    if (!job.cid())
      throw new Error(
        'Tab không ở cuộc trò chuyện ChatGPT (' +
          location.href +
          ') — cuộc trò chuyện đã bị xoá hoặc thuộc tài khoản khác?',
      );
    return waitForImage(job, {
      collect: true,
      before: [],
      refs: new Set(),
      timeout: 360000,
      refuseAfter: 0,
      timeoutMsg: 'Quá 360s chưa lấy được ảnh từ cuộc trò chuyện ChatGPT',
      noImageMsg: 'Cuộc trò chuyện không có ảnh',
    });
  }

  // The Director agent: type a prompt, wait for the reply, scrape its text. No images.
  async function runAsk({ prompt }, job) {
    await ensureLoggedIn();
    await newChatIfNeeded(job);
    const editor = await waitForComposer();
    job.say('nhập prompt');
    await setEditorText(editor, prompt);
    await sleep(250);
    job.check();
    job.say('gửi');
    await clickSend(editor);
    await waitForSubmittedPrompt(editor, job);
    job.markSent();
    job.say('chờ ChatGPT trả lời…');
    const text = await waitForText(job, 600000);
    return { text };
  }
  // The assistant reply's rendered text. ChatGPT's 2026 build dropped data-message-author-role
  // and .markdown; the reply now lives in a "MarkdownRoot-*" container — for a normal message AND
  // for a writing-block / canvas answer — so match that by class prefix, with fallbacks for the
  // writing-block surface and older builds. (Deliberately NOT used: data-conversation-role=
  // "assistant" is only the "ChatGPT said:" label, and the last data-turn-key can be the user's
  // turn.) Confirmed live by a page probe: [class*="MarkdownRoot"] held the full reply.
  const REPLY_SELS = [
    '[class*="MarkdownRoot"]',
    '[data-oai-writing-block-surface]',
    '[data-markdown-copy-content]',
    '.writing-block-editor .ProseMirror',
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"]',
    'main .markdown, main .prose',
  ];
  const replyText = () => {
    for (const sel of REPLY_SELS) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      const t = ((els[els.length - 1] || {}).innerText || '').trim();
      if (t) return t;
    }
    return '';
  };
  // Is ChatGPT still generating? (A stop button, or a streaming indicator.) Selectors vary across
  // builds; if none ever match we simply fall back to text-stability. Reasoning models ("Analyzed",
  // "Worked for 2m") think for a long time before streaming, and stream large answers for a while —
  // so we must NOT take the text while this is true.
  const isStreaming = () =>
    !!document.querySelector(
      'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="Dừng" i], [data-state="streaming"], [class*="result-streaming"], [class*="is-streaming"]',
    );
  // Wait for this ask-job's reply from the conversation's OWN backend API — the complete message
  // text, not the DOM's innerText. ChatGPT virtualizes a long code block (a big CSV answer), so
  // innerText returns only the rows currently rendered and keeps shifting: text never settles, the
  // turn hits the watchdog, and whatever is scraped is truncated. The backend branch (current_node
  // → last end_turn reply to the user) returns the whole message regardless of what is on screen,
  // and reasoning models are handled for free — convState ignores thoughts / reasoning_recap and
  // the model's own Python tool calls, so the "Analyzed" steps never count as the answer. The DOM
  // is a fallback only while the API is unreachable or the conversation id is still unknown.
  async function waitForText(job, timeout) {
    const t0 = job.sentAt || Date.now();
    const POLL = 1500;
    let apiErrs = 0,
      blocked = 0,
      pauseUntil = 0,
      sendChecked = false,
      lastErr = '',
      reply = '',
      domText = '',
      domSince = 0,
      domGrew = false;
    for (;;) {
      job.check();
      if (Date.now() - t0 > timeout) {
        const best = reply || (domGrew ? domText : '') || replyText();
        if (best) return best; // timed out mid-answer: hand back the most complete text we saw
        throw jobError('ChatGPT quá thời gian trả lời.' + (lastErr ? ' [' + lastErr + ']' : ''), {
          replyText: reply,
        });
      }
      const block = blocker();
      blocked = block ? blocked + 1 : 0;
      if (blocked >= 2) throw jobError(block, { replyText: reply });

      const cid = job.cid();
      // No conversation 30 s after sending and the prompt still sits in the composer: it never went
      // out (safe to re-run). Checked once.
      if (!cid && !sendChecked && Date.now() - t0 > 30000) {
        sendChecked = true;
        const ed = first(EDITOR);
        if (ed && (ed.value || ed.textContent || '').trim() && !document.querySelector(USER_TURN))
          throw jobError('Prompt chưa được gửi lên ChatGPT (nút gửi không phản hồi).', {
            sent: false,
          });
      }

      let phase = cid ? 'chờ ChatGPT trả lời' : 'chờ ChatGPT mở cuộc trò chuyện';
      let st = null;
      if (cid && Date.now() < pauseUntil) phase = 'ChatGPT giới hạn tốc độ, tạm ngừng hỏi';
      else if (cid) {
        try {
          st = await convState(cid);
          apiErrs = 0;
        } catch (e) {
          apiErrs++;
          lastErr = 'API: ' + e.message;
          if (e.status === 429) pauseUntil = Date.now() + Math.max(30000, e.retryAfter || 0);
          if (e.noSession && apiErrs >= 2)
            throw jobError('ChatGPT đã đăng xuất — hãy đăng nhập lại trong tab này.', {
              replyText: reply,
            });
        }
      }

      if (st) {
        if (st.fullText)
          reply = st.fullText; // keep the latest full answer, even mid-stream
        else if (st.text) reply = st.text;
        if (st.finished) {
          if (st.fullText) return st.fullText; // the end_turn reply to the user, complete
          const t = replyText();
          if (t) return t; // finished but the answer wasn't plain text (canvas): take the DOM
        }
        phase = st.idle ? 'ChatGPT đang soạn trả lời' : 'ChatGPT đang phân tích';
      }

      // DOM fallback: only while the backend API can't be used (no id yet, or failing repeatedly).
      // Same rule as before — a new reply, not streaming, steady 3 s.
      if (!cid || apiErrs >= 3) {
        const t = replyText();
        if (t && t !== domText) {
          domText = t;
          domSince = Date.now();
          domGrew = true;
        }
        if (t && !isStreaming() && Date.now() - domSince >= 3000) return t;
      }

      job.say(phase + (reply ? ' · ' + reply.length + ' ký tự' : ''));
      await sleep(POLL);
    }
  }

  function visibleEditor(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function currentEditor() {
    return EDITOR.map(s => [...document.querySelectorAll(s)].find(visibleEditor)).find(Boolean) || null;
  }
  async function waitForComposer(timeout = 20000) {
    try {
      return await waitFor(currentEditor, timeout, 'Không thấy ô nhập của ChatGPT');
    } catch {
      throw new Error('Composer ChatGPT chưa sẵn sàng hoặc chưa đăng nhập. Hãy mở tab ChatGPT và thử lại.');
    }
  }
  async function ensureLoggedIn() {
    await waitForComposer(20000);
  }

  const isEmptyChat = () => !CONV_RE.test(location.pathname) && !document.querySelector(TURN_ANY);
  async function newChatIfNeeded(job) {
    if (isEmptyChat()) return;
    job.say('mở cuộc trò chuyện mới');
    // The in-app button keeps this script (and the job's Port) alive; verify it really emptied.
    const btn = first(NEWCHAT);
    if (btn) {
      btn.click();
      if (await waitFor(isEmptyChat, 8000).catch(() => false)) return;
    }
    // A full load of '/' is the surest empty chat, but it unloads this script and its Port, so
    // report a clean failure before anything was sent (safe to re-run) instead of going silent.
    location.assign('/');
    throw jobError('Tab ChatGPT chưa ở cuộc trò chuyện mới — đã mở lại trang chủ, hãy chạy lại.', {
      sent: false,
    });
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }
  function editorValue(editor) {
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') return editor.value;
    const clone = editor.cloneNode(true);
    for (const el of clone.querySelectorAll(
      '.placeholder, [data-placeholder], [class*="placeholder"]',
    ))
      el.remove();
    return (clone.innerText || clone.textContent || '').replace(/ /g, ' ');
  }
  function editorValue2(editor) {
    return (
      editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT'
        ? editor.value
        : editor.innerText || editor.textContent || ''
    ).replace(/ /g, ' ');
  }
  function selectEditorContents(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function normalizeEditorText(text) {
    return String(text || '')
      .replace(/ /g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function promptMatches(editor, value) {
    const actual = normalizeEditorText(editorValue(editor));
    const expected = normalizeEditorText(value);
    return actual === expected || (expected.length > 40 && actual.includes(expected.slice(0, 40)));
  }
  async function setEditorText(editor, text) {
    const value = String(text || '');
    editor = currentEditor() || editor;
    if (!visibleEditor(editor)) throw new Error('Composer ChatGPT không còn sẵn sàng');
    editor.focus();
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      setNativeValue(editor, value);
      editor.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
      );
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);
      if (!promptMatches(editor, value)) {
        const fresh = currentEditor();
        if (fresh && fresh !== editor) {
          setNativeValue(fresh, value);
          fresh.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          await sleep(150);
          editor = fresh;
        }
      }
      if (!promptMatches(editor, value)) throw new Error('Không nhập được prompt vào ô ChatGPT');
      return;
    }

    // ChatGPT's current composer is contenteditable. Select only this editor (not the document),
    // then use the browser editing command so the app's input handler receives a real edit.
    selectEditorContents(editor);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, value);
    } catch {}
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    await sleep(150);

    // Some builds ignore execCommand. A synthetic paste is the next compatible path; unlike
    // assigning textContent, ChatGPT's paste handler updates its internal editor state.
    if (!promptMatches(editor, value)) {
      const fresh = currentEditor() || editor;
      selectEditorContents(fresh);
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', value);
        fresh.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      } catch {}
      fresh.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }),
      );
      await sleep(150);
      editor = fresh;
    }
    if (!promptMatches(editor, value)) throw new Error('Không nhập được prompt vào ô ChatGPT');
    void inserted;
  }
  // The prompt is out only when a user turn or a /c/<id> URL exists, or the composer cleared
  // (ChatGPT empties it after a successful send). A composer that re-rendered after the send
  // detaches the old element, so re-read it rather than trusting the stale node.
  async function waitForSubmittedPrompt(editor, job) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      job.check();
      if (convPath() || document.querySelector(USER_TURN)) return;
      const ed = editor.isConnected ? editor : currentEditor();
      if (!ed || !editorValue(ed).trim()) return;
      await sleep(350);
    }
    throw jobError('ChatGPT không nhận nút gửi hoặc prompt chưa được gửi.', { sent: false });
  }

  function dataUrlToFile(dataUrl, name, mime) {
    const comma = dataUrl.indexOf(',');
    const bytes = atob(dataUrl.slice(comma + 1));
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new File([arr], name || 'ref.png', { type: mime || 'image/png' });
  }
  async function attachImages(images, editor) {
    const files = images.map((im, i) =>
      dataUrlToFile(im.dataUrl, im.name || 'ref-' + (i + 1) + '.png', im.mime),
    );
    // The composer's own upload input is #upload-files (inside the form). The accept="image/*"
    // inputs outside the form (#upload-photos, #upload-media, …) are decoys: files given to them
    // are silently dropped. Other inputs are a last resort.
    const input =
      document.querySelector('#upload-files') ||
      document.querySelector('form input[type="file"]') ||
      [...document.querySelectorAll('input[type="file"]')].find(
        el => !el.accept || /image|\*/.test(el.accept),
      );
    if (input) {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // Fallback: paste the files onto the composer.
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }
  // Ready = the composer form shows a thumbnail per image, none still a local blob: preview (those
  // are not on ChatGPT's server yet), and nothing in the form is busy. Never send half-uploaded.
  async function waitUploadsReady(count, job) {
    await sleep(600);
    const end = Date.now() + 90000;
    for (;;) {
      job.check();
      const ed = first(EDITOR);
      const form =
        (ed && ed.closest('form')) ||
        document.querySelector('main form') ||
        document.querySelector('form');
      if (form) {
        const thumbs = [...form.querySelectorAll('img')].filter(img =>
          /^blob:|estuary\/content|oaiusercontent|files\/download/.test(srcOf(img)),
        );
        const busy = form.querySelector('[role="progressbar"], [aria-busy="true"]');
        if (thumbs.length >= count && !thumbs.some(img => srcOf(img).startsWith('blob:')) && !busy)
          return;
      }
      if (Date.now() > end) throw new Error('Ảnh tham chiếu chưa tải lên xong — chưa gửi.');
      await sleep(500);
    }
  }

  async function clickSend(editor) {
    const btn = await waitFor(
      () => {
        const b = first(SEND);
        return b && !b.disabled ? b : null;
      },
      15000,
      'Không bấm được nút gửi của ChatGPT',
    ).catch(() => null);
    if (btn) {
      btn.click();
      return;
    }
    // Fallback: press Enter in the editor.
    for (const type of ['keydown', 'keypress', 'keyup'])
      editor.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        }),
      );
  }

  // ---- ChatGPT backend API (the page's own, same origin) -------------------
  let token = '';
  const httpError = r =>
    jobError('HTTP ' + r.status, {
      status: r.status,
      retryAfter: (Number(r.headers.get('retry-after')) || 0) * 1000,
    });
  async function accessToken(refresh) {
    if (token && !refresh) return token;
    token = '';
    const r = await fetch(location.origin + '/api/auth/session', {
      credentials: 'include',
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw httpError(r);
    const d = await r.json().catch(() => null);
    if (!d || !d.accessToken) throw jobError('không có phiên đăng nhập', { noSession: true });
    return (token = d.accessToken);
  }
  async function apiGet(path) {
    for (let retry = false; ; retry = true) {
      const r = await fetch(location.origin + path, {
        credentials: 'include',
        headers: { Authorization: 'Bearer ' + (await accessToken(retry)) },
        signal: AbortSignal.timeout(20000),
      });
      if ((r.status === 401 || r.status === 403) && !retry) continue; // stale token: refresh once
      if (!r.ok) throw httpError(r);
      return r.json();
    }
  }

  // The live branch of a conversation (current_node → parent), reduced to what came after the last
  // user message — so the user's own reference uploads never count as a result. finished = no
  // background task left and the tail is the reply that ENDS the turn (end_turn), addressed to the
  // user — a finished intermediate message (a reasoning recap, a line before the image tool runs,
  // a message to a tool) is not the end.
  async function convState(cid) {
    const d = await apiGet('/backend-api/conversation/' + cid);
    const map = d.mapping || {};
    const chain = [];
    for (let id = d.current_node, seen = new Set(); id && map[id] && !seen.has(id);) {
      seen.add(id);
      if (map[id].message) chain.unshift(map[id].message);
      id = map[id].parent;
    }
    let lastUser = -1;
    chain.forEach((m, i) => {
      if (m.author && m.author.role === 'user' && m.weight !== 0) lastUser = i;
    });
    const after = chain.slice(lastUser + 1);
    const assets = [];
    const said = { assistant: [], tool: [] };
    for (const m of after) {
      const role = m.author && m.author.role;
      const recipient = m.recipient || 'all';
      const ctype = m.content && m.content.content_type;
      // User-facing assistant prose and code blocks only — NOT the model's own Python tool calls
      // (recipient 'python', content_type 'code') nor its reasoning ('thoughts'/'reasoning_recap').
      // So a CSV produced with the analysis tool is the answer text, not the code that built it.
      const userFacing =
        role === 'assistant' &&
        recipient === 'all' &&
        (ctype === 'text' || ctype === 'multimodal_text');
      for (const p of (m.content && m.content.parts) || []) {
        if (p && p.content_type === 'image_asset_pointer' && p.asset_pointer)
          assets.push(String(p.asset_pointer));
        else if (typeof p === 'string' && p.trim()) {
          if (userFacing) said.assistant.push(p.trim());
          else if (role === 'tool') said.tool.push(p.trim());
        }
      }
    }
    const tail = last(after);
    const idle = d.async_status == null;
    return {
      assets,
      text: (said.assistant.length ? said.assistant : said.tool).join(' ').slice(0, 300),
      fullText: said.assistant.join('\n\n'),
      idle,
      finished:
        idle &&
        !!tail &&
        (tail.author && tail.author.role) !== 'user' &&
        (!tail.recipient || tail.recipient === 'all') &&
        tail.end_turn === true &&
        !['thoughts', 'reasoning_recap', 'code'].includes(
          tail.content && tail.content.content_type,
        ),
    };
  }

  // asset_pointer is 'sediment://file_…' (current) or 'file-service://file-…' (older).
  async function downloadAsset(cid, pointer) {
    const id = pointer.replace(/^[\w-]+:\/\//, '');
    const paths = [
      `/backend-api/files/download/${id}?conversation_id=${cid}&inline=false`,
      `/backend-api/files/${id}/download`,
      `/backend-api/conversation/${cid}/attachment/${id}/download`,
    ];
    let err = null;
    for (const p of paths) {
      let d;
      try {
        d = await apiGet(p);
      } catch (e) {
        if (e.status === 429) throw e; // rate-limited: do not hit the other endpoints too
        err = e;
        continue;
      }
      if (d && d.download_url) return fetchResult(d.download_url);
      err = new Error('không có download_url');
    }
    throw err;
  }
  // Same-origin links are fetched here with the page's cookies; a cross-origin one (e.g.
  // files.oaiusercontent.com) is CORS-blocked for a content script, so the service worker fetches it.
  async function fetchResult(link) {
    const url = new URL(link, location.origin);
    if (url.origin !== location.origin) return { imageUrl: url.href };
    const r = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw httpError(r);
    return blobToResult(await r.blob());
  }

  // ---- result bytes -------------------------------------------------------
  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  // Trust the bytes, not the Content-Type: an HTML challenge page must never be stored as a PNG.
  function sniffMime(b) {
    const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
    if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    return '';
  }
  async function blobToResult(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = sniffMime(bytes);
    if (!mime) throw new Error('tệp tải về không phải ảnh PNG/JPEG/WebP');
    return { base64: bytesToBase64(bytes), mime };
  }
  function canvasBlob(img) {
    return new Promise((resolve, reject) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('không đọc được ảnh'))), 'image/png');
    });
  }
  // A DOM image: blob: or same-origin src is read here (a revoked blob: is redrawn from the decoded
  // <img> on a canvas, which a same-origin image does not taint); cross-origin goes to the worker.
  async function imgToResult(img) {
    const src = srcOf(img);
    if (new URL(src, location.href).origin !== location.origin) return { imageUrl: src };
    try {
      const r = await fetch(src, { credentials: 'include', signal: AbortSignal.timeout(60000) });
      if (r.ok) return await blobToResult(await r.blob());
    } catch {}
    return blobToResult(await canvasBlob(img));
  }

  // ---- DOM fallback -------------------------------------------------------
  const RESULT_IMG =
    '[data-image-gen-result] img:not([aria-hidden="true"]), [data-testid="generated-image-preview"] img';
  const RESULT_SRC = /estuary\/content|files\/download|oaiusercontent|^blob:/;
  // The newest assistant turn, or null.
  function assistantTurn() {
    const turn = last([
      ...document.querySelectorAll('[data-testid^="conversation-turn-"][data-turn="assistant"]'),
    ]);
    if (turn) return turn;
    // 2026-09 layout: div[data-turn-key] holding an h4 "ChatGPT said" label. The thread is rendered
    // twice, so of the newest key's copies prefer one that shows a generated image.
    const keyed = [...document.querySelectorAll('[data-turn-key]')].filter(
      el =>
        !el.closest('[aria-hidden="true"]') &&
        el.querySelector('h4[data-conversation-role="assistant"]'),
    );
    const k = last(keyed);
    if (k) {
      const key = k.getAttribute('data-turn-key');
      const twins = keyed.filter(el => el.getAttribute('data-turn-key') === key);
      return twins.find(el => el.querySelector(RESULT_IMG)) || k;
    }
    // Legacy layout: the generated <img> sits beside, not inside, the role element.
    const role = last([...document.querySelectorAll('[data-message-author-role="assistant"]')]);
    if (role) return role.closest('[data-testid^="conversation-turn-"], article, section') || role;
    return null;
  }
  // Result-looking images of the newest assistant turn; anything inside a user turn or the composer
  // (the user's reference uploads) is excluded. Without a recognisable assistant turn the scope is
  // <main> (never document.body: a toast from another tab must not count), and there only the
  // explicit generated-image markers are trusted, not any upload-looking src.
  function domImages() {
    const turn = assistantTurn();
    const scope = turn || document.querySelector('main');
    if (!scope) return [];
    let imgs = [...scope.querySelectorAll(RESULT_IMG)];
    if (!imgs.length && turn)
      imgs = [...turn.querySelectorAll('img')].filter(i => RESULT_SRC.test(srcOf(i)));
    return imgs.filter(
      i => srcOf(i) && i.getAttribute('aria-hidden') !== 'true' && !i.closest(USER_TURN + ', form'),
    );
  }

  // Early exits that need a human. Each must hold on two polls in a row.
  function blocker() {
    for (const d of document.querySelectorAll('[role="dialog"]'))
      if (/too many requests|requests too quickly|quá nhiều yêu cầu/i.test(d.innerText || ''))
        return 'ChatGPT báo quá nhiều yêu cầu (giới hạn tốc độ) — đợi vài phút rồi chạy lại.';
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]'))
      return 'ChatGPT đòi xác minh Cloudflare — mở tab ChatGPT và xác minh thủ công.';
    if (document.querySelector(LOGIN))
      return 'ChatGPT đã đăng xuất — hãy đăng nhập lại trong tab này.';
    return '';
  }

  // Wait for this job's generated image, polling every 5 s. The backend is the source of truth and
  // the Stop button is never read as done or failed (images render after it disappears). It ends
  // early only on a clear signal: the reply finished without an image (two polls in a row, past
  // opt.refuseAfter), a rate-limit dialog, a Cloudflare challenge, or a login wall. The DOM is read
  // only while the API keeps failing (or the conversation id is unknown).
  async function waitForImage(job, opt) {
    const t0 = opt.collect ? Date.now() : job.sentAt;
    const skipSrc = new Set(opt.before);
    const skipAsset = new Set();
    const isRef = out => !!out.base64 && opt.refs.has(out.base64);
    let apiErrs = 0,
      dlErrs = 0,
      pauseUntil = 0,
      noImage = 0,
      noImageSince = 0,
      blocked = 0,
      lastErr = '',
      reply = '',
      asset = '',
      assetSince = 0,
      domSrc = '',
      domSince = 0,
      sendChecked = !!opt.collect;
    const backOff = e => {
      if (e.status === 429) pauseUntil = Date.now() + Math.max(30000, e.retryAfter || 0);
    };
    for (;;) {
      job.check();
      if (Date.now() - t0 > opt.timeout)
        throw jobError(opt.timeoutMsg + (lastErr ? ' [' + lastErr + ']' : ''), {
          replyText: reply,
        });
      const block = blocker();
      blocked = block ? blocked + 1 : 0;
      if (blocked >= 2) throw jobError(block, { replyText: reply });

      const cid = job.cid();
      // No conversation 30 s after sending: if the prompt still sits in the composer and no user
      // turn appeared, it never went out (safe to re-run).
      if (!cid && !sendChecked && Date.now() - t0 > 30000) {
        sendChecked = true;
        const ed = first(EDITOR);
        if (ed && (ed.value || ed.textContent || '').trim() && !document.querySelector(USER_TURN))
          throw jobError('Prompt chưa được gửi lên ChatGPT (nút gửi không phản hồi).', {
            sent: false,
          });
      }

      let phase = cid ? 'chờ ChatGPT vẽ' : 'chờ ChatGPT mở cuộc trò chuyện';
      let st = null;
      if (cid && Date.now() < pauseUntil) phase = 'ChatGPT giới hạn tốc độ, tạm ngừng hỏi';
      else if (cid) {
        try {
          st = await convState(cid);
          apiErrs = 0;
        } catch (e) {
          // 404 right after sending = the conversation is not saved yet: just poll again.
          apiErrs++;
          lastErr = 'API: ' + e.message;
          backOff(e);
          if (e.noSession && apiErrs >= 2)
            throw jobError('ChatGPT đã đăng xuất — hãy đăng nhập lại trong tab này.', {
              replyText: reply,
            });
          if (opt.collect && e.status === 404 && apiErrs >= 3)
            throw new Error(
              'Không tìm thấy cuộc trò chuyện ChatGPT (đã bị xoá hoặc thuộc tài khoản khác?)',
            );
        }
      }

      if (st) {
        if (st.text) reply = st.text;
        const a = last(st.assets.filter(x => !skipAsset.has(x))) || '';
        if (a !== asset) {
          asset = a;
          assetSince = Date.now();
        }
        const steady = Date.now() - assetSince;
        if (asset) {
          noImage = 0;
          noImageSince = 0;
          phase = 'ảnh sắp xong';
          // Settled = no background task left and the same pointer on two polls (or the turn is
          // finished). A pointer unchanged for 90 s is taken whatever the status fields say.
          if ((st.idle && (st.finished || steady >= POLL_MS - 1000)) || steady >= 90000) {
            job.say('đã có ảnh, đang tải');
            try {
              const out = await downloadAsset(cid, asset);
              if (!isRef(out)) return out;
              skipAsset.add(asset);
              lastErr = 'ảnh nhận được trùng ảnh tham chiếu';
            } catch (e) {
              dlErrs++;
              lastErr = 'tải ảnh: ' + e.message;
              backOff(e);
            }
          }
        } else if (st.finished && Date.now() - t0 > opt.refuseAfter) {
          // A finished turn without an image: a refusal, a quota message, or a verification step.
          // Language-independent; the reply text tells the user why. It must hold for 30 s (the
          // image task can still start after a reply that looked final).
          noImageSince = noImageSince || Date.now();
          if (++noImage >= 2 && Date.now() - noImageSince >= 30000)
            throw jobError(opt.noImageMsg + (reply ? ': "' + reply.slice(0, 120) + '"' : ''), {
              replyText: reply,
            });
          phase = 'ChatGPT đã trả lời, kiểm tra lại ảnh';
        } else {
          noImage = 0;
          noImageSince = 0;
          phase = st.idle ? 'ChatGPT đang trả lời' : 'ChatGPT đang vẽ ảnh';
        }
      }

      // DOM fallback: only a stable, fully loaded, big image of the newest assistant turn, the same
      // src for 10 s with nothing streaming. Any poll without it starts the 10 s over.
      if (!cid || apiErrs >= 3 || dlErrs >= 3) {
        const img = last(
          domImages().filter(i => !skipSrc.has(srcOf(i)) && i.complete && i.naturalWidth >= 512),
        );
        const src = img ? srcOf(img) : '';
        if (src !== domSrc) {
          domSrc = src;
          domSince = Date.now();
        }
        if (img) {
          phase = 'đã thấy ảnh trên trang, chờ ổn định';
          if (Date.now() - domSince >= 10000 && !isStreaming()) {
            try {
              const out = await imgToResult(img);
              if (!isRef(out)) return out;
              skipSrc.add(src);
              lastErr = 'ảnh trên trang trùng ảnh tham chiếu';
            } catch (e) {
              lastErr = 'đọc ảnh trên trang: ' + e.message;
            }
          }
        }
      } else domSrc = '';

      job.say(phase);
      await sleep(POLL_MS);
    }
  }
})();
