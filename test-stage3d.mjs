// 3D stage blocking: the shared geometry (public/js/stage-math.js — what the browser editor draws
// and captures, and what the server writes into prompts) and the whole flow through a real
// server: a band built from a blueprint, a shot list imported, the stage saved with real captures,
// then every shot's prompt, wiring, staleness and the image job's reference list checked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as M from './public/js/stage-math.js';
import { SHOT_LIST_HEADER } from './lib/shotlist.mjs';
import { templateFromProject } from './templates.mjs';

// --- Unit: who plays what, the default layout, the saved stage ----------------------------------
assert.equal(M.gearOf({ name: 'Ca sĩ chính', assetKey: 'singer' }), 'mic');
assert.equal(M.gearOf({ name: 'Cellist' }), 'cello', 'a cellist plays the cello');
assert.equal(M.gearOf({ name: 'Bass guitar player' }), 'bass', 'bass before guitar');
assert.equal(M.gearOf({ name: 'Keyboardist' }), 'keys');
assert.equal(M.gearOf({ name: 'Dancer' }), 'none');
const band = ['Ca sĩ chính', 'Pianist', 'Guitarist', 'Drummer', 'Violinist', 'Cellist'].map(
  (name, i) => ({ id: 'p' + i, name }),
);
const auto = M.autoLayout(band);
assert.equal(auto.length, 6);
assert.deepEqual(
  auto.map(p => p.gear),
  ['mic', 'grand_piano', 'guitar', 'drums', 'violin', 'cello'],
);
assert.ok(
  auto.find(p => p.gear === 'mic').z >
    Math.max(...auto.filter(p => p.gear !== 'mic').map(p => p.z)),
  'the singer stands in front of everyone',
);
assert.deepEqual(
  auto.filter(p => M.SEATED.has(p.gear)).map(p => p.pose),
  ['sit', 'sit', 'sit'],
  'piano, drums and cello players sit',
);
const front = { target: null, size: 'WS', angle: { kind: 'eye', side: 0 } };
assert.deepEqual(
  M.hidden({ performers: auto }, M.shotCamera({ performers: auto }, front)),
  [],
  'the default layout hides no face in the front wide',
);
const known = new Set(band.map(p => p.id));
const clean = M.cleanStage(
  {
    size: { w: 10, d: 6 },
    performers: [
      { id: 'p0', x: 99, z: -99, facing: 270, gear: 'mic' },
      { id: 'p0', x: 0, z: 0 }, // twice: kept once
      { id: 'ghost', x: 0, z: 0 }, // not a character
      { id: 'p1', x: -1, z: 0, facing: 0, gear: 'drums', pose: 'stand' },
      { id: 'p2', x: 1, z: 0, facing: 0, gear: 'kazoo' },
    ],
  },
  id => known.has(id),
);
assert.deepEqual(clean.size, { w: 10, d: 6 });
assert.deepEqual(
  clean.performers.map(p => [p.id, p.x, p.z, p.facing, p.pose, p.gear]),
  [
    ['p0', 5, -3, -90, 'stand', 'mic'],
    ['p1', -1, 0, 0, 'sit', 'drums'],
    ['p2', 1, 0, 0, 'stand', 'none'],
  ],
  'clamped to the floor, facing in -180…180, seated gear seats, unknown gear / ids dropped',
);

