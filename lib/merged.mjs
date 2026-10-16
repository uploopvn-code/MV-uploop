// Merged scenes: 2–3 camera setups of ONE conversation, filmed as one Veo clip.
// Each setup is a frame node in the production column — its own keyframe image, built from
// the location plate plus the two character sheets. The frames wire into a merged node in
// the "⑦ Phân cảnh ghép" column, which sends those images as reference images (Veo calls
// them Ingredients) and a prompt that cuts hard at each timecode.
// The tested recipes and prompts this file reproduces: Veo-shot-notes.md, sections 3–6.
import {
  getNode,
  imageParents,
  isCharacter,
  isSetting,
  isWardrobe,
  settingParents,
} from './nodes.mjs';
import { aspectPhrase } from './aspect.mjs';
import { db } from './projects.mjs';
import { castOf, noLine, speakerOf } from './prompts.mjs';

// The node that holds the prompt and makes the clip.
export const isMerged = n => n?.role === 'merged';
// One camera setup of a merged scene: an image only, never filmed on its own.
export const isFrame = n => n?.role === 'frame';
// The camera setups a frame can be. ots_a looks at the person on the RIGHT over the left
// one's shoulder; ots_b is its 180° reverse; two_shot holds both.
export const FRAMINGS = ['ots_a', 'ots_b', 'two_shot'];
export const CLIP_SECONDS = 8; // Veo 3.1 always renders 8 seconds
export const MAX_FRAMES = 3; // and takes at most 3 reference images (only 3 framings exist anyway)
export const MAX_BEATS = 6; // but rapid dialogue may cut among those images several times in 8 s
const MIN_BEAT = 2; // a cut shorter than this leaves no room for a line (relaxed for many beats)
export const WORDS_PER_SECOND = 3; // faster than this and the line gets swallowed

// The frame images of a merged scene, in the order they are cut. These are the camera-setup
// stills (one per framing) that Veo gets as reference images.
export const frames = m =>
  imageParents(m)
    .filter(isFrame)
    .sort((a, b) => (a.frameNo || a.seq || 0) - (b.frameNo || b.seq || 0));
// The distinct camera-setup images, one per framing used, in first-cut order. Only 3 framings
// exist, so this is always ≤ 3 — a rapid exchange reuses them across more cuts than there are
// images (A/B/A/B/A uses two stills, five cuts).
export const setupFrames = m => {
  const seen = new Map();
  for (const f of frames(m)) {
    const fr = f.framing || 'two_shot';
    if (!seen.has(fr)) seen.set(fr, f);
  }
  return [...seen.values()];
};
// The dialogue beats in cut order. A scene that reuses setups carries an explicit `beats` list
// on the merged node ({ framing, lyric, frameAction, audioDelivery }); a classic one cut per
// image has none, so each frame is its own beat (keeps old projects and their clips working).
export const beatsOf = m => {
  const byFraming = new Map(setupFrames(m).map(f => [f.framing || 'two_shot', f]));
  const order = setupFrames(m).map(f => f.framing || 'two_shot');
  const imageK = fr => order.indexOf(fr) + 1; // which reference image this framing is
  if (Array.isArray(m.beats) && m.beats.length)
    return m.beats.map((b, i) => {
      const framing = FRAMINGS.includes(b.framing) ? b.framing : 'two_shot';
      return {
        no: i + 1,
        framing,
        frame: byFraming.get(framing) || null,
        imageK: imageK(framing),
        lyric: String(b.lyric || ''),
        frameAction: String(b.frameAction || b.action || ''),
        audioDelivery: String(b.audioDelivery || b.audio_delivery || ''),
      };
    });
  return frames(m).map((f, i) => ({
    no: i + 1,
    framing: f.framing || 'two_shot',
    frame: f,
    imageK: imageK(f.framing || 'two_shot'),
    lyric: String(f.lyric || ''),
    frameAction: String(f.frameAction || ''),
    audioDelivery: String(f.audioDelivery || ''),
  }));
};
// The merged scenes a frame belongs to.
export const mergedOf = id =>
  db.edges
    .filter(e => e.source === id)
    .map(e => getNode(e.target))
    .filter(isMerged);

