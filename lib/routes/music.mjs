// Routes: the MUSIC node. It analyzes a song (YouTube link / file / lyrics) through the Director
// LLM, imports an externally-made analysis CSV into an exactly-timed storyboard (consolidated to
// ~8s merged shots, auto-wired to the cast + stage + style), and designs that cast (singer,
// musicians, stage, style) with the MV master prompt — merged into the graph without touching the
// imported shots.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEEP_MUSIC_ANALYSIS_PROMPT,
  MASTER_PROMPT,
  MUSIC_MASTER_PROMPT,
  buildGraph,
  parseBlueprint,
  parseMusicAnalysis,
} from '../../director.mjs';
import { defaultNaming } from '../../output-config.mjs';
import { parseCsv } from '../csv.mjs';
import {
  beatsFor,
  detectCsvKind,
  groupShots,
  partOf,
  retimeRows,
  rowsToSections,
  rowsToShots,
  splitLong,
} from '../shotlist.mjs';
import { directorLLM } from '../config.mjs';
import { runTurn, workerOnline } from '../director-web.mjs';
import {
  extractCsv,
  fillPrompt,
  fixPrompt,
  lyricSections,
  rowsToCsv,
  skeletonRows,
  validateFilled,
} from '../music-auto.mjs';
import { NEXT, body, json } from '../http.mjs';
import { createJob, requireIdle } from '../jobs.mjs';
import {
  ALIGN_MIN,
  ALIGN_SURE,
  POST,
  PRE,
  SNAP,
  TAKE_MAX,
  TAKE_MIN,
  alignLines,
  ensureLipsyncInput,
  groupLines,
  guessLang,
  musicProfile,
  omniPrompt,
  probeDuration,
  refineTakes,
  separateVocals,
  takeStill,
  vocalActivity,
} from '../lipsync.mjs';
import {
  deps,
  getNode,
  imageParents,
  isLipsync,
  isMusic,
  isSetting,
  isStageOnly,
} from '../nodes.mjs';
import { db, mediaDir, mutate, save, vocalTasks } from '../projects.mjs';
import { pump } from '../runner.mjs';
import { publicState } from '../public-state.mjs';
import { isGroup } from '../seedance.mjs';
import { isMerged } from '../merged.mjs';
import { LAYOUT_MAX, wireStageCast } from '../stage3d.mjs';
import { flagClips, markChildren, markStale } from '../staleness.mjs';
import { nextSeq, nodeZone } from '../zones.mjs';

// A node name that is still the auto default ("Nhạc" / "Nhạc (MUSIC)"): the title from the song
// may replace it, otherwise a user-chosen name is kept.
const isDefaultName = s =>
  !String(s || '').trim() || /^Nhạc(\s*\(MUSIC\))?$/i.test(String(s).trim());

// The LLM turn either runs through the ChatGPT extension (via "web") or the API key.
function requireLLM(via) {
  if (via !== 'web' && !directorLLM.configured())
    throw new Error('Chưa cấu hình API key LLM cho Đạo diễn, hoặc bật "Chạy qua extension".');
  if (via === 'web' && !workerOnline())
    throw new Error('Chưa thấy extension ChatGPT online. Mở tab ChatGPT và bật worker extension.');
}
const musicNode = id => {
  const n = getNode(id);
  if (!n || !isMusic(n)) throw new Error('Node nhạc không tồn tại.');
  return n;
};
// After a long wait (vocal separation, GPU reading, an LLM turn): the song node is still the one
// of the open project — else another project was opened meanwhile and nothing may be written.
const still = n => {
  if (getNode(n.id) !== n)
    throw new Error('Project đã đổi (hoặc node nhạc bị xóa) trong lúc xử lý — mở lại và làm lại.');
};
// The production shots that came from a CSV import (they remember their beats).
const csvShots = () =>
  db.nodes.filter(x => !x.terminal && nodeZone(x) === 'production' && Array.isArray(x.parts));

