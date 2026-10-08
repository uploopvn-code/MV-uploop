// The 3D stage of a set (a scene node's `stage3d`): where each performer stands — pinned for every
// shot filmed there — and the camera each shot sees it from. Pure (no DOM, no three.js), so the
// server (the blocking text in each shot's prompt, whether a shot's capture is current) and the
// browser editor (what it draws and captures) compute the SAME cameras from the same data.
//
// Stage coordinates, in metres: the floor is y = 0; +z points to the audience (the front of the
// stage); +x is the audience's right — the right of the frame in the front wide shot. A
// performer's `facing` is in degrees: 0 faces the audience (+z), 90 faces +x, -90 faces -x.

export const STAGE = { w: 12, d: 7 };
// One fixed colour per performer (in stage order): the capture shows coloured mannequins and the
// prompt says which colour is which person — how the image model tells them apart. The first six
// are hues far apart (no red next to a pink), the usual size of a band.
export const COLORS = [
  '#4F8EF7',
  '#F75353',
  '#34C759',
  '#FFD60A',
  '#AF52DE',
  '#2EC4B6',
  '#FF9F0A',
  '#FF5FC8',
];
export const COLOR_NAMES = ['blue', 'red', 'green', 'yellow', 'purple', 'teal', 'orange', 'pink'];
// What a performer plays, and how the prompt says it. Seated gear seats its player.
export const GEAR = {
  mic: 'at the microphone stand',
  grand_piano: 'seated at the grand piano',
  keys: 'at the keyboard',
  drums: 'seated behind the drum kit',
  guitar: 'playing the guitar',
  bass: 'playing the bass guitar',
  violin: 'playing the violin',
  cello: 'seated with the cello',
  none: '',
};
export const SEATED = new Set(['grand_piano', 'drums', 'cello']);
export const POSES = ['stand', 'sit'];
export const VFOV = 40;
export const ASPECT = 16 / 9;
export const MAX_PERFORMERS = COLORS.length;

const strip = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd');
const rad = d => (d * Math.PI) / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, k = 3) => Number(Number(v).toFixed(k));

// The gear a character plays, from its name / blueprint key ("Pianist" → grand piano).
export function gearOf(person) {
  const s = strip(`${person?.name || ''} ${person?.assetKey || ''}`);
  if (/\b(singer|vocalist|vocal|ca si)\b/.test(s)) return 'mic';
  if (/\bbass/.test(s)) return 'bass';
  if (/piano|pianist/.test(s)) return 'grand_piano';
  if (/keyboard|keys\b/.test(s)) return 'keys';
  if (/drum/.test(s)) return 'drums';
  if (/guitar/.test(s)) return 'guitar';
  if (/violin/.test(s)) return 'violin';
  if (/cell(o|ist)/.test(s)) return 'cello';
  return 'none';
}
// Where each gear stands by default on a concert stage (the singer front and centre, drums at
// the back, piano and strings to one side, guitars to the other).
const SLOT = {
  mic: { x: 0, z: 1.8, facing: 0 },
  // the piano runs ~2 m in front of its player: kept clear of the strings beside it; nobody
  // stands straight behind someone else as the audience sees them (the drums sit off the
  // singer's axis), so the front wide shows every face
  grand_piano: { x: -4.6, z: -0.6, facing: 70 },
  drums: { x: 1.4, z: -2.4, facing: -10 },
  guitar: { x: 2.8, z: 0.6, facing: -20 },
  bass: { x: 4.2, z: -0.8, facing: -25 },
  violin: { x: -2.0, z: 1.2, facing: 20 },
  cello: { x: -1.0, z: -1.6, facing: 15 },
  keys: { x: 3.4, z: -2.2, facing: -30 },
};
// A first layout for these characters: each by its gear's slot, anyone else (or a second player
// of the same gear) in a free spot on a line across mid-stage.
export function autoLayout(people) {
  const out = [];
  const taken = (x, z) => out.some(p => Math.hypot(p.x - x, p.z - z) < 1.2);
  const spare = () => {
    for (let k = 0; k < 20; k++) {
      const x = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 1.2;
      if (!taken(x, -0.6)) return { x, z: -0.6, facing: 0 };
    }
    return { x: 0, z: -0.6, facing: 0 };
  };
  for (const person of people.slice(0, MAX_PERFORMERS)) {
    const gear = gearOf(person);
    const slot = SLOT[gear] && !taken(SLOT[gear].x, SLOT[gear].z) ? SLOT[gear] : spare();
    out.push({
      id: person.id,
      x: slot.x,
      z: slot.z,
      facing: slot.facing,
      pose: SEATED.has(gear) ? 'sit' : 'stand',
      gear,
    });
  }
  return out;
}
// A stage as saved: known fields only, numbers clamped to the floor, at most MAX_PERFORMERS.
// `isPerson(id)` says whether an id is a character of the project.
export function cleanStage(input, isPerson) {
  const w = clamp(Number(input?.size?.w) || STAGE.w, 4, 40);
  const d = clamp(Number(input?.size?.d) || STAGE.d, 3, 30);
  const seen = new Set();
  const performers = [];
  for (const p of Array.isArray(input?.performers) ? input.performers : []) {
    const id = String(p?.id || '');
    if (!id || seen.has(id) || !isPerson(id) || performers.length >= MAX_PERFORMERS) continue;
    seen.add(id);
    const gear = Object.hasOwn(GEAR, p.gear) ? p.gear : 'none';
    performers.push({
      id,
      x: round(clamp(Number(p.x) || 0, -w / 2, w / 2), 2),
      z: round(clamp(Number(p.z) || 0, -d / 2, d / 2), 2),
      facing: round(((((Number(p.facing) || 0) % 360) + 540) % 360) - 180, 1),
      pose: SEATED.has(gear) || p.pose === 'sit' ? 'sit' : 'stand',
      gear,
    });
  }
  return { v: 2, size: { w, d }, performers };
}

