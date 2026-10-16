// Generation providers: Seedvis key/status, Orbit login, per-node provider settings.
import { store } from './store.js';
import { $, api, esc, toast } from './core.js';
import { refresh } from './render.js';
import { t } from './i18n.js';

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
        ? t('provider.imageToImageHint', { count: n.references.length, max: m.maxImages })
        : t('provider.textToImageHint')
      : t('provider.videoHint', { source: videoFromRefs(n) ? t('provider.fromReferences', { count: n.references.length, max: m.maxImages ? ` (${t('provider.modelMax', { max: m.maxImages })})` : '' }) : t('provider.fromKeyframe'), duration: m.durations ? `${Math.max(...m.durations)} giây` : t('provider.modelDecides'), shot: n.duration });
  return (
    `<label>${t('provider.model')}<select data-sv-model="${kind}">${models
      .map(
        x =>
          `<option value="${esc(x.id)}" ${x.id === m.id ? 'selected' : ''}>${esc(x.name)}${available && !available.includes(x.id) ? ' (' + t('provider.accountUnavailable') + ')' : ''}</option>`,
      )
      .join('')}</select></label>` +
    `<div class="two"><label>${t('provider.aspectRatio')}<select data-sv-aspect="${kind}">${options(m.aspect, cur.aspectRatio)}</select></label>` +
    (m.upscale.length
      ? `<label>${t('provider.upscale')}<select data-sv-upscale="${kind}">${options(m.upscale, cur.upscale, v => (v === 'none' ? t('provider.none') : v))}</select></label>`
      : '') +
    `</div><p class="field-hint">${esc(hint)}</p>` +
    (m.note ? `<p class="note">${esc(m.note)}</p>` : '')
  );
}
export function providerSettings(n, shot) {
  return (
    '<section class="inspector-section"><h3>' + t('provider.sourceTitle') + '</h3>' +
    (store.state.seedvisConfigured
      ? ''
      : `<p class="note">${t('provider.noSeedvisKey')}</p>`) +
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
            ? `<p class="field-hint" data-web-hint="${kind}" ${cur.type === 'web' ? '' : 'hidden'}>${t('provider.chatgptHint', { refs: n.references.length ? ' + ' + n.references.length + t('provider.inputImages') : '' })}</p>`
            : '';
        // Google Vids runs in the browser extension and only makes video.
        const gvidsOpt =
          kind === 'video'
            ? `<option value="gvids" ${cur.type === 'gvids' ? 'selected' : ''}>Google Vids (extension)</option>`
            : '';
        const gvidsHint =
          kind === 'video'
            ? `<p class="field-hint" data-gvids-hint="${kind}" ${cur.type === 'gvids' ? '' : 'hidden'}>${t('provider.gvidsHint', { refs: n.references.length ? ' + ' + n.references.length + t('provider.ingredientImages') : '' })}</p>`
            : '';
        // Muse chat runs in the browser extension for image and video — one background tab per job.
        const museOpt =
          `<option value="musechat" ${cur.type === 'musechat' ? 'selected' : ''}>Muse chat (extension)</option>`;
        const museHint =
          `<p class="field-hint" data-musechat-hint="${kind}" ${cur.type === 'musechat' ? '' : 'hidden'}>${t('provider.museHint', { kind: kind === 'image' ? t('provider.image') : t('provider.video'), refs: n.references.length ? ' + ' + n.references.length + t('provider.referenceImages') : '' })}</p>`;
        // Seedane (desktop tool on the LAN): Dola makes video, Muse image or video.
        const sdVal = cur.type === 'seedane' ? 'seedane-' + cur.platform : '';
        const seedaneOpt =
          (kind === 'video'
            ? `<option value="seedane-dola" ${sdVal === 'seedane-dola' ? 'selected' : ''}>Seedane · Dola</option>`
            : '') +
          `<option value="seedane-muse" ${sdVal === 'seedane-muse' ? 'selected' : ''}>Seedane · Muse</option>`;
        const seedaneFields =
          `<div data-seedane-fields="${kind}" ${sdVal ? '' : 'hidden'}>` +
          (kind === 'video'
            ? `<label data-seedane-model-row="${kind}" ${sdVal === 'seedane-muse' ? 'hidden' : ''}>Model Dola<select data-seedane-model="${kind}">` +
              ['2.5', '2.0']
                .map(m => `<option value="${m}" ${(cur.model || '2.5') === m ? 'selected' : ''}>Dola ${m}${m === '2.5' ? ' (10/15/30 giây)' : ' (10/15 giây)'}</option>`)
                .join('') +
              '</select></label>'
            : '') +
          `<label>Nick (để trống = nick sẵn sàng đầu tiên)<input data-seedane-account="${kind}" value="${esc(cur.type === 'seedane' ? cur.account || '' : '')}" placeholder="vd Muse #1"></label>` +
          `<p class="field-hint">${store.state.seedaneConfigured ? 'Chạy qua Seedane trên máy/LAN; Dola chỉ ra 16:9 hoặc 9:16.' : 'Chưa nhập token Seedane — Kết nối web → Seedane.'}</p>` +
          '</div>';
        return `<h4>${kind === 'image' ? t('provider.createImage') : t('provider.createVideo')}</h4><label>${t('provider.useLabel')}<select data-provider="${kind}"><option value="seedvis" ${cur.type === 'seedvis' ? 'selected' : ''}>Seedvis API</option>${seedaneOpt}${webOpt}${gvidsOpt}${museOpt}<option value="orbit" ${cur.type === 'orbit' ? 'selected' : ''}>${t('provider.orbit')}</option></select></label><div data-seedvis-fields="${kind}" ${cur.type === 'seedvis' ? '' : 'hidden'}>${seedvisFields(n, kind, sv)}</div>${seedaneFields}${webHint}${gvidsHint}${museHint}`;
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
      const museHint = document.querySelector(`[data-musechat-hint="${kind}"]`);
      if (museHint) museHint.hidden = select.value !== 'musechat';
      const sdBox = document.querySelector(`[data-seedane-fields="${kind}"]`);
      if (sdBox) sdBox.hidden = !select.value.startsWith('seedane-');
      const sdModel = document.querySelector(`[data-seedane-model-row="${kind}"]`);
      if (sdModel) sdModel.hidden = select.value !== 'seedane-dola';
      // Editing and several versions run on Seedvis only: follow the choice before it is saved.
      const edit = $('#editImage'),
        versions = $('#inspector #nodeVideoVersions');
      if (kind === 'image' && edit) {
        edit.disabled = off;
        edit.title = off ? t('provider.editNeedsSeedvis') : '';
      }
      if (kind === 'video' && versions) {
        if (off) versions.value = '1';
        versions.disabled = off;
      }
    };
    bindFields(kind);
  });
}
// Only the kinds whose provider or Seedvis options changed are sent. Returns the seedvis, web,
// gvids and musechat patches separately; the inspector PATCHes them as b.seedvis, b.web,
// b.gvids and b.musechat.
// Switching to a browser source (orbit/web/gvids/musechat) sets seedvis[kind] = false so the
// server routes it there.
export function readProviderSettings(n) {
  const seedvis = {},
    web = {},
    gvids = {},
    musechat = {},
    seedane = {};
  document.querySelectorAll('[data-provider]').forEach(select => {
    const kind = select.dataset.provider,
      cur = n.providers[kind];
    // Seedane: its own per-kind binding; any other choice turns it off.
    if (select.value.startsWith('seedane-')) {
      if (cur.type !== 'seedane') seedvis[kind] = false;
      if (cur.type === 'web') web[kind] = false;
      if (cur.type === 'gvids') gvids[kind] = false;
      if (cur.type === 'musechat') musechat[kind] = false;
      const next = {
        platform: select.value.slice(8),
        model: document.querySelector(`[data-seedane-model="${kind}"]`)?.value || '2.5',
        account: document.querySelector(`[data-seedane-account="${kind}"]`)?.value.trim() || '',
      };
      if (
        cur.type !== 'seedane' ||
        cur.platform !== next.platform ||
        (next.platform === 'dola' && cur.model !== next.model) ||
        (cur.account || '') !== next.account
      )
        seedane[kind] = next;
      return;
    }
    if (cur.type === 'seedane') seedane[kind] = false;
    if (select.value === 'orbit') {
      if (cur.type !== 'orbit') seedvis[kind] = false;
      if (cur.type === 'web') web[kind] = false;
      if (cur.type === 'gvids') gvids[kind] = false;
      if (cur.type === 'musechat') musechat[kind] = false;
      return;
    }
    if (select.value === 'web') {
      if (cur.type !== 'web') {
        seedvis[kind] = false;
        web[kind] = true;
      }
      if (cur.type === 'gvids') gvids[kind] = false;
      if (cur.type === 'musechat') musechat[kind] = false;
      return;
    }
    if (select.value === 'gvids') {
      if (cur.type !== 'gvids') {
        seedvis[kind] = false;
        gvids[kind] = true;
      }
      if (cur.type === 'web') web[kind] = false;
      if (cur.type === 'musechat') musechat[kind] = false;
      return;
    }
    if (select.value === 'musechat') {
      if (cur.type !== 'musechat') {
        seedvis[kind] = false;
        musechat[kind] = true;
      }
      if (cur.type === 'web') web[kind] = false;
      if (cur.type === 'gvids') gvids[kind] = false;
      return;
    }
    // Seedvis: leaving a browser source clears its flag.
    if (cur.type === 'web') web[kind] = false;
    if (cur.type === 'gvids') gvids[kind] = false;
    if (cur.type === 'musechat') musechat[kind] = false;
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
  return { seedvis, web, gvids, musechat, seedane };
}
function showSeedvis(o) {
  seedvisStatus = o;
  $('#seedvisStatus').textContent = o.configured
    ? [
        o.message,
        'key ' + o.keyHint,
        o.account?.plan ? t('provider.accountPlan', { plan: o.account.plan }) : '',
        o.account?.balance != null ? t('provider.accountBalance', { balance: o.account.balance }) : '',
        o.source === 'env' ? t('provider.envSource') : '',
        // The exact model ids the account exposes (from /models) — so a model the app's catalog
        // does not list yet (e.g. a distinct "Google Omni Flash" id) is visible for debugging.
        Array.isArray(o.available) && o.available.length
          ? t('provider.accountModels', { models: o.available.join(', ') })
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : o.message;
  $('#seedvisKey').placeholder = o.configured ? t('provider.replaceKey') : t('provider.pasteKey');
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
      seedvisStatus.error ? seedvisStatus.message : t('provider.seedvisSaved'),
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
  if (!confirm(t('provider.seedvisRemoveConfirm'))) return;
  try {
    showSeedvis(await api('/api/seedvis/key', { method: 'POST', body: { key: null } }));
    await refresh();
    toast(t('provider.seedvisRemoved'));
  } catch (e) {
    toast(e.message, true);
  }
};

export function showOrbit(o) {
  orbitStatus = o;
  $('#orbitStatus').textContent = o.message;
  $('#orbitInventory').textContent = o.authenticated
    ? t('provider.orbitInventory', { profiles: o.profiles.length, apps: (o.apps || []).length, workflows: o.workflows.length, flows: o.flows.length })
    : '';
  $('#orbitLogin').hidden = !!o.authenticated;
  $('#logoutOrbit').hidden = !o.authenticated;
  $('#workerBadge').textContent = store.state.worker?.online
    ? '● ' + t('provider.workerConnected', { count: store.state.worker.count || 1 })
    : o.authenticated
      ? '● Orbit: ' + o.user.email
      : '◐ ' + t('provider.orbitLogin');
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
    toast(t('provider.orbitLoggedIn'));
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
    toast(t('provider.orbitLoggedOut'));
  } catch (e) {
    toast(e.message, true);
  }
};
export function orbitSettings(n, shot) {
  const c = orbitStatus;
  if (!c?.authenticated)
    return '<section class="inspector-section"><h3>' + t('provider.orbitSettings') + '</h3><p>' + t('provider.orbitLoginHint') + '</p></section>';
  const scripts = [
    ...(c.apps || []).map(s => ({ ...s, type: 'app', label: 'App' })),
    ...c.workflows.map(s => ({ ...s, type: 'workflow', label: 'Kịch bản' })),
    ...c.flows.map(s => ({ ...s, type: 'flow', label: 'Khối' })),
  ];
  return (
    '<section class="inspector-section"><h3>' + t('provider.orbitSettings') + '</h3><p>' + t('provider.orbitChooseHint') + '</p>' +
    (shot ? ['image', 'video'] : ['image'])
      .map(kind => {
        const saved = n.orbit?.[kind],
          value = saved ? saved.type + ':' + saved.scriptId : '';
        return (
          '<h4>' +
          (kind === 'image' ? t('provider.createImage') : t('provider.createVideo')) +
          '</h4><label>' + t('provider.workflow') + '<select data-orbit-select data-orbit-script="' +
          kind +
          '"><option value="">Chọn kịch bản…</option>' +
          (!value || scripts.some(s => s.type + ':' + s.id === value)
            ? ''
            : '<option selected value="' +
              esc(value) +
              '">' + t('provider.accessRevoked') + '</option>') +
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
          '</select></label><label>' + t('provider.profile') + '<select data-orbit-select data-orbit-profile="' +
          kind +
          '"><option value="">Chọn nick…</option>' +
          (!saved?.profileId || c.profiles.some(p => p.id === saved.profileId)
            ? ''
            : '<option selected value="' +
              esc(saved.profileId) +
              '">' + t('provider.profileRevoked') + '</option>') +
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
    '<p class="muted">' + t('provider.orbitJobHint') + '</p></section>'
  );
}

export function outputSettings(n, shot) {
  return (
    '<section class="inspector-section"><h3>' + t('provider.outputTitle') + '</h3><p class="field-hint">' + t('provider.orbitFolder') + ': ' +
    esc(store.state.outputDirectory) +
    '</p>' +
    (shot ? ['image', 'video'] : ['image'])
      .map(
        kind =>
          '<label>' +
          t('provider.fileName') + ' ' +
          (kind === 'image' ? t('provider.image') : t('provider.video')) +
          ' <code class="variable-tag">{{mv_output_filename}}</code><input data-output-pattern="' +
          kind +
          '" value="' +
          esc(
            n.outputNaming?.[kind] ||
              (kind === 'image' ? '{node_id}_{job_id}.png' : '{node_id}_{job_id}.mp4'),
          ) +
          '"></label><p class="field-hint" data-output-preview="' +
          kind +
          '">' + t('provider.example') + ': ' +
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
    '<p class="field-hint">' + t('provider.outputPatternHint') + '</p></section>'
  );
}
export function updateOutputPreview() {
  document.querySelectorAll('[data-output-pattern]').forEach(e => {
    document.querySelector('[data-output-preview="' + e.dataset.outputPattern + '"]').textContent =
      t('provider.example') + ': ' +
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
  // Độ nét ảnh tham chiếu: chỉ hiện khi nguồn ảnh là Seedvis VÀ model ảnh đang chọn thật sự có
  // mức nâng cỡ ("nếu có"). Mức nào model không nhận thì server tự hạ, nên danh sách lấy theo
  // đúng model đang chọn, không phải toàn catalog.
  {
    const up = $('#defaultSheetUpscale');
    const upRow = $('#defaultSheetUpscaleRow');
    if (up && upRow) {
      const chosen = (cat.image || []).find(m => m.id === $('#defaultImageModel')?.value);
      const levels = chosen?.upscale || [];
      upRow.hidden = img.value !== 'seedvis' || levels.length < 2;
      if (!upRow.hidden) {
        up.innerHTML = levels
          .map(v => `<option value="${esc(v)}">${v === 'none' ? 'Cỡ gốc' : v.toUpperCase()}</option>`)
          .join('');
        if (document.activeElement !== up) {
          const want = d.sheetUpscale || '2k';
          up.value = levels.includes(want) ? want : levels[0];
        }
      }
    }
  }
  const hint = $('#defaultsHint');
  if (hint)
    hint.textContent =
      img.value.startsWith('seedane-') || vid.value.startsWith('seedane-')
        ? 'Nguồn Seedane: mở Seedane, bật API nội bộ và nhập token ở Kết nối web → Seedane. Muse cần nick muse.ai đã đăng nhập trong Seedane.'
        : img.value === 'musechat'
        ? 'Ảnh mặc định tạo bằng Muse chat — cần bật worker Muse chat trong extension và đăng nhập muse.ai.'
        : img.value === 'web'
          ? 'Ảnh mặc định tạo bằng ChatGPT — cần bật worker extension (xem phần ChatGPT).'
          : vid.value === 'gvids'
            ? 'Video mặc định tạo bằng Google Vids — cần bật worker Google Vids trong extension và mở sẵn một tài liệu Google Vids.'
            : vid.value === 'musechat'
              ? 'Video mặc định tạo bằng Muse chat — cần bật worker Muse chat trong extension và đăng nhập muse.ai.'
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
          sheetUpscale: $('#defaultSheetUpscale')?.value || '',
        },
      },
    });
    await refresh();
    toast(t('provider.defaultsSaved'));
  } catch (e) {
    toast(e.message, true);
  }
}
for (const id of [
  '#defaultImage',
  '#defaultVideo',
  '#defaultImageModel',
  '#defaultVideoModel',
  '#defaultSheetUpscale',
])
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
    toast(t('provider.tokenCopied'));
  };

// --- Seedane connection (Kết nối web) ---------------------------------------------------------
function showSeedane(o) {
  const el = $('#seedaneStatus');
  if (!el) return;
  if ($('#seedaneUrl') && document.activeElement !== $('#seedaneUrl')) $('#seedaneUrl').value = o.url || '';
  const acc = o.accounts
    ? ` · Dola ${o.accounts.dola?.ready ?? 0}/${o.accounts.dola?.total ?? 0} nick sẵn sàng · Muse ${o.accounts.muse?.ready ?? 0}/${o.accounts.muse?.total ?? 0}`
    : '';
  el.textContent = !o.ok
    ? 'Không kết nối được Seedane: ' + (o.error || '')
    : !o.configured
      ? `Seedane ${o.version} đang chạy ở ${o.url} — chưa nhập token.`
      : o.error
        ? `Seedane ${o.version} · ${o.error}`
        : `✅ Seedane ${o.version} · ${o.url}${acc}`;
}
async function loadSeedane() {
  try {
    showSeedane(await api('/api/seedane'));
  } catch (e) {
    if ($('#seedaneStatus')) $('#seedaneStatus').textContent = e.message;
  }
}
if ($('#seedaneForm')) {
  loadSeedane();
  $('#seedaneForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const body = { url: $('#seedaneUrl').value.trim() };
      if ($('#seedaneToken').value.trim()) body.token = $('#seedaneToken').value.trim();
      showSeedane(await api('/api/seedane', { method: 'POST', body }));
      await refresh();
      toast('Đã lưu cấu hình Seedane.');
    } catch (err) {
      toast(err.message, true);
    } finally {
      $('#seedaneToken').value = '';
    }
  };
  $('#testSeedane').onclick = loadSeedane;
}
