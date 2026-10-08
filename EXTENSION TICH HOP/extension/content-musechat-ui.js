// Shared Muse DOM adapter. No framework internals or private API endpoints.
(function () {
  const ui = window.__dramaMuseChatUi = {
    visible(el) {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    },
    enabled(el) { return !el.disabled && el.getAttribute('aria-disabled') !== 'true'; },
    label(el) {
      return ['aria-label', 'title', 'placeholder', 'data-testid', 'data-icon'].map(k => el.getAttribute(k) || '')
        .concat(el.innerText || el.textContent || '', typeof el.className === 'string' ? el.className : '').join(' ');
    },
    value(el) { return el.isContentEditable ? (el.innerText || el.textContent || '') : el.value || ''; },
    composer(includeDisabled = false) {
      const candidates = [...document.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], input[type="text"]')]
        .filter(el => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) &&
          ui.visible(el) && (includeDisabled || (!el.disabled && !el.readOnly)) && !/search|tìm kiếm/i.test(ui.label(el)));
      candidates.sort((a, b) => {
        const score = el => (el.tagName === 'TEXTAREA' || el.isContentEditable ? 20 : 0) +
          (/message|chat|ask|prompt|nhắn/i.test(ui.label(el)) ? 40 : 0) +
          (el.closest('[role="dialog"]') ? 80 : 0) + el.getBoundingClientRect().top / Math.max(1, innerHeight);
        return score(b) - score(a);
      });
      return candidates[0] || null;
    },
    scope(input) {
      const explicit = input.closest('[data-chat-id], .chat-container, .chat-panel, .side-chat, [role="dialog"], main, aside');
      if (explicit) return explicit;
      // A form is just the composer, not the transcript. Walk out far enough to
      // include its siblings, but never use the whole page as a conversation.
      const form = input.closest('form');
      if (form) return form.parentElement;
      let region = input.parentElement;
      for (let i = 0; i < 4 && region?.parentElement && region.parentElement !== document.body; i++) {
        if (region.querySelector('[role="log"], [data-message-id], [data-message-author-role], video')) break;
        region = region.parentElement;
      }
      return region || input.parentElement;
    },
    controls(input) {
      const scope = ui.scope(input);
      let node = input.parentElement;
      for (let i = 0; node && i < 6; i++, node = node.parentElement) {
        if (node.querySelector('button, [role="button"], input[type="submit"]') || node === scope) return node;
      }
      return scope;
    },
    busy(input) {
      return [...ui.controls(input).querySelectorAll('[role="progressbar"], [aria-busy="true"], [data-uploading="true"]')].some(ui.visible);
    },
    attachmentTokens(input) {
      const region = ui.scope(input), tokens = new Set();
      for (const el of region.querySelectorAll('img, [style*="background"], button, [role="button"], [data-attachment-id]')) {
        if (!ui.visible(el)) continue;
        if (el.tagName === 'IMG' && el.src) tokens.add('image:' + el.src);
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none' && /url\(/.test(bg)) tokens.add('background:' + bg);
        if (/remove.*(image|attach|file)|delete.*(image|attach|file)|xóa.*(ảnh|tệp)/i.test(ui.label(el))) tokens.add(el);
        if (el.hasAttribute('data-attachment-id')) tokens.add('attachment:' + el.getAttribute('data-attachment-id'));
      }
      return tokens;
    },
    sendControl(input) {
      const scope = ui.scope(input), r = input.getBoundingClientRect();
      const buttons = [...scope.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(ui.visible);
      const excluded = /stop|cancel|upload|attach|new.*chat|remove|delete|microphone|voice|menu|model|settings|close|add.*file|dừng|hủy|đính kèm|xóa/i;
      const explicit = buttons.filter(el => !excluded.test(ui.label(el)) && (
        /\bsend\b|send[-_ ]?(message|button)|gửi|submit|paper[-_ ]?plane|arrow[-_ ]?up/i.test(ui.label(el)) ||
        el.getAttribute('type') === 'submit' ||
        el.querySelector('[data-lucide="send"], .lucide-send, .lucide-send-horizontal, .lucide-arrow-up, [data-icon="paper-plane"], [data-icon="arrow-up"], svg title')?.textContent?.match(/send|gửi|arrow.?up/i) ||
        el.querySelector('.lucide-send, .lucide-send-horizontal, .lucide-arrow-up, [data-icon="paper-plane"], [data-icon="arrow-up"]')));
      const distance = el => { const b = el.getBoundingClientRect(); return Math.abs(b.right - r.right) + Math.abs(b.bottom - r.bottom); };
      explicit.sort((a, b) => distance(a) - distance(b));
      // Disabled send means uploading/generating: never bypass it with Enter.
      if (explicit.length) return { button: explicit[0], disabled: !ui.enabled(explicit[0]) };
      const near = buttons.filter(el => {
        if (excluded.test(ui.label(el)) || !el.querySelector('svg') || (el.textContent || '').trim() === '+') return false;
        const b = el.getBoundingClientRect();
        return b.left >= r.right - 72 && b.left <= r.right + 96 && b.top >= r.top - 12 && b.top <= r.bottom + 64 && b.width <= 80 && b.height <= 80;
      });
      // Unique icon on the right edge of the editor is the conventional send control.
      // Multiple candidates are ambiguous; let the editor handle Enter instead.
      if (near.length === 1) return { button: near[0], disabled: !ui.enabled(near[0]) };
      return null;
    },
    hasMessage(input, prompt) {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
      const region = ui.scope(input), copy = region.cloneNode(true);
      copy.querySelectorAll('textarea, input, [contenteditable], [data-drama-muse-status]').forEach(el => el.remove());
      return norm(copy.textContent).includes(norm(prompt));
    },
    status(text, error = false) {
      window.__dramaMuseChatStage = text;
      let box = document.querySelector('[data-drama-muse-status]');
      if (!box) {
        box = document.createElement('div'); box.setAttribute('data-drama-muse-status', '');
        box.setAttribute('role', 'status');
        box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:420px;padding:10px 14px;border-radius:8px;background:#172536;color:white;font:13px/1.5 sans-serif;box-shadow:0 2px 12px #0004;pointer-events:none';
        document.documentElement.appendChild(box);
      }
      box.textContent = 'Drama Tool · ' + text;
      box.style.background = error ? '#842828' : '#172536';
    },
  };
})();