// --- Cameras ------------------------------------------------------------------------------------

// Text as the size / angle readers see it: no accents (Vietnamese "cận cảnh" → "can canh"), and
// without what is said about light — "light from behind", "backlit", "under the stage lights",
// "đèn từ phía sau" say nothing about where the camera is (only the phrase goes, the rest stays).
const plain = s =>
  strip(
    String(s || '')
      .toLowerCase()
      .replace(
        /(ánh sáng|ánh đèn|ngược sáng|đèn)( (từ|chiếu|rọi|hắt|ngược))*( (phía sau|sau lưng|trên cao|bên trái|bên phải|nghiêng|dưới lên|trên xuống))?/g,
        ' ',
      ),
  ).replace(
    /\b(?:(?:back|rim|side|top|key|hard|soft|warm|cold|stage|phone|candle|overhead)[- ]?)?(?:lights?|lighting|lit|backlit|backlight|glow)\b(?:\s+(?:trusses|rig|from|behind|above|below)(?:\s+(?:the|a|her|his|their))?(?:\s+\w+)?)?/g,
    ' ',
  );
// Hands on an instrument: a close shot of them is a macro of the hands, not of a face.
const HANDS =
  /\b(hands?|fingers?|keys|strings|fretboard|frets|drumsticks?|bow|ban tay|ngon tay|phim dan|day dan)\b/;
