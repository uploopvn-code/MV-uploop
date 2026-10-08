// Lip-sync with Omni Flash: reading a vocal (voice activity + snapping each sung line to it), the
// real ffmpeg mux of keyframe + vocal cut, real Demucs separation, and the whole flow through the
// server — vocals → takes from the imported storyboard → keyframe → source video → an Omni Flash
// video-to-video render against a local Seedvis API (a real HTTP exchange, as in test-seedvis).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  TAKE_MAX,
  TAKE_MIN,
  activityFromPcm,
  alignLines,
  groupLines,
  guessLang,
  muxTake,
  refineTakes,
  separateVocals,
} from './lib/lipsync.mjs';
import { buildRequest } from './seedvis-client.mjs';
import { parseCsv } from './lib/csv.mjs';
import { SHOT_LIST_HEADER, parseTime } from './lib/shotlist.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-lipsync-'));
const ff = args => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr.toString());
};
const probe = file => {
  const r = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name:format=duration',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(r.stdout.toString());
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// --- Unit: reading a vocal ---------------------------------------------------------------------
// 6 s of 16 kHz mono: near-silence, a sung phrase 1.0–2.2 s with a 100 ms breath at 1.5 (bridged),
// another 2.6–4.0 s, and a 40 ms click at 5.0 s (dropped).
const RATE = 16000;
const pcm = Buffer.alloc(6 * RATE * 2);
for (let i = 0; i < 6 * RATE; i++) {
  const t = i / RATE;
  const sung =
    (t >= 1.0 && t < 2.2 && !(t >= 1.5 && t < 1.6)) ||
    (t >= 2.6 && t < 4.0) ||
    (t >= 5.0 && t < 5.04);
  const v = sung ? 0.3 * Math.sin(2 * Math.PI * 220 * t) : 0.0005 * Math.sin(2 * Math.PI * 50 * t);
  pcm.writeInt16LE(Math.round(v * 32767), i * 2);
}
const act = activityFromPcm(pcm, RATE);
assert.equal(act.hop, 0.02);
assert.equal(act.duration, 6);
const at = t => act.mask[Math.floor(t / act.hop)];
assert.equal(at(0.5), 0, 'silence is silent');
assert.equal(at(1.2), 1, 'singing is sung');
assert.equal(at(1.55), 1, 'a 100 ms breath inside a phrase is bridged');
assert.equal(at(2.4), 0, 'the 400 ms gap between phrases stays a gap');
assert.equal(at(5.02), 0, 'a 40 ms click is dropped');

// Storyboard marks a little off the real vocal: each snaps to the real edge (±0.5 s), the cut keeps
// up to 0.15 s of silence before and 0.3 s after — never into the other phrase.
let cuts = refineTakes(
  [
    { start: 0.9, end: 2.4 },
    { start: 2.75, end: 4.1 },
  ],
  act,
);
near(cuts[0].lsStart, 1.0, 0.021, 'line 1 starts where the voice starts');
near(cuts[0].lsEnd, 2.2, 0.021, 'line 1 ends where the voice stops');
assert.ok(cuts[0].snappedStart && cuts[0].snappedEnd);
near(cuts[0].clipStart, 0.85, 0.021, '0.15 s of silence before');
near(cuts[0].clipEnd, 2.5, 0.021, '0.3 s of silence after');
near(cuts[1].lsStart, 2.6, 0.021, 'line 2 snaps back to the real onset');
near(cuts[1].lsEnd, 4.0, 0.021, 'line 2 end');
near(cuts[1].clipStart, 2.45, 0.021, 'line 2 pre-roll stays in the silence after line 1');
assert.ok(cuts[1].clipStart >= cuts[0].lsEnd, 'no cut reaches into the other line’s voice');
assert.ok(cuts[0].voiced > 0.85, 'line 1 is sung');
// A mark far from any vocal edge stays where the storyboard put it; a silent stretch is "quiet".
cuts = refineTakes([{ start: 4.6, end: 5.6 }], act);
assert.equal(cuts[0].lsStart, 4.6);
assert.equal(cuts[0].lsEnd, 5.6);
assert.ok(!cuts[0].snappedStart && !cuts[0].snappedEnd);
assert.ok(cuts[0].voiced < 0.1, 'no voice there');

// --- Unit: whole sung lines merged into takes of TAKE_MIN…TAKE_MAX ------------------------------
const line = (key, start, end, extra = {}) => ({
  key,
  lyric: 'line ' + key,
  start,
  end,
  section: 'Verse 1',
  location: 'Main stage',
  ...extra,
});
// 2 s lines a second apart: a take keeps taking whole lines until it reaches TAKE_MIN and never
// passes TAKE_MAX. Every line is in exactly one take, in the order sung, and no take overlaps the
// next.
const even = Array.from({ length: 12 }, (_, i) => line(String(i + 1), i * 3, i * 3 + 2));
const merged = groupLines(even);
assert.deepEqual(
  merged.map(g => [g.lines.length, Number((g.end - g.start).toFixed(2))]),
  [
    [3, 8],
    [3, 8],
    [3, 8],
    [3, 8],
  ],
  '12 lines → four takes of three lines',
);
assert.deepEqual(
  merged.flatMap(g => g.lines.map(l => l.key)),
  even.map(l => l.key),
  'every line in exactly one take, in the order sung',
);
for (let i = 1; i < merged.length; i++)
  assert.ok(merged[i].start >= merged[i - 1].end, 'takes do not overlap');
assert.ok(merged.every(g => g.end - g.start >= TAKE_MIN && g.end - g.start <= TAKE_MAX && !g.over));
// The ceiling closes a take the next line would carry past TAKE_MAX (reported as "capped").
assert.deepEqual(
  groupLines([line('a', 0, 4), line('b', 6.5, 10.5), line('c', 12, 16)]).map(g => [
    g.lines.map(l => l.key),
    g.stop,
    g.capped,
  ]),
  [
    [['a'], 'max', true],
    [['b', 'c'], 'end', false], // long enough, and the song has no further line
  ],
);
// One line longer than TAKE_MAX stays whole (splitting it would cut the voice mid-word) and is flagged.
const over = groupLines([line('a', 0, 11.5), line('b', 13, 15)]);
assert.deepEqual(
  over.map(g => [g.lines.map(l => l.key), g.over]),
  [
    [['a'], true],
    [['b'], false],
  ],
);
// A take never runs across a change of section; a line with no section takes the take's.
const keysOf = gs => gs.map(g => g.lines.map(l => l.key));
assert.deepEqual(
  keysOf(
    groupLines([
      line('a', 0, 2),
      line('b', 2.5, 4.5, { section: 'Chorus 1' }),
      line('c', 5, 7, { section: 'Chorus 1' }),
    ]),
  ),
  [['a'], ['b', 'c']],
);
// A coverage row's Location is a camera position in luồng A, not the singer's place: it never
// breaks a lip-sync take (the take is one singer in one spot).
assert.deepEqual(
  keysOf(groupLines([line('a', 0, 2), line('b', 2.5, 4.5, { location: 'Balcony' })])),
  [['a', 'b']],
);
assert.deepEqual(keysOf(groupLines([line('a', 0, 2, { section: '' }), line('b', 2.5, 4.5)])), [
  ['a', 'b'],
]);

// A merged window: its cut grows into the silence on both sides until the take is `padTo` long —
// never past the window's lo / hi (the middle of the silence to the take beside it) nor past `max`,
// and the voiced share is measured over the WHOLE window, both lines and the breath between them.
cuts = refineTakes([{ start: 1.0, end: 4.0, padTo: 5, max: 5.5, lo: 0, hi: 6 }], act);
near(cuts[0].clipEnd - cuts[0].clipStart, 5, 0.03, 'grown into the silence until it is 5 s long');
assert.ok(cuts[0].clipStart < 0.85 && cuts[0].clipEnd > 4.3, 'grown on both sides');
near(cuts[0].voiced, 2.6 / 3, 0.03, 'voiced over the whole window, not the first line');
cuts = refineTakes([{ start: 1.0, end: 2.2, padTo: 5, lo: 0.95, hi: 2.45 }], act);
assert.ok(cuts[0].clipStart >= 0.95 - 1e-9, 'never into the take before it');
assert.ok(cuts[0].clipEnd <= 2.45 + 1e-9, 'never into the take after it');
cuts = refineTakes([{ start: 1.0, end: 4.0, padTo: 5, max: 3.2 }], act);
near(cuts[0].clipEnd - cuts[0].clipStart, 3.2, 0.021, 'never longer than max');

// --- Unit: the Omni Flash request ----------------------------------------------------------------
const omni = { model: 'Omni-Flash', aspectRatio: '16:9' };
let req = buildRequest('video', omni, 'sing', [], 1, 'data:video/mp4;base64,AAAA');
assert.equal(req.endpoint, '/developer/generations');
assert.equal(req.body.mode, 'video-to-video');
assert.equal(req.body.video, 'data:video/mp4;base64,AAAA');
assert.ok(!('duration' in req.body), 'no duration: the result is as long as the source');
assert.ok(!('images' in req.body) && !('image' in req.body), 'no images unless given');
assert.throws(
  () => buildRequest('video', { model: 'Veo-3.1', aspectRatio: '16:9' }, 'x', [], 1, 'data:,'),
  /không nhận video đầu vào/,
  'only a video-to-video model takes a source video',
);
req = buildRequest('video', omni, 'x', [], 1); // without a video: unchanged behaviour
assert.equal(req.body.mode, 'text-to-video');

// --- Real ffmpeg: keyframe + vocal cut → the source video ----------------------------------------
const still = path.join(tmp, 'still.png');
ff(['-f', 'lavfi', '-i', 'color=c=gray:s=64x36', '-frames:v', '1', still]);
const tone = path.join(tmp, 'tone.wav');
ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-ac', '2', '-ar', '44100', tone]);
let mux = await muxTake({ image: still, vocals: tone, start: 1.0, end: 4.5, outDir: tmp });
let info = probe(path.join(tmp, mux.id));
assert.deepEqual(
  info.streams.map(s => s.codec_type).sort(),
  ['audio', 'video'],
  'one picture + one sound track',
);
assert.ok(
  info.streams.some(s => s.codec_name === 'h264') && info.streams.some(s => s.codec_name === 'aac'),
);
near(Number(info.format.duration), 3.5, 0.08, 'as long as the cut');
mux = await muxTake({ image: still, vocals: tone, start: 2.0, end: 2.6, outDir: tmp });
near(
  Number(probe(path.join(tmp, mux.id)).format.duration),
  2.0,
  0.08,
  'a short line is padded to 2 s',
);
assert.equal(mux.duration, 2);

// --- Real Demucs (skipped only when Demucs is not installed here) -------------------------------
const demucs = spawnSync('python', ['-c', 'import demucs'], { stdio: 'ignore' }).status === 0;
const song = path.join(tmp, 'song.wav');
const SONG_SECS = 20; // long enough to hold two 7–10 s lip-sync takes
// a little "song": a tone with a rhythmic amplitude, plus noise
ff([
  '-f',
  'lavfi',
  '-i',
  `aevalsrc='0.4*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*2*t))':s=44100:d=${SONG_SECS}`,
  '-f',
  'lavfi',
  '-i',
  `anoisesrc=d=${SONG_SECS}:a=0.03`,
  '-filter_complex',
  'amix=inputs=2',
  '-ac',
  '2',
  '-ar',
  '44100',
  song,
]);
if (demucs) {
  let progressed = false;
  const v = await separateVocals(song, tmp, () => (progressed = true));
  assert.match(v.id, /^[a-f0-9-]+\.wav$/);
  assert.equal(v.mime, 'audio/wav');
  assert.ok(progressed, 'Demucs progress reported');
  near(
    Number(probe(path.join(tmp, v.id)).format.duration),
    SONG_SECS,
    0.1,
    'vocals as long as the song',
  );
} else console.log('SKIP: Demucs is not installed (pip install demucs) — separation not tested');

// --- Real forced alignment: spoken lines found where they are, whatever the storyboard said ------
assert.equal(guessLang('Dios no cerró la puerta, todavía me estaba esperando'), 'es');
assert.equal(guessLang('and every light is shining for you'), 'en');
const canAlign =
  process.platform === 'win32' &&
  spawnSync('python', ['-c', 'import torchaudio'], { stdio: 'ignore' }).status === 0;
let aligned = false;
// The spoken track (22 s, four lines) and where each line's voice begins — reused by the server
// flow, where the four lines become two 7–10 s lip-sync takes.
let spoken = null;
const spokenAt = [];
const SPOKEN = [
  { text: 'The river carries us home tonight.', at: 1.5 },
  { text: 'And every light is shining for you.', at: 6.5 },
  { text: 'We walk the quiet road again.', at: 12 },
  { text: 'And morning finds us singing.', at: 17.5 },
];
const SPOKEN_SECS = 22;
if (canAlign) {
  // Windows speech synthesis says the four lines; each is placed at its own second of the track.
  const say = (text, file) =>
    spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${file}'); $s.Speak('${text}'); $s.Dispose()`,
    ]).status === 0;
  const says = SPOKEN.map((l, i) => path.join(tmp, `a${i + 1}.wav`));
  const mix = path.join(tmp, 'spoken.wav');
  if (SPOKEN.every((l, i) => say(l.text.replace(/[.!]/g, '').toLowerCase(), says[i]))) {
    const pcm16 = f =>
      spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', f, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
        {
          maxBuffer: 1 << 28,
        },
      ).stdout;
    const speechAt = f => {
      const a = activityFromPcm(pcm16(f), 16000);
      return a.mask.indexOf(1) * a.hop; // the synthesizer's own lead-in silence
    };
    ff([
      ...says.flatMap(f => ['-i', f]),
      '-filter_complex',
      SPOKEN.map((l, i) => `[${i}]adelay=${Math.round(l.at * 1000)}:all=1[x${i}]`).join(';') +
        ';' +
        SPOKEN.map((l, i) => `[x${i}]`).join('') +
        `amix=inputs=${SPOKEN.length}:normalize=0,apad=whole_dur=${SPOKEN_SECS}`,
      '-ac',
      '2',
      '-ar',
      '44100',
      mix,
    ]);
    const items = SPOKEN.map((l, i) => ({ id: 'l' + i, text: l.text }));
    const res = await alignLines(mix, items, 'en');
    SPOKEN.forEach((l, i) =>
      near(
        res.lines[i].start,
        l.at + speechAt(says[i]),
        0.25,
        `line ${i + 1} is where it is spoken`,
      ),
    );
    for (let i = 1; i < res.lines.length; i++)
      assert.ok(res.lines[i - 1].end < res.lines[i].start, 'in order, not overlapping');
    assert.ok(
      res.lines.every(l => l.score > 0.5),
      'confident on clear speech: ' + res.lines.map(l => l.score),
    );
    // A hyphen (the model's CTC blank) or a "|" in a lyric is dropped, not fed to the aligner —
    // one of them used to fail the reading of the whole song.
    const dashed = await alignLines(
      mix,
      [
        { ...items[0], text: 'The river - carries us home | tonight.' },
        { ...items[1], text: 'And every light is shining for-you!' },
        ...items.slice(2),
      ],
      'en',
    );
    near(dashed.lines[0].start, res.lines[0].start, 0.05, 'hyphenated line 1 still read');
    near(dashed.lines[1].start, res.lines[1].start, 0.05, 'hyphenated line 2 still read');
    aligned = true;
    spoken = mix;
    spokenAt.push(...SPOKEN.map((l, i) => l.at + speechAt(says[i])));
  }
}
if (!aligned) console.log('SKIP: forced alignment (needs Windows speech synthesis + torchaudio)');