export async function handle(req, res, p, u) {
  if (p === '/api/music/analyze' && req.method === 'POST') {
    const b = await body(req);
    const n = musicNode(b.id);
    requireLLM(b.via);

    const url = String(n.youtubeUrl || '').trim();
    const lyrics = String(n.lyrics || '').trim();
    let title = String(n.name || '').trim();
    let durationSec = Number.isFinite(n.audioDuration) ? Math.round(n.audioDuration) : 0;
    if (!url && !lyrics && !n.audio)
      throw new Error('Điền link YouTube / lời bài hát, hoặc tải file nhạc trước khi phân tích.');

    // Best-effort: pull the real title + length from a YouTube link so the timing is anchored even
    // when no file was uploaded. Never fails the analysis.
    if (url && (!durationSec || isDefaultName(title))) {
      const meta = await fetchYouTubeMeta(url).catch(() => null);
      if (meta) {
        if (!durationSec && meta.lengthSeconds) durationSec = meta.lengthSeconds;
        if (meta.title && isDefaultName(title)) title = meta.title;
      }
    }

    const parts = [];
    if (title && !isDefaultName(title)) parts.push('Tên gợi ý: ' + title);
    if (url) parts.push('Link: ' + url);
    if (durationSec) parts.push('Thời lượng (giây): ' + durationSec);
    if (n.audio?.name) parts.push('File nhạc: ' + n.audio.name);
    parts.push(lyrics ? 'Lời bài hát:\n' + lyrics : 'Lời bài hát: (không cung cấp)');
    const user =
      'PHÂN TÍCH BÀI HÁT theo thông tin dưới đây. Chỉ trả về đúng khối JSON thông số theo schema, ' +
      'không thêm chữ nào ngoài khối JSON.\n\n' +
      parts.join('\n');

    const text = await runTurn(b.via, MUSIC_MASTER_PROMPT, user);
    const analysis = parseMusicAnalysis(text); // throws on non-JSON → surfaced to the UI
    n.analysis = { json: analysis, at: new Date().toISOString() };
    // Anchor the node's duration to the analysis when we still have none (e.g. link-only input).
    const d = Number(analysis.durationSec);
    if (!Number.isFinite(n.audioDuration) && Number.isFinite(d) && d > 0) n.audioDuration = d;
    mutate();
    return json(res, 200, publicState());
  }

  // One button: a song (+ lyrics) → the final shot-list CSV. The tool separates the vocal, measures
  // the song (instruments, Energy), splits the lyric into coverage rows, then the LLM fills only
  // the creative columns of that skeleton; the tool validates and, on errors, asks the LLM to fix
  // the flagged rows (up to twice). It returns the CSV; the browser then imports it the usual way,
  // which re-times it to the vocal and builds luồng A + luồng B. No Demucs runs twice (the profile
  // keeps the vocal it separated).
  if (p === '/api/music/auto' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const n = musicNode(b.id);
    requireLLM(b.via);
    if (!n.audio) throw new Error('Tải file nhạc ở bước 1 trước khi tạo tự động.');
    const audioFile = path.join(mediaDir, n.audio.id);
    if (!fs.existsSync(audioFile)) throw new Error('Không tìm thấy file nhạc của node này.');

    // Only one long task per song at a time: wait out a vocal separation already running (started
    // when the file was uploaded) or another auto run — the same vocalTasks key, so the Map is
    // never overwritten and Demucs never runs twice.
    if (vocalTasks.has(n.id)) {
      await vocalTasks.get(n.id).catch(() => {});
      still(n);
    }
    if (n.vocalTask?.status === 'running')
      throw new Error('Đang xử lý bài này — đợi xong rồi tạo tự động lại.');
    n.vocalTask = {
      status: 'running',
      step: 'auto',
      progress: 0,
      startedAt: new Date().toISOString(),
    };
    save();
    const task = (async () => {
      let madeVocals = null; // a vocal this run separated — removed if the run then fails
      try {
        // re-use the vocal already separated (upload separates it in the background); else profile
        // separates it as part of its one Demucs pass
        const { profile, vocals } = await musicProfile(audioFile, {
          lyricsText: n.lyrics,
          outDir: mediaDir,
          onProgress: pct => {
            if (n.vocalTask) n.vocalTask.progress = pct;
          },
        });
        still(n);
        if (vocals) {
          if (!n.vocals) ((n.vocals = vocals), (madeVocals = vocals.id));
          else fs.rmSync(path.join(mediaDir, vocals.id), { force: true }); // already had one
        }
        const total = Number(profile.total) || Number(n.audioDuration) || 0;
        if (!(total > 1))
          throw new Error('Bài quá ngắn hoặc chưa đo được thời lượng — kiểm tra file nhạc.');
        if (!Number.isFinite(n.audioDuration) && total) n.audioDuration = total;
        const lyrics = String(n.lyrics || '').trim();
        const sections = lyrics ? lyricSections(lyrics) : [];
        let rows = skeletonRows(sections, {
          total,
          energyCurve: profile.energy_curve,
          lo: profile.lo_db,
          hi: profile.hi_db,
          location: String(b.location || '').trim() || undefined,
        });
        if (!rows.length)
          throw new Error('Không dựng được khung từ lời bài hát (thêm lời ở bước 1).');
        const feel = profile.feel === 'nhanh' ? 'nhanh' : 'cham';

        const first = fillPrompt(profile, rowsToCsv(rows), rows.length);
        let v = validateFilled(
          rows,
          extractCsv(await runTurn(b.via, first.system, first.user)),
          feel,
        );
        // ask the LLM to fix the flagged rows, but keep the best result (fewest errors) so a worse
        // retry never overwrites a better fill — validateFilled always returns an importable CSV
        let best = v,
          tries = 1;
        for (; !best.ok && tries <= 2; tries++) {
          still(n);
          const fp = fixPrompt(best.errors, best.csv, rows.length);
          const r = validateFilled(
            rows,
            extractCsv(await runTurn(b.via, fp.system, fp.user)),
            feel,
          );
          if (r.errors.length < best.errors.length) best = r;
          if (best.ok) break;
        }
        return {
          profile,
          feel,
          rows: rows.length,
          csv: best.csv,
          tries,
          ok: best.ok,
          errors: best.errors,
        };
      } catch (e) {
        if (madeVocals) {
          fs.rmSync(path.join(mediaDir, madeVocals), { force: true });
          if (n.vocals?.id === madeVocals) n.vocals = null; // keep RAM and disk in step
        }
        throw e;
      }
    })();
    vocalTasks.set(n.id, task);
    let out;
    try {
      out = await task;
    } finally {
      vocalTasks.delete(n.id);
      if (getNode(n.id) === n) n.vocalTask = null;
    }
    mutate();
    const state = publicState();
    state.autoSummary = {
      instruments: out.profile.instruments,
      feel: out.feel,
      rows: out.rows,
      tries: out.tries,
      ok: out.ok,
      remaining: out.ok ? 0 : out.errors.length,
      csv: out.csv, // the browser imports this next
    };
    return json(res, 200, state);
  }

  // The shot-list master prompt (run OUTSIDE the app with the audio, then import its CSV). For a
  // music node it ends with that song's facts — title, exact length, the official lyrics — so it
  // pastes as is.
  if (p === '/api/music/deep-prompt' && req.method === 'GET') {
    const id = u.searchParams.get('id');
    const n = id ? musicNode(id) : null;
    return json(res, 200, {
      prompt: DEEP_MUSIC_ANALYSIS_PROMPT + (n ? '\n\n' + (await songFacts(n)) : ''),
    });
  }

  // Import an analysis CSV: a master SHOT LIST → an exactly-timed storyboard, or a LYRIC-TIMING
  // table → the song's sections on the node. Shot building mutates the graph, so it requires idle.
  if (p === '/api/music/import' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const n = musicNode(b.id);
    const rows = parseCsv(String(b.csv || ''));
    if (!rows.length) throw new Error('File CSV trống hoặc không đọc được.');
    const kind = detectCsvKind(Object.keys(rows[0]));

    if (kind === 'shots') {
      let shots = rowsToShots(rows);
      if (!shots.length)
        throw new Error('Không thấy dòng shot hợp lệ (cần cột Start + Duration_s hoặc End).');
      const original = shots; // the rows at their CSV times
      // The CSV's words against the official lyrics (the node's lyrics box): the GPU reads the
      // CSV's words in order, so a line added, dropped or changed there pulls its neighbours off.
      const lyricsCheck = String(n.lyrics || '').trim()
        ? sameWords(shots.map(s => s.lyric).join(' '), n.lyrics)
        : null;

      // The CSV says WHAT each shot shows; the vocal says WHEN. With the vocals separated, every row
      // is re-timed to where its words are really sung (the GPU reading) before anything is built.
      // A separation still running (started when the song was uploaded) is waited for.
      // Nothing is written until every check has passed: while the vocal is separated / read (up to
      // a minute) the project may change, the song be replaced or a render start.
      let retime = null,
        lyricTiming = null;
      if (b.retime !== false && !n.vocals && vocalTasks.has(n.id)) {
        await vocalTasks.get(n.id);
        still(n);
      }
      if (b.retime !== false && n.vocals) {
        const vocals = n.vocals;
        const read = await readSung(
          n,
          shots.map(s => (isSungText(s.lyric) ? s.lyric : '')),
        );
        const length = await songLength(n);
        still(n);
        if (n.vocals !== vocals)
          throw new Error('File nhạc vừa đổi trong lúc đọc vocal — nhập lại.');
        // the GPU reading of every sung line, kept on the song (panel + LYRIC TIMING download)
        lyricTiming = lyricTimingOf(
          shots.flatMap((s, i) =>
            isSungText(s.lyric)
              ? [
                  {
                    text: s.lyric,
                    section: s.section,
                    csvStart: s.start,
                    csvEnd: round3(s.start + s.duration),
                    at: read.sung[i],
                  },
                ]
              : [],
          ),
          read.lang,
        );
        if (read.sung.some(Boolean)) {
          const before = shots;
          shots = retimeRows(shots, read.sung, length);
          retime = retimeSummary(before, shots, read);
        } else retime = { aligned: 0, rows: shots.length, note: read.note };
      }
      requireIdle(); // a render started meanwhile may be filming a shot this import replaces
      // Consolidate consecutive rows into ~N-second merged shots (default 8; 0 = one shot per row),
      // after cutting any row longer than a video model films.
      const target = b.targetSeconds === undefined ? 8 : Number(b.targetSeconds);
      const rowCount = shots.length;
      shots = splitLong(shots);
      if (target > 0) shots = groupShots(shots, target);
      // Replace: drop the current production shots (and their clips) before importing new ones.
      // A shot's keyframe is its opening beat, so a new shot that opens on the same CSV row — the
      // same row number showing the same thing — gets that picture back (re-importing the CSV
      // re-timed to the vocal keeps the frames still right; another CSV numbered alike does not).
      const keyframes = new Map(),
        layouts = new Map(),
        stagesOf = new Map();
      const prodNodes = b.replaceShots
        ? db.nodes.filter(x => !x.terminal && nodeZone(x) === 'production' && !isMerged(x))
        : [];
      // the node limit, counted before anything is removed
      const workNodes = db.nodes.filter(x => !x.terminal && !isGroup(x)).length - prodNodes.length;
      if (workNodes + shots.length > 200)
        throw new Error(
          `Vượt giới hạn 200 node/project (đang có ${workNodes}, nhập thêm ${shots.length}).`,
        );
      if (lyricTiming) n.lyricTiming = lyricTiming;
      if (retime) n.retimeInfo = { ...retime, vocalsId: n.vocals.id, at: new Date().toISOString() };
      if (b.replaceShots) {
        for (const x of prodNodes) {
          // its opening row: remembered in its beats, or (a storyboard from before beats kept
          // their rows) found by its CSV time in this same CSV
          const head =
            Array.isArray(x.parts) && x.parts[0] && 'lyric' in x.parts[0]
              ? x.parts[0]
              : beatsFor(x, original)?.[0];
          if (head?.shot && x.image && !x.stale) keyframes.set(rowSig(head), x.image);
          // its 3D capture too (used only while its framing still matches the stage), and the 3D
          // stage nodes wired straight into it
          if (head?.shot && x.layout) layouts.set(rowSig(head), x.layout);
          const pins = deps(x.id).filter(id => isStageOnly(getNode(id)));
          if (head?.shot && pins.length) stagesOf.set(rowSig(head), pins);
        }
        const prod = new Set(prodNodes.map(x => x.id));
        const clips = new Set(
          db.nodes.filter(x => x.terminal && prod.has(x.source)).map(x => x.id),
        );
        const remove = new Set([...prod, ...clips]);
        db.nodes = db.nodes.filter(x => !remove.has(x.id));
        db.edges = db.edges.filter(e => !remove.has(e.source) && !remove.has(e.target));
      }
      const ctx = b.autoWire ? wireContext() : null;
      let seq = nextSeq('production');
      let wired = 0,
        kept = 0;
      for (const sh of shots) {
        const parts = sh.parts || [partOf(sh)];
        const multi = parts.length > 1;
        const keyframe = keyframes.get(rowSig(parts[0])) || null;
        if (keyframe) kept++;
        const layout = layouts.get(rowSig(parts[0]));
        const node = {
          id: 'node-' + crypto.randomUUID(),
          name: sh.name,
          zone: 'production',
          seq: seq++,
          // A merged multi-beat shot: its keyframe (if made) is the opening beat, and its video is
          // filmed straight from every performer's reference (refs/"Ingredients"), so a performer in
          // a later beat keeps their identity instead of being invented from one keyframe.
          prompt: multi ? sh.stillPrompt : '',
          ...(multi ? { videoInput: 'refs' } : {}),
          videoPrompt: sh.videoPrompt,
          lyric: sh.lyric,
          start: sh.start,
          duration: sh.duration,
          // Informational columns carried from the CSV (not part of the render contract).
          section: sh.section,
          energy: sh.energy,
          subject: sh.subject,
          shotSize: sh.shotSize,
          lipSync: sh.lipSync,
          ...(multi ? { beats: sh.beats } : {}),
          // The beats this shot covers: lets the cast step re-wire it to newly designed assets.
          parts,
          image: keyframe,
          video: null,
          outputNaming: { ...defaultNaming },
          ...(layout ? { layout } : {}),
        };
        db.nodes.push(node);
        for (const sid of stagesOf.get(rowSig(parts[0])) || [])
          if (getNode(sid)) db.edges.push({ source: sid, target: node.id });
        if (ctx && wireShot(node, ctx, false)) wired++;
      }
      // The storyboard now sits on the vocal: cut the lip-sync stream straight away — a 7–10 s take
      // per window of sung lines (nothing is rendered — only the takes' column fills). Not when the
      // GPU could not place the lines: takes on the CSV's guessed times would sing out of sync.
      mutate(); // the storyboard is saved before the takes' wait (it may not be interrupted)
      let takes = null;
      if (b.takes !== false && retime?.aligned)
        try {
          takes = await cutTakes(n);
          mutate();
        } catch (e) {
          takes = { error: e.message };
        }
      still(n);
      const state = publicState();
      state.importSummary = {
        kind: 'shots',
        rows: rowCount,
        // rows dropped for an unreadable Start / End (their lines are missing from the storyboard)
        skipped: rows.length - original.length,
        created: shots.length,
        wired,
        keyframesKept: kept,
        keyframesHad: keyframes.size,
        style: !!ctx?.styleNode,
        target,
        retime, // null: no vocals yet, the CSV timecodes were kept
        takes, // null: not cut (no vocals / not aligned / turned off)
        lyricsCheck, // null: no official lyrics on the node to compare with
      };
      return json(res, 200, state);
    }

    if (kind === 'lyrics') {
      const sections = rowsToSections(rows);
      if (!sections.length) throw new Error('Không đọc được dòng lời/thời gian nào trong CSV.');
      const durationSec = Math.round(sections[sections.length - 1].endSec || 0);
      n.analysis = {
        json: { title: n.name, durationSec, sections, source: 'csv' },
        at: new Date().toISOString(),
      };
      if (!Number.isFinite(n.audioDuration) && durationSec > 0) n.audioDuration = durationSec;
      mutate();
      const state = publicState();
      state.importSummary = { kind: 'lyrics', sections: sections.length, durationSec };
      return json(res, 200, state);
    }

    throw new Error(
      'CSV không nhận dạng được. Cần master shot list (có cột Subject/Shot Size…) hoặc lyric timing (Start,End,Exact Lyric,Delivery).',
    );
  }

  // Design the cast the imported storyboard needs — singer, musicians, stage, style — with the MV
  // master prompt (the project's own, else the built-in one), pinned to the exact keys the CSV
  // subjects map to. Only the assets + style are merged in: the CSV shots and this node stay, and
  // every CSV shot is then re-wired to the designed cast.
  if (p === '/api/music/cast' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const n = musicNode(b.id);
    const shots = csvShots();
    if (!shots.length)
      throw new Error(
        'Nhập shot-list CSV trước — dàn nhân vật và bối cảnh được lấy từ storyboard đó.',
      );
    requireLLM(b.via);
    const title =
      n.analysis?.json?.title || (!isDefaultName(n.name) ? n.name : '') || db.name || 'MV';
    const brief = castBrief(
      title,
      shots.flatMap(x => x.parts),
    );
    const text = await runTurn(b.via, db.masterPrompt || MASTER_PROMPT, brief);
    still(n);
    requireIdle();
    const bp = parseBlueprint(text);
    // The builder needs at least one shot; the storyboard comes from the CSV, so whatever shots
    // the LLM wrote are dropped below.
    if (!Array.isArray(bp.shots) || !bp.shots.length) {
      const k = Array.isArray(bp.assets) ? bp.assets[0]?.key : null;
      bp.shots = [{ name: 'tmp', duration: 8, uses: k ? [k] : [] }];
    }
    const summary = mergeCast(buildGraph(bp));
    const ctx = wireContext();
    let rewired = 0;
    for (const s of csvShots()) if (wireShot(s, ctx, true)) rewired++;
    // lip-sync takes made earlier compose their keyframe from the cast too
    for (const t of db.nodes.filter(isLipsync)) wireShot(t, ctx, true);
    mutate();
    const state = publicState();
    state.castSummary = { ...summary, rewired, shots: shots.length };
    return json(res, 200, state);
  }

  // ① Separate the vocals from the song (Demucs, local). Runs in the background — about a minute
  // for a whole song on a GPU — and reports its progress on the node (vocalTask) as it goes.
  if (p === '/api/music/vocals' && req.method === 'POST') {
    const b = await body(req);
    const n = musicNode(b.id);
    if (!(n.audio || db.audio)) throw new Error('Tải file nhạc (mp3/wav) vào node MUSIC trước.');
    if (vocalTasks.has(n.id)) throw new Error('Đang tách vocal cho bài này, đợi xong.');
    startVocals(n);
    return json(res, 200, publicState());
  }

  // Cut the lip-sync stream: a 7–10 s take per window of sung lines (see cutTakes). Importing the
  // CSV already does this once the vocal is read; this re-cuts on demand.
  if (p === '/api/music/lipsync' && req.method === 'POST') {
    const b = await body(req);
    const n = musicNode(b.id);
    const summary = await cutTakes(n, { align: b.align });
    mutate();
    const state = publicState();
    state.lipsyncSummary = summary;
    return json(res, 200, state);
  }

  // The GPU lyric timing as a CSV (the LYRIC TIMING columns + confidence + the CSV time it replaces).
  if (p === '/api/music/lyric-timing.csv' && req.method === 'GET') {
    const n = musicNode(u.searchParams.get('id'));
    const lt = n.lyricTiming;
    if (!lt?.lines?.length) throw new Error('Chưa đọc lời theo vocal (bước 2).');
    const head = 'Start,End,Duration_s,Section,Exact Lyric,Delivery,Confidence,CSV_Start,Shift_s';
    const rowsOut = lt.lines.map(l =>
      [
        l.start === null ? '' : stamp(l.start),
        l.end === null ? '' : stamp(l.end),
        l.start === null ? '' : (l.end - l.start).toFixed(3),
        l.section || '',
        l.text,
        l.delivery || '',
        l.score === null ? '' : l.score.toFixed(2),
        l.csvStart === undefined ? '' : stamp(l.csvStart),
        l.csvStart === undefined || l.start === null ? '' : (l.start - l.csvStart).toFixed(3),
      ]
        .map(csvCell)
        .join(','),
    );
    const fname =
      (String(n.name || 'song').replace(/[^\w.\- ]+/g, '_') || 'song').trim() +
      '_LYRIC_TIMING_GPU.csv';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    });
    return res.end('﻿' + [head, ...rowsOut].join('\n'));
  }
  // Give the storyboard's shots their beats (time, line, lip-sync flag, framing) again from the
  // MASTER SHOT LIST CSV, matched by time — nothing else changes: no shot is added or removed, and
  // images, wires and clips stay. For a storyboard imported before beats carried their timing.
  // Only that bookkeeping changes (no prompt, wire or image), so queued renders are unaffected.
  if (p === '/api/music/refresh-beats' && req.method === 'POST') {
    const b = await body(req);
    musicNode(b.id);
    const rows = parseCsv(String(b.csv || ''));
    if (!rows.length || detectCsvKind(Object.keys(rows[0])) !== 'shots')
      throw new Error(
        'Chọn đúng file MASTER SHOT LIST (CSV có cột Subject / Shot Size / Lip Sync).',
      );
    const beats = rowsToShots(rows);
    const shots = csvShots();
    if (!shots.length)
      throw new Error('Chưa có storyboard nhập từ CSV — dùng "↑ Nhập shot-list CSV".');
    let matched = 0;
    const missed = [];
    for (const s of shots) {
      const parts = beatsFor(s, beats);
      if (parts) {
        s.parts = parts;
        matched++;
      } else missed.push(s.name);
    }
    if (!matched)
      throw new Error(
        'CSV không khớp storyboard hiện tại (mốc thời gian khác) — chọn đúng file đã nhập.',
      );
    mutate();
    const state = publicState();
    state.refreshSummary = {
      matched,
      total: shots.length,
      missed: missed.slice(0, 5),
      lines: shots.flatMap(s => s.parts).filter(pt => pt.lipSync && pt.lyric).length,
    };
    return json(res, 200, state);
  }

  // A take's source video (keyframe + its cut of the vocal), built now so it can be checked
  // before paying for an Omni render. Creating the render rebuilds it when anything changed.
  if (p === '/api/music/lipsync-input' && req.method === 'POST') {
    const b = await body(req);
    const t = getNode(b.id);
    if (!isLipsync(t)) throw new Error('Không phải take lip-sync.');
    await ensureLipsyncInput(t);
    mutate();
    return json(res, 200, publicState());
  }

  // Film every take of this song that has its keyframe and no clip yet (nor one on the way).
  // Like a single node's render (/api/jobs): refused only while a chained auto run drives the queue.
  if (p === '/api/music/lipsync-render' && req.method === 'POST') {
    if (db.autoRun?.status === 'running' || db.autoVideoRun?.status === 'running')
      throw new Error('Đang chạy tự động. Dừng chuỗi trước khi quay lip-sync.');
    const b = await body(req);
    const n = musicNode(b.id);
    const takes = db.nodes.filter(
      x =>
        isLipsync(x) &&
        x.musicId === n.id &&
        x.image &&
        !x.stale &&
        !db.nodes.some(c => c.terminal && c.source === x.id) &&
        !db.jobs.some(
          j =>
            j.nodeId === x.id && j.kind === 'video' && !['failed', 'cancelled'].includes(j.status),
        ),
    );
    if (!takes.length)
      throw new Error(
        'Không có take nào sẵn sàng: cần ảnh khung, chưa có video và không có tác vụ đang chờ.',
      );
    let queued = 0;
    const errors = [];
    for (const t of takes)
      try {
        await createJob(req, { nodeId: t.id, kind: 'video', count: 1 });
        queued++;
      } catch (e) {
        errors.push(t.name + ': ' + e.message);
      }
    pump(req);
    const state = publicState();
    state.lipsyncRender = { queued, errors };
    return json(res, 200, state);
  }
  return NEXT;
}