// A shot size → one of EWS, WS, MS, MCU, CU, ECU, Macro; null when the text names none. A CSV
// cell ("Wide", "Close", "LS") is read loosely; free `text` (a camera setting, a node's name) only
// by unmistakable phrases — "Long" there is a name, "pull back" a camera move.
export function normSize(s, text = false) {
  const t = plain(s).replace(/[^a-z0-9/ -]/g, ' ');
  const close =
    /\bcu\b|\becu\b|close[- ]?up|close (shot|reaction|framing|frame|on)\b|\d+ ?mm close|tight close|extreme close|can canh|can mat|dac ta/;
  if (/\bews\b|extreme wide|establishing|very wide|sieu toan|toan rong/.test(t)) return 'EWS';
  if (
    /\bmacro\b|\binsert\b|\bdetail\b|chi tiet/.test(t) ||
    ((close.test(t) || (!text && /\bclose\b/.test(t))) && HANDS.test(t))
  )
    return 'Macro';
  if (/\becu\b|extreme close|\bdac ta\b/.test(t)) return 'ECU';
  if (/\bmcu\b|medium close|chest[- ]up|can trung/.test(t)) return 'MCU';
  if (
    close.test(t) ||
    /\b(on|of) (the |her |his |their )?faces?\b/.test(t) ||
    (!text && /\bclose\b/.test(t))
  )
    return 'CU';
  if (
    /\bws\b|\bwide\b|(long|full)[- ]shot|full[- ](length|body|stage)|toan canh/.test(t) ||
    (!text && /\blong\b|\bfull\b|\bls\b/.test(t))
  )
    return 'WS';
  if (/\bms\b|medium|mid[- ]shot|waist|trung canh/.test(t) || (!text && /\bmid\b/.test(t)))
    return 'MS';
  return null;
}
// An angle → the kind of camera placement (null when none is named) and the side it leans to (-1
// the audience's left, +1 their right, 0 the side toward centre stage). A CSV cell ("Rear", "Low",
// "Side") is read loosely; free `text` only by phrases ("from behind", "low angle", "side view").
export function angleOf(a, text = false) {
  const t = plain(a);
  const turned = s =>
    new RegExp(
      `\\b(from|on|to) (the )?${s}\\b|\\b${s}[- ]side\\b|\\bcamera ${s}\\b|(3/4|three[- ]quarter|profile|side)( angle| view)?[- ](from (the )?)?${s}\\b|\\b${s} (3/4|three[- ]quarter|profile)`,
    );
  const L = text ? turned('left') : /\bleft\b/;
  const R = text ? turned('right') : /\bright\b/;
  const vL = /ben trai|goc trai|phia trai/,
    vR = /ben phai|goc phai|phia phai/;
  const side = L.test(t) || vL.test(t) ? -1 : R.test(t) || vR.test(t) ? 1 : 0;
  const K = text
    ? {
        rear: /\brear\b|from behind|behind (the |her |his |their )?(back|singer|band|performers?)|back of (the |her |his )?head|\breverse\b|from (the )?stage|looking (out )?(at|toward|towards|over) (the )?(audience|crowd|hall|arena)|sau lung|phia sau/,
        overhead:
          /\boverhead (shot|angle|view|camera)\b|from overhead|top[- ]down|bird'?s?[- ]eye|aerial (shot|view)|drone (shot|view|camera)|flycam|tu tren cao/,
        profile: /\bprofile\b|side (angle|view|shot|on)|goc nghieng/,
        34: /3\/4|three[- ]quarter/,
        low: /low[- ]angle|worm'?s?[- ]eye|looking up|goc thap/,
        high: /high[- ]angle|looking down|goc cao/,
        eye: /eye[- ]level|\bfrontal\b|straight[- ]on|ngang tam mat|chinh dien/,
      }
    : {
        rear: /\brear\b|behind|\bback\b|\breverse\b|sau lung|phia sau/,
        overhead: /overhead|\btop\b|bird|aerial|drone|flycam|tren cao/,
        profile: /profile|\bside\b|nghieng/,
        34: /3\/4|three.quarter/,
        low: /\blow\b|worm|goc thap/,
        high: /\bhigh\b|goc cao/,
        eye: /\beye\b|\bfront\b|straight|ngang|chinh dien/,
      };
  const kind = ['rear', 'overhead', 'profile', '34', 'low', 'high', 'eye'].find(k => K[k].test(t));
  return { kind: kind || null, side };
}
// A CSV angle → { kind, side }, eye level when it names none.
export function normAngle(a) {
  const { kind, side } = angleOf(a);
  return { kind: kind || 'eye', side };
}
// A node's name as a framing hint: without its numbering ("Shot 12 —", "LS 033 ·", timecodes).
// (Short codes are left out too: in a name "cũ", "cứ", "cú" read as "cu" — not a close-up.)
const nameHint = s =>
  strip(
    String(s || '')
      .replace(/^\s*(shot|ls|take|cảnh|canh)\b[\s\d.,:–—·-]*/i, ' ')
      .replace(/\d+([.:]\d+)*/g, ' '),
  ).replace(/\b(cu|ecu|mcu|ms|ws|ews|ls)\b/g, ' ');
