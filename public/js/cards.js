// Node cards on the canvas: status badge, preview, ports.
import { store } from './store.js';
import { esc } from './core.js';
import { SIZE_VI } from './stage-math.js';
import { nodeTime } from './zones.js';

function status(n) {
  const j = [...store.state.jobs].reverse().find(j => j.nodeId === n.id);
  if (j && ['queued', 'running', 'failed', 'needs_review'].includes(j.status))
    return {
      text: {
        queued: j.recover ? 'Đang lấy lại ảnh từ ChatGPT' : 'Đang chờ chạy',
        running: j.payload.seedvis
          ? 'Đang tạo trên Seedvis'
          : j.recover
            ? 'Đang lấy lại ảnh từ ChatGPT'
            : 'Đang chạy trên web',
        failed: 'Cần xử lý lỗi',
        needs_review: j.payload.seedvis
          ? 'Cần kiểm tra Seedvis'
          : j.kind === 'image' && j.payload.site === 'chatgpt'
            ? j.recoverAt
              ? 'Chờ lấy lại ảnh ChatGPT'
              : 'Ảnh ChatGPT chưa về'
            : 'Cần kiểm tra website',
      }[j.status],
      class: 'warn',
    };
  if (n.stale || (n.videoStale && (n.video || videosOf(n).length)))
    return { text: 'Đầu vào đã thay đổi', class: 'warn' };
  // A merged scene has no image of its own: it is ready, blocked, or filmed.
  if (n.role === 'merged')
    return n.video || videosOf(n).length
      ? { text: 'Có video', class: 'good' }
      : n.merged?.problem
        ? { text: 'Chưa đủ để quay', class: 'warn' }
        : { text: 'Sẵn sàng quay', class: 'good' };
  // a 3D stage node holds marks, not a picture
  if (n.stageOnly) {
    const k = n.stage3d?.performers?.length;
    return k
      ? { text: 'Đã ghim ' + k + ' người', class: 'good' }
      : { text: 'Chưa ghim', class: '' };
  }
  return n.video || videosOf(n).length
    ? { text: 'Có video', class: 'good' }
    : n.image
      ? { text: 'Đã có ảnh', class: 'good' }
      : { text: 'Chưa có ảnh', class: '' };
}
// The clips this node produced: one node per version in the Video column, newest last.
// (A video uploaded by hand still lives on the node itself.)
// A node shows the 🎬 output when it can make clips (a shot) or already has some — wires to
// its clips start there, so the predicate is shared by the markup and wireEnds().
export const hasVideoPort = n =>
  !!n &&
  !n.terminal &&
  n.kind !== 'setting' &&
  ('duration' in n || n.role === 'seedance' || n.role === 'lipsync' || videosOf(n).length > 0);
export const videosOf = n =>
  store.state.nodes
    .filter(t => t.terminal && t.source === n.id && t.video)
    .sort((a, b) => (a.version || 0) - (b.version || 0));
