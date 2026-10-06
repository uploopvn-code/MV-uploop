// Secondary windows: one extra server process per open project.
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { data, isChild, mainPort, port, root } from './config.mjs';
import { activeId, lockOwner, releaseLock, ws } from './projects.mjs';
import { releaseAll } from './sv-slots.mjs';

// --- Secondary windows: one extra server process per project, so several projects can be
// open (each with its own job queue) at the same time. Only the main window spawns them;
// they are killed when it exits and also watch its pid themselves.
export const windows = new Map();
// project id → { port, proc }
const windowUrl = p => `http://127.0.0.1:${p}/`;
export const openWindowList = () =>
  [...windows]
    .filter(([, w]) => w.proc.exitCode === null)
    .map(([id, w]) => ({ id, port: w.port, url: windowUrl(w.port) }));
const portFree = p =>
  new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
async function pickPort() {
  const used = new Set(openWindowList().map(w => w.port));
  for (let p = port + 1; p < port + 50; p++) if (!used.has(p) && (await portFree(p))) return p;
  throw new Error('Không tìm được cổng trống cho cửa sổ mới.');
}
export const mainOnly = what => {
  if (isChild) throw new Error(`${what} ở cửa sổ chính${mainPort ? ` (cổng ${mainPort})` : ''}.`);
};
export async function openWindow(id) {
  mainOnly('Mở cửa sổ mới');
  if (!ws.order.includes(id)) throw new Error('Project không tồn tại.');
  if (id === activeId) throw new Error('Project này đang mở ngay tại cửa sổ này.');
  const existing = windows.get(id);
  if (existing && existing.proc.exitCode === null) return windowUrl(existing.port);
  windows.delete(id);
  const other = lockOwner(id);
  if (other) throw new Error(`Project đang mở ở cửa sổ khác (cổng ${other.port}).`);
  const p = await pickPort();
  const proc = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    env: {
      ...process.env,
      MV_PORT: String(p),
      MV_PROJECT: id,
      MV_PARENT_PID: String(process.pid),
      MV_MAIN_PORT: String(port),
      MV_DATA_DIR: data,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  windows.set(id, { port: p, proc });
  proc.on('exit', () => {
    if (windows.get(id)?.proc === proc) windows.delete(id);
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('Cửa sổ mới không khởi động được.');
    try {
      const r = await fetch(windowUrl(p) + 'api/state');
      await r.text();
      if (r.ok) return windowUrl(p);
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  proc.kill();
  windows.delete(id);
  throw new Error('Cửa sổ mới không phản hồi.');
}
export function closeWindow(id) {
  const w = windows.get(id);
  if (!w) throw new Error('Cửa sổ này không do server mở; hãy đóng tab của nó.');
  w.proc.kill();
  windows.delete(id);
}
export function shutdown() {
  for (const w of windows.values())
    try {
      w.proc.kill();
    } catch {}
  releaseAll(); // hand this window's Seedvis slots back to the other windows at once
  if (activeId) releaseLock(activeId);
}
