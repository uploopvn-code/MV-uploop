// Popup UI: shared base URL + token, then two independently-toggled workers (ChatGPT images/text
// and Google Vids video) with live status for each.
const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);

// Show the running version right in the popup header — always know which build is loaded.
try {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
} catch {}

let runChatgpt = false;
let runVids = false;
let runMuseChat = false;

function readCfg() {
  return {
    baseUrl: $('baseUrl').value.trim(),
    token: $('token').value.trim(),
    concChatgpt: Math.max(1, Math.min(6, Number($('concChatgpt').value) || 2)),
    concVids: Math.max(1, Math.min(2, Number($('concVids').value) || 1)),
    promptPrefix: $('prefix').value,
    workerName: $('workerName').value.trim() || 'Drama worker',
  };
}

function paintState(s) {
  runChatgpt = !!s.cfg.runChatgpt;
  runVids = !!s.cfg.runVids;
  runMuseChat = !!s.cfg.runMuseChat;
  $('baseUrl').value = s.cfg.baseUrl || '';
  if (document.activeElement !== $('token')) $('token').value = s.cfg.token || '';
  if (document.activeElement !== $('concChatgpt')) $('concChatgpt').value = s.cfg.concChatgpt || 2;
  if (document.activeElement !== $('concVids')) $('concVids').value = s.cfg.concVids || 1;
  $('prefix').value = s.cfg.promptPrefix || '';
  $('workerName').value = s.cfg.workerName || '';

  $('dotChatgpt').classList.toggle('on', runChatgpt);
  $('stateChatgpt').textContent = runChatgpt
    ? s.activeChatgpt
      ? `Đang chạy ${s.activeChatgpt} job…`
      : 'Đang bật — chờ job'
    : 'Đang tắt';
  $('toggleChatgpt').textContent = runChatgpt ? 'Tắt worker ChatGPT' : 'Bật worker ChatGPT';

  $('dotVids').classList.toggle('on', runVids);
  $('dotVids').classList.toggle('vids', runVids);
  $('stateVids').textContent = runVids
    ? s.activeVids
      ? `Đang dựng ${s.activeVids} video…`
      : 'Đang bật — chờ job'
    : 'Đang tắt';
  $('toggleVids').textContent = runVids ? 'Tắt worker Google Vids' : 'Bật worker Google Vids';

  $('dotMuseChat').classList.toggle('on', runMuseChat);
  $('dotMuseChat').classList.toggle('muse', runMuseChat);
  $('stateMuseChat').textContent = runMuseChat
    ? s.activeMuseChat
      ? `Đang tạo ${s.activeMuseChat} video…`
      : 'Đang bật — chờ job (không giới hạn tab)'
    : 'Đang tắt';
  $('toggleMuseChat').textContent = runMuseChat ? 'Tắt worker Muse chat' : 'Bật worker Muse chat';

  if (s.status) {
    const box = $('status');
    box.textContent =
      s.status + (s.statusAt ? '  ·  ' + new Date(s.statusAt).toLocaleTimeString() : '');
    box.classList.toggle('err', !!s.statusError);
  }
}

async function refresh() {
  try {
    paintState(await send({ type: 'getStatus' }));
  } catch {}
}

// Save config fields (debounced) whenever they change.
let saveTimer = null;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => send({ type: 'setConfig', cfg: readCfg() }), 300);
}
for (const id of ['baseUrl', 'token', 'concChatgpt', 'concVids', 'prefix', 'workerName'])
  $(id).addEventListener('input', queueSave);

$('toggleChatgpt').onclick = async () => {
  clearTimeout(saveTimer); // persist the latest fields first, then flip
  await send({ type: 'setConfig', cfg: readCfg() });
  await send({ type: 'setWorker', worker: 'chatgpt', on: !runChatgpt });
  refresh();
};

$('toggleVids').onclick = async () => {
  clearTimeout(saveTimer);
  await send({ type: 'setConfig', cfg: readCfg() });
  await send({ type: 'setWorker', worker: 'vids', on: !runVids });
  refresh();
};

$('toggleMuseChat').onclick = async () => {
  clearTimeout(saveTimer);
  await send({ type: 'setConfig', cfg: readCfg() });
  await send({ type: 'setWorker', worker: 'musechat', on: !runMuseChat });
  refresh();
};

$('openVids').onclick = () => send({ type: 'openVids' });

$('test').onclick = async () => {
  clearTimeout(saveTimer);
  await send({ type: 'setConfig', cfg: readCfg() });
  $('test').disabled = true;
  $('status').textContent = 'Đang kiểm tra…';
  $('status').classList.remove('err');
  const r = await send({ type: 'testConnection' });
  $('status').textContent = r.message;
  $('status').classList.toggle('err', !r.ok);
  $('test').disabled = false;
};

refresh();
setInterval(refresh, 1500);
