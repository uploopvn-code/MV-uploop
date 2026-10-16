// Entry point: loads every feature module, then fetches the first state and keeps it fresh.
import { esc, workflowProcessing } from './core.js';
import { initGuide } from './guide.js';
import { refreshOrbit, refreshSeedvis, refreshWorkerInfo } from './providers.js';
import { listenForChanges, pollState, refresh } from './render.js';
import './zones.js';
import './cards.js';
import './canvas.js';
import './inspector.js';
import './edit-image.js';
import './projects.js';
import './gallery.js';
import './jobs.js';
import './add-nodes.js';
import './wardrobe.js';
import './director.js';
import './auto.js';
import './seedance.js';
import './merged.js';
import './commands.js';
import { initI18n } from './i18n.js';
const ui = (key, fallback) => globalThis.mvT?.(key) || fallback;

initI18n().catch(() => {});
refreshSeedvis().catch(() => {});
refreshWorkerInfo().catch(() => {});
try {
  await refresh();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const fit = document.getElementById('fitCanvas');
      if (fit) fit.click();
    }),
  );
} catch (e) {
  // Don't leave a blank page: show what went wrong and how to recover.
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div style="position:fixed;inset:0;z-index:9999;background:#1a1410;color:#fde68a;padding:24px;font:14px system-ui;overflow:auto">' +
      '<h2 style="color:#fbbf24">' +
      ui('main.loadFailed', 'Không tải được dữ liệu') +
      '</h2>' +
      '<p>' +
      esc(e.message) +
      '</p><p>' +
      ui(
        'main.loadFailedHelp',
        'Thử: nhấn Ctrl+F5 để tải lại. Nếu vẫn lỗi, chụp màn hình cửa sổ chạy server để được hỗ trợ.',
      ) +
      '</p>' +
      '<button onclick="location.reload()" style="padding:8px 16px;margin-top:8px;cursor:pointer">' +
      ui('main.reload', 'Tải lại') +
      '</button>' +
      '</div>',
  );
}
// Changes arrive on the push channel, so the poll is only a safety net for an event that went
// missing — except while a job is live: its progress line ("đang dựng… 60s") keeps changing without
// an event of its own, and that is worth the fast tick.
const pushChannel = listenForChanges();
const tick = async () => {
  await pollState();
  setTimeout(tick, !pushChannel || workflowProcessing() ? 4000 : 20000);
};
setTimeout(tick, 4000);
await refreshOrbit();
// Hướng dẫn sử dụng: tự hiện lần đầu vào tool, sau đó mở bằng nút ？ Hướng dẫn.
initGuide();