// --- Unit: cameras and what they see ----------------------------------------------------------
assert.equal(M.normSize('EWS'), 'EWS');
assert.equal(M.normSize('Medium'), 'MS');
assert.equal(M.normSize('MCU'), 'MCU');
assert.equal(M.normSize('Wide'), 'WS');
assert.equal(M.normSize('Macro'), 'Macro');
assert.deepEqual(M.normAngle('rear aisle'), { kind: 'rear', side: 0 });
assert.deepEqual(M.normAngle('left 3/4'), { kind: '34', side: -1 });
assert.deepEqual(M.normAngle('front high'), { kind: 'high', side: 0 });
const stage = { rev: 3, performers: auto };
const by = gear => auto.find(p => p.gear === gear);
const names = { mic: 'Singer', grand_piano: 'Pianist', guitar: 'Guitarist', drums: 'Drummer' };
const nameOf = id => names[auto.find(p => p.id === id).gear] || 'Other';
const order = (text, ...who) => who.map(w => text.indexOf(w + ' '));
// The front wide sees everyone, left to right as the audience does.
const wideText = M.blockingText(stage, front, nameOf);
assert.match(wideText, /^Stage blocking — /);
const [pi, si, gu] = order(wideText, 'Pianist', 'Singer', 'Guitarist');
assert.ok(
  pi >= 0 && pi < si && si < gu,
  'pianist left of the singer, guitarist right: ' + wideText,
);
// From behind the band the same marks read the other way round.
const rear = { target: null, size: 'WS', angle: { kind: 'rear', side: 0 } };
const rearText = M.blockingText(stage, rear, nameOf);
const [pr, sr, gr] = order(rearText, 'Pianist', 'Singer', 'Guitarist');
assert.ok(gr >= 0 && gr < sr && sr < pr, 'a rear camera flips left and right: ' + rearText);
assert.match(rearText, /Singer [^;]*back to camera/);
// A close-up on the singer: framed close, at most three performers named behind.
const cu = { target: by('mic'), size: 'CU', angle: { kind: '34', side: 0 } };
const cuText = M.blockingText(stage, cu, nameOf);
assert.match(cuText, /Singer framed close on the face/);
assert.ok((cuText.match(/softly out of focus/g) || []).length <= 3, cuText);
// The pianist in profile: the camera stays on the audience side, the pianist turned to one side.
const prof = M.shotCamera(stage, {
  target: by('grand_piano'),
  size: 'MS',
  angle: { kind: 'profile', side: 0 },
});
assert.ok(
  prof.pos[2] > by('grand_piano').z,
  'a profile camera stands downstage (the audience side)',
);
assert.match(
  M.blockingText(
    stage,
    { target: by('grand_piano'), size: 'MS', angle: { kind: 'profile', side: 0 } },
    nameOf,
  ),
  /Pianist [^;]*in profile/,
);
// A shot's framing comes from what its (opening) beat's SUBJECT names — never from how many
// people are wired in, which saving the stage changes.
const people6 = band.map(p => ({ ...p, role: 'character' }));
const gOf = (wired = {}) => ({
  node: id => people6.find(p => p.id === id),
  parents: id => (wired[id] || []).map(pid => people6.find(p => p.id === pid)),
  isPerson: x => !!x && x.role === 'character',
  isSet: () => false,
});
const shot = (subject, shotSize, angle = 'eye level', id = 'sh') => ({
  id,
  parts: [{ subject, shotSize, angle }],
});
const solo = { rev: 1, performers: [auto[0]] };
assert.deepEqual(
  [
    M.shotSpec(shot('Main stage', 'WS'), solo, gOf()),
    M.shotSpec(shot('Main stage', 'WS'), solo, gOf({ sh: ['p0'] })),
  ].map(s => s.target),
  [null, null],
  'a wide of the place stays a band framing once its one performer is wired in',
);
assert.equal(M.shotSpec(shot('Singer', 'EWS'), stage, gOf()).target, null, 'an EWS holds the band');
assert.equal(M.shotSpec(shot('Singer', 'WS'), stage, gOf()).target.gear, 'mic', 'a WS of one');
assert.equal(M.shotSpec(shot('Crowd waving phones', 'WS'), stage, gOf()), null, 'not the band');
assert.equal(M.shotSpec(shot('Piano keys', 'Macro'), stage, gOf()).target.gear, 'grand_piano');
// a merged shot opening on an insert is not staged, whoever its later beats wire in
assert.equal(
  M.shotSpec(
    {
      id: 'm',
      parts: [
        { subject: 'Candle', shotSize: 'Macro' },
        { subject: 'Singer', shotSize: 'CU' },
      ],
    },
    stage,
    gOf({ m: ['p0'] }),
  ),
  null,
);
// a band close-up names everyone (not "behind, out of focus" without a subject)
const bandCU = M.blockingText(
  stage,
  { target: null, size: 'CU', angle: { kind: 'eye', side: 0 } },
  nameOf,
);
assert.ok(bandCU.includes('Singer') && !bandCU.includes('out of focus'), bandCU);
// an extreme close-up from below keeps its own subject in the sentence
assert.match(
  M.blockingText(
    stage,
    { target: by('mic'), size: 'ECU', angle: { kind: 'low', side: 0 } },
    nameOf,
  ),
  /Singer framed close on the face/,
);
// from behind, a close-up is on the back of the head, not the face
assert.match(
  M.blockingText(
    stage,
    { target: by('mic'), size: 'CU', angle: { kind: 'rear', side: 0 } },
    nameOf,
  ),
  /Singer framed close on the back of the head and shoulders/,
);
// a performer that cannot be named (deleted since) is left out, the others keep their colours
const gone = id => (id === by('grand_piano').id ? null : nameOf(id));
assert.ok(!M.blockingText(stage, front, gone).includes('Pianist'));
assert.match(M.colorLegend(stage, gone), /^blue = Singer, green = Guitarist/);
// facing upstage, a 3/4 camera still swings toward centre stage
const upstage = { performers: [{ id: 'u', x: 3, z: 0, facing: 180, pose: 'stand', gear: 'none' }] };
assert.ok(
  Math.abs(
    M.shotCamera(upstage, {
      target: upstage.performers[0],
      size: 'MS',
      angle: { kind: '34', side: 0 },
    }).pos[0],
  ) < 3,
);
// A capture is identified by the stage revision and the framing.
assert.equal(M.layoutSig(stage, cu), `g2:3|${by('mic').id}|CU|34|0`);
assert.notEqual(M.layoutSig({ rev: 4 }, cu), M.layoutSig(stage, cu));
// A close-up of a seated player frames the face (where the mannequin's head is), not the chest.
assert.ok(
  Math.abs(M.shotCamera(stage, { ...cu, target: by('grand_piano') }).target[1] - 1.43) < 0.01,
);

// --- Unit: the tool frames every node itself -------------------------------------------------
// Free text (a CSV cell, a camera setting, a node's name): Vietnamese too, nothing when it names
// no size, and light is not an angle.
assert.equal(M.normSize('Toàn cảnh'), 'WS');
assert.equal(M.normSize('Cận cảnh'), 'CU');
assert.equal(M.normSize('Cận trung'), 'MCU');
assert.equal(M.normSize('Waist-up medium shot of the singer'), 'MS');
assert.equal(M.normSize('Shot 011 — Verse 1'), null);
assert.deepEqual(M.angleOf('warm light from behind'), { kind: null, side: 0 });
assert.deepEqual(M.angleOf('Low angle, backlit'), { kind: 'low', side: 0 });
assert.deepEqual(M.angleOf('góc thấp bên trái'), { kind: 'low', side: -1 });
// The set whose marks a node keeps: a staged one first — wired straight in, or wired into the
// location the node is filmed in — else the first set wired in.
const loc = { id: 'loc', role: 'scene' },
  other = { id: 'other', role: 'scene' },
  pinned = { id: 'pin', role: 'scene', stage3d: { performers: [auto[0]] } };
