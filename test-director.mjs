// Director: blueprint → full node graph with wiring, plus the LLM auto path.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildGraph, parseBlueprint } from './director.mjs';

// --- Unit: blueprint parsing + graph building (no server) ---
const bp = {
  project: { name: 'Test MV', theme: 'music' },
  style: 'Cinematic 35mm photorealistic, no CGI',
  assets: [
    { key: 'singer', role: 'character', name: 'Ca sĩ', prompt: 'singer model sheet' },
    { key: 'guitarist', role: 'character', name: 'Guitarist', prompt: 'guitarist playing' },
    { key: 'stage', role: 'scene', name: 'Sân khấu', prompt: 'wide stage' },
  ],
  cameras: [
    { key: 'wide', name: 'Wide', config: 'wide establishing shot' },
    { key: 'close', name: 'Close', config: 'macro close-up' },
  ],
  shots: [
    {
      name: 'Shot 1',
      start: 0,
      duration: 8,
      uses: ['singer', 'stage'],
      camera: 'wide',
      lyric: 'la la',
      videoPrompt: 'Pace: x. Prompt Video: y.',
    },
    {
      name: 'Shot 2',
      start: 8,
      duration: 10,
      uses: ['guitarist'],
      camera: 'close',
      videoPrompt: 'z',
    },
  ],
};
const g = buildGraph(bp);
assert.equal(g.name, 'Test MV');
const byName = n => g.nodes.find(x => x.name === n);
// Characters, scene, setup (style+cameras), shots across the 5 zones.
assert.equal(g.nodes.filter(n => n.zone === 'character').length, 2); // singer + guitarist
assert.equal(g.nodes.filter(n => n.zone === 'design').length, 1); // stage
assert.equal(g.nodes.filter(n => n.zone === 'setup').length, 3); // style + 2 cameras
assert.equal(g.nodes.filter(n => n.zone === 'production').length, 2);
assert.equal(byName('Style').kind, 'setting');
assert.equal(byName('Style').zone, 'setup');
assert.equal(byName('Ca sĩ').zone, 'character');
assert.equal(byName('Sân khấu').zone, 'design');
assert.equal(byName('Wide').settingType, 'camera');
assert.equal(byName('Ca sĩ').prompt, 'singer model sheet');
assert.equal(byName('Shot 1').videoInput, 'refs');
assert.equal(byName('Shot 2').duration, 10);
// Shot 1 wired to singer, stage, wide-camera and style.
const s1 = byName('Shot 1').id;
const parents = g.edges.filter(e => e.target === s1).map(e => e.source);
assert.ok(parents.includes(byName('Ca sĩ').id));
assert.ok(parents.includes(byName('Sân khấu').id));
assert.ok(parents.includes(byName('Wide').id));
assert.ok(parents.includes(byName('Style').id));
assert.ok(!parents.includes(byName('Guitarist').id), 'Shot 1 does not use the guitarist');
// A shot with no "prompt" gets its image prompt from the blueprint's own videoPrompt
// (composition + staging), never the project's default template fields; and the baked
// "Camera:/Style:" tail is stripped so the wired setting nodes are the single source.
const baked = buildGraph({
  project: { name: 'Baked', theme: 'music' },
  style: 'Kodak Vision3, teal-orange, no CGI',
  assets: [{ key: 'singer', role: 'character', name: 'Ca sĩ', prompt: 'ref singer' }],
  cameras: [{ key: 'close', name: 'Close', config: 'Tight emotional close-up on face.' }],
  shots: [
    {
      name: 'S1',
      duration: 8,
      uses: ['singer'],
      camera: 'close',
      videoPrompt:
        'Compose the connected reference images into one coherent shot. Preserve the referenced subjects. @singer center stage. Camera: Tight emotional close-up on face. Style: Kodak Vision3, teal-orange, no CGI, 16:9, no text.',
    },
  ],
});
const bshot = baked.nodes.find(n => n.name === 'S1');
assert.ok(
  /^Compose the connected reference images/.test(bshot.prompt),
  'image prompt from blueprint',
);
assert.ok(!/Camera:/i.test(bshot.prompt), 'baked Camera: stripped from the shot prompt');
assert.ok(!/Burgundy|wavy hair|polished wooden/i.test(bshot.prompt), 'no default-template leakage');

// Drama (Google VEO) blueprint: project.title, role:"prop", a keyed "styles" array, and
// shots that list their camera + style keys in "uses" (plus the scalar camera/style).
const drama = buildGraph({
  project: { title: 'Bẫy Ngầm (The Trap)', country_setting: 'Việt Nam' },
  styles: [
    {
      key: 'style_main',
      name: 'Gothic 35mm',
      prompt: 'Cinematic 35mm anamorphic, chiaroscuro, photorealistic.',
    },
  ],
  assets: [
    { key: 'wife', role: 'character', name: 'Người vợ', prompt: 'model sheet wife' },
    { key: 'husband', role: 'character', name: 'Người chồng', prompt: 'model sheet husband' },
    { key: 'scene_table', role: 'scene', name: 'Bàn ăn', prompt: 'dining table' },
    { key: 'prop_card', role: 'prop', name: 'Thẻ khách sạn', prompt: 'hotel keycard macro' },
  ],
  cameras: [{ key: 'ots', name: 'OTS', config: 'over-the-shoulder push-in' }],
  shots: [
    {
      name: 'Shot 01',
      start: 0,
      duration: 7,
      beat: 'setup',
      uses: ['wife', 'husband', 'scene_table', 'prop_card', 'ots', 'style_main'],
      camera: 'ots',
      style: 'style_main',
      dialogue: 'Anh về muộn.',
      videoPrompt:
        'Veo Video Prompt: @wife and @husband at @scene_table. Camera: over-the-shoulder. Lighting & Physics: amber chiaroscuro, 16:9, cinematic 35mm, no text.',
    },
  ],
});
assert.equal(drama.name, 'Bẫy Ngầm (The Trap)', 'name comes from project.title');
assert.equal(drama.theme, 'film', 'drama defaults to the film theme');
const dByName = n => drama.nodes.find(x => x.name === n);
assert.equal(dByName('Người vợ').zone, 'character');
assert.equal(dByName('Bàn ăn').zone, 'design');
assert.equal(dByName('Thẻ khách sạn').zone, 'design', 'a prop is a reference image');
assert.equal(dByName('Gothic 35mm').settingType, 'style', 'styles[] entry becomes a Style node');
assert.equal(dByName('Gothic 35mm').zone, 'setup');
assert.match(dByName('Gothic 35mm').config, /Kodak|anamorphic/, 'style prompt is the config');
const dShot = dByName('Shot 01');
// The lighting + safety tail of the VEO prompt is kept; only the inline "Camera:" sentence
// goes, because the wired camera node now injects "Camera: …" (no duplicate).
assert.match(dShot.videoPrompt, /@wife and @husband at @scene_table\. Lighting & Physics: amber/);
assert.ok(!/Camera:/.test(dShot.videoPrompt), 'inline Camera: sentence dropped');
assert.equal(dShot.prompt, dShot.videoPrompt, 'keyframe prompt mirrors the VEO prompt');
assert.equal(dShot.lyric, 'Anh về muộn.', 'dialogue mapped to the shot line');
// The shot is wired to its 4 reference assets AND to its camera + style nodes.
const dParents = drama.edges.filter(e => e.target === dShot.id).map(e => e.source);
assert.equal(dParents.length, 6, '4 reference assets + camera + style');
assert.ok(dParents.includes(dByName('Thẻ khách sạn').id));
assert.ok(dParents.includes(dByName('OTS').id), 'camera wired for drama');
assert.ok(dParents.includes(dByName('Gothic 35mm').id), 'style wired for drama');
// Camera before style in the edge order → "Camera: … Style: …" in the injected prompt text.
assert.ok(
  dParents.indexOf(dByName('OTS').id) < dParents.indexOf(dByName('Gothic 35mm').id),
  'camera edge precedes style edge',
);
// A drama shot whose camera key is unknown keeps its inline camera sentence (nothing to
// replace it), and a style named in "uses" alone (no scalar) still wires.
const loose = buildGraph({
  project: { title: 'Loose' },
  styles: [
    { key: 'style_main', name: 'Main', prompt: 'main look' },
    { key: 'style_flash', name: 'Flashback', prompt: 'sepia' },
  ],
  assets: [{ key: 'a', role: 'prop', name: 'A', prompt: 'p' }],
  shots: [
    {
      name: 'L1',
      duration: 5,
      uses: ['a', 'style_flash'],
      camera: 'missing_cam',
      videoPrompt: 'Veo: @a. Camera: handheld. Lighting & Physics: dusk.',
    },
  ],
});
const lShot = loose.nodes.find(n => n.name === 'L1');
assert.match(lShot.videoPrompt, /Camera: handheld\./, 'inline camera kept when no camera node');
const lParents = loose.edges.filter(e => e.target === lShot.id).map(e => e.source);
assert.ok(lParents.includes(loose.nodes.find(n => n.name === 'Flashback').id), 'style via uses');
assert.ok(!lParents.includes(loose.nodes.find(n => n.name === 'Main').id), 'other style not wired');