// The lip-sync stream (⑪): one take per 7–10 s window of sung lines. The takes are cut from EVERY
// sung line of the storyboard in the order sung — not from the "Lip Sync = YES" rows alone, because
// the silence between two of those rows holds other lines whose voice the window would swallow
// while the take's lyric never mentioned them. Lines next to each other are merged until the take
// lasts TAKE_MIN (never across a section or a change of set, never past TAKE_MAX); each take keeps
// ONE shot size and ONE keyframe, wired to the singer + set + style, and Omni Flash films it
// video-to-video from that still + the take's cut of the vocal. Re-running keeps every take whose
// window and lines are unchanged. It only adds takes in their own column (and re-cuts its own
// takes), so it may run while other work is queued — just not while one of this song's takes is
// itself being made.
// Returns what it did; what reading the vocal found is also kept on the song (lipsyncInfo).
async function cutTakes(n, { align } = {}) {
  requireTakesIdle(n);
  if (!n.vocals) throw new Error('Tách vocal trước.');
  const shots = csvShots().sort((a, x) => a.start - x.start);
  if (!shots.length)
    throw new Error('Nhập shot-list CSV trước — các câu hát lấy từ storyboard đó.');
  // Imported before the beats carried their time, line and lip-sync flag: say so (re-importing
  // would cost the shots' images and clips — refresh-beats restores the beats in place).
  const oldBeats = shots.filter(s => s.parts.some(pt => !('start' in pt) || !('lipSync' in pt)));
  if (oldBeats.length)
    throw new Error(
      `Storyboard nhập từ bản cũ: ${oldBeats.length}/${shots.length} shot chưa lưu thời gian từng câu. ` +
        'Bấm "↑ Cập nhật thời gian từng câu từ CSV" và chọn lại file MASTER SHOT LIST — shot, ảnh và video đã làm giữ nguyên.',
    );
  const vocalsFile = path.join(mediaDir, n.vocals.id);
  const act = await vocalActivity(vocalsFile);
  still(n);
  // Where EVERY sung line of the storyboard (lip-sync or not, in order) is really sung. A
  // storyboard re-timed to the vocal at import already carries it on its beats; an older one is
  // read on the vocal now — an LLM-made storyboard can be seconds off. When the GPU recognises no
  // voice (another language, a near-empty vocal), the storyboard marks stay and only the ±0.5 s
  // snap to the vocal applies.
  const sung = [];
  for (const s of shots)
    s.parts.forEach((pt, i) => {
      if (String(pt.lyric || '').trim())
        sung.push({
          id: String(pt.shot || s.id + ':' + i),
          text: pt.lyric,
          start: pt.start,
          pt,
          shotId: s.id,
          section: s.section,
        });
    });
  if (!sung.length) throw new Error('Storyboard không có câu hát nào (cột Exact Lyric trống).');
  // (beats re-timed on THIS vocal only — a song replaced since has other times)
  const retimed =
    n.retimeInfo?.vocalsId === n.vocals.id && sung.every(x => x.pt.sungStart !== undefined);
  const read =
    align === false
      ? { sung: sung.map(() => null), note: 'không căn lời' }
      : retimed
        ? {
            lang: n.retimeInfo?.lang || '',
            note: '',
            sung: sung.map(({ pt }) =>
              pt.sungStart === null
                ? null
                : { start: pt.sungStart, end: pt.sungEnd, score: pt.alignScore },
            ),
          }
        : await readSung(
            n,
            sung.map(x => x.text),
          );
  still(n);
  const aligned = new Map(
    sung.map((x, i) => [x.id, read.sung[i] ? { ...read.sung[i], lang: read.lang } : null]),
  );
  const alignNote = read.note;
  // Every sung line where the vocal really has it (else where the storyboard put it), with what the
  // CSV shows on it. The section comes from the song's GPU reading: a merged shot drops its CSV
  // Section, so the shot's own is usually empty — and the section is what a take must not cross.
  const sections = lineSections(n.lyricTiming, sung);
  const lines = sung.map((x, i) => {
    const a = aligned.get(x.id);
    return {
      key: x.id,
      lyric: x.text,
      start: a ? a.start : x.pt.start,
      end: a ? a.end : round3(x.pt.start + x.pt.duration),
      snap: a ? (a.score >= ALIGN_SURE ? 0.25 : SNAP) : SNAP,
      // where the aligner found the line in the vocal (null: storyboard marks used)
      align: a ? { start: a.start, end: a.end, score: a.score, lang: a.lang } : null,
      section: sections[i],
      subject: x.pt.subject,
      shotSize: x.pt.shotSize,
      angle: x.pt.angle,
      lens: x.pt.lens,
      movement: x.pt.movement,
      action: x.pt.action,
      emotion: x.pt.emotion,
      vocalDelivery: x.pt.vocalDelivery,
      location: x.pt.location,
      csvStart: round3(x.pt.start),
      csvEnd: round3(x.pt.start + x.pt.duration),
      shotId: x.shotId,
    };
  });
  // In sung order, and no line starting before the one before it ends — a stale storyboard mark
  // (a line whose words the aligner did not find) can sit out of order, and the no-overlap rule
  // between takes relies on the lines being ordered.
  lines.sort((a, b) => a.start - b.start);
  for (let i = 1; i < lines.length; i++)
    if (lines[i].start < lines[i - 1].end)
      lines[i].start = Math.min(lines[i].end, lines[i - 1].end);
  // The takes: whole lines merged to TAKE_MIN…TAKE_MAX, each cut widened into the silence around it
  // but never past the middle of the gap to the take beside it (so no two takes overlap).
  const groups = groupLines(lines);
  const windows = groups.map((g, i) => {
    const last = g.lines[g.lines.length - 1];
    const prev = groups[i - 1],
      next = groups[i + 1];
    return {
      start: g.start,
      end: g.end,
      snap: Math.max(g.lines[0].snap, last.snap), // the looser of the two readings
      lo: prev ? Math.min(g.start, (prev.end + g.start) / 2) : 0,
      hi: next ? Math.max(g.end, (g.end + next.start) / 2) : Infinity,
      padTo: TAKE_MIN,
      // a single line longer than TAKE_MAX stays whole, and still gets its handles; every other
      // take ends at TAKE_MAX, handles included
      max: g.over ? round3(g.end - g.start) + PRE + POST : TAKE_MAX,
    };
  });
  const cuts = refineTakes(windows, act);
  // How far the storyboard has each sung line from where the voice really is (≈ 0 once re-timed).
  const offsets = sung
    .map(x => (aligned.get(x.id) ? Math.abs(aligned.get(x.id).start - x.start) : null))
    .filter(x => x !== null);
  const ctx = wireContext();
  const existing = db.nodes.filter(x => isLipsync(x) && x.musicId === n.id);
  if (
    db.nodes.filter(x => !x.terminal && !isGroup(x)).length + groups.length - existing.length >
    200
  )
    throw new Error('Vượt giới hạn 200 node/project. Xóa bớt node trước khi tạo take lip-sync.');
  // Which take a window belongs to when it is re-cut: the one sharing the most of its sung lines
  // (a take can no longer be keyed by one CSV row — merging moves the row a window opens on).
  const free = new Set(existing);
  const claim = keys => {
    let best = null,
      score = 0;
    for (const x of free) {
      const own = linesOfTake(x);
      const hit = own.filter(k => keys.includes(k)).length;
      if (!hit) continue;
      const s = hit * 2 + (own[0] === keys[0] ? 1 : 0);
      if (s > score) {
        score = s;
        best = x;
      }
    }
    if (best) free.delete(best);
    return best;
  };
  let created = 0,
    updated = 0;
  groups.forEach((g, i) => {
    const cut = cuts[i];
    const seconds = round3(cut.clipEnd - cut.clipStart);
    const frame = takeFraming(g.lines, i);
    const notes = [...frame.notes];
    if (g.over)
      notes.push(
        `Một câu dài ${seconds}s — vượt ${TAKE_MAX}s, giữ nguyên cả câu (không cắt giữa câu hát).`,
      );
    else if (seconds < TAKE_MIN - 0.05)
      notes.push(`Chỉ ${seconds}s — dưới ${TAKE_MIN}s vì hết khoảng lặng quanh câu.`);
    const fields = {
      lyric: g.lines.map(l => l.lyric).join(' '),
      // the lines this take sings, each timed from its first frame (the Omni prompt reads them)
      lsLines: g.lines.map(l => ({
        key: l.key,
        lyric: l.lyric,
        at: round3(Math.max(0, l.start - cut.clipStart)),
        start: round3(l.start),
        end: round3(l.end),
        section: l.section,
        emotion: deliveryOf(l),
      })),
      lsKeys: g.lines.map(l => l.key),
      section: g.lines.find(l => l.section)?.section || '',
      shotId: frame.shotId,
      subject: frame.subject,
      shotSize: frame.shotSize,
      angle: frame.angle,
      lens: frame.lens,
      movement: frame.movement,
      action: frame.action,
      location: frame.location,
      // what the singer feels AND how the line is sung, every line of the window, the first kept
      emotion: frame.emotion,
      csvStart: g.lines[0].csvStart,
      csvEnd: g.lines[g.lines.length - 1].csvEnd,
      align: g.lines[0].align, // the line the take opens on (its keyframe is that moment)
      ...cut,
      parts: [
        {
          subject: frame.subject,
          shotSize: frame.shotSize,
          angle: frame.angle,
          action: frame.action,
          location: frame.location,
        },
      ],
      lsNote: notes.join(' '),
    };
    fields.videoPrompt = omniPrompt(fields);
    fields.lsSig = takeSig(fields);
    const key = takeKey(fields.lsKeys);
    const old = claim(fields.lsKeys);
    if (old) {
      // a new cut, or another Omni prompt (another line in the window, another camera): the clips
      // made from it are out of date
      const recut =
        old.clipStart !== fields.clipStart ||
        old.clipEnd !== fields.clipEnd ||
        old.videoPrompt !== fields.videoPrompt;
      // another line to open on, or another framing / feeling: a new keyframe
      const changed = old.lsSig
        ? old.lsSig !== fields.lsSig
        : strip(old.lyric) !== strip(fields.lyric);
      Object.assign(old, fields);
      old.lsKey = key;
      if (/^LS /.test(String(old.name || ''))) old.name = takeName(key, cut.lsStart); // (a renamed take keeps its name)
      if (changed || !String(old.prompt || '').trim()) old.prompt = takeStill(old);
      if (changed) {
        markStale(old);
        wireShot(old, ctx, true);
      } else if (recut) flagClips(old); // its source video and the clips made from it are out of date
      updated++;
      return;
    }
    const node = {
      id: 'node-' + crypto.randomUUID(),
      role: 'lipsync',
      zone: 'lipsync',
      seq: nextSeq('lipsync'),
      name: takeName(key, cut.lsStart),
      lsKey: key,
      musicId: n.id,
      ...fields,
      prompt: takeStill(fields),
      // Omni Flash is the model that takes a source video (video-to-video).
      seedvis: { video: { model: 'Omni-Flash', aspectRatio: '16:9', upscale: null } },
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    };
    db.nodes.push(node);
    wireShot(node, ctx, false);
    created++;
  });
  // A take no window kept (its lines are inside another take's window now, or they left the
  // storyboard) goes — even with a keyframe, else it sits on top of the take that now sings its
  // line. One the user already filmed is kept instead, and reported so the panel can say so.
  const filmed = x => db.nodes.some(c => c.terminal && c.source === x.id);
  const ghosts = [...free];
  const keptFilmed = ghosts.filter(filmed);
  const gone = new Set(ghosts.filter(x => !filmed(x)).map(x => x.id));
  const lostFrames = ghosts.filter(x => !filmed(x) && x.image).length;
  db.nodes = db.nodes.filter(x => !gone.has(x.id));
  db.edges = db.edges.filter(e => !gone.has(e.source) && !gone.has(e.target));
  // alignment: lines placed from the vocal, how many unsure, and how far off the storyboard was
  const found = {
    aligned: lines.filter(l => l.align).length,
    unsure: lines.filter(l => l.align && l.align.score < ALIGN_SURE).length,
    csvOff: offsets.filter(x => x > 1).length,
    csvOffMax: offsets.length ? Math.round(Math.max(...offsets) * 10) / 10 : 0,
    sungLines: sung.length,
    alignNote,
  };
  // how many takes the song could not fill to TAKE_MIN, and how many the TAKE_MAX ceiling closed
  const lengths = {
    min: TAKE_MIN,
    max: TAKE_MAX,
    short: cuts.filter((c, i) => !groups[i].over && c.clipEnd - c.clipStart < TAKE_MIN - 0.05)
      .length,
    capped: groups.filter(g => g.capped || g.over).length,
  };
  // What reading the vocal found, kept on the song for its panel.
  n.lipsyncInfo = { at: new Date().toISOString(), takes: groups.length, ...lengths, ...found };
  return {
    takes: groups.length,
    created,
    updated,
    removed: gone.size,
    // takes dropped although their keyframe was made, and the filmed ones kept instead of dropped
    removedWithImage: lostFrames,
    filmedKept: keptFilmed.map(x => x.name),
    ...lengths,
    snapped: cuts.filter(c => c.snappedStart && c.snappedEnd).length,
    quiet: cuts.filter(c => c.voiced < 0.3).length,
    seconds: Math.round(cuts.reduce((a, c) => a + (c.clipEnd - c.clipStart), 0)),
    ...found,
  };
}
// A take's name and key: the row its first line comes from, plus how many lines it sings ("014+3").
const takeKey = keys => keys[0] + (keys.length > 1 ? '+' + keys.length : '');
const takeName = (key, at) => `LS ${key} · ${clock(at)}`.slice(0, 100);
// The sung lines a take holds (a take cut before they were merged holds exactly one).
const linesOfTake = x => (Array.isArray(x.lsKeys) ? x.lsKeys : x.lsKey ? [x.lsKey] : []);
// The section of every sung line, from the song's GPU lyric timing — it keeps one for each line, in
// the order sung. Falls back to the section of the shot the line sits in (what a storyboard read
// before the timing was kept had), line by line, when the two readings are not the same lines.
function lineSections(lyricTiming, sung) {
  const read = lyricTiming?.lines;
  const same =
    Array.isArray(read) &&
    read.length === sung.length &&
    sung.every((x, i) => strip(read[i].text) === strip(x.text));
  return sung.map((x, i) => String((same && read[i].section) || x.section || '').trim());
}
// ONE shot size, ONE angle, ONE keyframe per take: the framing comes from the line of the window
// whose Subject is the singer (the CSV gives other lines to the band, the stage or the audience),
// else from the line the take opens on. A window the CSV frames no singer in falls back to a
// readable default — and says so in the take's note. The feeling is every line's, the first kept:
// the keyframe shows the first (faceOf), the Omni prompt names each line's own.
// How the singer sings a line: the CSV's "Vocal Delivery" for it; on an older CSV, a singer row's
// Emotion was the singer's (a coverage row's is the band's, so it is not borrowed).
const deliveryOf = l => {
  const d = String(l.vocalDelivery || '').trim();
  if (d) return d;
  return SINGER_RE.test(strip(l.subject || '')) ? String(l.emotion || '').trim() : '';
};
// The framing of a lip-sync take. Luồng B is the singer in one place, so it NEVER borrows a camera,
// an angle, an action or a location from luồng A's coverage rows (those face the band/audience and
// deliberately hide the singer's mouth). The tool gives the take one frontal shot size (rotating so
// takes do not all look alike), eye level, at the main stage (wireShot wires it), and the singer's
// own delivery as the feeling.
const TAKE_SIZES = ['MCU', 'CU', 'MS'];
function takeFraming(lines, index = 0) {
  const notes = [];
  const emotion = [...new Set(lines.map(deliveryOf).filter(Boolean))].join('; ');
  if (!emotion)
    notes.push(
      'CSV chưa mô tả cách ca sĩ hát các câu này (cột "Vocal Delivery") — thêm cột đó để take có đúng cảm xúc, cách hát.',
    );
  return {
    subject: 'Singer',
    shotSize: TAKE_SIZES[index % TAKE_SIZES.length],
    angle: 'eye level',
    lens: '',
    movement: 'slow push-in',
    action: '',
    location: '', // the singer is at the main stage; wireShot wires it
    shotId: lines[0].shotId,
    emotion,
    notes,
  };
}
// The GPU reading of the sung lines as the song's LYRIC TIMING: each line where it is sung (null
// when its words were not found), its confidence, and the CSV time it replaces.
// lines: [{ text, section, csvStart, csvEnd, at: { start, end, score } | null }].
function lyricTimingOf(lines, lang) {
  const out = lines.map(({ at, ...l }) => ({
    ...l,
    start: at?.start ?? null,
    end: at?.end ?? null,
    score: at?.score ?? null,
  }));
  const shifts = out.filter(l => l.start !== null).map(l => Math.abs(l.start - l.csvStart));
  return {
    at: new Date().toISOString(),
    lang,
    lines: out,
    aligned: out.filter(l => l.start !== null).length,
    unsure: out.filter(l => l.score !== null && l.score < ALIGN_SURE).length,
    csvOff: shifts.filter(x => x > 1).length,
    csvOffMax: shifts.length ? Math.round(Math.max(...shifts) * 10) / 10 : 0,
  };
}
const round3 = x => Math.round(x * 1000) / 1000;
// Two lyrics compared word by word (case, accents, punctuation and [tags] / (x2) aside): where the
// first difference is, with a few words of each from there.
function sameWords(csv, official) {
  const words = t =>
    strip(String(t).replace(/\[[^\]]*\]|\([^)]*\)/g, ' '))
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean);
  const a = words(csv),
    b = words(official);
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  if (k === a.length && k === b.length) return { ok: true, words: a.length };
  return {
    ok: false,
    at: k,
    csvWords: a.length,
    officialWords: b.length,
    csv: a.slice(k, k + 6).join(' '),
    official: b.slice(k, k + 6).join(' '),
  };
}
// A CSV row as the storyboard remembers it: its number and what it shows. A keyframe made for a
// row carries over only to that same row of a re-import — not to another CSV numbered alike.
const rowSig = r =>
  [r.shot, r.subject, r.shotSize, r.angle, r.location, r.action, r.emotion, r.lyric]
    .map(strip)
    .join('|');
