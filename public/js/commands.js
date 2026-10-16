// First command-console iteration: deterministic studio shortcuts. It delegates execution to the
// existing batch controls, so command behavior stays identical to the normal UI actions.
import { $, api, esc, toast, triggerDownload } from './core.js';
import { store } from './store.js';
import { refresh } from './render.js';
import { getLocale, t } from './i18n.js';
const msg = (key, vars = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key));

const HISTORY_KEY = 'mv-command-history';
let history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
let awaitingApproval = false;
function confirmPlan(title, items = [], { guard = true } = {}) {
  if (awaitingApproval) return Promise.resolve(false);
  awaitingApproval = true;
  const projectId = store.state.activeProjectId;
  const revision = store.state.revision;
  const panel = $('#commandPreview');
  $('#commandPreviewTitle').textContent = title;
  const shown = items.slice(0, 20);
  $('#commandPreviewItems').innerHTML =
    shown.map(item => `<li>${esc(item)}</li>`).join('') +
    (items.length > shown.length
      ? `<li>${esc(t('assistant.andMore').replace('{count}', items.length - shown.length))}</li>`
      : '');
  panel.hidden = false;
  $('#commandRun').disabled = true;
  $('#commandUndo').disabled = true;
  return new Promise(resolve => {
    const finish = accepted => {
      panel.hidden = true;
      $('#commandRun').disabled = false;
      $('#commandUndo').disabled = false;
      awaitingApproval = false;
      if (
        guard &&
        accepted &&
        (store.state.activeProjectId !== projectId || store.state.revision !== revision)
      ) {
        result(t('assistant.previewExpired'), true);
        resolve(false);
      } else resolve(accepted);
    };
    $('#commandApprove').onclick = () => finish(true);
    $('#commandCancel').onclick = () => finish(false);
  });
}
function renderHistory() {
  const el = $('#commandHistory');
  if (!el) return;
  el.innerHTML = history.length
    ? history
        .slice(0, 10)
        .map(
          (h, i) =>
            `<button class="history-row" type="button" data-history-index="${i}"><span>${String(h.command || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</span><small>${new Date(h.at).toLocaleTimeString()}</small></button>`,
        )
        .join('')
    : `<span class="field-hint">${t('command.empty')}</span>`;
}
const remember = entry => {
  history = [entry, ...history].slice(0, 30);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
  document.querySelectorAll('[data-history-index]').forEach(el => {
    el.onclick = () => {
      const item = history[Number(el.dataset.historyIndex)];
      if (!item) return;
      $('#commandInput').value = item.command || '';
      $('#commandInput').focus();
    };
  });
};

const zones = {
  'nhân vật': 'character',
  characters: 'character',
  character: 'character',
  'trang phục': 'wardrobe',
  'vật dụng': 'wardrobe',
  wardrobe: 'wardrobe',
  'bối cảnh': 'design',
  locations: 'design',
  production: 'production',
  'sản xuất': 'production',
  制作: 'production',
  生产: 'production',
  プロダクション: 'production',
  제작: 'production',
  lipsync: 'lipsync',
  'hát nhép': 'lipsync',
};

function result(text, error = false) {
  const el = $('#commandResult');
  if (el) el.textContent = text;
  if (error) toast(text, true);
}
const fold = value =>
  String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

