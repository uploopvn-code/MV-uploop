// Batch runs: auto images, auto video, stop, retry failed, create missing videos.
import { store } from './store.js';
import { $, api, toast } from './core.js';
import { render } from './render.js';
import { capturesReady } from './stage-keeper.js';
import { t } from './i18n.js';

$('#autoStart').onclick = async () => {
  try {
    await capturesReady(); // shots on a pinned stage go out with their 3D capture
    store.state = await api('/api/auto/start', {
      method: 'POST',
      body: { target: $('#autoTarget').value },
    });
    render();
    toast(t('render.autoStarted'));
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoImageStart').onclick = async () => {
  try {
    await capturesReady();
    store.state = await api('/api/auto/images/start', {
      method: 'POST',
      body: { zone: $('#imageZone').value },
    });
    render();
    // Có thể là tạo mới, kiểm lại ảnh đang chờ Seedvis, hoặc cả hai.
    const sum = store.state.imageBatchSummary;
    toast(sum?.message ? sum.message : t('render.imagesStarted'));
  } catch (e) {
    toast(e.message, true);
  }
};
// What "Dừng" did: queued jobs are cancelled; jobs already sent to Seedvis keep running in
// the background (the workflow is unlocked) and their results still land in the workflow.
const stopToast = (s, what) =>
  toast(
    !s || !(s.cancelled || s.detached)
      ? t('render.stopNone').replace('{what}', what)
      : t('render.stopDone')
          .replace('{what}', what)
          .replace('{cancelled}', s.cancelled)
          .replace('{detached}', s.detached),
  );
$('#autoStop').onclick = async () => {
  try {
    store.state = await api('/api/auto/stop', { method: 'POST', body: {} });
    render();
    stopToast(store.state.stopped, t('render.imageJobs'));
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoZoneStart').onclick = async () => {
  try {
    await capturesReady();
    const zone = $('#videoZone').value;
    const provider = $('#videoProvider').value;
    const targetVersions = Math.max(1, Number($('#videoVersions').value) || 1);
    const commandOptions = window.mvVideoBatchOptions || {};
    delete window.mvVideoBatchOptions;
    const outputCount = source =>
      Number(!!source.video) +
      store.state.nodes.filter(clip => clip.terminal && clip.source === source.id && clip.video).length;
    const candidates = store.state.nodes.filter(n => {
      if (n.terminal || n.zone !== zone || outputCount(n) >= targetVersions) return false;
      if (provider && n.providers?.video?.type !== provider) return false;
      if (
        commandOptions.excludeCloseups === true &&
        /cận mặt|cận cảnh|close[- ]?up|\b(?:cu|ecu)\b/i.test(String(n.name || ''))
      )
        return false;
      return !!(n.image || n.references?.some(r => r?.asset || r?.image));
    });
    const missingVersions = candidates.reduce(
      (total, n) => total + Math.max(0, targetVersions - outputCount(n)),
      0,
    );
    const confirmation = t('render.targetVersionsConfirm')
      .replace('{target}', targetVersions)
      .replace('{missing}', missingVersions)
      .replace('{count}', candidates.length);
    if (!confirm(confirmation)) return;
    const staleCount = candidates.filter(
      n =>
        !n.terminal &&
        (n.image ? n.stale : n.references?.some(r => store.state.nodes.find(parent => parent.id === r.role)?.stale)) &&
        (n.image || n.references?.some(r => r?.asset || r?.image)),
    ).length;
    const allowStale =
      staleCount > 0 &&
      confirm(`${t('render.staleConfirmPrefix')} ${staleCount} ${t('render.staleConfirmQuestion')}\n\n${t('render.staleConfirmOk')}\n${t('render.staleConfirmCancel')}`);
    store.state = await api('/api/auto/video/zone/start', {
      method: 'POST',
      body: {
        zone,
        provider: provider || undefined,
        versions: targetVersions,
        allowStale,
        onlyWithImage: false,
        excludeCloseups: commandOptions.excludeCloseups === true,
      },
    });
    render();
    toast(t('render.zoneVideosStarted'));
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoStart').onclick = async () => {
  try {
    await capturesReady(); // a keyframe made on the way goes with its 3D capture
    store.state = await api('/api/auto/video/start', {
      method: 'POST',
      body: { target: $('#autoTarget').value, versions: Number($('#videoVersions').value) },
    });
    render();
    toast(t('render.videosStarted'));
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoStop').onclick = async () => {
  try {
    store.state = await api('/api/auto/video/stop', { method: 'POST', body: {} });
    render();
    stopToast(store.state.stopped, t('render.videoJobs'));
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoRetry').onclick = async () => {
  try {
    await capturesReady(); // a keyframe made on the way goes with its 3D capture
    store.state = await api('/api/auto/video/retry', {
      method: 'POST',
      body: { versions: Number($('#videoVersions').value) },
    });
    render();
    toast(t('render.retryStarted'));
  } catch (e) {
    toast(e.message, true);
  }
};
const missingBtn = $('#autoVideoMissing');
if (missingBtn)
  missingBtn.onclick = async () => {
    try {
      await capturesReady(); // a keyframe made on the way goes with its 3D capture
      store.state = await api('/api/auto/video/missing', {
        method: 'POST',
        body: { versions: Number($('#videoVersions').value) },
      });
      render();
      toast(t('render.missingStarted'));
    } catch (e) {
      toast(e.message, true);
    }
  };