// Wardrobe: a character's costume + personal items for one scene context. It becomes a
// node in the wardrobe zone wired FROM its character (face reference); a shot that uses it
// gets the wardrobe image INSTEAD of the bare character, so the costume cannot drift.
const dressed = buildGraph({
  project: { title: 'Wardrobe' },
  assets: [
    { key: 'eleanor', role: 'character', name: 'Eleanor', prompt: 'model sheet' },
    {
      key: 'eleanor_mourning',
      role: 'wardrobe',
      character: 'eleanor',
      name: 'Eleanor — tang lễ',
      outfit: 'charcoal mourning dress, black gloves',
      items: ['black umbrella', 'silver locket'],
    },
    { key: 'scene_cemetery', role: 'scene', name: 'Nghĩa trang', prompt: 'misty cemetery' },
  ],
  // A separate "wardrobe" list works too (role implied).
  wardrobe: [
    {
      key: 'eleanor_dinner',
      character: 'eleanor',
      name: 'Eleanor — dạ tiệc',
      outfit: 'emerald gown',
    },
  ],
  shots: [
    {
      name: 'W1',
      duration: 6,
      uses: ['eleanor', 'eleanor_mourning', 'scene_cemetery'],
      videoPrompt: 'Veo: @eleanor in @scene_cemetery.',
    },
    { name: 'W2', duration: 6, uses: ['eleanor', 'scene_cemetery'], videoPrompt: 'Veo: @eleanor.' },
    { name: 'W3', duration: 6, uses: ['eleanor'], wardrobe: 'eleanor_dinner', videoPrompt: 'Veo.' },
  ],
});
const wNode = dressed.nodes.find(n => n.name === 'Eleanor — tang lễ');
assert.equal(wNode.zone, 'wardrobe');
assert.equal(wNode.role, 'wardrobe');
assert.equal(wNode.assetKey, 'eleanor_mourning');
assert.equal(wNode.outfit, 'charcoal mourning dress, black gloves');
assert.equal(wNode.items, 'black umbrella, silver locket', 'items list joined');
const elId = dressed.nodes.find(n => n.name === 'Eleanor').id;
assert.equal(wNode.charId, elId, 'the costume records who wears it');
assert.ok(
  !dressed.edges.some(e => e.target === wNode.id),
  'the garment renders on its own: no image input, so no person to redraw',
);
const dinner = dressed.nodes.find(n => n.name === 'Eleanor — dạ tiệc');
assert.equal(dinner.zone, 'wardrobe', 'wardrobe list entry built');
const parentsOf = name =>
  dressed.edges
    .filter(e => e.target === dressed.nodes.find(n => n.name === name).id)
    .map(e => e.source);
// Two-stage dressing: each costume gets a "look" node (character + costume → that person
// wearing the outfit); shots use the look, never the raw costume or the bare character.
const lookOf = key => dressed.nodes.find(n => n.role === 'look' && n.assetKey === 'look_' + key);
const mourningLook = lookOf('eleanor_mourning');
assert.ok(mourningLook, 'look node created for the costume');
assert.equal(mourningLook.zone, 'character', 'a look is a dressed version of the character');
// Column order follows the node list: each look sits right under its character.
const at = n => dressed.nodes.indexOf(n);
const eleanorNode = dressed.nodes.find(n => n.id === elId);
assert.equal(at(mourningLook), at(eleanorNode) + 1, 'look placed right under its character');
assert.equal(at(lookOf('eleanor_dinner')), at(eleanorNode) + 2, 'next look stacks below it');
assert.equal(mourningLook.prompt, '', 'look prompt is generated by the server');
assert.deepEqual(
  dressed.edges.filter(e => e.target === mourningLook.id).map(e => e.source),
  [elId, wNode.id],
  'look takes the character (face) then the costume (outfit)',
);
assert.ok(parentsOf('W1').includes(mourningLook.id), 'shot wired to the look');
assert.ok(!parentsOf('W1').includes(wNode.id), 'raw costume never feeds a shot');
assert.ok(!parentsOf('W1').includes(elId), 'bare character skipped when its costume is used');
assert.ok(parentsOf('W2').includes(elId), 'a shot without a costume still uses the character');
assert.ok(
  parentsOf('W3').includes(lookOf('eleanor_dinner').id),
  'scalar "wardrobe" key → its look',
);
assert.ok(!parentsOf('W3').includes(elId) && !parentsOf('W3').includes(dinner.id));
assert.deepEqual(dressed.warnings, [], 'well-formed wardrobe → no warnings');