// What a lip-sync take's keyframe is made from: the line it opens on and how that one shot is framed
// and played (its feeling is every line's, the first one shown on the face). When a re-cut or a
// re-import changes it — another line to open on, another framing — the keyframe is out of date.
const takeSig = t =>
  [
    t.lsLines?.[0]?.lyric ?? t.lyric,
    t.subject,
    t.shotSize,
    t.angle,
    t.location,
    t.emotion,
    t.action,
  ]
    .map(strip)
    .join('|');

// --- The GPU reading of the vocal ---------------------------------------------------------------

// Separate the song's vocals in the background (Demucs), progress kept on the node. The task's
// promise stays in vocalTasks until it settles, so an import can wait for it.
function startVocals(n) {
  const src = n.audio || db.audio;
  const dir = mediaDir; // this project's media folder, even if another project opens meanwhile
  const startedAt = new Date().toISOString();
  n.vocalTask = { status: 'running', progress: 0, startedAt };
  save();
  // The song node of this task in the open project — found by id and start time, so a project
  // closed and reopened meanwhile still gets the result (and another project never does).
  const mine = () => {
    const cur = getNode(n.id);
    return cur?.vocalTask?.startedAt === startedAt ? cur : null;
  };
  let saved = 0;
  const task = separateVocals(path.join(dir, src.id), dir, pct => {
    const cur = mine();
    if (!cur) return;
    cur.vocalTask.progress = pct;
    if (Date.now() - saved > 1500) {
      saved = Date.now();
      save();
    }
  })
    .then(asset => {
      const cur = mine();
      if (!cur) return; // another project is open, or the node was deleted / given a new song
      cur.vocals = asset;
      cur.vocalTask = { status: 'done', at: new Date().toISOString(), model: asset.model };
      mutate();
    })
    .catch(e => {
      const cur = mine();
      if (!cur) return;
      cur.vocalTask = { status: 'failed', error: e.message };
      save();
    })
    .finally(() => vocalTasks.delete(n.id));
  vocalTasks.set(n.id, task);
  return task;
}

