// Node cards on the canvas: status badge, preview, ports.
import { store } from './store.js';
import { esc } from './core.js';
import { SIZE_VI } from './stage-math.js';
import { nodeTime } from './zones.js';
import { t } from './i18n.js';

function status(n) {
  const j = [...store.state.jobs].reverse().find(j => j.nodeId === n.id);
  if (j && ['queued', 'running', 'failed', 'needs_review'].includes(j.status))
    return {
      text: {
        queued: j.recover
          ? j.payload.site === 'musechat'
            ? t('node.runningWeb')
            : t('node.recoverChatgpt')
          : t('node.queued'),
        running: j.payload.seedvis
          ? t('node.runningSeedvis')
          : j.recover
            ? j.payload.site === 'musechat'
              ? t('node.runningWeb')
              : t('node.recoverChatgpt')
            : t('node.runningWeb'),
        failed: t('node.failed'),
        needs_review: j.payload.seedvis
          ? t('node.reviewSeedvis')
          : j.kind === 'image' && j.payload.site === 'chatgpt'
            ? j.recoverAt
              ? t('node.waitChatgpt')
              : t('node.chatgptMissing')
            : t('node.reviewWebsite'),
      }[j.status],
      class: 'warn',
    };
  if (n.stale || (n.videoStale && (n.video || videosOf(n).length)))
    return { text: t('node.inputChanged'), class: 'warn' };
  // A merged scene has no image of its own: it is ready, blocked, or filmed.
  if (n.role === 'merged')
    return n.video || videosOf(n).length
      ? { text: t('node.hasVideo'), class: 'good' }
      : n.merged?.problem
        ? { text: t('node.notReady'), class: 'warn' }
        : { text: t('node.ready'), class: 'good' };
  // a 3D stage node holds marks, not a picture
  if (n.stageOnly) {
    const k = n.stage3d?.performers?.length;
    return k
      ? { text: t('node.pinned') + ' ' + k, class: 'good' }
      : { text: t('node.notPinned'), class: '' };
  }
  return n.video || videosOf(n).length
    ? { text: t('node.hasVideo'), class: 'good' }
    : n.image
      ? { text: t('node.hasImage'), class: 'good' }
      : { text: t('node.noImage'), class: '' };
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
// The clips of one source are ONE stacked card on the canvas. The timeline choice is saved
// on the source node; `picked` only makes the just-selected thumbnail update immediately.
const picked = new Map(); // source id → clip id
export const clipsOf = sourceId => videosOf({ id: sourceId });
export function timelineClip(sourceId) {
  const source = store.state.nodes.find(n => n.id === sourceId);
  const list = clipsOf(sourceId);
  return list.find(t => t.id === source?.timelineClipId) || list.at(-1) || null;
}
export function shownClip(sourceId) {
  const list = clipsOf(sourceId);
  return list.find(t => t.id === picked.get(sourceId)) || timelineClip(sourceId);
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
    return `<div class="preview ${cls}">${n.stage3d?.capture ? `<img src="${esc(n.stage3d.capture.url)}" alt="${esc(n.name)}">` : `<div class="placeholder"><span class="symbol">🧍</span>${esc(t('node.stage3d'))}</div>`}<span class="play-badge">🧍 3D</span></div>`;
  if (n.role === 'merged')
    return `<div class="preview ${cls}"><div class="placeholder"><span class="symbol">🎞</span>${esc(t('node.merged'))} · ${n.imageInputs ?? 0} ${esc(t('node.frames'))}</div></div>`;
  return `<div class="preview ${cls}">${n.image ? `<img src="${esc(n.image.url)}" alt="${esc(n.name)}">` : `<div class="placeholder"><span class="symbol">${n.id === 'singer' ? '♙' : n.id === 'stage' ? '▱' : n.id === 'scene' ? '▧' : n.role === 'wardrobe' ? '👗' : n.role === 'look' ? '👤' : n.role === 'angle' ? '◧' : '▣'}</span>${esc(n.id === 'scene' ? t('node.scene') : n.role === 'wardrobe' ? t('node.wardrobe') : n.role === 'look' ? t('node.look') : n.role === 'angle' ? t('node.angle') : t('node.createImage'))}</div>`}</div>`;
}
// Inputs summary on a node card: reference images vs. style / camera text, and whether
// a shot exceeds its video model's reference limit (then its keyframe is composed first).
function inputsLabel(n) {
  const over =
    'duration' in n && n.videoNeedsKeyframe
      ? ` · >${n.videoRefLimit}: ${t('node.createKeyframeFirst')}`
      : '';
  const people = n.stage3d?.performers?.length;
  return `🖼 ${n.imageInputs ?? 0} ${t('node.images')}${n.settingInputs ? ` · 🎨🎥 ${n.settingInputs}` : ''}${over}${pinMark(n)}${people ? ` · 🧍 ${people}` : ''}`;
}
// A node keeping a pinned stage's marks: 📌, with the framing the tool chose in its tooltip.
function pinMark(n) {
  const p = n.stagePin;
  if (!p) return '';
  const tip =
    t('node.pinnedBy') +
    p.setName +
    (p.sig ? ' · ' + (SIZE_VI[p.size] || p.size) : ' · ' + t('node.objectCloseup')) +
    (p.capture === 'missing' ? ' · ' + t('node.capturing3d') : '');
  return ` · <span class="pin3d" title="${esc(tip)}">📌</span>`;
}
export function card(n, shot = false) {
  const s = status(n);
  if (n.kind === 'script') {
    const run = n.run;
    const qc = n.qc;
    const foot =
      run?.status === 'running'
        ? `⏳ ${esc(run.label || '')} ${run.step}/${run.total}`
        : qc
          ? qc.ok
            ? '✅ QC sạch'
            : `❌ ${qc.errors.length} lỗi QC`
          : n.blueprint
            ? 'Có blueprint'
            : 'Chưa chạy';
    const idea = String(n.brief?.idea || '').slice(0, 70);
    // A song wired in makes this an MV breakdown rather than a drama written from scratch.
    const song = store.state.nodes.find(
      x =>
        x.kind === 'music' && store.state.edges.some(e => e.source === x.id && e.target === n.id),
    );
    const body = song ? '🎵 ' + esc(song.name) : idea ? esc(idea) : '<em>Chưa có ý tưởng</em>';
    return `<article class="node setting" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>✍ ${esc(n.name)}</span><span class="mini">↗</span></div><div class="setting-body">${body}</div><div class="node-footer"><span class="status ${qc?.ok ? 'good' : ''}">${foot}</span><span>${song ? 'MV · ' : ''}${n.mode === 'full' ? 'Kỹ' : 'Nhanh'}</span></div></article>`;
  }
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
        : `<em>${esc(t('node.noMusicSource'))}</em>`;
    const j = n.analysis?.json;
    const foot = j
      ? '✓ ' +
        (j.sections?.length || 0) +
        ' đoạn' +
        (j.durationSec ? ' · ' + j.durationSec + 's' : '')
      : t('node.notAnalyzed');
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
    return `<article class="node setting" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>${icon} ${esc(n.name)}</span><span class="mini">↗</span></div><div class="setting-body">${n.config ? esc(n.config) : '<em>' + esc(t('node.noContent')) + '</em>'}</div><div class="node-footer"><span class="status">${esc(t('node.appliesToConnected'))}</span></div></article>`;
  }
  if (n.terminal) {
    const stack = clipsOf(n.source);
    const total = stack.length,
      k = stack.findIndex(x => x.id === n.id) + 1;
    const selected = timelineClip(n.source)?.id === n.id;
    return `<article class="node terminal video-stack-card" tabindex="0" role="button" data-video-stack-source="${esc(n.source)}" aria-label="${esc(t('node.openVideoVersions'))}: ${esc(n.name)}"><div class="node-top"><span>🎬 ${esc(n.name)}</span><span class="video-stack-count">${total}</span></div><div class="preview video"><video muted playsinline preload="metadata" src="${esc(n.video?.url || '')}"></video><span class="play-badge">▶</span>${selected ? `<span class="timeline-choice">✓ ${esc(t('node.onTimeline'))}</span>` : ''}</div><div class="node-footer"><span class="status good">${total} ${esc(t('node.videoVersions'))}</span><span>v${n.version || k} · ${esc(t('node.clickToChoose'))}</span></div></article>`;
  }
  const seq = n.seq ? `<span class="seq">#${n.seq}</span>` : '';
  // the shot's place on the song, from the one time helper (a float sum needs the rounding)
  const sec = v => Math.round(v * 1000) / 1000;
  const [from, to] = (nodeTime(n) || [0, 0]).map(sec);
  return shot
    ? `<article class="node shot" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}">${preview(n)}<div class="shot-info"><strong>${seq} ${esc(n.name)} <small>↗</small></strong><small>${from}s — ${to}s · ${n.duration} giây</small><small>${inputsLabel(n)}</small><span class="status ${s.class}">${s.text}</span></div></article>`
    : `<article class="node" tabindex="0" role="button" data-node="${n.id}" aria-label="Chỉnh ${esc(n.name)}"><div class="node-top"><span>${seq} ${n.role === 'wardrobe' ? '👗 ' : n.role === 'look' ? '👤 ' : n.role === 'angle' ? '◧ ' : ''}${esc(n.name)}</span><span class="mini">↗</span></div>${preview(n, ['singer', 'stage', 'scene'].includes(n.id) ? n.id : '')}<div class="node-footer"><span class="status ${s.class}">${s.text}</span><span>${inputsLabel(n)}</span></div></article>`;
}