const all = [loc, other, pinned, ...people6];
const gSets = wired => ({
  node: id => all.find(x => x.id === id),
  parents: id => (wired[id] || []).map(k => all.find(x => x.id === k)),
  isPerson: x => x?.role === 'character',
  isSet: x => x?.role === 'scene',
});
assert.equal(M.setOf('s', gSets({ s: ['loc', 'pin'] })).id, 'pin', 'the staged set wins');
assert.equal(M.setOf('s', gSets({ s: ['loc'], loc: ['pin'] })).id, 'pin', 'via the location');
assert.equal(M.setOf('s', gSets({ s: ['other', 'loc'] })).id, 'other', 'none staged: the first');
// A node with no beat (hand-made or from a blueprint): who is wired in, its camera and its name.
const brief = s =>
  s && { t: s.target?.id || null, g: s.group || null, size: s.size, kind: s.angle.kind };
const gN = (wired, cam = '') => ({ ...gOf({ n: wired }), cameraText: () => cam });
const hand = name => ({ id: 'n', name });
assert.deepEqual(brief(M.shotSpec(hand('Ảnh mới 1'), stage, gN([]))), {
  t: null,
  g: null,
  size: 'WS',
  kind: 'eye',
});
assert.deepEqual(brief(M.shotSpec(hand('Ảnh mới 1'), stage, gN(['p0']))), {
  t: 'p0',
  g: null,
  size: 'MS',
  kind: 'eye',
});
// a close-up of two people wired in is on the first (the other behind); a medium frames both
assert.deepEqual(brief(M.shotSpec(hand('Cận cảnh'), stage, gN(['p1', 'p0']))), {
  t: 'p1',
  g: null,
  size: 'CU',
  kind: 'eye',
});
assert.deepEqual(brief(M.shotSpec(hand('Trung cảnh'), stage, gN(['p1', 'p0']))).g, ['p0', 'p1']);
// free text is read by phrases: numbers, a name ("Long"), a camera move or light say nothing
assert.equal(M.shotSpec(hand('Shot 34 — Long hát'), stage, gN(['p0'])).angle.kind, 'eye');
assert.equal(M.shotSpec(hand('Shot 34 — Long hát'), stage, gN(['p0'])).size, 'MS');
assert.equal(M.angleOf('slow push-in then pull back', true).kind, null);
assert.equal(
  M.angleOf('Over-the-shoulder wide looking at audience from stage, high emotional depth', true)
    .kind,
  'rear',
);
assert.equal(M.normSize('Cận cảnh ca sĩ áo đen dưới ánh đèn sân khấu'), 'CU');
assert.equal(M.normSize('Extreme close-up on fingers on keys/strings', true), 'Macro');
assert.equal(M.angleOf('Low angle against the stage lights').kind, 'low');
// real camera presets and names
assert.equal(
  M.angleOf(
    'Low Angle Hero. Low angle tracking upward shot, against towering overhead lighting trusses.',
    true,
  ).kind,
  'low',
);
assert.equal(M.normSize('Reaction Close. 85mm close reaction', true), 'CU');
assert.equal(M.normSize('Profile Dialogue. three-quarter close framing', true), 'CU');
assert.equal(M.normSize('Close on hands at the keys', true), 'Macro');
assert.equal(M.angleOf('Ánh sáng chiếu từ phía sau', true).kind, null);
assert.deepEqual(M.angleOf('Three-quarter left angle', true), { kind: '34', side: -1 });
assert.equal(M.shotSpec(hand('Đôi giày cũ'), stage, gN(['p0'])).size, 'MS', '"cũ" is no close-up');
assert.equal(M.shotSpec(hand('Cello Somber Drone'), stage, gN(['p0'])).angle.kind, 'eye');
// a few of the band wired in, no size: framed on them
assert.deepEqual(brief(M.shotSpec(hand('Ảnh mới'), stage, gN(['p0', 'p2']))).g, ['p0', 'p2']);
// a wide of the place holding one performer alone is on them
assert.equal(
  M.shotSpec(
    {
      id: 'i',
      parts: [{ subject: 'Opera house', shotSize: 'Wide', action: 'Singer isolated in vast hall' }],
    },
    stage,
    gOf(),
  ).target.id,
  'p0',
);
// a stage said to be empty is not the band
assert.equal(
  M.shotSpec(
    {
      id: 'e',
      parts: [{ subject: 'Stage', shotSize: 'EWS', action: 'Empty candlelit opera stage' }],
    },
    stage,
    gOf(),
  ),
  null,
);
// a CSV beat with no Subject is the place alone
assert.equal(M.shotSpec(shot('', 'WS'), stage, gOf()), null);
// a name starting with Đ is still named
assert.equal(
  M.shotSpec(
    shot('Đức', 'CU'),
    { performers: [{ ...auto[1], id: 'duc' }] },
    {
      ...gOf(),
      node: id => (id === 'duc' ? { id, name: 'Đức', role: 'character' } : null),
    },
  ).target.id,
  'duc',
);
assert.equal(M.shotSpec(hand('Cận cảnh'), stage, gN([])), null, 'a close-up of nobody');
assert.deepEqual(
  brief(M.shotSpec(hand('Shot 7'), stage, gN(['p0'], 'Wide establishing shot, full stage'))),
  { t: null, g: null, size: 'EWS', kind: 'eye' },
  'the wired camera setting decides the size',
);
// "A + B" frames the two of them; an extreme wide still holds the band
assert.deepEqual(brief(M.shotSpec(shot('Singer + Piano', 'MS'), stage, gOf())).g, ['p0', 'p1']);
assert.equal(M.shotSpec(shot('Singer + Piano', 'EWS'), stage, gOf()).group, undefined);
assert.ok(
  M.layoutSig(stage, M.shotSpec(shot('Singer + Piano', 'MS'), stage, gOf())).endsWith('|p0,p1'),
);
// a group is framed tighter than the band
const tightCam = M.shotCamera(stage, M.shotSpec(shot('Singer + Piano', 'MS'), stage, gOf()));
const bandCam = M.shotCamera(stage, front);
assert.ok(
  Math.hypot(...tightCam.pos.map((v, i) => v - tightCam.target[i])) <
    Math.hypot(...bandCam.pos.map((v, i) => v - bandCam.target[i])),
);
// through angle plate B (the reverse of the master view) the node is seen from behind
const plateB = { id: 'b', role: 'angle', preset: 'b' };
assert.equal(
  M.shotSpec(shot('Singer', 'CU', ''), stage, {
    ...gOf(),
    parents: id => (id === 'sh' ? [plateB] : []),
  }).angle.kind,
  'rear',
);
// every beat framed: a shot opening on a candle cuts to the singer
assert.deepEqual(
  M.beatSpecs(
    {
      id: 'm',
      parts: [
        { subject: 'Candle', shotSize: 'Macro' },
        { subject: 'Singer', shotSize: 'CU' },
      ],
    },
    stage,
    gOf(),
  ).map(s => s?.target?.id || null),
  [null, 'p0'],
);
assert.equal(
  M.framingLabel({ size: 'MCU', angle: { kind: '34', side: -1 }, target: 'p0' }, () => 'Ca sĩ'),
  'Cận trung · 3/4 trái · Ca sĩ',
);

