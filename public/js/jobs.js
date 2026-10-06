// Job queue tab.
import { store } from './store.js';
import { $, api, dlUrl, esc, paint, toast } from './core.js';
import { refresh } from './render.js';

export function renderJobs() {
  paint(
    '#jobs',
    store.state.jobs.length
      ? [...store.state.jobs]
          .reverse()
          .map(
            j =>
              `<div class="job-row"><div><strong>${esc(store.state.nodes.find(n => n.id === j.nodeId)?.name)} · ${j.kind === 'image' ? 'Tạo ảnh' : 'Tạo video'}</strong><p>${esc(j.payload.website)} · ${new Date(j.createdAt).toLocaleString('vi-VN')}</p>${j.progress ? `<p>${esc(j.progress)}</p>` : ''}${j.error ? `<p>${esc(j.error)}</p>` : ''}${j.warning ? `<p>${esc(j.warning)}</p>` : ''}${j.resultStale ? '<p>Đầu vào đã thay đổi trong khi chạy: cần duyệt lại kết quả.</p>' : ''}</div><span class="badge">${esc({ queued: 'Đang chờ', running: 'Đang chạy', script_completed: 'Kịch bản đã xong', completed: 'Hoàn tất', failed: 'Lỗi', retried: 'Lỗi · đã tự chạy lại', needs_review: 'Cần kiểm tra', cancelled: 'Đã hủy' }[j.status])}</span>${j.status === 'queued' ? `<button class="button" data-cancel="${j.id}">Hủy chờ</button>` : ['needs_review', 'script_completed'].includes(j.status) && (j.payload.output || j.payload.seedvis) ? `<button class="button" data-collect="${j.id}">${j.payload.seedvis ? 'Kiểm tra lại' : 'Nhận file'}</button>` : j.result ? `<a class="button" href="${esc(dlUrl(j.result.url, j.result.name || 'ket-qua'))}" download="${esc(j.result.name || 'ket-qua')}">Tải kết quả</a>` : '<span></span>'}</div>`,
          )
          .join('')
      : '<div class="empty">Chưa có tác vụ. Chọn một node và nhấn “Tạo ảnh”.</div>',
  );
  document.querySelectorAll('[data-collect]').forEach(
    e =>
      (e.onclick = async () => {
        e.disabled = true;
        try {
          await api('/api/jobs/collect', { method: 'POST', body: { id: e.dataset.collect } });
          await refresh();
          toast(
            store.state.jobs.find(j => j.id === e.dataset.collect)?.payload.seedvis
              ? 'Đang đọc lại trạng thái Seedvis'
              : 'Đã nhận file',
          );
        } catch (err) {
          toast(err.message, true);
        } finally {
          e.disabled = false;
        }
      }),
  );
  document.querySelectorAll('[data-cancel]').forEach(
    e =>
      (e.onclick = async () => {
        try {
          await api('/api/jobs/cancel', { method: 'POST', body: { id: e.dataset.cancel } });
          await refresh();
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}
