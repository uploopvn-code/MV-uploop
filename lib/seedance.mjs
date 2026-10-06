// Seedance groups: consecutive shots filmed in ONE Seedance render (up to 30 s with Seedance
// 2.5). A group node sits in the Seedance column, wired from its shots — so a changed keyframe
// makes it out of date like any other input. Its own image is the storyboard sheet the browser
// composes from the shots' keyframes. This module splits the shots into groups, plans the
// timeline, picks the reference images and writes the one timecoded prompt.
import { catalog } from '../seedvis-client.mjs';
import { defaultNaming } from '../output-config.mjs';
import crypto from 'node:crypto';
import { getNode, imageParents, isCharacter, isSetting, settingParents } from './nodes.mjs';
import { db } from './projects.mjs';
import {
  SILENT_MARK,
  SPEAK_MARK,
  VOICE_MARK,
  castOf,
  noLine,
  resolveTags,
  settingText,
  speakerOf,
  stripCastIntro,
} from './prompts.mjs';
import { seedvisBinding } from './providers.mjs';
import { markStale } from './staleness.mjs';
import { uncertainJobs } from './auto.mjs';
import { nextSeq, nodeZone } from './zones.mjs';
import { isFrame } from './merged.mjs';

export const isGroup = n => n?.role === 'seedance';
const DEFAULT_MODEL = 'seedance_2.5';
const seedanceModels = () => catalog.video.filter(m => /^seedance/i.test(m.id));
// The group's Seedance model (its own setting, else Seedance 2.5).
export function groupModel(g) {
  const id = seedvisBinding(g, 'video')?.model;
  return (
    seedanceModels().find(m => m.id === id) || seedanceModels().find(m => m.id === DEFAULT_MODEL)
  );
}
const pad2 = n => String(n || 0).padStart(2, '0');
// Whole seconds: Seedance timecodes are integers.
const secs = n => Math.max(1, Math.round(Number(n.duration) || 0));
const isShot = n =>
  !!n && !n.terminal && !isSetting(n) && !isFrame(n) && nodeZone(n) === 'production';

// The group's shots, in timeline order (the production column is the timeline).
export const groupMembers = g =>
  imageParents(g)
    .filter(isShot)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
// The groups a shot belongs to.
export const groupsOf = id =>
  db.edges
    .filter(e => e.source === id)
    .map(e => getNode(e.target))
    .filter(isGroup);

// Each shot keeps its own length; the render is the smallest duration the model accepts that
// holds them all, and the seconds left over become a still tail to trim in the edit.
export function groupPlan(g) {
  const model = groupModel(g);
  const members = groupMembers(g);
  let t = 0;
  const timeline = members.map((n, i) => {
    const from = t;
    t += secs(n);
    return { n, k: i + 1, from, to: t };
  });
  const steps = model.durations || [];
  const max = Math.max(...steps);
  return {
    model,
    members,
    timeline,
    total: t,
    max,
    over: t > max,
    D: steps.find(d => d >= t) ?? max,
  };
}

// Where a shot happens: the master scenes behind its scene / angle inputs.
const locationsOf = shot =>
  new Set(
    imageParents(shot)
      .filter(p => nodeZone(p) === 'design')
      .map(
        p => (p.role === 'angle' ? imageParents(p).find(x => nodeZone(x) === 'design') || p : p).id,
      ),
  );
const assetsOf = shot =>
  imageParents(shot).filter(p => !p.terminal && nodeZone(p) !== 'production');
const isPerson = p => isCharacter(p) || p.role === 'look';

// The images sent besides the storyboard: the people first, then the places, then the props,
// each ranked by how many of the group's shots use it, as many as the model takes. With fewer
// than two, the shots' own keyframes fill in: one storyboard plus a single image may be read as
// a first / last frame instead of as references.
export function groupRefs(g) {
  const cap = (groupModel(g).maxImages || 10) - 1;
  const uses = new Map();
  for (const s of groupMembers(g)) for (const p of assetsOf(s)) uses.set(p, (uses.get(p) || 0) + 1);
  const rank = p => (isPerson(p) ? 0 : nodeZone(p) === 'design' ? 1 : 2);
  const refs = [...uses.keys()]
    .filter(p => p.image)
    .sort((a, b) => rank(a) - rank(b) || uses.get(b) - uses.get(a))
    .slice(0, cap);
  for (const s of groupMembers(g)) if (refs.length < 2 && s.image) refs.push(s);
  return refs;
}