// The height of a performer's face (seated players sit lower) — where the mannequin's head is
// (public/js/stage-scene.js), so a close-up frames the face, not the chest.
const seated = p => p.pose === 'sit' || SEATED.has(p.gear);
const faceY = p => (seated(p) ? 1.43 : 1.7);
// How much of the scene the frame covers, top to bottom, at the subject (metres).
const FRAME_H = { ECU: 0.28, CU: 0.5, MCU: 0.8, MS: 1.3, WS: 2.8, EWS: 6, Macro: 0.4 };
const ELEVATION = { eye: 0, low: -15, high: 25, overhead: 70 };
const hfovTan = () => Math.tan(rad(VFOV) / 2) * ASPECT;
// Rotate a horizontal direction about the vertical axis (+deg turns +z toward +x).
const turn = (v, deg) => {
  const a = rad(deg);
  return { x: v.x * Math.cos(a) + v.z * Math.sin(a), z: -v.x * Math.sin(a) + v.z * Math.cos(a) };
};

// The camera of a shot: { pos, target, fov, aspect } from what it frames (a performer; a `group`
// of them; or the whole band when neither is set), its size and its angle — always looking at the
// stage from where a concert camera would: in front of the subject, turned for 3/4 / profile,
// behind it for "rear".
export function shotCamera(stage, spec) {
  const size = spec?.size || 'WS';
  const angle = spec?.angle || { kind: 'eye', side: 0 };
  const p = spec?.target || null;
  const people = stage?.performers || [];
  let T, base, dist;
  if (!p || (size === 'EWS' && people.length > 1)) {
    // the band (or the group): centred on them, wide enough to hold them all — a group closer
    // than a wide is framed tight, at chest height
    const grouped = spec?.group?.length && size !== 'EWS';
    const crowd = (grouped && people.filter(q => spec.group.includes(q.id))) || [];
    const them = crowd.length ? crowd : people;
    const tight = crowd.length && size !== 'WS';
    const xs = them.length ? them.map(q => q.x) : [0];
    const zs = them.length ? them.map(q => q.z) : [0];
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
      cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const width = Math.max(...xs) - Math.min(...xs) + (size === 'EWS' ? 5 : tight ? 1.4 : 3);
    T = {
      x: cx,
      y: tight ? them.reduce((s, q) => s + faceY(q), 0) / them.length - 0.35 : 1.0,
      z: cz,
    };
    base = { x: 0, z: 1 };
    dist = width / 2 / hfovTan() + (Math.max(...zs) - cz);
  } else {
    T = {
      x: p.x,
      y:
        size === 'Macro'
          ? faceY(p) - 0.6
          : size === 'MS'
            ? faceY(p) - 0.35
            : size === 'WS'
              ? 1.0
              : faceY(p),
      z: p.z,
    };
    base = { x: Math.sin(rad(p.facing || 0)), z: Math.cos(rad(p.facing || 0)) };
    dist = FRAME_H[size] / 2 / Math.tan(rad(VFOV) / 2);
  }
  // 3/4 and profile swing to the side the CSV named, else to the audience side (the camera stays
  // downstage, the set behind the subject), toward centre stage on a tie; rear looks out from
  // behind the subject.
  const by = angle.kind === 'profile' ? 90 : angle.kind === '34' ? 35 : 0;
  let swing = angle.kind === 'rear' ? 180 : 0;
  if (by) {
    const a = turn(base, by),
      b = turn(base, -by);
    swing = angle.side
      ? a.x > b.x === angle.side > 0
        ? by
        : -by
      : Math.abs(a.z - b.z) > 1e-6
        ? a.z > b.z
          ? by
          : -by
        : Math.abs(T.x + a.x * dist) <= Math.abs(T.x + b.x * dist)
          ? by
          : -by;
  }
  const dir = turn(base, swing);
  const e = rad(ELEVATION[angle.kind] ?? 0);
  const flat =
    angle.kind === 'eye' ||
    angle.kind === '34' ||
    angle.kind === 'profile' ||
    angle.kind === 'rear';
  const pos = {
    x: T.x + dir.x * dist * (flat ? 1 : Math.cos(e)),
    y: flat ? (p ? T.y : 1.7) : T.y + dist * Math.sin(e),
    z: T.z + dir.z * dist * (flat ? 1 : Math.cos(e)),
  };
  return {
    pos: [round(pos.x), round(Math.max(0.2, pos.y)), round(pos.z)],
    target: [round(T.x), round(T.y), round(T.z)],
    fov: VFOV,
    aspect: ASPECT,
  };
}

