// The 3D stage as three.js draws it — the floor, coloured mannequins and their instruments — and
// the capture of one camera's framing. Shared by the editor (public/js/stage3d.js) and the keeper
// that captures new framings on its own (public/js/stage-keeper.js), so both pictures look alike.
// Loaded on demand (three.js is ~2 MB).
import * as THREE from 'three';
import * as M from './stage-math.js';

export const CAP_W = 1280,
  CAP_H = 720;

// --- Low-poly mannequins and instruments (metres; feet at y = 0, facing +z) ---------------------
const mat = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 });
// A name tag / label: shown in the editor, never in a capture (userData.label).
export function textSprite(text, color = '#c5ed89') {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.65)';
  g.beginPath();
  g.roundRect(2, 2, 316, 60, 14);
  g.fill();
  g.fillStyle = color;
  g.font = 'bold 28px Segoe UI, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.slice(0, 22), 160, 33);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  s.scale.set(1.25, 0.25, 1);
  s.renderOrder = 10;
  s.userData.label = true;
  return s;
}
function mannequin(color, sit) {
  const g = new THREE.Group();
  const m = mat(color);
  const add = (geo, x, y, z, rx = 0, rz = 0) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.rotation.set(rx, 0, rz);
    g.add(o);
  };
  add(new THREE.CapsuleGeometry(0.17, 0.45, 4, 10), 0, sit ? 0.95 : 1.22, 0);
  add(new THREE.SphereGeometry(0.12, 16, 12), 0, sit ? 1.43 : 1.7, 0);
  add(new THREE.ConeGeometry(0.04, 0.09, 8), 0, sit ? 1.43 : 1.7, 0.13, Math.PI / 2); // nose: facing
  for (const sx of [-1, 1]) {
    add(
      new THREE.CapsuleGeometry(0.05, 0.5, 4, 8),
      sx * 0.24,
      sit ? 0.95 : 1.22,
      sit ? 0.15 : 0,
      sit ? -1 : 0,
      sx * 0.12,
    );
    if (sit) {
      add(new THREE.CapsuleGeometry(0.07, 0.4, 4, 8), sx * 0.1, 0.55, 0.22, Math.PI / 2);
      add(new THREE.CapsuleGeometry(0.06, 0.4, 4, 8), sx * 0.1, 0.25, 0.45);
    } else add(new THREE.CapsuleGeometry(0.07, 0.75, 4, 8), sx * 0.1, 0.45, 0);
  }
  return g;
}
function grandPiano() {
  const g = new THREE.Group();
  const black = mat(0x111111);
  const box = (w, h, d, x, y, z, m = black, rx = 0) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    o.rotation.x = rx;
    g.add(o);
  };
  box(1.5, 0.3, 1.6, 0, 0.85, 0);
  box(1.5, 0.03, 1.6, 0, 1.25, -0.2, black, -0.5);
  box(1.4, 0.04, 0.18, 0, 0.88, 0.88, mat(0xf2f2f2));
  for (const [x, z] of [
    [-0.65, 0.65],
    [0.65, 0.65],
    [0, -0.7],
  ]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8), black);
    leg.position.set(x, 0.35, z);
    g.add(leg);
  }
  box(0.8, 0.5, 0.35, 0, 0.25, 1.35);
  // the player sits at the bench (z 1.35 of the piano), facing the keys
  g.rotation.y = Math.PI;
  g.position.z = 1.35;
  return g;
}
function drumKit() {
  const g = new THREE.Group();
  const shell = mat(0x8b1e2d),
    metal = mat(0xc8a23a),
    chrome = mat(0x999999);
  const drum = (r, h, x, y, z, rx = 0) => {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), shell);
    d.position.set(x, y, z);
    d.rotation.x = rx;
    g.add(d);
  };
  drum(0.28, 0.4, 0, 0.3, -0.2, Math.PI / 2);
  drum(0.18, 0.15, 0.35, 0.65, 0.25, 0.2);
  drum(0.14, 0.15, -0.15, 0.8, -0.05, 0.3);
  drum(0.14, 0.15, 0.2, 0.8, -0.05, 0.3);
  drum(0.2, 0.35, -0.5, 0.45, 0.2);
  for (const [x, z, y] of [
    [0.6, 0, 1.1],
    [-0.6, -0.3, 1.2],
    [0.55, 0.45, 0.85],
  ]) {
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, y, 6), chrome);
    st.position.set(x, y / 2, z);
    g.add(st);
    const cy = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.01, 24), metal);
    cy.position.set(x, y, z);
    g.add(cy);
  }
  const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.5, 12), chrome);
  stool.position.set(0, 0.25, 0.75);
  g.add(stool);
  // the drummer sits on the stool (z 0.75 of the kit), facing the drums
  g.rotation.y = Math.PI;
  g.position.z = 0.75;
  return g;
}
function stringed(scale, color, neck) {
  const g = new THREE.Group();
  const wood = mat(color);
  const b1 = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.09, 20), wood);
  b1.rotation.x = Math.PI / 2;
  g.add(b1);
  const b2 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.09, 20), wood);
  b2.rotation.x = Math.PI / 2;
  b2.position.y = 0.24;
  g.add(b2);
  const n = new THREE.Mesh(new THREE.BoxGeometry(0.05, neck, 0.03), mat(0x3b2412));
  n.position.y = 0.3 + neck / 2;
  g.add(n);
  g.scale.setScalar(scale);
  return g;
}
function micStand() {
  const g = new THREE.Group();
  const c = mat(0x222222);
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 16), c));
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.5, 8), c);
  pole.position.y = 0.75;
  g.add(pole);
  const mic = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.12, 4, 8), mat(0x555555));
  mic.position.set(0, 1.52, -0.06);
  mic.rotation.x = -1.2;
  g.add(mic);
  g.position.z = 0.45;
  return g;
}
function keyboard() {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.35), mat(0x1a1a1a));
  top.position.y = 0.95;
  g.add(top);
  const keys = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.02, 0.15), mat(0xf2f2f2));
  keys.position.set(0, 1.0, -0.08);
  g.add(keys);
  for (const x of [-0.45, 0.45]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.95, 0.3), mat(0x333333));
    leg.position.set(x, 0.47, 0);
    g.add(leg);
  }
  g.position.z = 0.4;
  return g;
}
function stringedFor(gear) {
  const s =
    gear === 'violin'
      ? stringed(0.45, 0x8a3b12, 0.4)
      : gear === 'cello'
        ? stringed(1.7, 0x6b2e0e, 0.5)
        : stringed(1, gear === 'bass' ? 0x2b2b2b : 0xb5733a, gear === 'bass' ? 0.75 : 0.55);
  if (gear === 'cello') s.position.set(0, 0.1, 0.38);
  else if (gear === 'violin') {
    s.position.set(0.12, 1.35, 0.12);
    s.rotation.z = 1.4;
  } else {
    s.position.set(0, 1.05, 0.2);
    s.rotation.z = 0.9;
  }
  return s;
}
// A performer: mannequin + gear (+ a name tag when `name` is given), at its mark and facing.
export function performerObject(p, color, name) {
  const sit = p.pose === 'sit' || M.SEATED.has(p.gear);
  const g = mannequin(color, sit);
  const gear =
    p.gear === 'grand_piano'
      ? grandPiano()
      : p.gear === 'drums'
        ? drumKit()
        : p.gear === 'mic'
          ? micStand()
          : p.gear === 'keys'
            ? keyboard()
            : ['guitar', 'bass', 'violin', 'cello'].includes(p.gear)
              ? stringedFor(p.gear)
              : null;
  if (gear) g.add(gear);
  if (name) {
    const tag = textSprite(name);
    tag.position.y = sit ? 1.8 : 2.05;
    g.add(tag);
  }
  g.position.set(p.x, 0, p.z);
  g.rotation.y = THREE.MathUtils.degToRad(p.facing || 0);
  g.userData.pid = p.id;
  g.traverse(o => (o.userData.pid = p.id));
  return g;
}