// What stops the group from being filmed now, or null.
export function groupProblem(g) {
  const plan = groupPlan(g);
  if (!plan.members.length) return 'Nhóm chưa có shot nào. Nối shot vào nhóm.';
  if (plan.over)
    return `Nhóm dài ${plan.total} giây, quá ${plan.max} giây của ${plan.model.name}. Cắt bớt dây shot hoặc chọn model dài hơn.`;
  const missing = plan.members.find(s => !s.image || s.stale);
  if (missing)
    return `Shot "${missing.name}" ${missing.image ? 'có ảnh đã cũ' : 'chưa có ảnh'}. Tạo ảnh shot trước rồi dựng storyboard.`;
  if (!g.image) return 'Chưa có storyboard. Bấm "🧩 Dựng storyboard" trong nhóm.';
  if (boardChanged(g))
    return 'Thứ tự hoặc danh sách shot trong nhóm đã đổi sau khi dựng storyboard. Bấm "🧩 Dựng storyboard" để dựng lại.';
  if (g.stale) return 'Ảnh shot trong nhóm đã đổi. Bấm "🧩 Dựng storyboard" để dựng lại.';
  return null;
}
// The storyboard's panels are the shots the group had, in their order, when it was composed
// (g.board): reordering, moving or rewiring a shot makes the sheet wrong for the prompt.
const boardChanged = g =>
  Array.isArray(g.board) &&
  g.board.join('|') !==
    groupMembers(g)
      .map(m => m.id)
      .join('|');
// Called after edits that can reorder shots (seq, column, arrange): a group whose sheet no
// longer matches gets out of date — storyboard and clips (they show the old order).
export function refreshGroups() {
  for (const g of db.nodes) if (isGroup(g) && g.image && !g.stale && boardChanged(g)) markStale(g);
}
// The references of the render: [1] the storyboard, then groupRefs.
export const groupReferences = g => [
  { role: 'keyframe', asset: g.image },
  ...groupRefs(g).map(p => ({ role: p.id, asset: p.image })),
];

// --- The prompt. One shot's text is what the blueprint wrote for it (staging, action, camera,
// light), without what the group prompt says once for all shots (format tail, cast line,
// voice lock, presets) or what the tool adds for a single-shot render.
const humanize = key =>
  String(key || '')
    .replace(/^(scene|prop|item|costume|look)_/, '')
    .replace(/_/g, ' ')
    .trim();
const tidy = s =>
  String(s || '')
    .trim()
    .replace(/[.\s]+$/, '');