// A point seen through a camera: x, y in -1…1 across the frame (left→right, bottom→top) and its
// depth along the lens (metres; ≤ 0 is behind the camera).
export function project(cam, pt) {
  const [px, py, pz] = cam.pos,
    [tx, ty, tz] = cam.target;
  let f = [tx - px, ty - py, tz - pz];
  const fl = Math.hypot(...f) || 1;
  f = f.map(v => v / fl);
  // right = f × up, up' = right × f (up = +y); straight down falls back to +z as "up"
  let r = [-f[2], 0, f[0]];
  if (Math.hypot(...r) < 1e-6) r = [1, 0, 0];
  const rl = Math.hypot(...r);
  r = r.map(v => v / rl);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const d = [pt[0] - px, pt[1] - py, pt[2] - pz];
  const depth = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  const xc = d[0] * r[0] + d[1] * r[1] + d[2] * r[2];
  const yc = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  const t = Math.tan(rad(cam.fov) / 2);
  return {
    x: xc / (Math.max(depth, 1e-3) * t * cam.aspect),
    y: yc / (Math.max(depth, 1e-3) * t),
    depth,
    right: r,
  };
}

// --- Shots of a set ------------------------------------------------------------------------------
// The graph is read through `g` = { node(id), parents(id), isPerson(n), isSet(n), cameraText(id) }
// so the server (its db) and the browser (its state) share these helpers. `parents` are the
// wired nodes that are not settings (a 3D stage node with no picture included); `cameraText` is
// what the camera settings wired into a node say.

// The people wired into a node, in wire order (a "look" stands for its character).
export function wiredPeople(id, g) {
  return g
    .parents(id)
    .map(p => (p.role === 'look' ? g.parents(p.id).find(g.isPerson) : p))
    .filter(p => p && g.isPerson(p))
    .map(p => p.id);
}
// A set with performers pinned on its 3D stage.
export const isStaged = s => !!s?.stage3d?.performers?.length;
// The set a node is filmed in — and so the stage whose marks it keeps: a wired scene, or the scene
// a wired angle of it was made from. A staged one comes first: wired straight in (a 3D stage node
// wired into the shot), else wired into the set the node is filmed in (a 3D stage node wired into
// the location: every shot there keeps its marks); with none staged, the first set wired in.
export function setOf(id, g) {
  const sets = [];
  for (const p of g.parents(id)) {
    const s = p.role === 'angle' ? g.parents(p.id).find(g.isSet) : g.isSet(p) ? p : null;
    if (s && !sets.includes(s)) sets.push(s);
  }
  return (
    sets.find(isStaged) ||
    sets.map(s => g.parents(s.id).find(q => g.isSet(q) && isStaged(q))).find(Boolean) ||
    sets[0] ||
    null
  );
}
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACE_RE =
  /\b(stage|opera|hall|balcony|venue|theat(er|re)|church|chapel|cathedral|arena|studio|room|house|set)\b/;
// The performers on this stage a beat's subject names, in the order it names them: by their
// character's name / code / key, or by what they play ("Piano keys" → the pianist, "Singer" →
// whoever is at the microphone) — each of "A + B", "A & B", "A, B", "A and / và B" on its own.
function namedIn(subject, stage, g) {
  const s = strip(subject);
  const parts = s.split(/\s*(?:\+|&|,|\band\b|\bva\b)\s*/).filter(Boolean);
  const at = (p, n) => {
    const names = [n.name, n.code, n.assetKey].map(x => strip(x).trim()).filter(x => x.length >= 2);
    const hits = names
      .map(x => s.search(new RegExp(`(?<![a-z0-9])${escRe(x)}(?![a-z0-9])`)))
      .concat(
        parts
          .filter(x => gearOf({ name: x }) === p.gear && p.gear !== 'none')
          .map(x => s.indexOf(x)),
      )
      .filter(i => i >= 0);
    return hits.length ? Math.min(...hits) : -1;
  };
  return (stage?.performers || [])
    .map(p => ({ p, i: g.node(p.id) ? at(p, g.node(p.id)) : -1 }))
    .filter(x => x.i >= 0)
    .sort((a, b) => a.i - b.i)
    .map(x => x.p.id);
}
// A beat or a shot said to show no one ("Empty candlelit opera stage").
const EMPTY =
  /\b(empty|no one|nobody|no people|without (people|anyone|performers)|deserted|unoccupied)\b|trong khong|trong vang|khong (co )?(ai|nguoi)|vang ve/;
