// Routes: edit/add/delete nodes, wires, arrange, uploads, swap image.
import { orderGraph } from '../../graph.mjs';
import { defaultNaming, validatePattern } from '../../output-config.mjs';
import { validateBinding } from '../../orbit-client.mjs';
import { validateSeedvisBinding } from '../../seedvis-client.mjs';
import { ANGLE_PRESETS } from '../../director.mjs';
import crypto from 'node:crypto';
import { NEXT, body, json } from '../http.mjs';
import { createBranchNode, requireIdle } from '../jobs.mjs';
import { rememberAndExport } from '../library.mjs';
import { storeAsset } from '../media.mjs';
import {
  deps,
  getNode,
  imageParents,
  isCharacter,
  isLipsync,
  isMusic,
  isSetting,
  isStageOnly,
  isWardrobe,
} from '../nodes.mjs';
import { db, mutate, vocalTasks } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import { groupMembers, groupsOf, isGroup, refreshGroups } from '../seedance.mjs';
import { isMerged, mergedOf } from '../merged.mjs';
import { clipsOf, flagClips, markChildren, markStale, setImage } from '../staleness.mjs';
import { ZONES, nextSeq, nodeZone } from '../zones.mjs';

// Reference sheets the user types instead of writing a prompt: a name and a description are
// enough, prompts() turns them into the house layout for that kind of subject. The zone is
// the canvas column each one belongs to.
const SHEET_ROLES = ['prop', 'character', 'scene'];
const SHEET = {
  prop: { zone: 'wardrobe', name: 'Vật dụng mới' },
  character: { zone: 'character', name: 'Nhân vật mới' },
  scene: { zone: 'design', name: 'Bối cảnh mới' },
};

