// Batch runs: auto images, auto video, stop, retry failed, create missing videos.
import { store } from './store.js';
import { $, api, toast } from './core.js';
import { render } from './render.js';
import { capturesReady } from './stage-keeper.js';

$('#autoStart').onclick = async () => {
  try {
    await capturesReady(); // shots on a pinned stage go out with their 3D capture
    store.state = await api('/api/auto/start', {
      method: 'POST',
      body: { target: $('#autoTarget').value },
    });
    render();
    toast('Đã bắt đầu chuỗi tự động');
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
    toast('Đang tạo ảnh đồng loạt cho khu vực đã chọn');
  } catch (e) {
    toast(e.message, true);
  }
};
// What "Dừng" did: queued jobs are cancelled; jobs already sent to Seedvis keep running in
// the background (the workflow is unlocked) and their results still land in the workflow.
const stopToast = (s, what) =>
  toast(
    !s || !(s.cancelled || s.detached)
      ? 'Không có tác vụ ' + what + ' nào đang chờ hoặc đang chạy'
      : 'Đã dừng ' +
          what +
          ': hủy ' +
          s.cancelled +
          ' tác vụ đang chờ · ' +
          s.detached +
          ' tác vụ đã gửi Seedvis chạy tiếp, kết quả vẫn tự thêm vào workflow',
  );
$('#autoStop').onclick = async () => {
  try {
    store.state = await api('/api/auto/stop', { method: 'POST', body: {} });
    render();
    stopToast(store.state.stopped, 'tạo ảnh');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoZoneStart').onclick = async () => {
  try {
    await capturesReady();
    store.state = await api('/api/auto/video/zone/start', {
      method: 'POST',
      body: {
        zone: $('#videoZone').value,
        provider: $('#videoProvider').value || undefined,
        versions: Number($('#videoVersions').value),
      },
    });
    render();
    toast('Đang tạo video đồng loạt cho khu vực đã chọn');
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
    toast('Đã bắt đầu tạo video tự động');
  } catch (e) {
    toast(e.message, true);
  }
};
$('#autoVideoStop').onclick = async () => {
  try {
    store.state = await api('/api/auto/video/stop', { method: 'POST', body: {} });
    render();
    stopToast(store.state.stopped, 'tạo video');
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
    toast('Đang chạy lại các video lỗi');
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
      toast('Đang tạo các video còn thiếu');
    } catch (e) {
      toast(e.message, true);
    }
  };