// …or one performer alone in it.
const SOLO = /\b(alone|isolated|solo|lone|by (him|her)self)\b|mot minh|don doc/;
// What the camera settings wired into a node say (their names too: a blueprint camera is called
// "Wide", "Macro"…) — the server and the editor read them alike.
export const cameraTextOf = settings =>
  settings
    .filter(s => s?.kind === 'setting' && s.settingType === 'camera')
    .map(s => `${s.name || ''}. ${s.config || ''}`)
    .join('. ');
// How one beat of a shot frames its set's stage — { target, group, size, angle }: on a performer
// (`target`), on a few of them (`group`, their ids in stage order) or on the whole band (neither).
// The tool decides it from the node itself, so nobody sets a camera by hand:
// - a CSV beat (the opening beat is the keyframe) by its size, angle and SUBJECT — never by how many
//   people happen to be wired in (pinning the stage wires a band wide's performers, and that must
//   not change its framing); an empty Subject is the place alone, and so is a wide of the place
//   whose Action says it is empty;
// - a node without one (a blueprint or hand-made shot) by its wired camera setting, then its name
//   ("Cận cảnh"), and by who is wired in: nobody or the band → the band, one performer → on them;
// - a close shot of "A + B" is on A (B behind); a medium or wide one frames the two of them;
// - a node wired through angle plate B (the reverse of the master view) is seen from behind.
// null: the stage plays no part in it (an insert of an object, the crowd, nobody of this stage).
export function shotSpec(
  shot,
  stage,
  g,
  beat = (Array.isArray(shot.parts) && shot.parts[0]) || shot,
) {
  const on = new Map((stage?.performers || []).map(p => [p.id, p]));
  const csv = beat !== shot;
  const cam = g.cameraText?.(shot.id) || '';
  const name = csv ? '' : nameHint(shot.name);
  const size =
    normSize(beat.shotSize || shot.shotSize) || normSize(cam, true) || normSize(name, true);
  const a = angleOf(beat.angle || shot.angle),
    c = angleOf(cam, true),
    h = angleOf(name, true);
  const reverse = g.parents(shot.id).some(p => p.role === 'angle' && p.preset === 'b');
  const angle = {
    kind: a.kind || (reverse ? 'rear' : null) || c.kind || h.kind || 'eye',
    side: a.kind || a.side ? a.side : c.kind || c.side ? c.side : h.side,
  };
  const subject = String(beat.subject || '');
  const s = strip(subject);
  const wide = size === 'EWS' || size === 'WS';
  const tight = ['MCU', 'CU', 'ECU', 'Macro'].includes(size);
  const everyone = { target: null, size: size || 'WS', angle };
  const inOrder = ids => (stage?.performers || []).filter(p => ids.includes(p.id)).map(p => p.id);
  const on1 = (id, dflt) => ({ target: on.get(id), size: size || dflt, angle });
  // several people: a close shot is on the first one (the others behind it), a wider one on them all
  const several = who =>
    tight ? on1(who[0], 'MS') : { target: null, group: inOrder(who), size: size || 'WS', angle };
  if (/\b(band|ensemble|orchestra|musicians|choir|everyone|ban nhac|ca ban)\b/.test(s))
    return everyone;
  if (s.trim()) {
    const who = namedIn(subject, stage, g);
    // an extreme wide of a band holds them all
    if (who.length && size === 'EWS' && on.size > 1) return everyone;
    if (who.length > 1) return several(who);
    if (who.length === 1) return on1(who[0], 'MS');
    // nobody of the stage named: a wide of the place (or of "A + B") is the band — unless it is
    // said to be empty, or to hold one performer alone ("Singer isolated in vast hall") — else
    // not a shot of the stage
    const action = strip(beat.action);
    if (EMPTY.test(s + ' ' + action)) return null;
    if (!wide || !(PLACE_RE.test(s) || s.includes('+'))) return null;
    const alone = SOLO.test(action) && namedIn(beat.action, stage, g)[0];
    return alone ? on1(alone, 'WS') : everyone;
  }
  // a CSV beat with no Subject shows the place alone
  if (csv) return null;
  const who = wiredPeople(shot.id, g).filter(id => on.has(id));
  if (wide) return everyone;
  // no size anywhere: one performer of a band wired in is the shot's subject, a few of them a
  // group; nobody (or everyone) the band
  if (!size)
    return who.length === 1 && on.size > 1
      ? on1(who[0], 'MS')
      : who.length > 1 && who.length < on.size
        ? { target: null, group: inOrder(who), size: 'WS', angle }
        : everyone;
  // closer, on whoever is wired in (nobody: a close shot of no one on this stage)
  if (who.length > 1) return several(who);
  return who.length ? on1(who[0], size) : null;
}
// Each beat of a shot, framed (null for a beat the stage plays no part in).
export function beatSpecs(shot, stage, g) {
  const beats = Array.isArray(shot.parts) && shot.parts.length ? shot.parts : [shot];
  return beats.map(b => shotSpec(shot, stage, g, b));
}
// Identifies a shot's framing on a stage revision: a capture is current while this is unchanged.
// (GEOMETRY counts changes to how the cameras / mannequins are placed: captures made before one
// are taken again.)
const GEOMETRY = 2;
export const layoutSig = (stage, spec) =>
  `g${GEOMETRY}:${stage?.rev || 0}|${spec.target?.id || '-'}|${spec.size}|${spec.angle.kind}|${spec.angle.side}` +
  (spec.group?.length ? '|' + spec.group.join(',') : '');