function shotText(n, cast) {
  let t = stripCastIntro(n.videoPrompt || n.prompt || n.name)
    .replace(/^\s*Veo Video Prompt:\s*/i, '')
    .replace(/Compose connected reference subjects seamlessly\.\s*/gi, '')
    .replace(/Reference subjects, in the order of the attached images:[^]*?\.\s+(?=[A-Z@])/, '')
    .replace(
      /The attached image is the first frame of this shot:[^]*?exactly as they are\.(\s*In it:[^]*?\.(?=\s|$))?/,
      '',
    );
  // a single-shot prompt saved after the tool decorated it: cut at the first decoration
  for (const mark of [`The line ${SPEAK_MARK}`, VOICE_MARK + ' for', SILENT_MARK]) {
    const at = t.indexOf(mark);
    if (at >= 0) t = t.slice(0, at);
  }
  const settings = settingText(n);
  if (settings && t.includes(settings)) t = t.replace(settings, '');
  t = t.replace(/,?\s*16:9\b[^]*$/i, ''); // the format tail is said once for the whole render
  t = resolveTags(t, cast).replace(/@([A-Za-z0-9_]+)/g, (m, key) => humanize(key) || key);
  return tidy(t.replace(/\s+/g, ' '));
}
function soundText(n, cast, text) {
  if (noLine(n.lyric)) {
    const ambience = tidy(
      String(n.audioDelivery || '')
        .replace(/^\[|\]$/g, '')
        .replace(/^\s*(không\s+thoại|no\s+dialogue|no\s+speech)\s*[;:,.-]*\s*/i, ''),
    );
    return `No dialogue: nobody speaks and no lips move${ambience ? `; location sound — ${ambience}` : ''}.`;
  }
  const sp = speakerOf(n, cast);
  // the words alone: no "Name:" prefix, no quotes around them
  const words = String(n.lyric)
    .replace(/^\s*[^:"[\]]+:\s*/, '')
    .trim()
    .replace(/^["“]([^]*)["”]$/, '$1')
    .trim();
  // said once: the shot's own text may already carry the line
  const said = /mouth\s+articulat/i.test(text) || (words && text.includes(words.slice(0, 40)));
  const spoken = said || !words ? '' : ` Line: "${words}".`;
  const who = !sp
    ? spoken
      ? ' Only someone shown singing or speaking in its storyboard panel mouths it.'
      : ''
    : sp.voiceover
      ? ` Voice-over by ${sp.label}; no lips move.`
      : sp.index
        ? ` ${sp.label} (image ${sp.index}) speaks; everyone else stays silent.`
        : ` ${sp.label} speaks off-screen; no one in frame mouths it.`;
  const delivery = tidy(n.audioDelivery);
  return `${spoken}${who}${delivery ? ` Delivery: ${delivery}.` : ''}`.trim();
}
const unique = list => [...new Set(list.filter(Boolean))];
// [1, 2, 3, 5] → "1–3, 5"
const spans = ks =>
  ks
    .reduce((out, k) => {
      const last = out.at(-1);
      if (last && k === last[1] + 1) last[1] = k;
      else out.push([k, k]);
      return out;
    }, [])
    .map(([a, b]) => (a === b ? String(a) : `${a}–${b}`))
    .join(', ');
export function groupPrompt(g) {
  const plan = groupPlan(g);
  if (!plan.members.length) return '';
  const refs = groupRefs(g);
  const people = refs.filter(p => !isShot(p));
  // Images are numbered from 2: image 1 is the storyboard.
  const cast = castOf(people).map(c => ({ ...c, index: c.index + 1 }));
  // Places and props are told apart in English, never by their Vietnamese node names: an angle
  // by its letter ("the cemetery — angle A"), its master as the wide view.
  for (const c of cast) {
    if (c.person) continue;
    const p = c.node;
    const letter =
      p.role === 'angle' && p.ofKey && String(p.assetKey || '').slice(p.ofKey.length + 1);
    const hasAngles = cast.some(o => o.node?.role === 'angle' && o.node.ofKey === p.assetKey);
    c.desc = letter
      ? 'angle ' + letter.toUpperCase().replace(/_/g, ' ')
      : hasAngles
        ? 'master wide'
        : '';
  }
  for (const c of cast)
    if (!c.desc && cast.some(o => o !== c && o.label === c.label)) c.desc = c.node?.name || '';
  const kf = refs.filter(isShot).map(s => ({
    index: refs.indexOf(s) + 2,
    label: `the opening frame of shot ${plan.members.indexOf(s) + 1}`,
  }));
  const N = plan.members.length;
  const imageList = [
    ...cast.map(c => `Image ${c.index}: ${c.label}${c.desc ? ' — ' + c.desc : ''}`),
    ...kf.map(k => `Image ${k.index}: ${k.label}`),
  ].join('; ');
  const shots = plan.timeline.map(({ n, k, from, to }) => {
    const camera = settingParents(n)
      .find(s => s.settingType === 'camera')
      ?.config?.trim();
    const text = shotText(n, cast);
    const cam = camera && !/camera\s*:/i.test(text) ? ` Camera: ${tidy(camera)}.` : '';
    return `Shot ${k} (${from}–${to}s): ${text}.${cam} ${soundText(n, cast, text)}`.trim();
  });
  const tail =
    plan.D > plan.total
      ? `${plan.total}–${plan.D}s: hold on the last shot with only subtle natural movement, no new action and no cut — this tail is trimmed in the edit.`
      : '';
  const voices = unique(
    plan.members.map(n => {
      const sp = !noLine(n.lyric) && speakerOf(n, cast);
      return sp?.voice ? `${VOICE_MARK} for ${sp.label}: ${tidy(sp.voice)}.` : '';
    }),
  );
  const presets = type =>
    unique(
      plan.members.flatMap(n =>
        settingParents(n)
          .filter(s => s.settingType === type)
          .map(s => tidy(s.config)),
      ),
    );
  // Sound follows the shots: with one preset it is said once, with several, which shots get which.
  const audioOf = n =>
    settingParents(n)
      .filter(s => s.settingType === 'audio' && s.config?.trim())
      .map(s => tidy(s.config))
      .join('; ');
  const beds = new Map();
  for (const { n, k } of plan.timeline) {
    const a = audioOf(n);
    if (a) (beds.get(a) ?? beds.set(a, []).get(a)).push(k);
  }
  const audio =
    beds.size > 1
      ? [...beds].map(([a, ks]) => `shot${ks.length > 1 ? 's' : ''} ${spans(ks)}: ${a}`)
      : [...beds.keys()];
  const style = presets('style');
  return [
    `Create a ${plan.D}-second cinematic photorealistic video: one continuous scene in ${N} shot${N > 1 ? 's' : ''} with a hard cut at each timecode below. Use the attached images as strict visual references and recreate the storyboard sequence exactly, without changing the characters, location, props, wardrobe or story.`,
    `Image 1 is the storyboard: panels 1–${N}, read left to right and top to bottom, one panel per shot below. It sets each shot's framing, blocking and camera only; never show the storyboard grid, panel borders or panel numbers.${imageList ? ' ' + imageList + '.' : ''}`,
    ...shots,
    tail,
    ...voices,
    audio.length ? `Audio: ${audio.join('; ')}.` : '',
    style.length ? `Style: ${style.join('; ')}.` : '',
    'Keep every face, hairstyle and outfit identical in every shot. No subtitles, no captions, no on-screen text, no watermark. Fictional characters only, no resemblance to any real person or celebrity.',
  ]
    .filter(Boolean)
    .join('\n');
}

// What the browser shows for a group: its shots on the timeline, the images sent, the length.
export function groupInfo(g) {
  const plan = groupPlan(g);
  return {
    model: plan.model.id,
    models: seedanceModels().map(m => ({ id: m.id, name: m.name, max: Math.max(...m.durations) })),
    total: plan.total,
    D: plan.D,
    max: plan.max,
    members: plan.timeline.map(({ n, k, from, to }) => ({
      id: n.id,
      k,
      name: n.name,
      from,
      to,
      image: n.image?.url || null,
      ready: !!n.image && !n.stale,
    })),
    refs: groupRefs(g).map(p => ({ id: p.id, name: p.name })),
    problem: groupProblem(g),
    // renders of this group Seedvis may already have made: "↻ Kiểm tra lại" before a new one
    uncertain: uncertainJobs(g).length,
  };
}

// Splits the shots that are in no group yet into groups, in timeline order: a group ends when
// the next shot would make it longer than the model allows, would take it to another location,
// or would need more reference images than the model takes. Returns the new group ids.
export function makeGroups(modelId) {
  const model =
    seedanceModels().find(m => m.id === modelId) ||
    seedanceModels().find(m => m.id === DEFAULT_MODEL);
  const max = Math.max(...model.durations),
    cap = (model.maxImages || 10) - 1;
  const grouped = new Set(db.edges.filter(e => isGroup(getNode(e.target))).map(e => e.source));
  const shots = db.nodes
    .filter(n => isShot(n) && !grouped.has(n.id))
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  if (!shots.length)
    throw new Error('Mọi shot đã thuộc một nhóm Seedance. Xóa nhóm cũ để chia lại.');
  const groups = [];
  let cur = null;
  for (const s of shots) {
    const d = secs(s),
      loc = locationsOf(s),
      assets = assetsOf(s);
    const fits =
      cur &&
      cur.total + d <= max &&
      (!loc.size || !cur.loc.size || [...loc].some(x => cur.loc.has(x))) &&
      new Set([...cur.assets, ...assets]).size <= cap;
    if (!fits) groups.push((cur = { shots: [], total: 0, loc: new Set(), assets: new Set() }));
    cur.shots.push(s);
    cur.total += d;
    loc.forEach(x => cur.loc.add(x));
    assets.forEach(x => cur.assets.add(x));
  }
  const ids = [];
  for (const grp of groups) {
    const seq = nextSeq('seedance');
    const first = grp.shots[0].seq,
      last = grp.shots.at(-1).seq;
    const id = 'node-' + crypto.randomUUID();
    db.nodes.push({
      id,
      role: 'seedance',
      zone: 'seedance',
      seq,
      name: `Seedance ${pad2(seq)} · Shot ${first === last ? first : first + '–' + last}`,
      prompt: '',
      videoPrompt: '',
      image: null,
      video: null,
      seedvis: { video: { model: model.id, aspectRatio: '16:9' } },
      outputNaming: { ...defaultNaming },
    });
    for (const s of grp.shots) db.edges.push({ source: s.id, target: id });
    ids.push(id);
  }
  return ids;
}