// --- Through the server -------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-stage3d-'));
const ff = args => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args]);
  if (r.status) throw new Error('ffmpeg: ' + r.stderr);
};
const still = (color, file) => {
  ff(['-f', 'lavfi', '-i', `color=c=${color}:s=160x90`, '-frames:v', '1', path.join(tmp, file)]);
  return fs.readFileSync(path.join(tmp, file)).toString('base64');
};
const PNG = still('white', 'ref.png');
const JPG = still('gray', 'cap.jpg');
const PORT = 17890;
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    MV_PORT: String(PORT),
    MV_ORBIT_URL: 'http://127.0.0.1:1',
    MV_DATA_DIR: path.join(tmp, 'data'),
  },
  stdio: 'pipe',
});
const api = async (p, method = 'GET', b) => {
  const r = await fetch(`http://127.0.0.1:${PORT}` + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json() };
};
// The project graph as the browser editor reads it (public/js/stage3d.js graphOf).
const graphOf = s => {
  const byId = new Map(s.nodes.map(n => [n.id, n]));
  return {
    node: id => byId.get(id),
    parents: id =>
      s.edges
        .filter(e => e.target === id)
        .map(e => byId.get(e.source))
        .filter(x => x && x.kind !== 'setting'),
    isPerson: x => !!x && x.role !== 'look' && (x.role === 'character' || x.zone === 'character'),
    isSet: x =>
      !!x &&
      !x.terminal &&
      x.kind !== 'setting' &&
      x.role !== 'angle' &&
      (x.role === 'scene' || x.zone === 'design'),
    cameraText: id =>
      M.cameraTextOf(s.edges.filter(e => e.target === id).map(e => byId.get(e.source))),
  };
};
try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });
  // A band of six and their stage, from a blueprint (no LLM needed).
  const sheet = who =>
    `Character model sheet turnaround of a ${who}, portrait and front/side/back views.`;
  const cast = [
    ['singer', 'Ca sĩ chính'],
    ['pianist', 'Pianist'],
    ['guitarist', 'Guitarist'],
    ['drummer', 'Drummer'],
    ['violinist', 'Violinist'],
    ['cellist', 'Cellist'],
  ];
  let r = await api('/api/director/build', 'POST', {
    blueprint: {
      project: { name: 'Stage Test', theme: 'music' },
      style: 'Cinematic 35mm, warm stage light.',
      assets: [
        ...cast.map(([key, name]) => ({ key, role: 'character', name, prompt: sheet(name) })),
        { key: 'main_stage', role: 'scene', name: 'Main stage', prompt: 'Concert stage, wide.' },
      ],
      cameras: [{ key: 'wide', name: 'Wide', config: 'Wide.' }],
      shots: [
        { name: 'Mẫu', start: 0, duration: 8, uses: ['singer', 'main_stage'], camera: 'wide' },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = key => r.data.nodes.find(n => n.assetKey === key).id;
  const people = Object.fromEntries(cast.map(([key]) => [key, id(key)]));
  const setId = id('main_stage');
  // Every reference has its picture (a job is refused before that).
  for (const nid of [...Object.values(people), setId]) {
    r = await api('/api/upload', 'POST', {
      nodeId: nid,
      kind: 'image',
      mime: 'image/png',
      base64: PNG,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  // The shot list (one shot per row) on that stage.
  r = await api('/api/nodes', 'POST', { kind: 'music' });
  const musicId = r.data.nodes.find(n => n.kind === 'music').id;
  const CSV =
    SHOT_LIST_HEADER +
    '\n' +
    [
      '001,00:00.000,00:04.000,Intro,,NO,3,"calm — still",Band,Main stage,WS,eye level,locked,The band waits in warm light',
      '002,00:04.000,00:07.000,Verse,Line one here,YES,4,"hope — soft eyes; soft voice",Singer,Main stage,CU,eye level,slow push-in,Sings to the lens',
      '003,00:07.000,00:10.000,Verse,Line two here,YES,4,"doubt — eyes down",Singer,Main stage,MCU,rear,locked,Faces the hall',
      '004,00:10.000,00:13.000,Verse,,NO,4,"focus — calm hands",Pianist,Main stage,MS,profile,dolly left,Plays a chord',
      '005,00:13.000,00:15.000,Verse,,NO,3,"stillness — flicker",Candle,Main stage,Macro,eye level,locked,A candle flickers',
      '006,00:15.000,00:19.000,Chorus,,NO,8,"joy — open faces",Band,Main stage,WS,rear,crane up,The band seen from behind',
    ].join('\n');
  r = await api('/api/music/import', 'POST', {
    id: musicId,
    csv: CSV,
    replaceShots: true,
    autoWire: true,
    targetSeconds: 0,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = (s, k) => s.nodes.find(n => n.zone === 'production' && n.parts?.[0]?.shot === k);
  // The CU already has a picture: the stage must mark it out of date.
  r = await api('/api/upload', 'POST', {
    nodeId: row(r.data, '002').id,
    kind: 'image',
    mime: 'image/png',
    base64: PNG,
  });
  let s = r.data;
  const wiredBefore = M.wiredPeople(row(s, '001').id, graphOf(s)).length;

  // Save the stage, as the editor does: the marks, the front wide and each shot's framing.
  const marks = [
    { id: people.singer, x: 0, z: 1.8, facing: 0, gear: 'mic' },
    { id: people.pianist, x: -4.6, z: -0.6, facing: 70, gear: 'grand_piano' },
    { id: people.guitarist, x: 2.8, z: 0.6, facing: -20, gear: 'guitar' },
    { id: people.drummer, x: 1.4, z: -2.4, facing: -10, gear: 'drums' },
    { id: people.violinist, x: -2, z: 1.2, facing: 20, gear: 'violin' },
    { id: people.cellist, x: -1, z: -1.6, facing: 15, gear: 'cello' },
  ];
  const planned = M.cleanStage({ performers: marks }, () => true);
  const g = graphOf(s);
  const captures = ['001', '002', '003', '004', '006'].map(k => {
    const spec = M.shotSpec(row(s, k), planned, g);
    return { shotId: row(s, k).id, key: M.layoutSig({ rev: 0 }, spec), image: JPG };
  });
  // the candle insert is not framed on the stage: its capture is refused
  assert.equal(M.shotSpec(row(s, '005'), planned, g), null, 'an insert has no stage framing');
  captures.push({ shotId: row(s, '005').id, key: '0|-|Macro|eye|0', image: JPG });
  r = await api('/api/stage3d', 'POST', {
    sceneId: setId,
    stage: { performers: marks },
    wide: 'data:image/jpeg;base64,' + JPG,
    captures,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  assert.deepEqual(
    { ...s.stage3dSummary, wired: s.stage3dSummary.wired > 0 },
    { performers: 6, shots: 6, staged: 5, captures: 5, wired: true, stale: 1 },
  );
  const set = s.nodes.find(n => n.id === setId);
  assert.equal(set.stage3d.rev, 1);
  assert.equal(set.stage3d.performers.length, 6);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}` + set.stage3d.capture.url)).status, 200);
  // The band wide now holds every performer, each with their own reference.
  assert.equal(M.wiredPeople(row(s, '001').id, graphOf(s)).length, 6);
  assert.ok(wiredBefore < 6, 'it did not before');
  const img = k => row(s, k).resolvedPrompts.image;
  // Front wide: left to right as placed, every one numbered, and the capture named last.
  const w = img('001');
  const at = name => w.indexOf(name + ' [');
  assert.ok(at('Pianist') < at('Ca sĩ chính') && at('Ca sĩ chính') < at('Guitarist'), w);
  const refs = row(s, '001').references.length;
  assert.ok(w.includes(`[${refs + 1}] (the last attached image) is a 3D blocking sketch`), w);
  assert.match(w, /Mannequin colours: blue = Ca sĩ chính \[\d\], red = Pianist \[\d\]/);
  // Rear wide: the same marks the other way round.
  const rw = img('006');
  assert.ok(
    rw.indexOf('Guitarist [') < rw.indexOf('Pianist ['),
    'left/right flipped from behind: ' + rw,
  );
  // Singer from behind; pianist in profile.
  assert.match(img('003'), /Ca sĩ chính \[\d\] framed chest-up, [^;]*back to camera/);
  assert.match(img('004'), /Pianist \[\d\] [^;]*in profile/);
  // The insert: no blocking, no capture.
  assert.ok(!img('005').includes('Stage blocking'), 'the candle insert is not blocked');
  assert.equal(row(s, '005').layout, undefined);
  // The CU that had a picture is out of date; a video prompt never names the capture.
  assert.equal(row(s, '002').stale, true);
  assert.ok(!row(s, '001').resolvedPrompts.video.includes('3D blocking sketch'));

  // The image job sends the shot's references, then the capture of its framing — last.
  assert.equal((await api('/api/project', 'PATCH', { defaults: { image: 'web' } })).status, 200);
  r = await api('/api/jobs', 'POST', { nodeId: row(s, '001').id, kind: 'image' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const sent = r.data.job.payload.references;
  assert.equal(sent.length, refs + 1);
  assert.equal(sent.at(-1).role, 'layout');
  assert.equal(sent.at(-1).asset.id, row(s, '001').layout.asset.id);
  assert.ok(r.data.job.payload.prompt.includes(`[${refs + 1}] (the last attached image)`));
  r = await api('/api/jobs/cancel', 'POST', { id: r.data.job.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  // Moving a performer is a new stage revision: until the editor captures again, the old pictures
  // are not sent (nor named), while the blocking text already follows the new marks.
  r = await api('/api/stage3d', 'POST', {
    sceneId: setId,
    stage: {
      performers: marks.map(p => (p.gear === 'grand_piano' ? { ...p, x: 4.8, facing: -70 } : p)),
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  assert.equal(s.nodes.find(n => n.id === setId).stage3d.rev, 2);
  const w2 = img('001');
  assert.ok(!w2.includes('3D blocking sketch'), 'an old capture is not sent');
  assert.ok(
    w2.indexOf('Guitarist [') < w2.indexOf('Pianist ['),
    'the pianist moved to the right: ' + w2,
  );
  // Taking everyone off the stage removes the blocking.
  r = await api('/api/stage3d', 'POST', { sceneId: setId, stage: { performers: [] } });
  assert.equal(r.status, 200);
  // (its revision kept, never restarted: a capture of an older stage can never pass for a new one)
  assert.deepEqual(
    { ...r.data.nodes.find(n => n.id === setId).stage3d, size: undefined },
    { v: 2, size: undefined, performers: [], rev: 3 },
  );
  assert.ok(!row(r.data, '001').resolvedPrompts.image.includes('Stage blocking'));
  // Only a set takes a stage.
  r = await api('/api/stage3d', 'POST', { sceneId: people.singer, stage: { performers: marks } });
  assert.equal(r.status, 400);

  // Stage again and capture every framed shot, as the editor does.
  const mediaHas = id =>
    fs.readdirSync(path.join(tmp, 'data'), { recursive: true }).some(f => String(f).endsWith(id));
  const saveStage = async (performers, image) => {
    const st = (await api('/api/state')).data;
    const plan = M.cleanStage({ performers }, () => true);
    const gg = graphOf(st);
    const caps = st.nodes
      .filter(n => n.zone === 'production' && !n.terminal)
      .map(n => ({ n, spec: M.shotSpec(n, plan, gg) }))
      .filter(x => x.spec)
      .map(({ n, spec }) => ({ shotId: n.id, key: M.layoutSig({ rev: 0 }, spec), image }));
    const res = await api('/api/stage3d', 'POST', {
      sceneId: setId,
      stage: { performers },
      wide: image,
      captures: caps,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.stage3dSummary.captures, caps.length, 'every capture taken');
    return res.data;
  };
  const JPG2 = still('blue', 'cap2.jpg'),
    JPG3 = still('red', 'cap3.jpg');
  s = await saveStage(marks, JPG);
  // A prompt saved after it was decorated: its blocking and capture lines are the current ones,
  // once — never frozen at the marks of the day it was saved.
  r = await api('/api/node', 'PATCH', {
    id: row(s, '001').id,
    prompt: img('001') + ' Warm smile.',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const moved = marks.map(p => (p.gear === 'grand_piano' ? { ...p, x: 4.8, facing: -70 } : p));
  s = await saveStage(moved, JPG2);
  const kept = img('001');
  assert.equal(kept.split('Stage blocking —').length - 1, 1, 'one blocking line: ' + kept);
  assert.equal(kept.split('3D blocking sketch').length - 1, 1, 'one capture line');
  assert.ok(kept.includes('Warm smile.'), 'the user’s words stay');
  assert.ok(kept.indexOf('Guitarist [') < kept.indexOf('Pianist ['), 'the current marks: ' + kept);
  // Saving the same picture keeps its file (a job made from it stays current); a new picture
  // replaces the file, the old one is removed.
  const same = row(s, '004').layout.asset.id;
  s = await saveStage(moved, JPG2);
  assert.equal(row(s, '004').layout.asset.id, same);
  s = await saveStage(moved, JPG3);
  assert.notEqual(row(s, '004').layout.asset.id, same);
  assert.equal(mediaHas(same), false, 'the replaced capture file is gone');
  assert.ok(mediaHas(row(s, '004').layout.asset.id));
  // Re-importing the CSV keeps each row's capture (still the framing on this stage).
  const lay = row(s, '004').layout.asset.id;
  r = await api('/api/music/import', 'POST', {
    id: musicId,
    csv: CSV,
    replaceShots: true,
    autoWire: true,
    targetSeconds: 0,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  assert.equal(row(s, '004').layout?.asset.id, lay, 'capture carried to the re-imported row');
  assert.ok(img('004').includes('3D blocking sketch'));
  assert.equal(M.wiredPeople(row(s, '001').id, graphOf(s)).length, 6, 'the wide wired again');
  // A character deleted after the stage was saved: no longer named; the others keep their
  // colours (the capture still shows them that way until the next save).
  r = await api('/api/nodes/delete', 'POST', { id: people.cellist });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = (await api('/api/state')).data;
  assert.ok(!img('001').includes('Cellist'), img('001'));
  assert.match(img('001'), /Mannequin colours: blue = Ca sĩ chính \[\d\], red = Pianist/);
  // A template keeps the marks, never the pictures (they are the old project's media).
  const tpl = templateFromProject({ nodes: s.nodes, edges: s.edges, name: 'T', theme: 'music' });
  assert.ok(tpl.nodes.every(n => !n.layout && !n.stage3d?.capture));
  assert.ok(tpl.nodes.find(n => n.id === setId).stage3d.performers.length >= 5);

  // --- A 3D stage node: marks and no picture, wired into whatever uses it ------------------------
  // The location is unpinned; a separate stage node holds the marks from now on.
  r = await api('/api/stage3d', 'POST', { sceneId: setId, stage: { performers: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('/api/nodes', 'POST', { kind: 'stage' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const stageId = r.data.nodes.at(-1).id;
  assert.equal(r.data.nodes.at(-1).stageOnly, true, 'a stage node, pinned or not yet');
  // wired into the location before it is pinned: the location's picture stays current
  for (const k of ['005'])
    await api('/api/upload', 'POST', {
      nodeId: row(r.data, k).id,
      kind: 'image',
      mime: 'image/png',
      base64: PNG,
    });
  s = (await api('/api/state')).data;
  r = await api('/api/edges', 'PUT', { edges: [...s.edges, { source: stageId, target: setId }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(!r.data.nodes.find(n => n.id === setId).stale, 'the location stays current');
  r = await api('/api/edges', 'PUT', { edges: r.data.edges.filter(e => e.source !== stageId) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // a location left blank and pinned stays a location (an image input, rendered from its name)
  r = await api('/api/nodes', 'POST', { kind: 'scene' });
  const blank = r.data.nodes.at(-1).id;
  r = await api('/api/stage3d', 'POST', {
    sceneId: blank,
    stage: { performers: marks.slice(0, 1) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.nodes.find(n => n.id === blank).stageOnly, undefined);
  r = await api('/api/jobs', 'POST', { nodeId: blank, kind: 'image' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await api('/api/jobs/cancel', 'POST', { id: r.data.job.id })).status, 200);
  assert.equal((await api('/api/nodes/delete', 'POST', { id: blank })).status, 200);
  const five = marks.filter(p => p.gear !== 'cello'); // (the cellist was deleted)
  r = await api('/api/stage3d', 'POST', { sceneId: stageId, stage: { performers: five } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  const stageRev = s.nodes.find(n => n.id === stageId).stage3d.rev;
  assert.equal(s.nodes.find(n => n.id === stageId).stageOnly, true);
  // it is never generated itself
  r = await api('/api/jobs', 'POST', { nodeId: stageId, kind: 'image' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /sân khấu 3D/);
  // Wired into one shot: that shot keeps its marks, sends no picture of the stage node (its
  // reference numbers stay) and can still be generated — with the blocking text until its capture
  // is taken.
  const refs4 = row(s, '004').references.length;
  r = await api('/api/edges', 'PUT', {
    edges: [...s.edges, { source: stageId, target: row(s, '004').id }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  assert.equal(row(s, '004').stagePin.setId, stageId);
  assert.equal(row(s, '004').stagePin.capture, 'missing');
  assert.equal(row(s, '004').references.length, refs4);
  assert.equal(row(s, '004').imageInputs, refs4);
  assert.equal(row(s, '001').stagePin, undefined, 'its location has no marks');
  r = await api('/api/jobs', 'POST', { nodeId: row(s, '004').id, kind: 'image' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.data.job.payload.prompt.includes('Stage blocking —'));
  assert.equal(r.data.job.payload.references.length, refs4, 'text only until its capture');
  r = await api('/api/jobs/cancel', 'POST', { id: r.data.job.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Wired into the location: every shot filmed there keeps the marks; the location keeps its
  // picture (the stage node is not an image of it).
  s = (await api('/api/state')).data;
  r = await api('/api/edges', 'PUT', { edges: [...s.edges, { source: stageId, target: setId }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  for (const k of ['001', '002', '003', '004', '006'])
    assert.equal(row(s, k).stagePin?.setId, stageId, k);
  assert.ok(row(s, '001').stagePin.sig.startsWith(stageId + ':'), 'a capture is filed by its set');
  assert.equal(row(s, '005').stagePin.sig, undefined, 'the candle: on the stage, not framed');
  assert.equal(row(s, '005').stale, false, 'and its picture is not aged by the stage');
  assert.ok(!s.nodes.find(n => n.id === setId).stale);
  // The browser captures the missing framings on its own: one picture per framing, taken while a
  // job waits in the queue, with no revision bump (that job stays current) and nothing out of date.
  const missing = s.nodes.filter(n => n.stagePin?.capture === 'missing');
  assert.equal(missing.length, 5);
  const bySig = new Map();
  for (const n of missing) bySig.set(n.stagePin.sig, [...(bySig.get(n.stagePin.sig) || []), n.id]);
  r = await api('/api/jobs', 'POST', { nodeId: row(s, '002').id, kind: 'image' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const waiting = r.data.job.id;
  s = (await api('/api/state')).data;
  const rev0 = s.revision,
    stale0 = s.nodes.filter(n => n.stale).length;
  const post = caps =>
    api('/api/stage3d/captures', 'POST', { projectId: s.activeProjectId, captures: caps });
  r = await api('/api/stage3d/captures', 'POST', { projectId: 'other', captures: [] });
  assert.equal(r.status, 400, 'another project’s captures are refused');
  r = await post([{ sig: 'g2:0|-|WS|eye|0', shotIds: [row(s, '001').id], image: JPG }]);
  assert.equal(r.data.stage3dStored, 0, 'a framing that is not the shot’s is refused');
  r = await post([...bySig].map(([sig, shotIds]) => ({ sig, shotIds, image: JPG2 })));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stage3dStored, 5);
  s = r.data;
  assert.equal(s.revision, rev0);
  assert.equal(s.nodes.filter(n => n.stale).length, stale0);
  assert.ok(s.nodes.filter(n => n.stagePin?.sig).every(n => n.stagePin.capture === 'sent'));
  assert.equal(
    new Set(s.nodes.filter(n => n.stagePin?.sig).map(n => n.layout.asset.id)).size,
    bySig.size,
    'one file per framing',
  );
  assert.equal(
    (await post([...bySig].map(([sig, shotIds]) => ({ sig, shotIds, image: JPG3 })))).data
      .stage3dStored,
    0,
    'sent twice: kept once',
  );
  r = await api('/api/jobs/cancel', 'POST', { id: waiting });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Pinning the same marks again changes nothing: the same revision, every capture current.
  r = await api('/api/stage3d', 'POST', { sceneId: stageId, stage: { performers: five } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.nodes.find(n => n.id === stageId).stage3d.rev, stageRev);
  assert.equal(r.data.stage3dSummary.stale, 0);
  assert.ok(r.data.nodes.filter(n => n.stagePin?.sig).every(n => n.stagePin.capture === 'sent'));
  // Out of date is about the marks a shot SEES: renaming a performer ages nothing; moving the
  // drummer ages the band wide (it shows him), not the singer's rear close-up (it does not).
  for (const k of ['001', '003'])
    assert.equal(
      (
        await api('/api/upload', 'POST', {
          nodeId: row(s, k).id,
          kind: 'image',
          mime: 'image/png',
          base64: PNG,
        })
      ).status,
      200,
    );
  r = await api('/api/node', 'PATCH', { id: people.guitarist, name: 'Guitarist Lead' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(row(r.data, '001').stale, false, 'a rename ages nothing');
  r = await api('/api/stage3d', 'POST', {
    sceneId: stageId,
    stage: { performers: five.map(p => (p.gear === 'drums' ? { ...p, x: -5.5 } : p)) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  assert.equal(row(s, '001').stale, true, 'the band wide shows the drummer');
  assert.equal(row(s, '003').stale, false, 'the rear close-up does not');
  assert.ok(s.stage3dSummary.stale >= 1);
  // A node made by hand and wired to the stage node: the tool frames it (nobody wired: the band,
  // full stage) and wires in everyone it shows.
  r = await api('/api/nodes', 'POST', {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const hand = r.data.nodes.at(-1).id;
  r = await api('/api/edges', 'PUT', {
    edges: [...r.data.edges, { source: stageId, target: hand }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  const handPin = s.nodes.find(n => n.id === hand).stagePin;
  assert.deepEqual([handPin.size, handPin.target, handPin.group], ['WS', null, null]);
  assert.equal(M.wiredPeople(hand, graphOf(s)).length, 5, 'the band it shows, wired in');
  // A performer the user unwires stays unwired when the stage is pinned again.
  r = await api('/api/edges', 'PUT', {
    edges: s.edges.filter(e => !(e.source === people.drummer && e.target === hand)),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('/api/stage3d', 'POST', {
    sceneId: stageId,
    stage: { performers: five.map(p => (p.gear === 'violin' ? { ...p, facing: 35 } : p)) },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(!M.wiredPeople(hand, graphOf(r.data)).includes(people.drummer));
  // A stage node wired straight into a shot follows it through a re-import of the CSV.
  r = await api('/api/music/import', 'POST', {
    id: musicId,
    csv: CSV,
    replaceShots: true,
    autoWire: true,
    targetSeconds: 0,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(
    r.data.edges.some(e => e.source === stageId && e.target === row(r.data, '004').id),
    'kept through the re-import',
  );
  // Deleting the stage node: the location's picture stays current, its shots lose the marks.
  r = await api('/api/nodes/delete', 'POST', { id: stageId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(!r.data.nodes.find(n => n.id === setId).stale);
  assert.equal(row(r.data, '001').stagePin, undefined);

  // The vendored three.js and the editor module are served to the browser.
  for (const p of [
    '/vendor/three/three.module.js',
    '/vendor/three/three.core.js',
    '/vendor/three/addons/controls/OrbitControls.js',
    '/vendor/three/addons/controls/TransformControls.js',
    '/js/stage3d.js',
    '/js/stage-math.js',
  ]) {
    const res = await fetch(`http://127.0.0.1:${PORT}` + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /javascript/, p);
  }
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/vendor/three/../../server.mjs`)).status, 404);
  console.log(
    'PASS: 3D stage — gear from names, default band layout (singer in front, seated players sit, no hidden face in the front wide), saved stage cleaned (clamped, unknown ids/gear dropped), ' +
      'shot cameras (front wide left→right, rear flips sides, CU names ≤3 behind, profile stays downstage, capture keyed by revision + framing); ' +
      'server: band wide wired to every performer in frame, blocking per shot camera with image numbers, capture named last with the colour legend, inserts untouched, pictured shots marked out of date, image job sends the capture last, a new revision drops old captures while the text follows the marks, clearing the stage, only sets; framing from the subject (stable when the stage wires people in, EWS = band, crowd/insert not staged, merged insert opening not staged), band close-ups name everyone, ECU from below keeps its subject, rear close-up on the back of the head, deleted performers unnamed with colours kept, decorated prompts re-blocked once, same capture keeps its file and a replaced one is removed, re-import carries captures, templates drop captures; the tool frames every node (Vietnamese / camera-setting sizes, light is no angle, A + B as a group, plate B from behind, every beat, seated close-ups on the face); a 3D stage node (no picture): never generated, wired into a shot or its location every shot there keeps its marks without blocking generation or renumbering references, browser captures stored per framing while a job waits (no revision bump, nothing aged, refused for another project or framing, idempotent), re-pinning the same marks keeps the revision, renames age nothing and only shots that see a moved performer go out of date, a hand-made node is framed on the band and wired in; vendored three.js served',
  );
} finally {
  proc.kill();
}
