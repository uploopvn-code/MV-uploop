// Process-wide settings: app root, data folder, port, secondary-window flags, worker
// token, and the Seedvis / director-LLM clients.
import { createSeedvis } from '../seedvis-client.mjs';
import { createDirectorLLM } from '../director-llm.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The app folder (this file lives in lib/).
export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Projects are saved in a stable folder in the user's home directory, NOT inside the app
// folder — so updating, re-cloning or moving the app never wipes them. An existing
// repo-local data/ is migrated there once. Override with MV_DATA_DIR.
function resolveDataDir() {
  if (process.env.MV_DATA_DIR) return process.env.MV_DATA_DIR;
  const home = path.join(os.homedir(), 'MV-Director-data');
  const legacy = path.join(root, 'data');
  const hasData = d =>
    fs.existsSync(path.join(d, 'workspace.json')) ||
    fs.existsSync(path.join(d, 'projects')) ||
    fs.existsSync(path.join(d, 'project.json'));
  try {
    if (legacy !== home && !hasData(home) && hasData(legacy)) {
      fs.mkdirSync(home, { recursive: true });
      fs.cpSync(legacy, home, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'MOVED-to-home.txt'), 'Dữ liệu đã chuyển sang ' + home);
    }
  } catch (e) {
    console.error('Không di chuyển được dữ liệu cũ:', e.message);
  }
  return home;
}
export const data = resolveDataDir();
export const port = Number(process.env.MV_PORT || 7788);
// A secondary window: a server the main one spawned, pinned to one project (MV_PROJECT) on
// its own port, so several projects can be open and generating at the same time. It exits
// when the main server goes away and never rewrites the shared workspace file.
export const isChild = !!process.env.MV_PARENT_PID;
export const parentPid = Number(process.env.MV_PARENT_PID) || 0;
export const mainPort = isChild ? Number(process.env.MV_MAIN_PORT) || null : port;
// Worker token and Seedvis key stay at the data root, shared by every project.
const tokenFile = path.join(data, 'worker-token.txt');
fs.mkdirSync(data, { recursive: true });
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'));
export const workerToken = fs.readFileSync(tokenFile, 'utf8').trim();
export const seedvis = createSeedvis(data);
export const directorLLM = createDirectorLLM(data);
