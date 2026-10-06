// Drama Tool ChatGPT worker — content script (runs inside chatgpt.com).
//
// The service worker drives this over a Port: it sends { cmd:'generate', prompt, images } and
// gets progress messages then a final { done:true, imageUrl|base64|error }. This file only does
// DOM work: start a fresh chat, type the prompt, attach reference images, send, and wait for the
// generated image. ChatGPT's DOM changes often, so every lookup has fallbacks and clear errors.

(() => {
  if (window.__dramaChatGPTWorker) return;
  window.__dramaChatGPTWorker = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const first = sels => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  async function waitFor(fn, timeout, msg) {
    const end = Date.now() + timeout;
    for (;;) {
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

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'ping') sendResponse({ ready: true, href: location.href });
  });

  chrome.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith('job:')) return;
    const say = p => {
      try {
        port.postMessage({ progress: p });
      } catch {}
    };
    port.onMessage.addListener(async msg => {
      try {
        if (msg.cmd === 'generate')
          port.postMessage({ done: true, ...(await runGeneration(msg, say)) });
        else if (msg.cmd === 'ask') port.postMessage({ done: true, ...(await runAsk(msg, say)) });
      } catch (e) {
        port.postMessage({ done: true, error: e.message || String(e) });
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
  const STOP = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Dừng" i]',
  ];
  const NEWCHAT = [
    'a[data-testid="create-new-chat-button"]',
    'button[data-testid="create-new-chat-button"]',
    'button[aria-label*="New chat" i]',
    'a[aria-label*="New chat" i]',
  ];

  // ---- steps --------------------------------------------------------------
  async function runGeneration({ prompt, images }, say) {
    await ensureLoggedIn();
    await newChatIfNeeded(say);
    const editor = await waitFor(() => first(EDITOR), 20000, 'Không thấy ô nhập của ChatGPT');

    if (images && images.length) {
      say('đính ' + images.length + ' ảnh');
      await attachImages(images, editor);
      await waitUploadsReady();
    }

    say('nhập prompt');
    await setEditorText(editor, prompt);
    await sleep(250);

    say('gửi');
    const before = new Set(resultImages().map(i => i.currentSrc || i.src));
    await clickSend(editor);

    say('chờ ChatGPT vẽ…');
    const img = await waitForGeneratedImage(before, 240000, say);
    const src = img.currentSrc || img.src;
    if (src.startsWith('blob:')) {
      const blob = await (await fetch(src)).blob();
      return await blobToBase64(blob);
    }
    return { imageUrl: src };
  }

  // The Director agent: type a prompt, wait for the reply, scrape its text. No images.
  async function runAsk({ prompt }, say) {
    await ensureLoggedIn();
    await newChatIfNeeded(say);
    const editor = await waitFor(() => first(EDITOR), 20000, 'Không thấy ô nhập của ChatGPT');
    say('nhập prompt');
    await setEditorText(editor, prompt);
    await sleep(250);
    // Remember what was on screen before sending, to tell the new reply apart from it.
    const before = { text: replyText() };
    say('gửi');
    await clickSend(editor);
    say('chờ ChatGPT trả lời…');
    const text = await waitForReply(before, 240000);
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
  const replyCount = () => document.querySelectorAll(REPLY_SELS[0]).length;
  // The new build has no stable Stop button, so completion is judged by the reply text holding
  // steady for ~2.8s after it has appeared and differs from whatever was on screen before sending
  // (a fresh chat starts empty). Returns partial text on timeout rather than nothing.
  async function waitForReply(before, timeout) {
    const t0 = Date.now();
    let last = '',
      stableSince = 0,
      grew = false;
    const isNew = t => !!t && t !== before.text;
    while (Date.now() - t0 < timeout) {
      const t = replyText();
      if (isNew(t)) {
        grew = true;
        if (t === last) {
          if (!stableSince) stableSince = Date.now();
          else if (Date.now() - stableSince > 2800) return t; // stopped growing → done
        } else {
          last = t;
          stableSince = 0;
        }
      }
      await sleep(500);
    }
    if (grew && last) return last; // timed out mid-answer: hand back what we have
    throw new Error(
      `ChatGPT không trả lời (đang tạo, bị từ chối, hoặc giao diện đã đổi). [khối trả lời: ${replyCount()}]`,
    );
  }

  async function ensureLoggedIn() {
    // The composer only exists when signed in; a login wall has none.
    const el = first(EDITOR);
    if (el) return;
    await sleep(1500);
    if (!first(EDITOR))
      throw new Error('Chưa đăng nhập ChatGPT hoặc trang chưa tải. Hãy đăng nhập trong tab này.');
  }

  async function newChatIfNeeded(say) {
    if (!document.querySelector('[data-message-author-role]')) return; // already an empty chat
    say('mở cuộc trò chuyện mới');
    const btn = first(NEWCHAT);
    if (btn) {
      btn.click();
      await sleep(800);
    } else if (location.pathname !== '/') {
      location.assign('/');
      await sleep(1500);
    }
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }
  async function setEditorText(editor, text) {
    editor.focus();
    if (editor.tagName === 'TEXTAREA') {
      setNativeValue(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // contenteditable (ProseMirror): clear then insert as a typed input so the editor updates.
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } catch {}
    if (!editor.textContent.trim()) {
      // Fallback: paste the text.
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }
    await sleep(100);
    if (!editor.textContent.trim()) throw new Error('Không nhập được prompt vào ô ChatGPT');
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
    // Preferred path: the hidden <input type=file> ChatGPT uses for uploads.
    const input = [...document.querySelectorAll('input[type="file"]')].find(
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
  async function waitUploadsReady() {
    // Give uploads a moment, then wait until the send button is enabled (uploads disable it).
    await sleep(600);
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      const btn = first(SEND);
      const uploading = document.querySelector(
        'main [role="progressbar"], main [class*="uploading" i]',
      );
      if (btn && !btn.disabled && !uploading) return;
      await sleep(400);
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

  // Images inside the latest assistant turn (falls back to <main>), big enough to be a result.
  function resultImages() {
    const turns = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const scope = turns.length
      ? turns[turns.length - 1]
      : document.querySelector('main') || document.body;
    return [...scope.querySelectorAll('img')].filter(img => {
      const src = img.currentSrc || img.src || '';
      if (!src || src.startsWith('data:')) return false;
      const w = img.naturalWidth || img.width || 0;
      if (w && w < 200) return false; // skip avatars / icons
      return /oaiusercontent|\/backend-api\/|\/files\/|blob:/.test(src) || w >= 256;
    });
  }
  async function waitForGeneratedImage(beforeSrcs, timeout, say) {
    const end = Date.now() + timeout;
    let lastSrc = '';
    let stableSince = 0;
    let sawStop = false;
    while (Date.now() < end) {
      const stopping = !!first(STOP);
      if (stopping) sawStop = true;
      const candidate = resultImages()
        .map(img => ({ img, src: img.currentSrc || img.src }))
        .filter(x => !beforeSrcs.has(x.src))
        .pop();
      if (candidate) {
        if (candidate.src === lastSrc) {
          // src held steady and generation is no longer streaming → done.
          if (!stopping && Date.now() - stableSince > 1500) return candidate.img;
        } else {
          lastSrc = candidate.src;
          stableSince = Date.now();
          say('đã có ảnh, chờ hoàn tất…');
        }
      } else if (sawStop && !stopping) {
        // Streaming finished but produced no image: a refusal or a verification step.
        await sleep(1500);
        if (!resultImages().some(img => !beforeSrcs.has(img.currentSrc || img.src)))
          throw new Error('ChatGPT không trả ảnh (có thể bị từ chối hoặc cần xác minh thủ công).');
      }
      await sleep(700);
    }
    throw new Error('Quá thời gian chờ ChatGPT tạo ảnh');
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result);
        resolve({ base64: s.slice(s.indexOf(',') + 1), mime: blob.type || 'image/png' });
      };
      fr.onerror = () => reject(new Error('Không đọc được ảnh kết quả'));
      fr.readAsDataURL(blob);
    });
  }
})();
