// Entry point: loads every feature module, then fetches the first state and keeps it fresh.
import { esc } from './core.js';
import { refreshOrbit, refreshSeedvis, refreshWorkerInfo } from './providers.js';
import { refresh } from './render.js';
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

refreshSeedvis().catch(() => {});
refreshWorkerInfo().catch(() => {});
try {
  await refresh();
} catch (e) {
  // Don't leave a blank page: show what went wrong and how to recover.
  document.body.insertAdjacentHTML(
    'afterbegin',
    '<div style="position:fixed;inset:0;z-index:9999;background:#1a1410;color:#fde68a;padding:24px;font:14px system-ui;overflow:auto">' +
      '<h2 style="color:#fbbf24">Không tải được dữ liệu</h2>' +
      '<p>' +
      esc(e.message) +
      '</p><p>Thử: nhấn <b>Ctrl+F5</b> để tải lại. Nếu vẫn lỗi, chụp màn hình cửa sổ chạy server (dòng “Lỗi xử lý …”) để được hỗ trợ.</p>' +
      '<button onclick="location.reload()" style="padding:8px 16px;margin-top:8px;cursor:pointer">Tải lại</button>' +
      '</div>',
  );
}
setInterval(() => refresh().catch(() => {}), 4000);
await refreshOrbit();
