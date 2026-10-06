// Generation providers: Seedvis key/status, Orbit login, per-node provider settings.
import { store } from './store.js';
import { $, api, esc, toast } from './core.js';
import { refresh } from './render.js';

// What a node can generate: a shot makes an image and a video, anything else an image.
export const kindsFor = shot => (shot ? ['image', 'video'] : ['image']);
export const videoUsesRefs = n => n.videoInput === 'refs';
// Once the node has composed its own image, that exact keyframe drives the video —
// the connected refs only seed it beforehand. Mirrors the server.
// Over the video model's reference limit (Veo: 3) the refs cannot go straight into the
// video: the shot composes its keyframe first (server rule, mirrored here).
export const videoFromRefs = n => videoUsesRefs(n) && !n.image && !n.videoNeedsKeyframe;

export let orbitStatus = null;
let seedvisStatus = null;
function seedvisFields(n, kind, cur) {
  const models = store.state.seedvisCatalog[kind],
    m = models.find(x => x.id === cur.model) || models[0],
    available = seedvisStatus?.available;
  const options = (list, value, label = v => v) =>
    list
      .map(
        v => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(label(v))}</option>`,
      )
      .join('');
  const hint =
    kind === 'image'
      ? n.references.length
        ? `Ảnh → ảnh: gửi ${n.references.length} ảnh đầu vào (tối đa ${m.maxImages}).`
        : 'Chữ → ảnh: node chưa có ảnh đầu vào.'
      : `${videoFromRefs(n) ? `Ảnh → video từ ${n.references.length} ảnh node nối vào` + (m.maxImages ? ` (model này tối đa ${m.maxImages})` : '') : 'Ảnh → video từ keyframe (ảnh của chính node này)'}. Thời lượng gửi: ${m.durations ? Math.max(...m.durations) + ' giây (tối đa của model, để cắt đầu đuôi)' : 'model tự quyết'} · shot dài ${n.duration} giây.`;
  return (
    `<label>Model<select data-sv-model="${kind}">${models
      .map(
        x =>
          `<option value="${esc(x.id)}" ${x.id === m.id ? 'selected' : ''}>${esc(x.name)}${available && !available.includes(x.id) ? ' (tài khoản chưa dùng được)' : ''}</option>`,
      )
      .join('')}</select></label>` +
    `<div class="two"><label>Tỉ lệ khung<select data-sv-aspect="${kind}">${options(m.aspect, cur.aspectRatio)}</select></label>` +
    (m.upscale.length
      ? `<label>Upscale<select data-sv-upscale="${kind}">${options(m.upscale, cur.upscale, v => (v === 'none' ? 'Không' : v))}</select></label>`
      : '') +
    `</div><p class="field-hint">${esc(hint)}</p>` +
    (m.note ? `<p class="note">${esc(m.note)}</p>` : '')
  );
}
export function providerSettings(n, shot) {
  return (
    '<section class="inspector-section"><h3>Nguồn tạo</h3>' +
    (store.state.seedvisConfigured
      ? ''
      : '<p class="note">Chưa có API key Seedvis. Nhập key trong Kết nối web.</p>') +
    kindsFor(shot)
      .map(kind => {
        const cur = n.providers[kind],
          sv = cur.type === 'seedvis' ? cur : { ...store.state.seedvisDefaults[kind] };
        // ChatGPT runs in the browser extension and only makes images.
        const webOpt =
          kind === 'image'
            ? `<option value="web" ${cur.type === 'web' ? 'selected' : ''}>ChatGPT (extension)</option>`
            : '';
        const webHint =
          kind === 'image'
            ? `<p class="field-hint" data-web-hint="${kind}" ${cur.type === 'web' ? '' : 'hidden'}>Tạo ảnh bằng ChatGPT qua extension: cài extension, đăng nhập ChatGPT, bật worker. Gửi prompt${n.references.length ? ' + ' + n.references.length + ' ảnh đầu vào' : ''} sang ChatGPT.</p>`
            : '';
        // Google Vids runs in the browser extension and only makes video.
        const gvidsOpt =
          kind === 'video'
            ? `<option value="gvids" ${cur.type === 'gvids' ? 'selected' : ''}>Google Vids (extension)</option>`
            : '';
        const gvidsHint =
          kind === 'video'
            ? `<p class="field-hint" data-gvids-hint="${kind}" ${cur.type === 'gvids' ? '' : 'hidden'}>Tạo video bằng Google Vids qua extension: cài extension, đăng nhập Google, mở sẵn một tài liệu Google Vids, bật worker Google Vids. Gửi prompt${n.references.length ? ' + ' + n.references.length + ' ảnh làm nhân vật/ingredient' : ''} sang Google Vids, tự đặt 1080p rồi tải video về.</p>`
            : '';
        return `<h4>${kind === 'image' ? 'Tạo ảnh' : 'Tạo video'}</h4><label>Dùng<select data-provider="${kind}"><option value="seedvis" ${cur.type === 'seedvis' ? 'selected' : ''}>Seedvis API</option>${webOpt}${gvidsOpt}<option value="orbit" ${cur.type === 'orbit' ? 'selected' : ''}>Orbit (kịch bản web)</option></select></label><div data-seedvis-fields="${kind}" ${cur.type === 'seedvis' ? '' : 'hidden'}>${seedvisFields(n, kind, sv)}</div>${webHint}${gvidsHint}`;
      })
      .join('') +
    '</section>'
  );
}
export function bindProviderSettings(n) {
  const bindFields = kind => {
    const box = document.querySelector(`[data-seedvis-fields="${kind}"]`);
    box.querySelectorAll('select').forEach(e => (e.onchange = () => (store.dirty = true)));
    box.querySelector('[data-sv-model]').onchange = e => {
      store.dirty = true;
      const aspect = box.querySelector('[data-sv-aspect]')?.value,
        upscale = box.querySelector('[data-sv-upscale]')?.value;
      box.innerHTML = seedvisFields(n, kind, {
        model: e.target.value,
        aspectRatio: aspect,
        upscale,
      });
      bindFields(kind);
    };
  };
  document.querySelectorAll('[data-provider]').forEach(select => {
    const kind = select.dataset.provider;
    select.onchange = () => {
      store.dirty = true;
      const off = select.value !== 'seedvis';
      document.querySelector(`[data-seedvis-fields="${kind}"]`).hidden = off;
      const webHint = document.querySelector(`[data-web-hint="${kind}"]`);
      if (webHint) webHint.hidden = select.value !== 'web';
      const gvidsHint = document.querySelector(`[data-gvids-hint="${kind}"]`);
      if (gvidsHint) gvidsHint.hidden = select.value !== 'gvids';
      // Editing and several versions run on Seedvis only: follow the choice before it is saved.
      const edit = $('#editImage'),
        versions = $('#inspector #nodeVideoVersions');
      if (kind === 'image' && edit) {
        edit.disabled = off;
        edit.title = off ? 'Chuyển nguồn tạo ảnh của node sang Seedvis để sửa ảnh' : '';
      }
      if (kind === 'video' && versions) {
        if (off) versions.value = '1';
        versions.disabled = off;
      }
    };
    bindFields(kind);
  });
}
// Only the kinds whose provider or Seedvis options changed are sent. Returns the seedvis, web
// and gvids patches separately; the inspector PATCHes them as b.seedvis, b.web and b.gvids.
// Switching to a browser source (orbit/web/gvids) sets seedvis[kind] = false so the server
// routes it there.
export function readProviderSettings(n) {
  const seedvis = {},
    web = {},
    gvids = {};
  document.querySelectorAll('[data-provider]').forEach(select => {
    const kind = select.dataset.provider,
      cur = n.providers[kind];
    if (select.value === 'orbit') {
      if (cur.type !== 'orbit') seedvis[kind] = false;
      if (cur.type === 'web') web[kind] = false;
      if (cur.type === 'gvids') gvids[kind] = false;
      return;
    }
    if (select.value === 'web') {
      if (cur.type !== 'web') {
        seedvis[kind] = false;
        web[kind] = true;
      }
      if (cur.type === 'gvids') gvids[kind] = false;
      return;
    }
    if (select.value === 'gvids') {
      if (cur.type !== 'gvids') {
        seedvis[kind] = false;
        gvids[kind] = true;
      }
      if (cur.type === 'web') web[kind] = false;
      return;
    }
    // Seedvis: leaving a browser source clears its flag.
    if (cur.type === 'web') web[kind] = false;
    if (cur.type === 'gvids') gvids[kind] = false;
    const next = {
      model: document.querySelector(`[data-sv-model="${kind}"]`).value,
      aspectRatio: document.querySelector(`[data-sv-aspect="${kind}"]`).value,
      upscale: document.querySelector(`[data-sv-upscale="${kind}"]`)?.value || null,
    };
    if (
      cur.type !== 'seedvis' ||
      cur.model !== next.model ||
      cur.aspectRatio !== next.aspectRatio ||
      (cur.upscale || null) !== next.upscale
    )
      seedvis[kind] = next;
  });
  return { seedvis, web, gvids };
}
function showSeedvis(o) {
  seedvisStatus = o;
  $('#seedvisStatus').textContent = o.configured
    ? [
        o.message,
        'key ' + o.keyHint,
        o.account?.plan ? 'gói ' + o.account.plan : '',
        o.account?.balance != null ? 'số dư ' + o.account.balance : '',
        o.source === 'env' ? 'lấy từ biến môi trường SEEDVIS_API_KEY' : '',
        // The exact model ids the account exposes (from /models) — so a model the app's catalog
        // does not list yet (e.g. a distinct "Google Omni Flash" id) is visible for debugging.
        Array.isArray(o.available) && o.available.length
          ? 'model tài khoản: ' + o.available.join(', ')
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : o.message;
  $('#seedvisKey').placeholder = o.configured ? 'Dán key mới để thay' : 'Dán API key Seedvis';
  $('#removeSeedvis').hidden = !o.configured || o.source === 'env';
}
export async function refreshSeedvis() {
  showSeedvis(await api('/api/seedvis'));
}
$('#testSeedvis').onclick = () => refreshSeedvis().catch(e => toast(e.message, true));
$('#seedvisKeyForm').onsubmit = async e => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    showSeedvis(
      await api('/api/seedvis/key', { method: 'POST', body: { key: $('#seedvisKey').value } }),
    );
    await refresh();
    toast(
      seedvisStatus.error ? seedvisStatus.message : 'Đã lưu API key Seedvis',
      seedvisStatus.error,
    );
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#seedvisKey').value = '';
    button.disabled = false;
  }
};
$('#removeSeedvis').onclick = async () => {
  if (!confirm('Xóa API key Seedvis khỏi máy này?')) return;
  try {
    showSeedvis(await api('/api/seedvis/key', { method: 'POST', body: { key: null } }));
    await refresh();
    toast('Đã xóa API key Seedvis');
  } catch (e) {
    toast(e.message, true);
  }
};

export function showOrbit(o) {
  orbitStatus = o;
  $('#orbitStatus').textContent = o.message;
  $('#orbitInventory').textContent = o.authenticated
    ? o.profiles.length +
      ' nick · ' +
      (o.apps || []).length +
      ' App · ' +
      o.workflows.length +
      ' kịch bản · ' +
      o.flows.length +
      ' khối'
    : '';
  $('#orbitLogin').hidden = !!o.authenticated;
  $('#logoutOrbit').hidden = !o.authenticated;
  $('#workerBadge').textContent = store.state.worker?.online
    ? '● ' + (store.state.worker.count || 1) + ' worker đang nối'
    : o.authenticated
      ? '● Orbit: ' + o.user.email
      : '◐ Đăng nhập Orbit';
}
export async function refreshOrbit() {
  const o = await api('/api/orbit');
  showOrbit(o);
}
$('#testOrbit').onclick = () => refreshOrbit().catch(e => toast(e.message, true));
$('#orbitLogin').onsubmit = async e => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/orbit/login', {
      method: 'POST',
      body: { email: $('#orbitEmail').value, password: $('#orbitPassword').value },
    });
    await refreshOrbit();
    toast('Đã đăng nhập. Mở node để chọn kịch bản và nick.');
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('#orbitPassword').value = '';
    button.disabled = false;
  }
};
$('#logoutOrbit').onclick = async () => {
  try {
    await api('/api/orbit/logout', { method: 'POST', body: {} });
    await refreshOrbit();
    toast('Đã đăng xuất Orbit');
  } catch (e) {
    toast(e.message, true);
  }
};
export function orbitSettings(n, shot) {
  const c = orbitStatus;
  if (!c?.authenticated)
    return '<section class="inspector-section"><h3>Cài đặt Orbit</h3><p>Đăng nhập trong Kết nối web để chọn kịch bản và nick chạy.</p></section>';
  const scripts = [
    ...(c.apps || []).map(s => ({ ...s, type: 'app', label: 'App' })),
    ...c.workflows.map(s => ({ ...s, type: 'workflow', label: 'Kịch bản' })),
    ...c.flows.map(s => ({ ...s, type: 'flow', label: 'Khối' })),
  ];
  return (
    '<section class="inspector-section"><h3>Cài đặt Orbit</h3><p>Chọn App / kịch bản và nick cho từng loại tác vụ. App cần công khai các biến prompt, mv_prompt… trong public params.</p>' +
    (shot ? ['image', 'video'] : ['image'])
      .map(kind => {
        const saved = n.orbit?.[kind],
          value = saved ? saved.type + ':' + saved.scriptId : '';
        return (
          '<h4>' +
          (kind === 'image' ? 'Tạo ảnh' : 'Tạo video') +
          '</h4><label>Kịch bản<select data-orbit-select data-orbit-script="' +
          kind +
          '"><option value="">Chọn kịch bản…</option>' +
          (!value || scripts.some(s => s.type + ':' + s.id === value)
            ? ''
            : '<option selected value="' +
              esc(value) +
              '">Không còn quyền truy cập — chọn lại</option>') +
          scripts
            .map(
              s =>
                '<option value="' +
                esc(s.type + ':' + s.id) +
                '" ' +
                (value === s.type + ':' + s.id ? 'selected' : '') +
                '>' +
                esc(s.label + ' · ' + s.name) +
                '</option>',
            )
            .join('') +
          '</select></label><label>Nick chạy<select data-orbit-select data-orbit-profile="' +
          kind +
          '"><option value="">Chọn nick…</option>' +
          (!saved?.profileId || c.profiles.some(p => p.id === saved.profileId)
            ? ''
            : '<option selected value="' +
              esc(saved.profileId) +
              '">Nick không còn quyền truy cập — chọn lại</option>') +
          c.profiles
            .map(
              p =>
                '<option value="' +
                esc(p.id) +
                '" ' +
                (p.id === saved?.profileId ? 'selected' : '') +
                '>' +
                esc(p.name) +
                '</option>',
            )
            .join('') +
          '</select></label>'
        );
      })
      .join('') +
    '<p class="muted">Lựa chọn được lưu theo node và đính kèm từng job. Tự mở nick và chạy kịch bản đã chọn. Ảnh đầu vào được truyền bằng mv_input_1_path, mv_input_2_path… Kịch bản cần upload chúng; lưu kết quả tới mv_output_path.</p></section>'
  );
}

export function outputSettings(n, shot) {
  return (
    '<section class="inspector-section"><h3>File đầu ra</h3><p class="field-hint">Thư mục trên máy Orbit: ' +
    esc(store.state.outputDirectory) +
    '</p>' +
    (shot ? ['image', 'video'] : ['image'])
      .map(
        kind =>
          '<label>Tên file ' +
          (kind === 'image' ? 'ảnh' : 'video') +
          ' <code class="variable-tag">{{mv_output_filename}}</code><input data-output-pattern="' +
          kind +
          '" value="' +
          esc(
            n.outputNaming?.[kind] ||
              (kind === 'image' ? '{node_id}_{job_id}.png' : '{node_id}_{job_id}.mp4'),
          ) +
          '"></label><p class="field-hint" data-output-preview="' +
          kind +
          '">Ví dụ: ' +
          esc(
            (
              n.outputNaming?.[kind] ||
              (kind === 'image' ? '{node_id}_{job_id}.png' : '{node_id}_{job_id}.mp4')
            )
              .replaceAll('{node_id}', n.id)
              .replaceAll('{job_id}', 'JOB-ID')
              .replaceAll('{kind}', kind),
          ) +
          '</p>',
      )
      .join('') +
    '<p class="field-hint">Mẫu dùng {node_id}, {kind}, {job_id}. Kịch bản lưu tới <code>{{mv_output_path}}</code>. Đuôi file phải đúng định dạng tải về. App cần công khai các biến đầu ra này. Tự nhận file từ đường dẫn đầu ra khi kịch bản xong.</p></section>'
  );
}
export function updateOutputPreview() {
  document.querySelectorAll('[data-output-pattern]').forEach(e => {
    document.querySelector('[data-output-preview="' + e.dataset.outputPattern + '"]').textContent =
      'Ví dụ: ' +
      e.value
        .replaceAll('{node_id}', store.selected)
        .replaceAll('{job_id}', 'JOB-ID')
        .replaceAll('{kind}', e.dataset.outputPattern);
  });
}

// Project default source (Kết nối web): nodes that have not chosen their own follow it.
export function paintDefaults() {
  const img = $('#defaultImage'),
    vid = $('#defaultVideo');
  if (!img || !vid) return;
  const d = store.state?.defaults || {};
  if (document.activeElement !== img) img.value = d.image || 'seedvis';
  if (document.activeElement !== vid) vid.value = d.video || 'seedvis';
  // The default Seedvis model per kind: a new node uses it when its source is Seedvis, so the
  // picker is shown only then. Options come from the catalog; models the account cannot use are
  // flagged (so the default is not silently set to a model that will not run).
  const cat = store.state?.seedvisCatalog || { image: [], video: [] };
  const defModel = store.state?.seedvisDefaults || {};
  const available = seedvisStatus?.available;
  for (const [kind, srcSel, want, rowId, selId] of [
    ['image', img, d.imageModel, 'defaultImageModelRow', 'defaultImageModel'],
    ['video', vid, d.videoModel, 'defaultVideoModelRow', 'defaultVideoModel'],
  ]) {
    const sel = $('#' + selId),
      row = $('#' + rowId);
    if (!sel || !row) continue;
    const models = cat[kind] || [];
    sel.innerHTML = models
      .map(
        m =>
          `<option value="${esc(m.id)}">${esc(m.name)}${available && !available.includes(m.id) ? ' (tài khoản chưa dùng được)' : ''}</option>`,
      )
      .join('');
    if (document.activeElement !== sel)
      sel.value = models.some(m => m.id === want)
        ? want
        : defModel[kind]?.model || models[0]?.id || '';
    row.hidden = srcSel.value !== 'seedvis';
  }
  const hint = $('#defaultsHint');
  if (hint)
    hint.textContent =
      vid.value === 'gvids'
        ? 'Video mặc định tạo bằng Google Vids — cần bật worker Google Vids trong extension và mở sẵn một tài liệu Google Vids.'
        : img.value === 'web'
          ? 'Ảnh mặc định tạo bằng ChatGPT — cần bật worker extension (xem phần ChatGPT).'
          : img.value === 'orbit' || vid.value === 'orbit'
            ? 'Nguồn Orbit vẫn cần chọn kịch bản + nick trong Cài đặt Orbit của từng node.'
            : '';
}
async function saveDefaults() {
  try {
    await api('/api/project', {
      method: 'PATCH',
      body: {
        defaults: {
          image: $('#defaultImage').value,
          video: $('#defaultVideo').value,
          imageModel: $('#defaultImageModel')?.value || '',
          videoModel: $('#defaultVideoModel')?.value || '',
        },
      },
    });
    await refresh();
    toast('Đã lưu nguồn mặc định');
  } catch (e) {
    toast(e.message, true);
  }
}
for (const id of ['#defaultImage', '#defaultVideo', '#defaultImageModel', '#defaultVideoModel'])
  if ($(id)) $(id).onchange = saveDefaults;

// The ChatGPT extension worker token (read once; it does not change). Shown so the user can
// copy it into the browser extension.
export async function refreshWorkerInfo() {
  const el = $('#workerToken');
  if (!el) return;
  try {
    const info = await api('/api/worker-info');
    el.value = info.token || '';
    // Each window serves its own port; the panel used to name 7788 even at a secondary window,
    // sending the user to the wrong address. /api/worker-info already reports the right one.
    for (const id of ['#workerUrl', '#workerApiUrl'])
      if ($(id) && info.url) $(id).textContent = info.url;
  } catch {}
}
if ($('#copyWorkerToken'))
  $('#copyWorkerToken').onclick = async () => {
    const el = $('#workerToken');
    try {
      await navigator.clipboard.writeText(el.value);
    } catch {
      el.select();
      document.execCommand('copy');
    }
    toast('Đã sao chép token');
  };