// Where each of these sung texts (in the order sung) really is in the song's isolated vocal:
// { start, end, score } per text, or null for an empty text or one whose words were not found. The
// whole reading is dropped (all null + a note) when it cannot run or recognises no voice.
async function readSung(n, texts) {
  const none = note => ({ sung: texts.map(() => null), note, lang: '' });
  if (!n.vocals) return none('chưa tách vocal');
  const items = texts
    .map((t, i) => ({ id: String(i), text: String(t || '').trim() }))
    .filter(x => x.text);
  if (!items.length) return none('không có lời để đọc');
  const lang = guessLang(items.map(x => x.text).join(' '));
  let res;
  try {
    res = await alignLines(path.join(mediaDir, n.vocals.id), items, lang);
  } catch (e) {
    return { ...none(e.message), lang };
  }
  const scores = res.lines.map(l => l.score || 0).sort((a, b) => a - b);
  if (scores[Math.floor(scores.length / 2)] < ALIGN_MIN)
    return { ...none('căn lời không nhận ra giọng (' + lang + ') — dùng mốc CSV'), lang };
  const by = new Map(res.lines.map(l => [String(l.id), l]));
  return {
    lang,
    note: '',
    sung: texts.map((_, i) => {
      const l = by.get(String(i));
      return l && l.start !== null && l.end > l.start && l.score >= ALIGN_MIN
        ? { start: l.start, end: l.end, score: l.score }
        : null;
    }),
  };
}
// The THÔNG TIN BÀI HÁT block the shot-list master prompt ends with.
async function songFacts(n) {
  const src = n.audio || db.audio;
  const len = round3(
    (src && (await probeDuration(path.join(mediaDir, src.id)))) ||
      (Number.isFinite(n.audioDuration) ? n.audioDuration : 0),
  );
  const title =
    n.analysis?.json?.title ||
    (!isDefaultName(n.name) ? n.name : '') ||
    String(src?.name || '').replace(/\.[a-z0-9]{2,4}$/i, '');
  const lyrics = String(n.lyrics || '').trim();
  return [
    'THÔNG TIN BÀI HÁT (tool điền sẵn):',
    `- Tên bài: ${title || '(chưa có — lấy từ file đính kèm)'}`,
    len
      ? `- TOTAL_DURATION = ${stamp(len)} (= ${len} giây) — đo từ file nhạc.`
      : '- TOTAL_DURATION = (đo từ file nhạc đính kèm, dạng mm:ss.mmm)',
    '- Ý tưởng MV: trình diễn live concert.',
    '- Nhạc cụ: không rõ.',
    // the GPU reading has Spanish and English models only: another language keeps the CSV times
    ...(/[ăâđêôơư]/i.test(lyrics)
      ? [
          '- LƯU Ý: bộ đọc giọng của tool chỉ có mô hình tiếng Tây Ban Nha và tiếng Anh, có thể không căn được lời tiếng Việt — hãy đặt Start/End của hàng có lời sát audio thật nhất có thể.',
        ]
      : []),
    lyrics
      ? '- LỜI CHÍNH THỨC (đúng thứ tự và số lần hát trong bản thu; chép nguyên văn vào cột Lyric, không thêm, không bớt):\n' +
        lyrics
      : '- LỜI: CHƯA CÓ. Hãy DỪNG lại và đề nghị người dùng dán lời bài hát chính thức — không tự nghe đoán lời (tool cần đúng từng chữ để tìm từng câu trên giọng hát).',
  ].join('\n');
}
// The song's exact length (the timeline ends there): the vocal track's, else the uploaded song's.
const songLength = async n =>
  (await probeDuration(path.join(mediaDir, n.vocals.id))) ||
  (Number.isFinite(n.audioDuration) ? n.audioDuration : undefined);
