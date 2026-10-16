// Converts the approved 10-second Episode 2 cut sheet into five importable graph blueprints.
// The shared Bible is intentionally separate: select it with exactly one sequence in Director.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'stories/obrion-episode-02-10s-cut-sheet.md'), 'utf8');
const previous = JSON.parse(fs.readFileSync(path.join(root, 'examples/obrion-e01-seq01.json'), 'utf8'));
const ami = previous.assets.find(a => a.key === 'ami');
if (!ami) throw new Error('Missing shared Ami asset in Episode 1 blueprint');
const film = { title: 'THE RECKLESS NEWCOMER / OBRION' };
const character = (key, name, code, label, prompt) => ({ key, role: 'character', name, code, identity_label: label, prompt: `${prompt} Original fictional character, realistic 35mm character turnaround on a neutral gray background, front, profile and back views; no text, no celebrity likeness.` });
const scene = (key, name, lighting_profile, prompt) => ({ key, role: 'scene', name, lighting_profile, prompt: `${prompt} Empty master location reference, no people, no readable writing, consistent architecture and axis across angles, photorealistic 35mm.` , reverse_angles: false });

const bible = {
  film,
  assets: [
    ami,
    character('ken', 'Ken', 'NV2', 'the weathered driver', 'Lean adult man, early forties, weathered face, dark short hair, left eyebrow scar, practical patched dark driver jacket, worn mechanical right-hand glove, guarded posture; the same man across all scenes.'),
    character('rao', 'Rao', 'NV3', 'the salt-market broker', 'Adult woman in her fifties, angular face, dry lips, dark hair streaked gray and tied back, oil-stained hands, patched work apron; watchful and economical in movement.'),
    character('tam', 'Tâm', 'NV4', 'the wounded VCN archivist', 'Adult Vietnamese woman in her thirties, cropped dark hair, tired eyes, torn off-white VCN medical overcoat with a left-side blood stain, practical gray shirt; never glamorous.'),
    character('detained_girl', 'Bé gái bị giam', 'NV5', 'the detained twelve-year-old girl', 'Fictional twelve-year-old girl, short dark hair, narrow face, oversized dust-gray detention garment, faded registration ink at wrist; frightened but observant, no sexualization.'),
    character('vcn_captain', 'Đội trưởng VCN', 'NV6', 'the checkpoint captain', 'Adult VCN officer in his forties, tired lined face, matte worn gray checkpoint armor, plain utilitarian insignia without readable text; no villain glamour.'),
    character('vcn_guard', 'Lính VCN', 'NV7', 'the VCN guard', 'Adult VCN guard, practical scuffed gray armor, dusty visor, restrained non-heroic body language; generic guard design consistent in every location.'),
    character('medic', 'Nhân viên y vụ Gamma', 'NV8', 'the unarmed Gamma medic', 'Adult Gamma medical worker, pale utilitarian scrubs, tired ordinary face, empty hands, frightened and unarmed; no resemblance to real people.'),
    character('detainee', 'Người bị giam', 'NV9', 'the adult detainee', 'Exhausted adult prisoner, dust-gray detention clothing, thin face and a slight limp, no gore; same adult when seen inside and outside the cell.'),
    scene('ken_vehicle', 'Khoang xe của Ken', 'Dry pale daylight through dirty right window; Ken frame-left, Ami frame-right; no axis flip.', 'Interior of Ken’s old patched desert vehicle, damaged dashboard, scratched windshield, loose ID card on the dash, worn cloth seats; driver left, passenger right.'),
    scene('checkpoint', 'Trạm cân VCN', 'Ash-gray daylight, dirty tungsten under inspection canopy.', 'Obrion desert VCN weighing checkpoint: two inspection lanes, barrier arm, scanning station, detention vehicle lane camera-right, dusty metal canopy and distant sand road.'),
    scene('salt_market', 'Chợ muối và quầy Rao', 'White hazy daylight outside; dirty amber bulbs under corrugated roof.', 'Obrion salt market of patched corrugated roofing, narrow alleys, sacks of mineral salt, Rao’s small repair booth with a half curtain and old offline terminal, service hatch behind.'),
    scene('service_tunnel', 'Đường dịch vụ dưới Gamma', 'Aging green-blue fluorescents, deep shadow and occasional red warning spill.', 'Low damp maintenance tunnels beneath Gamma, exposed live wires above salty runoff, mechanical pump, metal access hatches, branching passage and a cold-storage door.'),
    scene('gamma_archive', 'Kho ký ức Gamma', 'Cold white fluorescent light with restrained amber emergency lamps.', 'Long Gamma archive with frosted data cabinets, one offline terminal, glass wall overlooking intake, narrow security door; practical worn infrastructure, no holograms.'),
    scene('gamma_intake', 'Khu nhận số 4', 'Cold overhead white with red alarm lamps that only switch on after the alarm.', 'Gamma detention intake number four: three separate glass-front cells with individual manual valves, connecting corridor, local-battery emergency exit, service door and visible sightline to the archive.'),
    scene('gamma_escape', 'Lối thoát Gamma và bãi gió', 'Gray exterior night changing to a dusty red dawn; interior emergency red stays behind.', 'Gamma maintenance stairwell opening onto a barren windy ridge, dry grass, low sand berm and distant facility floodlights; escape route has no clean safe haven.')
  ],
  styles: [{ key: 'style_obrion', name: 'Obrion gritty realism', prompt: 'Gritty photorealistic 35mm science fiction; physical dust, old metal, natural skin and exhaustion, compressed telephoto for enclosed threat, wide lens only for geography, static camera by default, no glossy heroics, no clean futuristic interfaces, no readable on-screen text.' }],
  cameras: [
    { key: 'cam_ws', name: 'Wide / geography', config: 'Locked wide shot, 24–35mm, preserve geography and 180-degree axis; physical movement only.' },
    { key: 'cam_ms', name: 'Medium / blocking', config: 'Locked medium shot, 35–50mm, body position and distance carry the action; no decorative pan.' },
    { key: 'cam_cu', name: 'Close / microexpression', config: 'Locked close-up, 50–85mm, realistic microexpression and shallow focus, no digital zoom.' },
    { key: 'cam_ecu', name: 'Detail / evidence', config: 'Locked extreme close-up or macro, 85mm equivalent, one physical detail, no hallucinated readable interface text.' },
    { key: 'cam_ots', name: 'Over shoulder', config: 'Static over-shoulder, 50mm, maintain established left/right axis and background continuity.' },
    { key: 'cam_pov', name: 'Subjective view', config: 'Static point of view at character eye height, preserve clear screen direction and plausible sightline.' },
    { key: 'cam_handheld', name: 'Motivated handheld', config: '35mm restrained handheld only during actual running, impact or loss of balance; no ornamental shake.' }
  ],
  audio: [
    { key: 'aud_road', name: 'Road and checkpoint', prompt: 'Worn vehicle engine, dry wind, metal chain rattle, checkpoint scanner; no heroic music or added dialogue.' },
    { key: 'aud_market', name: 'Salt market', prompt: 'Dry market ambience, salt under shoes, low human murmur and distant transport engine; no score or additional spoken words.' },
    { key: 'aud_tunnel', name: 'Service tunnel', prompt: 'Old pump, salty water, loose metal, strained breathing and distant guards; no score or additional spoken words.' },
    { key: 'aud_gamma', name: 'Gamma facility', prompt: 'Cold ventilation, electric lock clicks, distant alarm when specified, restrained footsteps; no score or additional spoken words.' },
    { key: 'aud_escape', name: 'Escape and dawn', prompt: 'Wind, dry grass, distant searchlight motors, injured breathing and intermittent crackling speaker; no triumphant score or additional spoken words.' }
  ]
};