// A framing as the UI says it: "Cận trung · 3/4 trái · Ca sĩ chính".
export const SIZE_VI = {
  EWS: 'Toàn rộng',
  WS: 'Toàn',
  MS: 'Trung',
  MCU: 'Cận trung',
  CU: 'Cận',
  ECU: 'Đặc tả',
  Macro: 'Cận chi tiết',
};
const ANGLE_VI = {
  eye: 'ngang mắt',
  34: '3/4',
  profile: 'nghiêng',
  rear: 'sau lưng',
  low: 'góc thấp',
  high: 'góc cao',
  overhead: 'từ trên cao',
};
export const framingLabel = (spec, nameOf) =>
  [
    SIZE_VI[spec.size] || spec.size,
    (ANGLE_VI[spec.angle.kind] || spec.angle.kind) +
      (spec.angle.side < 0 ? ' trái' : spec.angle.side > 0 ? ' phải' : ''),
    spec.target
      ? nameOf(spec.target.id || spec.target)
      : spec.group?.length
        ? spec.group.map(nameOf).join(' + ')
        : 'cả sân khấu',
  ].join(' · ');

// --- Blocking text -------------------------------------------------------------------------------

const across = x =>
  x < -0.6
    ? 'far left of frame'
    : x < -0.2
      ? 'left of frame'
      : x <= 0.2
        ? 'centre of frame'
        : x <= 0.6
          ? 'right of frame'
          : 'far right of frame';
