// Video gallery tab: pick, download and delete produced clips.
import { store } from './store.js';
import { $, api, dlUrl, downloadName, esc, paint, toast, triggerDownload } from './core.js';
import { render } from './render.js';

export const gallerySel = new Set();
// Every node that holds a video, grouped by its source node.
function videoGroups() {
  const items = store.state.nodes.filter(n => n.video);
  const groups = new Map();
  for (const n of items) {
    const src = n.terminal ? store.state.nodes.find(x => x.id === n.source) : null;
    const key = n.terminal ? n.source || n.id : n.id;
    const seq = n.terminal ? (src?.seq ?? n.sourceSeq) : n.seq;
    const name = n.terminal ? src?.name || n.sourceName || '(nguồn đã xóa)' : n.name;
    if (!groups.has(key)) groups.set(key, { key, seq: seq || 0, name, items: [] });
    groups.get(key).items.push(n);
  }
  return [...groups.values()].sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
}
export function renderGallery() {
  const groups = videoGroups();
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  $('#videoCount').textContent = total;
  for (const id of [...gallerySel])
    if (!store.state.nodes.some(n => n.id === id && n.video)) gallerySel.delete(id);
  paint(
    '#galleryBody',
    total
      ? groups
          .map(
            g =>
              `<div class="gallery-group"><h3>${g.seq ? '#' + g.seq + ' ' : ''}${esc(g.name)} <small>${g.items.length} video</small></h3><div class="gallery-grid">${g.items
                .map(
                  n =>
                    `<div class="gallery-item ${gallerySel.has(n.id) ? 'sel' : ''}" data-node="${n.id}"><label class="pick" title="Chọn"><input type="checkbox" data-pick="${n.id}" ${gallerySel.has(n.id) ? 'checked' : ''}></label><div class="preview video"><video muted playsinline preload="metadata" src="${esc(n.video.url)}"></video><span class="play-badge">▶</span></div><div class="gallery-meta"><strong>${esc(n.terminal ? 'v' + (n.version || 1) : n.name)}</strong><a class="text-button" href="${esc(dlUrl(n.video.url, downloadName(n)))}" download="${esc(downloadName(n))}" data-dl>↓ ${esc(downloadName(n))}</a></div></div>`,
                )
                .join('')}</div></div>`,
          )
          .join('')
      : '<div class="empty">Chưa có video nào. Tạo video ở một node, hoặc dùng ▶ Tự động tạo video.</div>',
  );
  $('#galleryBar').hidden = !total;
  $('#gallerySelected').textContent = 'Đã chọn ' + gallerySel.size;
  // Checkbox toggles selection; download link must not open the viewer.
  document.querySelectorAll('[data-pick]').forEach(
    e =>
      (e.onclick = ev => {
        ev.stopPropagation();
        if (e.checked) gallerySel.add(e.dataset.pick);
        else gallerySel.delete(e.dataset.pick);
        renderGallery();
      }),
  );
  document
    .querySelectorAll('#galleryBody [data-dl]')
    .forEach(e => (e.onclick = ev => ev.stopPropagation()));
}
$('#gallerySelectAll').onclick = () => {
  for (const g of videoGroups()) for (const n of g.items) gallerySel.add(n.id);
  renderGallery();
};
$('#galleryClear').onclick = () => {
  gallerySel.clear();
  renderGallery();
};
$('#galleryDownload').onclick = async () => {
  const picked = store.state.nodes.filter(n => gallerySel.has(n.id) && n.video);
  if (!picked.length) return toast('Chưa chọn video nào', true);
  // One video: download it directly. Several: package them into one ZIP named by shot.
  if (picked.length === 1) {
    triggerDownload(picked[0].video.url, downloadName(picked[0]));
    return toast('Đang tải video');
  }
  const btn = $('#galleryDownload');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Đang nén…';
  try {
    const r = await fetch('/api/videos/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: picked.map(n => n.id) }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Nén thất bại');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; // a blob URL already carries the right filename via the download attribute
    a.download = (store.state.name || 'videos').replace(/[^\w.\- ]+/g, '_') + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Đã nén ' + picked.length + ' video thành ZIP');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
};
$('#galleryDelete').onclick = async () => {
  const picked = store.state.nodes.filter(n => gallerySel.has(n.id) && n.terminal);
  const skipped = [...gallerySel].length - picked.length;
  if (!picked.length) return toast('Chỉ xóa được node phiên bản video đã chọn', true);
  if (!confirm('Xóa ' + picked.length + ' node phiên bản video đã chọn?')) return;
  try {
    for (const n of picked) {
      store.state = await api('/api/nodes/delete', { method: 'POST', body: { id: n.id } });
      gallerySel.delete(n.id);
    }
    render();
    toast(
      'Đã xóa ' +
        picked.length +
        ' video' +
        (skipped ? ' (bỏ qua ' + skipped + ' không phải node phiên bản)' : ''),
    );
  } catch (e) {
    toast(e.message, true);
  }
};