// The clips of one source are ONE card on the canvas: the version being looked at, with
// the count; ‹ › on the card walks through the others. Which one is shown lives here
// while the page is open (the newest until the user picks).
const picked = new Map(); // source id → clip id
export const clipsOf = sourceId => videosOf({ id: sourceId });
export function shownClip(sourceId) {
  const list = clipsOf(sourceId);
  return list.find(t => t.id === picked.get(sourceId)) || list.at(-1) || null;
}
export const pickClip = (sourceId, clipId) => picked.set(sourceId, clipId);
export function showClip(sourceId, delta) {
  const list = clipsOf(sourceId);
  if (!list.length) return null;
  const i = list.indexOf(shownClip(sourceId));
  const next = list[(i + delta + list.length) % list.length];
  picked.set(sourceId, next.id);
  return next;
}
function preview(n, cls = '') {
  // a 3D stage node shows its front wide
  if (n.stageOnly)
    return `<div class="preview ${cls}">${n.stage3d?.capture ? `<img src="${esc(n.stage3d.capture.url)}" alt="${esc(n.name)}">` : '<div class="placeholder"><span class="symbol">🧍</span>Sân khấu 3D</div>'}<span class="play-badge">🧍 3D</span></div>`;
  if (n.role === 'merged')
    return `<div class="preview ${cls}"><div class="placeholder"><span class="symbol">🎞</span>Phân cảnh ghép · ${n.imageInputs ?? 0} khung</div></div>`;
  return `<div class="preview ${cls}">${n.image ? `<img src="${esc(n.image.url)}" alt="${esc(n.name)}">` : `<div class="placeholder"><span class="symbol">${n.id === 'singer' ? '♙' : n.id === 'stage' ? '▱' : n.id === 'scene' ? '▧' : n.role === 'wardrobe' ? '👗' : n.role === 'look' ? '👤' : n.role === 'angle' ? '◧' : '▣'}</span>${n.id === 'scene' ? 'Nhân vật + bối cảnh' : n.role === 'wardrobe' ? 'Bộ đồ (render riêng)' : n.role === 'look' ? 'Nhân vật đã mặc bộ' : n.role === 'angle' ? 'Góc máy của bối cảnh' : 'Tạo hoặc tải ảnh'}</div>`}</div>`;
}
// Inputs summary on a node card: reference images vs. style / camera text, and whether
// a shot exceeds its video model's reference limit (then its keyframe is composed first).
function inputsLabel(n) {
  const over =
    'duration' in n && n.videoNeedsKeyframe ? ` · >${n.videoRefLimit}: tạo ảnh trước` : '';
  const people = n.stage3d?.performers?.length;
  return `🖼 ${n.imageInputs ?? 0} ảnh${n.settingInputs ? ` · 🎨🎥 ${n.settingInputs}` : ''}${over}${pinMark(n)}${people ? ` · 🧍 ${people}` : ''}`;
}
// A node keeping a pinned stage's marks: 📌, with the framing the tool chose in its tooltip.
function pinMark(n) {
  const p = n.stagePin;
  if (!p) return '';
  const tip =
    'Vị trí ghim theo ' +
    p.setName +
    (p.sig
      ? ' · ' + (SIZE_VI[p.size] || p.size)
      : ' · cận đồ vật — chỉ video nhận sơ đồ sân khấu') +
    (p.capture === 'missing' ? ' · đang tự chụp ảnh 3D' : '');
  return ` · <span class="pin3d" title="${esc(tip)}">📌</span>`;
}
export function card(n, shot = false) {
  const s = status(n);
  if (n.kind === 'music') {
    const src = n.audio
      ? '🎵 ' + esc(n.audio.name)
      : n.youtubeUrl
        ? '🔗 ' +
          esc(
            String(n.youtubeUrl)
              .replace(/^https?:\/\/(www\.)?/, '')
              .slice(0, 42),
          )
        : '<em>Chưa có nguồn nhạc</em>';
    const j = n.analysis?.json;
    const foot = j
      ? '✓ ' +
        (j.sections?.length || 0) +
        ' đoạn' +
        (j.durationSec ? ' · ' + j.durationSec + 's' : '')
      : 'Chưa phân tích';
    return `<article class="node setting" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>🎼 ${esc(n.name)}</span><span class="mini">↗</span></div><div class="setting-body">${src}</div><div class="node-footer"><span class="status ${j ? 'good' : ''}">${foot}</span></div></article>`;
  }
  if (n.role === 'lipsync') {
    const t = s => {
      const m = Math.floor(s / 60);
      return m + ':' + (s - m * 60).toFixed(2).padStart(5, '0');
    };
    const [from, to] = nodeTime(n) || [0, 0];
    const quiet = n.voiced !== undefined && n.voiced < 0.3;
    return `<article class="node" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>🎤 ${esc(n.name)}</span><span class="mini">↗</span></div>${preview(n)}<div class="setting-body">${t(from)} → ${t(to)} · ${(to - from).toFixed(1)}s · “${esc(String(n.lyric || '').slice(0, 60))}”${quiet ? ' · ⚠ ít giọng' : ''}</div><div class="node-footer"><span class="status ${s.class}">${s.text}</span><span>Omni${pinMark(n)}</span></div></article>`;
  }
  if (n.kind === 'setting') {
    const icon = { camera: '🎥', audio: '🔊' }[n.settingType] || '🎨';
    return `<article class="node setting" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>${icon} ${esc(n.name)}</span><span class="mini">↗</span></div><div class="setting-body">${n.config ? esc(n.config) : '<em>Chưa đặt nội dung</em>'}</div><div class="node-footer"><span class="status">Áp cho node được nối</span></div></article>`;
  }
  if (n.terminal) {
    const stack = clipsOf(n.source);
    const total = stack.length,
      k = stack.findIndex(x => x.id === n.id) + 1;
    const nav =
      total > 1
        ? `<span class="stack-nav"><button class="stack-btn" data-stack-prev="${esc(n.source)}" title="Bản trước">‹</button><span>${k}/${total}</span><button class="stack-btn" data-stack-next="${esc(n.source)}" title="Bản sau">›</button></span>`
        : '<span>Bấm để xem</span>';
    return `<article class="node terminal" tabindex="0" role="button" data-node="${n.id}" aria-label="Xem ${esc(n.name)}"><div class="node-top"><span>🎬 ${esc(n.name)}</span><span class="mini">↗</span></div><div class="preview video"><video muted playsinline preload="metadata" src="${esc(n.video?.url || '')}"></video><span class="play-badge">▶</span></div><div class="node-footer"><span class="status good">${total > 1 ? total + ' video' : 'Phiên bản video'}</span>${nav}</div></article>`;
  }
  const seq = n.seq ? `<span class="seq">#${n.seq}</span>` : '';
  // the shot's place on the song, from the one time helper (a float sum needs the rounding)
  const sec = v => Math.round(v * 1000) / 1000;
  const [from, to] = (nodeTime(n) || [0, 0]).map(sec);
  return shot
    ? `<article class="node shot" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}">${preview(n)}<div class="shot-info"><strong>${seq} ${esc(n.name)} <small>↗</small></strong><small>${from}s — ${to}s · ${n.duration} giây</small><small>${inputsLabel(n)}</small><span class="status ${s.class}">${s.text}</span></div></article>`
    : `<article class="node" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>${seq} ${n.role === 'wardrobe' ? '👗 ' : n.role === 'look' ? '👤 ' : n.role === 'angle' ? '◧ ' : ''}${esc(n.name)}</span><span class="mini">↗</span></div>${preview(n, ['singer', 'stage', 'scene'].includes(n.id) ? n.id : '')}<div class="node-footer"><span class="status ${s.class}">${s.text}</span><span>${inputsLabel(n)}</span></div></article>`;
}