// Costume wiring spec: a "wardrobe" list with kind "costume" (for / uses → the character,
// rendered FROM that character's image) and kind "item" (props in the same column); shots
// list the costume INSTEAD of the character. Characters carry a "wardrobe" look dictionary
// that the tool leaves alone.
const spec = buildGraph({
  project: { title: 'Spec' },
  assets: [
    {
      key: 'julian',
      role: 'character',
      name: 'Julian',
      prompt: 'suit model sheet',
      wardrobe: { default: 'business', business: 'base', mourning: 'costume_julian_mourning' },
    },
    { key: 'scene_cemetery', role: 'scene', name: 'Nghĩa trang', prompt: 'fog' },
  ],
  wardrobe: [
    {
      key: 'costume_julian_mourning',
      kind: 'costume',
      for: 'julian',
      uses: ['julian'],
      name: 'Julian — đồ tang',
      prompt: 'Same man as the reference, now in a black mourning suit.',
    },
    {
      key: 'costume_by_uses',
      kind: 'costume',
      uses: ['julian'],
      name: 'Julian — dạ tiệc',
      prompt: 'tux',
    },
    { key: 'costume_ghost', kind: 'costume', uses: ['nobody'], name: 'Lỗi', prompt: 'x' },
    { key: 'prop_will', kind: 'item', name: 'Di chúc', prompt: 'wax-sealed will macro' },
  ],
  shots: [
    {
      name: 'C1',
      duration: 6,
      uses: ['costume_julian_mourning', 'prop_will', 'scene_cemetery'],
      videoPrompt: 'Veo: @julian at the grave.',
    },
    {
      name: 'C2',
      duration: 6,
      uses: ['costume_julian_mourning', 'costume_by_uses', 'scene_cemetery'],
      videoPrompt: 'Veo: @julian.',
    },
  ],
});
const sp = n => spec.nodes.find(x => x.name === n);
assert.equal(sp('Julian — đồ tang').zone, 'wardrobe');
assert.equal(sp('Julian — đồ tang').role, 'wardrobe');
assert.equal(
  sp('Julian — đồ tang').prompt,
  'Same man as the reference, now in a black mourning suit.',
);
assert.equal(sp('Julian — đồ tang').charId, sp('Julian').id, 'costume → character from "for"');
assert.equal(
  sp('Julian — dạ tiệc').charId,
  sp('Julian').id,
  'costume → character from "uses" alone',
);
assert.equal(
  spec.edges.filter(e => e.target === sp('Julian — đồ tang').id).length,
  0,
  'the garment render has no image input',
);
assert.equal(sp('Di chúc').zone, 'wardrobe', 'item sits in the wardrobe column');
assert.equal(sp('Di chúc').role, 'prop', 'item is a plain prop, not a costume');
assert.equal(spec.edges.filter(e => e.target === sp('Di chúc').id).length, 0, 'item has no input');
// The blueprint line describes the object, so it feeds the server's prop model sheet
// (hero view + two turned views) rather than standing in for the whole prompt.
assert.equal(sp('Di chúc').desc, 'wax-sealed will macro', 'item prompt becomes its description');
assert.equal(sp('Di chúc').prompt, '', 'item leaves the prompt to the generated sheet');
// The costume's look node (character + costume → dressed person) is what the shot gets.
const julianLook = spec.nodes.find(
  n => n.role === 'look' && n.assetKey === 'look_costume_julian_mourning',
);
assert.ok(julianLook, 'look node created for the spec costume');
assert.equal(julianLook.name, 'NV đã mặc: Julian — đồ tang');
assert.equal(julianLook.zone, 'character');
assert.equal(
  spec.nodes.indexOf(julianLook),
  spec.nodes.indexOf(sp('Julian')) + 1,
  'look placed right under Julian',
);
assert.deepEqual(
  spec.edges.filter(e => e.target === julianLook.id).map(e => e.source),
  [sp('Julian').id, sp('Julian — đồ tang').id],
  'look is fed by the character then the costume',
);
assert.ok(
  !spec.nodes.some(n => n.role === 'look' && n.assetKey === 'look_costume_ghost'),
  'no look without a character',
);
const c1 = spec.edges.filter(e => e.target === sp('C1').id).map(e => e.source);
assert.ok(c1.includes(julianLook.id), 'shot gets the dressed look');
assert.ok(!c1.includes(sp('Julian — đồ tang').id), 'raw costume does not feed the shot');
assert.ok(c1.includes(sp('Di chúc').id) && c1.includes(sp('Nghĩa trang').id));
assert.ok(!c1.includes(sp('Julian').id), 'bare character stays out of the shot');
assert.equal(spec.warnings.length, 2, JSON.stringify(spec.warnings));
assert.match(spec.warnings[0], /costume_ghost/, 'costume without a known character');
assert.match(spec.warnings[1], /C2.*2 bộ trang phục/, 'two looks of one person in one shot');

// Feature-mode: paste a bible (assets+cameras, no shots) AND a sequence (shots, no assets)
// as two JSON blocks → they merge into one graph.
const bibleTxt =
  '```json\n' +
  JSON.stringify({
    bible: {
      assets: [
        { key: 'wife', role: 'character', name: 'Vợ', prompt: 'x' },
        { key: 'room', role: 'scene', name: 'Phòng', prompt: 'y' },
      ],
      cameras: [{ key: 'ots', name: 'OTS', config: 'c' }],
    },
    style: 'Cinematic',
  }) +
  '\n```';
const seqTxt =
  '```json\n' +
  JSON.stringify({
    project: { title: 'Seq 1', part_of: 'Phim', sequence_index: 1 },
    shots: [
      {
        name: 'S1',
        duration: 6,
        uses: ['wife', 'room'],
        camera: 'ots',
        videoPrompt: 'Veo: @wife in @room. Camera: ots. Lighting & Physics: amber.',
      },
    ],
  }) +
  '\n```';
const merged = buildGraph(bibleTxt + '\n' + seqTxt);
assert.equal(merged.name, 'Seq 1');
assert.ok(
  merged.nodes.some(n => n.name === 'Vợ'),
  'bible assets merged into the sequence',
);
assert.ok(
  merged.nodes.some(n => n.name === 'S1'),
  'sequence shot present',
);
// Legacy film-level "style" string + a shot naming no style: the lone style is wired, and
// the camera named by the scalar "camera" is wired even though it is absent from "uses".
const mShot = merged.nodes.find(n => n.name === 'S1');
const mParents = merged.edges.filter(e => e.target === mShot.id).map(e => e.source);
assert.ok(mParents.includes(merged.nodes.find(n => n.name === 'OTS').id), 'camera wired');
assert.ok(mParents.includes(merged.nodes.find(n => n.name === 'Style').id), 'lone style wired');
assert.equal(mShot.videoPrompt, 'Veo: @wife in @room. Lighting & Physics: amber.');
// A sequence file alone (no assets) gives a clear, guiding error.
assert.throws(
  () => buildGraph({ project: { title: 'Seq alone' }, shots: [{ name: 'S', uses: [] }] }),
  /bible/i,
  'missing-assets error mentions the bible',
);

// parseBlueprint tolerates a ```json fence and surrounding prose.
const wrapped = 'Đây là kết quả:\n```json\n' + JSON.stringify(bp) + '\n```\ncảm ơn';
assert.equal(parseBlueprint(wrapped).project.name, 'Test MV');