// What re-timing a CSV did: how many sung rows the vocal placed, how many the CSV had holding their
// whole line, how far it had moved them.
function retimeSummary(before, after, read) {
  const sungRows = before.filter(r => String(r.lyric || '').trim()).length;
  let aligned = 0,
    unsure = 0,
    csvHeld = 0,
    moved = 0,
    maxShift = 0;
  for (const r of after) {
    if (r.sungStart === null || r.sungStart === undefined) continue;
    aligned++;
    if (r.alignScore < ALIGN_SURE) unsure++;
    if (r.csvStart <= r.sungStart + 0.02 && r.csvStart + r.csvDuration >= r.sungEnd - 0.02)
      csvHeld++;
    const shift = Math.abs(r.start - r.csvStart);
    if (shift > 1) moved++;
    maxShift = Math.max(maxShift, shift);
  }
  return {
    rows: after.length,
    // unsung rows the CSV squeezed between two lines sung back to back
    dropped: before.length - after.length,
    sungRows,
    aligned,
    unsure,
    csvHeld,
    moved,
    maxShift: Math.round(maxShift * 10) / 10,
    lang: read.lang,
    note: read.note,
  };
}
const isSungText = t =>
  !!String(t || '').trim() && !/^\s*(instrumental|no vocal|nhạc dạo)\b/i.test(String(t));
