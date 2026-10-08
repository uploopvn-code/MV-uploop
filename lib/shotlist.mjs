// Turn an externally-produced music-analysis CSV into storyboard material: a master SHOT LIST
// (one shot per row, with exact timing + an assembled motion prompt), optionally CONSOLIDATED into
// ~N-second merged shots, or a LYRIC-TIMING table (the song's sections). Pure, so it is unit-tested.

// "mm:ss.mmm", "h:mm:ss.mmm" or plain seconds → seconds (number), else null.
export function parseTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Case/space/underscore/hyphen-insensitive column lookup; returns the first non-empty match.
const pick = (row, ...names) => {
  const norm = x =>
    String(x)
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find(key => norm(key) === norm(n));
    if (k != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
};

// The standard MV shot list the deep-analysis master prompt writes: one row = one cut. Older
// exports (Exact Lyric, Vocal, Lens, Duration_s, Visual Action …) still import.
export const SHOT_LIST_HEADER =
  'Shot,Start,End,Section,Lyric,Lip Sync,Energy,Emotion,Subject,Location,Shot Size,Angle,Camera Movement,Action,Vocal Delivery';

// Which kind of analysis CSV this is, from its headers.
export function detectCsvKind(headers) {
  const h = (headers || []).map(x => String(x).toLowerCase());
  const has = k => h.some(x => x.includes(k));
  if (has('shot size') || has('subject') || has('camera movement')) return 'shots';
  if (has('exact lyric') || has('delivery') || has('lyric')) return 'lyrics';
  return 'unknown';
}

const isTrue = v => /^(y|yes|true|1)$/i.test(String(v).trim());
const round3 = n => Number(Number(n).toFixed(3));

// "Singer at Balcony": who is in frame, and where.
const whoWhere = r => [r.subject, r.location && 'at ' + r.location].filter(Boolean).join(' ');
// The face of an Emotion ("quiet guilt — eyes lowered; breathy" → "quiet guilt — eyes lowered"):
// a still frame shows the feeling, not how the line is sung.
export const faceOf = e =>
  String(e || '')
    .split(';')[0]
    .replace(/[.\s]+$/, '')
    .trim();
// The row's Energy (1–10) as the pace of its motion.
const paceOf = e => {
  const v = Number(e);
  if (!(v >= 1)) return '';
  return v >= 9 ? 'peak energy' : v >= 7 ? 'high energy' : v >= 4 ? 'steady energy' : 'calm energy';
};

// An English motion prompt for a single beat, from the camera columns, the performer's emotion and
// the music's energy.
function beatPrompt(r) {
  const cam = [
    r.shotSize && r.shotSize + ' shot',
    r.angle && r.angle + ' angle',
    r.lens && r.lens + ' lens',
    r.movement,
  ]
    .filter(Boolean)
    .join(', ');
  const pace = paceOf(r.energy);
  let vp = [
    whoWhere(r),
    cam,
    r.action,
    r.emotion && 'Emotion: ' + r.emotion,
    pace && pace[0].toUpperCase() + pace.slice(1),
  ]
    .filter(Boolean)
    .map(s => s.replace(/[.\s]+$/, ''))
    .join('. ')
    .trim();
  if (vp && !/[.!?]$/.test(vp)) vp += '.';
  if (r.lipSync && r.lyric)
    vp += ` The performer's mouth articulates the line: ${JSON.stringify(r.lyric)}.`;
  vp +=
    ' Clean footage, no on-screen text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm.';
  return vp.trim();
}

// One CSV row → a shot spec with exact timing, the sung line (blank for instrumental), the raw
// camera fields (for consolidation) and a ready single-beat motion prompt.
export function rowToShot(row) {
  const start = parseTime(pick(row, 'Start'));
  if (start == null) return null;
  const durRaw = pick(row, 'Duration_s', 'Duration', 'Dur');
  const end = parseTime(pick(row, 'End'));
  let dur = durRaw ? Number(durRaw) : null;
  if (!(dur > 0)) dur = end != null ? Math.max(0, end - start) : null;
  if (!(dur > 0)) return null;

  const lyricRaw = pick(row, 'Exact Lyric', 'Lyric');
  const vocal = pick(row, 'Vocal');
  // no words to sing: "instrumental …" / "no vocal …" / "nhạc dạo …", or nothing left once the
  // bracketed groups ("[Instrumental]", "(x2)") and dashes / dots are taken out — "(Ay) te quiero
  // (ay)" keeps its words
  const nonVocal =
    /instrumental|no vocal/i.test(vocal) ||
    /^\s*(instrumental|no vocal|nhạc dạo)\b/i.test(lyricRaw) ||
    !lyricRaw.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/[-—–….\s]/g, '');
  const energyRaw = pick(row, 'Energy');
  const r = {
    shot: pick(row, 'Shot', '#', 'No'),
    section: pick(row, 'Section'),
    start: round3(start),
    duration: round3(dur),
    lyric: nonVocal ? '' : lyricRaw,
    lipSync: isTrue(pick(row, 'Lip Sync', 'LipSync', 'Lip')),
    subject: pick(row, 'Subject'),
    shotSize: pick(row, 'Shot Size', 'Size'),
    angle: pick(row, 'Angle'),
    lens: pick(row, 'Lens'),
    movement: pick(row, 'Camera Movement', 'Movement'),
    action: pick(row, 'Visual Action', 'Action'),
    // what the performer visibly feels on this line (face, body, delivery), and the set
    emotion: pick(row, 'Emotion', 'Performance', 'Expression'),
    // how the SINGER sings this line (feeling + soft/medium/full voice) — drives luồng B, the
    // lip-sync take; empty on coverage-only rows and on older CSVs
    vocalDelivery: pick(row, 'Vocal Delivery', 'Delivery'),
    location: pick(row, 'Location', 'Setting'),
    energy: energyRaw ? Number(energyRaw) || energyRaw : '',
  };
  r.name = ((r.shot ? 'Shot ' + r.shot : 'Shot') + (r.section ? ' — ' + r.section : '')).slice(
    0,
    100,
  );
  r.videoPrompt = beatPrompt(r);
  return r;
}

