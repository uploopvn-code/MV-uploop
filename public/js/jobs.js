// Job queue tab.
import { store } from './store.js';
import { $, api, dlUrl, esc, paint, toast } from './core.js';
import { refresh } from './render.js';
import { STATUS_LABELS } from './terminology.js';
import { getLocale, t } from './i18n.js';

// Browser jobs whose original conversation can be checked without sending the prompt again.
const chatgptImage = j => j.kind === 'image' && j.payload.site === 'chatgpt';
const recoverableBrowserJob = j => chatgptImage(j) ||
  (j.payload.site === 'musechat' && ['image', 'video'].includes(j.kind));
// A ChatGPT image not back yet: where it is, what the tool does next, what ChatGPT answered.
function webNotes(j) {
  const reply = j.web?.replyText
    ? `<p>${t('jobs.chatgptReply')}: ${esc(j.web.replyText.slice(0, 300))}</p>`
    : '';
  if (!recoverableBrowserJob(j) || j.status !== 'needs_review') return reply;
  const url = j.web?.conversationUrl;
  return url
    ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">${j.payload.site === 'musechat' ? 'Muse' : t('jobs.openChatgpt')}</a>${j.recoverAt ? ` · ${j.payload.site === 'musechat' ? t('jobs.checkAgain') : t('jobs.autoRecover')} ${new Date(j.recoverAt).toLocaleTimeString(getLocale())}` : ''}</p>${reply}`
    : `<p>${j.payload.site === 'musechat' ? t('jobs.noMuseLink') : t('jobs.noChatgptLink')}</p>${reply}`;
}
// The job's one action: stop waiting, fetch or check its result again, or download it.
function action(j) {
  if (j.status === 'queued') return `<button class="button" data-cancel="${j.id}">${t('jobs.cancelWait')}</button>`;
  if (j.status === 'needs_review' && recoverableBrowserJob(j) && j.web?.conversationUrl)
    return `<button class="button" data-collect="${j.id}">${j.kind === 'image' ? t('jobs.collectImage') : t('jobs.checkAgain')}</button>`;
  if (
    ['needs_review', 'script_completed'].includes(j.status) &&
    (j.payload.output || j.payload.seedvis || j.payload.seedane)
  )
    return `<button class="button" data-collect="${j.id}">${j.payload.seedvis || j.payload.seedane ? t('jobs.checkAgain') : t('jobs.receiveFile')}</button>`;
  if (j.result)
    return `<a class="button" href="${esc(dlUrl(j.result.url, j.result.name || 'ket-qua'))}" download="${esc(j.result.name || 'ket-qua')}">${t('jobs.downloadResult')}</a>`;
  return '<span></span>';
}