// mm:ss.mmm (the CSV time format)
const stamp = t => {
  const v = Math.max(0, Number(t) || 0),
    m = Math.floor(v / 60);
  return String(m).padStart(2, '0') + ':' + (v - m * 60).toFixed(3).padStart(6, '0');
};
const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// Re-cutting a take while its own keyframe or Omni render is being made would mix two cuts.
function requireTakesIdle(n) {
  const takes = new Set(db.nodes.filter(x => isLipsync(x) && x.musicId === n.id).map(x => x.id));
  if (db.jobs.some(j => takes.has(j.nodeId) && ['queued', 'running'].includes(j.status)))
    throw new Error('Có take lip-sync đang được tạo ảnh/video. Đợi xong rồi đọc vocal lại.');
}
// mm:ss.cc of a song time, for a take's name.
const clock = t => {
  const m = Math.floor(t / 60),
    s = t - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
};

// --- Cast design ---------------------------------------------------------------------------

const INSTRUMENT_VI = {
  piano: 'đàn piano',
  guitar: 'đàn guitar',
  violin: 'violin',
  cello: 'cello',
  drum: 'trống',
  bass: 'đàn bass',
};
// The activation text for the MV master prompt: the exact cast + places the storyboard uses, with
// the keys pinned so the imported shots re-wire to them, and the storyboard's own visual cues.
export function castBrief(title, parts) {
  const text = strip(parts.map(p => `${p.subject} ${p.action || ''}`).join(' | '));
  const cast = [];
  if (SINGER_RE.test(text))
    cast.push(['singer', 'ca sĩ chính — giọng hát chính của bài, xuất hiện nhiều nhất']);
  // the players the beats show (as the wiring finds them: not a piano only glimpsed in an action)
  const players = new Set(parts.flatMap(p => playersIn(p.subject, p.action)));
  for (const [inst, player] of PLAYERS)
    if (players.has(player))
      cast.push([
        player,
        `nhạc công ${INSTRUMENT_VI[inst]} (nếu cầm được nhạc cụ thì "holding …")`,
      ]);
  if (!cast.length) cast.push(['singer', 'ca sĩ chính']);
  // The sets: the CSV's Location column (one scene each, keyed by its name — "Main stage" and
  // "main Stage" are one set), else one main stage.
  const locations = [];
  for (const p of parts) {
    const l = String(p.location || '').trim();
    if (l && !locations.some(x => placeKey(x) === placeKey(l))) locations.push(l);
  }
  const places = [
    ...new Set(parts.map(p => String(p.subject || '').trim()).filter(s => PLACE_RE.test(strip(s)))),
  ];
  const sets = locations.length
    ? locations.map(
        (l, i) =>
          `- ${placeKey(l)} (role "scene"): ${l} — bối cảnh của mọi shot có Location "${l}"${i ? '' : ' (bối cảnh chính)'}.`,
      )
    : [
        `- stage (role "scene"): bối cảnh chính nơi mọi shot diễn ra${places.length ? ' — ' + places.join(', ') : ''}.`,
      ];
  const crowd = /\b(choir|orchestra|band|ensemble|audience)\b/.test(text);
  // the storyboard's visual cues, taken across the whole song (not only its first rows)
  const actions = [...new Set(parts.map(p => String(p.action || '').trim()).filter(Boolean))];
  const every = Math.max(1, Math.ceil(actions.length / 16));
  const cues = actions.filter((_, i) => i % every === 0).map(a => '- ' + a.slice(0, 160));
  return [
    `BẮT ĐẦU: "${title}" — ${locations.length ? 'MV ca nhạc (bối cảnh theo storyboard)' : 'MV Live Concert'}.`,
    `STORYBOARD ĐÃ CÓ SẴN (nhập từ CSV phân tích nhạc): KHÔNG cần thiết kế shot. Mảng "shots" chỉ cần ĐÚNG 1 shot mẫu (uses: ${cast[0][0]} + ${locations.length ? placeKey(locations[0]) : 'stage'}).`,
    'Hãy thiết kế ĐẦY ĐỦ phần TẠO HÌNH theo đúng master prompt cho DÀN SAU, dùng ĐÚNG các key này (không đổi key, không thêm nhân vật khác):',
    ...cast.map(([k, d]) => `- ${k} (role "character"): ${d}`),
    ...sets,
    'Kèm "style" chung và "cameras" như master prompt.',
    ...(crowd
      ? [
          'Nhóm đông (choir / dàn nhạc / khán giả) được dựng từ bối cảnh + prompt, KHÔNG tạo asset riêng.',
        ]
      : []),
    'Thế giới hình ảnh rút từ storyboard (đạo cụ, ánh sáng, nhạc cụ, cảm xúc) — tạo hình phải khớp:',
    ...cues,
    'Chỉ trả về đúng khối JSON blueprint theo schema, không thêm chữ nào ngoài khối JSON.',
  ].join('\n');
}

const REF_ZONES = ['character', 'wardrobe', 'design'];
// Merge a built blueprint's cast into the open project: its characters / costumes / scenes (by
// key: an asset the project already has is kept, with its images) and its style. Untouched
// template placeholders (no image, no prompt, no key) give way to the designed cast in their zone.
function mergeCast(graph) {
  const assets = graph.nodes.filter(
    x => !x.terminal && !isSetting(x) && REF_ZONES.includes(nodeZone(x)),
  );
  const byKey = new Map(db.nodes.filter(x => x.assetKey).map(x => [x.assetKey, x.id]));
  const added = assets.filter(x => !(x.assetKey && byKey.has(x.assetKey)));
  const ids = new Set(added.map(x => x.id));
  // A blueprint asset the project already has stands for that project node (and its images).
  const remap = new Map(
    assets.filter(x => x.assetKey && byKey.has(x.assetKey)).map(x => [x.id, byKey.get(x.assetKey)]),
  );
  for (const x of added) {
    x.seq = nextSeq(nodeZone(x));
    db.nodes.push(x);
  }
  // Edges inside the cast into the new nodes (character → its look, scene → its angle …), with a
  // kept asset standing in for its blueprint twin; the blueprint's own shots and the wires into
  // them are dropped.
  for (const e of graph.edges) {
    const source = remap.get(e.source) || e.source;
    if (ids.has(e.target) && (ids.has(source) || remap.has(e.source)))
      db.edges.push({ source, target: e.target });
  }
  // Placeholders of a zone that now has a designed asset.
  const designed = new Set(db.nodes.filter(x => x.assetKey).map(nodeZone));
  const gone = new Set(
    db.nodes
      .filter(
        x =>
          !String(x.id).startsWith('node-') &&
          !x.terminal &&
          !isSetting(x) &&
          REF_ZONES.includes(nodeZone(x)) &&
          designed.has(nodeZone(x)) &&
          !x.image &&
          !x.assetKey &&
          // (a placeholder set already pinned in 3D stays, and so does one a 3D stage node is
          // wired into: its shots keep their marks through it)
          !x.stage3d?.performers?.length &&
          !db.edges.some(e => e.target === x.id && isStageOnly(getNode(e.source))) &&
          !String(x.prompt || '').trim(),
      )
      .map(x => x.id),
  );
  db.nodes = db.nodes.filter(x => !gone.has(x.id));
  db.edges = db.edges.filter(e => !gone.has(e.source) && !gone.has(e.target));
  // The MV's look: the blueprint style replaces the project's style text (or is added).
  let style = 'none';
  const bpStyle = graph.nodes.find(
    x => isSetting(x) && x.settingType === 'style' && String(x.config || '').trim(),
  );
  if (bpStyle) {
    const cur = db.nodes.find(x => isSetting(x) && x.settingType === 'style');
    if (!cur) {
      bpStyle.seq = nextSeq('setup');
      db.nodes.push(bpStyle);
      style = 'added';
    } else if (cur.config !== bpStyle.config) {
      cur.config = bpStyle.config;
      markChildren(cur.id); // everything rendered under the old look is out of date
      style = 'updated';
    } else style = 'same';
  }
  return {
    added: added.length,
    characters: added.filter(x => nodeZone(x) === 'character').length,
    scenes: added.filter(x => nodeZone(x) === 'design').length,
    kept: assets.length - added.length,
    removedPlaceholders: gone.size,
    style,
  };
}

// --- Auto-wiring ---------------------------------------------------------------------------

const strip = s =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
const PLACE_RE = /\b(stage|opera|hall|balcony|architecture|environment|san khau|boi canh)\b/;
// A set's blueprint key from its Location name ("Main stage" → "main_stage").
const placeKey = s =>
  strip(s)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'stage';
// The scene a Location names: the one designed for it (by key), else one with that name.
function sceneFor(location, refNodes) {
  const s = strip(location);
  if (!s) return null;
  const scenes = refNodes.filter(n => nodeZone(n) === 'design' && n.role !== 'angle');
  const k = placeKey(location);
  return (
    (scenes.find(n => strip(n.assetKey) === k) || scenes.find(n => strip(n.name) === s))?.id || null
  );
}
// Instrument players, also found by their instrument ("Piano keys" → the pianist).
const PLAYERS = [
  ['piano', 'pianist'],
  ['guitar', 'guitarist'],
  ['violin', 'violinist'],
  ['cello', 'cellist'],
  ['drum', 'drummer'],
  ['bass', 'bassist'],
];