// The CSV rows as shots. A Shot number used twice gets a letter ("005", "005b") — the number keys a
// row's keyframe, take and GPU reading, so two rows must never share one.
export function rowsToShots(rows) {
  const shots = rows.map(rowToShot).filter(Boolean);
  const used = new Set(shots.map(r => r.shot));
  const seen = new Set();
  return shots.map(r => {
    if (!r.shot || !seen.has(r.shot)) {
      seen.add(r.shot);
      return r;
    }
    let k = 1,
      shot;
    do shot = r.shot + String.fromCharCode(97 + (k++ % 26)) + (k > 26 ? k : '');
    while (used.has(shot));
    used.add(shot);
    seen.add(shot);
    return { ...r, shot, name: r.name.replace(/^Shot \S+/, 'Shot ' + shot) };
  });
}

// One beat as a shot remembers it: framing + action (to wire the performers it shows) and its
// exact time, line and lip-sync flag (to cut that sung line for a lip-sync take).
export const partOf = m => ({
  shot: m.shot,
  subject: m.subject,
  shotSize: m.shotSize,
  angle: m.angle,
  lens: m.lens,
  movement: m.movement,
  action: m.action,
  emotion: m.emotion,
  section: m.section,
  energy: m.energy,
  vocalDelivery: m.vocalDelivery,
  location: m.location,
  start: m.start,
  duration: m.duration,
  lyric: m.lyric,
  lipSync: m.lipSync,
  // after re-timing to the vocal: where the CSV had it, and where the line is really sung
  csvStart: m.csvStart,
  csvDuration: m.csvDuration,
  sungStart: m.sungStart,
  sungEnd: m.sungEnd,
  alignScore: m.alignScore,
});

// Re-time a CSV shot list to where its lines are really sung (the GPU reading of the vocal).
// sung[i] = the aligned interval of row i's lyric ({ start, end, score }) or null (no lyric, or its
// words not found). Rows keep their order and keep tiling the song from 0 to `duration`:
// - between two sung rows the cut lands in the breath before the next line — LEAD s ahead of it,
//   never before the middle of the silence — so each row holds its whole line;
// - after a sung row followed by an unsung one (an instrumental tail) the cut is TAIL s after the
//   voice stops; before a sung row after an unsung one (an intro), LEAD s before the voice —
//   neither past the middle of the silence between the two lines around them;
// - unsung rows share the time between those cuts in proportion to their CSV lengths. Unsung rows
//   the CSV put between two lines that are really sung back to back (no time for them) are dropped
//   rather than pushing the next line's cut after its voice.
export const LEAD = 0.25,
  TAIL = 0.3,
  MIN_ROW = 0.3;
