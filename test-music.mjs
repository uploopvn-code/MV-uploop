// Music node: analyze a song (YouTube link / file / lyrics) into the tool's parameters.
// Pure parsers (unit) + the full create → patch → upload → analyze flow through a real server
// talking to a real local OpenAI-compatible LLM (no mock data: an actual HTTP exchange).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { DEEP_MUSIC_ANALYSIS_PROMPT, parseMusicAnalysis } from './director.mjs';
import { castBrief, extractYouTubeMeta, youTubeId } from './lib/routes/music.mjs';
import {
  extractCsv,
  lyricSections,
  rowsToCsv,
  skeletonRows,
  validateFilled,
} from './lib/music-auto.mjs';
import { parseCsv } from './lib/csv.mjs';
import {
  LEAD,
  MIN_ROW,
  SHOT_LIST_HEADER,
  TAIL,
  faceOf,
  splitLong,
  detectCsvKind,
  beatsFor,
  groupShots,
  parseTime,
  retimeRows,
  rowsToSections,
  rowsToShots,
} from './lib/shotlist.mjs';

// --- Unit: one-button auto storyboard (lib/music-auto.mjs) ---
{
  const LYR =
    '[Intro]\nla la\nyeah\n[Verse 1]\nI walked the road alone tonight\nunder the pale and silver light\n' +
    '[Chorus]\nAnd every single star above me shines so bright and clear tonight\n[Guitar Solo]\n' +
    '[Outro]\ngoodbye';
  const secs = lyricSections(LYR);
  assert.deepEqual(
    secs.map(s => s.name),
    ['Intro', 'Verse 1', 'Chorus 1', 'Instrumental 1', 'Outro'],
    'sections get canonical names; a solo becomes Instrumental N',
  );
  const curve = Array.from({ length: 30 }, (_, i) => [i * 2, -20 + (i % 10)]);
  const rows = skeletonRows(secs, {
    total: 60,
    energyCurve: curve,
    lo: -24,
    hi: -6,
    location: 'Opera stage',
  });
  assert.ok(rows.length >= 6, 'rows built: ' + rows.length);
  assert.equal(rows[0].Start, '00:00.000', 'tiles from 0');
  assert.equal(rows[rows.length - 1].End, '01:00.000', 'tiles to the song end');
  for (let i = 1; i < rows.length; i++)
    assert.equal(rows[i].Start, rows[i - 1].End, 'no gap / overlap in the skeleton');
  assert.ok(
    rows.every(
      r => !r['Lip Sync'] && !r['Vocal Delivery'] && !r.Subject && r.Location === 'Opera stage',
    ),
    'creative columns + Vocal Delivery empty; Location filled; Lip Sync left to the tool',
  );
  assert.ok(
    rows.every(r => Number(r.Energy) >= 1 && Number(r.Energy) <= 10),
    'Energy 1–10 from the loudness curve',
  );
  // the Chorus line (>8 words) was split into two rows
  assert.ok(rows.filter(r => r.Section === 'Chorus 1').length >= 2, 'a long chorus line splits');

  // a well-filled CSV (coverage only) passes and Lip Sync is forced NO
  const fill = r => {
    const o = { ...r };
    const e = Number(r.Energy);
    o.Emotion = 'driving focus — heads down; full force';
    o.Subject = r.Lyric ? 'Band' : 'Stage';
    o['Shot Size'] = r.Lyric ? 'WS' : 'EWS';
    o.Angle = r.Lyric ? 'eye level' : 'high';
    o['Camera Movement'] = e <= 3 ? 'locked' : e <= 6 ? 'dolly left' : 'orbit';
    o.Action = r.Lyric
      ? 'Pianist left, Drummer behind, Guitarist right hit the downbeat'
      : 'Lights sweep the empty stage';
    o['Vocal Delivery'] = r.Lyric ? 'yearning — full voice' : '';
    return o;
  };
  // vary Shot Size a little so no two adjacent rows repeat size+angle
  const filled = rows.map((r, i) => {
    const o = fill(r);
    if (r.Lyric && i % 2) ((o['Shot Size'] = 'MS'), (o.Angle = '3/4'));
    return o;
  });
  const good = validateFilled(rows, rowsToCsv(filled), 'nhanh');
  assert.ok(good.ok, 'a valid coverage CSV passes: ' + JSON.stringify(good.errors));
  assert.ok(
    good.rows.every(r => r['Lip Sync'] === 'NO'),
    'Lip Sync forced NO (luồng B is cut by the tool)',
  );

  // a bad CSV flags: changed locked col, singer-to-camera, missing Vocal Delivery, bad camera, band w/o names
  const bad = filled.map(r => ({ ...r }));
  const lyr = bad.find(r => r.Lyric);
  lyr.Energy = '99'; // locked column changed
  lyr.Subject = 'Singer';
  lyr['Shot Size'] = 'CU';
  lyr.Angle = 'eye level'; // singer to camera → belongs to luồng B
  lyr['Vocal Delivery'] = ''; // missing
  lyr['Camera Movement'] = 'handheld'; // not valid for its energy band on a slow song
  const other = bad.find(r => r.Lyric && r !== lyr);
  if (other) ((other.Subject = 'Band'), (other.Action = 'the group plays')); // no musician named
  const res = validateFilled(rows, rowsToCsv(bad), 'cham');
  assert.ok(!res.ok, 'the bad CSV is rejected');
  const reasons = res.errors.map(e => e.loi).join(' | ');
  assert.match(reasons, /Energy bị đổi|cột Energy/);
  assert.match(reasons, /ca sĩ hát vào ống kính/);
  assert.match(reasons, /Vocal Delivery trống/);
  assert.match(reasons, /hàng Band nên gọi tên/);
  // the coerced CSV is always importable: the singer row was turned away from the lens
  assert.ok(!res.ok && res.csv.includes(',rear,'), 'the singer-to-camera row was coerced to rear');
  // the locked column is restored in the returned CSV
  assert.ok(res.csv.includes(rows.find(r => r.Lyric).Energy + ''), 'locked Energy restored');

  // extractCsv pulls the fenced block, ignoring prose around it
  const block = 'Tóm tắt...\n```csv\n' + rowsToCsv(rows.slice(0, 2)) + '\n```\nxong';
  assert.ok(extractCsv(block).startsWith('Shot,Start,End'), 'the csv block is extracted');
  assert.throws(() => extractCsv('no csv here'), /không trả về khối CSV/);
}