// --- Integration: build endpoint + LLM auto path ---
// Scene angles: a scene with "of" is a derived view rendered from its master; a dialogue
// scene with reverse_angles gets two opposing close angles, and OTS shots that name the
// master are wired to the matching side.
{
  const g = buildGraph({
    project: { title: 'Angles' },
    assets: [
      { key: 'ann', role: 'character', name: 'Ann', prompt: 'p' },
      { key: 'scene_hall', role: 'scene', name: 'Sảnh', prompt: 'wide hall', reverse_angles: true },
      {
        key: 'scene_hall_table',
        role: 'scene',
        name: 'Bàn',
        of: 'scene_hall',
        angle: 'close on the table',
      },
      { key: 'scene_lost', role: 'scene', name: 'Lost', of: 'nope', prompt: 'x' },
      {
        key: 'scene_yard',
        role: 'scene',
        name: 'Sân',
        prompt: 'yard',
        reverse_angles: {
          a: 'by the gate looking at the well',
          b: 'by the well looking at the gate',
        },
      },
    ],
    cameras: [
      {
        key: 'veo_ots_a',
        name: 'Veo Over-Shoulder A',
        config: "Over character A's shoulder onto character B.",
      },
      {
        key: 'veo_ots_b',
        name: 'Veo Over-Shoulder B',
        config: "Reverse over character B's shoulder onto A.",
      },
      { key: 'veo_wide', name: 'Wide', config: 'wide static' },
    ],
    shots: [
      {
        name: 'S1',
        duration: 5,
        uses: ['ann', 'scene_hall', 'veo_ots_a'],
        camera: 'veo_ots_a',
        videoPrompt: 'a',
      },
      {
        name: 'S2',
        duration: 5,
        uses: ['ann', 'scene_hall', 'veo_ots_b'],
        camera: 'veo_ots_b',
        videoPrompt: 'b',
      },
      {
        name: 'S3',
        duration: 5,
        uses: ['ann', 'scene_hall', 'veo_wide'],
        camera: 'veo_wide',
        videoPrompt: 'w',
      },
      {
        name: 'S4',
        duration: 5,
        uses: ['ann', 'scene_hall_table', 'veo_ots_a'],
        camera: 'veo_ots_a',
        videoPrompt: 't',
      },
      {
        name: 'S5',
        duration: 5,
        uses: ['ann', 'scene_hall_b', 'veo_wide'],
        camera: 'veo_wide',
        videoPrompt: 'e',
      },
    ],
  });
  const byKey = k => g.nodes.find(n => n.assetKey === k);
  const parents = n =>
    g.edges.filter(e => e.target === n.id).map(e => g.nodes.find(x => x.id === e.source));
  const hall = byKey('scene_hall'),
    a = byKey('scene_hall_a'),
    b = byKey('scene_hall_b'),
    table = byKey('scene_hall_table');
  assert.ok(a && b, 'reverse angles created');
  assert.equal(a.role, 'angle');
  assert.equal(a.zone, 'design');
  assert.equal(a.ofKey, 'scene_hall');
  assert.match(a.angle, /^Reverse angle A/);
  assert.match(b.angle, /^Reverse angle B/);
  assert.equal(a.name, 'Sảnh — góc cận A (sau vai A nhìn B)');
  assert.deepEqual(
    parents(a).map(n => n.id),
    [hall.id],
    'angle rendered from the master image',
  );
  assert.equal(table.role, 'angle');
  assert.equal(table.angle, 'close on the table');
  assert.deepEqual(
    parents(table).map(n => n.id),
    [hall.id],
  );
  assert.deepEqual(
    g.nodes.filter(n => n.zone === 'design').map(n => n.assetKey),
    [
      'scene_hall',
      'scene_hall_table',
      'scene_hall_a',
      'scene_hall_b',
      'scene_lost',
      'scene_yard',
      'scene_yard_a',
      'scene_yard_b',
    ],
    'angles sit right under their scene',
  );
  assert.ok(!byKey('scene_lost').role, 'unknown "of" → plain scene');
  assert.equal(byKey('scene_yard_a').angle, 'by the gate looking at the well', 'per-place A text');
  assert.equal(byKey('scene_yard_b').angle, 'by the well looking at the gate', 'per-place B text');
  assert.ok(
    g.warnings.some(w => /scene_lost/.test(w)),
    'and a warning',
  );
  const refs = name =>
    parents(g.nodes.find(n => n.name === name))
      .filter(n => n.assetKey)
      .map(n => n.assetKey);
  assert.deepEqual(refs('S1'), ['ann', 'scene_hall_a'], 'OTS A → angle A');
  assert.deepEqual(refs('S2'), ['ann', 'scene_hall_b'], 'OTS B → angle B');
  assert.deepEqual(refs('S3'), ['ann', 'scene_hall'], 'other cameras keep the master');
  assert.deepEqual(
    refs('S4'),
    ['ann', 'scene_hall_table'],
    'no reverse angles on that view → itself',
  );
  assert.deepEqual(refs('S5'), ['ann', 'scene_hall_b'], 'explicit side');
}