export function retimeRows(rows, sung, duration) {
  const N = rows.length;
  if (!N) return [];
  const last = rows[N - 1];
  const D = duration > 0 ? duration : last.start + last.duration;
  const anchor = i => (sung[i] && sung[i].end > sung[i].start ? sung[i] : null);
  // the nearest sung row before / after row i
  const before = i => {
    while (i >= 0 && !anchor(i)) i--;
    return i >= 0 ? anchor(i) : null;
  };
  const after = i => {
    while (i < N && !anchor(i)) i++;
    return i < N ? anchor(i) : null;
  };
  // half the silence between two lines (negative when they overlap)
  const half = (A, B) => (A && B ? (B.start - A.end) / 2 : Infinity);
  const cut = new Array(N + 1).fill(null);
  cut[0] = 0;
  cut[N] = D;
  for (let k = 1; k < N; k++) {
    const A = anchor(k - 1),
      B = anchor(k);
    if (A && B) {
      const gap = B.start - A.end;
      cut[k] = gap >= 0 ? B.start - Math.min(LEAD, gap / 2) : (A.end + B.start) / 2;
    } else if (B) {
      const h = half(before(k - 1), B);
      cut[k] = h < 0 ? B.start + h : B.start - Math.min(LEAD, h);
    } else if (A) {
      const h = half(A, after(k));
      cut[k] = h < 0 ? A.end + h : A.end + Math.min(TAIL, h);
    }
  }
  // cuts with no voice on either side: spread by the CSV lengths of the rows between known cuts
  for (let k = 1; k < N;) {
    if (cut[k] !== null) {
      k++;
      continue;
    }
    let j = k;
    while (cut[j] === null) j++;
    const L = cut[k - 1],
      R = cut[j];
    const lens = rows.slice(k - 1, j).map(r => Math.max(0.01, r.duration));
    const total = lens.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let m = k; m < j; m++) {
      acc += lens[m - k];
      cut[m] = L + ((R - L) * acc) / total;
    }
    k = j;
  }
  // A run of unsung rows squeezed between two sung lines with no room for them (under a second —
  // only a flash) goes: the next line starts where the run would have.
  const keep = rows.map(() => true);
  for (let u = 0; u < N;) {
    if (anchor(u)) {
      u++;
      continue;
    }
    let v = u;
    while (v + 1 < N && !anchor(v + 1)) v++;
    const wordless = rows.slice(u, v + 1).every(r => !String(r.lyric || '').trim());
    if (wordless && u > 0 && v + 1 < N && cut[v + 1] - cut[u] < Math.max(1, MIN_ROW * (v - u + 1)))
      for (let i = u; i <= v; i++) keep[i] = false;
    u = v + 1;
  }
  const idx = rows.map((_, i) => i).filter(i => keep[i]);
  // the kept rows' cuts: each starts where it did, or where a dropped run before it started
  const c = idx.map((i, j) => (j && !keep[i - 1] ? cut[idx[j - 1] + 1] : cut[i]));
  c.push(D);
  const M = idx.length;
  // every row at least MIN_ROW long, cuts in order, within the song
  for (let k = 1; k < M; k++) c[k] = Math.max(c[k], c[k - 1] + MIN_ROW);
  for (let k = M - 1; k >= 1; k--) c[k] = Math.min(c[k], c[k + 1] - MIN_ROW);
  for (let k = 1; k < M; k++) c[k] = Math.max(c[k], 0);
  return idx.map((i, j) => {
    const r = rows[i],
      a = anchor(i);
    return {
      ...r,
      start: round3(c[j]),
      duration: round3(c[j + 1] - c[j]),
      csvStart: r.csvStart ?? r.start,
      csvDuration: r.csvDuration ?? r.duration,
      sungStart: a ? round3(a.start) : null,
      sungEnd: a ? round3(a.end) : null,
      alignScore: sung[i]?.score ?? null,
    };
  });
}

// The CSV rows a storyboard shot covers, found by time: every row starting inside [start, end).
// Gives a storyboard imported before the beats carried their timing those beats back from the same
// CSV — the shots, their images, wires and clips stay as they are. null when the rows found do not
// fill the shot (another CSV, or a shot whose timing was changed since).
export function beatsFor(shot, rows) {
  const s = Number(shot.start),
    e = s + Number(shot.duration);
  const members = rows.filter(r => r.start >= s - 0.005 && r.start < e - 0.005);
  if (!members.length) return null;
  const sum = members.reduce((a, r) => a + r.duration, 0);
  if (Math.abs(sum - Number(shot.duration)) > 0.05) return null;
  return members.map(partOf);
}