async function runCommand(rawOverride = null) {
  if (awaitingApproval) return;
  const raw =
    typeof rawOverride === 'string' ? rawOverride : $('#commandInput')?.value.trim() || '';
  const s = raw.toLowerCase();
  if (!s) return result(t('command.enterFirst'), true);
  // Gói GIAO HÀNG (video + ảnh đặt tên theo node, folder nhom/, 7 bước kịch bản) — 0 token, không
  // qua AI. Nhận khi nói "giao hàng / xuất bản dựng / đóng gói dữ liệu", hoặc "đóng gói" trơn mà
  // KHÔNG nhắc tới project/backup (đó là kiểu sao lưu bên dưới).
  if (
    /(giao hàng|giao hang|deliver|handoff|xuất bản|xuat ban|đóng gói dữ liệu|dong goi du lieu|đóng gói giao|dong goi giao)/i.test(
      s,
    ) ||
    (/(đóng gói|dong goi|package|export|zip|nén|nen|打包|封装|パッケージ|패키지)/i.test(s) &&
      !/(dự án|du an|project|projects|sao lưu|sao luu|backup|项目|專案|プロジェクト|프로젝트)/i.test(s))
  ) {
    try {
      const plan = await api('/api/package/plan');
      const mb =
        plan.bytes >= 1024 ** 3
          ? `${(plan.bytes / 1024 ** 3).toFixed(2)} GB`
          : `${(plan.bytes / 1024 ** 2).toFixed(1)} MB`;
      if (
        !(await confirmPlan(`Đóng gói giao hàng “${plan.name}” · ${mb}`, [
          `${plan.clips} video + ${plan.images} ảnh — đặt tên theo node, clip/ảnh của nhóm trong thư mục nhom/`,
          `${plan.steps} bước kịch bản + prompts.json + bible.json + manifest`,
          ...(plan.skipped ? [`bỏ qua ${plan.skipped} clip thiếu file`] : []),
          ...(plan.imageSkipped ? [`bỏ qua ${plan.imageSkipped} ảnh thiếu file`] : []),
        ]))
      )
        return;
      triggerDownload('/api/package', plan.name);
      return result('Đang tải gói giao hàng (0 token, không qua AI).');
    } catch (e) {
      return result(e.message, true);
    }
  }
  // SAO LƯU project: snapshot project.json + media để mở lại sau (không phải gói giao hàng).
  // Recognize the intent independently of word order: all, one/current, or a named project.
  if (
    /(đóng gói|dong goi|sao lưu|backup|package|export|zip|nén|nen|打包|封装|パッケージ|バックアップ|백업|패키지)/i.test(
      s,
    ) &&
    /(dự án|du an|project|projects|项目|專案|プロジェクト|프로젝트)/i.test(s)
  ) {
    const all = /(tất cả|toàn bộ|mọi|\ball\b|\bevery\b|所有|全部|すべて|全て|모든|전체)/i.test(s);
    const single =
      /(?:\b1\b|một|mot|\bone\b|\bsingle\b|chỉ)\s+(?:project|dự án|du an|项目|專案|プロジェクト|프로젝트)/i.test(
        s,
      ) ||
      /(?:project|dự án|du an)\s+này|hiện tại|đang mở|\bcurrent\b|\bthis project\b|当前|这个|この|現在|현재|이 프로젝트/i.test(
        s,
      );
    if (all && single) return result(t('command.packageScopeConflict'), true);
    const named = !all
      ? (store.state.projects || [])
          .filter(p => {
            const name = fold(p.name);
            return (
              name.length >= 3 && !['project', 'du an'].includes(name) && fold(raw).includes(name)
            );
          })
          .sort((a, b) => b.name.length - a.name.length)
      : [];
    if (named.length > 1 && named[0].name.length === named[1].name.length)
      return result(t('command.packageNameAmbiguous'), true);
    if (!named.length && /(?:dự án|du an|project)\s+(?:tên|named)\s+\S+/i.test(s))
      return result(t('command.packageNameNotFound'), true);
    const selectedId = named[0]?.id || null;
    const scope = selectedId ? 'project' : single ? 'current' : 'all';
    const query = `scope=${scope}` + (selectedId ? `&id=${encodeURIComponent(selectedId)}` : '');
    try {
      const plan = await api(`/api/projects/package/plan?${query}`);
      const size =
        plan.bytes >= 1024 ** 3
          ? `${(plan.bytes / 1024 ** 3).toFixed(2)} GB`
          : plan.bytes >= 1024 ** 2
            ? `${(plan.bytes / 1024 ** 2).toFixed(1)} MB`
            : `${Math.ceil(plan.bytes / 1024)} KB`;
      const title = msg('command.packagePreview', {
        projects: plan.projects.length,
        files: plan.mediaCount,
        size,
      });
      if (
        !(await confirmPlan(
          title,
          plan.projects.map(p => `${p.name} · ${p.mediaCount} ${t('command.packageMedia')}`),
        ))
      )
        return;
      const filename = `mv-director-${scope === 'all' ? 'all-projects' : 'project'}-${new Date().toISOString().slice(0, 10)}.zip`;
      triggerDownload(`/api/projects/package?${query}`, filename);
      remember({
        type: 'package',
        project: store.state.activeProjectId,
        command: raw,
        at: Date.now(),
      });
      return result(t('command.packageStarted'));
    } catch (e) {
      return result(e.message, true);
    }
  }
  // Basic localized aliases map to the same deterministic intents.
  if (
    /生成.*角色|角色.*生成|キャラクター.*生成|캐릭터.*생성|(?:create|generate|render).*character images?/.test(
      s,
    )
  ) {
    $('#imageZone').value = 'character';
    result(`${t('command.batchImageRecognized')} ${t('command.openConfirmation')}`);
    $('#autoImageStart').click();
    return;
  }
  if (
    /生成.*视频|视频.*生成|動画.*生成|비디오.*생성|(?:create|generate|render).*production videos?/.test(
      s,
    )
  ) {
    $('#videoZone').value = 'production';
    if (/muse|뮤즈|ムース/.test(s)) $('#videoProvider').value = 'musechat';
    result(`${t('command.batchVideoRecognized')} ${t('command.openConfirmation')}`);
    $('#autoVideoZoneStart').click();
    return;
  }
  if (/^(undo|hoàn tác|hoan tac|撤销|取り消し|실행 취소)$/i.test(s)) {
    const last = history.find(
      h =>
        h.project === store.state.activeProjectId &&
        ['edges', 'providers', 'sequence', 'node-edit'].includes(h.type),
    );
    if (!last) return result(t('command.noUndo'), true);
    if (
      !(await confirmPlan(
        last.type === 'providers'
          ? t('command.undoProvider')
          : last.type === 'sequence'
            ? t('command.undoSequence')
            : last.type === 'node-edit'
              ? 'Hoàn tác chỉnh sửa node?'
              : t('command.undoGraph'),
        last.before.map(item =>
          item.id
            ? store.state.nodes.find(n => n.id === item.id)?.name || item.id
            : `${item.source} → ${item.target}`,
        ),
      ))
    )
      return;
    if (last.type === 'edges')
      await api('/api/edges', { method: 'PUT', body: { edges: last.before } });
    else for (const item of last.before) await api('/api/node', { method: 'PATCH', body: item });
    history = history.filter(h => h !== last);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    await refresh();
    return result(
      last.type === 'providers'
        ? t('command.providerUndone')
        : last.type === 'sequence'
          ? t('command.sequenceUndone')
          : last.type === 'node-edit'
            ? 'Đã hoàn tác chỉnh sửa node.'
            : t('command.graphUndone'),
    );
  }
  if (
    /sắp xếp|sap xep|arrange|排序|並べ替え|정렬/.test(s) &&
    /khu|zone|workflow|graph|区域|ワークフロー|그래프/.test(s)
  ) {
    const before = store.state.nodes
      .filter(n => !n.terminal && Number.isFinite(Number(n.seq)))
      .map(n => ({ id: n.id, seq: n.seq }));
    if (
      !(await confirmPlan(
        t('command.arrangeConfirm'),
        before.map(item => store.state.nodes.find(n => n.id === item.id)?.name || item.id),
      ))
    )
      return;
    try {
      remember({
        type: 'sequence',
        project: store.state.activeProjectId,
        before,
        command: raw,
        at: Date.now(),
      });
      await api('/api/nodes/arrange', { method: 'POST', body: {} });
      await refresh();
      return result(t('command.arranged'));
    } catch (e) {
      return result(e.message, true);
    }
  }
  if (
    /(đổi|doi|change|switch|切换|切替|変更|변경)/.test(s) &&
    /(video|视频|動画|비디오)/.test(s) &&
    /muse|뮤즈|ムース|缪斯/.test(s)
  ) {
    const targets = store.state.nodes.filter(
      n => !n.terminal && n.zone === 'production' && !/cận mặt|close[- ]?up/i.test(n.name),
    );
    if (!targets.length) return result(t('command.noMatchingProduction'), true);
    result(msg('command.previewProvider', { count: targets.length }));
    if (
      !(await confirmPlan(
        `${t('command.switchProviderConfirm')} ${targets.length} ${t('command.shotsToMuse')}`,
        targets.map(n => n.name),
      ))
    )
      return;
    try {
      remember({
        type: 'providers',
        project: store.state.activeProjectId,
        before: targets.map(n => ({
          id: n.id,
          seedvis: n.seedvis,
          musechat: n.musechat,
          web: n.web,
          gvids: n.gvids,
        })),
        command: raw,
        at: Date.now(),
      });
      for (const n of targets)
        await api('/api/node', {
          method: 'PATCH',
          body: {
            id: n.id,
            seedvis: { video: false },
            musechat: { video: true },
            web: { video: false },
            gvids: { video: false },
          },
        });
      await refresh();
      result(msg('command.providerChanged', { count: targets.length }));
    } catch (e) {
      result(e.message, true);
    }
    return;
  }
  // Connect by display names, e.g. "Nối Main Stage vào các shot Chorus". Names are
  // intentionally matched as substrings so a user can address a numbered shot family.
  if (
    /(nối|kết nối|connect|连接|接続|연결)/.test(s) &&
    !/(sân khấu 3d|3d stage|舞台|ステージ|무대)/.test(s) &&
    /(?:^|\s)(vào|to|into|đến|到|へ|에)(?:\s|$)/.test(s)
  ) {
    const m = s.match(
      /(?:nối|kết nối|connect|连接|接続|연결)\s+(.+?)\s+(?:vào|to|into|đến|到|へ|에)\s+(?:các?\s+)?(.+)$/i,
    );
    if (m) {
      const sourceText = m[1].replace(/\b(all|tất cả|所有|すべての|모든)\b/g, '').trim();
      const targetText = m[2].replace(/\b(shot|shots|node|nodes|节点|ショット|노드)\b/g, '').trim();
      const source = store.state.nodes.find(
        n => !n.terminal && n.name?.toLowerCase().includes(sourceText),
      );
      const targets = store.state.nodes.filter(
        n => !n.terminal && n.name?.toLowerCase().includes(targetText),
      );
      if (!source) return result(`${t('command.sourceNotFound')}: “${sourceText}”.`, true);
      if (!targets.length) return result(`${t('command.targetNotFound')}: “${targetText}”.`, true);
      const old = new Set(store.state.edges.map(e => e.source + '>' + e.target));
      const additions = targets
        .filter(n => n.id !== source.id && !old.has(source.id + '>' + n.id))
        .map(n => ({ source: source.id, target: n.id }));
      result(
        msg('command.previewConnections', {
          source: source.name,
          targets: targets.length,
          count: additions.length,
        }),
      );
      if (
        !additions.length ||
        !(await confirmPlan(
          `${t('command.addConnectionsConfirm')} ${additions.length}?`,
          additions.map(
            e =>
              `${source.name} → ${store.state.nodes.find(n => n.id === e.target)?.name || e.target}`,
          ),
        ))
      )
        return;
      try {
        remember({
          type: 'edges',
          project: store.state.activeProjectId,
          before: store.state.edges,
          command: raw,
          at: Date.now(),
        });
        await api('/api/edges', {
          method: 'PUT',
          body: { edges: [...store.state.edges, ...additions] },
        });
        await refresh();
        result(msg('command.connectionsAdded', { count: additions.length }));
      } catch (e) {
        result(e.message, true);
      }
      return;
    }
  }
  if (/thống kê|thong ke|summary|tổng quan|统计|統計|概要|요약|현황/.test(s)) {
    const nodes = store.state.nodes.filter(n => !n.terminal);
    const images = nodes.filter(n => n.image).length;
    const videos = nodes.filter(
      n => n.video || store.state.nodes.some(x => x.terminal && x.source === n.id && x.video),
    ).length;
    const stale = nodes.filter(n => n.stale && n.image).length;
    return result(msg('command.summary', { nodes: nodes.length, images, videos, stale }));
  }
  if (
    /(nối|kết nối|connect|连接|接続|연결)/.test(s) &&
    /(sân khấu 3d|3d stage|舞台|ステージ|무대)/.test(s)
  ) {
    const stages = store.state.nodes.filter(n => n.stageOnly || n.role === 'stage');
    const targets = store.state.nodes.filter(n => !n.terminal && n.zone === 'production');
    if (!stages.length) return result(t('command.noStageNode'), true);
    if (!targets.length) return result(t('command.noProductionShots'), true);
    const old = new Set(store.state.edges.map(e => e.source + '>' + e.target));
    const additions = stages.flatMap(stage =>
      targets
        .filter(target => !old.has(stage.id + '>' + target.id))
        .map(target => ({ source: stage.id, target: target.id })),
    );
    result(
      msg('command.previewStageConnections', {
        stages: stages.length,
        targets: targets.length,
        count: additions.length,
      }),
    );
    if (
      !additions.length ||
      !(await confirmPlan(
        `${t('command.addConnectionsConfirm')} ${additions.length} ${t('command.toGraph')}?`,
        additions.map(
          e =>
            `${store.state.nodes.find(n => n.id === e.source)?.name || e.source} → ${store.state.nodes.find(n => n.id === e.target)?.name || e.target}`,
        ),
      ))
    )
      return;
    try {
      remember({
        type: 'edges',
        project: store.state.activeProjectId,
        before: store.state.edges,
        command: raw,
        at: Date.now(),
      });
      await api('/api/edges', {
        method: 'PUT',
        body: { edges: [...store.state.edges, ...additions] },
      });
      await refresh();
      result(msg('command.connectionsAdded', { count: additions.length }));
    } catch (e) {
      result(e.message, true);
    }
    return;
  }
  const imageMatch = s.match(/(?:tạo|render) (?:tất cả )?ảnh (?:ở|khu|khu vực) (.+)$/i);
  if (imageMatch) {
    const zone = zones[imageMatch[1].trim()];
    if (!zone) return result(t('command.imageZoneUnknown'), true);
    $('#imageZone').value = zone;
    result(
      `${t('command.batchImageRecognized')} ${imageMatch[1].trim()}. ${t('command.openConfirmation')}`,
    );
    $('#autoImageStart').click();
    return;
  }
  const videoMatch = s.match(/(?:tạo|render) (?:tất cả )?video (?:ở|khu|khu vực) (.+)$/i);
  if (videoMatch) {
    const requestedZone = videoMatch[1]
      .trim()
      .replace(/[,;].*$/, '')
      .trim();
    const zone = zones[requestedZone];
    if (!zone || !['production', 'lipsync'].includes(zone))
      return result(t('command.videoZoneUnsupported'), true);
    $('#videoZone').value = zone;
    if (/muse/.test(s)) $('#videoProvider').value = 'musechat';
    else if (/google\s*vids/.test(s)) $('#videoProvider').value = 'gvids';
    else if (/seedvis/.test(s)) $('#videoProvider').value = 'seedvis';
    window.mvVideoBatchOptions = {
      excludeCloseups:
        /bỏ qua.*(cận mặt|cận cảnh)|skip.*close[- ]?up|除外.*特写|近景を除外|클로즈업.*제외/i.test(
          s,
        ),
    };
    result(
      `${t('command.batchVideoRecognized')} ${requestedZone}. ${t('command.openConfirmation')}`,
    );
    $('#autoVideoZoneStart').click();
    return;
  }
  if (
    /(node|shot|节点|ショット|노드)/.test(s) &&
    /(chưa có video|thiếu video|没有视频|動画なし|비디오 없음)/.test(s)
  ) {
    const count = store.state.nodes.filter(n => !n.terminal && n.image && !n.video).length;
    return result(`${t('command.videoMissingPrefix')} ${count} ${t('command.videoMissingSuffix')}`);
  }
  if (/chưa có ảnh|thiếu ảnh|missing image|没有图片|画像なし|이미지 없음/.test(s)) {
    const nodes = store.state.nodes.filter(n => !n.terminal && !n.image);
    return result(
      nodes.length
        ? `${t('command.imageMissingPrefix')} ${nodes.length}: ${nodes
            .slice(0, 5)
            .map(n => n.name)
            .join(', ')}${nodes.length > 5 ? '…' : ''}`
        : t('command.noMissingImages'),
    );
  }
  const staleMatch = s.match(
    /(?:tạo lại|render lại) (?:tất cả )?ảnh stale (?:ở|khu|khu vực) (.+)$/i,
  );
  if (staleMatch) {
    const zone = zones[staleMatch[1].trim()];
    if (!zone) return result(t('command.staleZoneUnknown'), true);
    const count = store.state.nodes.filter(n => !n.terminal && n.zone === zone && n.stale).length;
    if (!count) return result(`${t('command.noStaleImages')} ${staleMatch[1].trim()}.`);
    $('#imageZone').value = zone;
    result(msg('command.staleFound', { count }));
    $('#autoImageStart').click();
    return;
  }
  const versionMatch = s.match(/(?:version|phiên bản)\s*([1-8])/);
  if (versionMatch && /video|shot|node/.test(s)) {
    $('#videoVersions').value = versionMatch[1];
    $('#videoZone').value = 'production';
    result(
      `${t('command.version2Recognized')} ${versionMatch[1]}. ${t('command.openConfirmation')}`,
    );
    $('#autoVideoZoneStart').click();
    return;
  }
  if (/stale|cần tạo ảnh lại|ảnh lỗi thời/.test(s)) {
    const nodes = store.state.nodes.filter(n => !n.terminal && n.stale && n.image);
    return result(
      nodes.length
        ? `${t('command.stalePrefix')} ${nodes.length}: ${nodes
            .slice(0, 5)
            .map(n => n.name)
            .join(', ')}${nodes.length > 5 ? '…' : ''}`
        : t('command.noStaleNodes'),
    );
  }
  result(t('command.unsupported'), true);
}