// --- The scene ----------------------------------------------------------------------------------
// An empty stage scene: background, light, a group for the floor and one for the performers.
export function newScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15171c);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 8, 6);
  scene.add(sun);
  const floor = new THREE.Group();
  scene.add(floor);
  const people = new THREE.Group();
  scene.add(people);
  return { scene, floor, people };
}
// The GPU side of what a rebuild throws away (geometries, materials, label textures).
export const dispose = group =>
  group.traverse(o => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) {
      m.map?.dispose();
      m.dispose();
    }
  });
// The stage deck; in the editor also its grid, the audience edge and the "KHÁN GIẢ" arrow (labels,
// left out of every capture).
export function fillFloor(group, size, labels = true) {
  dispose(group);
  group.clear();
  const { w, d } = size;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, d), mat(0x3a3026));
  deck.position.y = -0.2;
  group.add(deck);
  if (!labels) return;
  const grid = new THREE.GridHelper(Math.max(w, d), Math.round(Math.max(w, d)), 0x666a73, 0x4a4e57);
  grid.position.y = 0.011;
  grid.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d));
  grid.userData.label = true;
  group.add(grid);
  // the audience side: a lip at the front edge and an arrow pointing out to the audience
  const lip = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.08), mat(0xffd60a));
  lip.position.set(0, 0.02, d / 2 - 0.04);
  lip.userData.label = true;
  group.add(lip);
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0.05, d / 2 + 0.2),
    1.2,
    0xffd60a,
    0.4,
    0.3,
  );
  arrow.userData.label = true;
  group.add(arrow);
  const audience = textSprite('KHÁN GIẢ', '#ffd60a');
  audience.position.set(0, 0.4, d / 2 + 1.8);
  group.add(audience);
}
// Every performer of the stage, in its colour (its place in the stage's list); name tags only
// when `nameOf` is given.
export function fillPeople(group, stage, nameOf = null) {
  dispose(group);
  group.clear();
  stage.performers.forEach((p, i) =>
    group.add(performerObject(p, M.COLORS[i % M.COLORS.length], nameOf ? nameOf(p.id) : '')),
  );
}
// Point a three.js camera as stage-math.js placed it ({ pos, target, fov }).
export function aim(cam3, c) {
  cam3.position.set(...c.pos);
  cam3.lookAt(...c.target);
  cam3.fov = c.fov;
  cam3.updateProjectionMatrix();
}
// One camera's framing, 1280×720 JPEG: the coloured figures, their instruments and the stage —
// no tags, grid or editor helpers (`extra`: more objects to hide while it renders).
export function shoot(renderer, scene, c, extra = []) {
  const cam3 = new THREE.PerspectiveCamera(M.VFOV, M.ASPECT, 0.05, 300);
  aim(cam3, c);
  const hidden = [];
  const hide = o => {
    if (o.visible) {
      o.visible = false;
      hidden.push(o);
    }
  };
  scene.traverse(o => o.userData.label && hide(o));
  extra.forEach(hide);
  const prev = new THREE.Vector2();
  renderer.getSize(prev);
  const ratio = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(CAP_W, CAP_H, false);
  renderer.render(scene, cam3);
  const url = renderer.domElement.toDataURL('image/jpeg', 0.85);
  renderer.setPixelRatio(ratio);
  renderer.setSize(prev.x, prev.y, false);
  for (const o of hidden) o.visible = true;
  return url;
}
// Captures of several framings without the editor: [{ stage, cam }] → JPEG data URLs, one
// offscreen renderer for the lot (released after), each stage built once, a breath between
// pictures so the page stays responsive.
export async function captureFramings(list) {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  const out = [];
  let built = null,
    sc = null;
  try {
    for (const { stage, cam } of list) {
      if (stage !== built) {
        if (sc) dispose(sc.scene);
        sc = newScene();
        fillFloor(sc.floor, stage.size || M.STAGE, false);
        fillPeople(sc.people, stage);
        built = stage;
      }
      out.push(shoot(renderer, sc.scene, cam));
      await new Promise(r => setTimeout(r));
    }
  } finally {
    if (sc) dispose(sc.scene);
    renderer.dispose();
    renderer.forceContextLoss?.();
  }
  return out;
}