// --- Unit: YouTube id + watch-page parsing, and the analysis JSON extractor ---
assert.equal(youTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.equal(youTubeId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');
assert.equal(youTubeId('https://www.youtube.com/shorts/abcdEFGHijk'), 'abcdEFGHijk');
assert.equal(youTubeId('https://example.com/not-youtube'), '');

const sampleHtml =
  '<html><head><meta name="title" content="Tên Bài Hát &amp; Nghệ Sĩ">' +
  '<title>Ignored - YouTube</title></head><body>' +
  'var x = {"videoDetails":{"lengthSeconds":"213","title":"other"}};</body></html>';
const meta = extractYouTubeMeta(sampleHtml);
assert.equal(meta.lengthSeconds, 213, 'lengthSeconds parsed from the watch page');
assert.equal(
  meta.title,
  'Tên Bài Hát & Nghệ Sĩ',
  'title from <meta name="title">, entities decoded',
);
// Falls back to the <title> tag (minus the " - YouTube" suffix) when no meta title exists.
const meta2 = extractYouTubeMeta('<title>Chỉ Có Title - YouTube</title>');
assert.equal(meta2.title, 'Chỉ Có Title');
assert.equal(meta2.lengthSeconds, 0);

// parseMusicAnalysis tolerates a ```json fence and surrounding prose; rejects non-JSON.
const wrapped =
  'Kết quả:\n```json\n' + JSON.stringify({ title: 'X', durationSec: 10 }) + '\n```\nxong';
assert.equal(parseMusicAnalysis(wrapped).title, 'X');
assert.equal(parseMusicAnalysis(wrapped).durationSec, 10);
assert.throws(() => parseMusicAnalysis('không có json ở đây'), /thông số bài hát/);
assert.throws(
  () => parseMusicAnalysis('[1,2,3]'),
  /thông số bài hát/,
  'a bare array is not analysis',
);

// --- Unit: CSV parsing + shot-list / lyric-timing mapping (real columns from the user's export) ---
assert.equal(parseTime('00:00.000'), 0);
assert.equal(Number(parseTime('05:22.414').toFixed(3)), 322.414, 'mm:ss.mmm → seconds');
assert.equal(parseTime('1:02:03.5'), 3723.5, 'h:mm:ss.mmm supported');
assert.equal(parseTime('8.15'), 8.15, 'plain seconds');
assert.equal(parseTime('abc'), null);

// A quoted field with a comma must stay one field.
const csvQuoted = parseCsv('A,B\n1,"x, y"\n2,z');
assert.equal(csvQuoted.length, 2);
assert.equal(csvQuoted[0].B, 'x, y', 'comma inside quotes kept');
assert.equal(csvQuoted[1].B, 'z');

const SHOT_CSV =
  'Shot,Start,End,Duration_s,Section,Exact Lyric,Vocal,Lip Sync,Energy,Subject,Shot Size,Angle,Lens,Camera Movement,Visual Action,Emotional Purpose,Cut Motivation\n' +
  '001,00:00.000,00:08.150,8.15,Spoken Intro,instrumental intro,instrumental/no vocal,NO,2,Stage,EWS,front high,35mm,locked,Empty candlelit opera stage,absence,opening hush\n' +
  '002,00:08.150,00:17.438,9.288,Spoken Intro,Hubo un tiempo en que hablaba con Dios todos los días.,spoken,YES,2,Singer,MCU,3/4,85mm,very slow push,Singer speaks softly,confession,first narration\n' +
  '026,02:03.470,02:07.470,4.0,Chorus 1,Aunque fui yo quien se alejó.,sung,YES,8,Singer,CU,3/4,85mm,push-in,Delivers title line,mercy,vocal hook\n' +
  '031,02:22.470,02:27.720,5.25,Chorus 1,"Solo encontró mi corazón cansado y me enseñó,",sung,NO,8,Audience,CU,front,85mm,locked,Tearful listener reacts,recognition,emotional accent';
const shotRows = parseCsv(SHOT_CSV);
assert.equal(shotRows.length, 4);
assert.equal(detectCsvKind(Object.keys(shotRows[0])), 'shots', 'detected as a shot list');
const shots = rowsToShots(shotRows);
assert.equal(shots.length, 4);
// Instrumental row: no lyric, so no lip-sync line in the prompt.
assert.equal(shots[0].lyric, '', 'instrumental row carries no lyric');
assert.ok(!/mouth articulates/.test(shots[0].videoPrompt));
assert.match(shots[0].videoPrompt, /Stage\. EWS shot, front high angle, 35mm lens, locked/);
// Exact timing is preserved.
assert.equal(shots[1].start, 8.15);
assert.equal(shots[1].duration, 9.288);
assert.equal(shots[1].lyric, 'Hubo un tiempo en que hablaba con Dios todos los días.');
// A lip-sync sung line → the mouth-articulates instruction, with the exact words.
assert.match(shots[2].videoPrompt, /mouth articulates the line: "Aunque fui yo quien se alejó\."/);
assert.equal(shots[2].lipSync, true);
// A non-lip-sync insert over vocals: the lyric is kept (for SRT) but NOT lip-synced.
assert.equal(shots[3].lyric, 'Solo encontró mi corazón cansado y me enseñó,', 'quoted comma kept');
assert.ok(!/mouth articulates/.test(shots[3].videoPrompt), 'insert shot is not lip-synced');
assert.equal(shots[3].subject, 'Audience');
assert.equal(shots[0].name, 'Shot 001 — Spoken Intro');

// Lyric-timing CSV → sections.
const LYRIC_CSV =
  'Start,End,Duration_s,Section,Exact Lyric,Delivery\n' +
  '00:00.000,00:08.150,8.15,Spoken Intro,instrumental intro,spoken\n' +
  '00:08.150,00:17.438,9.288,Spoken Intro,Hubo un tiempo,spoken';
const lyricRows = parseCsv(LYRIC_CSV);
assert.equal(detectCsvKind(Object.keys(lyricRows[0])), 'lyrics', 'detected as lyric timing');
const sections = rowsToSections(lyricRows);
assert.equal(sections.length, 2);
assert.equal(sections[1].startSec, 8.15);
assert.equal(sections[1].lyric, 'Hubo un tiempo');
assert.equal(sections[1].note, 'spoken', 'delivery kept as the section note');

// Consolidation: short consecutive beats merge into ~8s shots (merged "shot ghép").
const SHORT_CSV =
  'Shot,Start,End,Duration_s,Section,Exact Lyric,Vocal,Lip Sync,Energy,Subject,Shot Size,Angle,Lens,Camera Movement,Visual Action,Emotional Purpose,Cut Motivation\n' +
  '025,02:00.070,02:03.470,3.4,Chorus 1,Dios no cerró la puerta.,sung + choir,NO,8,Stage,Wide,front,35mm,crane-in,Band and candle field open up,revelation,downbeat\n' +
  '026,02:03.470,02:07.470,4.0,Chorus 1,Aunque fui yo quien se alejó.,sung,YES,8,Singer,CU,3/4,85mm,push-in,Delivers title line,mercy,hook\n' +
  '027,02:07.470,02:11.470,4.0,Chorus 1,"Cuando pensé que era demasiado tarde,",sung,NO,8,Ensemble,Wide,left 3/4,35mm,tracking,Piano strings and singer,return,lift\n' +
  '028,02:11.470,02:14.970,3.5,Chorus 1,todavía me estaba esperando Dios.,sung,YES,8,Singer,MCU,front,50mm,slow orbit,Voice rises,late fear,peak\n' +
  '029,02:14.970,02:15.970,1.0,Chorus 1,,instrumental/no vocal,NO,8,Pianist,CU,side,85mm,slider,Chord lands,grace,accent';
const perRow = rowsToShots(parseCsv(SHORT_CSV));
assert.equal(perRow.length, 5);
const merged = groupShots(perRow, 8);
// A merged coverage shot never exceeds 8 s (Veo's take), so the clip fills its whole slot.
// 3.4+4.0 = 7.4; a third 4.0 beat would overshoot 8 → close bundle 1 (025–026). 4.0+3.5 = 7.5;
// +1.0 = 8.5 > 8 → close bundle 2 (027–028); the trailing 1.0 s beat (029) is its own shot.
assert.equal(merged.length, 3, '5 beats → 3 merged shots (none over 8 s)');
assert.equal(merged[0].start, 120.07, 'merged shot starts at the first beat');
assert.equal(merged[0].duration, 7.4, 'merged shot stays near ~8s instead of overshooting');
assert.equal(merged[1].duration, 7.5);
assert.equal(merged[2].duration, 1.0, 'the trailing sliver is its own shot, not a 8.5 s merge');
assert.ok(
  merged.every(s => s.duration <= 8.001),
  'no coverage shot longer than 8 s (one Veo take)',
);
assert.equal(merged[0].name, 'Shot 025–026 — Chorus 1');
assert.equal(merged[0].beats, 2);
assert.equal(
  merged[0].lyric,
  'Dios no cerró la puerta. Aunque fui yo quien se alejó.',
  'merged lyric = the beats in order',
);
assert.equal(merged[0].subject, 'Singer', 'dominant subject = the lip-sync beat (for auto-wire)');
assert.match(merged[0].videoPrompt, /7-second continuous music-video sequence, cut across 2 beats/);
assert.match(
  merged[0].videoPrompt,
  /Beat 2 \(~4s, high energy\): Singer — CU shot, 3\/4 angle, 85mm lens/,
  'each beat carries the music energy of its row (8 → high)',
);
assert.match(merged[0].videoPrompt, /lip-syncing: "Aunque fui yo quien se alejó\."/);
assert.ok(
  !/Beat 1[^.]*lip-syncing/.test(merged[0].videoPrompt),
  'non-lip-sync beat not lip-synced',
);
// Contiguity: the next merged shot starts where the previous ends.
assert.equal(
  Number((merged[0].start + merged[0].duration).toFixed(3)),
  merged[1].start,
  'no gap between merged shots',
);
// target 0 → no consolidation.
assert.equal(groupShots(perRow, 0).length, 5, 'target 0 keeps one shot per row');
// A tiny trailing sliver (< 2s) folds into the previous bundle while the total stays within one
// clip (≤ 8 s): 6 + 1 = 7 s folds; a sliver that would push past 8 s stays its own shot.
const sliver = groupShots(
  [
    { ...perRow[1], start: 0, duration: 6 },
    { ...perRow[4], start: 6, duration: 1 },
  ],
  8,
);
assert.equal(sliver.length, 1, 'a <2s tail folds into the previous shot');
assert.equal(sliver[0].duration, 7);

// A storyboard imported before beats carried their timing (parts = framing only) gets its beats
// back from the same CSV by time — whatever the merge target was.
const oldShot = {
  start: 120.07,
  duration: 7.4,
  parts: [{ subject: 'Stage', shotSize: 'Wide' }, { subject: 'Singer' }],
};
const restored = beatsFor(oldShot, perRow);
assert.equal(restored.length, 2, 'rows 025 + 026 fall inside the shot');
assert.equal(restored[1].lipSync, true);
assert.equal(restored[1].lyric, 'Aunque fui yo quien se alejó.');
assert.equal(restored[1].start, 123.47, 'each beat gets its own time back');
assert.equal(restored[1].duration, 4);
assert.equal(beatsFor({ start: 120.07, duration: 8.5 }, perRow), null, 'rows that do not fill it');
assert.equal(beatsFor({ start: 10, duration: 8 }, perRow), null, 'another CSV');

// Re-timing the CSV to the vocal: each sung row moves to where its line is really sung (the GPU
// reading), the rows keep tiling the song, and unsung rows share what is left.
const RETIME_CSV =
  'Shot,Start,End,Duration_s,Section,Exact Lyric,Vocal,Lip Sync,Energy,Subject,Shot Size,Angle,Lens,Camera Movement,Visual Action,Emotional Purpose,Cut Motivation\n' +
  '001,00:00.000,00:04.000,4.0,Intro,instrumental intro,instrumental/no vocal,NO,2,Stage,EWS,front,35mm,locked,Empty stage,x,x\n' +
  '002,00:04.000,00:08.000,4.0,Verse,Line one,sung,YES,4,Singer,MCU,3/4,85mm,push,Sings,x,x\n' +
  '003,00:08.000,00:12.000,4.0,Verse,Line two,sung,YES,4,Singer,CU,front,85mm,locked,Sings,x,x\n' +
  '004,00:12.000,00:14.000,2.0,Break,,instrumental/no vocal,NO,4,Pianist,CU,side,85mm,slider,Keys,x,x\n' +
  '005,00:14.000,00:20.000,6.0,Verse,Line three,sung,NO,4,Audience,CU,front,85mm,locked,Listens,x,x';
const csvRows = rowsToShots(parseCsv(RETIME_CSV));
// where the vocal has the three lines: line one 2 s later than the CSV says
const sung = [null, { start: 6, end: 9, score: 0.9 }, { start: 9.6, end: 12.5, score: 0.4 }, null];
sung.push({ start: 15.2, end: 19, score: 0.8 });
const re = retimeRows(csvRows, sung, 21);
const cuts = re.map(r => r.start);
// intro → line one: LEAD before the voice; one → two: LEAD into a 0.6 s breath; two → break: TAIL
// after the voice; break → three: LEAD before it; the last row runs to the end of the song.
assert.deepEqual(cuts, [0, 6 - LEAD, 9.6 - LEAD, 12.5 + TAIL, 15.2 - LEAD]);
assert.equal(Number((re[4].start + re[4].duration).toFixed(3)), 21, 'tiles to the song length');
for (let i = 1; i < re.length; i++)
  assert.equal(
    Number((re[i - 1].start + re[i - 1].duration).toFixed(3)),
    re[i].start,
    'no gap, no overlap',
  );
for (const i of [1, 2, 4])
  assert.ok(
    re[i].start <= sung[i].start && re[i].start + re[i].duration >= sung[i].end,
    `row ${i + 1} holds its whole line`,
  );
assert.equal(re[1].csvStart, 4, 'the CSV time is remembered');
assert.equal(re[1].csvDuration, 4);
assert.equal(re[1].sungStart, 6);
assert.equal(re[2].alignScore, 0.4);
assert.equal(re[0].sungStart, null, 'an instrumental row has no sung time');
assert.equal(re[1].lyric, 'Line one', 'the row keeps what it shows');
assert.equal(re[1].subject, 'Singer');
// Lines that overlap (a held note under the next line): the cut lands between them.
const overlap = retimeRows(
  csvRows.slice(1, 3),
  [
    { start: 1, end: 5.2, score: 0.9 },
    { start: 5, end: 8, score: 0.9 },
  ],
  9,
);
assert.equal(overlap[1].start, 5.1);
// Unsung rows between two lines share the gap in proportion to their CSV lengths (2 s : 4 s).
const between = retimeRows(
  [csvRows[1], { ...csvRows[3], duration: 2 }, { ...csvRows[3], duration: 4 }, csvRows[2]],
  [{ start: 1, end: 3, score: 0.9 }, null, null, { start: 11, end: 13, score: 0.9 }],
  14,
);
assert.equal(between[1].start, 3 + TAIL);
assert.equal(between[2].start, Number((3 + TAIL + ((11 - LEAD - 3 - TAIL) * 2) / 6).toFixed(3)));
assert.equal(between[3].start, 11 - LEAD);
// An unsung row the CSV put between two lines that are really sung back to back (0.2 s apart) has
// no room: it is dropped, and the next line's row still opens before its voice (at the middle of
// the breath) instead of being pushed after it.
const squeezedOut = retimeRows(
  [csvRows[1], csvRows[3], csvRows[2]],
  [{ start: 1, end: 3, score: 0.9 }, null, { start: 3.2, end: 5, score: 0.9 }],
  6,
);
assert.deepEqual(
  squeezedOut.map(r => [r.shot, r.start, r.duration]),
  [
    ['002', 0, 3.1],
    ['003', 3.1, 2.9],
  ],
);
assert.ok(squeezedOut[1].start <= squeezedOut[1].sungStart, 'the line keeps its first word');
// Lines read on top of each other never make a row shorter than MIN_ROW.
const squeezed = retimeRows(
  csvRows.slice(1, 4),
  [
    { start: 5, end: 5.1, score: 0.9 },
    { start: 5.1, end: 5.15, score: 0.9 },
    { start: 5.15, end: 5.2, score: 0.9 },
  ],
  10,
);
assert.ok(
  squeezed.every(r => r.duration >= MIN_ROW - 0.001),
  'every row ≥ MIN_ROW: ' + squeezed.map(r => r.duration),
);
assert.equal(Number(squeezed.reduce((a, r) => a + r.duration, 0).toFixed(3)), 10);

// The standard MV shot list (what the master prompt writes): the performer's emotion and the set
// of each row reach the prompts; a change of set always cuts the merged clips.
assert.ok(DEEP_MUSIC_ANALYSIS_PROMPT.includes(SHOT_LIST_HEADER), 'the prompt pins the header');
// … and what it writes is the COVERAGE stream (luồng A) alone: the tool cuts the singer's lip-sync
// takes itself, so every row is NO, every row names its set, and a Band row names its musicians.
assert.match(DEEP_MUSIC_ANALYSIS_PROMPT, /LUỒNG A/, 'the prompt says which stream it writes');
assert.match(DEEP_MUSIC_ANALYSIS_PROMPT, /Lip Sync: LUÔN là NO/);
assert.match(DEEP_MUSIC_ANALYSIS_PROMPT, /Location: BẮT BUỘC điền ở MỌI hàng/);
assert.match(DEEP_MUSIC_ANALYSIS_PROMPT, /CÔNG THỨC PHỦ CẢNH/, 'the coverage recipe is in it');
const STD_CSV =
  SHOT_LIST_HEADER +
  '\n' +
  '001,00:00.000,00:03.000,Intro,,NO,2,"stillness — cold air",Stage,Main stage,EWS,high,locked,Candles flicker on the empty stage\n' +
  '002,00:03.000,00:06.000,Verse 1,"Hubo un tiempo, hablaba con Dios.",YES,3,"quiet guilt — eyes lowered, jaw tight; breathy",Singer,Main stage,MCU,3/4,slow push-in,Singer steps to the mic\n' +
  '003,00:06.000,00:09.000,Verse 1,Yo conocía bien aquel camino.,NO,4,"memory — soft focus",Pianist,Balcony,CU,profile,dolly left,Hands answer the phrase\n' +
  '004,00:09.000,00:12.000,Verse 1,Sabía dónde encontrar su paz.,YES,4,"longing — eyes up; held note",Singer,Balcony,CU,eye level,orbit,Singer turns toward the light\n' +
  '005,00:12.000,00:13.000,Outro,,NO,2,"afterglow",Stage,Main stage,WS,rear,pull-out,Lights fade';
const stdRows = parseCsv(STD_CSV);
assert.equal(detectCsvKind(Object.keys(stdRows[0])), 'shots');
const std = rowsToShots(stdRows);
assert.equal(std.length, 5);
assert.equal(std[0].lyric, '', 'an empty Lyric cell is an instrumental row');
assert.equal(std[1].lyric, 'Hubo un tiempo, hablaba con Dios.');
assert.equal(std[1].lipSync, true);
assert.equal(std[1].emotion, 'quiet guilt — eyes lowered, jaw tight; breathy');
assert.equal(std[2].location, 'Balcony');
assert.equal(
  std[1].videoPrompt.split(' The performer')[0],
  'Singer at Main stage. MCU shot, 3/4 angle, slow push-in. Singer steps to the mic. Emotion: quiet guilt — eyes lowered, jaw tight; breathy. Calm energy.',
);
assert.match(
  std[1].videoPrompt,
  /mouth articulates the line: "Hubo un tiempo, hablaba con Dios\."/,
);
// 3 s rows toward 8 s: rows 1–2 would take row 3 (9 s is nearer 8 than 6 s) — but row 3 is on
// the balcony, so the clip cuts there; the 1 s tail back on the main stage stays its own clip.
const bySet = groupShots(std, 8);
assert.deepEqual(
  bySet.map(s => s.shot),
  ['001–002', '003–004', '005'],
);
assert.match(bySet[0].videoPrompt, /^6-second continuous music-video sequence at Main stage, cut/);
assert.match(
  bySet[0].videoPrompt,
  /Beat 2 \(~3s, calm energy\): Singer — MCU shot.*; emotion: quiet guilt — eyes lowered, jaw tight; breathy/,
);
// the opening still shows the face of the emotion, not how the line is sung
assert.match(bySet[0].stillPrompt, /expression: stillness — cold air\. Hold/);
assert.equal(
  faceOf('quiet guilt — eyes lowered, jaw tight; breathy.'),
  'quiet guilt — eyes lowered, jaw tight',
);
assert.match(
  bySet[1].stillPrompt,
  /Pianist at Balcony, CU shot, profile angle, Hands answer the phrase, expression: memory — soft focus/,
);
assert.deepEqual(
  bySet[1].parts.map(p => [p.location, p.emotion]),
  [
    ['Balcony', 'memory — soft focus'],
    ['Balcony', 'longing — eyes up; held note'],
  ],
);
// The cast step designs one scene per Location, keyed by its name, the first one the main set.
const brief = castBrief('Dios', std);
assert.match(brief, /- main_stage \(role "scene"\): Main stage — .*\(bối cảnh chính\)/);
assert.match(brief, /- balcony \(role "scene"\): Balcony — /);
assert.match(brief, /uses: singer \+ main_stage/);
assert.ok(!/- stage \(role "scene"\)/.test(brief), 'no generic stage when the sets are named');
assert.match(brief, /- pianist \(role "character"\)/);
// A set named twice in different case is one set.
assert.equal(
  (
    castBrief('X', [{ location: 'Main stage' }, { location: 'main Stage' }]).match(
      /role "scene"/g,
    ) || []
  ).length,
  1,
);
// Players: named in the Subject (a player also by the instrument), or as a person in the Action —
// an instrument only glimpsed in a singer's shot brings no one; in a band shot it does.
const castOf = parts =>
  [...castBrief('X', parts).matchAll(/^- (\w+) \(role "character"\)/gm)].map(m => m[1]);
assert.deepEqual(castOf([{ subject: 'Singer', action: 'Light glints off the piano lid' }]), [
  'singer',
]);
assert.deepEqual(castOf([{ subject: 'Piano keys', action: 'A chord lands' }]), ['pianist']);
assert.deepEqual(castOf([{ subject: 'Singer', action: 'The guitarist steps in beside her' }]), [
  'singer',
  'guitarist',
]);
assert.deepEqual(castOf([{ subject: 'Band', action: 'Piano and drums kick in' }]), [
  'pianist',
  'drummer',
]);

// A row with no words to sing: empty, a bracketed placeholder or dashes; a hyphenated header still
// reads ("Lip-Sync").
const odd = rowsToShots(
  parseCsv(
    'Shot,Start,End,Lyric,Lip-Sync,Subject,Shot Size\n' +
      '1,0,2,[Instrumental],NO,Band,WS\n' +
      '2,2,4,(nhạc dạo),NO,Band,WS\n' +
      '3,4,6,—,NO,Band,WS\n' +
      '4,6,8,Dios no cerró la puerta.,YES,Singer,CU',
  ),
);
assert.deepEqual(
  odd.map(r => r.lyric),
  ['', '', '', 'Dios no cerró la puerta.'],
);
// … but a sung line with ad-libs in brackets keeps its words; "No vocal …" is no line.
assert.deepEqual(
  rowsToShots(
    parseCsv(
      'Shot,Start,End,Lyric,Subject,Shot Size\n1,0,2,(Ay) te quiero tanto (ay),Singer,CU\n2,2,4,No vocal — strings swell,Band,WS',
    ),
  ).map(r => r.lyric),
  ['(Ay) te quiero tanto (ay)', ''],
);
assert.equal(odd[3].lipSync, true, '"Lip-Sync" header read');
// A Shot number used twice gets a letter: it keys the row's keyframe, take and GPU reading.
const twice = rowsToShots(
  parseCsv(
    'Shot,Start,End,Section,Subject,Shot Size\n005,0,2,Verse,Singer,CU\n005,2,4,Verse,Pianist,CU',
  ),
);
assert.deepEqual(
  twice.map(r => [r.shot, r.name]),
  [
    ['005', 'Shot 005 — Verse'],
    ['005b', 'Shot 005b — Verse'],
  ],
);
// … never one the CSV already uses
assert.deepEqual(
  rowsToShots(
    parseCsv('Shot,Start,End,Subject,Shot Size\n5,0,1,A,CU\n5,1,2,B,CU\n5b,2,3,C,CU'),
  ).map(r => r.shot),
  ['5', '5c', '5b'],
);

// Rows longer than a video model films (MAX_ROW = 8 s) are cut. A re-timed sung row that also
// holds the instrumental gap after its line: the first piece keeps the line (to TAIL after the
// voice), the gap is split into even pieces with no line.
const long = splitLong([
  {
    ...std[1],
    start: 100,
    duration: 14.5,
    sungStart: 100.25,
    sungEnd: 104,
    alignScore: 0.9,
  },
  { ...std[0], start: 114.5, duration: 10 },
  { ...std[3], start: 124.5, duration: 9, sungEnd: undefined },
  { ...std[3], start: 133.5, duration: 9, sungStart: 133.75, sungEnd: 140.5 },
]);
assert.deepEqual(
  long.map(r => [r.shot, r.start, r.duration, !!r.lyric]),
  [
    ['002', 100, 7.25, true],
    ['002.2', 107.25, 7.25, false],
    ['001', 114.5, 5, false],
    ['001.2', 119.5, 5, false],
    ['004', 124.5, 9, true],
    ['004', 133.5, 9, true],
  ],
);
assert.equal(long[1].name, 'Shot 002.2 — Verse 1');
assert.equal(long[1].lipSync, false);
assert.ok(!/mouth articulates/.test(long[1].videoPrompt), 'the gap piece sings nothing');
assert.match(long[0].videoPrompt, /mouth articulates/);
// … a sung row not re-timed (where its line ends is unknown) and a remainder under 2 s stay whole.
// The first line of a song whose CSV missed the intro (the row runs from 0, the voice comes at 12 s):
// the intro becomes wordless pieces, the line keeps its own piece.
assert.deepEqual(
  splitLong([{ ...std[1], start: 0, duration: 16.25, sungStart: 12, sungEnd: 16 }]).map(r => [
    r.shot,
    r.start,
    r.duration,
    !!r.lyric,
  ]),
  [
    ['002.2', 0, 5.875, false],
    ['002.3', 5.875, 5.875, false],
    ['002', 11.75, 4.5, true],
  ],
);

// A sliver before a change of set folds into the bundle before it only while the total stays ≤ 8 s;
// here a+b already fill one clip (8 s), so the 1.5 s sliver cannot fold without overshooting and
// stays its own shot (a grouped render still uses its full length).
const sliverSet = groupShots(
  [
    { ...std[1], shot: 'a', duration: 4, location: 'Main stage' },
    { ...std[1], shot: 'b', duration: 4, location: 'Main stage' },
    { ...std[1], shot: 'c', duration: 1.5, location: 'Main stage' },
    { ...std[3], shot: 'd', duration: 4, location: 'Balcony' },
    { ...std[3], shot: 'e', duration: 4, location: 'Balcony' },
  ],
  8,
);
assert.deepEqual(
  sliverSet.map(s => [s.shot, s.duration]),
  [
    ['a–b', 8],
    ['c', 1.5],
    ['d–e', 8],
  ],
);
// A bundle opening on a beat with no Location still cuts when the set changes later on.
assert.deepEqual(
  groupShots(
    [
      { ...std[1], shot: 'n', duration: 2, location: '' },
      { ...std[1], shot: 's', duration: 2, location: 'Church stage' },
      { ...std[1], shot: 'r', duration: 2, location: 'Rooftop' },
      { ...std[1], shot: 'r2', duration: 2, location: 'Rooftop' },
    ],
    8,
  ).map(s => s.shot),
  ['n–s', 'r–r2'],
);
// Small targets: slivers fold only while the bundle stays near one clip (no whole-song bundle).
const tiny = groupShots(
  Array.from({ length: 20 }, (_, i) => ({ ...std[1], shot: 't' + i, duration: 1.9 })),
  3,
);
assert.ok(tiny.length >= 10, 'small bundles: ' + tiny.length);
assert.ok(tiny.every(s => s.duration <= 3.75 + 0.001));
// A short bundle never takes a long beat that would carry it well past one clip (3 + 7.5 > 10).
assert.deepEqual(
  groupShots(
    [
      { ...std[1], shot: 'p', duration: 3 },
      { ...std[1], shot: 'q', duration: 7.5 },
    ],
    8,
  ).map(s => [s.shot, s.duration]),
  [
    ['p', 3],
    ['q', 7.5],
  ],
);

// --- Integration: a real server + a real local LLM ---
const ANALYSIS = {
  title: 'Bài Hát Thử',
  artist: 'Ca Sĩ Thử',
  language: 'vi',
  durationSec: 180,
  bpm: 92,
  timeSignature: '4/4',
  key: 'C minor',
  genre: 'ballad',
  mood: 'melancholic',
  energyCurve: 'low intro, rising chorus, soft outro',
  sections: [
    { name: 'Intro', startSec: 0, endSec: 12, energy: 'low', lyric: '', note: 'instrumental' },
    { name: 'Verse 1', startSec: 12, endSec: 48, energy: 'mid', lyric: 'câu một', note: '' },
    { name: 'Chorus', startSec: 48, endSec: 90, energy: 'high', lyric: 'điệp khúc', note: '' },
  ],
  suggestedShotSeconds: 8,
  suggestedShots: 24,
  styleHints: 'teal-orange cinematic 35mm, soft grain',
  cameraHints: 'slow push-in on verses, wide energy on chorus',
  notes: 'duration from provided length',
};
// What the MV master prompt returns for the cast step: the singer + pianist the storyboard names, the
// stage, a style and cameras, and one throwaway sample shot (the storyboard comes from the CSV).
const MODEL_SHEET =
  ', portrait on left, front, side and back views on right, neutral standing pose, solid gray background, studio lighting, consistent facial identity, cinematic 35mm photorealistic. This is an original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is purely coincidental.';
const CAST_BLUEPRINT = {
  project: { name: 'Bài Hát Thử', theme: 'music' },
  style:
    'Cinematic 35mm, Kodak Vision3 500T, candlelit opera house, warm amber, photorealistic, no CGI.',
  assets: [
    {
      key: 'singer',
      role: 'character',
      name: 'Ca sĩ chính',
      prompt:
        'Character model sheet turnaround of a 45yo Latino male baritone, dark suit' + MODEL_SHEET,
    },
    {
      key: 'pianist',
      role: 'character',
      name: 'Pianist',
      prompt:
        'Character model sheet turnaround of a 60yo male pianist, black tailcoat' + MODEL_SHEET,
    },
    {
      key: 'stage',
      role: 'scene',
      name: 'Nhà hát opera',
      prompt: 'Candlelit opera house stage, wide.',
    },
  ],
  cameras: [{ key: 'wide', name: 'Wide', config: 'Wide establishing shot, 35mm.' }],
  shots: [{ name: 'Mẫu', start: 0, duration: 8, uses: ['singer', 'stage'], camera: 'wide' }],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-music-'));
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
  // The MV master prompt (cast design) gets a blueprint; the music analyzer gets its JSON block.
  // The brief pins the keys the shot list uses, so the cast answers with exactly those: a balcony
  // set (a shot list with a Location column) and a drummer (a shot list that shows one) come along.
  const extra = [];
  if (lastUser.includes('- balcony (role "scene")'))
    extra.push({ key: 'balcony', role: 'scene', name: 'Balcony', prompt: 'Opera balcony, wide.' });
  if (lastUser.includes('- drummer (role "character")'))
    extra.push({
      key: 'drummer',
      role: 'character',
      name: 'Drummer',
      prompt: 'Character model sheet turnaround of a 35yo male drummer, black shirt' + MODEL_SHEET,
    });
  const reply = !lastSystem.includes('ĐẠO DIỄN SẢN XUẤT MV')
    ? ANALYSIS
    : extra.length
      ? { ...CAST_BLUEPRINT, assets: [...CAST_BLUEPRINT.assets, ...extra] }
      : CAST_BLUEPRINT;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' } }],
    }),
  );
});
await new Promise(r => llm.listen(17896, '127.0.0.1', r));
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, MV_PORT: '17897', MV_ORBIT_URL: 'http://127.0.0.1:1', MV_DATA_DIR: dir },
  stdio: 'pipe',
});
async function api(p, method = 'GET', b) {
  const r = await fetch('http://127.0.0.1:17897' + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
const musicNodes = s => s.nodes.filter(n => n.kind === 'music');
try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });

  // Create a MUSIC node — lands in the Âm thanh column, wires to nothing, renders no prompt.
  let r = await api('/api/nodes', 'POST', { kind: 'music' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let node = musicNodes(r.data).at(-1);
  assert.ok(node, 'music node created');
  assert.equal(node.kind, 'music');
  assert.equal(node.zone, 'audio', 'music node lives in the Âm thanh column');
  assert.equal(node.resolvedPrompts.image, '', 'no image prompt');
  assert.equal(node.resolvedPrompts.video, '', 'no video prompt');
  assert.equal(node.analysis, null, 'not analyzed yet');
  const id = node.id;

  // Analyzing with no source at all is rejected.
  await api('/api/director/llm', 'POST', {
    key: 'test-key-1234',
    baseUrl: 'http://127.0.0.1:17896/v1',
    model: 'mock',
  });
  let bad = await api('/api/music/analyze', 'POST', { id, via: 'api' });
  assert.equal(bad.status, 400, 'no link/lyrics/file → rejected');
  assert.match(bad.data.error, /link YouTube|lời|file nhạc/i);

  // The web path needs a worker online (none here).
  bad = await api('/api/music/analyze', 'POST', { id, via: 'web' });
  assert.equal(bad.status, 400, 'web path without a worker → rejected');
  assert.match(bad.data.error, /extension/i);

  // Add lyrics + a name via PATCH, then analyze through the real LLM.
  r = await api('/api/node', 'PATCH', {
    id,
    name: 'Bài Hát Thử',
    youtubeUrl: '',
    lyrics: 'câu một\nđiệp khúc',
  });
  assert.equal(r.status, 200);
  node = r.data.nodes.find(n => n.id === id);
  assert.equal(node.lyrics, 'câu một\nđiệp khúc', 'lyrics saved on the node');

  r = await api('/api/music/analyze', 'POST', { id, via: 'api' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(llmCalls, 1, 'the analyzer called the LLM once');
  assert.match(lastSystem, /PHÂN TÍCH BÀI HÁT/, 'the music master prompt is the system prompt');
  assert.match(lastUser, /câu một/, 'the lyrics are sent to the LLM');
  node = r.data.nodes.find(n => n.id === id);
  assert.ok(node.analysis && node.analysis.json, 'analysis stored on the node');
  assert.equal(node.analysis.json.title, 'Bài Hát Thử');
  assert.equal(node.analysis.json.sections.length, 3, 'sections parsed');
  assert.equal(node.analysis.json.suggestedShots, 24);
  assert.ok(node.analysis.at, 'analysis timestamped');
  // The node had no file duration, so the analysis durationSec anchors it.
  assert.equal(node.audioDuration, 180, 'duration anchored from the analysis');
  // The analysis survives a reload of state.
  node = (await api('/api/state')).data.nodes.find(n => n.id === id);
  assert.equal(node.analysis.json.bpm, 92, 'analysis persisted');

  // Upload a song file onto the node: it is stored as the node's audio with its duration.
  const AUDIO = Buffer.from('ID3 fake mp3 bytes for the test').toString('base64');
  r = await api('/api/upload', 'POST', {
    nodeId: id,
    kind: 'audio',
    name: 'bai-hat.mp3',
    mime: 'audio/mpeg',
    base64: AUDIO,
    duration: 181,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  node = r.data.nodes.find(n => n.id === id);
  assert.ok(node.audio && node.audio.url, 'audio file stored on the music node');
  assert.equal(node.audio.name, 'bai-hat.mp3');
  assert.equal(node.audioDuration, 181, 'file duration recorded on the node');
  // The uploaded file is actually served.
  const got = await fetch('http://127.0.0.1:17897' + node.audio.url);
  assert.equal(got.status, 200, 'the stored audio file is served');
  // The project's sidebar song (db.audio) is untouched by a music-node upload.
  assert.ok(!r.data.audio, 'the music-node upload did not become the project song');

  // A missing node id is a clean error.
  bad = await api('/api/music/analyze', 'POST', { id: 'node-does-not-exist', via: 'api' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /không tồn tại/i);

  // The shot-list master prompt (run outside with the audio, import its CSV): it pins the standard
  // header; for a music node it ends with that song's facts, ready to paste.
  let deep = await api('/api/music/deep-prompt');
  assert.equal(deep.status, 200);
  assert.ok(deep.data.prompt.includes(SHOT_LIST_HEADER), 'pins the standard CSV header');
  assert.ok(!/THÔNG TIN BÀI HÁT \(tool/.test(deep.data.prompt), 'no song: no facts block');
  deep = await api('/api/music/deep-prompt?id=' + id);
  assert.match(deep.data.prompt, /THÔNG TIN BÀI HÁT \(tool điền sẵn\)/);
  assert.match(deep.data.prompt, /TOTAL_DURATION = 03:01\.000 \(= 181 giây\)/, 'the song length');

  // Import a MASTER SHOT LIST CSV → an exactly-timed storyboard. The default music project already
  // has a singer (character zone) and a stage/scene (design zone), so auto-wiring by Subject can
  // connect. replaceShots first clears the template's wide/medium/close shots.
  // Coverage rows tile the song, each ≤ 8 s (one Veo take fills the whole clip).
  const IMPORT_CSV =
    'Shot,Start,End,Duration_s,Section,Exact Lyric,Vocal,Lip Sync,Energy,Subject,Shot Size,Angle,Lens,Camera Movement,Visual Action,Emotional Purpose,Cut Motivation\n' +
    '001,00:00.000,00:05.000,5.0,Spoken Intro,instrumental intro,instrumental/no vocal,NO,2,Stage,EWS,front,35mm,locked,Empty stage,absence,hush\n' +
    '002,00:05.000,00:13.000,8.0,Spoken Intro,"Hubo un tiempo, hablaba con Dios.",spoken,YES,2,Singer,MCU,3/4,85mm,slow push,Singer speaks,confession,narration\n' +
    '003,00:13.000,00:19.362,6.362,Spoken Intro,no vocal,instrumental/no vocal,NO,2,Pianist,CU,side,85mm,slider,Hands on keys,memory,accent';
  r = await api('/api/music/import', 'POST', {
    id,
    csv: IMPORT_CSV,
    replaceShots: true,
    autoWire: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.importSummary.kind, 'shots');
  assert.equal(r.data.importSummary.created, 3, 'three shots created');
  const built = r.data.nodes.filter(n => n.zone === 'production' && !n.terminal);
  assert.equal(built.length, 3, 'exactly the imported shots in the production column');
  const byStart = [...built].sort((a, b) => a.start - b.start);
  assert.equal(byStart[0].start, 0);
  assert.equal(byStart[0].duration, 5.0, 'exact duration imported');
  assert.equal(byStart[1].lyric, 'Hubo un tiempo, hablaba con Dios.', 'lyric with comma kept');
  assert.match(byStart[1].resolvedPrompts.video, /mouth articulates/, 'lip-sync shot articulates');
  assert.equal(byStart[2].lyric, '', 'non-vocal shot has no lyric');
  // Auto-wire by Subject: the "Singer" shot connects to a character-zone node, the "Stage" shot to
  // a design-zone (scene) node; the "Pianist" insert has no match and stays unwired.
  const parentsOf = nid => r.data.edges.filter(e => e.target === nid).map(e => e.source);
  const charZone = new Set(r.data.nodes.filter(n => n.zone === 'character').map(n => n.id));
  const designZone = new Set(r.data.nodes.filter(n => n.zone === 'design').map(n => n.id));
  assert.ok(
    parentsOf(byStart[1].id).some(pid => charZone.has(pid)),
    'Singer shot auto-wired to a character',
  );
  assert.ok(
    parentsOf(byStart[0].id).some(pid => designZone.has(pid)),
    'Stage shot auto-wired to a scene',
  );
  assert.ok(r.data.importSummary.wired >= 2, 'at least two shots auto-wired');
  // Like the MV blueprint: the singer shot also sits in the main stage, and the project style is
  // wired into every imported shot (the camera preset is not — each beat names its own framing).
  assert.ok(
    parentsOf(byStart[1].id).some(pid => designZone.has(pid)),
    'Singer shot also wired to the stage (environment continuity)',
  );
  assert.equal(r.data.importSummary.style, true, 'the project style was wired');
  for (const s of built) {
    assert.ok(parentsOf(s.id).includes('style'), `style wired into ${s.name}`);
    assert.match(
      s.resolvedPrompts.video,
      /Style: Cinematic concert film/,
      'style reaches the prompt',
    );
    assert.ok(!parentsOf(s.id).includes('camera'), 'camera preset not wired over the CSV framing');
  }
  // Order of image references: the subject first, then the stage → [1] singer, [2] stage.
  const singerRefs = parentsOf(byStart[1].id).filter(pid => pid !== 'style');
  assert.ok(charZone.has(singerRefs[0]), 'reference [1] is the performer');
  assert.ok(designZone.has(singerRefs[1]), 'reference [2] is the stage');

  // A merged multi-beat shot (consolidated to ~8s): every performer it shows is a reference, the
  // video runs from those references ("refs"), and its keyframe prompt is the opening beat.
  const MULTI_CSV =
    'Shot,Start,End,Duration_s,Section,Exact Lyric,Vocal,Lip Sync,Energy,Subject,Shot Size,Angle,Lens,Camera Movement,Visual Action,Emotional Purpose,Cut Motivation\n' +
    '020,00:00.000,00:02.901,2.901,Pre-Chorus,la distancia se volvió normal.,sung,NO,6,Pianist,CU,3/4,85mm,push,Hands on the keys,distance,cadence\n' +
    '021,00:02.901,00:07.453,4.552,Pre-Chorus,Hasta que una noche quise volver a hablar,sung,YES,6,Singer,Medium,3/4,50mm,push-in,Turns toward the auditorium,return,rise\n' +
    '022,00:07.453,00:07.953,0.5,Pre-Chorus,y pensé:,sung,NO,6,Microphone,Macro,side,100mm,locked,Breath at the grille,fear,breath';
  r = await api('/api/music/import', 'POST', {
    id,
    csv: MULTI_CSV,
    replaceShots: true,
    autoWire: true,
    targetSeconds: 8,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.importSummary.rows, 3);
  assert.equal(r.data.importSummary.created, 1, '3 beats (7.95s) → 1 merged shot');
  const ms = r.data.nodes.find(n => n.zone === 'production' && !n.terminal);
  assert.equal(ms.name, 'Shot 020–022 — Pre-Chorus');
  assert.equal(ms.duration, 7.953);
  assert.equal(ms.beats, 3);
  assert.equal(ms.videoInput, 'refs', 'merged shot films from the performers’ references');
  assert.equal(
    ms.lyric,
    'la distancia se volvió normal. Hasta que una noche quise volver a hablar y pensé:',
  );
  assert.match(
    ms.resolvedPrompts.image,
    /the opening frame — Pianist, CU shot/,
    'keyframe = beat 1',
  );
  assert.match(ms.resolvedPrompts.video, /cut across 3 beats/);
  assert.match(
    ms.resolvedPrompts.video,
    /lip-syncing: "Hasta que una noche quise volver a hablar"/,
  );
  const msParents = r.data.edges.filter(e => e.target === ms.id).map(e => e.source);
  assert.ok(
    msParents.some(pid => charZone.has(pid)),
    'the singer of beat 2 is a reference (identity kept)',
  );
  assert.ok(
    msParents.some(pid => designZone.has(pid)),
    'the stage is a reference (environment kept)',
  );

  // Cast design with the MV master prompt: the storyboard's performers + stage become designed
  // assets merged into the graph (shots kept), template placeholders give way, shots re-wire.
  const callsBefore = llmCalls;
  r = await api('/api/music/cast', 'POST', { id, via: 'api' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(llmCalls, callsBefore + 1, 'one LLM turn for the cast');
  assert.match(lastSystem, /ĐẠO DIỄN SẢN XUẤT MV/, 'the MV master prompt designs the cast');
  assert.match(lastUser, /- singer \(role "character"\)/, 'the brief pins the singer key');
  assert.match(lastUser, /- pianist \(role "character"\)/, 'the brief pins the pianist key');
  assert.match(lastUser, /- stage \(role "scene"\)/, 'the brief pins the stage key');
  assert.match(lastUser, /Hands on the keys/, 'the storyboard visual cues reach the brief');
  const c = r.data.castSummary;
  assert.equal(c.characters, 2, 'singer + pianist designed');
  assert.equal(c.scenes, 1, 'the stage designed');
  assert.equal(c.style, 'updated', 'the MV style replaces the template style text');
  assert.ok(c.removedPlaceholders >= 2, 'untouched template singer/stage placeholders removed');
  assert.equal(c.rewired, 1, 'the CSV shot re-wired');
  const castState = r.data;
  const key = k => castState.nodes.find(n => n.assetKey === k);
  assert.ok(key('singer') && key('pianist') && key('stage'), 'designed assets in the graph');
  assert.equal(key('singer').zone, 'character');
  assert.equal(key('stage').zone, 'design');
  assert.ok(!castState.nodes.some(n => n.id === 'singer'), 'template singer placeholder gone');
  assert.ok(
    castState.nodes.some(n => n.id === id && n.kind === 'music'),
    'the music node is kept',
  );
  const shotsAfter = castState.nodes.filter(n => n.zone === 'production' && !n.terminal);
  assert.equal(shotsAfter.length, 1, 'the CSV storyboard is kept (the sample shot was dropped)');
  assert.equal(shotsAfter[0].id, ms.id);
  const castParents = castState.edges.filter(e => e.target === ms.id).map(e => e.source);
  assert.deepEqual(
    castParents.filter(pid => pid !== 'style'),
    [key('pianist').id, key('singer').id, key('stage').id],
    'shot re-wired to the designed cast in beat order (pianist, singer), then the stage',
  );
  assert.ok(castParents.includes('style'), 'style still wired');
  const castStyle = castState.nodes.find(n => n.id === 'style');
  assert.match(castStyle.config, /candlelit opera house/, 'style text is the MV look');
  const msNow = castState.nodes.find(n => n.id === ms.id);
  assert.match(
    msNow.resolvedPrompts.video,
    /^Reference subjects, in the order of the attached images: \[1\] Pianist; \[2\] Ca sĩ chính; \[3\] the stage/,
    'the video prompt names the designed cast in order',
  );
  assert.match(msNow.resolvedPrompts.video, /Style: Cinematic 35mm, Kodak Vision3 500T/);
  // Running the cast again keeps the assets the project already has (and their images).
  r = await api('/api/music/cast', 'POST', { id, via: 'api' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.castSummary.added, 0, 'second run adds nothing');
  assert.equal(r.data.castSummary.kept, 3, 'the three assets are kept by key');
  assert.equal(r.data.nodes.filter(n => n.assetKey === 'singer').length, 1, 'no duplicate singer');

  // Re-import with replaceShots clears the old shots (no duplication).
  r = await api('/api/music/import', 'POST', {
    id,
    csv: IMPORT_CSV,
    replaceShots: true,
    autoWire: false,
  });
  assert.equal(
    r.data.nodes.filter(n => n.zone === 'production' && !n.terminal).length,
    3,
    'replaceShots avoids duplicating the storyboard',
  );

  // Subtitles build straight from the imported shots' lyrics. With no lip-sync takes yet, the
  // track comes from luồng A (the production column) and says so.
  let srtRes = await fetch('http://127.0.0.1:17897/api/director/subtitles.srt');
  let srt = await srtRes.text();
  assert.equal(srtRes.headers.get('X-Srt-Stream'), 'A', 'no takes: the .srt comes from luồng A');
  assert.match(srt, /Hubo un tiempo, hablaba con Dios\./, 'imported lyric reaches the .srt');
  assert.match(srt, /00:00:05,000 --> 00:00:13,000/, 'timed from the shot’s own start');
  // …and each block keeps its own start even when the column no longer tiles the song: shrinking
  // the silent opening shot leaves a gap, which used to shift every later subtitle by that much.
  const first = r.data.nodes
    .filter(n => n.zone === 'production' && !n.terminal)
    .sort((a, b) => a.start - b.start)[0];
  r = await api('/api/node', 'PATCH', { id: first.id, duration: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  srt = await (await fetch('http://127.0.0.1:17897/api/director/subtitles.srt')).text();
  assert.match(srt, /00:00:05,000 --> 00:00:13,000/, 'a gap in the column does not drift the .srt');
  await api('/api/node', 'PATCH', { id: first.id, duration: 5.0 });

  // The edit manifest of luồng A: one row per shot of the production column, in time order, with
  // the camera columns the CSV wrote and the exact clip file name (none of these are filmed yet).
  const manifest = async stream => {
    const res = await fetch('http://127.0.0.1:17897/api/director/manifest.csv?stream=' + stream);
    const text = await res.text();
    return { res, text, rows: res.ok ? parseCsv(text) : [] };
  };
  const mA = await manifest('A');
  assert.equal(mA.res.status, 200, mA.text);
  assert.match(
    mA.res.headers.get('Content-Disposition'),
    /luong-A-phu-canh\.csv/,
    'named per stream',
  );
  assert.equal(mA.res.headers.get('X-Manifest-Rows'), '3');
  assert.equal(
    mA.text.replace(/^﻿/, '').split('\n')[0],
    'No,In_s,Out_s,In_TC,Out_TC,Dur_s,Section,Subject,Shot Size,Angle,Movement,Location,Lyric,ClipFile,Status',
    'the manifest columns, in order',
  );
  assert.equal(mA.rows.length, 3);
  assert.deepEqual(
    mA.rows.map(x => x.No),
    ['1', '2', '3'],
    'numbered in play order',
  );
  assert.deepEqual(
    mA.rows.map(x => Number(x.In_s)),
    [0, 5, 13],
    'sorted by time, in seconds',
  );
  assert.deepEqual(
    mA.rows.map(x => x.In_TC),
    ['00:00:00:00', '00:00:05:00', '00:00:13:00'],
    'hh:mm:ss:ff at 25 fps',
  );
  assert.equal(mA.rows[0].Out_TC, '00:00:05:00');
  assert.equal(mA.rows[1].Dur_s, '8.000');
  assert.deepEqual(
    mA.rows.map(x => [x.Subject, x['Shot Size'], x.Angle, x.Movement]),
    [
      ['Stage', 'EWS', 'front', 'locked'],
      ['Singer', 'MCU', '3/4', 'slow push'],
      ['Pianist', 'CU', 'side', 'slider'],
    ],
    'the CSV camera columns reach the manifest',
  );
  assert.equal(mA.rows[1].Lyric, 'Hubo un tiempo, hablaba con Dios.', 'comma lyric survives');
  assert.equal(mA.rows[1].Section, 'Spoken Intro');
  assert.deepEqual(
    [...new Set(mA.rows.map(x => x.Status))],
    ['chưa có video'],
    'a shot with no clip is marked',
  );
  assert.deepEqual([...new Set(mA.rows.map(x => x.ClipFile))], [''], 'and carries no file name');
  // Luồng B is empty in this project (no vocal, so no takes): the download says what to do first.
  const mB = await manifest('B');
  assert.equal(mB.res.status, 400);
  assert.match(JSON.parse(mB.text).error, /Luồng B chưa có take/);

  // Import a LYRIC-TIMING CSV → the song's sections on the node.
  r = await api('/api/music/import', 'POST', {
    id,
    csv:
      'Start,End,Duration_s,Section,Exact Lyric,Delivery\n' +
      '00:00.000,00:08.150,8.15,Spoken Intro,instrumental intro,spoken\n' +
      '00:08.150,00:17.438,9.288,Spoken Intro,Hubo un tiempo,spoken',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.importSummary.kind, 'lyrics');
  assert.equal(r.data.importSummary.sections, 2);
  node = r.data.nodes.find(n => n.id === id);
  assert.equal(node.analysis.json.sections.length, 2, 'lyric timing stored as sections');

  // A CSV we cannot classify is a clean error.
  bad = await api('/api/music/import', 'POST', { id, csv: 'foo,bar\n1,2' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /không nhận dạng|CSV/i);

  // A full Director rebuild ("✦ Dựng sơ đồ") replaces the graph but keeps the song's music node.
  r = await api('/api/director/build', 'POST', { blueprint: CAST_BLUEPRINT });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(
    r.data.nodes.some(n => n.id === id && n.kind === 'music' && n.analysis),
    'the music node (with its analysis) survives a rebuild',
  );
  // The cast step needs an imported storyboard: a rebuild left none, so it is refused cleanly.
  bad = await api('/api/music/cast', 'POST', { id, via: 'api' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Nhập shot-list CSV trước/);

  // The standard shot list names its sets: the cast step designs one scene per Location, and each
  // shot is wired to the set it is on (a set with no scene of its own falls back to the main one).
  r = await api('/api/music/import', 'POST', {
    id,
    csv: STD_CSV,
    replaceShots: true,
    autoWire: true,
    targetSeconds: 8,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.importSummary.created, 3, 'a change of set cuts the merged clips');
  // The CSV's words are checked against the official lyrics on the node (here: another song's).
  assert.deepEqual(r.data.importSummary.lyricsCheck, {
    ok: false,
    at: 0,
    csvWords: 16,
    officialWords: 4,
    csv: 'hubo un tiempo hablaba con dios',
    official: 'cau mot diep khuc',
  });
  r = await api('/api/music/cast', 'POST', { id, via: 'api' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(lastUser, /- balcony \(role "scene"\): Balcony — /);
  const balcony = r.data.nodes.find(n => n.assetKey === 'balcony');
  const mainSet = r.data.nodes.find(n => n.assetKey === 'stage');
  assert.ok(balcony && mainSet, 'both sets designed');
  const setsOf = shot =>
    r.data.edges
      .filter(e => e.target === shot.id && [balcony.id, mainSet.id].includes(e.source))
      .map(e => e.source);
  const stdShot = row =>
    r.data.nodes.find(
      n => n.zone === 'production' && !n.terminal && n.parts?.some(p => p.shot === row),
    );
  assert.deepEqual(setsOf(stdShot('003')), [balcony.id], 'the balcony beats are on the balcony');
  assert.deepEqual(setsOf(stdShot('001')), [mainSet.id], 'the main-stage beats on the main set');
  assert.deepEqual(setsOf(stdShot('005')), [mainSet.id]);
  // A shot list too long for the project is refused BEFORE anything is removed: the storyboard
  // in place stays whole.
  const prodBefore = r.data.nodes.filter(n => n.zone === 'production' && !n.terminal).length;
  const BIG =
    SHOT_LIST_HEADER +
    '\n' +
    Array.from(
      { length: 220 },
      (_, i) =>
        `${i + 1},${i},${i + 1},Verse,,NO,3,calm,Singer,Main stage,CU,eye level,locked,Sings`,
    ).join('\n');
  bad = await api('/api/music/import', 'POST', {
    id,
    csv: BIG,
    replaceShots: true,
    targetSeconds: 0,
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Vượt giới hạn 200 node/);
  r = await api('/api/state');
  assert.equal(
    r.data.nodes.filter(n => n.zone === 'production' && !n.terminal).length,
    prodBefore,
    'the storyboard in place is untouched',
  );

  // Luồng A (phủ cảnh): a Band row holds EVERY musician of the project even when its Action names
  // no instrument (that is how the coverage stream is written), while the singer stays out of it —
  // she belongs to the lip-sync stream. An all-Macro detail row still sits in a set, so it is never
  // rendered from its prompt alone.
  const BAND_CSV =
    SHOT_LIST_HEADER +
    '\n' +
    [
      '001,00:00.000,00:08.000,Intro,,NO,7,"driving focus — heads down; full force",Band,Main stage,WS,eye level,crane up,The whole group leans into the downbeat together',
      '002,00:08.000,00:14.000,Verse 1,câu một,NO,5,"steady pulse — eyes ahead; soft strokes",Drummer,Main stage,MS,3/4,dolly left,Brushes keep time at the back line',
      '003,00:14.000,00:20.000,Verse 1,,NO,2,"stillness — wax runs cold",Candle,Main stage,Macro,eye level,locked,Wax runs down the rim',
    ].join('\n');
  r = await api('/api/music/import', 'POST', {
    id,
    csv: BAND_CSV,
    replaceShots: true,
    autoWire: true,
    targetSeconds: 0,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.importSummary.created, 3, 'one shot per row');
  r = await api('/api/music/cast', 'POST', { id, via: 'api' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cov = r.data;
  const covKey = k => cov.nodes.find(n => n.assetKey === k);
  assert.ok(covKey('drummer'), 'the drummer the shot list shows is designed');
  const covRow = shot =>
    cov.nodes.find(
      n => n.zone === 'production' && !n.terminal && n.parts?.some(p => p.shot === shot),
    );
  const covRefs = shot => cov.edges.filter(e => e.target === covRow(shot).id).map(e => e.source);
  const bandRefs = covRefs('001');
  assert.ok(
    bandRefs.includes(covKey('pianist').id) && bandRefs.includes(covKey('drummer').id),
    'the band wide holds every musician, though its Action names no instrument',
  );
  assert.ok(
    !bandRefs.includes(covKey('singer').id),
    'the singer is not pulled into a band framing (luồng B is hers)',
  );
  const covDesign = new Set(cov.nodes.filter(n => n.zone === 'design').map(n => n.id));
  assert.ok(
    bandRefs.some(pid => covDesign.has(pid)),
    'the band wide is on a set',
  );
  assert.match(
    covRow('001').resolvedPrompts.video,
    /In it: Pianist — as shown; Drummer — as shown/,
    'both musicians reach the prompt, in reference order',
  );
  assert.ok(
    covRefs('003').some(pid => covDesign.has(pid)),
    'an all-Macro detail row still sits in a set',
  );

  console.log(
    'PASS: youTubeId + extractYouTubeMeta parsing, parseMusicAnalysis (fence/bare/reject), CSV ' +
      'parse (quoted commas) + parseTime + rowsToShots/rowsToSections, re-timing the CSV to the ' +
      'vocal (sung rows hold their line, rows tile the song, overlap cut, unsung rows spread by CSV ' +
      'length, MIN_ROW), music node create (Âm thanh ' +
      'zone, no prompt/ports), analyze via real LLM (master prompt + lyrics sent, params stored + ' +
      'duration anchored + persisted), audio upload onto the node, deep-prompt endpoint, import ' +
      'shot-list CSV → exact-timed storyboard (lip-sync line, comma lyric, auto-wire singer/scene, ' +
      'replaceShots no-dup, .srt from imported lyrics), ~8s consolidation (nearest-to-target ' +
      'bundles, merged lyric, beat cut-list, refs mode, opening-beat keyframe, style + stage on ' +
      'every shot, camera never), cast design via the MV master prompt (pinned keys, assets merged ' +
      'without touching shots, template placeholders removed, MV style applied, shots re-wired in ' +
      'beat order, re-run keeps assets), music node survives a Director rebuild, import ' +
      'lyric-timing CSV → sections, guards (no source / no worker / missing node / unknown CSV / ' +
      'cast without storyboard), the standard shot list (prompt pins its header + the song facts, ' +
      'emotion + set + energy in the prompts, face-only stills, a change of set cuts the merged ' +
      'clips and folds slivers, rows over 8 s cut with the line kept on the first piece, ' +
      'placeholder lyrics + hyphenated headers, players wired from the Subject or a named person ' +
      'only, one scene designed per Location and each shot wired to its set), the coverage stream ' +
      '(the prompt writes luồng A only — Lip Sync always NO, Location on every row, the coverage ' +
      'recipe; a Band row wires every musician but not the singer, an all-Macro row still wires a ' +
      'set), the edit manifests (luồng A: columns, time order, 25 fps timecode, camera columns, ' +
      '"chưa có video"; luồng B refused while empty) and the .srt read from each shot’s own start',
  );
} finally {
  proc.kill();
  llm.close();
}