// Sound: the bible's audio presets become their own column, wired into the shots that
// name them (and a lone preset is wired into every shot, like a lone style). A shot with no
// line is told to stay silent with location sound only.
{
  const g = buildGraph({
    project: { title: 'Sound' },
    assets: [{ key: 'ann', role: 'character', code: 'NV1', name: 'Ann', prompt: 'p' }],
    audio: [
      { key: 'aud_funeral', name: 'Tang lễ', prompt: 'low cello drone, rain on umbrellas' },
      { key: 'aud_storm', name: 'Bão', config: 'thunder, rain on glass, no music' },
    ],
    shots: [
      {
        name: 'A1',
        duration: 5,
        uses: ['ann', 'aud_funeral'],
        dialogue: '[Không thoại; gió lạnh, tiếng quạ]',
        audio_delivery: 'No dialogue; cold wind, distant crows.',
        videoPrompt: 'Veo: @ann at the grave.',
      },
      {
        name: 'A2',
        duration: 5,
        uses: ['ann'],
        audio: 'aud_storm',
        dialogue: 'Ann: "You came."',
        videoPrompt: 'Veo: @ann, mouth articulates: "You came.".',
      },
    ],
  });
  const byName = n => g.nodes.find(x => x.name === n);
  const aud = byName('Tang lễ');
  assert.equal(aud.kind, 'setting');
  assert.equal(aud.settingType, 'audio');
  assert.equal(aud.zone, 'audio', 'sound presets live in their own column');
  assert.equal(aud.config, 'low cello drone, rain on umbrellas');
  const into = name =>
    g.edges
      .filter(e => e.target === byName(name).id)
      .map(e => g.nodes.find(x => x.id === e.source).name);
  assert.ok(into('A1').includes('Tang lễ'), 'wired from "uses"');
  assert.ok(into('A2').includes('Bão'), 'wired from the scalar "audio"');
  assert.ok(!into('A1').includes('Bão'), 'only the preset the shot names');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-dir-'));
let llmCalls = 0;
let lastSystem = '';
let lastUser = '';
const llm = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  llmCalls++;
  const body = JSON.parse(raw);
  lastSystem = body.messages[0].content;
  lastUser = body.messages[1]?.content || '';
  // The conversational director's script stage sends the KỊCH BẢN system prompt; every other
  // call (auto path, blueprint stage) asks for the JSON blueprint.
  const content = lastSystem.includes('KỊCH BẢN')
    ? 'KỊCH BẢN\n1) LOGLINE: Thử nghiệm.\nCảnh 1: @Singer hát "la la".'
    : 'Blueprint:\n```json\n' + JSON.stringify(bp) + '\n```';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise(r => llm.listen(17796, '127.0.0.1', r));
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: '17797', MV_ORBIT_URL: 'http://127.0.0.1:1', MV_DATA_DIR: dir },
  stdio: 'pipe',
});
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function api(p, method = 'GET', b) {
  const r = await fetch('http://127.0.0.1:17797' + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });
  // Build from a pasted blueprint (string with a fence).
  let r = await api('/api/director/build', 'POST', { blueprint: wrapped });
  assert.equal(r.status, 200);
  let s = r.data;
  assert.equal(s.name, 'Test MV');
  assert.equal(s.nodes.filter(n => n.zone === 'production').length, 2);
  const shot1 = s.nodes.find(n => n.name === 'Shot 1');
  const p1 = s.edges.filter(e => e.target === shot1.id).map(e => e.source);
  assert.equal(p1.length, 4);
  // Style text reaches the shot's resolved prompt.
  assert.match(shot1.resolvedPrompts.video, /Cinematic 35mm/);
  // Bad blueprint is rejected.
  r = await api('/api/director/build', 'POST', { blueprint: '{"assets":[]}' });
  assert.equal(r.status, 400);

  // Build from an array of files (feature mode: bible + sequence picked together).
  const bibleObj = {
    bible: { assets: [{ key: 'q', role: 'character', name: 'Q', prompt: 'p' }] },
    cameras: [{ key: 'c1', name: 'C', config: 'x' }],
    style: 'Cinematic',
  };
  const seqObj = {
    project: { title: 'Seq A' },
    shots: [{ name: 'SA', duration: 6, uses: ['q'], camera: 'c1', videoPrompt: 'Veo @q.' }],
  };
  r = await api('/api/director/build', 'POST', { blueprint: [bibleObj, seqObj] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.name, 'Seq A');
  assert.equal(r.data.theme, 'film');
  assert.ok(
    r.data.nodes.some(n => n.name === 'Q'),
    'bible asset built from the array',
  );
  // Drama shot: the wired camera + style text reaches the resolved image AND video prompts,
  // after the cast line; the @key becomes the character's name.
  const sa = r.data.nodes.find(n => n.name === 'SA');
  assert.match(
    sa.resolvedPrompts.video,
    /^Reference subjects, in the order of the attached images: \[1\] Q\. Veo Q\. No spoken dialogue in this shot: nobody speaks and no lips move\. Audio is location sound only; no added music, no voice-over, no narration\. Camera: x Style: Cinematic/,
  );
  assert.match(
    sa.resolvedPrompts.image,
    /^Reference subjects[^.]*\. Still keyframe, one photographic moment of this shot, not a sequence: Veo Q\. Hold the moment at its strongest instant; no motion blur, no text\. Framing \(take the angle and lens, not the movement\): x Style: Cinematic/,
    'the keyframe prompt is a still of the shot, not the clip',
  );

  // Two people in one shot: the model gets the images in order, so the resolved prompt names
  // each image (with the character's physical anchors), swaps every @key for that name and
  // says who speaks — otherwise Veo pairs faces and lines at random.
  const duo = {
    project: { title: 'Duo' },
    assets: [
      {
        key: 'ann',
        role: 'character',
        code: 'NV1',
        name: 'Ann Lee (Vợ)',
        prompt: 'ms',
        physical_anchors: ['red hair', 'green eyes'],
        voice_profile: { gender: 'Female', timbre: 'low alto', accent: 'Hanoi', pacing: 'slow' },
      },
      {
        key: 'bob',
        role: 'character',
        code: 'NV2',
        name: 'Bob Tran (Chồng)',
        prompt: 'ms',
        physical_anchors: ['grey beard'],
      },
      { key: 'scene_hall', role: 'scene', name: 'Sảnh lớn', prompt: 'hall' },
    ],
    wardrobe: [
      {
        key: 'costume_bob_gala',
        kind: 'costume',
        for: 'bob',
        uses: ['bob'],
        name: 'Bob — gala',
        prompt: 'tux sheet',
      },
    ],
    shots: [
      {
        name: 'D1',
        duration: 6,
        uses: ['costume_bob_gala', 'ann', 'scene_hall'],
        dialogue: 'Ann: "Where were you?"',
        audio_delivery: 'whispered, tight',
        videoPrompt:
          'Veo: @NV2 faces @NV1 across @scene_hall, @NV1\'s eyes narrow, mouth articulates: "Where were you?".',
      },
      {
        name: 'D2',
        duration: 4,
        uses: ['scene_hall'],
        dialogue: '[Không thoại]',
        videoPrompt: 'Veo: empty @scene_hall at dawn.',
      },
      {
        name: 'D3',
        duration: 4,
        uses: ['scene_hall'],
        dialogue: 'Ann (voiceover): "I knew."',
        audio_delivery: 'serene',
        videoPrompt: 'Veo: @scene_hall stands empty.',
      },
      {
        name: 'D4',
        duration: 4,
        uses: ['costume_bob_gala', 'scene_hall'],
        dialogue: 'Ann: "Well?"',
        videoPrompt: 'Veo: @bob flinches in @scene_hall.', // old blueprints tag by key
      },
      {
        name: 'D5',
        duration: 4,
        uses: ['costume_bob_gala', 'ann', 'scene_hall'],
        dialogue: 'Ann: "Not tonight."',
        // the tag nearest the line is the listener: the dialogue's name decides
        videoPrompt:
          'Veo: reverse over @NV1\'s shoulder onto @NV2: @NV1 turns toward @NV2 and mouth articulates: "Not tonight.".',
      },
    ],
  };
  r = await api('/api/director/build', 'POST', { blueprint: duo });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const vp = r.data.nodes.find(n => n.name === 'D1').resolvedPrompts.video;
  assert.match(
    vp,
    /^Reference subjects, in the order of the attached images: \[1\] NV2; \[2\] NV1; \[3\] the hall — Sảnh lớn\. /,
    'the cast line names people and describes nothing: the image is the appearance',
  );
  assert.match(vp, /Veo: NV2 faces NV1 across the hall, NV1's eyes narrow/, '@tags → codes');
  assert.ok(!/@/.test(vp), 'no raw tags left');
  assert.ok(!/grey beard|red hair/.test(vp), 'no physical description of the people');
  assert.ok(
    !/Ann Lee|Bob Tran/.test(vp.replace(/mouth articulates[\s\S]*/, '')),
    'no real name before the line',
  );
  assert.match(
    vp,
    /The line is spoken by NV1 \(reference image 2\) only/,
    'speaker = the person tag right before "mouth articulates"',
  );
  assert.match(
    r.data.nodes.find(n => n.name === 'D5').resolvedPrompts.video,
    /The line is spoken by NV1 \(reference image 2\) only/,
    'the name the line opens with beats the tag nearest "mouth articulates" (the listener)',
  );
  const d1Image = r.data.nodes.find(n => n.name === 'D1').resolvedPrompts.image;
  assert.ok(!/spoken by/.test(d1Image), 'the keyframe prompt carries no speaker line');
  assert.ok(
    !/Where were you\?/.test(d1Image) && /lips parted mid-sentence/.test(d1Image),
    'and no quoted line either: a still shows the mouth, not the words',
  );
  const vp2 = r.data.nodes.find(n => n.name === 'D2').resolvedPrompts.video;
  assert.ok(!/Reference subjects/.test(vp2), 'no cast line when nobody is in frame');
  assert.equal(
    vp2,
    'Veo: empty the hall at dawn. No spoken dialogue in this shot: nobody speaks and no lips move. Audio is location sound only; no added music, no voice-over, no narration.',
    'scene tags resolve, and a shot with no line is told to stay silent',
  );
  assert.match(
    vp,
    /only; everyone else stays silent and listens\. Voice lock for NV1: Female; timbre: low alto; accent: Hanoi; pacing: slow\. Delivery: whispered, tight\.$/,
    'voice lock = Bible voice_profile + the shot audio_delivery, by code, after the speaker line',
  );
  assert.ok(
    !/Voice lock/.test(r.data.nodes.find(n => n.name === 'D1').resolvedPrompts.image),
    'the keyframe prompt carries no voice lock',
  );
  const vp3 = r.data.nodes.find(n => n.name === 'D3').resolvedPrompts.video;
  assert.equal(
    vp3,
    "Veo: the hall stands empty. Voice lock for NV1 (voiceover in NV1's own voice): Female; timbre: low alto; accent: Hanoi; pacing: slow. Delivery: serene.",
    'voice-over: no lip-sync line, the voice is still locked although the speaker is not in frame',
  );
  const vp4 = r.data.nodes.find(n => n.name === 'D4').resolvedPrompts.video;
  assert.match(
    vp4,
    /The line is spoken by NV1 off-screen; no one in frame mouths it\. Voice lock for NV1: Female; /,
    'off-screen speaker (from the "Ann:" prefix): nobody in frame lip-syncs, voice still locked',
  );
  // Scene angles through the endpoint: the derived plate renders from the master with the
  // server-owned prompt, and a shot's cast line names the angle by its scene.
  r = await api('/api/director/build', 'POST', {
    blueprint: {
      project: { title: 'Angles' },
      assets: [
        { key: 'ann', role: 'character', name: 'Ann', prompt: 'p' },
        { key: 'scene_hall', role: 'scene', name: 'Sảnh', prompt: 'wide', reverse_angles: true },
      ],
      cameras: [
        {
          key: 'veo_ots_a',
          name: 'OTS A',
          config: "Over character A's shoulder onto character B.",
        },
      ],
      shots: [
        {
          name: 'A1',
          duration: 5,
          uses: ['ann', 'scene_hall', 'veo_ots_a'],
          videoPrompt: 'Veo @ann in @scene_hall.',
        },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const plate = r.data.nodes.find(n => n.assetKey === 'scene_hall_a');
  assert.match(
    plate.resolvedPrompts.image,
    /^A new camera angle of the location shown in the reference image\. Camera: Reverse angle A[\s\S]*not the reference framing[\s\S]*No people/,
  );
  assert.equal(plate.imageInputs, 1, 'the master is its image input');
  assert.match(
    r.data.nodes.find(n => n.name === 'A1').resolvedPrompts.video,
    /^Reference subjects, in the order of the attached images: \[1\] Ann; \[2\] the hall — Sảnh — góc cận A \(sau vai A nhìn B\)\. Veo Ann in the hall\./,
    'OTS A shot wired to angle A, named by its scene; @scene key resolves to it',
  );
  // A silent shot keeps its location sound and is told to add nothing; a shot with a line
  // is not. The sound node's text reaches the prompt as "Audio: …".
  r = await api('/api/director/build', 'POST', {
    blueprint: {
      project: { title: 'Sound' },
      assets: [{ key: 'ann', role: 'character', code: 'NV1', name: 'Ann', prompt: 'p' }],
      audio: [{ key: 'aud_funeral', name: 'Tang lễ', prompt: 'rain on umbrellas, distant bell' }],
      shots: [
        {
          name: 'Q1',
          duration: 5,
          uses: ['ann', 'aud_funeral'],
          dialogue: '[Không thoại; gió lạnh]',
          audio_delivery: 'No dialogue; cold wind, distant crows.',
          videoPrompt: 'Veo: @ann at the grave.',
        },
        {
          name: 'Q2',
          duration: 5,
          uses: ['ann', 'aud_funeral'],
          dialogue: 'Ann: "You came."',
          videoPrompt: 'Veo: @ann, mouth articulates: "You came.".',
        },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const silentShot = r.data.nodes.find(n => n.name === 'Q1').resolvedPrompts.video;
  assert.match(
    silentShot,
    /No spoken dialogue in this shot: nobody speaks and no lips move\. Keep the location sound — cold wind, distant crows — under the audio bed described below; no voice-over, no narration\./,
    'silent shot with a sound preset: bans speech, never the music the Audio line asks for',
  );
  assert.match(silentShot, /Audio: rain on umbrellas, distant bell/, 'the sound node is injected');
  assert.ok(!/no added music/.test(silentShot), 'and no sentence forbidding it');
  assert.ok(!/Voice lock/.test(silentShot), 'nobody speaks, so no voice lock');
  const silentImage = r.data.nodes.find(n => n.name === 'Q1').resolvedPrompts.image;
  assert.ok(!/Audio:/.test(silentImage), 'the sound preset never reaches an image prompt');
  assert.match(silentImage, /Still keyframe/, 'the keyframe asks for one photograph');
  assert.ok(
    !/No spoken dialogue/.test(r.data.nodes.find(n => n.name === 'Q1').resolvedPrompts.image),
    'the keyframe prompt says nothing about sound',
  );
  // Once the shot has its own keyframe, the video is made from that single image: the
  // ordered list of references would be a lie, so it becomes one "animate this frame" line.
  const q1 = r.data.nodes.find(n => n.name === 'Q1');
  await api('/api/upload', 'POST', {
    nodeId: q1.id,
    kind: 'image',
    mime: 'image/png',
    base64: PIXEL,
  });
  const keyed = (await api('/api/state')).data.nodes.find(n => n.id === q1.id);
  assert.ok(
    !/Reference subjects/.test(keyed.resolvedPrompts.video),
    'no ordered reference list when only the keyframe is sent',
  );
  assert.match(
    keyed.resolvedPrompts.video,
    /^The attached image is the first frame of this shot: animate it, keeping every face, outfit, prop and the set exactly as they are\. Veo: NV1 at the grave\./,
  );
  assert.match(
    keyed.resolvedPrompts.image,
    /^Reference subjects/,
    'the image prompt still maps the wired references, it composes them',
  );
  const spokenShot = r.data.nodes.find(n => n.name === 'Q2').resolvedPrompts.video;
  assert.ok(!/No spoken dialogue/.test(spokenShot), 'a shot with a line is not silenced');
  assert.match(spokenShot, /The line is spoken by NV1/, 'and still names its speaker');

  // Back to the Seq A build for the reuse test below (the duo build replaced the graph).
  r = await api('/api/director/build', 'POST', { blueprint: [bibleObj, seqObj] });
  assert.equal(r.status, 200);

  // Reuse across sequences: give the asset an image, then build a NEW sequence with the same
  // key — the image is re-attached automatically so it is not regenerated.
  const qNode = r.data.nodes.find(n => n.assetKey === 'q');
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await api('/api/upload', 'POST', {
    nodeId: qNode.id,
    kind: 'image',
    mime: 'image/png',
    base64: PNG,
  });
  const seqB = {
    project: { title: 'Seq B' },
    shots: [{ name: 'SB', duration: 6, uses: ['q'], camera: 'c1', videoPrompt: 'Veo @q.' }],
  };
  r = await api('/api/director/build', 'POST', { blueprint: [bibleObj, seqB] });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Seq B');
  assert.equal(r.data.graphReused, 1, 'reused the asset image from the previous sequence');
  assert.ok(
    r.data.nodes.find(n => n.assetKey === 'q')?.image,
    'the new sequence node already has the reused image',
  );

  // Reuse across PROJECTS: episode 2 imported into a NEW project (e.g. a second window) finds
  // episode 1's rendered characters / scenes / costumes by key, same film, and copies the
  // files into its own media folder.
  const bibleFilm = { ...bibleObj, film: { title: 'Film X' } };
  r = await api('/api/director/build', 'POST', { blueprint: [bibleFilm, seqObj] });
  assert.equal(r.status, 200);
  assert.ok(r.data.nodes.find(n => n.assetKey === 'q')?.image, 'same project: q keeps its image');
  const ep1 = r.data.activeProjectId;
  // With a working folder of its own, a new project does NOT inherit another project's
  // renders at build time — the folder (empty here) is the source, importing is explicit.
  r = await api('/api/projects', 'POST', {
    name: 'Tập 2',
    theme: 'film',
    exportDir: path.join(dir, 'tap2'),
  });
  assert.equal(r.status, 201);
  r = await api('/api/director/build', 'POST', { blueprint: [bibleFilm, seqB] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.graphReusedOther, 0, 'working folder = the only source at build time');
  assert.ok(!r.data.nodes.find(n => n.assetKey === 'q')?.image);
  r = await api('/api/assets/pull', 'POST', {});
  assert.equal(r.data.pulled, 1, 'q pulled from the episode-1 project on demand');
  const q2 = r.data.nodes.find(n => n.assetKey === 'q');
  assert.ok(q2?.image, 'the new project node carries the image');
  const copied = await fetch('http://127.0.0.1:17797' + q2.image.url);
  assert.equal(copied.status, 200, 'the file was copied into the new project');
  // Another film using the same key does not borrow the image — but a reference image
  // already in its own working folder (thu-vien/…/<key>.png) is picked up at build time.
  const yDir = path.join(dir, 'phim-khac');
  fs.mkdirSync(path.join(yDir, 'thu-vien', 'nhan-vat'), { recursive: true });
  fs.writeFileSync(path.join(yDir, 'thu-vien', 'nhan-vat', 'q.png'), Buffer.from(PNG, 'base64'));
  r = await api('/api/projects', 'POST', { name: 'Phim khác', theme: 'film', exportDir: yDir });
  r = await api('/api/director/build', 'POST', {
    blueprint: [{ ...bibleObj, film: { title: 'Film Y' } }, seqB],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.graphReusedOther, 0, 'other film: nothing borrowed');
  assert.equal(r.data.graphReusedFolder, 1, 'q taken from the working folder');
  assert.ok(r.data.nodes.find(n => n.assetKey === 'q')?.image);
  // A folder holding a character, its costume and the dressed look is one consistent set:
  // loading the look before its costume must not mark it out of date (that blocked every
  // shot using it and made the batch re-render it).
  const lookDir = path.join(dir, 'tap-trang-phuc');
  for (const [folder, key] of [
    ['nhan-vat', 'bob'],
    ['nhan-vat', 'look_costume_bob_gala'],
    ['trang-phuc', 'costume_bob_gala'],
    ['boi-canh', 'scene_hall'],
  ]) {
    fs.mkdirSync(path.join(lookDir, 'thu-vien', folder), { recursive: true });
    fs.writeFileSync(
      path.join(lookDir, 'thu-vien', folder, key + '.png'),
      Buffer.from(PNG, 'base64'),
    );
  }
  r = await api('/api/projects', 'POST', {
    name: 'Tập trang phục',
    theme: 'film',
    exportDir: lookDir,
  });
  r = await api('/api/director/build', 'POST', {
    blueprint: {
      project: { title: 'Film L' },
      assets: [
        { key: 'bob', role: 'character', name: 'Bob', prompt: 'b' },
        { key: 'scene_hall', role: 'scene', name: 'Hall', prompt: 'h' },
      ],
      wardrobe: [
        { key: 'costume_bob_gala', kind: 'costume', for: 'bob', name: 'Bob gala', prompt: 'tux' },
      ],
      shots: [
        { name: 'L1', duration: 5, uses: ['costume_bob_gala', 'scene_hall'], videoPrompt: 'x' },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.graphReusedFolder, 4, 'character, look, costume and scene from the folder');
  assert.deepEqual(
    r.data.nodes.filter(n => n.image && n.stale).map(n => n.name),
    [],
    'nothing loaded from the folder is out of date',
  );
  // Pull on demand: episode 3 was imported before a new asset of the film was rendered.
  const bibleZ = {
    ...bibleFilm,
    bible: {
      assets: [...bibleFilm.bible.assets, { key: 'z', role: 'scene', name: 'Z', prompt: 'z' }],
    },
  };
  r = await api('/api/projects', 'POST', {
    name: 'Tập 3',
    theme: 'film',
    exportDir: path.join(dir, 'tap3'),
  });
  const ep3 = r.data.activeProjectId;
  r = await api('/api/director/build', 'POST', { blueprint: [bibleZ, seqB] });
  assert.equal(r.data.graphReusedOther, 0, 'working folder: nothing inherited at build time');
  r = await api('/api/assets/pull', 'POST', {});
  assert.equal(r.data.pulled, 1, 'q found on demand; z not rendered anywhere yet');
  assert.ok(!r.data.nodes.find(n => n.assetKey === 'z')?.image);
  await api('/api/projects/switch', 'POST', { id: ep1 });
  r = await api('/api/director/build', 'POST', { blueprint: [bibleZ, seqObj] });
  await api('/api/upload', 'POST', {
    nodeId: r.data.nodes.find(n => n.assetKey === 'z').id,
    kind: 'image',
    mime: 'image/png',
    base64: PNG,
  });
  await api('/api/projects/switch', 'POST', { id: ep3 });
  r = await api('/api/assets/pull', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pulled, 1, 'z pulled after it was rendered in episode 1');
  assert.ok(r.data.nodes.find(n => n.assetKey === 'z')?.image);
  assert.equal((await api('/api/assets/pull', 'POST', {})).data.pulled, 0, 'nothing left');
  await api('/api/projects/switch', 'POST', { id: ep1 });

  // LLM auto path: point the Director at the mock, then auto-build.
  await api('/api/director/llm', 'POST', {
    key: 'test-key-1234',
    baseUrl: 'http://127.0.0.1:17796/v1',
    model: 'mock',
  });
  assert.equal((await api('/api/director')).data.llm.configured, true);
  r = await api('/api/director/auto', 'POST', { song: 'BẮT ĐẦU: Bài test' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.name, 'Test MV');
  assert.equal(llmCalls, 1);
  assert.ok(lastSystem.includes('MASTER PROMPT'), 'default master prompt sent to the LLM');
  assert.equal((await api('/api/director/auto', 'POST', { song: '' })).status, 400);

  // Per-project master prompt: save a custom one, confirm it is served and used by auto.
  let d = (await api('/api/director')).data;
  assert.equal(d.customMaster, false);
  const custom = 'MASTER PROMPT TUỲ CHỈNH RIÊNG · marker-XYZ';
  d = (await api('/api/director/master', 'POST', { masterPrompt: custom })).data;
  assert.equal(d.customMaster, true);
  assert.equal(d.masterPrompt, custom);
  assert.equal((await api('/api/director')).data.masterPrompt, custom);
  await api('/api/director/auto', 'POST', { song: 'Bài 2' });
  assert.ok(lastSystem.includes('marker-XYZ'), 'the custom prompt is sent to the LLM');
  // Reset restores the default.
  d = (await api('/api/director/master', 'POST', { masterPrompt: '' })).data;
  assert.equal(d.customMaster, false);
  assert.ok(d.masterPrompt.includes('MASTER PROMPT'), 'default restored');

  // Master-prompt library: built-in presets per theme + save/delete the user's own.
  const mt = await api('/api/director/master-templates');
  assert.equal(mt.status, 200);
  const presetIds = mt.data.templates.map(t => t.id);
  assert.ok(presetIds.includes('builtin:mv'), 'built-in MV preset present');
  assert.ok(presetIds.includes('builtin:drama-short'), 'built-in drama-short preset present');
  assert.ok(presetIds.includes('builtin:drama-long'), 'built-in drama-long preset present');
  const dramaShort = mt.data.templates.find(t => t.id === 'builtin:drama-short');
  assert.ok(dramaShort.prompt.length > 800, 'drama-short preset has real content');
  // The JSON example embedded in the drama-short preset must actually build (schema is valid).
  // Pass the whole prompt: collectBlueprints() skips the inline "```json ... ```" in the
  // instructions and uses the real worked example, exactly as the LLM output would parse.
  assert.ok(dramaShort.prompt.includes('```json'), 'drama-short embeds a worked JSON example');
  r = await api('/api/director/build', 'POST', { blueprint: dramaShort.prompt });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const dn = r.data.nodes;
  assert.ok(
    dn.filter(n => n.role === 'merged').length >= 2,
    'drama-short builds multiple merged dialogue clusters (fast pacing)',
  );
  assert.ok(
    dn.some(n => n.role === 'look'),
    'drama-short builds a wardrobe costume (look) node',
  );
  assert.ok(
    dn.filter(n => n.role === 'character').length >= 2,
    'drama-short builds the recurring characters',
  );
  // Save a user template, confirm it lists, delete it; a built-in cannot be deleted.
  const sv = await api('/api/director/master-templates/save', 'POST', {
    name: 'Mẫu test',
    prompt: 'MY CUSTOM MASTER PROMPT XYZ',
  });
  assert.equal(sv.status, 200);
  const myTplId = sv.data.saved.id;
  assert.ok(
    sv.data.templates.some(t => t.id === myTplId && !t.builtin && t.prompt.includes('XYZ')),
    'saved user template is listed with its prompt',
  );
  assert.equal(
    (await api('/api/director/master-templates/delete', 'POST', { id: 'builtin:mv' })).status,
    400,
    'a built-in preset cannot be deleted',
  );
  const delTpl = await api('/api/director/master-templates/delete', 'POST', { id: myTplId });
  assert.equal(delTpl.status, 200);
  assert.ok(!delTpl.data.templates.some(t => t.id === myTplId), 'user template removed');

  // Conversational director: script stage returns a treatment, blueprint stage returns JSON.
  // The production meta (title + type + target minutes) is prepended to the LLM input.
  let ag = await api('/api/director/agent', 'POST', {
    stage: 'script',
    idea: 'Một người mẹ…',
    meta: { title: 'Phim Thử', type: 'drama', minutes: 3 },
  });
  assert.equal(ag.status, 200, JSON.stringify(ag.data));
  assert.equal(ag.data.stage, 'script');
  assert.ok(ag.data.script.includes('KỊCH BẢN'), 'script stage returns the treatment');
  assert.ok(lastSystem.includes('KỊCH BẢN'), 'script stage uses the script system prompt');
  assert.match(lastUser, /BỐI CẢNH SẢN XUẤT/, 'production meta is prepended to the script input');
  assert.match(lastUser, /Phim Thử/, 'meta carries the title');
  assert.match(lastUser, /3 phút/, 'meta carries the target minutes');
  assert.match(lastUser, /180 giây/, 'meta converts minutes to seconds');
  assert.match(
    lastUser,
    /dựng khoảng \d+–\d+ shot/,
    'meta derives a shot-count target from the duration',
  );
  ag = await api('/api/director/agent', 'POST', { stage: 'blueprint', script: ag.data.script });
  assert.equal(ag.status, 200, JSON.stringify(ag.data));
  assert.equal(ag.data.stage, 'blueprint');
  assert.ok(/"shots"/.test(ag.data.blueprint), 'blueprint stage returns JSON text');
  assert.ok(ag.data.summary.includes('shot'), 'summary counts shots: ' + ag.data.summary);
  r = await api('/api/director/build', 'POST', { blueprint: ag.data.blueprint });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.name, 'Test MV', 'the agent blueprint builds into a graph');
  assert.equal(
    (await api('/api/director/agent', 'POST', { stage: 'script', idea: '' })).status,
    400,
    'empty idea rejected',
  );
  assert.equal(
    (await api('/api/director/agent', 'POST', { stage: 'blueprint', script: '' })).status,
    400,
    'blueprint stage without a script rejected',
  );

  // Subtitles: built from the storyboard's spoken lines; silent shots take their time but show
  // nothing. The graph just built has Shot 1 ("la la", 0–8s) and a silent Shot 2.
  const srtRes = await fetch('http://127.0.0.1:17797/api/director/subtitles.srt');
  assert.equal(srtRes.status, 200);
  const srt = await srtRes.text();
  assert.match(srt, /00:00:00,000 --> 00:00:08,000/, 'first line timed from the shot duration');
  assert.match(srt, /la la/, 'the spoken line is in the track');
  assert.equal((srt.match(/-->/g) || []).length, 1, 'only the one shot that carries a line');

  // 2D staging editor: build a merged scene (shot with setups), then set sides / framing /
  // staging text through the endpoint and confirm the live prompts follow.
  const stageBp = {
    project: { title: 'Phim dàn dựng', theme: 'film' },
    assets: [
      {
        key: 'alice',
        role: 'character',
        name: 'Alice',
        code: 'NV1',
        prompt: 'p',
        identity_label: 'the tall woman',
        back_view: 'her dark bob',
        voice_profile: 'Female, 30s',
      },
      {
        key: 'bob',
        role: 'character',
        name: 'Bob',
        code: 'NV2',
        prompt: 'p',
        identity_label: 'the older man',
        back_view: 'his grey coat',
        voice_profile: 'Male, 50s',
      },
      {
        key: 'study',
        role: 'scene',
        name: 'Study',
        prompt: 'a study',
        conversation: {
          place: 'The study at night',
          two_shot: 'from the door',
          left: { anchor: 'by the desk', background: 'the bookshelf', light: 'lamp glow' },
          right: { anchor: 'by the window', background: 'the curtains', light: 'moonlight' },
        },
      },
    ],
    shots: [
      {
        name: 'Cảnh đối thoại',
        start: 0,
        uses: ['alice', 'bob', 'study'],
        sides: { left: 'alice', right: 'bob' },
        setups: [
          { framing: 'two_shot', dialogue: 'Alice: "Anh phải đi."' },
          { framing: 'ots_a', dialogue: 'Bob: "Không bao giờ."' },
        ],
      },
    ],
  };
  r = await api('/api/director/build', 'POST', { blueprint: stageBp });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let ms = r.data.nodes.find(x => x.role === 'merged');
  assert.ok(ms, 'merged scene built from setups');
  const stage0 = ms.merged.stage;
  assert.ok(stage0 && stage0.left && stage0.right, 'stage info has both people');
  const aliceId = stage0.left.id,
    bobId = stage0.right.id;
  assert.match(stage0.text.place, /study at night/, 'initial staging text from the blueprint');
  const videoBefore = ms.resolvedPrompts.video;
  const fr = r.data.nodes.filter(x => x.role === 'frame');
  assert.equal(fr.length, 2, 'two frame nodes, one per setup');
  const frameImgBefore = fr[0].resolvedPrompts.image;
  assert.match(frameImgBefore, /study at night/, 'still prompt built from staging text');

  const sr = await api('/api/merged/staging', 'POST', {
    id: ms.id,
    sides: { left: bobId, right: aliceId }, // swap who is on the left
    frames: [{ id: fr[0].id, framing: 'ots_b' }],
    staging: {
      place: 'The CHANGED study at night',
      two_shot: 'from the door',
      left: { anchor: 'by the desk', background: 'shelves', light: 'lamp' },
      right: { anchor: 'by the window', background: 'curtains', light: 'moon' },
    },
    blocking: { left: { x: 0.3, y: 0.5 }, right: { x: 0.7, y: 0.5 } },
  });
  assert.equal(sr.status, 200, JSON.stringify(sr.data));
  ms = sr.data.nodes.find(x => x.id === ms.id);
  assert.equal(ms.merged.stage.left.id, bobId, 'sides swapped via edge order');
  assert.equal(ms.blocking.left.x, 0.3, 'marker layout persisted on the merged node');
  assert.notEqual(ms.resolvedPrompts.video, videoBefore, 'swapping sides rewrites the clip prompt');
  const frameNow = sr.data.nodes.find(x => x.id === fr[0].id);
  assert.equal(frameNow.framing, 'ots_b', 'frame framing updated');
  assert.match(
    frameNow.resolvedPrompts.image,
    /CHANGED study/,
    'edited staging drives the still prompt',
  );
  assert.equal(
    (
      await api('/api/merged/staging', 'POST', {
        id: ms.id,
        sides: { left: 'nope', right: aliceId },
      })
    ).status,
    400,
    'sides must be the two real characters',
  );

  console.log(
    'PASS: buildGraph assets/cameras/style/shots + wiring, codes (NV1) instead of names, sound presets + silent shots, fence parsing, build endpoint, style injection, bad blueprint rejected, scene angles (of / reverse_angles / OTS wiring), asset reuse across sequences + projects + working folder, LLM auto path, per-project master prompt, conversational agent (script → blueprint → build), subtitles .srt, merged 2D staging (sides swap + framing + staging text → live prompt), master-prompt library (built-in presets + drama-short example builds + save/delete user template), production meta (title/type/duration prepended to prompt)',
  );
} finally {
  proc.kill();
  llm.close();
}
