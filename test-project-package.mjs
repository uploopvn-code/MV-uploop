// Isolated project-package test: no real user projects or paid providers are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { writeZipStream } from './zip.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-package-'));
process.env.MV_DATA_DIR = temp;
const projects = await import('./lib/projects.mjs');
const { projectPackage } = await import('./lib/project-package.mjs');
await projects.initWorkspace();
const first = projects.activeId;
const media1 = path.join(projects.projectDir(first), 'media');
fs.writeFileSync(path.join(media1, '11111111-1111-1111-1111-111111111111.png'), Buffer.from('first-image'));
fs.writeFileSync(path.join(media1, '.lock-copy'), 'must not export');
const second = projects.createProjectFiles('Second film', 'film');
fs.writeFileSync(path.join(projects.projectDir(second), 'media', '22222222-2222-2222-2222-222222222222.mp4'), Buffer.from('second-video'));
projects.ws.order.push(second);
projects.writeWorkspace(projects.ws);
const plan = projectPackage('all');
assert.equal(plan.projects.length, 2);
assert.equal(plan.mediaCount, 2);
assert.equal(projectPackage('current').projects.length, 1);
assert.deepEqual(projectPackage('project', second).projects.map(p => p.id), [second]);
assert.throws(() => projectPackage('project', 'missing'), /không tồn tại/);
assert.throws(() => projectPackage('../'), /Phạm vi/);
assert.ok(!plan.files.some(f => f.name.includes('.lock')));

const sink = new PassThrough();
const received = [];
const collect = (async () => { for await (const chunk of sink) received.push(chunk); })();
await writeZipStream(sink, plan.files);
await collect;
const zip = Buffer.concat(received);
// Read central directory and local entries of a STORE archive, including descriptor entries.
const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
assert.ok(endAt > 0);
const count = zip.readUInt16LE(endAt + 10);
let at = zip.readUInt32LE(endAt + 16);
const entries = new Map();
for (let i = 0; i < count; i++) {
  assert.equal(zip.readUInt32LE(at), 0x02014b50);
  const size = zip.readUInt32LE(at + 24);
  const nameLength = zip.readUInt16LE(at + 28);
  const extraLength = zip.readUInt16LE(at + 30);
  const commentLength = zip.readUInt16LE(at + 32);
  const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
  const localAt = zip.readUInt32LE(at + 42);
  assert.equal(zip.readUInt32LE(localAt), 0x04034b50);
  const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
  entries.set(name, zip.subarray(dataAt, dataAt + size));
  at += 46 + nameLength + extraLength + commentLength;
}
assert.equal(entries.size, plan.files.length);
assert.deepEqual(JSON.parse(entries.get('workspace.json')), { active: first, order: [first, second] });
assert.equal(entries.get(`projects/${first}/media/11111111-1111-1111-1111-111111111111.png`).toString(), 'first-image');
assert.equal(entries.get(`projects/${second}/media/22222222-2222-2222-2222-222222222222.mp4`).toString(), 'second-video');
assert.equal(JSON.parse(entries.get(`projects/${second}/project.json`)).name, 'Second film');
assert.ok(![...entries.keys()].some(name => /worker-token|seedvis|\.lock/.test(name)));
const { handle } = await import('./lib/routes/files.mjs');
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try { await handle(req, res, u.pathname, u); }
  catch (error) { res.writeHead(400); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const preview = await fetch(`${base}/api/projects/package/plan?scope=all`);
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).mediaCount, 2);
  const namedPreview = await fetch(`${base}/api/projects/package/plan?scope=project&id=${second}`);
  assert.deepEqual((await namedPreview.json()).projects.map(p => p.id), [second]);
  const download = await fetch(`${base}/api/projects/package?scope=current`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /\.zip/);
  const downloaded = Buffer.from(await download.arrayBuffer());
  assert.ok(downloaded.includes(Buffer.from(`projects/${first}/project.json`)));
  assert.ok(!downloaded.includes(Buffer.from(`projects/${second}/project.json`)));
} finally { await new Promise(resolve => server.close(resolve)); }
projects.releaseLock(first);
// This directory was created by this test and is verified under the OS temp directory.
assert.equal(path.dirname(temp), os.tmpdir());
fs.rmSync(temp, { recursive: true, force: true });
console.log('PASS: project ZIP contains all projects and local media without credentials');
