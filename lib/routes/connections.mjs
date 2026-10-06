// Routes: Orbit login/status, Seedvis key/status, and the browser state.
import { inspectOrbit, loginOrbit, logoutOrbit } from '../../orbit-client.mjs';
import { data, port, seedvis, workerToken } from '../config.mjs';
import { NEXT, body, json } from '../http.mjs';
import { publicState } from '../public-state.mjs';
import { pump } from '../runner.mjs';

export async function handle(req, res, p, u) {
  // The worker token for the ChatGPT extension. Served only here (behind the browser-origin
  // check, unlike /api/worker/*), so only this app's own UI can read it, not any web page.
  if (p === '/api/worker-info' && req.method === 'GET')
    return json(res, 200, { token: workerToken, dataDir: data, url: `http://127.0.0.1:${port}` });
  if (p === '/api/orbit' && req.method === 'GET') {
    const info = await inspectOrbit(req);
    if (info.authenticated) pump(req);
    return json(res, 200, info);
  }
  if (p === '/api/orbit/login' && req.method === 'POST')
    return json(res, 200, await loginOrbit(req, res, await body(req)));
  if (p === '/api/orbit/logout' && req.method === 'POST')
    return json(res, 200, await logoutOrbit(req, res));
  if (p === '/api/state' && req.method === 'GET') {
    pump(req);
    return json(res, 200, publicState());
  }
  if (p === '/api/seedvis' && req.method === 'GET') return json(res, 200, await seedvis.status());
  if (p === '/api/seedvis/key' && req.method === 'POST') {
    const b = await body(req);
    if (b.key) seedvis.saveKey(b.key);
    else seedvis.removeKey();
    return json(res, 200, await seedvis.status());
  }
  return NEXT;
}