// The motion prompt of a merged shot: its length and each beat in order (framing, action, the line
// it lip-syncs, how long it lasts).
export function mergedVideoPrompt(members) {
  const duration = members.reduce((a, m) => a + m.duration, 0);
  const beats = members
    .map((m, i) => {
      const cam = [
        m.shotSize && m.shotSize + ' shot',
        m.angle && m.angle + ' angle',
        m.lens && m.lens + ' lens',
        m.movement,
      ]
        .filter(Boolean)
        .join(', ');
      const pace = paceOf(m.energy);
      let beat = `Beat ${i + 1} (~${round3(m.duration)}s${pace ? ', ' + pace : ''}): ${m.subject || 'the scene'}${cam ? ' — ' + cam : ''}${m.action ? ', ' + m.action : ''}`;
      if (m.emotion) beat += `; emotion: ${m.emotion}`;
      if (m.lipSync && m.lyric) beat += `, lip-syncing: ${JSON.stringify(m.lyric)}`;
      return beat;
    })
    .join('. ');
  const loc = members.find(m => m.location)?.location;
  return (
    `${Math.round(duration)}-second continuous music-video sequence${loc ? ' at ' + loc : ''}, cut across ${members.length} beats in time with the music. ${beats}. ` +
    "Keep each performer's lip-sync accurate on their own beat; smooth musical cuts, consistent " +
    'identities, clean footage, no on-screen text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm.'
  );
}

// Merge several consecutive beats into one ~N-second shot: combined lyric, a cut-list prompt
// describing each internal beat, and the dominant subject (for auto-wiring + the keyframe).
function combineBundle(members) {
  if (members.length === 1) return members[0];
  const start = members[0].start;
  const duration = round3(members.reduce((a, m) => a + m.duration, 0));
  const section = members[0].section;
  const lyric = members
    .map(m => m.lyric)
    .filter(Boolean)
    .join(' ');
  const lipSync = members.some(m => m.lipSync);
  // Dominant beat = the longest lip-sync beat, else the longest beat: its subject anchors the clip.
  const dom = [...members].sort(
    (a, b) => Number(b.lipSync) - Number(a.lipSync) || b.duration - a.duration,
  )[0];
  const first = members[0].shot,
    last = members[members.length - 1].shot;
  const videoPrompt = mergedVideoPrompt(members);
  // The clip opens on beat 1, so a keyframe (if one is made) is that opening frame — not a still of
  // the whole multi-beat sequence, which no single photograph can show.
  const m0 = members[0];
  const cam0 = [
    m0.shotSize && m0.shotSize + ' shot',
    m0.angle && m0.angle + ' angle',
    m0.lens && m0.lens + ' lens',
  ]
    .filter(Boolean)
    .join(', ');
  const stillPrompt =
    'Still keyframe, one photographic moment of this shot, not a sequence: the opening frame — ' +
    [whoWhere(m0), cam0, m0.action, m0.emotion && 'expression: ' + faceOf(m0.emotion)]
      .filter(Boolean)
      .join(', ') +
    '. Hold the moment at its strongest instant; no motion blur, no text.';
  return {
    shot: `${first}–${last}`,
    name: (`Shot ${first}–${last}` + (section ? ` — ${section}` : '')).slice(0, 100),
    section,
    start,
    duration,
    lyric,
    lipSync,
    subject: dom.subject,
    shotSize: dom.shotSize,
    energy: Math.max(0, ...members.map(m => Number(m.energy) || 0)) || '',
    videoPrompt,
    stillPrompt,
    beats: members.length,
    // Each beat: wires every performer the clip shows (including one only named in the action,
    // like the singer inside a wide of the hall) and lets a lip-sync take cut its sung line.
    parts: members.map(partOf),
  };
}

