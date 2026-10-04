// Multi-project + style/camera setting nodes, against a running server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-proj-'));
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: '17795', MV_ORBIT_URL: 'http://127.0.0.1:1', MV_DATA_DIR: dir },
  stdio: 'pipe',
});
async function api(p, method = 'GET', body) {
  const r = await fetch('http://127.0.0.1:17795' + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
const node = (s, id) => s.nodes.find(n => n.id === id);
try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });
  // Default project: music template with style + camera setting nodes.
  let s = (await api('/api/state')).data;
  assert.equal(s.projects.length, 1);
  assert.ok(s.themes.some(t => t.id === 'film'));
  assert.equal(s.theme, 'music');
  assert.equal(node(s, 'style').kind, 'setting');
  assert.equal(node(s, 'camera').settingType, 'camera');
  // Setting text is injected into connected nodes' prompts.
  assert.match(node(s, 'scene').resolvedPrompts.image, /Cinematic concert film/);
  assert.match(node(s, 'wide').resolvedPrompts.video, /35mm lens/);
  // Setting nodes are not image inputs (scene's references exclude them).
  assert.ok(!node(s, 'scene').references.some(r => r.role === 'style'));

  // Zones: image/setting nodes in design, shots in production.
  // 5 zones: singer=character, stage/scene=design, style/camera=setup, shots=production.
  assert.equal(node(s, 'singer').zone, 'character');
  assert.equal(node(s, 'style').zone, 'setup');
  assert.equal(node(s, 'camera').zone, 'setup');
  assert.equal(node(s, 'scene').zone, 'design');
  assert.equal(node(s, 'wide').zone, 'production');
  s = (await api('/api/node', 'PATCH', { id: 'wide', zone: 'design' })).data;
  assert.equal(node(s, 'wide').zone, 'design', 'zone change persists');
  await api('/api/node', 'PATCH', { id: 'wide', zone: 'production' });

  // Each zone is numbered from 1 independently.
  s = (await api('/api/state')).data;
  const bySeq = z =>
    s.nodes
      .filter(n => n.zone === z)
      .sort((a, b) => a.seq - b.seq)
      .map(n => n.seq);
  assert.deepEqual(bySeq('character'), [1]); // ca sĩ
  assert.deepEqual(bySeq('design'), [1, 2]); // sân khấu, ghép cảnh
  assert.deepEqual(bySeq('setup'), [1, 2]); // style, máy quay
  assert.deepEqual(bySeq('production'), [1, 2, 3]); // 3 shots, numbered on their own
  // Typing a new position reorders within the zone.
  const before = node(s, 'close').seq;
  s = (await api('/api/node', 'PATCH', { id: 'close', seq: 1 })).data;
  assert.equal(node(s, 'close').seq, 1, 'moved to position 1');
  assert.deepEqual(bySeq('production'), [1, 2, 3], 'production still 1..3');
  assert.notEqual(node(s, 'close').seq, before);

  // Editing a setting node changes downstream prompts.
  await api('/api/node', 'PATCH', { id: 'style', config: 'NEON CYBERPUNK LOOK' });
  s = (await api('/api/state')).data;
  assert.match(node(s, 'scene').resolvedPrompts.image, /NEON CYBERPUNK LOOK/);

  // A setting node cannot generate.
  let r = await api('/api/jobs', 'POST', { nodeId: 'style', kind: 'image' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /cài đặt/);

  // Rename a node, to prove project isolation later.
  await api('/api/node', 'PATCH', { id: 'singer', name: 'CA SĨ A' });

  // Create a film project — becomes active, cloned from the film template.
  r = await api('/api/projects', 'POST', { name: 'Phim A', theme: 'film' });
  assert.equal(r.status, 201);
  s = r.data;
  assert.equal(s.projects.length, 2);
  assert.equal(s.theme, 'film');
  assert.ok(node(s, 'char') && node(s, 'world') && node(s, 'shot1'));
  assert.ok(!node(s, 'singer'), 'film project has no music nodes');
  assert.equal(node(s, 'style').kind, 'setting');
  assert.match(node(s, 'scene').resolvedPrompts.image, /anamorphic/i);
  const filmId = s.activeProjectId;
  const musicId = s.projects.find(p => p.id !== filmId).id;

  // Switch back to the music project — its edits persisted and are isolated.
  s = (await api('/api/projects/switch', 'POST', { id: musicId })).data;
  assert.equal(node(s, 'singer').name, 'CA SĨ A');
  assert.match(node(s, 'scene').resolvedPrompts.image, /NEON CYBERPUNK LOOK/);
  assert.ok(!node(s, 'char'), 'music project unaffected by film project');

  // Each project stores media separately.
  assert.ok(fs.existsSync(path.join(dir, 'projects', musicId, 'media')));
  assert.ok(fs.existsSync(path.join(dir, 'projects', filmId, 'media')));

  // Delete the film project; cannot delete the last one.
  s = (await api('/api/projects/delete', 'POST', { id: filmId })).data;
  assert.equal(s.projects.length, 1);
  assert.equal(s.activeProjectId, musicId);
  assert.ok(!fs.existsSync(path.join(dir, 'projects', filmId)));
  r = await api('/api/projects/delete', 'POST', { id: musicId });
  assert.equal(r.status, 400);

  // Backup (export) then restore (import) → a separate copy with a new id.
  const exp = await api('/api/projects/export?id=' + musicId);
  assert.equal(exp.status, 200);
  assert.equal(exp.data.type, 'mv-director-project');
  assert.ok(exp.data.project.nodes.length, 'bundle carries the graph');
  r = await api('/api/projects/import', 'POST', exp.data);
  assert.equal(r.status, 200);
  s = r.data;
  assert.equal(s.projects.length, 2, 'import adds a project, keeps the original');
  const importedId = s.activeProjectId;
  assert.notEqual(importedId, musicId, 'imported copy has its own id');
  assert.equal(node(s, 'singer').name, 'CA SĨ A', 'imported copy keeps the edited node');
  assert.ok(fs.existsSync(path.join(dir, 'projects', importedId, 'media')));
  // A bad bundle is rejected.
  assert.equal((await api('/api/projects/import', 'POST', { foo: 1 })).status, 400);

  // A dangling edge (pointing to a missing node) must not break state — repaired on load.
  const musicFile = path.join(dir, 'projects', musicId, 'project.json');
  const pj = JSON.parse(fs.readFileSync(musicFile, 'utf8'));
  pj.edges.push({ source: 'ghost-node', target: 'scene' });
  fs.writeFileSync(musicFile, JSON.stringify(pj));
  await api('/api/projects/switch', 'POST', { id: importedId }); // away…
  const back = await api('/api/projects/switch', 'POST', { id: musicId }); // …and back = reload
  assert.equal(back.status, 200, 'state still loads with a dangling edge');
  assert.ok(!back.data.edges.some(e => e.source === 'ghost-node'), 'dangling edge repaired');

  // Custom export folder: generated/uploaded images are saved there, organized by zone.
  const expDir = path.join(dir, 'exports-custom');
  let rr = await api('/api/project', 'PATCH', { exportDir: expDir });
  assert.equal(rr.status, 200);
  assert.equal(rr.data.exportDir, expDir, 'export folder saved on the project');
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await api('/api/upload', 'POST', {
    nodeId: 'singer',
    kind: 'image',
    mime: 'image/png',
    base64: PNG,
  });
  assert.ok(
    fs.existsSync(path.join(expDir, 'thu-vien', 'nhan-vat', 'CA SĨ A.png')),
    'image exported into the chosen folder, by zone',
  );
  // A relative export path is rejected.
  assert.equal((await api('/api/project', 'PATCH', { exportDir: 'relative/x' })).status, 400);

  console.log(
    'PASS: default template + setting nodes, prompt injection, setting edit, no-gen on setting, zones, per-zone numbering + reorder, create/switch/delete projects, isolation, per-project media, export/import backup, custom export folder',
  );
} finally {
  proc.kill();
}
