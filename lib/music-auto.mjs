// One-button storyboard from a song: the machine does the structure (split the lyric into rows,
// estimate the times, measure Energy from the song's loudness, detect the instruments) and the LLM
// only fills the creative columns of a skeleton CSV — then the machine validates and, if needed,
// asks the LLM to fix the flagged rows. The result is a luồng-A (coverage) CSV with a Vocal
// Delivery column; /api/music/import then re-times it to the vocal and builds luồng A + luồng B.
//
// Columns the LLM fills: Emotion, Subject, Shot Size, Angle, Camera Movement, Action, Vocal
// Delivery. Everything else is written by the tool and must come back unchanged.
import { parseCsv } from './csv.mjs';
import { SHOT_LIST_HEADER } from './shotlist.mjs';

const round3 = n => Math.round(n * 1000) / 1000;
const fmt = t => {
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${(t - 60 * m).toFixed(3).padStart(6, '0')}`;
};
const nwords = s =>
  String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

// --- the lyric → sections ------------------------------------------------------------------------
const MERGE = /\b(intro|verse|bridge|outro|spoken)\b/i;
const SPLIT = /\b(pre-?chorus|chorus|final|powerful)\b/i;

// Parse "[Section]" blocks (an [End] marker is dropped; a [Guitar Solo] / [Instrumental] with no
// lines is kept), then give each a canonical name (Verse 1/2, Chorus 1/2, Instrumental N…).
export function lyricSections(text) {
  const blocks = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\[(.+?)\]$/);
    if (m) {
      if (m[1].trim().toLowerCase() === 'end') continue;
      cur = { label: m[1].trim(), lines: [] };
      blocks.push(cur);
    } else if (cur) cur.lines.push(line);
    else blocks.push((cur = { label: 'Intro', lines: [line] }));
  }
  const counts = {};
  const next = base => `${base} ${(counts[base] = (counts[base] || 0) + 1)}`;
  return blocks.map(({ label, lines }) => {
    // Section tags in the lyric's own language: Spanish / Portuguese / Italian / French /
    // Vietnamese tags read like the English ones ("Coro" is a chorus, "Puente" a bridge,
    // "Intro – muy suave" an intro). Read as "Verse", a whole Spanish song became Verse 1–10.
    const low = strip(label);
    const has = re => re.test(low);
    let name;
    if (has(/^(spoken|intro|dao dau|mo dau)/) || has(/\bspoken\b/)) name = 'Intro';
    else if (has(/\bfading\b/)) name = 'Fading Outro';
    else if (has(/\b(outro|cierre|coda|ket|vi thanh)\b/)) name = 'Outro';
    else if (has(/\b(bridge|puente|ponte|pont|cau noi|cau)\b/)) name = 'Bridge';
    else if (has(/\b(powerful|final)\b/)) name = 'Final Chorus';
    else if (has(/\b(solo|instrumental|interludio|interlude|intermezzo|gian tau)\b/) || !lines.length)
      name = next('Instrumental');
    else if (has(/\b(pre|tien diep khuc)\b/)) name = next('Pre-Chorus');
    else if (has(/\b(chorus|coro|estribillo|refran|refrao|ritornello|refrain|diep khuc|hook)\b/))
      name = next('Chorus');
    else name = next('Verse'); // verse, verso, estrofa, couplet, strofa, phien khuc…
    return { name, label, lines };
  });
}
const strip = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .trim();
// A cast member's / place's key, the same slug the importer wires by ("Grandmother's house" →
// "grandmother_s_house").
export const placeKey = s =>
  strip(s)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'stage';

// One section's lyric lines → the rows that cover it: merge two short (≤4-word) adjacent lines in a
// Verse/Intro/Bridge/Outro; split a long (>8-word) line of a Chorus/Pre-Chorus at its first comma.
function rowsForSection(label, lines) {
  const low = label.toLowerCase();
  const out = [];
  if (SPLIT.test(low)) {
    for (const ln of lines) {
      const w = ln.split(/\s+/);
      if (w.length > 8) {
        if (ln.includes(',')) {
          const [a, b] = ln.split(/,(.+)/);
          out.push(a.trim() + ',', b.trim());
        } else {
          const h = Math.ceil(w.length / 2);
          out.push(w.slice(0, h).join(' '), w.slice(h).join(' '));
        }
      } else out.push(ln);
    }
  } else {
    for (let i = 0; i < lines.length;) {
      if (i + 1 < lines.length && nwords(lines[i]) <= 4 && nwords(lines[i + 1]) <= 4) {
        out.push(lines[i] + ' ' + lines[i + 1]);
        i += 2;
      } else out.push(lines[i++]);
    }
  }
  return out;
}

const dbToEnergy = (db, lo, hi) =>
  hi - lo < 1e-6 ? 5 : Math.max(1, Math.min(10, Math.round(1 + 9 * ((db - lo) / (hi - lo)))));
const dbAt = (curve, t) =>
  (curve || []).reduce(
    (best, p) => (Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best),
    [0, -30],
  )[1];

// The skeleton CSV rows: Shot / Start / End / Section / Lyric / Energy / Location filled, the
// creative columns empty. Times tile the song head→tail by word weight (an estimate; the import
// re-times every row to where its line is really sung).
export function skeletonRows(sections, { total, energyCurve = [], lo = -30, hi = -3, location }) {
  const plan = [];
  for (const { name, lines } of sections) {
    if (!lines.length) plan.push({ name, lyric: '', w: 4 });
    else
      for (const r of rowsForSection(name, lines))
        plan.push({ name, lyric: r, w: Math.max(2, nwords(r)) });
  }
  if (!plan.length || !(total > 0)) return [];
  // the wordless intro / outro take a small share of the song; on a short song they shrink so the
  // lyric rows still fit (head + tail never eats more than ~a quarter of it)
  const head = Math.min(2.0, total * 0.1),
    tail = Math.min(4.0, total * 0.15);
  const body = Math.max(0.1, total - head - tail);
  const W = plan.reduce((a, p) => a + p.w, 0) || 1;
  const first = plan[0].name,
    last = plan[plan.length - 1].name;
  const timed = [{ name: first, lyric: '', dur: head }];
  for (const p of plan) timed.push({ name: p.name, lyric: p.lyric, dur: (body * p.w) / W });
  timed.push({ name: last, lyric: '', dur: tail });

  const rows = [];
  let t = 0;
  timed.forEach((p, i) => {
    const start = t;
    // every row ends after it starts and no later than the song; the last one ends exactly at the end
    const end =
      i === timed.length - 1
        ? Math.max(round3(start + 0.05), total)
        : Math.min(total, Math.max(round3(start + 0.05), round3(t + p.dur)));
    if (start >= total) return; // the song is too short for this many rows: stop tiling
    rows.push({
      Shot: String(i + 1).padStart(3, '0'),
      Start: fmt(start),
      End: fmt(end),
      Section: p.name,
      Lyric: p.lyric,
      'Lip Sync': '',
      Energy: dbToEnergy(dbAt(energyCurve, (start + end) / 2), lo, hi),
      Emotion: '',
      Subject: '',
      Location: location || 'Dim concert hall stage',
      'Shot Size': '',
      Angle: '',
      'Camera Movement': '',
      Action: '',
      'Vocal Delivery': '',
    });
    t = end;
  });
  // flatten Energy per section (median) so one noisy row does not mislead the LLM
  const bySec = {};
  for (const r of rows) (bySec[r.Section] ||= []).push(r.Energy);
  const median = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  for (const r of rows) if (r.Lyric) r.Energy = median(bySec[r.Section]);
  return rows;
}

const HEADERS = SHOT_LIST_HEADER.split(',');
const esc = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const rowsToCsv = rows =>
  [SHOT_LIST_HEADER, ...rows.map(r => HEADERS.map(h => esc(r[h])).join(','))].join('\n');

// --- the cast the treatment designs ------------------------------------------------------------
// A narrative MV (a grandmother praying through her house, a family far away…) is not a band on a
// stage. The treatment (station ①) ends with a machine-readable ```cast block — who sings, who else
// appears, where — and the fill step, the checker and the build all follow it. Without it the fill
// step fell back to the concert vocabulary (Singer / Guitarist / Audience at one "Dim concert hall
// stage") and silently turned the treatment's story into a stage show.
const FENCE = '```';
export const CAST_SPEC = [
  `Kết thúc treatment bằng ĐÚNG MỘT khối ${FENCE}cast (JSON) — tool đọc khối này để dựng nhân vật, bối cảnh và nối dây:`,
  `${FENCE}cast`,
  '{"singer": "<tên của người hát chính, trùng một name trong people>",',
  ' "people": [{"name": "<tên tiếng Anh ngắn 1–3 từ, vd Abuela, Adult son, Guitarist>",',
  '             "look": "<EN: tuổi, dáng, tóc, mặt, trang phục — đủ để vẽ model sheet; không tên người thật>",',
  '             "identity_label": "<EN: cách gọi khi quay lưng, vd the silver-haired grandmother>",',
  '             "back_view": "<EN: nhìn từ sau thấy gì>"}],',
  ' "places": [{"name": "<tên bối cảnh tiếng Anh ngắn, vd Grandmother\'s bedroom>", "look": "<EN: tả bối cảnh để vẽ location sheet>"}],',
  ' "lipsync_place": "<name của MỘT place — nơi ca sĩ hát nhép vào ống kính>"}',
  FENCE,
  '- people: người hát chính ĐẦU TIÊN; chỉ những người thật sự xuất hiện (tối đa 8); đám đông/khán giả không cần mục riêng.',
  '- places: 1–6 bối cảnh treatment dùng (sân khấu cũng là một place nếu có).',
  '- MV biểu diễn trên sân khấu: people là ca sĩ + từng nhạc công, places là sân khấu. MV kể chuyện: people là các nhân vật của câu chuyện.',
].join('\n');

const castBlock = text => {
  const t = String(text || '');
  const m =
    t.match(/```cast\s*\n([\s\S]*?)```/i) || t.match(/```json\s*\n(\{[\s\S]*?"people"[\s\S]*?)```/i);
  return m ? m[1] : null;
};
const clip = (v, n) =>
  String(v ?? '')
    .trim()
    .slice(0, n);
// The treatment's cast, normalised — or null when it has none / it is unreadable.
export function parseCast(text) {
  const raw = castBlock(text);
  if (!raw) return null;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const uniq = list => {
    const seen = new Set();
    return list.filter(
      x => x.name && x.look && !seen.has(placeKey(x.name)) && seen.add(placeKey(x.name)),
    );
  };
  const people = uniq(
    (Array.isArray(j.people) ? j.people : []).map(p => ({
      name: clip(p?.name, 60),
      look: clip(p?.look, 1500),
      identity_label: clip(p?.identity_label, 200),
      back_view: clip(p?.back_view, 500),
    })),
  ).slice(0, 8);
  const places = uniq(
    (Array.isArray(j.places) ? j.places : []).map(p => ({
      name: clip(p?.name, 80),
      look: clip(p?.look, 1500),
    })),
  ).slice(0, 6);
  if (!people.length || !places.length) return null;
  const find = (list, name) => list.find(x => placeKey(x.name) === placeKey(name));
  const singer = (find(people, j.singer) || people[0]).name;
  const lipsyncPlace = (find(places, j.lipsync_place) || places[0]).name;
  return { singer, people, places, lipsyncPlace };
}
// The cast as a blueprint (assets only + one placeholder shot the importer drops), so it goes
// through the same builder as every other blueprint: a person becomes a character turnaround, a
// place a 3-in-1 location sheet, each keyed by its name's slug (what the CSV's Subject / Location
// wire by).
export const castBlueprint = cast => ({
  project: { name: 'MV cast', theme: 'music' },
  assets: [
    ...cast.people.map(p => ({
      key: placeKey(p.name),
      role: 'character',
      // the lead keeps "ca sĩ" in its name: a "Singer" Subject and the lip-sync takes find it
      name: placeKey(p.name) === placeKey(cast.singer) ? `${p.name} (ca sĩ)` : p.name,
      prompt: p.look,
      ...(p.identity_label ? { identity_label: p.identity_label } : {}),
      ...(p.back_view ? { back_view: p.back_view } : {}),
    })),
    ...cast.places.map(p => ({
      key: placeKey(p.name),
      role: 'scene',
      name: p.name,
      prompt: p.look,
    })),
  ],
  shots: [{ name: 'tmp', duration: 8, uses: [placeKey(cast.singer)] }],
});

// --- the LLM prompts -----------------------------------------------------------------------------
const system = cast =>
  'Bạn là Đạo diễn MV + Dựng phim âm nhạc. Tool đã chia hàng theo lời, ước lượng giờ và đo Energy. ' +
  `Việc của bạn: điền ${cast ? '8 cột Emotion, Subject, Location' : '7 cột Emotion, Subject'}, Shot Size, Angle, Camera Movement, Action, Vocal ` +
  `Delivery cho mọi hàng. KHÔNG đổi Shot, Start, End, Section, Lyric, Energy${cast ? '' : ', Location'}, Lip Sync. ` +
  'Không thêm, bớt, gộp hàng. Trả về ĐÚNG MỘT khối ```csv``` đủ số hàng, header đúng như khung.';

// Subject / Location rules: the treatment's own cast and places when it has them, else the concert
// vocabulary (a song-only storyboard: a band on one stage).
function subjectRules(profile, cast) {
  if (cast) {
    const people = cast.people.map(p => p.name);
    return (
      `- Subject: CHỈ dùng tên trong dàn của treatment: ${people.map(x => `"${x}"`).join(', ')} (người hát chính là "${cast.singer}"). ` +
      `Hai–ba người cùng khung: nối bằng " + " (vd "${people.slice(0, 2).join(' + ')}"). ` +
      'Khung chỉ có một vật: MỘT danh từ tiếng Anh (vd Candle, Window, Hands). Khung chỉ có bối cảnh: để TRỐNG. ' +
      `"${cast.singer}" ở luồng này KHÔNG hát vào ống kính: góc rear / profile / overhead, hoặc chỉ thấy tay / bóng — KHÔNG MCU/CU chính diện mặt.\n` +
      `- Location: điền ĐÚNG một tên bối cảnh của treatment: ${cast.places.map(p => `"${p.name}"`).join(', ')} — đúng nơi treatment đặt đoạn đó.\n` +
      '- Shot Size: EWS, WS, MS, MCU, CU, ECU, Macro. Angle: eye level, low, high, 3/4, profile, overhead, rear. Không lặp cùng Shot Size + Angle ở hai hàng liền. Mỗi Section luân phiên toàn – trung – cận – chi tiết theo mạch treatment. Chorus hát lại không lặp nguyên thứ tự Shot Size + Angle của Chorus trước.\n'
    );
  }
  const instr =
    (profile?.instruments || []).join(', ') ||
    '(không rõ — chọn Pianist cho ballad, Guitarist cho thể loại khác)';
  return (
    `- Subject: chỉ Band, Pianist, Guitarist, Violinist, Cellist, Drummer, Bassist, Choir, Audience, Singer, Stage, hoặc MỘT vật (danh từ tiếng Anh không mạo từ: Piano keys, Guitar strings, Microphone, Candle). Dùng đúng nhạc cụ có trong hồ sơ (${instr}). Hai người: "Pianist + Drummer". Ba người trở lên = "Band" và Action gọi tên từng nhạc công thấy trong khung. Có Singer thì Angle phải rear/profile/overhead hoặc chỉ thấy tay/bóng — KHÔNG bao giờ MCU/CU chính diện mặt ca sĩ. Khung chỉ có bối cảnh: để TRỐNG.\n` +
    '- Shot Size: EWS, WS, MS, MCU, CU, ECU, Macro. Angle: eye level, low, high, 3/4, profile, overhead, rear. Không lặp cùng Shot Size + Angle ở hai hàng liền. Mỗi Section luân phiên: toàn band (WS/EWS) → nhóm (MS) → một nhạc công (CU/MCU) → nhạc cụ (Macro/ECU) → toàn cảnh (EWS) → khán giả. Chorus hát lại không lặp nguyên thứ tự Shot Size + Angle của Chorus trước.\n'
  );
}

export function fillPrompt(profile, csvText, rowCount, cast = null) {
  const instr = (profile?.instruments || []).join(', ') || '(không rõ)';
  const user =
    'HỒ SƠ ÂM NHẠC (tool tự đo):\n' +
    `- Nhạc cụ có mặt: ${instr}\n` +
    `- Nhịp bài: ${profile?.feel === 'nhanh' ? 'nhanh' : 'chậm'}${profile?.words_per_sec ? ` (mật độ lời ${profile.words_per_sec} từ/giây)` : ''}\n` +
    `- Thời lượng: ${profile?.total ?? '?'} giây\n\n` +
    'ĐÂY LÀ CSV CỦA LUỒNG PHỦ CẢNH (luồng A). Tool tự cắt luồng hát nhép (luồng B) từ giọng thật, ' +
    'nên CSV này KHÔNG có hàng nào là ca sĩ hát vào ống kính. Các hàng là những gì khán giả thấy ' +
    (cast
      ? 'TRONG LÚC bài hát chạy, đúng theo mạch hình của treatment: các nhân vật, hành động, chi tiết, bối cảnh của câu chuyện.\n\n'
      : 'TRONG LÚC bài hát chạy: band toàn/trung/cận, nhạc cụ đang chơi, toàn cảnh sân khấu, khán giả ' +
        'phản ứng, chi tiết, bối cảnh. Ca sĩ CÓ THỂ xuất hiện nhưng chỉ ở góc không thấy khẩu hình ' +
        '(rear / profile / overhead, hoặc chỉ thấy bàn tay / bóng / dáng người).\n\n') +
    'QUY TẮC\n' +
    subjectRules(profile, cast) +
    '- Camera Movement: locked, slow push-in, pull-out, dolly left, dolly right, orbit, tracking, crane up, crane down, handheld, rack focus. Theo Energy: 1–3 locked/slow push-in; 4–6 dolly left/right, pull-out, rack focus; 7–8 orbit, tracking, crane up; 9–10 crane up/down, tracking, handheld. ' +
    `${profile?.feel === 'nhanh' ? '' : 'Bài chậm: bỏ handheld và tracking; Energy 7–10 chỉ crane up, crane down, orbit. '}\n` +
    `- Emotion (tiếng Anh, cảm xúc NHÌN THẤY của người/vật TRONG KHUNG${cast ? '' : ' — thường là band/khán giả, không phải ca sĩ'}): người → "<cảm xúc> — <nét mặt, cơ thể>; <cử chỉ/phản ứng>"; vật/không người → "<tâm trạng> — <hình ảnh>".\n` +
    `- Action: một câu tiếng Anh tả việc nhìn thấy${cast ? ', gọi đúng tên người trong Subject' : '; hàng Band gọi tên các nhạc công'}; không lặp Emotion, không tả khẩu hình, không tả âm thanh.\n` +
    '- Vocal Delivery: CHỈ điền ở hàng CÓ Lyric (hàng không lời để TRỐNG). Tả CA SĨ hát câu đó thế nào — cảm xúc TRONG GIỌNG + độ to (soft khi Energy ≤4, medium 5–7, full 8–10), tiếng Anh (vd "aching, almost whispered — soft voice"). Đây là dữ liệu cho luồng hát nhép; KHÁC với Emotion.\n' +
    '- Hành trình cảm xúc: mỗi Section một cảm xúc gốc, đổi tối đa một lần khi lời rẽ nghĩa; Verse kìm nén → Pre-Chorus dồn → Chorus bung → Bridge vỡ/lắng → Final Chorus đỉnh. Ballad/thánh ca: "bung" là nước mắt, biết ơn, không gào.\n\n' +
    `Xuất ĐÚNG MỘT khối \`\`\`csv\`\`\` gồm header và đủ ${rowCount} hàng, đúng thứ tự Shot.\n\n` +
    'KHUNG CSV\n```csv\n' +
    csvText +
    '\n```';
  return { system: system(cast), user };
}

export function fixPrompt(errors, currentCsv, rowCount, cast = null) {
  return {
    system: system(cast),
    user:
      'Đây là BẢNG BẠN VỪA TRẢ. Sửa ĐÚNG các hàng lỗi theo lý do bên dưới, giữ nguyên mọi hàng ' +
      `khác và giữ nguyên Shot, Start, End, Section, Lyric, Energy${cast ? '' : ', Location'}, Lip Sync. Không lặp ` +
      'Shot Size + Angle với hàng liền kề.' +
      (cast
        ? ` Subject chỉ dùng: ${cast.people.map(p => p.name).join(', ')} (hoặc một vật); Location chỉ dùng: ${cast.places.map(p => p.name).join(', ')}.`
        : '') +
      '\n\nBẢNG HIỆN TẠI\n```csv\n' +
      currentCsv +
      '\n```\n\nHàng lỗi:\n' +
      JSON.stringify(errors, null, 1) +
      `\n\nXuất lại ĐÚNG MỘT khối \`\`\`csv\`\`\` đầy đủ ${rowCount} hàng.`,
  };
}

// The ```csv block of an LLM reply (or the whole reply when it is bare CSV with the right header).
export function extractCsv(text) {
  const m =
    String(text || '').match(/```csv\s*\n([\s\S]*?)```/i) ||
    String(text).match(/```\s*\n(Shot,[\s\S]*?)```/i);
  if (m) return m[1].trim();
  const i = String(text).indexOf('Shot,Start,End');
  if (i >= 0) return String(text).slice(i).trim();
  throw new Error('LLM không trả về khối CSV. Thử lại, hoặc chuyển sang nhập CSV tay ở bước 2.');
}

// --- validation (two streams) --------------------------------------------------------------------
const SIZES = new Set(['EWS', 'WS', 'MS', 'MCU', 'CU', 'ECU', 'Macro']);
const ANGLES = new Set(['eye level', 'low', 'high', '3/4', 'profile', 'overhead', 'rear']);
const CAMS = new Set([
  'locked',
  'slow push-in',
  'pull-out',
  'dolly left',
  'dolly right',
  'orbit',
  'tracking',
  'crane up',
  'crane down',
  'handheld',
  'rack focus',
]);
const PEOPLE = new Set([
  'Singer',
  'Pianist',
  'Guitarist',
  'Violinist',
  'Cellist',
  'Drummer',
  'Bassist',
  'Band',
  'Choir',
  'Audience',
  'Stage',
]);
const LOCKED = ['Shot', 'Start', 'End', 'Section', 'Lyric', 'Energy', 'Location'];
const camsForEnergy = (e, feel) =>
  e <= 3
    ? ['locked', 'slow push-in']
    : e <= 6
      ? ['dolly left', 'dolly right', 'pull-out', 'rack focus']
      : feel === 'cham'
        ? ['crane up', 'crane down', 'orbit']
        : e <= 8
          ? ['orbit', 'tracking', 'crane up']
          : ['crane up', 'crane down', 'tracking', 'handheld'];

const voiceOf = e => (e <= 4 ? 'soft voice' : e <= 7 ? 'medium voice' : 'full voice');
// A single-token Subject that is not a listed role is allowed when it is a plain object noun
// (letters and spaces, any language / casing): "Piano keys", "Microphone", "Candle", "Micrófono".
const isObjectNoun = s => /^\p{L}[\p{L} ]*$/u.test(s);
const namesMusician = a =>
  /(singer|vocalist|pianist|keyboardist|guitarist|violinist|cellist|drummer|bassist|band|choir|trio|quartet|musicians?|players?|performers?)/i.test(
    a,
  );

// Check the LLM's CSV against the skeleton AND make it importable: restore any locked column it
// changed, coerce an out-of-range creative cell to a safe value, force Lip Sync = NO (luồng B is
// cut by the tool). The returned CSV always imports; `errors` lists what was off (for the fix loop
// and the UI count). Parsed with the shared CSV reader, so quoted commas / newlines and blank
// lines are handled.
export function validateFilled(skeleton, filledCsv, feel, cast = null) {
  const L = parseCsv(filledCsv).map(r => {
    const o = {};
    for (const h of HEADERS) o[h] = String(r[h] ?? '').trim();
    return o;
  });
  const errs = [];
  const err = (shot, loi) => errs.push({ Shot: shot, loi });
  if (L.length !== skeleton.length)
    err('*', `số hàng khác khung: khung ${skeleton.length}, LLM ${L.length}`);
  const n = Math.min(L.length, skeleton.length);
  for (let i = 0; i < n; i++) {
    const k = skeleton[i],
      r = L[i],
      s = r.Shot || k.Shot;
    // the tool owns these; whatever the LLM did to them is reverted
    for (const c of LOCKED)
      if (cast && c === 'Location') continue; // the treatment's places: the LLM picks per row
      else if (String(k[c]) !== String(r[c])) (err(s, `cột ${c} bị đổi`), (r[c] = k[c]));
    if (cast) {
      const place = cast.places.find(p => placeKey(p.name) === placeKey(r.Location));
      if (place) r.Location = place.name;
      else {
        err(s, `Location '${r.Location}' không phải bối cảnh của treatment`);
        r.Location = (i && L[i - 1].Location) || cast.lipsyncPlace;
      }
    }
    const e = Number(r.Energy) || 0;
    if (!SIZES.has(r['Shot Size']))
      (err(s, `Shot Size lạ: '${r['Shot Size']}'`), (r['Shot Size'] = 'MS'));
    if (!ANGLES.has(r.Angle)) (err(s, `Angle lạ: '${r.Angle}'`), (r.Angle = 'eye level'));
    const subj = r.Subject;
    if (subj) {
      const parts = subj.split('+').map(x => x.trim());
      const person = pp => cast?.people.find(p => placeKey(p.name) === placeKey(pp));
      const singer = cast
        ? parts.some(pp => /^singer/i.test(pp) || placeKey(pp) === placeKey(cast.singer))
        : parts.some(pp => /^singer/i.test(pp));
      if (cast) {
        // the treatment's own names, spelled as the treatment spells them (the wiring keys on them)
        if (parts.length === 1 && !person(parts[0]) && !isObjectNoun(parts[0]))
          err(s, `Subject lạ: '${subj}'`);
        if (parts.length >= 2 && !parts.every(person))
          err(s, `Subject nhiều người phải là tên trong dàn treatment: '${subj}'`);
        if (parts.length > 3) err(s, `Subject tối đa 3 người: '${subj}'`);
        r.Subject = parts.map(pp => person(pp)?.name || pp).join(' + ');
      } else {
        if (parts.length === 1 && !PEOPLE.has(parts[0]) && !isObjectNoun(parts[0]))
          err(s, `Subject lạ: '${subj}'`);
        if (parts.length === 2 && !parts.every(pp => PEOPLE.has(pp)))
          err(s, `Subject 2 người sai: '${subj}'`);
        if (parts.length >= 3) err(s, `Subject ≥3 người phải là 'Band': '${subj}'`);
      }
      // no singer-to-camera row — that belongs to luồng B; turn it away from the lens
      if (
        singer &&
        ['MS', 'MCU', 'CU', 'ECU'].includes(r['Shot Size']) &&
        ['eye level', 'low', 'high', '3/4'].includes(r.Angle)
      ) {
        err(
          s,
          'hàng ca sĩ hát vào ống kính không thuộc luồng A — đổi sang góc không thấy khẩu hình',
        );
        r.Angle = 'rear';
      }
    }
    if (!r.Emotion) (err(s, 'Emotion trống'), (r.Emotion = 'focused energy — engaged, present'));
    if (!r.Action)
      (err(s, 'Action trống'),
        (r.Action = cast ? 'The scene holds quietly on the moment' : 'The performers play on the stage'));
    if (r.Lyric && !r['Vocal Delivery'])
      (err(s, 'Vocal Delivery trống'), (r['Vocal Delivery'] = `singing the line — ${voiceOf(e)}`));
    if (!r.Lyric && r['Vocal Delivery'])
      (err(s, 'Vocal Delivery phải trống ở hàng không lời'), (r['Vocal Delivery'] = ''));
    r['Lip Sync'] = 'NO'; // luồng B is cut by the tool, not chosen in the CSV
    if (!camsForEnergy(e, feel).includes(r['Camera Movement']))
      (err(s, `Camera '${r['Camera Movement']}' không hợp Energy ${e} (bài ${feel})`),
        (r['Camera Movement'] = camsForEnergy(e, feel)[0]));
  }
  // cosmetic (the import copes with either): a Band row not naming a musician in its Action, and
  // two adjacent rows of the same framing — reported for the fix loop, not coerced
  for (let i = 1; i < L.length; i++)
    if (
      L[i]['Shot Size'] &&
      L[i]['Shot Size'] === L[i - 1]['Shot Size'] &&
      L[i].Angle === L[i - 1].Angle
    )
      err(L[i].Shot, `lặp ${L[i]['Shot Size']} ${L[i].Angle} với hàng trước`);
  for (const r of L)
    if (!cast && /^band/i.test(r.Subject) && !namesMusician(r.Action))
      err(r.Shot, 'hàng Band nên gọi tên nhạc công trong Action');
  return { ok: errs.length === 0, errors: errs, csv: rowsToCsv(L), rows: L };
}