// Bundle consecutive shots so each bundle lands as close to ~targetSeconds as the beats allow, then
// merge each bundle into one shot. Before adding a beat, the bundle closes if stopping now is
// nearer the target than taking the beat (and the bundle is at least half the target), so a 7.4s
// bundle is not pushed to 11.4s by one more 4s beat; nor does any bundle grow past 1.25 × the
// target by taking a beat. A beat longer than the target stays whole (splitLong cuts those first).
// target <= 0 → no consolidation (one shot per row). A change of Location always cuts: one clip is
// filmed in one set (its references hold one location). A sliver (< 2s) left before a change of
// set or at the end folds into the previous bundle of the same set, so there is no sliver clip.
export function groupShots(shots, targetSeconds) {
  const target = Number(targetSeconds);
  if (!(target > 0)) return shots;
  // A merged shot is filmed by one model take, so it never grows past what that take covers: at
  // most 1.25× the target, and never past MAX_ROW (Veo's longest take is 8 s), so the clip fills
  // its whole slot and the song stays covered. A trailing sliver (< 2 s) that would still fit folds
  // onto the previous bundle instead of becoming its own clip.
  const hardMax = Math.min(target * 1.25, MAX_ROW);
  const bundles = [];
  let cur = [],
    dur = 0;
  // a set's name as the cast step keys it ("Candle-lit stage." = "candle lit stage")
  const place = s =>
    String(s.location || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  // a bundle's set: the first Location among its beats (a beat with none sits in any set)
  const setOf = list => list.map(place).find(Boolean) || '';
  const moves = (a, b) => !!a && !!b && a !== b;
  const sum = list => list.reduce((a, x) => a + x.duration, 0);
  const close = () => {
    const last = bundles[bundles.length - 1];
    const fold = last && dur < 2 && !moves(setOf(last), setOf(cur)) && sum(last) + dur <= hardMax;
    if (fold) last.push(...cur);
    else bundles.push(cur);
    cur = [];
    dur = 0;
  };
  for (const s of shots) {
    if (
      cur.length &&
      (moves(setOf(cur), place(s)) ||
        dur + s.duration > hardMax || // never well past what one clip films
        (dur >= target / 2 && Math.abs(dur + s.duration - target) > Math.abs(dur - target)))
    )
      close();
    cur.push(s);
    dur += s.duration;
    if (dur >= target) close();
  }
  if (cur.length) close();
  return bundles.map(combineBundle);
}

// The longest clip a video model makes in one take (Veo: 8 s).
export const MAX_ROW = 8;
// Rows re-timed to the vocal can grow past MAX_ROW: a sung row also holds the instrumental gap
// after its line when the CSV had no row there — or, first in the song, the intro the CSV missed.
// Such a row is cut so no clip outlasts the model: a wordless stretch of 2 s or more before the
// line becomes pieces of its own; then the piece with the line (to TAIL s after the voice, at
// least an even share) and the rest split evenly. The pieces ("078.2", "078.3") hold the same
// picture with no line. A sung row that was not re-timed (where its line is unknown) stays whole,
// as does a remainder < 2 s.
export function splitLong(rows, max = MAX_ROW) {
  const out = [];
  for (const r of rows) {
    const sung = !!String(r.lyric || '').trim();
    if (!(r.duration > max + 0.001) || (sung && (r.sungEnd == null || r.sungStart == null))) {
      out.push(r);
      continue;
    }
    let k = 2;
    const wordless = (start, end) => {
      const n = Math.ceil((end - start - 0.001) / max);
      for (let i = 0; i < n; i++) {
        const a = round3(start + ((end - start) * i) / n),
          b = round3(start + ((end - start) * (i + 1)) / n);
        const piece = {
          ...r,
          shot: `${r.shot}.${k}`,
          name: r.name.replace(/^Shot \S+/, `Shot ${r.shot}.${k}`),
          start: a,
          duration: round3(b - a),
          lyric: '',
          lipSync: false,
          sungStart: null,
          sungEnd: null,
          alignScore: null,
        };
        k++;
        piece.videoPrompt = beatPrompt(piece);
        out.push(piece);
      }
    };
    // the intro the CSV missed, before the line
    const pre = sung ? r.sungStart - LEAD - r.start : 0;
    const from = pre >= 2 ? r.start + pre : r.start;
    if (pre >= 2) wordless(r.start, from);
    const end = r.start + r.duration,
      len = end - from;
    if (!(len > max + 0.001)) {
      out.push({ ...r, start: round3(from), duration: round3(len) });
      continue;
    }
    const even = len / Math.ceil(len / max);
    const head = Math.min(len, Math.max(even, sung ? r.sungEnd + TAIL - from : 0));
    if (len - head < 2) {
      out.push({ ...r, start: round3(from), duration: round3(len) });
      continue;
    }
    out.push({ ...r, start: round3(from), duration: round3(head) });
    wordless(from + head, end);
  }
  return out;
}

// Lyric-timing table → the song's sections (for the music node's analysis view / SRT reference).
export function rowsToSections(rows) {
  const sections = [];
  for (const row of rows) {
    const start = parseTime(pick(row, 'Start'));
    if (start == null) continue;
    const end = parseTime(pick(row, 'End'));
    sections.push({
      name: pick(row, 'Section'),
      startSec: round3(start),
      endSec: end != null ? round3(end) : round3(start),
      lyric: pick(row, 'Exact Lyric', 'Lyric'),
      note: pick(row, 'Delivery'),
    });
  }
  return sections;
}