const rows = [...source.matchAll(/^- \*\*(\d\d):(\d\d)–(\d\d):(\d\d)\*\* (.+)$/gm)];
if (rows.length !== 150) throw new Error(`Expected 150 ten-second units, got ${rows.length}`);
const names = [
  ['ami', /\bAmi\b/u], ['ken', /\bKen\b/u], ['rao', /\bRao\b/u], ['tam', /\bTâm\b/u],
  ['detained_girl', /bé gái|con bé|cô bé/iu], ['vcn_captain', /đội trưởng/iu],
  ['vcn_guard', /\blính\b|bảo vệ|đội VCN/iu], ['medic', /nhân viên y vụ|kỹ thuật viên/iu],
  ['detainee', /người bị giam|người trong buồng|người lớn vừa cứu/iu]
];
const location = (sec, line) => {
  if (sec < 300) return /xe Ken|trong kính chiếu hậu|táp-lô|vô lăng|ghế phải|cột gió cát|đường đến Gamma/iu.test(line) ? 'ken_vehicle' : 'checkpoint';
  if (sec < 600) return 'salt_market';
  if (sec < 900) return 'service_tunnel';
  if (sec < 1040) return 'gamma_archive';
  if (sec < 1320) return 'gamma_intake';
  if (sec < 1380) return 'gamma_archive';
  return 'gamma_escape';
};
const beat = index => ['setup', 'tension_rising', 'confrontation', 'reveal', 'aftermath'][Math.min(4, Math.floor(index / 6))];
const cam = description => {
  const prefix = description.trim().split(/\s+/u)[0].toUpperCase();
  if (/HANDHELD/i.test(description)) return 'cam_handheld';
  return ({ WS: 'cam_ws', MS: 'cam_ms', CU: 'cam_cu', ECU: 'cam_ecu', OTS: 'cam_ots', POV: 'cam_pov' })[prefix] || 'cam_ms';
};
const aud = seq => ['aud_road', 'aud_market', 'aud_tunnel', 'aud_gamma', 'aud_escape'][seq];
const sequences = Array.from({ length: 5 }, (_, seq) => ({
  film,
  project: {
    title: `E02 - Phân đoạn ${String(seq + 1).padStart(2, '0')} - ${['Trạm cân', 'Chợ muối', 'Đường dịch vụ', 'Kho ký ức', 'Cửa chưa mở'][seq]}`,
    theme: 'film', genre: 'Gritty psychological science-fiction survival',
    duration_seconds: 300, aspect_ratio: '16:9',
    country_setting: 'Fictional planet Obrion; Gamma region',
    pacing_profile: '30 ten-second editorial units. Each has three hard-cut shots, normally 3s + 4s + 3s. Render separate clips and trim on the Timeline; source clips may be 8s.',
    beat_sheet: { setup: 'Establish the new immediate problem.', tension_rising: 'Pressure closes in.', confrontation: 'Ami must choose under risk.', reveal: 'New evidence changes what the characters know.', aftermath: 'The consequence leads into the next sequence.' }
  },
  sequence_index: seq + 1,
  editorial_note: 'Times in shots are local to this five-minute sequence. scene_id groups three cut shots into one final ten-second unit. Build together with obrion-e02-bible.json.',
  shots: []
}));

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const absoluteStart = Number(row[1]) * 60 + Number(row[2]);
  const absoluteEnd = Number(row[3]) * 60 + Number(row[4]);
  if (absoluteStart !== i * 10 || absoluteEnd !== (i + 1) * 10) throw new Error(`Time discontinuity at row ${i + 1}`);
  const seq = Math.floor(i / 30);
  const unit = (i % 30) + 1;
  const parts = row[5].split(' → ');
  if (parts.length !== 3) throw new Error(`Expected three cuts at ${absoluteStart}s`);
  const allPeople = names.filter(([, re]) => re.test(row[5])).map(([key]) => key);
  const sceneKey = location(absoluteStart, row[5]);
  for (let cut = 0; cut < 3; cut++) {
    const m = parts[cut].match(/^(\d+)–(\d+)\s+(.+)$/u);
    if (!m) throw new Error(`Bad cut at ${absoluteStart}s #${cut + 1}`);
    const from = Number(m[1]), to = Number(m[2]), desc = m[3].trim();
    if (from !== (cut ? Number(parts[cut - 1].match(/^(\d+)–(\d+)/u)[2]) : 0) || to <= from || (cut === 2 && to !== 10)) throw new Error(`Bad cut timing at ${absoluteStart}s`);
    const camera = cam(desc);
    const matchPeople = names.filter(([, re]) => re.test(desc)).map(([key]) => key);
    const uses = [...new Set([sceneKey, ...(matchPeople.length ? matchPeople : allPeople)])];
    const dialogue = [...desc.matchAll(/“([^”]+)”/gu)].map(m => m[1]).join(' / ');
    const shot = {
      shot_id: `E02-S${seq + 1}-${String(unit).padStart(2, '0')}-C${cut + 1}`,
      scene_id: `E02-S${seq + 1}-${String(unit).padStart(2, '0')}`,
      name: `${String(unit).padStart(2, '0')}.${cut + 1} - ${desc.slice(0, 62)}`,
      start: (i % 30) * 10 + from, duration: to - from,
      beat: beat(unit - 1), emotional_value: Math.max(-5, Math.min(5, -3 + seq + Math.floor(unit / 10))),
      uses, camera, style: 'style_obrion', audio: aud(seq),
      dialogue: dialogue ? dialogue : `[Không thoại; ${desc}]`,
      audio_delivery: dialogue ? 'Short, restrained natural Vietnamese speech, no extra words.' : 'No dialogue; location sound only.',
      internal_subtext: row[5],
      videoPrompt: `Veo Video Prompt: Single editorial shot, not a montage. ${desc} Location: @${sceneKey}. Preserve the identity and physical continuity of referenced characters, prop placement and screen direction established in the shared Bible. This is cut ${cut + 1} of a 10-second scene; hold only this composition. Physical light and restrained movement; no captions, no readable text, no watermark.`,
      transition_to_next: 'Hard cut on the specified local timecode.'
    };
    sequences[seq].shots.push(shot);
  }
}

const outDir = path.join(root, 'examples');
const write = (file, object) => fs.writeFileSync(path.join(outDir, file), JSON.stringify(object, null, 2) + '\n', 'utf8');
write('obrion-e02-bible.json', bible);
for (let i = 0; i < 5; i++) write(`obrion-e02-seq${String(i + 1).padStart(2, '0')}.json`, sequences[i]);
console.log(`Wrote shared Bible and ${sequences.length} sequences (${sequences.reduce((n, s) => n + s.shots.length, 0)} cut shots).`);