export function renderJobs() {
  const accountBox = $('#workerAccounts');
  if (accountBox) {
    const accounts = store.state.workerAccounts || [];
    const accountSelect = $('#queueAccount');
    if (accountSelect) {
      const selected = accountSelect.value;
      accountSelect.innerHTML = `<option value="">${esc(t('queue.allAccounts'))}</option>` + accounts.map(a => `<option value="${esc(a.workerId)}">${esc(a.workerId)}</option>`).join('');
      accountSelect.value = accounts.some(a => a.workerId === selected) ? selected : '';
    }
    const projectSelect = $('#queueProject');
    if (projectSelect) {
      const projects = store.state.projects || [];
      const selected = store.state.activeProjectId;
      projectSelect.innerHTML = projects
        .map(p => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''} ${p.window ? 'disabled' : ''}>${esc(p.name)}</option>`)
        .join('');
    }
    accountBox.innerHTML = accounts.length
      ? accounts
          .map(
            a =>
              `<div class="worker-account ${a.online ? 'online' : ''}"><strong>${esc(a.workerId)}</strong><span>${a.online ? esc(t('queue.online')) : esc(t('queue.offline'))} · ${esc(a.provider || t('queue.worker'))}</span><small>${esc(t('queue.muse'))}: ${a.museActive}/${a.concurrencyLimit || '—'} · ${esc(t('queue.queued'))} ${a.queuedMuse}</small>${a.activeJobs?.length ? `<ul class="worker-job-list">${a.activeJobs.map(j => `<li>${esc(store.state.nodes.find(n => n.id === j.nodeId)?.name || j.nodeId)} · ${esc(t('queue.kind.' + j.kind) || j.kind)}</li>`).join('')}</ul>` : ''}</div>`,
          )
          .join('')
      : `<span class="field-hint">${esc(t('queue.noWorkers'))}</span>`;
  }
  const search = ($('#queueSearch')?.value || '').toLowerCase();
  const provider = $('#queueProvider')?.value || '';
  const account = $('#queueAccount')?.value || '';
  const status = $('#queueStatus')?.value || '';
  const jobs = store.state.jobs.filter(j => {
    const node = store.state.nodes.find(n => n.id === j.nodeId);
    const hay = `${node?.name || ''} ${j.payload?.website || ''} ${j.payload?.site || ''}`.toLowerCase();
    const site = j.payload?.site || (j.payload?.seedvis ? 'seedvis' : j.payload?.orbit ? 'orbit' : '');
    return (!search || hay.includes(search)) && (!provider || site === provider) && (!account || j.worker === account) && (!status || j.status === status);
  });
  paint(
    '#jobs',
    jobs.length
      ? [...jobs]
          .reverse()
          .map(
            j =>
              `<div class="job-row"><div><strong>${esc(store.state.nodes.find(n => n.id === j.nodeId)?.name)} · ${j.kind === 'image' ? t('jobs.image') : t('jobs.video')}</strong><p>${esc(j.payload.website)} · ${new Date(j.createdAt).toLocaleString(getLocale())}</p>${j.progress ? `<p>${esc(j.progress)}</p>` : ''}${j.error ? `<p>${esc(j.error)}</p>` : ''}${j.warning ? `<p>${esc(j.warning)}</p>` : ''}${j.resultStale ? `<p>${t('jobs.inputChanged')}</p>` : ''}${webNotes(j)}</div><span class="badge">${esc(t('status.' + j.status) || STATUS_LABELS[j.status] || j.status)}</span>${action(j)}</div>`,
          )
          .join('')
      : `<div class="empty">${esc(t('queue.empty'))}</div>`,
  );
  document.querySelectorAll('[data-collect]').forEach(
    e =>
      (e.onclick = async () => {
        e.disabled = true;
        const j = store.state.jobs.find(j => j.id === e.dataset.collect);
        try {
          await api('/api/jobs/collect', { method: 'POST', body: { id: e.dataset.collect } });
          await refresh();
          toast(
            j?.payload.seedvis
              ? t('queue.recheckSeedvis')
              : j && recoverableBrowserJob(j)
                ? (j.payload.site === 'musechat' ? t('jobs.checkAgain') : t('queue.recoverChatgpt'))
                : t('queue.fileReceived'),
          );
        } catch (err) {
          toast(err.message, true);
        } finally {
          e.disabled = false;
        }
      }),
  );
  document.querySelectorAll('[data-cancel]').forEach(
    e =>
      (e.onclick = async () => {
        try {
          await api('/api/jobs/cancel', { method: 'POST', body: { id: e.dataset.cancel } });
          await refresh();
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}

document.addEventListener('localechange', () => {
  if (store.state) renderJobs();
});
['queueSearch', 'queueProvider', 'queueAccount', 'queueStatus'].forEach(id =>
  document.getElementById(id)?.addEventListener('input', renderJobs),
);
$('#queueProject')?.addEventListener('change', async e => {
  try {
    await api('/api/projects/switch', { method: 'POST', body: { id: e.target.value } });
    await refresh();
  } catch (err) { toast(err.message, true); }
});
document.querySelectorAll('.queue-pause').forEach(button => button.addEventListener('click', async () => {
  try { await api('/api/jobs/group/pause', { method: 'POST', body: { group: button.dataset.group } }); await refresh(); } catch (e) { toast(e.message, true); }
}));
document.querySelectorAll('.queue-resume').forEach(button => button.addEventListener('click', async () => {
  try { await api('/api/jobs/group/resume', { method: 'POST', body: { group: button.dataset.group } }); await refresh(); } catch (e) { toast(e.message, true); }
}));
document.querySelectorAll('.queue-retry').forEach(button => button.addEventListener('click', async () => {
  try {
    const r = await api('/api/jobs/group/retry', { method: 'POST', body: { group: button.dataset.group } });
    await refresh();
    toast(r.retried ? `${t('queue.retried')} ${r.retried} ${button.dataset.group}.` : `${t('queue.noFailed')} ${button.dataset.group}.`);
  } catch (e) { toast(e.message, true); }
}));
