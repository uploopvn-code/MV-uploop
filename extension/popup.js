// Popup UI: configure base URL + token + concurrency, toggle the worker, show live status.
const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);

let running = false;

function readCfg() {
  return {
    baseUrl: $('baseUrl').value.trim(),
    token: $('token').value.trim(),
    concurrency: Math.max(1, Math.min(6, Number($('concurrency').value) || 3)),
    promptPrefix: $('prefix').value,
    workerName: $('workerName').value.trim() || 'ChatGPT extension',
  };
}

function paintState(s) {
  running = !!s.cfg.running;
  $('baseUrl').value = s.cfg.baseUrl || '';
  if (document.activeElement !== $('token')) $('token').value = s.cfg.token || '';
  if (document.activeElement !== $('concurrency')) $('concurrency').value = s.cfg.concurrency || 3;
  $('prefix').value = s.cfg.promptPrefix || '';
  $('workerName').value = s.cfg.workerName || '';
  $('dot').classList.toggle('on', running);
  $('stateText').textContent = running
    ? s.active
      ? `Đang chạy ${s.active} job…`
      : 'Worker đang bật — chờ job'
    : 'Worker đang tắt';
  $('toggle').textContent = running ? 'Tắt worker' : 'Bật worker';
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
for (const id of ['baseUrl', 'token', 'concurrency', 'prefix', 'workerName'])
  $(id).addEventListener('input', queueSave);

$('toggle').onclick = async () => {
  clearTimeout(saveTimer); // persist the latest fields first, then flip
  await send({ type: 'setConfig', cfg: readCfg() });
  await send({ type: running ? 'stop' : 'start' });
  refresh();
};

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
