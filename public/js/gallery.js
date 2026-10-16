// Video gallery tab: pick, download and delete produced clips.
import { store } from './store.js';
import { $, api, dlUrl, downloadName, esc, paint, toast, triggerDownload } from './core.js';
import { render } from './render.js';
import { nodeStream, nodeTime, streamLabel } from './zones.js';
import { t } from './i18n.js';

export const gallerySel = new Set();
// Every node that holds a video, grouped by its source node. Both streams end up here and their
// numbers restart per column (⑥ #1 and ⑪ #1 both exist), so a group is labelled with its stream
// and the lists are ordered by the second of the song they play at — the order they are edited in.
function videoGroups() {
  const search = ($('#gallerySearch')?.value || '').toLowerCase();
  const provider = $('#galleryProvider')?.value || '';
  const zone = $('#galleryZone')?.value || '';
  const items = store.state.nodes.filter(n => {
    if (!n.video) return false;
    const source = n.terminal ? store.state.nodes.find(x => x.id === n.source) : n;
    const hay = `${n.name || ''} ${source?.name || ''}`.toLowerCase();
    return (!search || hay.includes(search)) && (!provider || n.providers?.video?.type === provider || source?.providers?.video?.type === provider) && (!zone || source?.zone === zone);
  });
  const groups = new Map();
  for (const n of items) {
    const src = n.terminal ? store.state.nodes.find(x => x.id === n.source) : null;
    const key = n.terminal ? n.source || n.id : n.id;
    const of = src || n; // the shot / take the clips came from
    const seq = n.terminal ? (src?.seq ?? n.sourceSeq) : n.seq;
    const name = n.terminal ? src?.name || n.sourceName || t('gallery.sourceDeleted') : n.name;
    if (!groups.has(key))
      groups.set(key, {
        key,
        seq: seq || 0,
        name,
        stream: nodeStream(of),
        at: nodeTime(of)?.[0] ?? Infinity,
        items: [],
      });
    groups.get(key).items.push(n);
  }
  const rank = g => ({ A: 0, B: 1 })[g.stream] ?? 2; // luồng A, luồng B, then Seedance / assets
  return [...groups.values()].sort(
    (a, b) => rank(a) - rank(b) || a.at - b.at || a.seq - b.seq || a.name.localeCompare(b.name),
  );
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
              `<div class="gallery-group"><h3>${g.stream ? esc(streamLabel(g.stream)) + ' · ' : ''}${g.seq ? '#' + g.seq + ' ' : ''}${esc(g.name)} <small>${g.items.length} ${esc(t('gallery.video'))}${Number.isFinite(g.at) ? ' · ' + esc(t('gallery.fromSecond')) + ' ' + g.at.toFixed(2) : ''}</small></h3><div class="gallery-grid">${g.items
                .map(
                  n =>
                    `<div class="gallery-item ${gallerySel.has(n.id) ? 'sel' : ''}" data-node="${n.id}"><label class="pick" title="${esc(t('gallery.select'))}"><input type="checkbox" data-pick="${n.id}" ${gallerySel.has(n.id) ? 'checked' : ''}></label><div class="preview video"><video muted playsinline preload="metadata" src="${esc(n.video.url)}"></video><span class="play-badge">▶</span></div><div class="gallery-meta"><strong>${esc(n.terminal ? 'v' + (n.version || 1) : n.name)}</strong><a class="text-button" title="${esc(t('gallery.downloadOne'))}" href="${esc(dlUrl(n.video.url, downloadName(n)))}" download="${esc(downloadName(n))}" data-dl>↓ ${esc(downloadName(n))}</a></div></div>`,
                )
                .join('')}</div></div>`,
          )
          .join('')
      : `<div class="empty">${esc(t('gallery.empty'))}</div>`,
  );
  $('#galleryBar').hidden = !total;
  $('#gallerySelected').textContent = `${t('gallery.selected')} ${gallerySel.size}`;
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
document.addEventListener('localechange', () => {
  if (store.state) renderGallery();
});
$('#gallerySelectAll').onclick = () => {
  for (const g of videoGroups()) for (const n of g.items) gallerySel.add(n.id);
  renderGallery();
};
$('#galleryClear').onclick = () => {
  gallerySel.clear();
  renderGallery();
};
['gallerySearch', 'galleryProvider', 'galleryZone'].forEach(id =>
  document.getElementById(id)?.addEventListener('input', renderGallery),
);
$('#galleryDownload').onclick = async () => {
  const picked = store.state.nodes.filter(n => gallerySel.has(n.id) && n.video);
  if (!picked.length) return toast(t('gallery.noSelection'), true);
  // One video: download it directly. Several: package them into one ZIP named by shot.
  if (picked.length === 1) {
    triggerDownload(picked[0].video.url, downloadName(picked[0]));
    return toast(t('gallery.downloading'));
  }
  const btn = $('#galleryDownload');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = t('gallery.compressing');
  try {
    const r = await fetch('/api/videos/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: picked.map(n => n.id) }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || t('gallery.compressFailed'));
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; // a blob URL already carries the right filename via the download attribute
    a.download = (store.state.name || 'videos').replace(/[^\w.\- ]+/g, '_') + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(t('gallery.compressed') + ' ' + picked.length + ' ' + t('gallery.video') + ' ZIP');
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
  if (!picked.length) return toast(t('gallery.onlyVersions'), true);
  if (!confirm(t('gallery.deleteConfirm') + ' ' + picked.length + '?')) return;
  try {
    for (const n of picked) {
      store.state = await api('/api/nodes/delete', { method: 'POST', body: { id: n.id } });
      gallerySel.delete(n.id);
    }
    render();
    toast(
      t('gallery.deleted') +
        ' ' + picked.length + ' ' + t('gallery.video') +
        (skipped ? ' (' + t('gallery.skipped') + ' ' + skipped + ')' : ''),
    );
  } catch (e) {
    toast(e.message, true);
  }
};
