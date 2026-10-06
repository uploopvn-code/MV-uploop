// Small helpers every feature uses: DOM lookup, HTML escaping, the API client, toasts,
// download names, and the "workflow is busy" lock.
import { store } from './store.js';

// The workflow is read-only while any job is queued/running or an auto-run is active —
// the server rejects edits then, so the UI mirrors that lock instead of letting the user
// make changes that would only error or silently not persist.
export const workflowBusy = () =>
  !!(
    typeof store.state !== 'undefined' &&
    store.state &&
    (store.state.autoRun?.status === 'running' ||
      store.state.autoVideoRun?.status === 'running' ||
      store.state.autoImageRun?.status === 'running' ||
      store.state.jobs?.some(j => ['queued', 'running'].includes(j.status) && !j.cancelRequested))
  );
const pad2 = n => String(n || 0).padStart(2, '0');
// Filesystem-safe version of a node name.
const safeName = s =>
  String(s || 'video')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'video';
const extOf = url => String(url).match(/\.(mp4|webm|png|jpg|jpeg|webp)(?:\?|$)/i)?.[1] || 'mp4';
// Download name: <stt>_<tên node>[_vN].<ext>, so the source is obvious.
export function downloadName(n, kind = 'video') {
  const asset = n[kind] || n.video || n.image;
  const ext = extOf(asset?.url || asset?.name || '');
  if (n.terminal) {
    // Name by the source shot's production number so the origin is obvious.
    const src = store.state?.nodes?.find(x => x.id === n.source);
    const num = src?.seq ?? n.sourceSeq,
      nm = src?.name ?? n.sourceName;
    return pad2(num) + '_' + safeName(nm) + '_v' + (n.version || 1) + '.' + ext;
  }
  return pad2(n.seq) + '_' + safeName(n.name) + '.' + ext;
}
// Point a media URL at the download route so the server forces a file save (browsers
// otherwise play video inline and ignore the download attribute).
export const dlUrl = (url, name) =>
  String(url) + (String(url).includes('?') ? '&' : '?') + 'dl=' + encodeURIComponent(name);
export function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = dlUrl(url, name);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
export const $ = s => document.querySelector(s),
  esc = s =>
    String(s ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
// The state is polled every few seconds, so most redraws write the very same markup.
// Writing innerHTML anyway throws away every child — images and videos reload, the canvas
// repaints, a half-played preview restarts. Keep the last markup and only write on change.
export function paint(sel, html) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el || el.__html === html) return false;
  el.innerHTML = html;
  el.__html = html;
  return true;
}
export async function api(url, options = {}) {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Không kết nối được');
  return data;
}
export function toast(msg, error = false) {
  $('#toast').textContent = msg;
  $('#toast').className = error ? 'error' : '';
  $('#toast').style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($('#toast').style.display = 'none'), 5000);
}
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Đã sao chép');
  } catch {
    toast('Trình duyệt chưa cho phép sao chép. Chọn và copy nội dung prompt.', true);
  }
}
