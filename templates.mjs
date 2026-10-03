// Project templates per theme. A new project is cloned from one of these.
// Setting nodes (style / camera) carry text that is injected into connected
// nodes' prompts; they produce no media.
export const themes = [
  { id: 'music', label: 'Music / MV' },
  { id: 'film', label: 'Phim' },
  { id: 'animation', label: 'Hoạt hình' },
  { id: 'custom', label: 'Khác (tự dựng)' },
];
export const themeLabel = id => themes.find(t => t.id === id)?.label || id;

const shot = (id, name, i) => ({
  id,
  name,
  zone: 'production',
  prompt: '',
  videoPrompt: '',
  lyric: '',
  start: i * 8,
  duration: 8,
  image: null,
  video: null,
});
// zone: 'character' for the character/visual reference, 'design' for stage/scene.
const imageNode = (id, name, zone = 'design') => ({
  id,
  name,
  zone,
  prompt: '',
  image: null,
  video: null,
});
const setting = (settingType, name, config) => ({
  id: settingType,
  kind: 'setting',
  settingType,
  zone: 'setup',
  name,
  config,
});

// style + camera connected into the compose node and each shot.
function wireSettings(composeId, shotIds) {
  return ['style', 'camera'].flatMap(s => [
    { source: s, target: composeId },
    ...shotIds.map(t => ({ source: s, target: t })),
  ]);
}

const TEMPLATES = {
  music: () => {
    const shots = ['wide', 'medium', 'close'];
    return {
      name: 'MV mới',
      theme: 'music',
      fields: {
        identity: 'Adult singer, dark wavy hair, natural appearance',
        wardrobe: 'Burgundy velvet evening outfit',
        instrument: 'Matte black handheld microphone',
        stage:
          'Grand concert theater, polished wooden stage, singer center, guitarist left, piano right',
        lighting: 'Warm amber key light, soft golden rim light, gentle haze',
        bpm: '',
      },
      nodes: [
        imageNode('singer', 'Ca sĩ', 'character'),
        imageNode('stage', 'Sân khấu'),
        imageNode('scene', 'Ghép cảnh'),
        shot('wide', 'Toàn cảnh', 0),
        shot('medium', 'Trung cảnh', 1),
        shot('close', 'Cận cảnh', 2),
        setting(
          'style',
          'Style',
          'Cinematic concert film, warm filmic grade, shallow depth of field, 35mm.',
        ),
        setting('camera', 'Máy quay', 'Stabilized, subtle movement, eye-level, 35mm lens.'),
      ],
      edges: [
        { source: 'singer', target: 'scene' },
        { source: 'stage', target: 'scene' },
        ...shots.map(target => ({ source: 'scene', target })),
        ...wireSettings('scene', shots),
      ],
    };
  },
  film: () => {
    const shots = ['shot1', 'shot2', 'shot3'];
    return {
      name: 'Phim mới',
      theme: 'film',
      fields: {
        identity: 'Lead character, distinct consistent face',
        wardrobe: 'Era-appropriate costume',
        instrument: '',
        stage: 'Film location / set',
        lighting: 'Motivated cinematic lighting',
        bpm: '',
      },
      nodes: [
        imageNode('char', 'Nhân vật', 'character'),
        imageNode('world', 'Bối cảnh'),
        imageNode('scene', 'Cảnh dựng'),
        shot('shot1', 'Cảnh 1', 0),
        shot('shot2', 'Cảnh 2', 1),
        shot('shot3', 'Cảnh 3', 2),
        setting(
          'style',
          'Style',
          'Cinematic film look, filmic grain, teal-orange grade, anamorphic.',
        ),
        setting('camera', 'Máy quay', 'Dolly and slow push-ins, 40mm, cinematic framing.'),
      ],
      edges: [
        { source: 'char', target: 'scene' },
        { source: 'world', target: 'scene' },
        ...shots.map(target => ({ source: 'scene', target })),
        ...wireSettings('scene', shots),
      ],
    };
  },
  animation: () => {
    const shots = ['shot1', 'shot2', 'shot3'];
    return {
      name: 'Hoạt hình mới',
      theme: 'animation',
      fields: {
        identity: 'Main character, stylized consistent design',
        wardrobe: 'Signature outfit',
        instrument: '',
        stage: 'Stylized background',
        lighting: 'Soft stylized lighting',
        bpm: '',
      },
      nodes: [
        imageNode('char', 'Nhân vật', 'character'),
        imageNode('bg', 'Bối cảnh'),
        imageNode('scene', 'Ghép cảnh'),
        shot('shot1', 'Cảnh 1', 0),
        shot('shot2', 'Cảnh 2', 1),
        shot('shot3', 'Cảnh 3', 2),
        setting('style', 'Style', 'Animation style, clean line art, vibrant palette, cel shading.'),
        setting('camera', 'Máy quay', 'Smooth animated camera, gentle parallax.'),
      ],
      edges: [
        { source: 'char', target: 'scene' },
        { source: 'bg', target: 'scene' },
        ...shots.map(target => ({ source: 'scene', target })),
        ...wireSettings('scene', shots),
      ],
    };
  },
  custom: () => ({
    name: 'Project mới',
    theme: 'custom',
    fields: { identity: '', wardrobe: '', instrument: '', stage: '', lighting: '', bpm: '' },
    nodes: [
      imageNode('base', 'Ảnh gốc'),
      shot('shot1', 'Cảnh 1', 0),
      setting('style', 'Style', ''),
      setting('camera', 'Máy quay', ''),
    ],
    edges: [{ source: 'base', target: 'shot1' }, ...wireSettings('shot1', [])],
  }),
};

// A fresh project object for the given theme.
export function projectTemplate(theme) {
  const build = TEMPLATES[theme] || TEMPLATES.music;
  const t = build();
  return {
    name: t.name,
    theme: t.theme,
    revision: 1,
    website: '',
    audio: null,
    audioDuration: null,
    fields: t.fields,
    nodes: t.nodes,
    edges: t.edges,
    jobs: [],
    worker: null,
  };
}