// --- Through the server -------------------------------------------------------------------------
const KEY = 'sv-lipsync-key-1234';
const SV_PORT = 17881,
  PORT = 17880;
const API = `http://127.0.0.1:${SV_PORT}/api/v1`;
const outMp4 = path.join(tmp, 'omni-out.mp4');
ff([
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=64x36:d=2',
  '-f',
  'lavfi',
  '-i',
  'sine=duration=2',
  '-shortest',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  outMp4,
]);
const submits = [];
const jobs = new Map();
let hold = false; // true → renders stay "processing" (the queue is busy)
const mock = http.createServer(async (rq, rs) => {
  let raw = '';
  for await (const c of rq) raw += c;
  const send = (s, o) => {
    rs.writeHead(s, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify(o));
  };
  if (rq.url.startsWith('/cdn/')) {
    rs.writeHead(200, { 'Content-Type': 'video/mp4' });
    return rs.end(fs.readFileSync(outMp4));
  }
  if (rq.headers.authorization !== 'Bearer ' + KEY) return send(401, { error: 'bad key' });
  if (rq.url === '/api/v1/account/info') return send(200, { data: { balance: 1 } });
  if (rq.url === '/api/v1/models')
    return send(200, { data: [{ id: 'Omni-Flash' }, { id: 'GEM_PIX_2' }] });
  const life = (id, j) => ({
    id,
    status: j.status,
    is_final: j.status === 'completed',
    mode: j.mode,
    next:
      j.status === 'completed'
        ? { action: 'done' }
        : { action: 'poll', url: `${API}/developer/generations/${id}?wait=0`, after_seconds: 1 },
    outputs: j.status === 'completed' ? [{ url: `http://localhost:${SV_PORT}/cdn/${id}` }] : [],
  });
  const poll = rq.url.match(/^\/api\/v1\/developer\/generations\/([\w-]+)\?wait=0$/);
  if (poll) {
    const j = jobs.get(poll[1]);
    j.status = hold ? 'processing' : 'completed';
    return send(200, { success: true, data: life(poll[1], j) });
  }
  if (rq.method === 'POST' && rq.url === '/api/v1/developer/generations') {
    const b = JSON.parse(raw),
      id = rq.headers['idempotency-key'];
    submits.push(b);
    jobs.set(id, { status: 'queued', mode: b.mode });
    return send(202, { success: true, status: 202, data: life(id, jobs.get(id)) });
  }
  send(404, {});
});
await new Promise(r => mock.listen(SV_PORT, '127.0.0.1', r));
// The MV master prompt's answer for the cast step (a local OpenAI-compatible server).
const LLM_PORT = 17882;
const llm = http.createServer(async (rq, rs) => {
  for await (const c of rq);
  const bp = {
    project: { name: 'Test', theme: 'music' },
    style: 'Candlelit opera, 35mm.',
    assets: [
      { key: 'singer', role: 'character', name: 'Ca sĩ chính', prompt: 'Character model sheet' },
      { key: 'stage', role: 'scene', name: 'Nhà hát', prompt: 'Opera stage, wide.' },
    ],
    shots: [{ name: 'Mẫu', duration: 8, uses: ['singer', 'stage'] }],
  };
  rs.writeHead(200, { 'Content-Type': 'application/json' });
  rs.end(
    JSON.stringify({
      choices: [{ message: { content: '```json\n' + JSON.stringify(bp) + '\n```' } }],
    }),
  );
});
await new Promise(r => llm.listen(LLM_PORT, '127.0.0.1', r));
const proc = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: {
    ...process.env,
    SEEDVIS_API_KEY: '',
    MV_PORT: String(PORT),
    MV_ORBIT_URL: 'http://127.0.0.1:1',
    MV_SEEDVIS_URL: API,
    MV_SEEDVIS_POLL_MS: '30',
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
const state = async () => (await api('/api/state')).data;
const until = async (test, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const s = await state();
    if (test(s)) return s;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Timed out waiting for ' + what);
};
const PNG = b => fs.readFileSync(b).toString('base64');
try {
  await new Promise((r, j) => {
    proc.stdout.once('data', r);
    proc.once('error', j);
  });
  let r = await api('/api/nodes', 'POST', { kind: 'music' });
  const music = r.data.nodes.find(n => n.kind === 'music');
  const id = music.id;
  // Nothing to separate before a song is attached.
  r = await api('/api/music/vocals', 'POST', { id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Tải file nhạc/);
  r = await api('/api/upload', 'POST', {
    nodeId: id,
    kind: 'audio',
    name: 'song.wav',
    mime: 'audio/wav',
    base64: fs.readFileSync(song).toString('base64'),
    duration: SONG_SECS,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Takes need the vocals first.
  r = await api('/api/music/lipsync', 'POST', { id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Tách vocal trước/);

  if (!demucs) {
    console.log('SKIP: server lip-sync flow needs Demucs');
    process.exitCode = 0;
  } else {
    r = await api('/api/music/vocals', 'POST', { id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(
      r.data.nodes.find(n => n.id === id).vocalTask.status,
      'running',
      'runs in the background',
    );
    const sep = await until(
      s => ['done', 'failed'].includes(s.nodes.find(n => n.id === id).vocalTask?.status),
      180000,
      'vocal separation',
    );
    const m = sep.nodes.find(n => n.id === id);
    assert.equal(m.vocalTask.status, 'done', m.vocalTask.error);
    assert.match(m.vocals.url, /^\/media\/[a-f0-9-]+\.wav$/);
    assert.equal(
      (await fetch(`http://127.0.0.1:${PORT}` + m.vocals.url)).status,
      200,
      'vocals served',
    );

    // Storyboard: four sung lines (one of them given to the band) between instrumental shots.
    const CSV =
      'Shot,Start,End,Duration_s,Section,Exact Lyric,Vocal,Lip Sync,Energy,Subject,Shot Size,Angle,Lens,Camera Movement,Visual Action,Emotional Purpose,Cut Motivation,Vocal Delivery\n' +
      '001,00:00.000,00:01.000,1.0,Intro,instrumental intro,instrumental/no vocal,NO,2,Stage,EWS,front,35mm,locked,Empty stage,x,x,\n' +
      '002,00:01.000,00:05.000,4.0,Verse,Uno dos tres,sung,YES,4,Singer,MCU,3/4,85mm,slow push,Singer begins,x,x,bright hope — full voice\n' +
      '003,00:05.000,00:09.000,4.0,Verse,cuatro cinco,sung,NO,4,Pianist,CU,side,85mm,slider,Hands on keys,x,x,steady — medium voice\n' +
      '004,00:09.000,00:13.000,4.0,Chorus,seis siete,sung,YES,4,Singer,CU,front,85mm,locked,Holds the note,x,x,soaring — full voice\n' +
      '005,00:13.000,00:17.000,4.0,Chorus,ocho nueve,sung,YES,4,Singer,Medium,3/4,50mm,orbit,Lifts the chin,x,x,triumphant — full voice\n' +
      '006,00:17.000,00:20.000,3.0,Outro,,instrumental/no vocal,NO,2,Stage,WS,rear,35mm,pull-out,Lights fade,x,x,';
    r = await api('/api/music/import', 'POST', {
      id,
      csv: CSV,
      replaceShots: true,
      autoWire: true,
      targetSeconds: 0,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));

    // Refreshing the beats from the CSV touches nothing else: same shots, keyframe kept.
    const shot2 = r.data.nodes.find(n => n.zone === 'production' && n.start === 1);
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', path.join(tmp, 's.png')]);
    await api('/api/upload', 'POST', {
      nodeId: shot2.id,
      kind: 'image',
      mime: 'image/png',
      base64: PNG(path.join(tmp, 's.png')),
    });
    const before = (await state()).nodes.find(n => n.id === shot2.id);
    r = await api('/api/music/refresh-beats', 'POST', { id, csv: CSV });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.refreshSummary.matched, 6);
    assert.equal(r.data.refreshSummary.lines, 3, 'three Lip Sync = YES lines');
    const after = r.data.nodes.find(n => n.id === shot2.id);
    assert.equal(after.image.id, before.image.id, 'keyframe kept');
    assert.equal(after.stale, before.stale, 'not marked out of date');
    assert.equal(r.data.nodes.filter(n => n.zone === 'production').length, 6, 'no shot added');
    assert.equal(after.parts[0].lyric, 'Uno dos tres');
    // A CSV with other times does not fit this storyboard.
    r = await api('/api/music/refresh-beats', 'POST', {
      id,
      csv: CSV.replace(/00:0(\d)\.(\d00)/g, '00:1$1.$2'),
    });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /không khớp/);

    r = await api('/api/music/lipsync', 'POST', { id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // Every sung line belongs to a take (not just the Lip Sync = YES ones), merged into windows of
    // 7–10 s: four lines of 4 s → two takes of two lines.
    assert.equal(r.data.lipsyncSummary.takes, 2, JSON.stringify(r.data.lipsyncSummary));
    assert.equal(r.data.lipsyncSummary.sungLines, 4, 'all four sung lines were cut');
    assert.equal(r.data.lipsyncSummary.min, 7);
    assert.equal(r.data.lipsyncSummary.max, 10);
    assert.equal(r.data.lipsyncSummary.short, 0, 'both takes reach 7 s');
    // This "song" is a tone: its separated vocal holds no recognisable voice, so the alignment is
    // discarded and the storyboard marks stay (snapped ±0.5 s to the vocal) — never noise.
    assert.equal(r.data.lipsyncSummary.aligned, 0, JSON.stringify(r.data.lipsyncSummary));
    assert.ok(r.data.lipsyncSummary.alignNote, 'the panel says why the lines were not aligned');
    assert.equal(r.data.nodes.find(n => n.id === id).lipsyncInfo.aligned, 0, 'kept on the song');
    assert.equal(r.data.lipsyncSummary.created, 2);
    let takes = r.data.nodes
      .filter(n => n.role === 'lipsync')
      .sort((a, b) => a.clipStart - b.clipStart);
    assert.equal(takes.length, 2);
    const [t1, t2] = takes;
    assert.equal(t1.zone, 'lipsync', 'takes live in the ⑪ Lip-sync column');
    assert.equal(t1.lyric, 'Uno dos tres cuatro cinco', 'the take sings both of its lines');
    assert.deepEqual(t1.lsKeys, ['002', '003']);
    assert.equal(t1.lsKey, '002+2', 'keyed by its first line and how many lines it holds');
    assert.deepEqual(
      t1.lsLines.map(l => l.key),
      ['002', '003'],
    );
    assert.ok(
      t1.lsLines[0].at >= 0 && t1.lsLines[0].at < 1,
      'the first line opens the clip, right after its pre-roll: ' + t1.lsLines[0].at,
    );
    assert.ok(
      t1.lsLines[1].at > 3,
      'the second line is timed from the clip start: ' + t1.lsLines[1].at,
    );
    assert.equal(t1.subject, 'Singer', 'the tool frames the singer, not the coverage rows');
    assert.equal(t1.shotSize, 'MCU', 'one shot size per take, rotated by the tool (take 1 → MCU)');
    assert.equal(t1.angle, 'eye level', 'always frontal — never a coverage row’s rear/profile');
    assert.equal(
      t1.parts[0].location,
      '',
      'the singer is wired to the main stage, not a coverage set',
    );
    assert.equal(t1.lsNote, '', 'the Vocal Delivery column fed the take, so nothing to warn');
    assert.match(
      t1.resolvedPrompts.video,
      /feeling and delivery: bright hope — full voice/,
      'the singer delivery drives the Omni prompt',
    );
    assert.equal(t1.csvStart, 1);
    assert.equal(t1.csvEnd, 9);
    assert.ok(
      t1.clipStart >= 0 && t1.clipEnd <= SONG_SECS && t1.clipEnd > t1.clipStart,
      'cut inside the song',
    );
    // (a snap to the real vocal edges may add up to SNAP on a side — a take never cuts a word)
    for (const t of takes) {
      const dur = t.clipEnd - t.clipStart;
      assert.ok(dur >= TAKE_MIN - 0.05 && dur <= TAKE_MAX + 0.5, `${t.name} is 7–10 s: ${dur}`);
    }
    assert.ok(t2.clipStart >= t1.clipEnd - 1e-9, 'the takes do not overlap');
    assert.ok(Math.abs(t1.lsStart - 1) <= 0.5 && Math.abs(t1.lsEnd - 9) <= 0.5, 'within ±0.5 s');
    assert.equal(t1.seedvis.video.model, 'Omni-Flash', 'filmed by Omni Flash');
    assert.equal(t1.providers.video.type, 'seedvis');
    assert.match(t1.resolvedPrompts.video, /lip-sync[\s\S]*"Uno dos tres"/);
    // one unbroken take, both lines timed from its first frame; the tool films a lip-sync take with
    // a gentle push-in a still source can hold
    assert.match(t1.resolvedPrompts.video, /The 2 lines of this take, timed from its first frame/);
    assert.match(t1.resolvedPrompts.video, /\d\.\ds: "Uno dos tres".*\d\.\ds: "cuatro cinco"/);
    assert.match(t1.resolvedPrompts.video, /ONE continuous unbroken take from ONE camera/);
    assert.match(t1.resolvedPrompts.video, /camera: slow push-in\./);
    assert.ok(!/Reference subjects/.test(t1.resolvedPrompts.video), 'no image list: no images go');
    assert.match(
      t1.resolvedPrompts.image,
      /mouth relaxed and gently closed/,
      'keyframe: about to sing',
    );
    const parents = r.data.edges.filter(e => e.target === t1.id).map(e => e.source);
    assert.ok(parents.includes('singer'), 'keyframe composed from the singer');
    assert.ok(parents.includes('stage'), '… on the stage');
    assert.ok(parents.includes('style'), '… in the MV style');

    // No keyframe yet: the Omni render is refused before anything is sent.
    r = await api('/api/jobs', 'POST', { nodeId: t1.id, kind: 'video' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /ảnh khung/);
    // A take stays in its column.
    r = await api('/api/node', 'PATCH', { id: t1.id, zone: 'production' });
    assert.equal(r.status, 400);

    // Keyframe in → the source video: the keyframe held over the line's vocal cut.
    ff(['-f', 'lavfi', '-i', 'color=c=white:s=128x72', '-frames:v', '1', path.join(tmp, 'k.png')]);
    r = await api('/api/upload', 'POST', {
      nodeId: t1.id,
      kind: 'image',
      mime: 'image/png',
      base64: PNG(path.join(tmp, 'k.png')),
    });
    assert.equal(r.status, 200);
    r = await api('/api/music/lipsync-input', 'POST', { id: t1.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let take = r.data.nodes.find(n => n.id === t1.id);
    assert.match(take.lsInput.url, /^\/media\/[a-f0-9-]+\.mp4$/);
    const srcFile = path.join(tmp, 'src.mp4');
    fs.writeFileSync(
      srcFile,
      Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}` + take.lsInput.url)).arrayBuffer()),
    );
    info = probe(srcFile);
    assert.deepEqual(info.streams.map(s => s.codec_type).sort(), ['audio', 'video']);
    near(
      Number(info.format.duration),
      Math.max(2, take.clipEnd - take.clipStart),
      0.08,
      'source video = the cut',
    );

    // The Omni Flash render: one source video, video-to-video, no images, no duration.
    await api('/api/seedvis/key', 'POST', { key: KEY });
    r = await api('/api/jobs', 'POST', { nodeId: t1.id, kind: 'video' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const jobId = r.data.job.id;
    const done = await until(
      s => !['queued', 'running'].includes(s.jobs.find(j => j.id === jobId).status),
      30000,
      'the Omni render',
    );
    const job = done.jobs.find(j => j.id === jobId);
    assert.equal(job.status, 'completed', job.error);
    const sent = submits.at(-1);
    assert.equal(sent.model, 'Omni-Flash');
    assert.equal(sent.mode, 'video-to-video');
    assert.match(sent.video, /^data:video\/mp4;base64,/);
    assert.ok(
      Buffer.from(sent.video.split(',')[1], 'base64').equals(fs.readFileSync(srcFile)),
      'exactly the source video that was previewed',
    );
    assert.ok(!('images' in sent) && !('duration' in sent));
    assert.match(sent.prompt, /"Uno dos tres"/);
    const clip = done.nodes.find(n => n.terminal && n.source === t1.id);
    assert.ok(clip, 'the render became a clip node');
    assert.equal(clip.zone, 'lipsync-video', 'in the ⑫ Video lip-sync column');
    assert.equal(clip.start, take.clipStart, 'the clip carries the song time it belongs at');
    near(clip.duration, take.clipEnd - take.clipStart, 0.001, 'and its length');
    assert.equal(clip.outdated, false);

    // Re-reading keeps the takes (keyframe + clip), no duplicates.
    r = await api('/api/music/lipsync', 'POST', { id });
    assert.equal(r.data.lipsyncSummary.created, 0);
    assert.equal(r.data.lipsyncSummary.updated, 2);
    assert.equal(r.data.nodes.filter(n => n.role === 'lipsync').length, 2);
    assert.ok(r.data.nodes.find(n => n.id === t1.id).image, 'keyframe kept');
    // nothing moved, so no clip was flagged out of date by the re-cut itself
    for (const old of [t1, t2]) {
      const now = r.data.nodes.find(n => n.id === old.id);
      assert.equal(now.clipStart, old.clipStart, 'the same cut');
      assert.equal(now.clipEnd, old.clipEnd);
      assert.equal(now.videoPrompt, old.videoPrompt, 'the same Omni prompt');
    }
    // A hand-nudged cut makes the clip out of date (it was made from another cut).
    r = await api('/api/node', 'PATCH', {
      id: t1.id,
      clipStart: take.clipStart + 0.05,
      clipEnd: take.clipEnd,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.nodes.find(n => n.id === clip.id).outdated, true);
    r = await api('/api/node', 'PATCH', { id: t1.id, clipStart: 3, clipEnd: 3.1 });
    assert.equal(r.status, 400, 'a cut under 0.3 s is refused');

    // "Quay lip-sync" films the takes that are ready (keyframe, no clip yet): only t2 once it has one.
    r = await api('/api/music/lipsync-render', 'POST', { id });
    assert.equal(r.status, 400, 'nothing ready: t1 is filmed, t2 has no keyframe');
    await api('/api/upload', 'POST', {
      nodeId: t2.id,
      kind: 'image',
      mime: 'image/png',
      base64: PNG(path.join(tmp, 'k.png')),
    });
    hold = true;
    r = await api('/api/music/lipsync-render', 'POST', { id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.lipsyncRender.queued, 1);
    // The queue is busy (a render in progress): refreshing the beats still works — it touches no
    // render's inputs — but re-cutting the takes waits while one of them is being made.
    r = await api('/api/music/refresh-beats', 'POST', { id, csv: CSV });
    assert.equal(r.status, 200, 'beats refresh while the queue is busy: ' + JSON.stringify(r.data));
    r = await api('/api/music/lipsync', 'POST', { id });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /đang được tạo/);
    hold = false;
    await until(s => s.nodes.some(n => n.terminal && n.source === t2.id), 30000, 'the second take');
    takes = (await state()).nodes.filter(n => n.terminal && n.zone === 'lipsync-video');
    assert.equal(takes.length, 2, 'both takes filmed');

    // --- The two streams as two manifests the editor can open ------------------------------------
    // Luồng A = the coverage shots of ⑥ (none filmed here), luồng B = the lip-sync takes of ⑪
    // (both filmed). The same seconds of the song appear in both files: that is the point.
    const manifest = async stream => {
      const res = await fetch(
        `http://127.0.0.1:${PORT}/api/director/manifest.csv?stream=${stream}`,
      );
      const text = await res.text();
      assert.equal(res.status, 200, text);
      return { res, rows: parseCsv(text) };
    };
    const live = (await state()).nodes;
    const shotRows = live
      .filter(n => n.zone === 'production' && !n.terminal)
      .sort((a, b) => a.start - b.start);
    const takeRows = live
      .filter(n => n.role === 'lipsync')
      .sort((a, b) => a.clipStart - b.clipStart);
    const mA = await manifest('A');
    assert.match(mA.res.headers.get('Content-Disposition'), /luong-A-phu-canh\.csv/);
    assert.deepEqual(
      mA.rows.map(x => Number(x.In_s)),
      shotRows.map(s => s.start),
      'luồng A: one row per coverage shot of ⑥, sorted by time',
    );
    assert.deepEqual(
      [...new Set(mA.rows.map(x => x.Status))],
      ['chưa có video'],
      'no clip in luồng A yet',
    );
    const mB = await manifest('B');
    assert.match(mB.res.headers.get('Content-Disposition'), /luong-B-hat-nhep\.csv/);
    assert.equal(mB.rows.length, takeRows.length, 'luồng B: one row per take');
    assert.deepEqual(
      mB.rows.map(x => Number(x.In_s)),
      takeRows.map(t => Math.round(t.clipStart * 1000) / 1000),
      'each row is the take’s own cut, in time order',
    );
    assert.deepEqual(
      mB.rows.map(x => x.Lyric),
      takeRows.map(t => t.lyric),
      'the sung line travels with the row',
    );
    // Status mirrors the clip the editor would place: the newest version of that take, and whether
    // it was made from the cut the take has now (t1's cut was nudged after it was filmed).
    const clipStatus = t => {
      const clip = live
        .filter(x => x.terminal && x.source === t.id && x.video)
        .sort((a, b) => (a.version || 0) - (b.version || 0))
        .at(-1);
      return !clip ? 'chưa có video' : clip.outdated ? 'video cũ — đầu vào đã đổi' : 'đã có video';
    };
    assert.deepEqual(
      mB.rows.map(x => x.Status),
      takeRows.map(clipStatus),
      'each row says whether its clip is there and current',
    );
    assert.ok(
      mB.rows.every(x => x.Status !== 'chưa có video'),
      'both takes are filmed, so neither row reads as missing its clip',
    );
    assert.deepEqual(
      mB.rows.map(x => [x.Subject, x['Shot Size']]),
      takeRows.map(t => [t.subject, t.shotSize]),
      'the take’s one subject and one shot size',
    );
    // The names in ClipFile are the names the clips really download as: the ZIP of those clips
    // holds exactly these files, so the editor can match them on disk without guessing.
    const zipRes = await fetch(`http://127.0.0.1:${PORT}/api/videos/zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: takes.map(t => t.id) }),
    });
    assert.equal(zipRes.status, 200);
    const zip = Buffer.from(await zipRes.arrayBuffer());
    for (const row of mB.rows) {
      assert.match(row.ClipFile, /_v1\.mp4$/, 'ClipFile is the clip download name');
      assert.ok(zip.includes(Buffer.from(row.ClipFile, 'utf8')), `the ZIP holds ${row.ClipFile}`);
    }
    // Timecodes: hh:mm:ss:ff at 25 fps, and the row's own seconds.
    for (const row of mB.rows) {
      assert.match(row.In_TC, /^\d\d:\d\d:\d\d:\d\d$/);
      const [h, m, s, f] = row.In_TC.split(':').map(Number);
      assert.ok(f < 25, 'frames under the 25 fps grid');
      assert.ok(Math.abs(h * 3600 + m * 60 + s + f / 25 - Number(row.In_s)) <= 0.02);
    }

    // The .srt track is the sung text, so with takes cut it comes from luồng B: ONE block per sung
    // LINE (a take holds several), each timed on its own voice span — not one block of several lines
    // over the whole padded clip, and not on a running total of the production column.
    const srtRes = await fetch(`http://127.0.0.1:${PORT}/api/director/subtitles.srt`);
    assert.equal(srtRes.headers.get('X-Srt-Stream'), 'B', 'the .srt follows luồng B');
    const srt = await srtRes.text();
    const srtLines = takeRows.flatMap(t => t.lsLines || []);
    assert.equal((srt.match(/-->/g) || []).length, srtLines.length, 'one subtitle per sung line');
    for (const l of srtLines) assert.ok(srt.includes(l.lyric), `the sung line: ${l.lyric}`);
    const srtStart = srt.match(/00:00:0(\d),(\d{3})/);
    assert.ok(srtStart, 'the first block is timed in the first seconds');
    assert.equal(
      Number(srtStart[1]) + Number(srtStart[2]) / 1000,
      Math.round(srtLines[0].start * 1000) / 1000,
      'timed on the sung line’s own voice span, not on the padded clip or a running total',
    );

    // The cast designed AFTER the takes: the template singer gives way to the designed one, and
    // every take re-wires to it (its keyframe composes the real cast, not a removed placeholder).
    await api('/api/director/llm', 'POST', {
      key: 'llm-key-1234',
      baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`,
      model: 'local',
    });
    r = await api('/api/music/cast', 'POST', { id, via: 'api' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const singer = r.data.nodes.find(n => n.assetKey === 'singer');
    assert.ok(singer && !r.data.nodes.some(n => n.id === 'singer'), 'template singer replaced');
    for (const t of r.data.nodes.filter(n => n.role === 'lipsync'))
      assert.ok(
        r.data.edges.some(e => e.source === singer.id && e.target === t.id),
        `${t.name} re-wired to the designed singer`,
      );

    // --- A spoken song: the vocal sets the timecodes, the CSV only says what each shot shows ---
    if (spoken) {
      r = await api('/api/nodes', 'POST', { kind: 'music' });
      const sid = r.data.nodes.find(n => n.kind === 'music' && n.id !== id).id;
      r = await api('/api/upload', 'POST', {
        nodeId: sid,
        kind: 'audio',
        name: 'spoken.wav',
        mime: 'audio/wav',
        base64: fs.readFileSync(spoken).toString('base64'),
        duration: SPOKEN_SECS,
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      // The master prompt to paste, with this song's facts: exact length + the official lyrics.
      await api('/api/node', 'PATCH', { id: sid, lyrics: SPOKEN.map(l => l.text).join('\n') });
      r = await api(`/api/music/deep-prompt?id=${sid}`);
      assert.ok(r.data.prompt.includes(SHOT_LIST_HEADER), 'the standard header');
      const totalDur = r.data.prompt.match(/TOTAL_DURATION = \d\d:\d\d\.\d{3} \(= ([\d.]+) giây\)/);
      assert.ok(totalDur, 'the song length is in the prompt');
      near(Number(totalDur[1]), SPOKEN_SECS, 0.2, 'measured from the file');
      assert.match(r.data.prompt, /LỜI CHÍNH THỨC[^\n]*\nThe river carries us home tonight\./);

      // The standard shot list, its timecodes ~1.5 s off. The separation starts as the song is
      // uploaded; the import waits for it, reads every line on the vocal, re-times the rows and cuts
      // the lip-sync takes — one pick of the file. Four sung lines (one of them given to the
      // audience, which the lip-sync stream still sings) become two takes of 7–10 s.
      const SH =
        SHOT_LIST_HEADER +
        '\n' +
        '001,00:00.000,00:03.500,Intro,,NO,2,"stillness — dark hall, one warm lamp",Stage,Main stage,EWS,eye level,locked,Lamp glows on an empty stage\n' +
        '002,00:03.500,00:06.000,Verse,The river carries us home tonight.,YES,4,"quiet hope — soft eyes, small smile; gentle, close to the mic",Singer,Main stage,MCU,3/4,slow push-in,Singer steps into the light\n' +
        '003,00:06.000,00:08.000,Verse,,NO,4,"warmth — relaxed hands",Pianist,Main stage,CU,profile,dolly left,Hands roll a soft chord\n' +
        '004,00:08.000,00:10.500,Verse,And every light is shining for you.,YES,6,"open joy — chin lifted, eyes bright; full voice",Singer,Main stage,CU,eye level,orbit,Lights bloom behind the singer\n' +
        '005,00:10.500,00:13.500,Chorus,,NO,4,"afterglow — haze settles",Stage,Main stage,WS,high,locked,Light spills over the rows\n' +
        '006,00:13.500,00:16.000,Chorus,We walk the quiet road again.,NO,5,"recognition — tears held back",Audience,Main stage,CU,front,locked,A listener leans in\n' +
        '007,00:16.000,00:19.000,Chorus,,NO,4,"warmth — relaxed hands",Pianist,Main stage,CU,side,dolly right,Chords roll under the line\n' +
        '008,00:19.000,00:21.000,Chorus,And morning finds us singing.,YES,7,"open joy — chin lifted, eyes bright; full voice",Singer,Main stage,MCU,eye level,locked,Singer lifts the last line\n' +
        '009,00:21.000,00:22.000,Outro,,NO,2,"afterglow — haze settles",Stage,Main stage,WS,rear,pull-out,Lights fade';
      const importSh = async extra => {
        const x = await api('/api/music/import', 'POST', {
          id: sid,
          csv: SH,
          replaceShots: true,
          targetSeconds: 0,
          ...extra,
        });
        assert.equal(x.status, 200, JSON.stringify(x.data));
        const prod = x.data.nodes
          .filter(n => n.zone === 'production' && !n.terminal)
          .sort((a, b) => a.start - b.start);
        return { data: x.data, prod, byRow: k => prod.find(n => n.parts[0].shot === k) };
      };
      r = await api('/api/music/vocals', 'POST', { id: sid });
      assert.equal(r.data.nodes.find(n => n.id === sid).vocalTask.status, 'running');
      let im = await importSh({});
      const song2 = im.data.nodes.find(n => n.id === sid);
      assert.ok(song2.vocals, 'the import waited for the separation');
      const rt = im.data.importSummary.retime;
      assert.deepEqual(im.data.importSummary.lyricsCheck, { ok: true, words: 24 }, 'same words');
      assert.equal(rt.sungRows, 4);
      assert.equal(rt.aligned, 4, JSON.stringify(rt));
      assert.equal(im.prod.length, 9);
      assert.equal(im.prod[0].start, 0);
      for (let i = 1; i < im.prod.length; i++)
        near(im.prod[i].start, im.prod[i - 1].start + im.prod[i - 1].duration, 0.002, 'tiled');
      near(im.prod[8].start + im.prod[8].duration, SPOKEN_SECS, 0.2, 'to the end of the song');
      for (const [k, at] of [
        ['002', spokenAt[0]],
        ['004', spokenAt[1]],
        ['006', spokenAt[2]],
        ['008', spokenAt[3]],
      ]) {
        const s = im.byRow(k),
          beat = s.parts[0];
        near(beat.sungStart, at, 0.3, `row ${k}: its line read on the vocal`);
        assert.ok(
          s.start <= beat.sungStart && s.start + s.duration >= beat.sungEnd,
          `row ${k} holds its whole line`,
        );
        near(s.start, beat.sungStart - 0.25, 0.002, `row ${k} opens just before the voice`);
      }
      assert.equal(im.byRow('002').parts[0].csvStart, 3.5, 'the CSV time remembered');
      assert.equal(song2.retimeInfo.aligned, 4);
      // what the performer feels and where the shot is go into its prompt
      assert.match(im.byRow('002').videoPrompt, /Singer at Main stage\. MCU shot/);
      assert.match(im.byRow('002').videoPrompt, /Emotion: quiet hope — soft eyes, small smile/);
      // The GPU reading of the lines, kept on the song …
      const lt = song2.lyricTiming;
      assert.equal(lt.lines.length, 4, 'the instrumental rows are not read');
      assert.equal(lt.aligned, 4);
      near(lt.lines[0].start, spokenAt[0], 0.3, 'line 1 read where it is said');
      assert.equal(lt.lines[0].csvStart, 3.5, 'the CSV time kept to compare');
      assert.equal(lt.csvOff, 4, 'every CSV line is more than 1 s off');
      assert.deepEqual(
        lt.lines.map(l => l.section),
        ['Verse', 'Verse', 'Chorus', 'Chorus'],
        'the section of every line is kept (a take never crosses one)',
      );
      // … downloadable as a LYRIC TIMING CSV (GPU times, confidence, the CSV time it replaces)
      const dl = await fetch(`http://127.0.0.1:${PORT}/api/music/lyric-timing.csv?id=${sid}`);
      assert.equal(dl.status, 200);
      assert.match(dl.headers.get('content-disposition'), /LYRIC_TIMING_GPU\.csv/);
      const gpuRows = parseCsv(await dl.text());
      assert.equal(gpuRows.length, 4);
      assert.equal(gpuRows[1]['Exact Lyric'], 'And every light is shining for you.');
      near(parseTime(gpuRows[1].Start), spokenAt[1], 0.3, 'GPU time in the CSV');
      assert.equal(gpuRows[1].CSV_Start, '00:08.000');
      assert.ok(Number(gpuRows[1].Shift_s) < -1, 'the shift from the CSV');
      // … and the lip-sync takes cut on those same readings: the four lines merged into two windows
      // of 7–10 s, each one shot size and one keyframe, each line timed inside its take.
      const tk = im.data.importSummary.takes;
      assert.equal(tk.takes, 2, JSON.stringify(tk));
      assert.equal(tk.created, 2);
      assert.equal(tk.aligned, 4, 'all four lines were read on the vocal');
      assert.equal(tk.sungLines, 4);
      assert.equal(tk.short, 0, JSON.stringify(tk));
      assert.equal(typeof tk.capped, 'number', 'the panel can say how many hit the ceiling');
      assert.equal(tk.min, 7);
      assert.equal(tk.max, 10);
      const takes2 = im.data.nodes
        .filter(n => n.role === 'lipsync' && n.musicId === sid)
        .sort((a, b) => a.clipStart - b.clipStart);
      assert.deepEqual(
        takes2.map(t => t.lsKey),
        ['002+2', '006+2'],
      );
      // every take 7–10 s (a snap to the real vocal edges may add up to SNAP on a side), no two
      // takes overlapping, every sung line in exactly one take
      for (const t of takes2) {
        const d = t.clipEnd - t.clipStart;
        assert.ok(d >= TAKE_MIN - 0.05 && d <= TAKE_MAX + 0.5, `${t.name} is 7–10 s: ${d}`);
      }
      assert.ok(takes2[1].clipStart >= takes2[0].clipEnd - 1e-9, 'the two takes do not overlap');
      assert.deepEqual(
        takes2.flatMap(t => t.lsKeys),
        ['002', '004', '006', '008'],
        'every sung line belongs to exactly one take, in the order sung',
      );
      assert.deepEqual(
        takes2.map(t => t.section),
        ['Verse', 'Chorus'],
        'the section comes from the GPU reading of its lines',
      );
      assert.equal(takes2[0].align.start, im.byRow('002').parts[0].sungStart, 'no second reading');
      assert.ok(
        takes2[0].clipStart <= takes2[0].align.start &&
          takes2[0].clipEnd >= takes2[0].lsLines[1].end,
        'the take covers both of its lines',
      );
      for (const t of takes2) {
        assert.ok(
          t.lsLines[0].at >= 0 && t.lsLines[0].at < 1,
          'the first line opens the clip, right after its pre-roll: ' + t.lsLines[0].at,
        );
        assert.ok(t.lsLines[1].at > t.lsLines[0].at, 'the second line comes later in the clip');
        near(
          t.clipStart + t.lsLines[1].at,
          t.lsLines[1].start,
          0.001,
          'each line is timed from the clip start',
        );
      }
      // Take 2 opens on the AUDIENCE row 006, but luồng B never borrows a coverage row's framing or
      // feeling: the tool gives it one frontal shot size (rotation: take 2 → CU), eye level, and the
      // feeling of its own SINGER line (008), never the audience's "recognition".
      assert.equal(takes2[1].lsLines[0].key, '006');
      assert.equal(takes2[1].subject, 'Singer');
      assert.equal(takes2[1].shotSize, 'CU');
      assert.equal(takes2[1].angle, 'eye level');
      assert.equal(
        takes2[1].parts[0].location,
        '',
        'wired to the main stage, not the coverage set',
      );
      assert.equal(takes2[1].lsNote, '', 'the singer rows carry a delivery: nothing to warn about');
      assert.equal(takes2[1].parts.length, 1, 'one framing, one keyframe');
      // the keyframe shows the SINGER's feeling (row 008), not the audience row's
      assert.match(
        takes2[1].prompt,
        /Expression: open joy — chin lifted, eyes bright\. The singer/,
        takes2[1].prompt,
      );
      assert.ok(
        !/recognition — tears held back/.test(takes2[1].prompt),
        'never the audience row’s emotion on the singer’s keyframe',
      );
      // Omni gets every line with its own feeling AND delivery (how it is sung), and is told the
      // whole take is one unbroken shot; a still source cannot orbit, so take 1's "slow push-in"
      // stays and take 2's "locked" stays.
      assert.match(
        takes2[0].videoPrompt,
        /\d\.\ds: "The river carries us home tonight\." — feeling and delivery: quiet hope — soft eyes, small smile; gentle, close to the mic/,
      );
      assert.match(
        takes2[0].videoPrompt,
        /\d\.\ds: "And every light is shining for you\." — feeling and delivery: open joy — chin lifted, eyes bright; full voice/,
      );
      assert.match(takes2[0].videoPrompt, /ONE continuous unbroken take from ONE camera/);
      assert.match(takes2[0].videoPrompt, /camera: slow push-in\./);
      assert.match(takes2[1].videoPrompt, /camera: slow push-in\./);
      // A re-cut on the same vocal and the same storyboard changes nothing.
      const takeSig = t =>
        JSON.stringify([
          t.lsKey,
          t.lsKeys,
          t.clipStart,
          t.clipEnd,
          t.lsSig,
          t.videoPrompt,
          t.prompt,
          t.stale ?? null,
        ]);
      const sigBefore = takes2.map(takeSig);
      r = await api('/api/music/lipsync', 'POST', { id: sid });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.lipsyncSummary.created, 0);
      assert.equal(r.data.lipsyncSummary.updated, 2);
      assert.equal(r.data.lipsyncSummary.removed, 0);
      assert.deepEqual(
        r.data.nodes
          .filter(n => n.role === 'lipsync' && n.musicId === sid)
          .sort((a, b) => a.clipStart - b.clipStart)
          .map(takeSig),
        sigBefore,
        're-cutting the same input changes nothing',
      );
      // Re-importing keeps a shot's keyframe when a new shot opens on the same CSV row.
      ff(['-f', 'lavfi', '-i', 'color=c=green:s=64x36', '-frames:v', '1', path.join(tmp, 'g.png')]);
      r = await api('/api/upload', 'POST', {
        nodeId: im.byRow('002').id,
        kind: 'image',
        mime: 'image/png',
        base64: PNG(path.join(tmp, 'g.png')),
      });
      const frame = r.data.nodes.find(n => n.id === im.byRow('002').id).image.id;
      // Without re-timing the CSV timecodes are kept (and no takes are cut on guessed times).
      im = await importSh({ retime: false });
      assert.equal(im.data.importSummary.retime, null);
      assert.equal(im.data.importSummary.takes, null);
      assert.equal(im.byRow('002').start, 3.5, 'CSV time kept');
      assert.equal(im.byRow('002').image?.id, frame, 'keyframe carried to the new shot');
      assert.equal(im.data.importSummary.keyframesKept, 1);
      assert.equal(im.data.importSummary.keyframesHad, 1);
      // Another CSV numbered alike: row 002 now shows another framing and feeling. Its old
      // keyframe does not carry over, and the take of that line needs a new keyframe.
      r = await api('/api/upload', 'POST', {
        nodeId: takes2[0].id,
        kind: 'image',
        mime: 'image/png',
        base64: PNG(path.join(tmp, 'g.png')),
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const SH2 = SH.replace(
        '"quiet hope — soft eyes, small smile; gentle, close to the mic",Singer,Main stage,MCU,3/4,slow push-in',
        '"aching doubt — eyes closed, brow tight; fragile",Singer,Main stage,CU,eye level,locked',
      );
      assert.notEqual(SH2, SH);
      im = await importSh({ csv: SH2 });
      assert.equal(im.data.importSummary.keyframesHad, 1);
      assert.equal(im.data.importSummary.keyframesKept, 0, 'no old picture on a different row');
      assert.equal(im.byRow('002').image, null);
      const take002 = im.data.nodes.find(n => n.id === takes2[0].id);
      assert.equal(take002.stale, true, 'the take keyframe is out of date');
      assert.match(take002.prompt, /MCU shot, eye level angle.*Expression: aching doubt/);
      assert.equal(
        im.data.nodes.find(n => n.id === takes2[1].id).stale,
        undefined,
        'the unchanged line keeps its take as it was',
      );
      // A new song on the node: the old vocals and their reading no longer apply.
      r = await api('/api/upload', 'POST', {
        nodeId: sid,
        kind: 'audio',
        name: 'song.wav',
        mime: 'audio/wav',
        base64: fs.readFileSync(song).toString('base64'),
        duration: SONG_SECS,
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const swapped = r.data.nodes.find(n => n.id === sid);
      assert.equal(swapped.vocals, null);
      assert.equal(swapped.lyricTiming, null);
    } else
      console.log(
        'SKIP: re-timed import + takes on a spoken vocal (needs speech synthesis + torchaudio)',
      );
  }
  console.log(
    'PASS: forced alignment of spoken lines (real speech, en) + language guess + fallback on a voiceless vocal, vocal reading (adaptive level, breath bridged, click dropped), snapping each sung line to ' +
      'the real vocal edges + silence-only handles, Omni Flash video-to-video request, real ffmpeg ' +
      'mux of keyframe + vocal cut (2 s minimum), ' +
      (demucs
        ? 'real Demucs separation (background task + progress), takes from EVERY sung line of the ' +
          'storyboard merged into 7–10 s windows (one shot size, one keyframe, singer + stage + ' +
          'style wired, every line timed in the Omni prompt), source video previewed = sent, ' +
          'Omni render → clip in ⑫ at its song time, re-read keeps takes, re-cut outdates clips, ' +
          'batch render of ready takes, the two edit manifests (luồng A rows per coverage shot, ' +
          'luồng B rows per take with the exact clip file name the ZIP holds, 25 fps timecode) ' +
          'and the .srt read from luồng B, cast designed after the takes re-wires them' +
          (spoken
            ? ', master prompt with the song facts (header, exact length, official lyrics), one ' +
              'pick of the standard CSV: import waits for the separation, reads every line on the ' +
              'vocal (GPU timing kept + CSV download), re-times the rows (tile the song, each sung ' +
              'row holds its line), emotion + location in the prompts, lip-sync takes cut on the ' +
              'same reading (7–10 s each, no overlap, every sung line in exactly one take, the ' +
              'framing from the singer’s own row, section per line, a re-cut changes nothing); ' +
              'keyframe carried over on re-import of the same CSV but not to another ' +
              'CSV numbered alike (its changed take marked out of date); hyphens in lyrics do not ' +
              'break the reading; a new song drops the old vocals'
            : '')
        : 'server flow SKIPPED (no Demucs)'),
  );
} finally {
  proc.kill();
  mock.close();
  llm.close();
}