// Which way a performer faces, as the camera sees it.
function facingWords(p, cam) {
  const F = [Math.sin(rad(p.facing || 0)), 0, Math.cos(rad(p.facing || 0))];
  const toCam = [cam.pos[0] - p.x, 0, cam.pos[2] - p.z];
  const l = Math.hypot(...toCam) || 1;
  const c = (F[0] * toCam[0] + F[2] * toCam[2]) / l;
  if (c > 0.7) return 'facing camera';
  if (c < -0.7) return 'back to camera';
  const { right } = project(cam, [p.x, 1, p.z]);
  const side = F[0] * right[0] + F[2] * right[2] > 0 ? 'frame right' : 'frame left';
  return c > 0.25
    ? `three-quarter, turned toward ${side}`
    : c < -0.25
      ? `turned three-quarter away, toward ${side}`
      : `in profile, facing ${side}`;
}
// Who is in this camera's frame, left to right: { p, x, depth }.
export function inFrame(stage, cam) {
  return (stage?.performers || [])
    .map(p => {
      const mid = project(cam, [p.x, faceY(p) - 0.35, p.z]);
      const head = project(cam, [p.x, faceY(p) + 0.1, p.z]);
      const feet = project(cam, [p.x, 0, p.z]);
      // (an extreme close-up stands a few tens of centimetres from the face: in front is enough)
      const seen =
        Math.max(mid.depth, head.depth) > 0.05 &&
        Math.abs(mid.x) <= 1.05 &&
        head.y >= -1.05 &&
        feet.y <= 1.05;
      return seen ? { p, x: mid.x, depth: mid.depth } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.x - b.x);
}
// The blocking sentence of one shot: every performer in its frame, where (left → right, near →
// far), which way they face and at what instrument — the same marks in every shot of the set, seen
// from this shot's camera. `labelOf(id)` names a performer ("NV1 [1]", "the drummer").
export function blockingText(stage, spec, labelOf) {
  const cam = shotCamera(stage, spec);
  // (a performer `labelOf` cannot name — a character since deleted — is left out)
  const seen = inFrame(stage, cam).filter(s => labelOf(s.p.id));
  if (!seen.length) return '';
  const near = Math.min(...seen.map(s => s.depth));
  const focus = spec.target ? seen.find(s => s.p.id === spec.target.id) : null;
  // a close shot (of one performer) names its subject and the (at most three) performers seen
  // behind it, nearest the middle of the frame first
  const close = !!focus && ['ECU', 'CU', 'MCU', 'Macro'].includes(spec.size);
  const behind = close
    ? seen
        .filter(s => s !== focus && s.depth > focus.depth + 0.8)
        .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))
        .slice(0, 3)
    : [];
  const parts = seen
    .filter(s => !close || s === focus || behind.includes(s))
    .map(s => {
      const facing = facingWords(s.p, cam);
      const framing =
        spec.size === 'MCU'
          ? 'framed chest-up'
          : spec.size === 'Macro'
            ? ['none', 'mic'].includes(s.p.gear)
              ? 'hands in close detail'
              : 'hands and instrument in close detail'
            : facing === 'back to camera'
              ? 'framed close on the back of the head and shoulders'
              : 'framed close on the face';
      const where =
        s === focus && close
          ? `${framing}, ${across(s.x)}`
          : `${across(s.x)}, ${
              close
                ? 'behind, softly out of focus'
                : s.depth - near < 1
                  ? 'foreground'
                  : s.depth - near > 2.5
                    ? 'background'
                    : 'midground'
            }`;
      const gear = GEAR[s.p.gear] ? ', ' + GEAR[s.p.gear] : '';
      return `${labelOf(s.p.id)} ${where}, ${facing}${gear}`;
    });
  return (
    'Stage blocking — every performer keeps the same mark in every shot of this set; nobody changes place or swaps sides. Seen from this camera: ' +
    parts.join('; ') +
    '.'
  );
}
// Performers this camera sees one behind the other (the one behind hidden by the one in front):
// [{ front, back }] — the editor warns, so a face is not lost in every wide.
export function hidden(stage, cam) {
  const seen = inFrame(stage, cam);
  const out = [];
  for (const a of seen)
    for (const b of seen)
      if (a !== b && b.depth > a.depth + 0.5 && Math.abs(a.x - b.x) < 0.07)
        out.push({ front: a.p.id, back: b.p.id });
  return out;
}
// The colour legend of a capture: "blue = NV1 [1], red = the drummer".
// (A colour is a performer's place in the saved stage, as the editor draws it — someone deleted
// since keeps their place, and is just not named.)
export const colorLegend = (stage, labelOf) =>
  (stage?.performers || [])
    .map((p, i) => (labelOf(p.id) ? `${COLOR_NAMES[i]} = ${labelOf(p.id)}` : ''))
    .filter(Boolean)
    .join(', ');
