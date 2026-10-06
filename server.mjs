// MV Director server: opens the project store, serves the routes in lib/routes and runs
// the job runner.
import http from 'node:http';
import { isChild, parentPid, port } from './lib/config.mjs';
import { NEXT, json } from './lib/http.mjs';
import { initWorkspace, pidAlive } from './lib/projects.mjs';
import { watchWorkerHeartbeats } from './lib/runner.mjs';
import { shutdown } from './lib/windows.mjs';
import { handle as connectionsRoutes } from './lib/routes/connections.mjs';
import { handle as projectsRoutes } from './lib/routes/projects.mjs';
import { handle as directorRoutes } from './lib/routes/director.mjs';
import { handle as nodesRoutes } from './lib/routes/nodes.mjs';
import { handle as assetsRoutes } from './lib/routes/assets.mjs';
import { handle as jobsRoutes } from './lib/routes/jobs.mjs';
import { handle as autoRoutes } from './lib/routes/auto.mjs';
import { handle as filesRoutes } from './lib/routes/files.mjs';
import { handle as seedanceRoutes } from './lib/routes/seedance.mjs';
import { handle as mergedRoutes } from './lib/routes/merged.mjs';

await initWorkspace();
if (isChild)
  setInterval(() => {
    if (!pidAlive(parentPid)) process.exit(0);
  }, 3000).unref();
process.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

// Each route group answers its own paths and returns NEXT for the rest; the web app files
// and media come last.
const routes = [
  connectionsRoutes,
  projectsRoutes,
  directorRoutes,
  nodesRoutes,
  assetsRoutes,
  jobsRoutes,
  autoRoutes,
  seedanceRoutes,
  mergedRoutes,
  filesRoutes,
];
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${port}`),
      p = u.pathname;
    // The web worker extension runs in a browser (origin chrome-extension://…) and talks to the
    // worker queue plus downloads reference images. Those paths are guarded by the worker token
    // (or are read-only media), so they skip the browser-origin check and allow cross-origin
    // fetches from the extension.
    const workerPath = p.startsWith('/api/worker/') || p.startsWith('/media/');
    if (workerPath) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
    } else {
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin))
        return json(res, 403, { error: 'Origin not allowed' });
    }
    for (const handle of routes) if ((await handle(req, res, p, u)) !== NEXT) return;
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    // Log unexpected (non-validation) failures so a broken project can be diagnosed.
    if (!e.status) console.error('Lỗi xử lý', req.method, req.url, '→', e.stack || e.message);
    json(res, e.status || 400, { error: e.message });
  }
});
watchWorkerHeartbeats();
server.listen(port, '127.0.0.1', () => console.log(`MV Director ready: http://127.0.0.1:${port}`));
