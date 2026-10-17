// Routes: Orbit login/status, Seedvis key/status, and the browser state.
import { inspectOrbit, loginOrbit, logoutOrbit } from '../../orbit-client.mjs';
import { data, port, seedane, seedvis, workerToken } from '../config.mjs';
import { subscribe } from '../events.mjs';
import { NEXT, body, json } from '../http.mjs';
import { db } from '../projects.mjs';
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
  // A cheap heartbeat the UI polls to decide whether a full /api/state is worth fetching: the
  // graph revision (bumped on every mutate), how many jobs are live, and when the last one
  // finished. No disk reads, no prompt recompute — so an idle window stops pulling ~1.8 MB every
  // few seconds.
  // `lastDone` is what makes the poll a real safety net: a finished job deliberately does NOT bump
  // the revision, and by the tick after it finished nothing is active any more — so revision +
  // active alone describe a window that has a new picture waiting exactly like one that has
  // nothing to do. The push channel normally gets there first; this is for when it is missed.
  if (p === '/api/revision' && req.method === 'GET') {
    pump(req);
    let lastDone = '';
    for (const j of db.jobs) if (j.completedAt > lastDone) lastDone = j.completedAt;
    return json(res, 200, {
      revision: db.revision || 0,
      active: db.jobs.filter(j => ['queued', 'running'].includes(j.status)).length,
      lastDone,
    });
  }
  // The push channel the UI listens on, so a finished image/video shows up at once instead of on
  // the next poll tick. Stays open; see lib/events.mjs.
  if (p === '/api/events' && req.method === 'GET') {
    subscribe(req, res);
    return true;
  }
  if (p === '/api/seedvis' && req.method === 'GET') return json(res, 200, await seedvis.status());
  // Seedane: its LAN address + token (kept on this machine), and a live check of both.
  if (p === '/api/seedane' && req.method === 'GET') return json(res, 200, await seedane.status());
  if (p === '/api/seedane' && req.method === 'POST') {
    seedane.save(await body(req));
    return json(res, 200, await seedane.status());
  }
  if (p === '/api/seedvis/key' && req.method === 'POST') {
    const b = await body(req);
    if (b.key) seedvis.saveKey(b.key);
    else seedvis.removeKey();
    return json(res, 200, await seedvis.status());
  }
  return NEXT;
}