let assistantClaudeStatus = null;
const ASSISTANT_CHAT_KEY = 'mv-assistant-conversations-v1';
let assistantChats = {};
let renderedAssistantProject = null;
let renderedUsageProject = null;
let renderedLearnedProject = null;
let assistantLearningPending = false;
let learnedRefreshTimer = null;
const tokenCount = value => (Number(value) || 0).toLocaleString();
function usageLabel(usage) {
  const u = usage?.usage || usage || {};
  return (
    `Token: ${tokenCount(u.inputTokens)} vào + ${tokenCount(u.outputTokens)} ra` +
    (u.cacheCreationTokens || u.cacheReadTokens
      ? ` · cache ghi ${tokenCount(u.cacheCreationTokens)}, đọc ${tokenCount(u.cacheReadTokens)}`
      : '')
  );
}
async function loadAssistantUsage() {
  const projectId = assistantProjectId();
  if (!projectId) return;
  try {
    const data = await api('/api/assistant/usage');
    if (projectId !== assistantProjectId() || data.projectId !== projectId) return;
    renderedUsageProject = projectId;
    $('#assistantUsageTotal').textContent = tokenCount(
      data.total.inputTokens +
        data.total.outputTokens +
        data.total.cacheCreationTokens +
        data.total.cacheReadTokens,
    );
    $('#assistantUsageHistory').innerHTML = data.history.length
      ? data.history
          .map(
            row =>
              `<div class="assistant-usage-row"><strong>${esc(row.step || 'Claude')}</strong> · ${esc(new Date(row.at).toLocaleString())}<br>` +
              `${esc(row.request || '')}<br><span>${esc(usageLabel(row))} · ${esc(row.model || '')}</span></div>`,
          )
          .join('')
      : 'Chưa có lần gọi Claude nào.';
  } catch (error) {
    $('#assistantUsageHistory').textContent = error.message;
  }
}
async function loadAssistantLearned() {
  const projectId = assistantProjectId();
  if (!projectId) return;
  try {
    const data = await api('/api/assistant/learned');
    if (projectId !== assistantProjectId() || data.projectId !== projectId) return;
    renderedLearnedProject = projectId;
    const active = data.commands.filter(row => row.status === 'active');
    assistantLearningPending = data.commands.some(row => row.status === 'pending');
    $('#assistantLearnedCount').textContent = String(active.length);
    $('#assistantLearnedList').innerHTML = data.commands.length
      ? data.commands
          .map(
            row =>
              `<div class="assistant-usage-row">${esc(row.request)} <span>· ${row.status === 'active' ? 'Đã học · 0 token lần sau' : 'Chờ job hoàn tất'}${row.scope === 'global' ? ' · 🌐 mọi project' : ''}</span></div>`,
          )
          .join('')
      : 'Chưa có lệnh sửa nào được học.';
  } catch (error) {
    $('#assistantLearnedList').textContent = error.message;
  }
}
// Kỹ năng Trợ lý — standing instructions the assistant always applies.
let assistantSkills = [];
async function loadAssistantSkills() {
  const projectId = assistantProjectId();
  if (!projectId) return;
  try {
    const data = await api('/api/assistant/skills');
    if (projectId !== assistantProjectId() || data.projectId !== projectId) return;
    assistantSkills = data.skills || [];
    renderAssistantSkills();
  } catch (error) {
    if ($('#assistantSkillsList')) $('#assistantSkillsList').textContent = error.message;
  }
}
function renderAssistantSkills() {
  if (!$('#assistantSkillsCount')) return;
  $('#assistantSkillsCount').textContent = String(assistantSkills.filter(s => s.enabled).length);
  $('#assistantSkillsList').innerHTML = assistantSkills.length
    ? assistantSkills
        .map(
          s =>
            `<div class="assistant-usage-row"><label><input type="checkbox" data-skill-toggle="${s.id}" ${s.enabled ? 'checked' : ''}> <b>${esc(s.name)}</b></label> <span>· ${s.scope === 'global' ? '🌐 mọi project' : 'project này'}</span><br><span>${esc(s.text).replace(/\n/g, '<br>')}</span><br><button type="button" class="text-button" data-skill-edit="${s.id}">Sửa</button> · <button type="button" class="text-button" data-skill-del="${s.id}">Xóa</button></div>`,
        )
        .join('')
    : 'Chưa có kỹ năng nào. Làm một việc ưng ý rồi bấm “📌 Nhớ việc → kỹ năng”, hoặc “+ Thêm kỹ năng”.';
  document
    .querySelectorAll('[data-skill-toggle]')
    .forEach(cb => (cb.onchange = () => toggleSkill(cb.dataset.skillToggle, cb.checked)));
  document
    .querySelectorAll('[data-skill-edit]')
    .forEach(b => (b.onclick = () => openSkillEditor(assistantSkills.find(x => x.id === b.dataset.skillEdit))));
  document
    .querySelectorAll('[data-skill-del]')
    .forEach(b => (b.onclick = () => deleteSkill(b.dataset.skillDel)));
}
function openSkillEditor(skill = {}) {
  const box = $('#assistantSkillEditor');
  if (!box) return;
  box.hidden = false;
  box.innerHTML =
    `<label>Tên kỹ năng<input id="skillName" value="${esc(skill.name || '')}"></label>` +
    `<label>Nội dung — luật Trợ lý luôn áp (mỗi dòng một luật)<textarea id="skillText" rows="5">${esc(skill.text || '')}</textarea></label>` +
    `<label>Phạm vi<select id="skillScope"><option value="global" ${skill.scope !== 'project' ? 'selected' : ''}>Mọi project</option><option value="project" ${skill.scope === 'project' ? 'selected' : ''}>Chỉ project này</option></select></label>` +
    `<div class="actions"><button id="skillSave" class="button primary" type="button">Lưu kỹ năng</button><button id="skillCancel" class="button" type="button">Hủy</button></div>`;
  $('#skillSave').onclick = async () => {
    try {
      const r = await api('/api/assistant/skills/save', {
        method: 'POST',
        body: { id: skill.id, name: $('#skillName').value, text: $('#skillText').value, scope: $('#skillScope').value },
      });
      assistantSkills = r.skills;
      box.hidden = true;
      box.innerHTML = '';
      renderAssistantSkills();
      toast('Đã lưu kỹ năng.');
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('#skillCancel').onclick = () => {
    box.hidden = true;
    box.innerHTML = '';
  };
}
async function toggleSkill(id, enabled) {
  try {
    const r = await api('/api/assistant/skills/toggle', { method: 'POST', body: { id, enabled } });
    assistantSkills = r.skills;
    renderAssistantSkills();
  } catch (e) {
    toast(e.message, true);
    loadAssistantSkills();
  }
}
async function deleteSkill(id) {
  if (!confirm('Xóa kỹ năng này?')) return;
  try {
    const r = await api('/api/assistant/skills/delete', { method: 'POST', body: { id } });
    assistantSkills = r.skills;
    renderAssistantSkills();
  } catch (e) {
    toast(e.message, true);
  }
}
try {
  const saved = JSON.parse(localStorage.getItem(ASSISTANT_CHAT_KEY) || '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) assistantChats = saved;
} catch {}
const assistantProjectId = () => store.state?.activeProjectId || '';
const assistantMessages = (projectId = assistantProjectId()) =>
  Array.isArray(assistantChats[projectId]) ? assistantChats[projectId] : [];
function saveAssistantChats() {
  try {
    localStorage.setItem(ASSISTANT_CHAT_KEY, JSON.stringify(assistantChats));
  } catch {}
}
function assistantText(value) {
  return esc(String(value || '')).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}
function renderAssistantConversation(forceBottom = false) {
  const container = $('#assistantConversation');
  const projectId = assistantProjectId();
  if (!container || !projectId) return;
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
  const messages = assistantMessages(projectId);
  container.innerHTML = messages.length
    ? messages
        .map(message => {
          const user = message.role === 'user';
          const details =
            Array.isArray(message.details) && message.details.length
              ? `<ul class="assistant-message-details">${message.details
                  .slice(0, 20)
                  .map(item => `<li>${assistantText(item)}</li>`)
                  .join('')}</ul>`
              : '';
          const at = new Date(message.at || Date.now()).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });
          const name = user ? t('assistant.you') : t('assistant.name');
          return (
            `<article class="assistant-message ${user ? 'user' : 'assistant'} ${message.kind === 'error' ? 'error' : ''}">` +
            `<span class="assistant-avatar" aria-hidden="true">${user ? 'U' : '✦'}</span>` +
            `<div class="assistant-message-main"><div class="assistant-message-bubble">${assistantText(message.content)}</div>${details}` +
            `<span class="assistant-message-meta">${esc(name)} · ${esc(at)}${message.usage ? ` · ${esc(usageLabel(message.usage))}` : ''}</span></div></article>`
          );
        })
        .join('')
    : `<div class="assistant-empty"><strong>${esc(t('assistant.welcomeTitle'))}</strong>${esc(t('assistant.welcome'))}</div>`;
  renderedAssistantProject = projectId;
  if (forceBottom || wasNearBottom)
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
}
function addAssistantMessage(role, content, extra = {}) {
  const projectId = extra.projectId || assistantProjectId();
  if (!projectId || !content) return null;
  const message = {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    role: role === 'user' ? 'user' : 'assistant',
    content: String(content).slice(0, 5000),
    details: Array.isArray(extra.details) ? extra.details.map(String).slice(0, 20) : [],
    kind: extra.kind || 'text',
    usage: extra.usage || null,
    at: Date.now(),
  };
  assistantChats[projectId] = [...assistantMessages(projectId), message].slice(-60);
  saveAssistantChats();
  renderAssistantConversation(true);
  return message;
}
function assistantHistory(projectId = assistantProjectId()) {
  return assistantMessages(projectId)
    .filter(message => ['user', 'assistant'].includes(message.role) && message.kind !== 'error')
    .slice(-12)
    .map(message => ({ role: message.role, content: message.content }));
}
function setAssistantTyping(active) {
  const typing = $('#assistantTyping');
  if (!typing) return;
  typing.hidden = !active;
  if (active)
    requestAnimationFrame(() => {
      const container = $('#assistantConversation');
      if (container) container.scrollTop = container.scrollHeight;
    });
}
function showAssistantClaudeStatus() {
  const s = assistantClaudeStatus;
  const plan = $('#assistantClaudeVia').value === 'claude';
  $('#assistantClaudeApiFields').hidden = plan;
  $('#assistantClaudeStatus').textContent = plan
    ? s?.planAvailable
      ? `Gói Claude qua Claude Code · model ${s.planModel} · không tốn API key`
      : 'Chưa thấy Claude Code trên máy. Cài: npm i -g @anthropic-ai/claude-code, rồi chạy `claude` và gõ /login.'
    : s?.keyHint
      ? `Claude: ${s.model} · key ${s.keyHint} · Workspace ${s.workspaceConfigured ? s.workspaceId : 'chưa nhập'}`
      : 'Chưa cấu hình Claude API key. Key chỉ lưu trên máy chạy app.';
}
$('#assistantClaudeVia').onchange = showAssistantClaudeStatus;
// Model picker: a dropdown of common models that drives the model-id field; "custom" reveals it.
const MODEL_OPTIONS = ['claude-sonnet-4-6', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
function syncModelSelect() {
  const sel = $('#assistantClaudeModelSelect');
  const input = $('#assistantClaudeModel');
  if (!sel || !input) return;
  const custom = !MODEL_OPTIONS.includes(input.value);
  sel.value = custom ? '__custom__' : input.value;
  const row = input.closest('label');
  if (row) row.hidden = !custom;
}
$('#assistantClaudeModelSelect')?.addEventListener?.('change', e => {
  const input = $('#assistantClaudeModel');
  const row = input?.closest('label');
  if (e.target.value === '__custom__') {
    if (row) row.hidden = false;
    input?.focus?.();
  } else {
    if (input) input.value = e.target.value;
    if (row) row.hidden = true;
  }
});
async function loadAssistantClaudeStatus() {
  try {
    assistantClaudeStatus = await api('/api/assistant/claude');
    $('#assistantClaudeVia').value = assistantClaudeStatus.via;
    showAssistantClaudeStatus();
    $('#assistantClaudeModel').value = assistantClaudeStatus.model;
    syncModelSelect();
    $('#assistantClaudeWorkspace').value = assistantClaudeStatus.workspaceId || '';
    $('#assistantClaudeWebSearch').checked = !!assistantClaudeStatus.webSearch;
  } catch (error) {
    $('#assistantClaudeStatus').textContent = error.message;
  }
}
$('#assistantClaudeSave').onclick = async () => {
  try {
    assistantClaudeStatus = await api('/api/assistant/claude', {
      method: 'POST',
      body: {
        via: $('#assistantClaudeVia').value,
        key: $('#assistantClaudeKey').value,
        model: $('#assistantClaudeModel').value.trim(),
        workspaceId: $('#assistantClaudeWorkspace').value.trim(),
        webSearch: $('#assistantClaudeWebSearch').checked,
      },
    });
    $('#assistantClaudeKey').value = '';
    $('#assistantClaudeWorkspace').value = assistantClaudeStatus.workspaceId || '';
    showAssistantClaudeStatus();
    result('Đã lưu cấu hình Claude cho Trợ lý đạo diễn.');
  } catch (error) {
    result(error.message, true);
  }
};

async function executeAssistantAction(action, command) {
  if (action.type === 'create_node') {
    const before = new Set(store.state.nodes.map(n => n.id));
    const kind = action.kind === 'shot' ? undefined : action.kind;
    store.state = await api('/api/nodes', {
      method: 'POST',
      body: {
        kind,
        name: action.name,
        desc: action.desc,
        config: action.config,
        settingType: action.settingType,
      },
    });
    const created = store.state.nodes.find(n => !before.has(n.id) && !n.terminal);
    if (created && Object.keys(action.content || {}).length)
      store.state = await api('/api/node', {
        method: 'PATCH',
        body: { id: created.id, ...action.content },
      });
    if (created) result(`Đã tạo node “${created.name}”.`);
    await refresh();
  } else if (action.type === 'edit_node') {
    const node = store.state.nodes.find(n => n.id === action.nodeId && !n.terminal);
    if (!node) throw new Error('Node cần sửa không còn tồn tại.');
    const before = { id: node.id };
    for (const key of Object.keys(action.changes))
      before[key] = node[key] ?? (key === 'duration' ? 8 : key === 'start' ? 0 : '');
    store.state = await api('/api/node', {
      method: 'PATCH',
      body: { id: node.id, ...action.changes },
    });
    remember({
      type: 'node-edit',
      project: store.state.activeProjectId,
      before: [before],
      command,
      at: Date.now(),
    });
    await refresh();
  } else if (action.type === 'edit_stage') {
    // Sửa kết quả một bước của xưởng kịch bản, rồi (tuỳ chọn) chạy tiếp các bước sau. Lưu
    // trước, chạy sau: nếu chạy lỗi thì bản sửa vẫn còn trên node để xem lại.
    const node = store.state.nodes.find(n => n.id === action.nodeId);
    if (!node) throw new Error('Node Kịch bản không còn tồn tại.');
    const before = { id: node.id, stages: { ...(node.stages || {}) } };
    store.state = await api('/api/node', {
      method: 'PATCH',
      body: { id: node.id, stages: { [action.stage]: action.text } },
    });
    remember({
      type: 'stage-edit',
      project: store.state.activeProjectId,
      before: [before],
      command,
      at: Date.now(),
    });
    result(`Đã sửa bước “${action.stage}”.`);
    if (action.rerun) {
      store.state = await api('/api/script/run', {
        method: 'POST',
        body: { id: node.id, from: action.stage, via: node.via || 'api' },
      });
      result('Đang chạy tiếp từ bước này.');
    }
    await refresh();
  } else if (action.type === 'connect') {
    const before = store.state.edges.map(e => ({ source: e.source, target: e.target }));
    store.state = await api('/api/edges', {
      method: 'PUT',
      body: { edges: [...before, ...action.additions] },
    });
    remember({
      type: 'edges',
      project: store.state.activeProjectId,
      before,
      command,
      at: Date.now(),
    });
    await refresh();
  } else if (action.type === 'delete_edge') {
    // Remove wires by rewriting the edge set without them (the API PUT replaces the whole list).
    const before = store.state.edges.map(e => ({ source: e.source, target: e.target }));
    const gone = new Set((action.removals || []).map(e => `${e.source}>${e.target}`));
    store.state = await api('/api/edges', {
      method: 'PUT',
      body: { edges: before.filter(e => !gone.has(`${e.source}>${e.target}`)) },
    });
    remember({ type: 'edges', project: store.state.activeProjectId, before, command, at: Date.now() });
    await refresh();
  } else if (action.type === 'delete_node') {
    // One API call per node; the server refuses a node that is not user-added (not "node-…").
    for (const id of action.nodeIds || [])
      store.state = await api('/api/nodes/delete', { method: 'POST', body: { id } });
    result(`Đã xóa ${(action.nodeIds || []).length} node.`);
    await refresh();
  } else if (action.type === 'remember_last') {
    // Ask the server to learn the most recent learnable command it ran for this project.
    const r = await api('/api/assistant/remember-last', { method: 'POST', body: {} });
    if (r.learned) {
      loadAssistantLearned();
      result(`✅ Đã ghi nhớ “${r.request}” vào bộ nhớ agent — lần sau tự chạy 0 token.`);
    } else {
      result(r.reason || 'Chưa có lệnh nào để ghi nhớ.', true);
    }
  } else if (action.type === 'lipsync_prompt') {
    // Append/replace the extra direction on every lip-sync take's Omni prompt, then rewrite them.
    store.state = await api('/api/music/lipsync-extra', {
      method: 'POST',
      body: { instruction: action.instruction, append: action.append },
    });
    const r = store.state.relipsyncSummary || {};
    await refresh();
    result(`Đã cập nhật prompt Omni cho ${r.updated || 0}/${r.total || 0} take lip-sync — video cũ cần quay lại.`);
  } else if (action.type === 'set_provider') {
    const before = action.nodeIds
      .map(id => store.state.nodes.find(n => n.id === id))
      .filter(Boolean)
      .map(n => ({
        id: n.id,
        seedvis: n.seedvis,
        musechat: n.musechat,
        web: n.web,
        gvids: n.gvids,
      }));
    remember({
      type: 'providers',
      project: store.state.activeProjectId,
      before,
      command,
      at: Date.now(),
    });
    for (const id of action.nodeIds) {
      const isMuse = action.provider === 'musechat',
        isVids = action.provider === 'gvids';
      const seedvis =
        action.provider === 'seedvis'
          ? store.state.seedvisDefaults?.video || {
              model: 'Veo-3.1',
              aspectRatio: '16:9',
              upscale: 'none',
            }
          : false;
      store.state = await api('/api/node', {
        method: 'PATCH',
        body: {
          id,
          seedvis: { video: seedvis },
          musechat: { video: isMuse },
          gvids: { video: isVids },
          web: { video: false },
        },
      });
    }
    await refresh();
  } else if (action.type === 'arrange') {
    const before = store.state.nodes
      .filter(n => !n.terminal && Number.isFinite(Number(n.seq)))
      .map(n => ({ id: n.id, seq: n.seq }));
    store.state = await api('/api/nodes/arrange', { method: 'POST', body: {} });
    remember({
      type: 'sequence',
      project: store.state.activeProjectId,
      before,
      command,
      at: Date.now(),
    });
    await refresh();
  } else if (action.type === 'package') {
    if (action.deliverable) {
      // Gói giao hàng: video + ảnh đặt tên theo node, folder nhom/, 7 bước kịch bản.
      const plan = await api('/api/package/plan');
      triggerDownload('/api/package', plan.name);
      result(
        `Đang tải gói giao hàng: ${plan.clips} video + ${plan.images} ảnh (đặt tên theo node; nhóm trong thư mục nhom/), ${plan.steps} bước kịch bản.`,
      );
    } else {
      const query =
        `scope=${action.scope}` +
        (action.projectId ? `&id=${encodeURIComponent(action.projectId)}` : '');
      const size = await api(`/api/projects/package/plan?${query}`);
      if (!size.projects?.length) throw new Error('Không có project nào để đóng gói.');
      triggerDownload(
        `/api/projects/package?${query}`,
        `mv-director-${action.scope}-${new Date().toISOString().slice(0, 10)}.zip`,
      );
    }
  } else if (action.type === 'summary') {
    const nodes = store.state.nodes.filter(n => !n.terminal);
    const videos = nodes.filter(
      n => n.video || store.state.nodes.some(x => x.terminal && x.source === n.id && x.video),
    ).length;
    result(
      `Project: ${nodes.length} node · ${nodes.filter(n => n.image).length} có ảnh · ${videos} có video · ${nodes.filter(n => n.stale && n.image).length} ảnh cũ.`,
    );
  } else if (action.type === 'edit_image') {
    const queued = await api('/api/jobs', {
      method: 'POST',
      body: { nodeId: action.nodeId, kind: 'image', edit: action.instruction },
    });
    await refresh();
    result('Đã xếp tác vụ sửa ảnh. Theo dõi tiến độ trong hàng đợi.');
    return queued.job?.id || null;
  } else if (action.type === 'image_node') {
    // Tạo ảnh cho MỘT node/shot (khác image_zone chạy cả nhóm). Async; trả jobId như edit_image.
    const queued = await api('/api/jobs', {
      method: 'POST',
      body: { nodeId: action.nodeId, kind: 'image', count: action.count || 1 },
    });
    await refresh();
    result('Đã xếp tác vụ tạo ảnh cho shot. Theo dõi tiến độ trong hàng đợi.');
    return queued.job?.id || null;
  } else if (action.type === 'run_recipe') {
    store.state = await api('/api/recipes/start', {
      method: 'POST',
      body: {
        recipeId: action.recipeId,
        steps: action.steps,
        name: action.name,
        triggers: action.triggers,
        auto: action.auto,
        learn: action.learn,
      },
    });
    renderRecipe();
    result('Quy trình đã bắt đầu — theo dõi ở ô "Quy trình" của Trợ lý.');
  } else if (action.type === 'image_zone') {
    $('#imageZone').value = action.zone;
    $('#autoImageStart').click(); // the existing batch controller handles capture and errors
  } else if (action.type === 'video_zone') {
    $('#videoZone').value = action.zone;
    $('#videoProvider').value = action.provider || '';
    window.mvVideoBatchOptions = { excludeCloseups: action.excludeCloseups };
    $('#autoVideoZoneStart').click(); // keeps the app's stale-image and render confirmations
  } else if (action.type === 'stage_3d') {
    // Pin the proposed 3D marks (if any), then render with the Topview 3D engine: a layout image
    // and/or a camera-move preview video. With shotId the marks override just that shot (per-shot);
    // clear removes that override; otherwise they stage the whole scene. Server-side; slow.
    if (action.cameraOnly) {
      // Camera-only: a camera move over an empty stage, attached to the node's video. No marks.
      store.state = await api('/api/stage3d/topview-camera', {
        method: 'POST',
        body: {
          sceneId: action.sceneId,
          shotId: action.shotId,
          move: action.move,
          seconds: action.seconds,
        },
      });
      const r = store.state.topview3dCamera || {};
      result(`🎥 Video quỹ đạo máy 3D (${r.move || action.move}) — sàn trống.`);
      await refresh();
      return null;
    }
    if (action.clear && action.shotId) {
      store.state = await api('/api/stage3d/shot', {
        method: 'POST',
        body: { shotId: action.shotId, clear: true },
      });
      result('↩ Đã bỏ dàn dựng riêng của khung hình — về theo cảnh.');
    } else if (action.performers && action.performers.length) {
      if (action.shotId) {
        store.state = await api('/api/stage3d/shot', {
          method: 'POST',
          body: {
            shotId: action.shotId,
            stage: { size: { w: 8, d: 6 }, performers: action.performers, dialogue: action.dialogue },
          },
        });
        result(`Đã dàn dựng riêng cho khung hình (${action.performers.length} nhân vật, đè lên cảnh).`);
      } else {
        store.state = await api('/api/stage3d', {
          method: 'POST',
          body: {
            sceneId: action.sceneId,
            stage: { size: { w: 6, d: 5 }, performers: action.performers, dialogue: action.dialogue },
          },
        });
        result(`Đã ghim dàn dựng 3D cho cả cảnh (${action.performers.length} nhân vật).`);
      }
    }
    if (action.render === 'image' || action.render === 'both') {
      store.state = await api('/api/stage3d/topview', {
        method: 'POST',
        body: { sceneId: action.sceneId, shotId: action.shotId },
      });
      const r = store.state.topview3d || {};
      result(`🎬 Ảnh layout 3D: ${r.done}/${r.total}` + (r.errors?.length ? ` · ⚠ ${r.errors[0]}` : ''));
    }
    if (action.render === 'video' || action.render === 'both') {
      store.state = await api('/api/stage3d/topview-video', {
        method: 'POST',
        body: {
          sceneId: action.sceneId,
          shotId: action.shotId,
          move: action.move,
          cluster: action.cluster,
          seconds: action.seconds,
        },
      });
      const r = store.state.topview3dVideo || {};
      const made = action.cluster ? `cụm ${r.clips} cảnh` : `${r.clips?.length || 0} cảnh`;
      result(`🎥 Video preview 3D: ${made} (${r.move})` + (r.errors?.length ? ` · ⚠ ${r.errors[0]}` : ''));
    }
    await refresh();
  }
}

// --- Quy trình: a whole run the tool steers itself (lib/recipes.mjs) -------------------------
let recipeList = null;
async function loadRecipes() {
  try {
    recipeList = (await api('/api/recipes')).recipes || [];
  } catch {
    recipeList = [];
  }
  renderRecipe();
}
const RUN_STATE = {
  running: 'đang chạy',
  paused: 'chờ xác nhận',
  failed: 'lỗi — bấm Tiếp tục để chạy lại bước',
  done: 'xong',
  stopped: 'đã dừng',
};
function renderRecipe() {
  const box = $('#assistantRecipeRun');
  if (!box || !store.state) return; // the project state is not loaded yet: the poll redraws
  const run = store.state.recipeRun;
  $('#assistantRecipeState').textContent = run
    ? `${run.name} · ${RUN_STATE[run.status] || run.status}`
    : 'chưa chạy';
  if (!run) box.innerHTML = '<em>Chưa có quy trình nào chạy. Chọn một quy trình bên dưới, hoặc nhắn "chạy toàn bộ".</em>';
  else {
    const mark = i =>
      i < run.step
        ? '✅'
        : i > run.step
          ? '·'
          : { running: '⏳', paused: '⏸', failed: '❌', done: '✅', stopped: '■' }[run.status] || '·';
    const rows = run.steps
      .map((s, i) => {
        const note = (run.log || []).find(l => l.step === i)?.note;
        return `<div class="assistant-usage-row">${mark(i)} ${esc(run.labels?.[i] || s.type)}${note ? `<br><span>${esc(note)}</span>` : ''}</div>`;
      })
      .join('');
    const buttons =
      (['paused', 'failed'].includes(run.status)
        ? `<button class="button primary" id="recipeContinue">▶ ${run.status === 'failed' || run.redo ? 'Chạy lại bước này' : 'Tiếp tục'}</button> `
        : '') +
      (['running', 'paused', 'failed'].includes(run.status)
        ? '<button class="button" id="recipeStop">■ Dừng</button> '
        : '') +
      (run.zip ? '<button class="button" id="recipeZip">⤓ Tải zip</button>' : '');
    box.innerHTML =
      `<div><b>${esc(run.label || '')}</b>${run.error ? `<br><b>${esc(run.error)}</b>` : ''}` +
      (run.zip ? `<br><span>Zip đã ghi: ${esc(run.zip.dir)}\\${esc(run.zip.name)}</span>` : '') +
      (run.learned
        ? `<br><span>Đã học quy trình "${esc(run.learned.name)}" — lần sau nhắn: ${esc(run.learned.triggers.join(' / '))}</span>`
        : '') +
      '</div>' +
      rows +
      `<div class="actions">${buttons}</div>`;
    const act = (sel, path) => {
      if ($(sel))
        $(sel).onclick = async () => {
          try {
            store.state = await api(path, { method: 'POST', body: {} });
            renderRecipe();
          } catch (e) {
            result(e.message, true);
          }
        };
    };
    act('#recipeContinue', '/api/recipes/continue');
    act('#recipeStop', '/api/recipes/stop');
    if ($('#recipeZip')) $('#recipeZip').onclick = () => triggerDownload('/api/package', run.zip.name);
  }
  const list = $('#assistantRecipeList');
  if (!recipeList) return;
  list.innerHTML = recipeList
    .map(
      r =>
        `<div class="assistant-usage-row"><strong>${esc(r.name)}</strong> <span>· ${r.steps.length} bước · nhắn: ${esc((r.triggers || []).slice(0, 3).join(' / '))}</span><br>` +
        `<button class="button" data-recipe="${esc(r.id)}">▶ Chạy (có dừng hỏi)</button> ` +
        `<button class="button" data-recipe="${esc(r.id)}" data-auto="1">▶ Chạy hết</button>` +
        (r.builtin ? '' : ` <button class="button" data-recipe-del="${esc(r.id)}">✕</button>`) +
        '</div>',
    )
    .join('');
  for (const b of list.querySelectorAll('[data-recipe]'))
    b.onclick = async () => {
      try {
        store.state = await api('/api/recipes/start', {
          method: 'POST',
          body: { recipeId: b.dataset.recipe, auto: b.dataset.auto === '1' },
        });
        renderRecipe();
      } catch (e) {
        result(e.message, true);
      }
    };
  for (const b of list.querySelectorAll('[data-recipe-del]'))
    b.onclick = async () => {
      if (!confirm('Xoá quy trình này?')) return;
      try {
        recipeList = (await api('/api/recipes/delete', { method: 'POST', body: { id: b.dataset.recipeDel } })).recipes;
        renderRecipe();
      } catch (e) {
        result(e.message, true);
      }
    };
}
if ($('#assistantRecipePanel')) {
  loadRecipes();
  // the run's progress comes with /api/state (polled); a recipe that just finished learning
  // refreshes the list once
  let lastSig = '';
  setInterval(() => {
    if (!store.state) return;
    const run = store.state.recipeRun;
    const sig = run ? `${run.id}:${run.status}:${run.step}:${run.label}:${(run.log || []).length}` : '';
    if (sig === lastSig && $('#assistantRecipeList').childElementCount) return;
    if (run?.learned && lastSig && !lastSig.endsWith(`:${run.status}:${run.step}:${run.label}:${(run.log || []).length}`)) loadRecipes();
    lastSig = sig;
    renderRecipe();
  }, 2000);
}

// Files attached to the NEXT assistant message. Context for that one request only: the server
// never stores them in the project, and they are cleared as soon as the message is sent.
const MAX_ASSISTANT_FILES = 4;
const MAX_ASSISTANT_FILE_MB = 12;
let assistantFiles = [];

function renderAssistantFiles() {
  const box = $('#assistantFiles');
  if (!box) return;
  box.hidden = !assistantFiles.length;
  box.innerHTML = assistantFiles
    .map(
      (f, i) =>
        `<span class="assistant-file-chip">${f.mime.startsWith('image/') ? '\u{1F5BC}' : '\u{1F4C4}'} ` +
        `<span class="assistant-file-name">${esc(f.name)}</span>` +
        `<button type="button" class="assistant-file-drop" data-drop-file="${i}" ` +
        `title="Bỏ tệp này" aria-label="Bỏ ${esc(f.name)}">\u00d7</button></span>`,
    )
    .join('');
}

const readFileBase64 = file =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL gives "data:<mime>;base64,<payload>" — the server wants the payload alone.
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Không đọc được tệp "${file.name}".`));
    reader.readAsDataURL(file);
  });

async function addAssistantFiles(fileList) {
  const picked = Array.from(fileList || []);
  if (!picked.length) return;
  for (const file of picked) {
    if (assistantFiles.length >= MAX_ASSISTANT_FILES) {
      toast(`Tối đa ${MAX_ASSISTANT_FILES} tệp cho một tin nhắn.`, true);
      break;
    }
    if (file.size > MAX_ASSISTANT_FILE_MB * 1024 * 1024) {
      toast(`Tệp "${file.name}" lớn hơn ${MAX_ASSISTANT_FILE_MB} MB.`, true);
      continue;
    }
    try {
      assistantFiles.push({
        name: file.name,
        // Browsers leave .srt/.md with an empty type; the server falls back to the extension.
        mime: file.type || 'text/plain',
        base64: await readFileBase64(file),
      });
    } catch (e) {
      toast(e.message, true);
    }
  }
  renderAssistantFiles();
}

$('#assistantAttach')?.addEventListener('click', () => $('#assistantFileInput')?.click());
$('#assistantFileInput')?.addEventListener('change', async e => {
  await addAssistantFiles(e.target.files);
  e.target.value = ''; // so picking the same file again still fires a change
});
$('#assistantFiles')?.addEventListener('click', e => {
  const drop = e.target.closest('[data-drop-file]');
  if (!drop) return;
  assistantFiles.splice(Number(drop.dataset.dropFile), 1);
  renderAssistantFiles();
});

// Kéo-thả tệp vào bất cứ đâu trong panel trợ lý, và dán ảnh (Ctrl+V) khi đang gõ trong panel.
// Chỉ nhận khi con trỏ thật sự mang TỆP — kéo node trên canvas đi ngang qua thì không tính.
const draggingFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
const assistantDock = $('#assistantDock');
if (assistantDock) {
  // dragenter/dragleave bắn theo từng phần tử con, nên phải đếm để viền không nhấp nháy.
  let dragDepth = 0;
  const clearDrag = () => {
    dragDepth = 0;
    assistantDock.classList.remove('file-drop');
  };
  assistantDock.addEventListener('dragenter', e => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    assistantDock.classList.add('file-drop');
  });
  assistantDock.addEventListener('dragover', e => {
    if (!draggingFiles(e)) return;
    // Không chặn mặc định thì trình duyệt MỞ tệp và mất hết trạng thái đang làm.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  assistantDock.addEventListener('dragleave', e => {
    if (!draggingFiles(e)) return;
    if (--dragDepth <= 0) clearDrag();
  });
  assistantDock.addEventListener('drop', async e => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    clearDrag();
    await addAssistantFiles(e.dataTransfer.files);
  });
  assistantDock.addEventListener('paste', async e => {
    const pasted = Array.from(e.clipboardData?.files || []);
    if (!pasted.length) return; // dán chữ bình thường thì để nguyên
    e.preventDefault();
    // Ảnh chụp màn hình từ clipboard đều tên "image.png" — đặt lại tên để hai chip không trùng nhau.
    const stamp = Date.now();
    await addAssistantFiles(
      pasted.map((f, i) =>
        !f.name || f.name === 'image.png'
          ? new File([f], `dan-${stamp}${i ? '-' + i : ''}.png`, { type: f.type || 'image/png' })
          : f,
      ),
    );
  });
}

async function runAssistant() {
  if (awaitingApproval) return;
  const request = $('#commandInput').value.trim();
  if (!request) return result(t('command.enterFirst'), true);
  const requestProjectId = assistantProjectId();
  const requestRevision = store.state.revision;
  const recentHistory = assistantHistory(requestProjectId);
  const sentFiles = assistantFiles;
  addAssistantMessage(
    'user',
    sentFiles.length ? `${request}\n\n\u{1F4CE} ${sentFiles.map(f => f.name).join(', ')}` : request,
  );
  assistantFiles = []; // the files belong to this message; a failure must not resend them silently
  renderAssistantFiles();
  $('#commandInput').value = '';
  $('#commandInput').style.height = '';
  const button = $('#commandRun');
  button.disabled = true;
  try {
    result('Đang chọn lệnh nhanh hoặc lập kế hoạch…');
    setAssistantTyping(true);
    const plan = await api('/api/assistant/plan', {
      method: 'POST',
      body: {
        request,
        history: recentHistory,
        projectId: requestProjectId,
        revision: requestRevision,
        attachments: sentFiles,
        directorDraft: {
          idea: $('#directorIdea')?.value || '',
          script: $('#agentScriptText')?.value || '',
          blueprint: $('#blueprintInput')?.value || '',
        },
      },
    });
    if (plan.source === 'claude') loadAssistantUsage();
    setAssistantTyping(false);
    if (plan.question) {
      addAssistantMessage('assistant', plan.question, {
        projectId: requestProjectId,
        usage: plan.usage,
      });
      return result(plan.question);
    }
    if (!plan.actions?.length) throw new Error('Claude chưa tạo được bước thực hiện.');
    const summary =
      (plan.source === 'quick'
        ? 'Lệnh nhanh · 0 token. '
        : plan.source === 'learned'
          ? 'Lệnh đã học · 0 token. '
          : '') + (plan.summary || `Đã lập ${plan.actions.length} bước. Xem trước để xác nhận.`);
    addAssistantMessage('assistant', summary, {
      kind: 'plan',
      details: plan.preview || [],
      projectId: requestProjectId,
      usage: plan.usage,
    });
    result(summary);
    if (plan.actions.every(action => action.type === 'summary')) {
      remember({ type: 'ai-plan', project: plan.projectId, command: request, at: Date.now() });
      return;
    }
    if (!(await confirmPlan(summary, plan.preview || []))) {
      addAssistantMessage('assistant', t('assistant.planCancelled'), {
        projectId: requestProjectId,
      });
      return;
    }
    const latest = await api('/api/state');
    if (latest.activeProjectId !== plan.projectId || latest.revision !== plan.revision)
      throw new Error(t('assistant.previewExpired'));
    store.state = latest;
    const jobIds = [];
    for (const action of plan.actions) {
      if (store.state.activeProjectId !== plan.projectId)
        throw new Error('Project đã đổi trong khi thực hiện.');
      const jobId = await executeAssistantAction(action, request);
      if (action.type === 'edit_image' && jobId) jobIds.push(jobId);
    }
    remember({ type: 'ai-plan', project: plan.projectId, command: request, at: Date.now() });
    if (!plan.actions.some(a => a.type === 'summary')) {
      const done = msg('assistant.planDone', { count: plan.actions.length });
      addAssistantMessage('assistant', done, { projectId: requestProjectId });
      result(done);
    }
    // The run succeeded. Offer to remember it so the same request replays at 0 token next time
    // (only Claude plans with deterministic, learnable actions can be replayed safely).
    if (plan.source === 'claude' && plan.learnable && plan.planId) {
      const save = await confirmPlan(
        `💾 Lưu ghi nhớ công việc này vào bộ nhớ? Lần sau gặp lệnh “${request}” sẽ chạy 0 token (không gọi Claude).`,
        plan.preview || [],
        { guard: false },
      );
      if (save) {
        // Portable commands (zone-addressed, e.g. set_provider) can serve every project; ask where.
        let scope = 'project';
        if (plan.portable) {
          const global = await confirmPlan(
            '🌐 Dùng lệnh này cho MỌI project? Chọn Hủy nếu chỉ muốn dùng trong project hiện tại.',
            plan.preview || [],
            { guard: false },
          );
          scope = global ? 'global' : 'project';
        }
        try {
          await api('/api/assistant/learn', {
            method: 'POST',
            body: { planId: plan.planId, jobIds, scope },
          });
          loadAssistantLearned();
          addAssistantMessage(
            'assistant',
            scope === 'global'
              ? '✅ Đã lưu vào bộ nhớ dùng chung. Lần sau gặp lệnh này ở BẤT KỲ project nào, tôi sẽ chạy ngay với 0 token.'
              : '✅ Đã lưu vào bộ nhớ của project này. Lần sau gặp lệnh tương tự, tôi sẽ chạy ngay với 0 token.',
            { projectId: requestProjectId },
          );
        } catch (learnError) {
          addAssistantMessage('assistant', `Chưa lưu được vào bộ nhớ: ${learnError.message}`, {
            kind: 'error',
            projectId: requestProjectId,
          });
        }
      }
    }
  } catch (error) {
    if (/Chưa nhập Claude API key|Chưa thấy Claude Code|chưa đăng nhập gói/.test(error.message)) $('#assistantClaudeSettings').open = true;
    addAssistantMessage('assistant', error.message, { kind: 'error', projectId: requestProjectId });
    result(error.message, true);
  } finally {
    setAssistantTyping(false);
    button.disabled = false;
  }
}

const dispatchCommand = raw => runCommand(raw).catch(error => result(error.message, true));
$('#commandRun').onclick = () => runAssistant();
$('#commandQuickRun').onclick = () => dispatchCommand();
$('#commandUndo').onclick = () => dispatchCommand('undo');
$('#commandInput').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    runAssistant();
  }
};
$('#commandInput').oninput = e => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
};
$('#assistantClearChat').onclick = () => {
  const projectId = assistantProjectId();
  if (!projectId || !assistantMessages(projectId).length) return;
  if (!confirm(t('assistant.clearChatConfirm'))) return;
  delete assistantChats[projectId];
  saveAssistantChats();
  renderAssistantConversation(true);
  result(t('assistant.chatCleared'));
};
$('#assistantClaudeSettings').ontoggle = () => {
  if ($('#assistantClaudeSettings').open && !assistantClaudeStatus) loadAssistantClaudeStatus();
};
const examples = {
  package: {
    vi: 'Đóng gói tất cả dự án',
    en: 'Package all projects',
    zh: '打包所有项目',
    ja: 'すべてのプロジェクトをパッケージ',
    ko: '모든 프로젝트 패키지',
  },
  summary: {
    vi: 'Thống kê project',
    en: 'Project summary',
    zh: '项目统计',
    ja: 'プロジェクト概要',
    ko: '프로젝트 요약',
  },
  images: {
    vi: 'Tạo ảnh ở nhân vật',
    en: 'Create character images',
    zh: '生成角色图片',
    ja: 'キャラクター生成',
    ko: '캐릭터 생성',
  },
  videos: {
    vi: 'Tạo video ở Production',
    en: 'Render Production videos',
    zh: '生成视频',
    ja: '動画生成',
    ko: '비디오 생성',
  },
  provider: {
    vi: 'Đổi video Production sang Muse Chat',
    en: 'Change Production video to Muse Chat',
    zh: '切换 Production 视频到 Muse Chat',
    ja: 'Production 動画を Muse Chat に変更',
    ko: 'Production 비디오를 Muse Chat로 변경',
  },
};
document.querySelectorAll('[data-command-example]').forEach(button => {
  button.onclick = () => {
    $('#commandInput').value =
      examples[button.dataset.commandExample]?.[getLocale()] ||
      examples[button.dataset.commandExample]?.vi ||
      '';
    $('#commandInput').focus();
  };
});
renderHistory();
renderAssistantConversation();
loadAssistantUsage();
loadAssistantLearned();
loadAssistantSkills();
let renderedSkillsProject = assistantProjectId();
$('#assistantAddSkill')?.addEventListener?.('click', () => {
  if ($('#assistantSkillsPanel')) $('#assistantSkillsPanel').open = true;
  openSkillEditor();
});
// "Nhớ việc → kỹ năng": the agent distils the recent satisfactory work into a reusable skill.
$('#assistantRememberSkill')?.addEventListener?.('click', async () => {
  const projectId = assistantProjectId();
  const history = assistantHistory(projectId);
  if (!history.length) return result('Chưa có trò chuyện để rút thành kỹ năng.', true);
  const btn = $('#assistantRememberSkill');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Đang tổng hợp…';
  try {
    const r = await api('/api/assistant/skills/synthesize', { method: 'POST', body: { history } });
    if ($('#assistantSkillsPanel')) $('#assistantSkillsPanel').open = true;
    openSkillEditor(r.draft);
    addAssistantMessage('assistant', `Tôi đã rút kỹ năng “${r.draft.name}” từ việc vừa làm — xem lại rồi bấm “Lưu kỹ năng”.`, { projectId });
  } catch (e) {
    result(e.message, true);
    addAssistantMessage('assistant', e.message, { kind: 'error', projectId });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});
document.addEventListener('appstatechange', () => {
  if (assistantProjectId() !== renderedAssistantProject) renderAssistantConversation(true);
  if (assistantProjectId() !== renderedUsageProject) loadAssistantUsage();
  if (assistantProjectId() !== renderedLearnedProject) loadAssistantLearned();
  else if (assistantLearningPending && !learnedRefreshTimer)
    learnedRefreshTimer = setTimeout(() => {
      learnedRefreshTimer = null;
      loadAssistantLearned();
    }, 1500);
  if (assistantProjectId() !== renderedSkillsProject) {
    renderedSkillsProject = assistantProjectId();
    loadAssistantSkills();
  }
});
document.addEventListener('localechange', renderHistory);
document.addEventListener('localechange', () => renderAssistantConversation());
document.querySelectorAll('[data-history-index]').forEach(el => {
  el.onclick = () => {
    const item = history[Number(el.dataset.historyIndex)];
    if (!item) return;
    $('#commandInput').value = item.command || '';
    $('#commandInput').focus();
  };
});
