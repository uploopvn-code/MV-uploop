// Job queue tab.
import { store } from './store.js';
import { $, api, dlUrl, esc, paint, toast } from './core.js';
import { refresh } from './render.js';

// A ChatGPT (extension) image job.
const chatgptImage = j => j.kind === 'image' && j.payload.site === 'chatgpt';
// A ChatGPT image not back yet: where it is, what the tool does next, what ChatGPT answered.
function webNotes(j) {
  const reply = j.web?.replyText
    ? `<p>ChatGPT trả lời: ${esc(j.web.replyText.slice(0, 300))}</p>`
    : '';
  if (!chatgptImage(j) || j.status !== 'needs_review') return reply;
  const url = j.web?.conversationUrl;
  return url
    ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">Mở ChatGPT</a>${j.recoverAt ? ` · Tự lấy lại ảnh lúc ${new Date(j.recoverAt).toLocaleTimeString('vi-VN')}` : ''}</p>${reply}`
    : `<p>Không có link cuộc trò chuyện ChatGPT: tải ảnh từ ChatGPT rồi dùng "↑ Tải ảnh" ở node.</p>${reply}`;
}
// The job's one action: stop waiting, fetch or check its result again, or download it.
function action(j) {
  if (j.status === 'queued') return `<button class="button" data-cancel="${j.id}">Hủy chờ</button>`;
  if (j.status === 'needs_review' && chatgptImage(j) && j.web?.conversationUrl)
    return `<button class="button" data-collect="${j.id}">Lấy lại ảnh</button>`;
  if (
    ['needs_review', 'script_completed'].includes(j.status) &&
    (j.payload.output || j.payload.seedvis)
  )
    return `<button class="button" data-collect="${j.id}">${j.payload.seedvis ? 'Kiểm tra lại' : 'Nhận file'}</button>`;
  if (j.result)
    return `<a class="button" href="${esc(dlUrl(j.result.url, j.result.name || 'ket-qua'))}" download="${esc(j.result.name || 'ket-qua')}">Tải kết quả</a>`;
  return '<span></span>';
}

export function renderJobs() {
  paint(
    '#jobs',
    store.state.jobs.length
      ? [...store.state.jobs]
          .reverse()
          .map(
            j =>
              `<div class="job-row"><div><strong>${esc(store.state.nodes.find(n => n.id === j.nodeId)?.name)} · ${j.kind === 'image' ? 'Tạo ảnh' : 'Tạo video'}</strong><p>${esc(j.payload.website)} · ${new Date(j.createdAt).toLocaleString('vi-VN')}</p>${j.progress ? `<p>${esc(j.progress)}</p>` : ''}${j.error ? `<p>${esc(j.error)}</p>` : ''}${j.warning ? `<p>${esc(j.warning)}</p>` : ''}${j.resultStale ? '<p>Đầu vào đã thay đổi trong khi chạy: cần duyệt lại kết quả.</p>' : ''}${webNotes(j)}</div><span class="badge">${esc({ queued: 'Đang chờ', running: 'Đang chạy', script_completed: 'Kịch bản đã xong', completed: 'Hoàn tất', failed: 'Lỗi', retried: 'Lỗi · đã tự chạy lại', needs_review: 'Cần kiểm tra', cancelled: 'Đã hủy' }[j.status])}</span>${action(j)}</div>`,
          )
          .join('')
      : '<div class="empty">Chưa có tác vụ. Chọn một node và nhấn “Tạo ảnh”.</div>',
  );
  document.querySelectorAll('[data-collect]').forEach(
    e =>
      (e.onclick = async () => {
        e.disabled = true;
        const j = store.state.jobs.find(j => j.id === e.dataset.collect);
        try {
          await api('/api/jobs/collect', { method: 'POST', body: { id: e.dataset.collect } });
          await refresh();
          toast(
            j?.payload.seedvis
              ? 'Đang đọc lại trạng thái Seedvis'
              : j && chatgptImage(j)
                ? 'Đang nhờ extension lấy lại ảnh từ ChatGPT (không tạo lại)'
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
