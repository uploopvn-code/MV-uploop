// Lip-sync takes for Omni Flash (video-to-video). The pipeline:
// 1. separate the vocals from the song (Demucs, local — on the GPU when there is one);
// 2. read the isolated vocal: where the singer really sings (voice activity), and snap every sung
//    line of the imported storyboard to those real edges;
// 3. group those lines into 7–10 s takes (groupLines), cut each take's vocal (with a little silence
//    on either side) and mux it with the take's keyframe into a still-image video — the source Omni
//    Flash makes the singer sing to.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNode } from './nodes.mjs';
import { mediaDir } from './projects.mjs';
import { faceOf } from './shotlist.mjs';

const PYTHON = () => process.env.MV_PYTHON || 'python';
const FFMPEG = () => process.env.MV_FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.MV_FFPROBE || 'ffprobe';
// htdemucs_6s isolates vocals as well as htdemucs and is usually already in the torch cache (no
// download); override with MV_DEMUCS_MODEL (htdemucs, htdemucs_ft, mdx_extra…).
const DEMUCS_MODEL = () => process.env.MV_DEMUCS_MODEL || 'htdemucs_6s';

// Runs a command (no shell); resolves { code, stdout: Buffer, stderr }. onErr sees stderr as it
// arrives — Demucs reports its progress there.
function exec(cmd, args, { onErr } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    const out = [];
    let err = '';
    p.stdout.on('data', c => out.push(c));
    p.stderr.on('data', c => {
      const s = c.toString();
      err = (err + s).slice(-20000);
      onErr?.(s);
    });
    p.on('error', reject);
    p.on('close', code => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
  });
}
const lastLines = s =>
  String(s || '')
    .split(/\r?\n|\r/)
    .map(x => x.trim())
    .filter(x => x && !/\d+%\|/.test(x))
    .slice(-3)
    .join(' | ');
const round3 = n => Math.round(n * 1000) / 1000;

