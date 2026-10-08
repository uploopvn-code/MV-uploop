// Prompt building: cast lines, speaker/voice lock, silent shots, keyframe/still frame,
// style/camera/audio settings, and the image/video prompts of every node.
import {
  assetRefs,
  deps,
  getNode,
  imageParents,
  isCharacter,
  isSetting,
  isWardrobe,
  settingParents,
} from './nodes.mjs';
import { db } from './projects.mjs';
import { groupPrompt, isGroup } from './seedance.mjs';
import { framePrompt, isFrame, isMerged, mergedPrompt } from './merged.mjs';
import { BLOCK_MARK, LAYOUT_MARK, stageLines } from './stage3d.mjs';

// One blocking line as stageLines writes it — the sentence, then (image) the capture's.
const BLOCK_RE = new RegExp(
  `\\s*${BLOCK_MARK} [^]*?(?:Seen from this camera|Stage map, as seen from the audience): [^.]*\\.` +
    `(?:\\s*\\[\\d+\\] \\(the last attached image\\) ${LAYOUT_MARK}[^.]*\\.\\s*Mannequin colours:[^.]*\\.)?`,
  'g',
);

const suffix =
  ', clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm.';
const settingLabel = { style: 'Style', camera: 'Camera', audio: 'Audio' };
// Text contributed by the setting nodes connected into `n`. A sound preset describes what
// the clip must be heard over, so it never goes into an image prompt.
export function settingText(n, kind = 'video') {
  return deps(n.id)
    .map(getNode)
    .filter(
      s => isSetting(s) && s.config?.trim() && (kind === 'video' || s.settingType !== 'audio'),
    )
    .map(s => {
      const label =
        kind === 'image' && s.settingType === 'camera'
          ? 'Framing (take the angle and lens, not the movement)'
          : settingLabel[s.settingType] || 'Setting';
      return label + ': ' + s.config.trim();
    })
    .join(' ');
}
// --- Reference-aware prompt text. The video/image model receives the reference images as
// an ordered list; a prompt's "@key" tags mean nothing to it, so a two-person scene easily
// gets faces and lines swapped. So we (1) open the prompt with a cast line naming each
// attached image in the order it is sent — a name only: the image already shows what the
// person looks like, and describing them again fights the reference, (2) turn
// every @key into that label, (3) say who speaks, and
// (4) lock the speaker's voice (Bible voice_profile + the shot's audio_delivery), voice-over
// and off-screen speakers included. Idempotent: a prompt the user saved after resolution is
// not decorated twice.
const CAST_MARK = 'Reference subjects, in the order of the attached images:';
export const SPEAK_MARK = 'is spoken by';
export const VOICE_MARK = 'Voice lock';
export const SILENT_MARK = 'No spoken dialogue';
const KEY_MARK = 'The attached image is the first frame of this shot';
const shortName = s =>
  String(s || '')
    .split(/\s*[(—–]\s*/)[0]
    .trim();
const humanize = key =>
  String(key || '')
    .replace(/^(scene|prop|item|costume|look)_/, '')
    .replace(/_/g, ' ')
    .trim();
// What the prompt calls a person: the Bible's code (NV1, NV2…) when there is one. A real
// name in a reference label or a voice lock makes the video model more likely to refuse
// the shot as "a real person", so the name stays out of everything we send.
const castLabel = x => String(x?.code || '').trim() || shortName(x?.name) || x?.name || '';
function castFor(n) {
  if (isWardrobe(n)) return []; // a garment render has no cast
  return castOf(imageParents(n));
}
// The cast of an ordered list of reference nodes: [1] is the first one sent, and so on.
export function castOf(parents) {
  const cast = parents.map((p, i) => {
    // A look (character wearing a costume) stands for its character.
    const ch = p.role === 'look' ? imageParents(p).find(isCharacter) : null;
    const base = ch || p;
    const person = isCharacter(base);
    const costume = p.role === 'look' ? imageParents(p).find(isWardrobe) : null;
    // An angle answers to its scene's key too (@scene_hall → the hall).
    const keys = new Set(
      [base.assetKey, base.code, p.assetKey, p.ofKey, costume?.assetKey].filter(Boolean),
    );
    const label = person
      ? castLabel(base)
      : isWardrobe(p)
        ? 'the costume'
        : humanize(p.ofKey || p.assetKey)
          ? 'the ' + humanize(p.ofKey || p.assetKey)
          : p.name;
    // Only non-people carry a description: which room, which prop. A person is just their
    // code — the attached image is the appearance, and any text about it only competes.
    const desc = person ? '' : p.name !== label ? p.name : '';
    return {
      index: i + 1,
      keys,
      label,
      desc,
      person,
      node: base,
      voice: person ? base.voice || '' : '',
    };
  });
  return cast;
}
// A video that runs from the shot's own keyframe gets exactly one image, so there is no
// order to map people onto. Name them by their anchors instead — the only case where the
// appearance text earns its place — and only when telling two people apart is needed.
const keyframeLine = cast => {
  const people = cast.filter(c => c.person);
  const who =
    people.length > 1
      ? ' In it: ' +
        people.map(c => `${c.label} — ${c.node?.anchors || 'as shown'}`).join('; ') +
        '.'
      : '';
  return (
    `${KEY_MARK}: animate it, keeping every face, outfit, prop and the set exactly as they are.` +
    `${who} `
  );
};
const castLine = cast =>
  CAST_MARK +
  ' ' +
  cast.map(c => `[${c.index}] ${c.label}${c.desc ? ' — ' + c.desc : ''}`).join('; ') +
  '. ';
// Blueprints often open the motion prompt with "In this shot, NV1 is a poised woman in her
// late 30s…; NV3 is a glamorous woman…" — appearance text that competes with the reference
// images. Positioning ("NV1 is standing by the window") is kept; "is a/an <description>" is not.
export const stripCastIntro = text =>
  String(text || '')
    .replace(/\bIn this shot,\s+@?[A-Za-z0-9_]+\s+is\s+an?\s+[^.]*\.\s*/gi, '')
    .trim();
// A shot's keyframe is one photograph, not the clip: the same staging without the movement,
// the spoken line or the sound. Applied when the blueprint gave the shot no image prompt of
// its own, so a prompt the user wrote or saved is left exactly as it is.
const STILL_MARK = 'Still keyframe';
const stillFrame = text => {
  const body = String(text || '')
    .replace(/^\s*Veo Video Prompt:\s*/i, '')
    .replace(/\bmouth articulates[^:]*:\s*"[^"]*"\.?/gi, 'lips parted mid-sentence.')
    .trim()
    .replace(/([^.!?])$/, '$1.');
  return (
    `${STILL_MARK}, one photographic moment of this shot, not a sequence: ${body} ` +
    'Hold the moment at its strongest instant; no motion blur, no text.'
  );
};
export const resolveTags = (text, cast) =>
  String(text || '').replace(/@([A-Za-z0-9_]+)('s)?/g, (m, key, poss) => {
    const c = cast.find(x => x.keys.has(key));
    return c ? c.label + (poss || '') : m;
  });
// Who speaks the shot's line. First choice: the last person tag before "mouth
// articulates" in the video prompt ("Over @NV1's shoulder onto @NV3 … mouth articulates:"
// → NV3), which is where the blueprint marks the speaker. Otherwise the "Name: …" prefix
// of the line. A cast member is lip-synced; a character who is not in frame is not.
export function speakerOf(n, cast) {
  const line = String(n.lyric || '');
  const m = line.match(/^\s*([^:[\]"]+?)\s*:/);
  const vp = String(n.videoPrompt || '');
  // A voice-over is not lip-synced to anyone on screen.
  const voiceover = /voice-?over|\bV\.?O\b/i.test((m ? m[1] : '') + ' ' + vp);
  const found = p =>
    p && { label: p.label ?? castLabel(p), index: p.index || 0, voice: p.voice || '', voiceover };
  // First choice: the name the line opens with ("Eleanor: …") — the dialogue says who speaks.
  // The tags around "mouth articulates" can mislead: in "@NV1 turns toward @NV3 and mouth
  // articulates" the tag nearest the line is the listener.
  const named = m && byName(m[1]);
  if (named) return named;
  const speaks = vp.search(/mouth\s+articulat/i);
  if (speaks > 0) {
    const tags = [...vp.slice(0, speaks).matchAll(/@([A-Za-z0-9_]+)/g)].map(x => x[1]);
    for (const tag of tags.reverse()) {
      const c = cast.find(x => x.person && x.keys.has(tag));
      if (c) return found(c);
      const ch = (db.nodes || []).find(
        x => isCharacter(x) && (x.code === tag || x.assetKey === tag),
      );
      if (ch) return found(ch);
    }
  }
  return null;
  // The person a "Name:" prefix names: a cast member (lip-synced) or a character off-screen.
  function byName(raw) {
    const name = raw
      .replace(/\(.*?\)/g, '')
      .trim()
      .toLowerCase();
    if (!name) return null;
    // The line keeps the real name, so match it against the Bible name, not the code.
    const match = x => {
      const l = String(shortName(x?.name) || x?.name || '').toLowerCase();
      return !!l && (l.startsWith(name) || name.startsWith(l.split(' ')[0]));
    };
    const c = cast.find(x => x.person && (match(x.node) || String(x.label).toLowerCase() === name));
    if (c) return found(c);
    return found((db.nodes || []).find(x => isCharacter(x) && match(x)));
  }
}
function speakerLine(sp, byIndex = true) {
  if (!sp || sp.voiceover) return '';
  if (!sp.index) return `The line ${SPEAK_MARK} ${sp.label} off-screen; no one in frame mouths it.`;
  const where = byIndex ? ` (reference image ${sp.index})` : '';
  return `The line ${SPEAK_MARK} ${sp.label}${where} only; everyone else stays silent and listens.`;
}
// Does this shot carry no line at all? Empty, or a stage direction in brackets
// ("[Không thoại; chuông nhà nguyện]"). A sung lyric is a line, so a music shot is not silent.
export const noLine = s => {
  const t = String(s || '').trim();
  return !t || /^\[/.test(t) || /^(không\s+thoại|no\s+dialogue|silent)/i.test(t);
};
// A shot with no line must stay silent: left alone, the video model invents chatter or a
// score. The shot's audio_delivery describes the location sound to keep instead.
function silentLine(n) {
  const ambience = String(n.audioDelivery || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/^\s*(không\s+thoại|no\s+dialogue|no\s+speech)\s*[;:,.-]*\s*/i, '')
    .replace(/[.\s]+$/, '');
  // A sound preset is wired in: it may well ask for a score, so forbidding music here
  // would contradict the "Audio: …" line the same prompt carries. Only the speech ban
  // belongs to both cases.
  const scored = settingParents(n).some(s => s.settingType === 'audio' && s.config?.trim());
  const head = `${SILENT_MARK} in this shot: nobody speaks and no lips move.`;
  return scored
    ? `${head} Keep the location sound${ambience ? ` — ${ambience} —` : ''} under the audio bed described below; no voice-over, no narration.`
    : `${head} Audio is location sound only${ambience ? ` — ${ambience}` : ''}; no added music, no voice-over, no narration.`;
}
// Keep the voice consistent across shots: the Bible's voice_profile, modulated by the
// shot's audio_delivery.
function voiceLine(n, sp) {
  if (!sp || !sp.voice) return '';
  const tidy = s =>
    String(s || '')
      .trim()
      .replace(/[.\s]+$/, '');
  const who = sp.voiceover ? `${sp.label} (voiceover in ${sp.label}'s own voice)` : sp.label;
  const delivery = tidy(n.audioDelivery);
  return `${VOICE_MARK} for ${who}: ${tidy(sp.voice)}.${delivery ? ` Delivery: ${delivery}.` : ''}`;
}
export function prompts(n) {
  if (isSetting(n)) return { image: '', video: '' };
  // A music node carries a song reference + its analysis, no renderable prompt.
  if (n.kind === 'music') return { image: '', video: '' };
  // A Seedance group films its shots in one render: its prompt is the timecoded shot list.
  if (isGroup(n)) return { image: '', video: String(n.videoPrompt || '').trim() || groupPrompt(n) };
  // A merged scene films 2–3 camera setups in one clip: its prompt is the cut list.
  if (isMerged(n))
    return { image: '', video: String(n.videoPrompt || '').trim() || mergedPrompt(n) };
  // One setup of a merged scene: the still is built from the location plate + the two
  // character sheets, so the frame itself carries no written prompt.
  if (isFrame(n)) return { image: String(n.prompt || '').trim() || framePrompt(n), video: '' };
  const f = db.fields,
    common = `${f.identity}. ${f.wardrobe}. ${f.instrument}.`,
    stage = `${f.stage}. ${f.lighting}.`;
  const size = {
    wide: 'Wide shot, full body and stage environment',
    medium: 'Medium shot, waist-up singer',
    close: 'Close-up three-quarter view, face and microphone',
  };
  const hasRefs = assetRefs(n).length > 0;
  // Costume node: the OUTFIT only, as a costume reference sheet on a neutral mannequin.
  // Re-rendering "the same person in new clothes" in one step is unreliable (the image
  // model tends to return a faceless mannequin or a stranger), so the person + outfit
  // composition is done by the look node below. Never mixes in the project's template
  // fields (those describe the default look, not this costume).
  const outfit = String(n.outfit || '').trim(),
    items = String(n.items || '').trim();
  const wardrobe = isWardrobe(n)
    ? `Outfit reference sheet (model sheet turnaround) of one single costume: ${outfit || "the character's costume for this scene"}${items ? ', with ' + items : ''}. The garment worn on a plain neutral-grey headless mannequin with NO head and NO face, shown full length three times in one image — front, side and back views — at the same scale on one shared horizontal baseline, even soft studio product lighting from the same direction in every view, sharp fabric and material detail. A clean light grey-to-white seamless studio backdrop that makes the outfit stand out; the mannequin and clothes only — no person, no face, no head, no human skin, no scenery, no other objects, no text. Cinematic 35mm photorealistic.`
    : null;
  // Look node ("character wearing this costume"): a virtual try-on from two references,
  // the character (face, body) and the costume (outfit), laid out like the character's own
  // model sheet (portrait + front/side/back turnaround) so shots get the same kind of
  // reference they already use for the base look. The tool owns this prompt so the result
  // is a complete, face-locked person.
  const look =
    n.role === 'look'
      ? 'Character model sheet turnaround, virtual try-on from the reference images: the exact same person as in the character reference (identical face, hairstyle, skin tone, age and body) now wearing exactly the outfit from the costume reference: the same garments, cut, fabric, colors and accessories, nothing else changed. Same layout as the character model sheet: a large head-and-shoulders portrait on the left, then full-body front, side and back views on the right, neutral standing pose, face clearly visible and sharp, solid gray background, studio lighting, consistent facial identity and consistent outfit across all views, cinematic 35mm photorealistic, no text.'
      : null;
  // Scene angle: the same place from another camera position, rendered from the scene's
  // image. The camera change comes first and the prompt forbids the reference framing —
  // image-to-image models otherwise hand back the master view with the people removed.
  const angle =
    n.role === 'angle'
      ? `A new camera angle of the location shown in the reference image. Camera: ${
          String(n.angle || '')
            .trim()
            .replace(/[.\s]+$/, '') || 'a medium-close view of the main playing area'
        }. This is a different shot, not the reference framing: compose it from this new vantage point with its own composition and distance. The place itself stays exactly as in the reference (same architecture, furniture, props, materials, colour palette, weather, time of day and lighting), nothing added except what the new angle reveals. No people: a clean empty background plate for a dialogue shot, 35mm lens, photorealistic, no text.`
      : null;
  // Reference sheets the user creates by typing a name and a description: the tool owns the
  // prompt so every prop, character and location comes out with the same layout, scale and
  // lighting discipline. `desc` is the only thing the user writes.
  const desc = String(n.desc || '').trim();
  // Prop model sheet: ONE object shown three times in one image (hero + two turned views),
  // the same trick the character sheet uses, so an object stays recognisable from shot to
  // shot. Usually text-to-image; with a reference photo the object must be kept, not
  // redesigned. Never mixes in the project's template fields — those describe the cast.
  const prop =
    n.role === 'prop'
      ? `Prop model sheet turnaround of one single object: ${desc || `the object called "${n.name}"`}.${
          hasRefs
            ? ' The object is exactly the one in the reference image: keep its real shape, proportions, materials, colour, finish, wear and existing markings, do not restyle, repair or clean it up, and do not hand back the reference framing.'
            : ''
        } One image, three views of that same object and nothing else: a large three-quarter hero view filling the left half, then on the right half two smaller views stacked one above the other, each turned to a clearly different side so the whole shape reads. For a flat or thin object use a straight-on face view and a tilted three-quarter from the other side rather than an edge-on profile; for an object that looks the same from every side vary the two smaller views by height and distance instead. One object photographed three times, not three different objects and not several copies arranged in a scene: same size and proportions, same materials, same colours, same finish, same wear and the same small details in the same places, the two smaller views sharing one scale and one horizontal baseline. The object alone on a plain seamless neutral grey backdrop, one soft even studio light from the same direction in every view, one soft contact shadow under each view and no other cast shadow. Nothing else in frame: no hands, no people, no mannequin, no furniture, no other objects, no scenery. Sharp focus throughout, no shallow depth of field, true colour, cinematic 35mm photorealistic. Writing, screen content or a logo that physically belongs on the object stays exactly as described and in the same place in all three views; the wording above describes the object, it is not text to print: no captions, view labels, arrows, measurements, panel dividers or watermarks.`
      : null;
  // Character and location sheets typed from the toolbar. Blueprint nodes carry their own
  // written prompt, which wins in `imageBase` below, so these only drive the typed ones.
  // No description yet still builds the sheet: falling through to the generic prompt would
  // paste the project's own identity/stage fields onto an unrelated subject. A person is
  // never named here — a real name makes the video model refuse the shot later.
  const character =
    n.role === 'character'
      ? `Character model sheet turnaround of one single person${desc ? ': ' + desc : ''}. A large head-and-shoulders portrait on the left, then full-body front, side and back views on the right at the same scale on one shared baseline, neutral standing pose, arms relaxed and clear of the body, face clearly visible and sharp. The exact same person in every view: identical face, hairstyle, skin tone, age and body, wearing the same outfit, shoes and accessories, nothing added or removed between views. Solid gray background, studio lighting from the same direction in every view, sharp focus throughout, no shallow depth of field. No other person, no props beside the figure, no scenery, consistent facial identity and consistent outfit across all views, cinematic 35mm photorealistic, no text.`
      : null;
  const sceneWide = `Master wide establishing shot of the location${desc ? ': ' + desc : ''}. One continuous real space photographed completely empty, eye level, wide enough that the whole playing area and how its parts sit together are visible, so later camera angles of this same place can be matched to this frame. No people, no animals, nobody implied anywhere in frame: a clean empty background plate for a dialogue shot. One motivated lighting setup with a single consistent shadow direction, consistent architecture, furniture, materials, colour palette, time of day and weather throughout. A single continuous photograph, not a collage, grid or split-screen of several views. Sharp focus throughout, no shallow depth of field, 35mm lens, photorealistic, no text.`;
  // Location model sheet: the three shot sizes a scene needs — a wide, a close angle A and
  // its 180° reverse close angle B — in ONE image, so a place is one reference and one render,
  // the way a character is one turnaround sheet. All three views are the same empty space.
  const sceneSheet = `Location model sheet of one single place${desc ? ': ' + desc : ''}, three camera views of it in ONE image. A large WIDE establishing shot of the whole space across the top half, then on the bottom half two smaller matching views side by side: close angle A at eye level looking across the main area from one side, and close angle B, its 180-degree reverse from the opposite side. All three show the SAME empty real space — identical architecture, furniture, materials, colour palette, time of day and one consistent lighting and shadow direction — differing only in camera position so they cut together. The place photographed completely empty: no people, no animals, nobody implied in any view, a clean background plate for a dialogue scene. One reference sheet of three framings of ONE place, not three different places and not a scene full of objects; each view in sharp focus, 35mm lens, photorealistic. No text, no labels, no captions, no view numbers and no panel borders drawn on the image.`;
  const place = n.role === 'scene' ? (n.sheet3 ? sceneSheet : sceneWide) : null;
  // Music template keeps its tailored prompts; other themes use a generic builder.
  const generated =
    wardrobe ||
    look ||
    angle ||
    prop ||
    character ||
    place ||
    (['singer', 'stage', 'scene', 'wide', 'medium', 'close'].includes(n.id)
      ? n.id === 'singer'
        ? `${common} Neutral reference portrait and clear face, realistic skin texture, no text.`
        : n.id === 'stage'
          ? `${stage} Wide establishing shot of the empty stage, no singer, no text.`
          : n.id === 'scene'
            ? `Place the referenced singer in the referenced stage, preserve identity, outfit and instrument. ${common} ${stage} Wide shot, physically coherent scale, 16:9, photorealistic.`
            : `${size[n.id] || 'Compose the connected reference images into one coherent photograph'}. Preserve the referenced singer and scene. ${common} ${stage} Photorealistic concert still, 16:9, no text.`
      : hasRefs
        ? `Compose the connected reference images into one coherent shot for "${n.name}". Preserve the referenced subjects. ${common} ${stage} 16:9, no text.`
        : `${n.name}. ${common} ${stage} Clear reference frame, 16:9, no text.`);
  const pace = f.bpm
    ? `Steady ${f.bpm} BPM, natural breathing pauses.`
    : 'Natural breathing and restrained motion; align phrasing to the supplied audio.';
  const movement =
    n.id === 'wide'
      ? 'Slow dolly-in'
      : n.id === 'medium'
        ? 'Gentle push-in'
        : n.id === 'close'
          ? 'Very slow push-in, stable face'
          : 'Smooth, motivated camera move';
  let video = `Pace: ${pace} Prompt Video: ${movement}. Preserve the approved keyframe, identity, clothing and lighting. Subtle emotional performance.${n.lyric ? ' mouth articulates: ' + JSON.stringify(n.lyric) + '.' : ''}${suffix}`;
  // Append style / camera text from connected setting nodes (once). The image prompt gets
  // the same minus the sound preset.
  const settings = settingText(n);
  const imageSettings = settingText(n, 'image');
  const withSettings = (s, txt = settings) => (txt && !s.includes(txt) ? s + ' ' + txt : s);
  // Name the reference images and the speaker (see castFor). Tags resolve to names even in
  // a shot without people; the cast line is only worth adding when someone is in frame.
  const cast = castFor(n);
  const marked = s => s.includes(CAST_MARK) || s.includes(KEY_MARK);
  // Images are composed from the wired references, so the image prompt always maps them.
  const withCast = s =>
    cast.some(c => c.person) && !marked(s)
      ? castLine(cast) + resolveTags(s, cast)
      : resolveTags(s, cast);
  // The video runs from this node's own image unless it was told to use the references and
  // has none of its own (mirrors createJob).
  const fromKeyframe = 'duration' in n && !(n.videoInput === 'refs' && !n.image);
  const withCastVideo = s =>
    fromKeyframe
      ? marked(s)
        ? resolveTags(s, cast)
        : keyframeLine(cast) + resolveTags(s, cast)
      : withCast(s);
  const sp = speakerOf(n, cast);
  const speaker = speakerLine(sp, !fromKeyframe);
  const withSpeaker = s => (speaker && !s.includes(SPEAK_MARK) ? s + ' ' + speaker : s);
  const voice = voiceLine(n, sp);
  const withVoice = s => (voice && !s.includes(VOICE_MARK) ? s + ' ' + voice : s);
  // No speaker at all (and not a voice-over): say so, or the model fills the silence.
  const silent = !sp && 'duration' in n && noLine(n.lyric) ? silentLine(n) : '';
  const withSilent = s => (silent && !s.includes(SILENT_MARK) ? s + ' ' + silent : s);
  // A shot whose image prompt is just its video prompt renders a still of that moment.
  const ownImage = n.prompt && n.prompt !== n.videoPrompt;
  const imageBase =
    'duration' in n && !ownImage && (n.videoPrompt || n.prompt)
      ? stillFrame(stripCastIntro(n.videoPrompt || n.prompt))
      : stripCastIntro(n.prompt) || generated;
  // A shot on a staged set (3D blocking): where every performer stands, seen from this shot's
  // camera (+ the capture of that framing); its video gets the stage map when it films the
  // references, or cuts to the band after its keyframe.
  const staged = stageLines(n, cast, castLabel, fromKeyframe);
  // A prompt saved after it was decorated still carries an older blocking (and capture) line:
  // it is replaced by the current one — or dropped when the set has no stage any more.
  const withBlock = (s, line) => {
    const t = s.replace(BLOCK_RE, '');
    return line ? t + ' ' + line : t;
  };
  return {
    image: withSettings(withBlock(withCast(imageBase), staged?.image), imageSettings),
    // A lip-sync take sends Omni Flash one source video and no images: its prompt goes as written
    // (no reference list, speaker or voice lines — those talk about attached images).
    video:
      n.role === 'lipsync'
        ? String(n.videoPrompt || '').trim()
        : withSettings(
            withSilent(
              withVoice(
                withSpeaker(
                  withBlock(withCastVideo(stripCastIntro(n.videoPrompt) || video), staged?.video),
                ),
              ),
            ),
          ),
  };
}
// "Change only this": the image model gets the node's own picture and the user's request,
// and is told to keep every other thing — people, outfits, set, framing, light — as it is.
export const editPrompt = text =>
  `Edit the attached image. Change only this: ${String(text)
    .trim()
    .replace(/[.\s]+$/, '')}. ` +
  'Keep everything else exactly as it is: the same people, faces, hair, outfits, props, set, ' +
  'framing, camera angle, lighting and colour grade. Photorealistic, no text.';
