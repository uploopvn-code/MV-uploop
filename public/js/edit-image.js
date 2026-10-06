// Edit image: send the node's current image with "change only this", swap back.
import { store } from './store.js';
import { $, api, toast } from './core.js';
import { closeInspector, inspect, saveNode } from './inspector.js';
import { refresh, render } from './render.js';

// "Change only this" on the node's current image: the picture itself is sent with the request
// and the answer replaces it. The previous image is kept for a one-click swap back.
export function editPanel(n) {
  if (!n.image || n.terminal || n.kind === 'setting') return '';
  // Edit runs through Seedvis or the ChatGPT extension (not Orbit). The label names the source.
  const type = n.providers?.image?.type;
  const canEdit = type === 'seedvis' || type === 'web';
  const label = type === 'web' ? 'Sửa ảnh · ChatGPT' : 'Sửa ảnh · Seedvis';
  return (
    '<section class="edit-image"><label>✏️ Sửa ảnh này' +
    '<textarea id="editPrompt" rows="2" placeholder="Viết điều cần đổi, tiếng Anh cho kết quả tốt nhất — vd: make the sky darker, remove the umbrella on the left, close her mouth"></textarea></label>' +
    '<p class="field-hint">Gửi đúng ảnh đang có kèm yêu cầu; ảnh mới tự thay vào node, ảnh cũ được giữ để đổi lại.' +
    (type === 'web' ? ' Qua ChatGPT cần bật worker extension.' : '') +
    '</p>' +
    '<div class="actions">' +
    (n.prevImage
      ? '<button type="button" class="button" id="swapImage" title="Đổi qua lại giữa ảnh hiện tại và ảnh trước">↶ Đổi về ảnh trước</button>'
      : '') +
    `<button type="button" class="button primary" id="editImage" ${canEdit ? '' : 'disabled title="Chuyển nguồn tạo ảnh của node sang Seedvis hoặc ChatGPT (extension) để sửa ảnh"'}>${label}</button>` +
    '</div></section>'
  );
}
export async function editImage(id) {
  const text = $('#editPrompt').value.trim();
  if (!text) return toast('Nhập điều cần sửa trong ảnh', true);
  try {
    await saveNode();
    await api('/api/jobs', { method: 'POST', body: { nodeId: id, kind: 'image', edit: text } });
    await refresh();
    toast('Đã gửi sửa ảnh — ảnh mới sẽ tự thay vào node');
    closeInspector();
  } catch (e) {
    toast(e.message, true);
  }
}
export async function swapImage(id) {
  const draft = $('#editPrompt')?.value || '';
  try {
    await saveNode(); // the inspector is rebuilt below: keep what was typed
    store.state = await api('/api/node/swap-image', { method: 'POST', body: { id } });
    render();
    inspect(id);
    if ($('#editPrompt')) $('#editPrompt').value = draft;
    toast('Đã đổi ảnh');
  } catch (e) {
    toast(e.message, true);
  }
}