export async function handle(req, res, p, u) {
  // Swap the node's image with the one it had before (an edit, a re-roll or an upload);
  // pressing again swaps forward.
  if (p === '/api/node/swap-image' && req.method === 'POST') {
    requireIdle();
    const b = await body(req),
      n = getNode(b.id);
    if (!n) throw new Error('Node không tồn tại');
    if (!n.prevImage) throw new Error('Không có ảnh trước để đổi lại.');
    // Each image keeps its own out-of-date flag: swapping to one made before the inputs
    // changed brings the warning with it.
    [n.image, n.prevImage] = [n.prevImage, n.image];
    [n.stale, n.prevStale] = [!!n.prevStale, !!n.stale];
    flagClips(n);
    markChildren(n.id);
    rememberAndExport(n);
    mutate();
    return json(res, 200, publicState());
  }
  // Put the storyboard back in order: the Sản xuất video column follows the shots' start
  // time (that column IS the timeline), every other column keeps the order it has, and all
  // of them get clean numbers again. One wrong drag or zone change used to leave a shot
  // numbered last for good.
  if (p === '/api/nodes/arrange' && req.method === 'POST') {
    requireIdle();
    const shots = db.nodes.filter(n => nodeZone(n) === 'production');
    shots
      .map((n, i) => ({ n, i }))
      .sort(
        (a, b) =>
          (Number.isFinite(a.n.start) ? a.n.start : Infinity) -
            (Number.isFinite(b.n.start) ? b.n.start : Infinity) ||
          (a.n.seq ?? 0) - (b.n.seq ?? 0) ||
          a.i - b.i,
      )
      .forEach(({ n }, i) => (n.seq = i + 1));
    refreshGroups(); // the timeline order is the groups' panel order
    mutate();
    return json(res, 200, publicState());
  }
  if (p === '/api/node' && req.method === 'PATCH') {
    requireIdle();
    const b = await body(req),
      n = getNode(b.id);
    if (!n) throw new Error('Node không tồn tại');
    const next = { ...n };
    if ('name' in b) {
      next.name = String(b.name).trim().slice(0, 100);
      if (!next.name) throw new Error('Tên node không được trống.');
    }
    if (b.outputNaming) {
      next.outputNaming = { ...n.outputNaming };
      for (const kind of ['image', 'video'])
        if (kind in b.outputNaming)
          next.outputNaming[kind] = validatePattern(b.outputNaming[kind], kind);
    }
    if ('orbit' in b) {
      next.orbit = { ...n.orbit };
      for (const kind of ['image', 'video'])
        if (kind in b.orbit)
          next.orbit[kind] =
            b.orbit[kind] === null ? null : await validateBinding(req, b.orbit[kind]);
    }
    if (b.seedvis) {
      next.seedvis = { ...n.seedvis };
      for (const kind of ['image', 'video'])
        if (kind in b.seedvis)
          next.seedvis[kind] =
            b.seedvis[kind] === false
              ? false
              : b.seedvis[kind] === null
                ? null
                : validateSeedvisBinding(kind, b.seedvis[kind]);
    }
    // Web worker source (ChatGPT extension …): a per-kind flag. Choosing it also sends
    // seedvis[kind] = false, so seedvisBinding() returns null and providers() reports "web".
    if (b.web) {
      next.web = { ...n.web };
      for (const kind of ['image', 'video'])
        if (kind in b.web) next.web[kind] = b.web[kind] === true;
    }
    // Google Vids (extension) source: a per-kind flag like web. Choosing it for video also sends
    // seedvis.video = false, so seedvisBinding() returns null and providers() reports "gvids".
    if (b.gvids) {
      next.gvids = { ...n.gvids };
      for (const kind of ['image', 'video'])
        if (kind in b.gvids) next.gvids[kind] = b.gvids[kind] === true;
    }
    // Muse Chat source: a per-kind flag like web/gvids. It can create images and videos.
    if (b.musechat) {
      next.musechat = { ...n.musechat };
      for (const kind of ['image', 'video'])
        if (kind in b.musechat) next.musechat[kind] = b.musechat[kind] === true;
    }
    if ('videoInput' in b) next.videoInput = b.videoInput === 'refs' ? 'refs' : 'self';
    // Output nodes stay in the output zone; others move between design/production.
    // (a 3D stage node stays with the locations: elsewhere it would pass for a person or a shot)
    if ('zone' in b && ZONES.includes(b.zone) && !n.terminal && !isStageOnly(n)) {
      // The Seedance column holds the Seedance groups, and a group stays there.
      if (b.zone !== nodeZone(n) && (b.zone === 'seedance' || isGroup(n)))
        throw new Error('Cột Seedance chỉ chứa nhóm Seedance; nhóm không chuyển sang cột khác.');
      if (b.zone !== nodeZone(n) && (b.zone === 'merged' || isMerged(n)))
        throw new Error(
          'Cột Phân cảnh ghép chỉ chứa node phân cảnh ghép; node ghép không chuyển sang cột khác.',
        );
      if (b.zone === 'seedance-video')
        throw new Error('Cột Video Seedance chỉ chứa video do nhóm Seedance tạo ra.');
      if (b.zone !== nodeZone(n) && (b.zone === 'lipsync' || isLipsync(n)))
        throw new Error('Cột Lip-sync chỉ chứa take lip-sync; take không chuyển sang cột khác.');
      if (b.zone === 'lipsync-video')
        throw new Error('Cột Video lip-sync chỉ chứa video do take lip-sync tạo ra.');
      const z = b.zone === 'output' ? 'production' : b.zone;
      if (z !== nodeZone(n)) {
        next.zone = z;
        if (!('seq' in b)) next.seq = nextSeq(z); // fresh number in the new zone
      }
    }
    if ('seq' in b) {
      const v = Math.floor(Number(b.seq));
      if (!Number.isFinite(v) || v < 1 || v > 9999) throw new Error('Số thứ tự không hợp lệ.');
      // Land just before the node currently at position v; mutate() then
      // renumbers the zone back to clean integers, so typing v moves it there.
      next.seq = v - 0.5;
    }
    if ('config' in b && isSetting(n)) next.config = String(b.config).slice(0, 5000);
    for (const k of ['prompt', 'videoPrompt', 'lyric'])
      if (k in b) next[k] = String(b[k]).slice(0, 20000);
    // Wardrobe nodes: the costume + personal items drive their generated image prompt.
    if (isWardrobe(n))
      for (const k of ['outfit', 'items']) if (k in b) next[k] = String(b[k]).slice(0, 2000);
    if (n.role === 'angle' && 'angle' in b) next.angle = String(b.angle).slice(0, 2000);
    // Typed reference sheets: one description is the whole input, the prompt is generated.
    if (SHEET_ROLES.includes(n.role) && 'desc' in b) next.desc = String(b.desc).slice(0, 2000);
    // Music node: the song reference (YouTube link + optional pasted lyrics) to analyze.
    if (isMusic(n)) {
      if ('youtubeUrl' in b) next.youtubeUrl = String(b.youtubeUrl).slice(0, 2000);
      if ('lyrics' in b) next.lyrics = String(b.lyrics).slice(0, 20000);
    }
    // Lip-sync take: the cut of the song sent to Omni can be nudged by hand.
    if (isLipsync(n) && ('clipStart' in b || 'clipEnd' in b)) {
      const cs = 'clipStart' in b ? Number(b.clipStart) : n.clipStart,
        ce = 'clipEnd' in b ? Number(b.clipEnd) : n.clipEnd;
      if (!Number.isFinite(cs) || !Number.isFinite(ce) || cs < 0 || ce - cs < 0.3 || ce - cs > 30)
        throw new Error('Đoạn cắt không hợp lệ (0.3–30 giây, bắt đầu ≥ 0).');
      next.clipStart = Math.round(cs * 1000) / 1000;
      next.clipEnd = Math.round(ce * 1000) / 1000;
    }
    for (const k of ['start', 'duration'])
      if (k in b) {
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v < 0 || (k === 'duration' && v === 0))
          throw new Error('Thời lượng không hợp lệ');
        next[k] = v;
      }
    // A description only builds the prompt while the node has no written prompt of its own —
    // that one wins in prompts(). Editing it under a written prompt changes nothing, so it
    // must not age the image or the clips below it.
    const descChanged = next.desc !== n.desc && !String(next.prompt || '').trim();
    const imageChanged =
      next.prompt !== n.prompt ||
      next.outfit !== n.outfit ||
      next.items !== n.items ||
      next.angle !== n.angle ||
      descChanged;
    const configChanged = isSetting(n) && next.config !== n.config;
    const changed = JSON.stringify(n) !== JSON.stringify(next);
    // Only what shapes the next clip makes the existing ones out of date — not a rename, a
    // new number, a move to another column or the file naming.
    const videoChanged =
      !n.terminal &&
      (descChanged ||
        // a take cut differently is a different source video
        next.clipStart !== n.clipStart ||
        next.clipEnd !== n.clipEnd ||
        [
          'prompt',
          'videoPrompt',
          'lyric',
          'start',
          'duration',
          'videoInput',
          'outfit',
          'items',
          'angle',
        ].some(k => next[k] !== n[k]) ||
        JSON.stringify(next.seedvis?.video) !== JSON.stringify(n.seedvis?.video));
    Object.assign(n, next);
    if (videoChanged) {
      flagClips(n);
      // the Seedance groups filming this shot now get another prompt / timeline
      for (const g of groupsOf(n.id)) flagClips(g);
      // …and the merged scene cut from this frame gets another prompt / timing
      for (const m of mergedOf(n.id)) flagClips(m);
    }
    // A style/camera change or an image-prompt change invalidates children.
    if (imageChanged || configChanged) {
      if (n.image) n.stale = true;
      if (n.prevImage) n.prevStale = true;
      markChildren(n.id);
    }
    refreshGroups(); // a new seq or column can reorder a Seedance group's shots
    if (changed) mutate();
    return json(res, 200, publicState());
  }
  if (p === '/api/upload' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    const target = b.nodeId === 'audio' ? null : getNode(b.nodeId);
    if (b.nodeId !== 'audio' && !target) throw new Error('Node không tồn tại');
    // The sidebar song and a MUSIC node both take an audio file; every other node takes
    // image/video. A MUSIC node only ever holds audio, whatever "kind" the client sends.
    const musicNode = !!target && isMusic(target);
    // the MUSIC nodes whose song this file replaces: the target, or (the sidebar song) every one
    // without a file of its own
    const songOf = musicNode
      ? [target]
      : b.nodeId === 'audio'
        ? db.nodes.filter(x => isMusic(x) && !x.audio)
        : [];
    if (songOf.some(x => vocalTasks.has(x.id)))
      throw new Error('Đang tách vocal của bài hiện tại — đợi xong rồi đổi file nhạc.');
    const kind =
      b.nodeId === 'audio' || musicNode ? 'audio' : b.kind === 'video' ? 'video' : 'image';
    if (!String(b.mime).startsWith(kind + '/')) throw new Error('Loại file không khớp');
    const a = storeAsset(b);
    // the vocals and their reading belonged to the previous song
    for (const x of songOf) {
      x.vocals = null;
      x.lyricTiming = null;
      x.vocalTask = null;
    }
    if (b.nodeId === 'audio') {
      db.audio = a;
      db.audioDuration = Number.isFinite(b.duration) ? b.duration : null;
    } else if (musicNode) {
      target.audio = a;
      target.audioDuration = Number.isFinite(b.duration) ? b.duration : null;
    } else {
      const n = target;
      if (kind === 'video' && !n.terminal) {
        // Same rule as a generated clip: it becomes its own node in the Video column.
        createBranchNode(n.id, a);
      } else if (kind === 'image') {
        setImage(n, a, false);
        // a Seedance group's storyboard shows these shots, in this order
        if (isGroup(n)) n.board = groupMembers(n).map(m => m.id);
      } else {
        n[kind] = a;
        n.videoStale = false;
      }
    }
    mutate();
    return json(res, 200, publicState());
  }
  if (p === '/api/nodes' && req.method === 'POST') {
    requireIdle();
    const b = await body(req);
    // Clips are results, not workflow nodes: they do not count towards the cap.
    if (db.nodes.filter(x => !x.terminal && !isGroup(x)).length >= 200)
      throw new Error('Giới hạn 200 node/project.');
    let node;
    const newEdges = [];
    if (b.kind === 'setting')
      node = {
        id: 'node-' + crypto.randomUUID(),
        kind: 'setting',
        settingType: ['camera', 'audio'].includes(b.settingType) ? b.settingType : 'style',
        zone: b.settingType === 'audio' ? 'audio' : 'setup',
        seq: nextSeq(b.settingType === 'audio' ? 'audio' : 'setup'),
        name: String(
          b.name || { camera: 'Máy quay', audio: 'Âm thanh' }[b.settingType] || 'Style',
        ).slice(0, 100),
        config: String(b.config || '').slice(0, 5000),
      };
    else if (b.kind === 'wardrobe') {
      // One character in one costume (+ personal items) for a scene context. Wired FROM
      // the character so its image is the face reference; shots then wire to this node
      // instead of the bare character. With no characterId the user wires one in later.
      const ch = b.characterId ? getNode(b.characterId) : null;
      if (b.characterId && (!ch || ch.terminal || isSetting(ch)))
        throw new Error('Nhân vật không tồn tại.');
      const count = db.nodes.filter(x =>
        ch ? x.role === 'wardrobe' && x.charId === ch.id : x.role === 'wardrobe' && !x.charId,
      ).length;
      node = {
        id: 'node-' + crypto.randomUUID(),
        role: 'wardrobe',
        zone: 'wardrobe',
        seq: nextSeq('wardrobe'),
        name: String(b.name || (ch ? ch.name : 'Nhân vật') + ' — Trang phục ' + (count + 1)).slice(
          0,
          100,
        ),
        prompt: '',
        outfit: String(b.outfit || '').slice(0, 2000),
        items: String(b.items || '').slice(0, 2000),
        // Which character wears it. Not an image input: the costume renders the garment
        // alone, and the "NV đã mặc" node does the try-on.
        ...(ch ? { charId: ch.id } : {}),
        image: null,
        video: null,
        outputNaming: { ...defaultNaming },
      };
    } else if (b.kind === 'look') {
      // "Character wearing this costume": composes the costume's character (face) and the
      // costume (outfit) into one face-locked reference that shots use instead of the raw
      // costume. The try-on prompt is generated server-side (see prompts()).
      const costume = getNode(b.costumeId);
      if (!costume || !isWardrobe(costume)) throw new Error('Chọn một node trang phục.');
      const ch = imageParents(costume).find(isCharacter) || getNode(costume.charId);
      if (!ch || !isCharacter(ch))
        throw new Error('Trang phục này chưa gắn nhân vật. Tạo nó từ node nhân vật.');
      node = {
        id: 'node-' + crypto.randomUUID(),
        role: 'look',
        zone: 'character', // a dressed version of the character: same column, right under it
        seq: (ch.seq || nextSeq('character')) + 0.5, // mutate() renumbers → lands after ch
        name: String(b.name || 'NV đã mặc: ' + costume.name).slice(0, 100),
        prompt: '',
        image: null,
        video: null,
        outputNaming: { ...defaultNaming },
      };
      newEdges.push({ source: ch.id, target: node.id }, { source: costume.id, target: node.id });
    } else if (b.kind === 'angle') {
      // A scene seen from another camera position: rendered FROM the scene's image so it is
      // the same place, dressing and light. Presets a / b = the two opposing close angles
      // of a dialogue (what camera OTS A sees / what OTS B sees). The prompt is server-owned.
      const scene = getNode(b.sceneId);
      if (!scene || scene.terminal || isSetting(scene) || nodeZone(scene) !== 'design')
        throw new Error('Chọn một node bối cảnh.');
      if (isStageOnly(scene))
        throw new Error('Node sân khấu 3D không có ảnh để render góc máy — dùng node bối cảnh.');
      const preset = ['a', 'b'].includes(b.preset) ? b.preset : '';
      const kids = db.nodes.filter(x => x.role === 'angle' && deps(x.id).includes(scene.id));
      if (preset && kids.some(x => x.preset === preset)) return json(res, 200, publicState());
      const p = preset ? ANGLE_PRESETS[preset] : null;
      node = {
        id: 'node-' + crypto.randomUUID(),
        role: 'angle',
        zone: 'design', // another view of the scene: same column, right under it
        seq: kids.reduce((m, x) => Math.max(m, x.seq || 0), scene.seq || nextSeq('design')) + 0.5,
        ...(scene.assetKey
          ? { assetKey: scene.assetKey + (preset ? '_' + preset : '_angle' + (kids.length + 1)) }
          : {}),
        ...(preset ? { preset } : {}),
        ofKey: scene.assetKey || '',
        name: String(
          b.name || scene.name + ' — ' + (p ? p.name : 'góc máy ' + (kids.length + 1)),
        ).slice(0, 100),
        angle: String(b.angle || p?.angle || '').slice(0, 2000),
        prompt: '',
        image: null,
        video: null,
        outputNaming: { ...defaultNaming },
      };
      newEdges.push({ source: scene.id, target: node.id });
    } else if (b.kind === 'music') {
      // A music node: paste a YouTube link / upload a song file (+ optional lyrics), then analyze
      // it into the parameters the tool needs. It lives in the Âm thanh column, wires to nothing.
      node = {
        id: 'node-' + crypto.randomUUID(),
        kind: 'music',
        zone: 'audio',
        seq: nextSeq('audio'),
        name: String(b.name || 'Nhạc (MUSIC)').slice(0, 100),
        youtubeUrl: String(b.youtubeUrl || '').slice(0, 2000),
        lyrics: String(b.lyrics || '').slice(0, 20000),
        audio: null,
        audioDuration: null,
        analysis: null,
      };
    } else if (b.kind === 'stage') {
      // A 3D stage node: only where the performers stand (pinned in the 3D editor), no picture of
      // its own. Wired into shots — or into the location they are filmed in — it gives them those
      // marks.
      const taken = new Set(db.nodes.map(x => x.name));
      let name = 'Sân khấu 3D';
      for (let i = 2; taken.has(name); i++) name = 'Sân khấu 3D ' + i;
      node = {
        id: 'node-' + crypto.randomUUID(),
        role: 'scene',
        stageNode: true,
        zone: 'design',
        seq: nextSeq('design'),
        name,
        desc: '',
        prompt: '',
        image: null,
        video: null,
        outputNaming: { ...defaultNaming },
      };
    } else if (SHEET_ROLES.includes(b.kind)) {
      // A typed reference sheet: the user writes a name and a description, prompts() turns
      // them into the model sheet (prop, character) or empty establishing shot (scene) that
      // keeps the subject consistent across every shot that references it.
      const sheet = SHEET[b.kind];
      // The name is what the library folder calls this subject's file, so two sheets must
      // never share one: a plain counter repeats itself after a delete, so skip names in use.
      const taken = new Set(db.nodes.map(x => x.name));
      let auto = sheet.name;
      for (let i = 2; taken.has(auto); i++) auto = sheet.name + ' ' + i;
      node = {
        id: 'node-' + crypto.randomUUID(),
        role: b.kind,
        zone: sheet.zone,
        seq: nextSeq(sheet.zone),
        name: String(b.name || auto).slice(0, 100),
        desc: String(b.desc || '').slice(0, 2000),
        prompt: '',
        image: null,
        video: null,
        outputNaming: { ...defaultNaming },
      };
    } else
      node = {
        id: 'node-' + crypto.randomUUID(),
        name: String(b.name || 'Ảnh mới').slice(0, 100),
        zone: 'production',
        seq: nextSeq('production'),
        prompt: '',
        videoPrompt: '',
        lyric: '',
        // after the last timed shot in the column, so a hand-added shot has its own slot on the
        // timeline (and its own subtitle time) instead of sitting at 0 on top of the others
        start: Math.max(
          0,
          ...db.nodes
            .filter(x => !x.terminal && nodeZone(x) === 'production' && 'duration' in x)
            .map(x => (Number(x.start) || 0) + (Number(x.duration) || 0)),
        ),
        duration: 8,
        image: null,
        video: null,
        outputNaming: { ...defaultNaming },
      };
    db.nodes.push(node);
    db.edges.push(...newEdges);
    mutate();
    return json(res, 201, publicState());
  }
  if (p === '/api/nodes/delete' && req.method === 'POST') {
    requireIdle();
    const b = await body(req),
      n = getNode(b.id);
    if (!n) throw new Error('Node không tồn tại');
    if (!String(n.id).startsWith('node-'))
      throw new Error('Chỉ xóa được node bạn thêm hoặc node phiên bản video.');
    // Only the nodes this one fed lose an input (a clip feeds nothing). Marking the whole
    // graph made one deleted clip flag every shot in the project.
    // (a 3D stage node feeds no picture: the shots whose marks it gave go out of date on their own)
    const fed =
      n.terminal || isStageOnly(n)
        ? []
        : db.edges.filter(e => e.source === n.id).map(e => e.target);
    db.nodes = db.nodes.filter(x => x.id !== n.id);
    db.edges = db.edges.filter(e => e.source !== n.id && e.target !== n.id);
    for (const t of fed.map(getNode).filter(x => x && !x.terminal)) {
      markStale(t);
      markChildren(t.id);
    }
    // A clip deleted: the shot's warning follows its newest clip left (none left, nothing
    // to be out of date). Deleting the one fresh clip brings the warning back.
    if (n.terminal) {
      const src = getNode(n.source);
      const newest = src && clipsOf(src.id).sort((a, b) => b.version - a.version)[0];
      if (src) src.videoStale = !!newest?.outdated;
    }
    mutate();
    return json(res, 200, publicState());
  }
  if (p === '/api/edges' && req.method === 'PUT') {
    requireIdle();
    const b = await body(req);
    if (!Array.isArray(b.edges)) throw new Error('Danh sách nối không hợp lệ');
    const edges = b.edges.map(e => ({ source: String(e.source), target: String(e.target) }));
    if (new Set(edges.map(e => e.source + '>' + e.target)).size !== edges.length)
      throw new Error('Đường nối trùng');
    orderGraph(db.nodes, edges);
    // A clip node is fed only by the shot that made it and feeds nothing: it holds a video,
    // not an image, so a wire out of it would leave the next node waiting for an image. Only
    // new wires are checked, so a project saved with an odd wire can still be edited.
    const had = new Set(db.edges.map(e => e.source + '>' + e.target));
    for (const e of edges) {
      if (had.has(e.source + '>' + e.target)) continue;
      const s = getNode(e.source),
        t = getNode(e.target);
      if (s?.terminal) throw new Error('Node video kết quả chỉ để xem, không nối ra node khác.');
      if (t?.terminal && t.source !== e.source)
        throw new Error('Node video kết quả chỉ nhận dây từ shot đã tạo ra nó.');
    }
    // (a 3D stage node wired in or out changes no picture input: the shots whose marks it
    // changes go out of date on their own — lib/stage3d.mjs reconcilePins)
    const inputs = (list, id) =>
      list.filter(e => e.target === id && !isStageOnly(getNode(e.source))).map(e => e.source);
    const changed = db.nodes.filter(
      n => JSON.stringify(inputs(db.edges, n.id)) !== JSON.stringify(inputs(edges, n.id)),
    );
    db.edges = edges;
    for (const n of changed) {
      // New inputs: the image and the clips (a refs-mode shot films its inputs directly).
      if (!n.terminal) markStale(n);
      markChildren(n.id);
    }
    mutate();
    return json(res, 200, publicState());
  }
  return NEXT;
}