const tidy = s =>
  String(s || '')
    .trim()
    .replace(/[.\s]+$/, '');
const sentence = s => (tidy(s) ? tidy(s) + '.' : '');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// The words of a line, without the "Name:" prefix and the quotes around them.
const words = s =>
  String(s || '')
    .replace(/^\s*[^:"[\]]+:\s*/, '')
    .trim()
    .replace(/^["“]([^]*)["”]$/, '$1')
    .trim();
const wordCount = s => (words(s).match(/\S+/g) || []).length;
const mmss = s => '00:' + String(Math.round(s)).padStart(2, '0');

// The 8 seconds split across the beats: two share them evenly (the tested A/B cut at 00:04),
// three or more follow how long each line takes to say, never under `minBeat` seconds. With
// many fast beats the floor drops so five or six short cuts still fit the 8 seconds.
function split(counts, minBeat = MIN_BEAT) {
  const n = counts.length;
  if (n < 2) return counts.map(() => CLIP_SECONDS);
  if (n === 2) return [CLIP_SECONDS / 2, CLIP_SECONDS / 2];
  const floor = Math.max(1, Math.min(minBeat, Math.floor(CLIP_SECONDS / n)));
  const total = counts.reduce((a, b) => a + b, 0);
  const secs = counts.map(c =>
    total ? Math.max(floor, Math.round((CLIP_SECONDS * c) / total)) : Math.floor(CLIP_SECONDS / n),
  );
  // Rounding rarely lands on 8: balance by words-per-second, not raw length. The frame the ear
  // loses is the one with more words than its seconds allow, so take a second from the frame
  // with the MOST slack (lowest words/second — a silent beat is 0) and give it to the one most
  // pressed. Taking from the longest instead would flatten a wordy line toward the others and
  // leave it over the pace limit even after trimming.
  const sum = () => secs.reduce((a, b) => a + b, 0);
  const wps = i => (secs[i] > 0 ? counts[i] / secs[i] : 0);
  const pick = (ok, better) => {
    let best = -1;
    for (let i = 0; i < n; i++) if (ok(i) && (best < 0 || better(i, best))) best = i;
    return best;
  };
  let guard = 0;
  while (sum() > CLIP_SECONDS && guard++ < 1000) {
    const i = pick(
      i => secs[i] > floor,
      (i, b) => wps(i) < wps(b),
    );
    if (i < 0) break;
    secs[i] -= 1;
  }
  while (sum() < CLIP_SECONDS && guard++ < 1000) {
    const i = pick(
      () => true,
      (i, b) => wps(i) > wps(b),
    );
    if (i < 0) break;
    secs[i] += 1;
  }
  return secs;
}
// The seconds each beat would get, from its spoken-word count alone — the SAME split the clip
// itself uses. Lets a blueprint be checked for pace before anything is built from it.
export const beatSeconds = counts =>
  split(counts, Math.min(MIN_BEAT, Math.floor(CLIP_SECONDS / Math.max(counts.length, 1))));
// When each beat is on screen: [{ ...beat, from, to, seconds }], and the timecodes to cut at.
// The timeline is the beat list (a cut per line), the references are the ≤3 distinct setup
// images those beats reuse.
export function mergedPlan(m) {
  const beats = beatsOf(m);
  // A silent beat ("[Không thoại; …]") contributes no spoken words, so it claims only the floor
  // and leaves the rest of the 8 seconds to the lines that must be heard. More beats → a lower
  // floor so five or six fast cuts still fit.
  const minBeat = Math.min(MIN_BEAT, Math.floor(CLIP_SECONDS / Math.max(beats.length, 1)));
  const secs = split(
    beats.map(b => (noLine(b.lyric) ? 0 : wordCount(b.lyric))),
    minBeat,
  );
  let t = 0;
  const timeline = beats.map((b, i) => {
    const from = t;
    t += secs[i];
    return { ...b, k: i + 1, from, to: t, seconds: secs[i] };
  });
  return { frames: setupFrames(m), timeline, cuts: timeline.slice(1).map(b => mmss(b.from)) };
}

// A person in frame: the character node, or the look (that character wearing a costume).
const isPerson = p => !!p && (isCharacter(p) || p.role === 'look');
// What the prompt may say about someone: the Bible's identity label and back view, and the
// code (NV1…) that stands in for the real name. A look answers to its character; the
// costume it wears decides what the camera sees from behind, so its own back view wins.
function personOf(p) {
  const base = p.role === 'look' ? imageParents(p).find(isCharacter) || p : p;
  const costume = p.role === 'look' ? imageParents(p).find(isWardrobe) : null;
  const gender = /^\s*male\b/i.test(base.voice || '')
    ? 'male'
    : /^\s*female\b/i.test(base.voice || '')
      ? 'female'
      : '';
  return {
    node: p,
    base,
    code: String(base.code || '').trim(),
    label: tidy(p.label || costume?.label || base.label),
    back: tidy(p.back || costume?.back || base.back),
    voice: base.voice || '',
    poss: gender === 'male' ? 'his' : gender === 'female' ? 'her' : 'their',
    obj: gender === 'male' ? 'him' : gender === 'female' ? 'her' : 'them',
    gender,
  };
}
// "woman / women" when both are women, "man / men" when both are men, "person / people"
// otherwise — the prompt talks about the pair as often as about one of them.
function nouns(pair) {
  const g = pair.every(p => p.gender === 'female')
    ? 'female'
    : pair.every(p => p.gender === 'male')
      ? 'male'
      : '';
  return g === 'female'
    ? { one: 'woman', many: 'women' }
    : g === 'male'
      ? { one: 'man', many: 'men' }
      : { one: 'person', many: 'people' };
}
// A staging sentence is written once per side of the room ("firelight rims her hair"), so
// its pronouns follow whoever stands there in this scene.
function forPerson(text, p) {
  return tidy(text)
    .replace(/\b(his|their)\b/gi, p.poss)
    .replace(/\b(him|them)\b/gi, p.obj)
    .replace(/\bher\b(?=\s+\w)/gi, p.poss) // "her hair" — possessive
    .replace(/\bher\b/gi, p.obj); // "behind her" — object
}
// The staging of a location: its own, or that of the scene an angle plate is a view of.
const stagingOf = place => place?.staging || imageParents(place).find(p => p.staging)?.staging;
// A frame's inputs in the order they are sent: [1] the location, [2] the person on the left
// of frame, [3] the person on the right. The prompt names them by that index, so the wire
// order is what the image model is told.
export function frameCast(f) {
  const parents = imageParents(f);
  const people = parents.filter(isPerson).map(personOf);
  return {
    parents,
    place: parents.find(p => !isPerson(p)),
    left: people[0],
    right: people[1],
    index: node => parents.findIndex(p => p.id === node.id) + 1,
  };
}
// What is missing before this frame's image can be built: a wire, or a Bible field the
// over-the-shoulder template needs (identity label, back view, staging of the location).
export function frameProblem(f) {
  const { place, left, right } = frameCast(f);
  if (!place) return `${f.name}: nối node bối cảnh (hoặc góc bối cảnh) vào khung này.`;
  if (!left || !right) return `${f.name}: nối đúng 2 nhân vật vào khung này.`;
  const st = stagingOf(place) || {};
  if (!tidy(st.place))
    return `Bối cảnh "${place.name}" thiếu "conversation.place" trong Bible (câu mở tả địa điểm, tiếng Anh).`;
  for (const p of [left, right]) {
    if (!p.code)
      return `Nhân vật "${p.base.name}" thiếu "code" (NV1, NV2…) trong Bible: prompt gọi người bằng mã, không dùng tên thật.`;
    if (!p.label)
      return `Nhân vật "${p.base.name}" thiếu "identity_label" trong Bible (nhãn nhận dạng 2–5 chữ, ví dụ "the auburn-haired woman").`;
    if (f.framing !== 'two_shot' && !p.back)
      return `Nhân vật "${p.base.name}" thiếu "back_view" trong Bible (tả lưng, tóc sau và vai của bộ đang mặc).`;
  }
  for (const side of ['left', 'right']) {
    const s = st[side] || {};
    if (!tidy(s.background) || !tidy(s.light))
      return `Bối cảnh "${place.name}" thiếu "conversation.${side}" trong Bible (background + light của người đứng bên ${side === 'left' ? 'trái' : 'phải'}).`;
    if (f.framing === 'two_shot' && !tidy(s.anchor))
      return `Bối cảnh "${place.name}" thiếu "conversation.${side}.anchor" trong Bible (người bên ${side === 'left' ? 'trái' : 'phải'} đứng cạnh vật gì).`;
  }
  return '';
}
// The still that one camera setup is built from: the location plate and the two character
// sheets go in, this prompt says where everyone stands, who is sharp and where the light
// comes from. Over the shoulder (section 3 of the notes) or the medium two-shot (section 5).
export function framePrompt(f) {
  if (frameProblem(f)) return '';
  const { place, left, right, index } = frameCast(f);
  const st = stagingOf(place);
  const n = nouns([left, right]);
  // The Bible writes "The study from image 1 at night": image 1 is wherever the plate sits.
  const opening = tidy(st.place).replace(/\bimage\s*\d+\b/i, `image ${index(place)}`);
  const head = `Still frame, photorealistic, cinematic 35mm, ${aspectPhrase()}. ${sentence(opening)} The location reference shows this same empty place, possibly as several framings in one sheet; use it only for the space — architecture, furniture, materials and light — and build one single new frame of the moment below.`;
  const poss = n.one === 'person' ? 'their' : left.poss;
  const sheets = `Each ${n.one} appears once, with the same face, hair and clothes as ${poss} image; take only the ${n.many} from the character sheets, none of the printed words.`;
  if (f.framing === 'two_shot')
    return [
      head,
      `Medium two-shot${tidy(st.two_shot) ? ' ' + tidy(st.two_shot) : ''}, eye level: both ${n.many} seen waist-up, a few steps apart, facing each other in three-quarter profile, neither looking into the lens.`,
      `${cap(left.label)} from image ${index(left.node)} at frame left, ${forPerson(st.left.anchor, left)}, ${forPerson(st.left.background, left)} behind ${left.obj}; ${sentence(forPerson(st.left.light, left))}`,
      `${cap(right.label)} from image ${index(right.node)} at frame right, ${forPerson(st.right.anchor, right)}, ${forPerson(st.right.background, right)} behind ${right.obj}; ${sentence(forPerson(st.right.light, right))}`,
      sheets,
      `Moderate depth of field, both ${n.many} in focus, clean frame.`,
    ].join(' ');
  // Over the shoulder: the near one is the listener we see from behind, the far one faces
  // the camera. Each keeps the side of the frame they hold all through the conversation.
  const reverse = f.framing === 'ots_b';
  const near = reverse ? right : left,
    far = reverse ? left : right;
  const edge = reverse ? 'right' : 'left'; // which third the blurred shoulder fills
  const sharp = reverse ? 'left' : 'right'; // and where the one speaking sits
  const look = reverse ? 'frame right' : 'frame left';
  const behind = reverse ? st.left : st.right;
  return [
    head,
    `${reverse ? 'Reverse over' : 'Over'}-the-shoulder close-up: ${near.label} from image ${index(near.node)} seen from behind, ${forPerson(near.back, near)} out of focus, filling the ${edge} third of the frame.`,
    `${cap(far.label)} from image ${index(far.node)} in sharp focus ${sharp} of centre, chest-up, three-quarter view, looking ${look} at the other ${n.one}, not into the lens.`,
    `Behind ${far.obj} ${forPerson(behind.background, far)}; ${sentence(forPerson(behind.light, far))}`,
    sheets,
    'Shallow depth of field, clean frame.',
  ].join(' ');
}

const setupName = f =>
  f.framing === 'two_shot' ? 'the medium two-shot' : f.framing === 'ots_b' ? 'shot B' : 'shot A';
const framingName = fr =>
  fr === 'ots_a' ? 'qua vai A' : fr === 'ots_b' ? 'qua vai B' : 'trung đôi';
// Who speaks in a beat, as one of the two people in it (by the line's "Name:" prefix). The cast
// comes from the beat's setup frame (its reference image); the line comes from the beat.
function speakerIn(beat, left, right) {
  if (!beat || !beat.frame || noLine(beat.lyric)) return null;
  const cast = castOf(imageParents(beat.frame));
  const sp = speakerOf({ lyric: beat.lyric, videoPrompt: '' }, cast);
  if (!sp) return null;
  const entry = cast.find(c => c.person && c.label === sp.label);
  return (
    [left, right].find(p => p && entry && p.base.id === entry.node.id) ||
    [left, right].find(p => p && p.code && p.code === sp.label) ||
    null
  );
}
// What is missing before the merged scene can be filmed. `imgs` are the ≤3 distinct setup
// stills Veo gets as references; `beats` are the cuts (one per line), which may reuse them.
export function mergedProblem(m) {
  const imgs = setupFrames(m);
  const beats = beatsOf(m);
  if (beats.length < 2)
    return 'Nối 2–3 ảnh khung (node khung ở cột ⑥ Sản xuất) vào phân cảnh ghép này.';
  if (beats.length > MAX_BEATS)
    return `Phân cảnh ghép có ${beats.length} nhịp cắt; một clip 8 giây nhận tối đa ${MAX_BEATS}.`;
  if (imgs.length > MAX_FRAMES)
    return `Veo nhận tối đa ${MAX_FRAMES} ảnh: phân cảnh ghép này dùng ${imgs.length} cỡ cảnh.`;
  // Each distinct framing needs its one still; rapid beats reuse it.
  const noImage = imgs.find(f => !f.image);
  if (noImage) return `Khung "${noImage.name}" chưa có ảnh. Tạo ảnh khung trước.`;
  const stale = imgs.find(f => f.stale);
  if (stale) return `Ảnh khung "${stale.name}" đã thay đổi đầu vào. Tạo lại trước khi quay.`;
  // Every setup now HAS its still — the picture itself is what Veo is given, so the Bible
  // fields that only exist to BUILD one (identity label, back view, the staging sentences)
  // are no longer required here: a frame whose image the user uploaded by hand must film.
  // `frameProblem` still guards generating a frame image, in lib/routes/jobs.mjs.
  // What the CLIP itself cannot do without is the cast: the location and the two people must
  // be wired to every setup, because the cut list is written from them.
  const unwired = imgs.find(f => {
    const c = frameCast(f);
    return !c.place || !c.left || !c.right;
  });
  if (unwired)
    return `Khung "${unwired.name}": nối [1] bối cảnh và [2][3] hai nhân vật vào khung này.`;
  const orphan = beats.find(b => !b.frame);
  if (orphan)
    return `Nhịp ${orphan.no} (${framingName(orphan.framing)}) chưa có ảnh khung cỡ cảnh này — thêm một node khung ${orphan.framing}.`;
  // One conversation: the same place and the same two people, on the same sides, in every
  // setup image — the clip's prompt locks who is left and who is right once for all cuts.
  const first = frameCast(imgs[0]);
  for (const f of imgs.slice(1)) {
    const c = frameCast(f);
    if (
      c.place?.id !== first.place?.id ||
      c.left?.node.id !== first.left?.node.id ||
      c.right?.node.id !== first.right?.node.id
    )
      return `Khung "${f.name}" nối bối cảnh hoặc hai người khác thứ tự với khung "${imgs[0].name}": mọi khung cùng [1] bối cảnh, [2] người bên trái, [3] người bên phải.`;
  }
  // Every line must belong to one of the two, and in an over-the-shoulder beat to the one
  // facing the camera — or the clip lip-syncs the wrong person.
  for (const b of beats) {
    if (noLine(b.lyric)) continue;
    const sp = speakerIn(b, first.left, first.right);
    if (!sp)
      return `Nhịp ${b.no} (${framingName(b.framing)}): câu thoại phải viết dạng Tên: "…" với tên của một trong hai nhân vật (${first.left.base.name} hoặc ${first.right.base.name}).`;
    const facing = b.framing === 'ots_a' ? first.right : b.framing === 'ots_b' ? first.left : null;
    if (facing && sp !== facing)
      return `Nhịp ${b.no} (${b.framing === 'ots_a' ? 'qua vai A' : 'qua vai B'}): người nói phải là người quay mặt về máy, tức ${facing.code} bên ${b.framing === 'ots_a' ? 'phải' : 'trái'}. Đổi cỡ cảnh hoặc đổi "sides".`;
  }
  return '';
}
// The images this scene is filmed from: the ≤3 distinct setups (one per framing), in first-cut
// order. Veo gets them as reference images; beats that reuse a framing share its image.
export const mergedReferences = m => setupFrames(m).map(f => ({ role: f.id, asset: f.image }));

// The prompt of a merged scene: which image is which setup, where the cuts fall, one line
// per setup with the listener pinned shut, a voice lock per speaker, and unbroken room
// sound so the ear does not hear the cut (notes, sections 4 and 6).
export function mergedPrompt(m) {
  const { timeline } = mergedPlan(m);
  if (!timeline.length) return '';
  const imgs = setupFrames(m);
  const first = frameCast(imgs[0] || timeline[0].frame);
  const left = first.left,
    right = first.right;
  if (!left || !right) return '';
  const n = nouns([left, right]);
  const code = p => p.code || p.label;
  const who = p => (p.label ? `${p.label} (${code(p)})` : code(p));
  // The head describes the ≤3 distinct reference images; the blocks below cut among them by
  // name ("shot A", "shot B", "the medium two-shot"), returning to one as often as the dialogue
  // does. A reused setup is the SAME image again — Veo matches it, no new angle invented.
  // Who each person is, said ONCE here with their code, so the cut list below can call them
  // "NV1" / "NV2" and never repeat the identity label. Numbering the images removes the guess
  // about which attachment is which setup.
  const setups = imgs.map((f, i) => {
    const near = f.framing === 'ots_b' ? right : left;
    const far = f.framing === 'ots_b' ? left : right;
    return f.framing === 'two_shot'
      ? `Image ${i + 1} = the medium two-shot of both ${n.many}.`
      : `Image ${i + 1} = ${setupName(f)}: ${who(far)} faces camera over ${code(near)}'s blurred shoulder.`;
  });
  const cuts = timeline.slice(1).map(b => mmss(b.from));
  const reuse = timeline.length > imgs.length; // more cuts than images → a setup comes back
  const head = [
    `The ${imgs.length} attached images are the ${imgs.length} camera setups of one conversation in the same room. ${setups.join(' ')}`,
    'Recreate each exactly as its image shows — framing, focus, lighting, colour, faces, hair, clothes.',
    `${code(left)} is always frame left, ${code(right)} always frame right; each ${n.one} appears once per shot.`,
    `${timeline.length} shots, ${cuts.length === 1 ? 'one clean hard cut' : 'clean hard cuts'} at ${cuts.join(', ')} — no transition, morph, dissolve or camera movement.${reuse ? ' Cuts return to setups already seen: reuse that exact image, never invent a new angle.' : ''}`,
    // Said once instead of after every single cut.
    'In every shot only the named speaker’s lips move; the other keeps lips closed and stays still, and in the over-the-shoulder setups their face stays turned away.',
  ].join(' ');
  const voices = new Map();
  const blocks = timeline.map(b => {
    const speaker = speakerIn(b, left, right);
    const at = `[${mmss(b.from)}-${mmss(b.to)}]`;
    // Cite the setup's image NUMBER in the block, not just its name. The head already maps
    // "Image 2 = over-the-shoulder A", but a block that only says the name makes the model carry
    // that mapping down the whole prompt; the number in place removes the lookup at each cut.
    const shotImg = imgs.findIndex(f => f.framing === b.framing);
    const at_img = shotImg >= 0 ? ` (image ${shotImg + 1})` : '';
    const where =
      (b.framing === 'two_shot' ? 'Two-shot' : cap(setupName(b))) + at_img + '.';
    // The blueprint writes its action with "@NV1" tags; the block already names the speaker,
    // so drop the tag marks and any leading mention of the speaker to avoid naming them twice.
    const act = tidy(b.frameAction)
      .replace(/@([A-Za-z0-9_]+)/g, '$1')
      .replace(new RegExp(`^${speaker ? code(speaker) : ''}(?:'s)?\\s+`), '');
    if (!speaker) {
      // no line here (mergedProblem refuses a line nobody in frame can say)
      const ambience = tidy(
        String(b.audioDelivery || '')
          .replace(/^\[|\]$/g, '')
          .replace(/^\s*(không\s+thoại|no\s+dialogue|no\s+speech)\s*[;:,.-]*\s*/i, ''),
      );
      return `${at} ${where} No one speaks${act ? `: ${act}` : ''}.${ambience ? ` Location sound — ${ambience}.` : ''}`;
    }
    if (speaker.voice) voices.set(code(speaker), speaker.voice);
    const delivery = tidy(b.audioDelivery);
    // In a two-shot both faces are visible, so the speaker is pinned by which side they hold.
    const side =
      b.framing === 'two_shot' ? `, ${speaker === left ? 'on the left' : 'on the right'}` : '';
    return `${at} ${where} ${code(speaker)}${side}${act ? ', ' + act : ''}: "${words(b.lyric)}"${delivery ? ` — ${delivery}` : ''}.`;
  });
  const locks = [...voices].map(([c, v]) => `Voice lock for ${c}: ${tidy(v)}.`);
  return [
    head,
    ...blocks,
    ...locks,
    roomSound(m),
    styleLine(m),
    // The style line already asks for photorealistic 35mm, so this only adds what it does not —
    // and it drops any "no …" the user's own style preset has already asked for.
    finalTail(styleLine(m)),
  ]
    .filter(Boolean)
    .join('\n');
}
// The location sound, from the scene's audio preset or the node's own note. It must run
// unbroken across the cuts, or the ear hears them; and nothing else may be heard.
function roomSound(m) {
  const preset = settingParents(m).find(s => s.settingType === 'audio');
  const text = tidy(preset?.config) || tidy(m.audioDelivery);
  const room = text
    ? `Room sound runs unbroken across the cut${beatsOf(m).length > 2 ? 's' : ''}: ${text}. `
    : '';
  // Do not ask again for silence the preset already asks for ("no music, no melody…").
  const bans = notAlreadySaid(text, ['no other voices', 'no narration', 'no music']);
  return room + (bans.length ? cap(bans.join(', ')) + '.' : '');
}
// The "no …" items of `list` that `said` has not already covered.
const notAlreadySaid = (said, list) => {
  const t = String(said || '').toLowerCase();
  return list.filter(x => !t.includes(x));
};
function finalTail(style) {
  const bans = notAlreadySaid(style, ['no text', 'no subtitles', 'no captions', 'no watermarks']);
  return (
    `Clean frame, empty lower third${bans.length ? ', ' + bans.join(', ') : ''}. ` +
    'Fictional characters only, no resemblance to any real person.'
  );
}
function styleLine(m) {
  const style = settingParents(m).find(
    s => s.settingType !== 'audio' && s.settingType !== 'camera',
  );
  return tidy(style?.config) ? `Style: ${tidy(style.config)}.` : '';
}
// What the inspector shows about a merged scene: the frames in cut order with their seconds
// and pace, what still blocks the render, and what is merely worth a look.
export function mergedInfo(m) {
  const { timeline } = mergedPlan(m);
  const hasBeats = Array.isArray(m.beats) && m.beats.length > 0;
  const seenFraming = new Set();
  const list = timeline.map(b => {
    // A bracketed stage direction / silent beat ("[Không thoại; …]") carries no spoken line,
    // so its words are not said aloud — it can never be "too fast for Veo to say".
    const silent = noLine(b.lyric);
    const w = silent ? 0 : wordCount(b.lyric);
    const reuses = seenFraming.has(b.framing); // an earlier beat already shows this image
    seenFraming.add(b.framing);
    return {
      // A classic scene opens its frame node; a reused beat has no node of its own, so the
      // link points at the setup image it shares.
      id: b.frame?.id || null,
      name: hasBeats ? `Nhịp ${b.no} · ${framingName(b.framing)}` : b.frame?.name || '',
      framing: b.framing || '',
      line: b.lyric,
      action: b.frameAction || '',
      delivery: b.audioDelivery || '',
      from: b.from,
      to: b.to,
      words: w,
      pace: silent ? 0 : Math.round((w / b.seconds) * 10) / 10,
      tooFast: !silent && w > WORDS_PER_SECOND * b.seconds,
      hasImage: !!b.frame?.image,
      stale: !!b.frame?.stale,
      reuses, // true: this cut returns to an image an earlier beat already uses
    };
  });
  const fast = list.filter(f => f.tooFast);
  return {
    seconds: CLIP_SECONDS,
    maxFrames: MAX_FRAMES,
    maxBeats: MAX_BEATS,
    images: setupFrames(m).length,
    beats: list.length,
    frames: list,
    problem: mergedProblem(m),
    warning: fast.length
      ? `Thoại quá nhanh ở ${fast.map(f => `"${f.name}" (${f.pace} từ/giây)`).join(', ')}: nên ≤ ${WORDS_PER_SECOND} từ mỗi giây, rút ngắn câu kẻo Veo nuốt chữ.`
      : '',
    stage: stageInfo(m, timeline),
  };
}
// Everything the 2D staging editor needs for one merged scene: the location plate, the two
// people on their current sides, the location's staging text and the saved marker layout.
// The scene is filmed with the same place + same two people in every frame (mergedProblem
// enforces it), so the first frame speaks for the whole scene.
function stageInfo(m, timeline) {
  const base = timeline[0]?.frame ? frameCast(timeline[0].frame) : null;
  const url = x => (x && x.image && x.image.url) || null;
  const person = p =>
    p
      ? { id: p.node.id, name: p.base.name || p.node.name || '', code: p.code, image: url(p.node) }
      : null;
  return {
    framings: FRAMINGS,
    place: base?.place
      ? { id: base.place.id, name: base.place.name || '', image: url(base.place) }
      : null,
    left: person(base?.left),
    right: person(base?.right),
    text: base?.place?.staging || null, // the location's staging sentences
    blocking: m.blocking || null, // marker positions, for the editor to redraw (not in the prompt)
  };
}
