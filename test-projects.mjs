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
  // Inputs are reported split: reference images vs. style/camera text, plus the video
  // model's reference limit (default Veo: 3) and whether a keyframe is required first.
  assert.equal(node(s, 'scene').imageInputs, 2, 'singer + stage feed images');
  assert.equal(node(s, 'scene').settingInputs, 2, 'style + camera are text inputs');
  assert.equal(node(s, 'wide').videoRefLimit, 3, 'Veo takes 3 reference images');
  assert.equal(node(s, 'wide').videoNeedsKeyframe, false);

  // Zones: image/setting nodes in design, shots in production.
  // 5 zones: singer=character, stage/scene=design, style/camera=setup, shots=production.
  assert.equal(node(s, 'singer').zone, 'character');
  assert.equal(node(s, 'style').zone, 'setup');
  assert.equal(node(s, 'camera').zone, 'setup');
  assert.equal(node(s, 'scene').zone, 'design');
  assert.equal(node(s, 'wide').zone, 'production');
  // Sound: its own column, the text goes into every shot it is wired to.
  let ar = await api('/api/nodes', 'POST', {
    kind: 'setting',
    settingType: 'audio',
    name: 'Tang lễ',
    config: 'low cello drone, rain on umbrellas, distant bell',
  });
  assert.equal(ar.status, 201, JSON.stringify(ar.data));
  const au = ar.data.nodes.at(-1);
  assert.equal(au.zone, 'audio');
  assert.equal(au.settingType, 'audio');
  assert.equal(au.kind, 'setting');
  ar = await api('/api/edges', 'PUT', {
    edges: [...ar.data.edges, { source: au.id, target: 'wide' }],
  });
  assert.equal(ar.status, 200, JSON.stringify(ar.data));
  assert.match(
    node(ar.data, 'wide').resolvedPrompts.video,
    /Audio: low cello drone, rain on umbrellas, distant bell/,
    'the sound node writes an Audio: line into the shot',
  );
  assert.equal(
    (await api('/api/jobs', 'POST', { nodeId: au.id, kind: 'image' })).status,
    400,
    'a sound node generates nothing',
  );
  await api('/api/edges', 'PUT', { edges: ar.data.edges.filter(e => e.source !== au.id) });

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
  // A project needs a working folder; the folder is created.
  r = await api('/api/projects', 'POST', { name: 'Phim A', theme: 'film' });
  assert.equal(r.status, 400, 'no working folder → refused');
  r = await api('/api/projects', 'POST', {
    name: 'Phim A',
    theme: 'film',
    exportDir: path.join(dir, 'phim-a'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.exportDir, path.join(dir, 'phim-a'));
  assert.ok(fs.existsSync(path.join(dir, 'phim-a')), 'working folder created');
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

  // Clips: every video is a node in the Video column, the shot keeps the warning.
  const MP4 = Buffer.from('00000018667479706d70343200000000', 'hex').toString('base64');
  const up = id =>
    api('/api/upload', 'POST', { nodeId: id, kind: 'video', mime: 'video/mp4', base64: MP4 });
  const clipsOf = (st, id) =>
    st.nodes.filter(n => n.terminal && n.source === id).sort((a, b) => a.version - b.version);
  let cs = (await up('wide')).data;
  assert.deepEqual(
    clipsOf(cs, 'wide').map(n => n.version),
    [1],
    'an uploaded clip becomes v1',
  );
  assert.ok(!node(cs, 'wide').video, 'nothing pinned on the shot');
  assert.ok(cs.edges.some(e => e.source === 'wide' && e.target === clipsOf(cs, 'wide')[0].id));
  cs = (await api('/api/node', 'PATCH', { id: 'wide', lyric: 'changed' })).data;
  assert.equal(node(cs, 'wide').videoStale, true, 'editing a shot with clips flags it');
  cs = (await up('wide')).data;
  assert.equal(node(cs, 'wide').videoStale, false, 'a fresh clip clears the flag');
  cs = (await api('/api/node', 'PATCH', { id: 'wide', name: 'Toàn cảnh mới' })).data;
  assert.equal(node(cs, 'wide').videoStale, false, 'a rename does not make the clips stale');
  await api('/api/node', 'PATCH', { id: 'wide', name: 'Toàn cảnh' });
  cs = (
    await api('/api/upload', 'POST', {
      nodeId: 'wide',
      kind: 'image',
      mime: 'image/png',
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    })
  ).data;
  assert.equal(node(cs, 'wide').videoStale, true, 'a new keyframe makes its clips stale');
  cs = (await up('wide')).data; // re-film: clean again
  // Deleting that fresh clip leaves only old ones: the warning comes back.
  cs = (await api('/api/nodes/delete', 'POST', { id: clipsOf(cs, 'wide').at(-1).id })).data;
  assert.equal(node(cs, 'wide').videoStale, true, 'the clips left are out of date');
  cs = (await up('wide')).data;
  assert.equal(node(cs, 'wide').videoStale, false);
  // The last clip of a shot deleted: no video left, so no warning left either.
  let lone = (await up('close')).data;
  lone = (await api('/api/node', 'PATCH', { id: 'close', lyric: 'x' })).data;
  assert.equal(node(lone, 'close').videoStale, true);
  lone = (await api('/api/nodes/delete', 'POST', { id: clipsOf(lone, 'close')[0].id })).data;
  assert.equal(node(lone, 'close').videoStale, false, 'flag cleared with the last clip');
  // Deleting a clip does not flag every other shot in the project.
  assert.equal(node(lone, 'wide').videoStale, false, 'unrelated shots untouched');
  // A new wire into a shot changes what its next clip is made from.
  lone = (await up('close')).data;
  const wire = { source: 'singer', target: 'close' };
  const has = lone.edges.some(e => e.source === wire.source && e.target === wire.target);
  lone = (
    await api('/api/edges', 'PUT', {
      edges: has
        ? lone.edges.filter(e => !(e.source === wire.source && e.target === wire.target))
        : [...lone.edges, wire],
    })
  ).data;
  assert.equal(node(lone, 'close').videoStale, true, 'rewiring a shot outdates its clips');
  // Deleting v1 never hands its successor's number out twice.
  await api('/api/nodes/delete', 'POST', { id: clipsOf(cs, 'wide')[0].id });
  cs = (await up('wide')).data;
  assert.deepEqual(
    clipsOf(cs, 'wide').map(n => n.version),
    [2, 4, 5],
    'max + 1, never a duplicate (v1 and v3 were deleted)',
  );
  // A wire into a clip is only legal from its own shot: cutting and re-adding it works…
  const wClip = clipsOf(cs, 'wide')[0].id;
  const without = cs.edges.filter(e => !(e.source === 'wide' && e.target === wClip));
  assert.equal((await api('/api/edges', 'PUT', { edges: without })).status, 200);
  assert.equal(
    (await api('/api/edges', 'PUT', { edges: [...without, { source: 'wide', target: wClip }] }))
      .status,
    200,
    'the shot may wire its own clip back',
  );
  // …and an odd wire saved by an older version does not block every later edit.
  let lp = JSON.parse(fs.readFileSync(musicFile, 'utf8'));
  lp.edges.push({ source: wClip, target: 'close' });
  fs.writeFileSync(musicFile, JSON.stringify(lp));
  await api('/api/projects/switch', 'POST', { id: importedId });
  cs = (await api('/api/projects/switch', 'POST', { id: musicId })).data;
  assert.ok(
    cs.edges.some(e => e.source === wClip && e.target === 'close'),
    'legacy wire kept',
  );
  assert.equal(
    (await api('/api/edges', 'PUT', { edges: cs.edges.filter(e => e.target !== 'medium') })).status,
    200,
    'unrelated edits still save next to a legacy wire',
  );
  cs = (
    await api('/api/edges', 'PUT', {
      edges: [...cs.edges.filter(e => e.source !== wClip), { source: 'scene', target: 'medium' }],
    })
  ).data;
  // A project saved before clips were nodes: the pinned video moves to the Video column on
  // load, once, under the next free number (the clips already exported keep theirs).
  lp = JSON.parse(fs.readFileSync(musicFile, 'utf8'));
  const pinned = lp.nodes.find(n => n.terminal && n.source === 'wide').video;
  lp.nodes.find(n => n.id === 'medium').video = pinned;
  lp.nodes.find(n => n.id === 'wide').video = pinned;
  fs.writeFileSync(musicFile, JSON.stringify(lp));
  for (let round = 0; round < 2; round++) {
    await api('/api/projects/switch', 'POST', { id: importedId });
    cs = (await api('/api/projects/switch', 'POST', { id: musicId })).data;
    assert.deepEqual(
      clipsOf(cs, 'medium').map(n => n.version),
      [1],
      'lifted once: ' + round,
    );
    assert.ok(!node(cs, 'medium').video && !node(cs, 'wide').video, 'nothing left pinned');
  }
  assert.ok(cs.edges.some(e => e.source === 'medium' && e.target === clipsOf(cs, 'medium')[0].id));
  const wv = clipsOf(cs, 'wide');
  assert.deepEqual(
    wv.map(n => n.version),
    [2, 4, 5, 6],
    'the pinned one takes the next number',
  );
  assert.match(wv[0].name, / · v2$/, 'exported clips keep their number and name');
  assert.match(wv[3].name, / · v6$/);

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
  // A JPG replacing it leaves one file: a later project must not pick the old PNG.
  const JPG =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDLooorkOoKKKKACiiigAooooAKKKKACiiigD//2Q==';
  await api('/api/upload', 'POST', {
    nodeId: 'singer',
    kind: 'image',
    mime: 'image/jpeg',
    base64: JPG,
  });
  assert.deepEqual(
    fs.readdirSync(path.join(expDir, 'thu-vien', 'nhan-vat')).filter(f => f.startsWith('CA SĨ A.')),
    ['CA SĨ A.jpg'],
    'one file per asset in the library',
  );
  // A relative export path is rejected.
  assert.equal((await api('/api/project', 'PATCH', { exportDir: 'relative/x' })).status, 400);

  // Any new image keeps the one it replaces: swap back and forth.
  const PNG2 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKJkAAAAASUVORK5CYII=';
  const firstImg = (await api('/api/state')).data.nodes.find(n => n.id === 'singer').image;
  rr = await api('/api/upload', 'POST', {
    nodeId: 'singer',
    kind: 'image',
    mime: 'image/png',
    base64: PNG2,
  });
  const secondImg = node(rr.data, 'singer').image;
  assert.equal(node(rr.data, 'singer').prevImage.url, firstImg.url, 'the replaced image is kept');
  assert.deepEqual(
    fs.readdirSync(path.join(expDir, 'thu-vien', 'nhan-vat')).filter(f => f.startsWith('CA SĨ A.')),
    ['CA SĨ A.png'],
    'and back the other way',
  );
  rr = await api('/api/node/swap-image', 'POST', { id: 'singer' });
  assert.equal(node(rr.data, 'singer').image.url, firstImg.url, 'swapped back');
  assert.equal(node(rr.data, 'singer').prevImage.url, secondImg.url);
  assert.equal(
    (await api('/api/node/swap-image', 'POST', { id: 'stage' })).status,
    400,
    'nothing to swap',
  );
  // Exported clips never overwrite each other, even after the newest one is deleted.
  const VMP4 = Buffer.from('00000018667479706d70343200000000', 'hex').toString('base64');
  const vup = () =>
    api('/api/upload', 'POST', {
      nodeId: 'medium',
      kind: 'video',
      mime: 'video/mp4',
      base64: VMP4,
    });
  await vup();
  rr = await vup();
  const newest = rr.data.nodes
    .filter(n => n.terminal && n.source === 'medium')
    .sort((a, b) => b.version - a.version)[0];
  await api('/api/nodes/delete', 'POST', { id: newest.id });
  rr = await vup();
  const mv = rr.data.nodes.filter(n => n.terminal && n.source === 'medium').map(n => n.version);
  assert.ok(!mv.includes(newest.version), 'the deleted number is not reused');
  assert.ok(Math.max(...mv) > newest.version, 'the deleted number is not handed out again');
  const videoFiles = dirFiles =>
    fs.readdirSync(dirFiles, { recursive: true }).filter(f => /\.mp4$/.test(f));
  assert.ok(
    videoFiles(path.join(expDir, 'video')).length >= 3,
    'every clip kept its exported file',
  );

  // Wardrobe zone: one character in one costume (+ items) for a scene. Created from the
  // character it is pre-wired to it (the character's image is its face reference) and its
  // prompt is generated from the costume fields — never from the template's default outfit.
  rr = await api('/api/nodes', 'POST', {
    kind: 'wardrobe',
    characterId: 'singer',
    outfit: 'burgundy velvet suit',
    items: 'silver microphone',
  });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  const wd = rr.data.nodes.at(-1);
  assert.equal(wd.zone, 'wardrobe');
  assert.equal(wd.role, 'wardrobe');
  assert.equal(wd.name, 'CA SĨ A — Trang phục 1');
  assert.equal(wd.charId, 'singer', 'records the character it dresses');
  assert.ok(
    !rr.data.edges.some(e => e.target === wd.id),
    'the garment render takes no image input (the person would only be redrawn)',
  );
  assert.equal(wd.references.length, 0);
  assert.equal(wd.imageInputs, 0, 'so it can render before the character is done');
  assert.match(
    wd.resolvedPrompts.image,
    /Costume reference sheet[\s\S]*burgundy velvet suit, with silver microphone[\s\S]*mannequin/,
    'costume prompt describes the outfit only (the look node does the try-on)',
  );
  assert.ok(!/evening outfit/.test(wd.resolvedPrompts.image), 'no template wardrobe leakage');
  // Editing the fields regenerates the prompt; the zone numbers on its own.
  rr = await api('/api/node', 'PATCH', { id: wd.id, outfit: 'white silk gown' });
  assert.equal(rr.status, 200);
  assert.match(node(rr.data, wd.id).resolvedPrompts.image, /try-on: white silk gown/);
  assert.deepEqual(
    rr.data.nodes.filter(n => n.zone === 'wardrobe').map(n => n.seq),
    [1],
  );
  // Its image exports under thu-vien/trang-phuc.
  await api('/api/upload', 'POST', {
    nodeId: wd.id,
    kind: 'image',
    mime: 'image/png',
    base64: PNG,
  });
  assert.equal(
    fs.readdirSync(path.join(expDir, 'thu-vien', 'trang-phuc')).length,
    1,
    'wardrobe image exported by zone',
  );
  // The per-zone image batch knows the zone (nothing to do: the only node has an image).
  assert.equal((await api('/api/auto/images/start', 'POST', { zone: 'wardrobe' })).status, 400);
  // A loose wardrobe node (no character yet) is allowed; an unknown character is not.
  rr = await api('/api/nodes', 'POST', { kind: 'wardrobe' });
  assert.equal(rr.data.nodes.at(-1).name, 'Nhân vật — Trang phục 1');
  assert.equal(
    (await api('/api/nodes', 'POST', { kind: 'wardrobe', characterId: 'nope' })).status,
    400,
  );
  // "Character wearing this costume" (look): composed from the costume's character + the
  // costume image with a server-owned try-on prompt; shots use it instead of the costume.
  rr = await api('/api/nodes', 'POST', { kind: 'look', costumeId: wd.id });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  const lk = rr.data.nodes.at(-1);
  assert.equal(lk.role, 'look');
  assert.equal(lk.zone, 'character', 'a look lives in the character column');
  assert.equal(lk.seq, node(rr.data, 'singer').seq + 1, 'numbered right after its character');
  assert.equal(lk.name, 'NV đã mặc: CA SĨ A — Trang phục 1');
  assert.deepEqual(
    rr.data.edges.filter(e => e.target === lk.id).map(e => e.source),
    ['singer', wd.id],
    'wired from the character then the costume',
  );
  assert.equal(lk.references.length, 2, 'both input images are references');
  assert.match(
    lk.resolvedPrompts.image,
    /model sheet turnaround[\s\S]*exact same person[\s\S]*outfit from the costume reference[\s\S]*portrait on the left[\s\S]*front, side and back views/,
    'look renders as a model sheet like the character (portrait + 3 full-body views)',
  );
  assert.ok(!/Burgundy|evening outfit/.test(lk.resolvedPrompts.image), 'no template leakage');
  // Without a binding of its own, the look renders with the character's image model and
  // aspect ratio, so the sheet matches the character's.
  rr = await api('/api/node', 'PATCH', {
    id: 'singer',
    seedvis: { image: { model: 'NARWHAL', aspectRatio: '4:3', upscale: 'none' } },
  });
  assert.equal(rr.status, 200);
  assert.equal(
    node(rr.data, lk.id).providers.image.model,
    'NARWHAL',
    'look follows character model',
  );
  assert.equal(
    node(rr.data, lk.id).providers.image.aspectRatio,
    '4:3',
    'look follows character ratio',
  );
  assert.equal(
    node(rr.data, wd.id).providers.image.model,
    'GEM_PIX_2',
    'costume keeps the default',
  );
  // A costume with no character wired in cannot be dressed; a non-costume neither.
  const looseWd = rr.data.nodes.find(n => n.name === 'Nhân vật — Trang phục 1');
  assert.equal(
    (await api('/api/nodes', 'POST', { kind: 'look', costumeId: looseWd.id })).status,
    400,
  );
  assert.equal(
    (await api('/api/nodes', 'POST', { kind: 'look', costumeId: 'singer' })).status,
    400,
  );

  // Scene angles: another camera position of a scene, rendered from the scene's image with a
  // server-owned prompt; presets a / b are the opposing close angles of a dialogue.
  rr = await api('/api/nodes', 'POST', { kind: 'angle', sceneId: 'stage', preset: 'a' });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  const ang = rr.data.nodes.at(-1);
  assert.equal(ang.role, 'angle');
  assert.equal(ang.zone, 'design', 'an angle lives in the scene column');
  assert.equal(ang.seq, node(rr.data, 'stage').seq + 1, 'numbered right after its scene');
  assert.match(ang.name, /góc cận A \(sau vai A nhìn B\)$/);
  assert.deepEqual(
    rr.data.edges.filter(e => e.target === ang.id).map(e => e.source),
    ['stage'],
    'wired from the scene',
  );
  assert.match(
    ang.resolvedPrompts.image,
    /^A new camera angle of the location shown in the reference image\. Camera: Reverse angle A[\s\S]*not the reference framing[\s\S]*No people/,
  );
  rr = await api('/api/nodes', 'POST', { kind: 'angle', sceneId: 'stage', preset: 'a' });
  assert.equal(rr.data.nodes.filter(n => n.role === 'angle').length, 1, 'preset A not duplicated');
  rr = await api('/api/nodes', 'POST', {
    kind: 'angle',
    sceneId: 'stage',
    angle: 'low angle from the pit',
  });
  const custom = rr.data.nodes.at(-1);
  assert.match(
    custom.resolvedPrompts.image,
    /Camera: low angle from the pit\. This is a different shot/,
  );
  assert.equal(custom.seq, ang.seq + 1, 'after the earlier angle');
  rr = await api('/api/node', 'PATCH', { id: custom.id, angle: 'from the balcony' });
  assert.match(
    node(rr.data, custom.id).resolvedPrompts.image,
    /Camera: from the balcony\. This is/,
  );
  // Without a binding of its own, an angle renders with its scene's image model.
  rr = await api('/api/node', 'PATCH', {
    id: 'stage',
    seedvis: { image: { model: 'NARWHAL', aspectRatio: '4:3', upscale: 'none' } },
  });
  assert.equal(node(rr.data, ang.id).providers.image.model, 'NARWHAL', 'angle follows scene model');
  assert.equal(
    (await api('/api/nodes', 'POST', { kind: 'angle', sceneId: 'singer' })).status,
    400,
    'not from a character',
  );

  // Working folders: a folder that already holds reference images (thu-vien/…/<key>.png)
  // feeds them to the nodes with that name, and another folder's library can be brought in.
  const srcDir = path.join(dir, 'seq1-folder');
  fs.mkdirSync(path.join(srcDir, 'thu-vien', 'nhan-vat'), { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, 'thu-vien', 'nhan-vat', 'CA SĨ A.png'),
    Buffer.from(PNG, 'base64'),
  );
  const newDir = path.join(dir, 'seq2-folder');
  rr = await api('/api/projects', 'POST', { name: 'Tập mới', theme: 'music', exportDir: newDir });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  await api('/api/node', 'PATCH', { id: 'singer', name: 'CA SĨ A' });
  let info = (await api('/api/folders/inspect?dir=' + encodeURIComponent(newDir))).data;
  assert.equal(info.images, 0, 'new folder is empty');
  assert.ok(
    info.sources.some(s => s.exportDir === expDir && s.images >= 1),
    'other projects with a library are offered as sources',
  );
  info = (await api('/api/folders/inspect?dir=' + encodeURIComponent(srcDir))).data;
  assert.deepEqual(info.keys, ['CA SĨ A']);
  rr = await api('/api/assets/import-folder', 'POST', { dir: srcDir });
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
  assert.equal(rr.data.copied, 1, 'file copied into the new folder');
  assert.equal(rr.data.attached, 1, 'attached to the node with that name');
  assert.ok(node(rr.data, 'singer').image, 'singer carries the image');
  assert.ok(fs.existsSync(path.join(newDir, 'thu-vien', 'nhan-vat', 'CA SĨ A.png')));
  assert.equal(
    (await api('/api/assets/import-folder', 'POST', { dir: srcDir })).data.copied,
    0,
    'second import copies nothing',
  );
  assert.equal(
    (await api('/api/assets/import-folder', 'POST', { dir: newDir })).status,
    400,
    'own folder refused',
  );
  // Start fresh: drop the attached reference images (the exported files stay), and the
  // image kept for "swap back" with them.
  await api('/api/upload', 'POST', {
    nodeId: 'singer',
    kind: 'image',
    mime: 'image/png',
    base64: PNG,
  });
  assert.ok(node((await api('/api/state')).data, 'singer').prevImage, 'a kept image to forget');
  rr = await api('/api/assets/clear', 'POST', {});
  assert.equal(rr.data.cleared, 1);
  assert.ok(!node(rr.data, 'singer').image, 'node image dropped');
  assert.ok(!node(rr.data, 'singer').prevImage, 'no swap back to an image from before');
  assert.ok(
    fs.existsSync(path.join(newDir, 'thu-vien', 'nhan-vat', 'CA SĨ A.png')),
    'the exported file stays in the working folder',
  );
  assert.equal((await api('/api/assets/clear', 'POST', {})).data.cleared, 0);
  assert.equal(
    (await api('/api/assets/import-folder', 'POST', { dir: srcDir })).data.attached,
    1,
    'and can be taken back in from a folder',
  );
  // A folder from before one-file-per-asset may hold a picture twice: the newest file is
  // used, and reading the folder never deletes a file in it.
  const libDir = path.join(newDir, 'thu-vien', 'nhan-vat');
  fs.writeFileSync(path.join(libDir, 'CA SĨ A.jpg'), Buffer.from(JPG, 'base64'));
  const yesterday = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(libDir, 'CA SĨ A.jpg'), yesterday, yesterday);
  await api('/api/assets/clear', 'POST', {});
  rr = await api('/api/assets/import-folder', 'POST', { dir: srcDir });
  assert.equal(node(rr.data, 'singer').image.mime, 'image/png', 'the newest file wins');
  assert.deepEqual(
    fs
      .readdirSync(libDir)
      .filter(f => f.startsWith('CA SĨ A.'))
      .sort(),
    ['CA SĨ A.jpg', 'CA SĨ A.png'],
    'nothing deleted by reading',
  );
  // Another folder's copy under a different extension does not land next to this folder's own.
  const jpgSrc = path.join(dir, 'seq0-folder');
  fs.mkdirSync(path.join(jpgSrc, 'thu-vien', 'nhan-vat'), { recursive: true });
  fs.writeFileSync(
    path.join(jpgSrc, 'thu-vien', 'nhan-vat', 'CA SĨ A.webp'),
    Buffer.from(
      'UklGRjwAAABXRUJQVlA4IDAAAADQAgCdASoSACAAPtFiqk+oJaOiKAgBABoJZwAAPaOgAP7kAX+kulyG/wTTYvLgAAA=',
      'base64',
    ),
  );
  rr = await api('/api/assets/import-folder', 'POST', { dir: jpgSrc });
  assert.equal(rr.data.copied, 0, 'same picture name already here: kept');
  assert.ok(!fs.existsSync(path.join(libDir, 'CA SĨ A.webp')));
  await api('/api/projects/switch', 'POST', { id: musicId });

  // Arrange: the shot column goes back to timeline order, whatever happened to its numbers.
  await api('/api/projects/switch', 'POST', { id: filmId });
  rr = await api('/api/director/build', 'POST', {
    blueprint: {
      project: { title: 'Order' },
      assets: [{ key: 'a1', role: 'scene', name: 'A', prompt: 'p' }],
      shots: [
        { name: 'S1', start: 0, duration: 5, uses: ['a1'], videoPrompt: 'x' },
        { name: 'S2', start: 5, duration: 5, uses: ['a1'], videoPrompt: 'y' },
        { name: 'S3', start: 10, duration: 5, uses: ['a1'], videoPrompt: 'z' },
      ],
    },
  });
  const byStart = st =>
    st.nodes
      .filter(n => n.zone === 'production')
      .sort((a, b) => a.seq - b.seq)
      .map(n => n.name);
  assert.deepEqual(byStart(rr.data), ['S1', 'S2', 'S3']);
  // A trip through another zone and back leaves the first shot numbered last…
  const s1 = rr.data.nodes.find(n => n.name === 'S1');
  await api('/api/node', 'PATCH', { id: s1.id, zone: 'design' });
  rr = await api('/api/node', 'PATCH', { id: s1.id, zone: 'production' });
  assert.deepEqual(byStart(rr.data), ['S2', 'S3', 'S1'], 'the shot drifts to the end');
  // …until Arrange puts the timeline back.
  rr = await api('/api/nodes/arrange', 'POST', {});
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
  assert.deepEqual(byStart(rr.data), ['S1', 'S2', 'S3'], 'arranged by start time');
  await api('/api/projects/switch', 'POST', { id: musicId });

  // Several projects at once: another project opens in its own server process (next free
  // port), pinned to that project; the main window cannot switch into it while it is open.
  r = await api('/api/projects/open-window', 'POST', { id: importedId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const win = r.data.opened;
  assert.match(win.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const wport = Number(win.url.match(/:(\d+)\//)[1]);
  assert.ok(wport > 17795, 'child window on a port after the main one');
  assert.ok(r.data.openWindows.some(w => w.id === importedId && w.port === wport));
  const childState = await (await fetch(win.url + 'api/state')).json();
  assert.equal(childState.activeProjectId, importedId, 'child window is pinned to the project');
  assert.equal(childState.window.child, true);
  assert.equal(childState.window.mainPort, 17795);
  assert.equal(childState.window.port, wport);
  // Same project again → the same window.
  r = await api('/api/projects/open-window', 'POST', { id: importedId });
  assert.equal(r.data.opened.url, win.url, 'already open → reuses the window');
  // The main window sees the lock: it cannot switch into, delete or re-open that project.
  r = await api('/api/projects/switch', 'POST', { id: importedId });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /cửa sổ khác/);
  assert.equal((await api('/api/projects/delete', 'POST', { id: importedId })).status, 400);
  assert.equal(
    (await api('/api/projects')).data.projects.find(p => p.id === importedId).window,
    wport,
    'project list shows which port holds the project',
  );
  // The active project cannot be opened a second time; a child does not create projects.
  assert.equal((await api('/api/projects/open-window', 'POST', { id: musicId })).status, 400);
  const cr = await fetch(win.url + 'api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(cr.status, 400, 'child window does not create projects');
  await cr.text();
  // Close it: the lock clears and the main window can switch into the project again.
  r = await api('/api/projects/close-window', 'POST', { id: importedId });
  assert.equal(r.status, 200);
  assert.ok(!r.data.openWindows.some(w => w.id === importedId));
  let sw;
  for (let i = 0; i < 50; i++) {
    sw = await api('/api/projects/switch', 'POST', { id: importedId });
    if (sw.status === 200) break;
    await new Promise(res => setTimeout(res, 100));
  }
  assert.equal(sw.status, 200, 'project free again after its window closed');
  await api('/api/projects/switch', 'POST', { id: musicId });

  // Typed reference sheets: name + description in, a house model-sheet prompt out. The
  // music template's identity/stage fields must never leak into them — that was the bug
  // that put "Adult singer… Grand concert theater" into every prop's prompt.
  const fields = (await api('/api/state')).data.fields;
  assert.match(fields.identity, /singer/i, 'music template still describes a singer');
  for (const [kind, zone, marker] of [
    ['prop', 'wardrobe', /Prop model sheet turnaround/],
    ['character', 'character', /Character model sheet turnaround of one single person/],
    ['scene', 'design', /Master wide establishing shot of the location/],
  ]) {
    r = await api('/api/nodes', 'POST', { kind });
    assert.equal(r.status, 201, kind + ' node created');
    const created = r.data.nodes.at(-1);
    assert.equal(created.role, kind, kind + ' keeps its role');
    assert.equal(created.zone, zone, kind + ' lands in its own column');
    // Before a description is typed the sheet must ALREADY be in force: falling through to
    // the generic prompt would paste the project's own singer and concert hall onto it.
    assert.match(created.resolvedPrompts.image, marker, kind + ' builds its sheet with no desc');
    assert.doesNotMatch(
      created.resolvedPrompts.image,
      /Adult singer|Grand concert theater|Burgundy velvet/,
      kind + ' with an empty description does not inherit the template fields',
    );
    s = (await api('/api/node', 'PATCH', { id: created.id, desc: 'a dented brass pocket watch' }))
      .data;
    const made = node(s, created.id);
    assert.equal(made.desc, 'a dented brass pocket watch');
    assert.match(made.resolvedPrompts.image, marker, kind + ' uses its own sheet prompt');
    assert.match(made.resolvedPrompts.image, /a dented brass pocket watch/);
    assert.doesNotMatch(
      made.resolvedPrompts.image,
      /Adult singer|Grand concert theater|Burgundy velvet/,
      kind + ' prompt does not leak the project template fields',
    );
  }
  // A prop sheet shows the one object three times and bans the things that break reuse.
  const propNode = (await api('/api/state')).data.nodes.find(n => n.role === 'prop');
  const propPrompt = propNode.resolvedPrompts.image;
  for (const rule of [
    /three views of that same object/,
    /not three different objects/,
    /no hands, no people/,
    /one soft even studio light from the same direction/,
  ])
    assert.match(propPrompt, rule, 'prop sheet keeps its consistency rule: ' + rule);
  // Editing the description invalidates the image that was made from the old one.
  await api('/api/upload', 'POST', { nodeId: propNode.id, mime: 'image/png', base64: PNG });
  s = (await api('/api/node', 'PATCH', { id: propNode.id, desc: 'a cracked glass vial' })).data;
  assert.equal(node(s, propNode.id).stale, true, 'new description marks the old image stale');
  assert.match(node(s, propNode.id).resolvedPrompts.image, /a cracked glass vial/);
  // Default names are what the library folder calls each file, so two sheets never share one.
  const autoNames = [];
  for (let i = 0; i < 3; i++)
    autoNames.push((await api('/api/nodes', 'POST', { kind: 'prop' })).data.nodes.at(-1).name);
  assert.equal(new Set(autoNames).size, 3, 'each new sheet gets a free default name');
  // A written prompt wins over the generated sheet, so editing the description under one
  // changes nothing — and must not age the image or the clips below it.
  const own = (await api('/api/nodes', 'POST', { kind: 'character' })).data.nodes.at(-1);
  await api('/api/node', 'PATCH', { id: own.id, prompt: 'My own hand-written prompt.' });
  await api('/api/upload', 'POST', { nodeId: own.id, mime: 'image/png', base64: PNG });
  const beforeDesc = node((await api('/api/state')).data, own.id).resolvedPrompts.image;
  s = (await api('/api/node', 'PATCH', { id: own.id, desc: 'a bald scarred man' })).data;
  assert.equal(node(s, own.id).desc, 'a bald scarred man', 'the description is still stored');
  assert.equal(
    node(s, own.id).resolvedPrompts.image,
    beforeDesc,
    'a written prompt keeps winning over the sheet',
  );
  assert.ok(!node(s, own.id).stale, 'a change that reaches no prompt does not age the image');

  // User templates: save the active project's skeleton, clone a new project from it, delete it.
  let tr = await api('/api/templates/save', 'POST', { name: 'Khung của tôi' });
  assert.equal(tr.status, 200, JSON.stringify(tr.data));
  assert.equal(tr.data.saved.name, 'Khung của tôi');
  assert.ok(tr.data.saved.nodeCount >= 1, 'template captured the project nodes');
  const tplId = tr.data.templates.find(t => t.name === 'Khung của tôi')?.id;
  assert.ok(tplId, 'listed after save');
  assert.ok(
    (await api('/api/state')).data.templates.some(t => t.id === tplId),
    'template is in the shared state',
  );
  const fromTpl = await api('/api/projects', 'POST', {
    name: 'Từ template',
    templateId: tplId,
    exportDir: path.join(dir, 'tu-tpl'),
  });
  assert.equal(fromTpl.status, 201, JSON.stringify(fromTpl.data));
  assert.equal(fromTpl.data.name, 'Từ template');
  assert.equal(fromTpl.data.nodes.length, tr.data.saved.nodeCount, 'cloned the template nodes');
  assert.ok(
    fromTpl.data.nodes.every(n => !n.video && (n.kind === 'setting' || !n.image)),
    'no rendered media cloned',
  );
  assert.ok(!fromTpl.data.jobs?.length, 'fresh job queue');
  assert.equal(
    (
      await api('/api/projects', 'POST', {
        name: 'x',
        templateId: 'nope',
        exportDir: path.join(dir, 'tpl-bad'),
      })
    ).status,
    400,
    'unknown template id rejected',
  );
  const del = await api('/api/templates/delete', 'POST', { id: tplId });
  assert.equal(del.status, 200);
  assert.ok(!del.data.templates.some(t => t.id === tplId), 'removed from the list');
  assert.equal(
    (await api('/api/templates/delete', 'POST', { id: tplId })).status,
    400,
    'deleting a gone template is rejected',
  );

  console.log(
    'PASS: default template + setting nodes, prompt injection, setting edit, no-gen on setting, zones, per-zone numbering + reorder, create/switch/delete projects, isolation, per-project media, export/import backup, custom export folder, wardrobe/look nodes, scene angles, sound column, arrange by timeline, clip nodes (upload, versions, staleness per clip, rewiring, wire guard, legacy lift keeps numbers), one library file per asset, clear forgets the kept image, working folders (required, library pickup, import, clear, no silent cross-project pull), secondary windows (open, lock, close), typed reference sheets (prop/character/scene: own prompt, no template-field leak, prop turnaround rules, description change marks stale), user templates (save skeleton, clone project, delete)',
  );
} finally {
  proc.kill();
}
