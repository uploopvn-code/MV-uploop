// Timeline trims persist on the rendered clip without changing its source or media file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-timeline-'));
process.env.MV_DATA_DIR = dir;
process.env.MV_PROJECT = '';
process.env.MV_PARENT_PID = '';
const projects = await import('./lib/projects.mjs');
const { handle } = await import('./lib/routes/nodes.mjs');
const { NEXT } = await import('./lib/http.mjs');
let server;
try {
  await projects.initWorkspace();
  const { db, dbFile } = projects;
  const source = { id: 'timeline-shot', name: 'Timeline shot', zone: 'production', start: 4, duration: 8, seq: 1, videoStale: false };
  const clip = { id: 'timeline-video', name: 'Timeline shot v1', terminal: true, source: source.id, zone: 'output', version: 1, seq: 1, start: 0, duration: 8, video: { url: '/media/test.mp4' } };
  db.nodes.push(source, clip);
  projects.mutate();
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if ((await handle(req, res, url.pathname, url)) === NEXT) {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method, body) => {
    const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const patch = body => request('/api/node', 'PATCH', body);
  const choose = body => request('/api/timeline/clip', 'POST', body);
  const saved = await patch({ id: clip.id, timelineStart: 5.5, trimIn: 1.25, trimOut: 6.75 });
  assert.equal(saved.status, 200);
  assert.deepEqual([clip.timelineStart, clip.trimIn, clip.trimOut], [5.5, 1.25, 6.75]);
  assert.equal(source.start, 4);
  assert.equal(source.duration, 8);
  assert.equal(source.videoStale, false);
  assert.equal(clip.video.url, '/media/test.mp4');
  const disk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const persisted = disk.nodes.find(n => n.id === clip.id);
  assert.deepEqual([persisted.timelineStart, persisted.trimIn, persisted.trimOut], [5.5, 1.25, 6.75]);
  assert.equal((await patch({ id: clip.id, trimIn: 7, trimOut: 6 })).status, 400);
  assert.equal((await patch({ id: source.id, trimIn: 1, trimOut: 3 })).status, 400);
  assert.equal(clip.trimIn, 1.25, 'invalid edit did not overwrite the cut');
  const clip2 = { id: 'timeline-video-2', name: 'Timeline shot v2', terminal: true,
    source: source.id, zone: 'output', version: 2, seq: 2, start: 0, duration: 8,
    video: { url: '/media/test-v2.mp4' } };
  db.nodes.push(clip2);
  projects.mutate();
  const revisionBeforeChoice = db.revision;
  const chosen = await choose({ sourceId: source.id, clipId: clip.id });
  assert.equal(chosen.status, 200);
  assert.equal(source.timelineClipId, clip.id, 'source persists the version used by timeline');
  assert.equal(db.revision, revisionBeforeChoice, 'timeline preference does not invalidate graph inputs');
  assert.equal(JSON.parse(fs.readFileSync(dbFile, 'utf8')).nodes.find(n => n.id === source.id).timelineClipId, clip.id);
  assert.equal((await choose({ sourceId: source.id, clipId: 'missing' })).status, 400);
  const segments = [
    { id: clip.id, position: 5.5, inPoint: 1.25, outPoint: 4 },
    { id: 'cut-test', position: 8.25, inPoint: 4, outPoint: 6.75 },
  ];
  assert.equal((await patch({ id: clip.id, timelineSegments: segments })).status, 200);
  assert.deepEqual(clip.timelineSegments, segments, 'split produces two non-destructive segments');
  assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).nodes.find(n => n.id === clip.id).timelineSegments, segments);
  assert.equal((await patch({ id: clip.id, timelineSegments: [segments[0], segments[0]] })).status, 400);
  assert.equal(clip.timelineSegments.length, 2, 'duplicate segment IDs do not overwrite the cut');
  const direct = { id: 'timeline-direct', name: 'Direct clip', zone: 'production', start: 12, duration: 7, seq: 2, video: { url: '/media/direct.mp4' }, videoStale: false };
  db.nodes.push(direct);
  projects.mutate();
  assert.equal((await patch({ id: direct.id, timelineStart: 14, trimIn: 1, trimOut: 5 })).status, 200);
  assert.deepEqual([direct.start, direct.duration, direct.timelineStart, direct.trimIn, direct.trimOut], [12, 7, 14, 1, 5]);
  assert.equal(direct.videoStale, false, 'editing a direct clip does not invalidate its render');
  console.log('PASS: timeline trims and selected video version persist; source inputs and rendered files remain unchanged');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