// What a CSV shot can be wired to: the reference assets (designed ones — with a blueprint key —
// before template placeholders), the main stage, and the project style. Camera presets are never
// wired: each CSV beat already names its own framing.
function wireContext() {
  const refNodes = db.nodes
    .filter(x => !x.terminal && !isSetting(x) && !isMusic(x) && REF_ZONES.includes(nodeZone(x)))
    .sort((a, b) => Number(!!b.assetKey) - Number(!!a.assetKey));
  return {
    refNodes,
    mainScene: refNodes.find(x => nodeZone(x) === 'design' && x.role !== 'angle') || null,
    styleNode: db.nodes.find(x => isSetting(x) && x.settingType === 'style') || null,
  };
}
// Wire one CSV shot like the MV blueprint wires its shots ("uses" singer + stage, style on all):
// the performers first, in beat order (= the [1] [2] … order the prompt names) — from each beat's
// Subject and any performer its Visual Action names — then the places, then the style. replace:
// drop the shot's current image + style inputs first (re-wiring to a new cast); a changed set of
// images marks what was made from the old ones out of date. Returns whether any image was wired.
function wireShot(node, ctx, replace) {
  const parts = node.parts || [];
  const persons = [],
    places = [];
  const add = (list, id) => id && !persons.includes(id) && !places.includes(id) && list.push(id);
  for (const pt of parts) {
    // the set its Location names wins over a place word in the Subject ("Stage")
    const here = pt.location ? sceneFor(pt.location, ctx.refNodes) : null;
    if (here) add(places, here);
    const tid = wireTargetFor(pt.subject, ctx.refNodes);
    const isPlace = tid && nodeZone(getNode(tid)) === 'design';
    if (tid && !(isPlace && here)) add(isPlace ? places : persons, tid);
    for (const pid of performersIn(pt.subject, pt.action, ctx.refNodes)) add(persons, pid);
  }
  // Performers and wides sit in the main stage when no set was named; a macro detail insert does
  // not need it — unless it wired nobody either, and the shot would be rendered from its prompt
  // alone (a detail of an object whose Location names no set of this project).
  if (
    ctx.mainScene &&
    !places.length &&
    (!persons.length || parts.some(pt => !/macro/i.test(pt.shotSize)))
  )
    add(places, ctx.mainScene.id);
  const ids = [...persons, ...places];
  let before = [];
  if (replace) {
    // (a 3D stage node wired in is the user's choice: kept, and no picture input)
    const isAuto = e => {
      const s = getNode(e.source);
      return (
        e.target === node.id && s && !isStageOnly(s) && (!isSetting(s) || s.settingType === 'style')
      );
    };
    before = imageParents(node).map(x => x.id);
    db.edges = db.edges.filter(e => !isAuto(e));
  }
  for (const sid of ids) db.edges.push({ source: sid, target: node.id });
  if (ctx.styleNode) db.edges.push({ source: ctx.styleNode.id, target: node.id });
  // On a set staged in 3D, a band framing also holds every performer standing in its frame.
  wireStageCast(node);
  const after = imageParents(node).map(x => x.id);
  if (replace && JSON.stringify(before) !== JSON.stringify(after)) {
    markStale(node);
    markChildren(node.id);
  }
  return ids.length > 0;
}

// The lead singer: a character named/keyed as one, else the first character (the MV blueprint
// lists the singer first).
const leadOf = refNodes => {
  const chars = refNodes.filter(n => nodeZone(n) === 'character');
  return (
    chars.find(c => /singer|ca si|vocal/.test(strip(c.name) + ' ' + strip(c.assetKey))) ||
    chars[0] ||
    null
  );
};
// Performers a beat shows: the lead singer and instrument players named in its Subject — a player
// also by their instrument ("Piano keys" → the pianist) — or named in its Action ("Pianist answers
// the phrase"). An instrument named only in the Action ("light glints off the piano lid") brings
// its player only into a band / ensemble shot. A Subject that means the whole group ("Band",
// "Ensemble", "Dàn nhạc"…) shows EVERY musician of the project whether the Action names their
// instruments or not — the coverage stream is made of those framings, and a band wide with nobody
// wired invents its faces. Characters only.
function performersIn(subject, action, refNodes) {
  const chars = refNodes.filter(n => nodeZone(n) === 'character');
  const out = [];
  const lead = leadOf(refNodes);
  if (lead && SINGER_RE.test(strip(subject) + ' | ' + strip(action))) out.push(lead.id);
  for (const player of playersIn(subject, action)) {
    const n = chars.find(c => strip(c.name).includes(player) || strip(c.assetKey).includes(player));
    if (n && !out.includes(n.id)) out.push(n.id);
  }
  // the rest of the group, after the players its Action names (they are the frame's foreground) and
  // only as many as fit in one image request beside the set and a stage capture
  if (GROUP_RE.test(strip(subject)))
    for (const c of chars)
      if (c.id !== lead?.id && !out.includes(c.id) && out.length < LAYOUT_MAX - 2) out.push(c.id);
  return out;
}
const SINGER_RE = /\b(singer|vocalist|ca si)\b/;
// A Subject that means the whole group — the words the 3D stage also reads as a band framing.
const GROUP_RE = /\b(band|ensemble|orchestra|musicians|choir|everyone|ban nhac|dan nhac)\b/;
// The instrument players a beat shows (see performersIn).
function playersIn(subject, action) {
  const s = strip(subject),
    a = strip(action);
  const named = (t, w) => new RegExp(`\\b${w}s?\\b`).test(t);
  return PLAYERS.filter(
    ([inst, player]) =>
      s.includes(inst) ||
      named(s, player) ||
      named(a, player) ||
      (GROUP_RE.test(s) && named(a, inst)),
  ).map(([, player]) => player);
}
// Which reference node a beat's Subject points at: the lead "Singer" → the lead character;
// stage/architecture words → the first scene; otherwise a node whose name / key / code matches a
// word of the Subject. Returns a node id or null.
function wireTargetFor(subject, refNodes) {
  const s = strip(subject);
  if (!s) return null;
  if (/^(singer|vocalist|vocal|ca si)\b/.test(s)) return leadOf(refNodes)?.id || null;
  if (PLACE_RE.test(s)) return refNodes.find(n => nodeZone(n) === 'design')?.id || null;
  // the Subject's first word (4+ letters, so "the" / "old" match nothing) as the start of a word of
  // the node's name: "Violin" → "Violinist", never "Old Bible" → "Golden-lit chapel"
  const first = s.split(/[\s—–-]+/)[0].replace(/[^a-z0-9]/g, '');
  const startsWord = name => first.length >= 4 && new RegExp(`\\b${first}`).test(name);
  for (const n of refNodes) {
    const name = strip(n.name),
      key = strip(n.assetKey),
      code = strip(n.code);
    if (
      (name.length >= 3 && (s.includes(name) || startsWord(name))) ||
      (key.length >= 3 && s.includes(key)) ||
      (code && s.includes(code))
    )
      return n.id;
  }
  return null;
}

// --- YouTube metadata ----------------------------------------------------------------------

// Pull { title, lengthSeconds } from a YouTube watch page without an API key. Best-effort.
export async function fetchYouTubeMeta(url) {
  const id = youTubeId(url);
  if (!id) return null;
  const r = await fetch('https://www.youtube.com/watch?v=' + id, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return null;
  return extractYouTubeMeta(await r.text());
}

// The 11-char video id from a watch / youtu.be / embed / shorts / live URL.
export function youTubeId(url) {
  const s = String(url || '');
  const m =
    s.match(/[?&]v=([\w-]{11})/) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/\/(?:embed|shorts|live)\/([\w-]{11})/);
  return m ? m[1] : '';
}

// Parse the watch-page HTML for the video length (seconds) and title. Pure, so it is unit-tested.
export function extractYouTubeMeta(html) {
  const text = String(html || '');
  const len = text.match(/"lengthSeconds":"(\d+)"/);
  const lengthSeconds = len ? Number(len[1]) : 0;
  let title = '';
  const t1 = text.match(/<meta\s+name="title"\s+content="([^"]*)"/i);
  if (t1) title = decodeHtml(t1[1]);
  if (!title) {
    const t2 = text.match(/"title":\s*"((?:[^"\\]|\\.)*)"/);
    if (t2) {
      try {
        title = JSON.parse('"' + t2[1] + '"');
      } catch {
        title = t2[1];
      }
    }
  }
  if (!title) {
    const t3 = text.match(/<title>([^<]*)<\/title>/i);
    if (t3) title = decodeHtml(t3[1]).replace(/\s*-\s*YouTube\s*$/i, '');
  }
  return { title: String(title || '').trim(), lengthSeconds };
}

const decodeHtml = s =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#39;/g, "'");