// --- 1. Vocal separation ----------------------------------------------------------------------

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (e.name === name) return p;
  }
  return null;
}
// Splits the song into vocals / accompaniment and keeps the vocals as a WAV in `outDir` (the
// project's media folder, captured by the caller so a project switch mid-run cannot misfile it).
// A Windows native crash (NTSTATUS, e.g. 0xC0000409) or a signal — seen now and then while CUDA
// starts up — rather than Demucs refusing the input: worth another try.
const crashed = r => r.code === null || r.code > 255 || r.code < 0;
export async function separateVocals(audioFile, outDir, onProgress = () => {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-demucs-'));
  const model = DEMUCS_MODEL();
  try {
    let last = -1;
    const attempt = device =>
      exec(
        PYTHON(),
        [
          '-m',
          'demucs',
          '--two-stems=vocals',
          '-n',
          model,
          ...(device ? ['-d', device] : []),
          '-o',
          tmp,
          audioFile,
        ],
        {
          onErr: s => {
            const m = [...s.matchAll(/(\d{1,3})%\|/g)].at(-1);
            if (m && Number(m[1]) !== last) onProgress((last = Number(m[1])));
          },
        },
      ).catch(e => {
        throw new Error(
          e.code === 'ENOENT'
            ? 'Không chạy được Python. Cài Python + "pip install demucs" (hoặc đặt biến MV_PYTHON).'
            : e.message,
        );
      });
    // The default device (GPU when there is one), once more on a crash, then the CPU (slower).
    let r = await attempt(null);
    if (crashed(r)) r = await attempt(null);
    if (crashed(r)) r = await attempt('cpu');
    if (r.code !== 0)
      throw new Error(
        'Demucs lỗi: ' +
          (lastLines(r.stderr) || 'mã ' + r.code) +
          (/No module named demucs/.test(r.stderr) ? ' — chạy "pip install demucs".' : ''),
      );
    const found = findFile(tmp, 'vocals.wav');
    if (!found) throw new Error('Demucs không tạo ra file vocals.wav.');
    const id = crypto.randomUUID() + '.wav';
    fs.copyFileSync(found, path.join(outDir, id));
    return { id, url: '/media/' + id, mime: 'audio/wav', name: 'vocals.wav', model };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- 2. Reading the vocal ---------------------------------------------------------------------

export const HOP = 0.02; // 20 ms frames
// Voice activity of an isolated vocal: a frame is "sung" when its level clears an adaptive
// threshold between the track's silence floor and its loud singing. Dropouts inside a phrase
// (consonants, quick breaths < 150 ms) are bridged and blips < 80 ms (bleed, clicks) dropped.
export function activityFromPcm(buf, rate) {
  const per = Math.round(rate * HOP);
  const frames = Math.floor(Math.floor(buf.length / 2) / per);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = 0; i < per; i++) {
      const v = buf.readInt16LE((f * per + i) * 2) / 32768;
      s += v * v;
    }
    db[f] = 10 * Math.log10(s / per + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const pct = q =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : -120;
  const floor = pct(0.1),
    loud = pct(0.95);
  const threshold = Math.max(floor + 10, loud - 30);
  const mask = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) mask[f] = db[f] > threshold ? 1 : 0;
  bridge(mask, 0, Math.round(0.15 / HOP)); // short gaps inside a phrase → sung
  bridge(mask, 1, Math.round(0.08 / HOP)); // short blips in a silence → silent
  return { hop: HOP, mask, duration: round3(frames * HOP), threshold };
}
// Flips runs of `value` shorter than `max` frames that sit between runs of the other value.
function bridge(mask, value, max) {
  for (let i = 0; i < mask.length;) {
    if (mask[i] !== value) {
      i++;
      continue;
    }
    let j = i;
    while (j < mask.length && mask[j] === value) j++;
    if (i > 0 && j < mask.length && j - i < max) mask.fill(1 - value, i, j);
    i = j;
  }
}
export async function vocalActivity(file) {
  const r = await exec(FFMPEG(), [
    '-v',
    'error',
    '-i',
    file,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    's16le',
    '-',
  ]).catch(e => {
    throw new Error(e.code === 'ENOENT' ? 'Không tìm thấy ffmpeg (đặt MV_FFMPEG).' : e.message);
  });
  if (r.code !== 0) throw new Error('ffmpeg không đọc được vocal: ' + lastLines(r.stderr));
  return activityFromPcm(r.stdout, 16000);
}

// How far a storyboard boundary may move to meet the real vocal, and the silence kept around
// the sung line (so the mouth starts and ends closed) — never reaching into another line's voice.
export const SNAP = 0.5,
  PRE = 0.15,
  POST = 0.3;
// A take is one unbroken lip-sync performance to edit with, not a two-second fragment: whole sung
// lines are merged until the take lasts at least TAKE_MIN, and it never runs past TAKE_MAX. Omni
// Flash gives back a clip exactly as long as its source, so these are the only limits on it.
export const TAKE_MIN = 7,
  TAKE_MAX = 10;
// Two lines are only merged into one take when the silence between them is short: a long pause
// (> GAP_MAX seconds) means they are separate thoughts and each gets its own take, even if that
// leaves a take shorter than TAKE_MIN.
export const GAP_MAX = 3;
// A short, single-line take (voice shorter than LEAD_SHORT s — one brief phrase left on its own by a
// pause or a section change) is widened with a LEAD-IN before the first word and a LEAD-OUT after the
// last, centring the voice in a LEAD_CLIP_MIN…LEAD_CLIP_MAX s reference clip so Omni has room to show
// the singer breathe in before the line and let the note ring out after it (never frozen at the
// ends). The lead only grows into real silence, so it is smaller when the voice sits near a neighbour.
export const LEAD_DEFAULT = 2, // seconds of lead we try to add on EACH side
  LEAD_SHORT = 6, // a take with voice shorter than this gets the lead-in / lead-out
  LEAD_CLIP_MIN = 8,
  LEAD_CLIP_MAX = 10,
  LEAD_SHOW = 0.8; // omniPrompt writes the timecoded head/tail once a lead reaches this length
// The lead a short take of `voiceSpan` seconds asks for on EACH side before silence limits it:
// enough to centre the voice in a LEAD_CLIP_MIN…LEAD_CLIP_MAX s clip, LEAD_DEFAULT s by default
// (e.g. a 6 s line → 2 s + 2 s = 10 s; a 3 s line → 2.5 s each to reach the 8 s floor). 0 when the
// voice is already LEAD_SHORT s or longer (a full-length take needs no lead).
export function leadEach(voiceSpan) {
  if (voiceSpan > LEAD_SHORT + 1e-9) return 0; // a 6 s line still qualifies; a 6.5 s one does not
  const target = Math.min(LEAD_CLIP_MAX, Math.max(LEAD_CLIP_MIN, voiceSpan + 2 * LEAD_DEFAULT));
  return round3(Math.max(0, (target - voiceSpan) / 2));
}

// The sung lines (in the order sung, each { key, lyric, start, end, section, location }) grouped
// into takes: a take opens on a line and keeps taking the next one while it is still shorter than
// `min` and that line would not carry it past `max`. A line is never split in two, and a take never
// runs across a change of section or of set — a merged take stays one place and one part of the
// song. Each group: { lines, start, end, stop, capped, over }, where `stop` says why it closed,
// `capped` that the next line would have passed `max`, and `over` that this one line alone is
// longer than `max` (it stays whole: splitting it would cut the voice mid-word).
export function groupLines(lines, { min = TAKE_MIN, max = TAKE_MAX } = {}) {
  const key = s =>
    String(s || '')
      .trim()
      .toLowerCase();
  const out = [];
  for (let i = 0; i < lines.length;) {
    const first = lines[i];
    // A take is one singer in one place by construction, so it only ever breaks on a change of
    // song section — never on a coverage row's Location (that is a camera position in luồng A).
    let j = i,
      end = first.end,
      section = key(first.section),
      stop = 'end';
    while (j + 1 < lines.length) {
      if (end - first.start >= min) {
        stop = 'min';
        break;
      }
      const next = lines[j + 1];
      if (section && key(next.section) && key(next.section) !== section) {
        stop = 'section';
        break;
      }
      // A long pause between this line and the next means they are not one phrase — don't merge
      // them (keep each sung line whole, even if the take ends up shorter than TAKE_MIN).
      if (next.start - end > GAP_MAX) {
        stop = 'gap';
        break;
      }
      if (next.end - first.start > max) {
        stop = 'max';
        break;
      }
      j++;
      end = next.end;
      section = section || key(next.section);
    }
    out.push({
      lines: lines.slice(i, j + 1),
      start: first.start,
      end,
      stop,
      capped: stop === 'max',
      over: end - first.start > max,
    });
    i = j + 1;
  }
  return out;
}

// For each take's window [start, end] (its sung lines, aligned to the vocal, else from the
// storyboard), the edges where the singer really starts and stops — a phrase onset/offset within
// ±snap (the window's own `snap`, else SNAP), preferring the one with the longest silence beside it
// (a line break, not a breath inside the line); the mark stays when the vocal shows no clear break
// there (legato) — and the cut sent to Omni: those edges widened into the silence around them by
// PRE / POST seconds, and further (while `padTo` asks for a longer take) but never past the
// window's `lo` / `hi` (the middle of the silence to the take beside it, so two takes cannot
// overlap), never past `max` seconds, and never into a voice. (`max` holds the widening only: a
// window the snap itself stretches past it keeps its real edges — a take never cuts a word.)
// `voiced` = share of the whole window (every line it holds, and the breaths between them) where a
// voice is heard.
export function refineTakes(windows, act) {
  const { hop, mask, duration } = act;
  const N = mask.length;
  const sung = t => (N ? mask[Math.max(0, Math.min(N - 1, Math.floor(t / hop + 1e-6)))] : 0);
  const on = [],
    off = [];
  for (let i = 0; i < N; i++) {
    if (mask[i] && (i === 0 || !mask[i - 1])) on.push(i);
    if (mask[i] && (i === N - 1 || !mask[i + 1])) off.push(i + 1);
  }
  // silence before an onset / after an offset (frames), capped at 1 s
  const cap = Math.round(1 / hop);
  const gapBefore = k => Math.min(cap, k ? on[k] - off[k - 1] : on[k]);
  const gapAfter = k => Math.min(cap, k < off.length - 1 ? on[k + 1] - off[k] : N - off[k]);
  const pick = (edges, gap, t, snap) => {
    let best = null,
      score = -Infinity;
    edges.forEach((e, k) => {
      const x = e * hop;
      if (Math.abs(x - t) > snap) return;
      const sc = gap(k) * hop - 0.5 * Math.abs(x - t);
      if (sc > score) {
        score = sc;
        best = x;
      }
    });
    return best;
  };
  return windows.map(w => {
    const lo = Math.max(0, w.lo ?? 0),
      hi = Math.min(duration || Infinity, w.hi ?? Infinity),
      maxLen = w.max ?? Infinity,
      padTo = Math.min(w.padTo ?? 0, maxLen);
    const snap = w.snap ?? SNAP;
    const s0 = pick(on, gapBefore, w.start, snap),
      e0 = pick(off, gapAfter, w.end, snap);
    let s = s0 ?? w.start,
      e = e0 ?? w.end;
    if (e - s < 0.2) {
      s = w.start;
      e = w.end;
    }
    // A snap may not cross lo / hi either: that is the half of the silence belonging to the take
    // beside this one, and two takes may never overlap.
    s = Math.max(s, lo);
    e = Math.min(e, hi);
    let voiced = 0,
      total = 0;
    for (let t = s; t < e - 1e-9; t += hop) {
      total++;
      voiced += sung(t);
    }
    const fits = (a, b) => b - a <= maxLen + 1e-9;
    // The cut must cover the WHOLE aligned line span so a sentence is never clipped: start the cut
    // window at [w.start, w.end] (clamped to lo / hi), even if a snap moved the voiced edge inward.
    // The widening below then adds the silence handles from here, still bounded by max / lo / hi.
    let cs = Math.min(s, Math.max(lo, w.start)),
      ce = Math.max(e, Math.min(hi, w.end));
    while (cs - hop >= Math.max(lo, s - PRE) - 1e-9 && !sung(cs - hop) && fits(cs - hop, ce))
      cs -= hop;
    const limit = Math.min(hi, e + POST);
    while (ce + hop <= limit + 1e-9 && !sung(ce) && fits(cs, ce + hop)) ce += hop;
    // Lead-in / lead-out for a short reference clip: grow further to the lead the window asked for on
    // each side — the breath before the first word, the note ringing out after the last. This is the
    // NON-lip-sync performance window, so (unlike the silence-only handles above) it may run through
    // the singer's OWN sustain, breath or a little backing — that is exactly the "ngân/nhả" it should
    // show. It is bounded only by lo / hi (the midpoint to the neighbour take, which always sits
    // before the neighbour's words, so no other line's voice can enter) and by max; never by silence.
    // (No-op when the window asks for no lead: the target then equals the current edge.)
    const headTo = w.leadIn ? Math.max(lo, s - w.leadIn) : cs;
    while (cs - hop >= headTo - 1e-9 && fits(cs - hop, ce)) cs -= hop;
    const tailTo = w.leadOut ? Math.min(hi, e + w.leadOut) : ce;
    while (ce + hop <= tailTo + 1e-9 && fits(cs, ce + hop)) ce += hop;
    // Still shorter than a take should be (one short line, or lines with little voice): keep
    // growing into the silence, one frame at a time and each side in turn, as far as it may go.
    for (let grew = true; grew && ce - cs < padTo - 1e-9;) {
      grew = false;
      if (ce + hop <= hi + 1e-9 && !sung(ce) && fits(cs, ce + hop)) {
        ce += hop;
        grew = true;
      }
      if (ce - cs >= padTo - 1e-9) break;
      if (cs - hop >= lo - 1e-9 && !sung(cs - hop) && fits(cs - hop, ce)) {
        cs -= hop;
        grew = true;
      }
    }
    return {
      lsStart: round3(s),
      lsEnd: round3(e),
      clipStart: round3(Math.max(0, cs)),
      clipEnd: round3(ce),
      snappedStart: s0 !== null && s0 !== undefined && s === s0,
      snappedEnd: e0 !== null && e0 !== undefined && e === e0,
      voiced: total ? round3(voiced / total) : 0,
    };
  });
}

// Forced alignment of the song's sung lines — every one, in the order sung — to the isolated vocal
// (tools/align_lyrics.py: a wav2vec2 CTC speech model + torchaudio forced_align). Each line comes
// back with the time it is really sung and a confidence (0–1). A storyboard made by an LLM can be
// seconds off; this puts every line where the voice actually is. Throws when it cannot run.
const TOOLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const ALIGNER = path.join(TOOLS, 'align_lyrics.py');

// The music profile (tools/mv_profile.py): one Demucs 6-stem pass → which instruments are audible
// (Guitarist / Pianist / Drummer / Bassist), the song's loudness curve → Energy per time, the feel
// (slow / fast) from word density. It also drops the vocal it separated into `outDir` so the import
// can re-use it (no second Demucs). Degrades on a crash to the CPU. Returns { profile, vocals }.
export async function musicProfile(audioFile, { lyricsText, outDir, onProgress = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-profile-'));
  const vid = crypto.randomUUID() + '.wav';
  try {
    const outJson = path.join(dir, 'profile.json');
    const vocalsOut = path.join(outDir, vid);
    const args = [path.join(TOOLS, 'mv_profile.py'), audioFile, outJson, '--vocals-out', vocalsOut];
    if (lyricsText && lyricsText.trim()) {
      const lf = path.join(dir, 'lyric.txt');
      fs.writeFileSync(lf, lyricsText, 'utf8');
      args.push('--lyric', lf);
    }
    const attempt = device =>
      exec(PYTHON(), device ? [...args, '--device', device] : args, {
        onErr: s => {
          const m = [...s.matchAll(/(\d{1,3})%\|/g)].at(-1);
          if (m) onProgress(Number(m[1]));
        },
      }).catch(e => {
        throw new Error(
          e.code === 'ENOENT'
            ? 'Không chạy được Python. Cài Python + "pip install demucs" (hoặc đặt MV_PYTHON).'
            : e.message,
        );
      });
    let r = await attempt(null);
    if (crashed(r)) r = await attempt(null);
    if (crashed(r)) r = await attempt('cpu');
    if (r.code !== 0)
      throw new Error('Phân tích nhạc lỗi: ' + (lastLines(r.stderr) || 'mã ' + r.code));
    const profile = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    const vocals = fs.existsSync(vocalsOut)
      ? {
          id: vid,
          url: '/media/' + vid,
          mime: 'audio/wav',
          name: 'vocals.wav',
          model: 'htdemucs_6s', // mv_profile always uses the 6-stem model (it needs the instruments)
        }
      : null;
    return { profile, vocals };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
export async function alignLines(vocalsFile, lines, lang = 'es') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-align-'));
  try {
    const input = path.join(dir, 'lines.json'),
      output = path.join(dir, 'aligned.json');
    fs.writeFileSync(input, JSON.stringify(lines));
    const attempt = device =>
      exec(PYTHON(), [ALIGNER, vocalsFile, input, output, lang, ...(device ? [device] : [])]).catch(
        e => {
          throw new Error(e.code === 'ENOENT' ? 'Không chạy được Python để căn lời.' : e.message);
        },
      );
    // like Demucs: once more on a native crash, then the CPU
    let r = await attempt(null);
    if (crashed(r)) r = await attempt(null);
    if (crashed(r)) r = await attempt('cpu');
    if (r.code !== 0) throw new Error('Căn lời lỗi: ' + (lastLines(r.stderr) || 'mã ' + r.code));
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// A media file's exact length in seconds (the song's timeline ends there), or null.
export async function probeDuration(file) {
  const r = await exec(FFPROBE(), [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]).catch(() => null);
  const d = r && r.code === 0 ? Number(String(r.stdout).trim()) : NaN;
  return Number.isFinite(d) && d > 0 ? d : null;
}
// Which aligner suits the lyrics: Spanish or English (the two speech models wired in).
const ES = /\b(que|de|la|el|los|las|mi|yo|tu|te|se|lo|por|con|para|una?|es|del|al|pero|como)\b/g;
const EN = /\b(the|and|you|to|of|in|my|is|it|that|on|for|your|we|be|with|all|this|so|but)\b/g;
export function guessLang(text) {
  const t = String(text || '').toLowerCase();
  if (/[ñ¿¡]/.test(t)) return 'es';
  return (t.match(ES) || []).length > (t.match(EN) || []).length ? 'es' : 'en';
}
// Below this a line's alignment is noise (no recognisable voice there); below the median floor the
// whole alignment is (the vocal is not speech/singing in that language) and the storyboard marks stay.
export const ALIGN_MIN = 0.15,
  ALIGN_SURE = 0.5;

// --- 3. The source video Omni lip-syncs to ----------------------------------------------------

// Omni gives back a clip exactly as long as its source; a line shorter than this is padded with
// silence at the end (the clip still starts at clipStart, so it sits on the timeline the same).
export const MIN_INPUT = 2;
export async function muxTake({ image, vocals, start, end, outDir }) {
  const d = Math.max(0.1, end - start);
  const total = Math.max(MIN_INPUT, d);
  const id = crypto.randomUUID() + '.mp4';
  const r = await exec(FFMPEG(), [
    '-v',
    'error',
    '-y',
    '-loop',
    '1',
    '-framerate',
    '25',
    '-i',
    image,
    '-ss',
    start.toFixed(3),
    '-t',
    d.toFixed(3),
    '-i',
    vocals,
    '-filter_complex',
    `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[v];[1:a]apad=whole_dur=${total.toFixed(3)}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-r',
    '25',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    total.toFixed(3),
    '-movflags',
    '+faststart',
    path.join(outDir, id),
  ]).catch(e => {
    throw new Error(e.code === 'ENOENT' ? 'Không tìm thấy ffmpeg (đặt MV_FFMPEG).' : e.message);
  });
  if (r.code !== 0) throw new Error('ffmpeg không ghép được ảnh + vocal: ' + lastLines(r.stderr));
  return {
    id,
    url: '/media/' + id,
    mime: 'video/mp4',
    name: 'lipsync-input.mp4',
    duration: round3(total),
  };
}

// What a take's source video is made of: its keyframe, the song's vocal track and the cut.
export const lipsyncSig = n =>
  [n.image?.id, getNode(n.musicId)?.vocals?.id, n.clipStart, n.clipEnd].join('|');
// The take's source video, rebuilt whenever its keyframe, the vocals or the cut changed.
export async function ensureLipsyncInput(n) {
  const music = getNode(n.musicId);
  if (!music?.vocals) throw new Error('Chưa có vocal: tách vocal ở node MUSIC trước.');
  if (!n.image) throw new Error('Take chưa có ảnh khung (ca sĩ): tạo hoặc tải ảnh trước.');
  const sig = lipsyncSig(n);
  if (n.lsInput && n.lsInputSig === sig && fs.existsSync(path.join(mediaDir, n.lsInput.id)))
    return n.lsInput;
  n.lsInput = await muxTake({
    image: path.join(mediaDir, n.image.id),
    vocals: path.join(mediaDir, music.vocals.id),
    start: n.clipStart,
    end: n.clipEnd,
    outDir: mediaDir,
  });
  n.lsInputSig = sig;
  return n.lsInput;
}

// --- Prompts ----------------------------------------------------------------------------------

// What Omni Flash is asked to do with the take's source: sing the lines it hears, as is. A take
// holds several sung lines, so each one is listed with its offset from the take's first frame and
// with how it is felt and sung (`t.lsLines`, else the take's own single line) — and the model is
// told again that all of it is ONE unbroken take from one camera.
export function omniPrompt(t) {
  const lines = (
    Array.isArray(t.lsLines) && t.lsLines.length
      ? t.lsLines
      : [{ at: 0, lyric: t.lyric, emotion: t.emotion }]
  ).filter(l => String(l.lyric || '').trim());
  const script = lines
    .map(
      l =>
        `${Math.max(0, Number(l.at) || 0).toFixed(1)}s: ${JSON.stringify(l.lyric)}` +
        (l.emotion ? ` — feeling and delivery: ${l.emotion}` : ''),
    )
    .join('; ');
  const move = String(t.movement || '').trim() || 'steady cinematic push-in with a subtle handheld sway';
  const light = String(t.lighting || '').trim();
  // Lead-in / lead-out timeline: when the source clip is longer than the singing (a short take
  // widened into an 8–10 s reference clip), the head and tail hold the singer NOT lip-syncing — so
  // spell the timeline out in seconds and tell the model to perform, not freeze, in those windows.
  const r1 = x => Math.max(0, Math.round(x * 10) / 10);
  const hasClip = [t.clipStart, t.clipEnd, t.lsStart, t.lsEnd].every(x => typeof x === 'number');
  const headLead = hasClip ? r1(t.lsStart - t.clipStart) : 0;
  const tailLead = hasClip ? r1(t.clipEnd - t.lsEnd) : 0;
  const clipDur = hasClip ? r1(t.clipEnd - t.clipStart) : 0;
  const voiceEndIn = r1(clipDur - tailLead);
  const leadBlock =
    hasClip && (headLead >= LEAD_SHOW || tailLead >= LEAD_SHOW)
      ? `This is a ${clipDur.toFixed(1)}s reference clip and the singing does NOT fill it — follow this timeline exactly, in seconds from the first frame. ` +
        (headLead >= LEAD_SHOW
          ? `0.0–${headLead.toFixed(1)}s (LEAD-IN, before any singing): the singer is NOT lip-syncing yet — mouth gently closed, no words. They settle into the moment and draw a visible breath IN, chest and shoulders rising, a small natural sway and head movement, eyes lifting to meet the camera, the feeling building toward the first line. `
          : '') +
        `${headLead.toFixed(1)}–${voiceEndIn.toFixed(1)}s: the singing — lip-sync precisely to the vocal (the line timing below). ` +
        (tailLead >= LEAD_SHOW
          ? `${voiceEndIn.toFixed(1)}–${clipDur.toFixed(1)}s (LEAD-OUT, after the last word): the singer is NOT lip-syncing any more — they sustain and let the final note ring out, then ease off with a slow exhale, shoulders settling, holding the expression and the gaze into the camera while the body keeps a gentle sway; the mouth closes softly as the sound fades, no new words. `
          : '')
      : '';
  return (
    // 1) Lip-sync accuracy — the hard constraint — plus the per-line timing.
    'Make the singer in this video sing along to the vocal that plays in it. Precise lip-sync: the lips, jaw and cheeks move exactly with the vocal track, every syllable of every line landing on the audio — crisp consonants, natural vowel shapes, teeth and tongue visible on open sounds, soft breaths between phrases, no mumbling; the mouth rests gently closed in the silences between lines. ' +
    `${lines.length === 1 ? 'The line' : 'The ' + lines.length + ' lines'} of this take, timed from its first frame — ${script}. ` +
    // 1b) The head/tail timeline for a widened short reference clip (empty for a full-length take).
    leadBlock +
    // 2) One continuous take, same identity — but the set/background are free to move.
    'ONE continuous unbroken take from ONE camera: no cut, no edit, no change of shot size, framing or place from the first frame to the last. Keep the exact same person, face, hair, outfit and microphone as the source frame; identity-stable, no face morphing. ' +
    // 3) Expressive, full-body performance — stronger body sway, hand gestures and eye contact.
    'Expressive, emotional performance — never stiff or frozen: sing with real feeling that matches the delivery, eyes, eyebrows and cheeks fully engaged, the emotion swelling on the powerful words and easing on the tender ones; the gaze keeps meeting the lens — direct eye contact and small glances straight into the camera. The WHOLE BODY performs — the torso leans and tilts side to side, the head tilts, the shoulders rock and the weight shifts in a loose, natural sway and bounce to the beat (never rigid). The HANDS and ARMS move freely and LIFT in expressive gestures on the emphasised, emotional words — a hand rising toward the chest or reaching up/out toward the camera on the big notes, then relaxing. Living micro-movement in the neck, torso and hair, breaths lifting the chest and shoulders, natural blinks. Keep the BACKGROUND alive: any people or crowd behind sway, clap and react, stage elements, smoke and haze drift — nothing in the frame is static. ' +
    // 4) Camera move (one a single still frame can hold), a little more energetic now.
    `Camera: ${move}, shallow depth of field, filmic color grade, high detail. ` +
    // 5) Dynamic MOVING stage lighting with beams flaring toward camera to rim the singer.
    (light
      ? `Dynamic, MOVING stage lighting: ${light}. The lights sweep and flicker and beams flare toward the camera to rim-light the singer from behind, while the singer's face, hair and outfit stay unchanged. `
      : 'Dynamic, MOVING stage lighting: colored beams sweep the stage and flare toward the camera to rim-light the singer from behind, haze catching the light. ') +
    // 6) Extra direction the user asked the assistant to add to every lip-sync take.
    (String(t.lipsyncExtra || '').trim() ? `Additional direction: ${String(t.lipsyncExtra).trim()}. ` : '') +
    // 7) Audio hard constraint.
    'Keep the original audio exactly as it is: no added music, voices or sound effects. No text, no subtitles, no watermark.'
  );
}
// The keyframe a take starts from: ONE still frame of the take's one framing, the singer about to
// sing (mouth closed), so Omni drives every mouth movement from the audio. A merged take holds
// several lines but one shot, so the still shows the feeling of the first of them (faceOf keeps the
// first).
export function takeStill(t) {
  const cam = [
    t.shotSize && t.shotSize + ' shot',
    t.angle && t.angle + ' angle',
    t.lens && t.lens + ' lens',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    'Still keyframe, one photographic moment of this shot, not a sequence: ' +
    [t.subject || 'the singer', t.location && 'at ' + t.location, cam, t.action]
      .filter(Boolean)
      .join(', ') +
    // the feeling on the face only — how the line is sung would open the mouth Omni must open
    (faceOf(t.emotion) ? `. Expression: ${faceOf(t.emotion)}` : '') +
    '. The singer is about to sing, mouth relaxed and gently closed, face clearly visible — the frame a lip-sync performance starts from. Hold the moment; no motion blur, no text.'
  );
}
