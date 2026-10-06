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
import { db } from './projects.mjs';
import { castOf, noLine, speakerOf } from './prompts.mjs';

// The node that holds the prompt and makes the clip.
export const isMerged = n => n?.role === 'merged';
// One camera setup of a merged scene: an image only, never filmed on its own.
export const isFrame = n => n?.role === 'frame';
// The camera setups a frame can be. ots_a looks at the person on the RIGHT over the left
// one's shoulder; ots_b is its 180° reverse; two_shot holds both.
export const FRAMINGS = ['ots_a', 'ots_b', 'two_shot'];
const CLIP_SECONDS = 8; // Veo 3.1 always renders 8 seconds
const MAX_FRAMES = 3; // and takes at most 3 reference images
const MIN_BEAT = 2; // a cut shorter than this leaves no room for a line
const WORDS_PER_SECOND = 3; // faster than this and the line gets swallowed

// The frames of a merged scene, in the order they are cut.
export const frames = m =>
  imageParents(m)
    .filter(isFrame)
    .sort((a, b) => (a.frameNo || a.seq || 0) - (b.frameNo || b.seq || 0));
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

// The 8 seconds split across the setups: two share them evenly (the tested A/B cut at
// 00:04), three follow how long each line takes to say, never under 2 seconds.
function split(counts) {
  const n = counts.length;
  if (n < 2) return counts.map(() => CLIP_SECONDS);
  if (n === 2) return [CLIP_SECONDS / 2, CLIP_SECONDS / 2];
  const total = counts.reduce((a, b) => a + b, 0);
  const secs = counts.map(c =>
    total
      ? Math.max(MIN_BEAT, Math.round((CLIP_SECONDS * c) / total))
      : Math.floor(CLIP_SECONDS / n),
  );
  // Rounding rarely lands on 8: give or take from the longest line until it does.
  const sum = () => secs.reduce((a, b) => a + b, 0);
  const longest = (only = () => true) =>
    secs.reduce((best, v, i) => (only(i) && (best < 0 || v > secs[best]) ? i : best), -1);
  while (sum() > CLIP_SECONDS) {
    const i = longest(i => secs[i] > MIN_BEAT);
    if (i < 0) break;
    secs[i] -= 1;
  }
  while (sum() < CLIP_SECONDS) secs[longest()] += 1;
  return secs;
}
// When each setup is on screen: [{ n, k, from, to, seconds }], and the timecodes to cut at.
export function mergedPlan(m) {
  const list = frames(m);
  const secs = split(list.map(f => wordCount(f.lyric)));
  let t = 0;
  const timeline = list.map((n, i) => {
    const from = t;
    t += secs[i];
    return { n, k: i + 1, from, to: t, seconds: secs[i] };
  });
  return { frames: list, timeline, cuts: timeline.slice(1).map(b => mmss(b.from)) };
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
  const head = `Still frame, photorealistic, cinematic 35mm, 16:9. ${sentence(opening)}`;
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
// Who speaks in a frame, as one of the two people in it (by the line's "Name:" prefix).
function speakerIn(f, left, right) {
  if (noLine(f.lyric)) return null;
  const cast = castOf(imageParents(f));
  const sp = speakerOf(f, cast);
  if (!sp) return null;
  const entry = cast.find(c => c.person && c.label === sp.label);
  return (
    [left, right].find(p => p && entry && p.base.id === entry.node.id) ||
    [left, right].find(p => p && p.code && p.code === sp.label) ||
    null
  );
}
// What is missing before the merged scene can be filmed.
export function mergedProblem(m) {
  const list = frames(m);
  if (list.length < 2)
    return 'Nối 2–3 ảnh khung (node khung ở cột ⑥ Sản xuất) vào phân cảnh ghép này.';
  if (list.length > MAX_FRAMES)
    return `Veo nhận tối đa ${MAX_FRAMES} ảnh: phân cảnh ghép này có ${list.length} khung.`;
  const noImage = list.find(f => !f.image);
  if (noImage) return `Khung "${noImage.name}" chưa có ảnh. Tạo ảnh khung trước.`;
  const stale = list.find(f => f.stale);
  if (stale) return `Ảnh khung "${stale.name}" đã thay đổi đầu vào. Tạo lại trước khi quay.`;
  const bad = list.map(frameProblem).find(Boolean);
  if (bad) return bad;
  const dup = list.find((f, i) => list.findIndex(x => x.framing === f.framing) !== i);
  if (dup) return `Hai khung cùng cỡ cảnh (${dup.framing}): mỗi phân cảnh ghép một góc một lần.`;
  // One conversation: the same place and the same two people, on the same sides, in
  // every frame — the clip's prompt locks who is left and who is right once for all cuts.
  const first = frameCast(list[0]);
  for (const f of list.slice(1)) {
    const c = frameCast(f);
    if (
      c.place?.id !== first.place?.id ||
      c.left?.node.id !== first.left?.node.id ||
      c.right?.node.id !== first.right?.node.id
    )
      return `Khung "${f.name}" nối bối cảnh hoặc hai người khác thứ tự với khung "${list[0].name}": mọi khung cùng [1] bối cảnh, [2] người bên trái, [3] người bên phải.`;
  }
  // Every line must belong to one of the two, and in an over-the-shoulder frame to the one
  // facing the camera — or the clip lip-syncs the wrong person.
  for (const f of list) {
    if (noLine(f.lyric)) continue;
    const sp = speakerIn(f, first.left, first.right);
    if (!sp)
      return `Khung "${f.name}": câu thoại phải viết dạng Tên: "…" với tên của một trong hai nhân vật (${first.left.base.name} hoặc ${first.right.base.name}).`;
    const facing = f.framing === 'ots_a' ? first.right : f.framing === 'ots_b' ? first.left : null;
    if (facing && sp !== facing)
      return `Khung "${f.name}" (${f.framing === 'ots_a' ? 'qua vai A' : 'qua vai B'}): người nói phải là người quay mặt về máy, tức ${facing.code} bên ${f.framing === 'ots_a' ? 'phải' : 'trái'}. Đổi cỡ cảnh sang ${f.framing === 'ots_a' ? 'ots_b' : 'ots_a'} hoặc đổi "sides".`;
  }
  return '';
}
// The images this scene is filmed from, in cut order: Veo gets them as reference images.
export const mergedReferences = m => frames(m).map(f => ({ role: f.id, asset: f.image }));

// The prompt of a merged scene: which image is which setup, where the cuts fall, one line
// per setup with the listener pinned shut, a voice lock per speaker, and unbroken room
// sound so the ear does not hear the cut (notes, sections 4 and 6).
export function mergedPrompt(m) {
  const { timeline } = mergedPlan(m);
  if (!timeline.length) return '';
  const first = frameCast(timeline[0].n);
  const left = first.left,
    right = first.right;
  if (!left || !right) return '';
  const n = nouns([left, right]);
  const code = p => p.code || p.label;
  const who = p => (p.label ? `${p.label} (${code(p)})` : code(p));
  const setups = timeline.map(({ n: f }) => {
    const near = f.framing === 'ots_b' ? right : left;
    const far = f.framing === 'ots_b' ? left : right;
    return f.framing === 'two_shot'
      ? `the medium two-shot of both ${n.many}`
      : `${setupName(f)}, where ${who(far)} faces us over the blurred shoulder of ${near.label}`;
  });
  const cuts = timeline.slice(1).map(b => mmss(b.from));
  const head = [
    `The ${timeline.length} attached images are the ${timeline.length} camera setups of one conversation in the same room: ${setups.join('; ')}.`,
    'Recreate each setup exactly as its image shows: framing, focus, lighting, colour, faces, hair and clothes.',
    `Each ${n.one} appears only once in any shot. ${code(left)} is always on the left of frame, ${code(right)} always on the right.`,
    `${timeline.length === 2 ? 'Two shots, shot / reverse shot, with one clean hard cut' : timeline.length + ' shots with clean hard cuts'} at ${cuts.join(' and ')}: no transition, no morph, no dissolve, no camera movement.`,
  ].join(' ');
  const voices = new Map();
  const blocks = timeline.map((b, i) => {
    const f = b.n;
    const speaker = speakerIn(f, left, right);
    const other = speaker === left ? right : speaker === right ? left : null;
    const at = `[${mmss(b.from)}-${mmss(b.to)}]`;
    const where = i === 0 ? cap(setupName(f)) + '.' : `Hard cut to ${setupName(f)}.`;
    const act = tidy(f.frameAction);
    if (!speaker) {
      // no line here (mergedProblem refuses a line nobody in frame can say)
      const ambience = tidy(
        String(f.audioDelivery || '')
          .replace(/^\[|\]$/g, '')
          .replace(/^\s*(không\s+thoại|no\s+dialogue|no\s+speech)\s*[;:,.-]*\s*/i, ''),
      );
      return `${at} ${where} No one speaks${act ? `: ${act}` : ''}. Both keep their lips closed${ambience ? `; location sound — ${ambience}` : ''}.`;
    }
    if (speaker.voice) voices.set(code(speaker), speaker.voice);
    const delivery = tidy(f.audioDelivery);
    const side = p => (p === left ? 'on the left' : 'on the right');
    const name = `${code(speaker)}, ${f.framing === 'two_shot' ? side(speaker) : speaker.label},`;
    const says = `${name} ${act ? act + ' and says' : 'says'}${delivery ? ' ' + delivery : ''}: "${words(f.lyric)}"`;
    const quiet =
      f.framing === 'two_shot'
        ? `Only ${code(speaker)} speaks; ${code(other)}, ${side(other)}, does not move, lips closed.`
        : `Only ${code(speaker)} speaks; ${code(other)}'s face stays turned away, lips closed.`;
    return `${at} ${where} ${says} ${quiet}`;
  });
  const locks = [...voices].map(([c, v]) => `Voice lock for ${c}: ${tidy(v)}.`);
  return [
    head,
    ...blocks,
    ...locks,
    roomSound(m),
    styleLine(m),
    'Photorealistic, cinematic 35mm. Clean frame, empty lower third, no subtitles, no captions, no on-screen text. Fictional characters only, no resemblance to any real person.',
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
    ? `Room sound runs unbroken across the cut${frames(m).length > 2 ? 's' : ''}: ${text}. `
    : '';
  return room + 'No other voices, no narration, no music.';
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
  const list = timeline.map(b => {
    const w = wordCount(b.n.lyric);
    return {
      id: b.n.id,
      name: b.n.name,
      framing: b.n.framing || '',
      from: b.from,
      to: b.to,
      words: w,
      pace: Math.round((w / b.seconds) * 10) / 10,
      tooFast: w > WORDS_PER_SECOND * b.seconds,
      hasImage: !!b.n.image,
      stale: !!b.n.stale,
    };
  });
  const fast = list.filter(f => f.tooFast);
  return {
    seconds: CLIP_SECONDS,
    maxFrames: MAX_FRAMES,
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
  const base = timeline[0] ? frameCast(timeline[0].n) : null;
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
