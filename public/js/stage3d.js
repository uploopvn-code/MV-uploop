// "Dàn dựng 3D" — the 3D stage of one set. The user pins each performer (a coloured mannequin with
// their instrument) on the stage floor, once; every node that uses the set — wired to it, or to
// the location it is wired into — then sees the SAME marks through its own camera, which the tool
// decides from that node (its size / angle / subject, stage-math.js, shared with the server).
// Pinning stores the marks on the scene node and a capture of every node's framing, sent with its
// image as a layout reference; its prompt gets the matching blocking text. Nodes added or changed
// later are captured on their own (stage-keeper.js). Loaded on demand (three.js is ~2 MB).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { store } from './store.js';
import { api, esc, toast } from './core.js';
import { render } from './render.js';
import { inspect } from './inspector.js';
import * as M from './stage-math.js';
import { aim, dispose, fillFloor, fillPeople, newScene, shoot } from './stage-scene.js';

const isShot = n =>
  !!n &&
  !n.terminal &&
  n.kind !== 'setting' &&
  n.kind !== 'music' &&
  ('duration' in n || n.role === 'lipsync') &&
  !['seedance', 'merged', 'frame'].includes(n.role);
// The project graph as stage-math.js reads it (the same rules as the server's lib/stage3d.mjs).
function graphOf(state) {
  const byId = new Map(state.nodes.map(n => [n.id, n]));
  const wired = id =>
    state.edges
      .filter(e => e.target === id)
      .map(e => byId.get(e.source))
      .filter(Boolean);
  return {
    node: id => byId.get(id),
    parents: id => wired(id).filter(x => x.kind !== 'setting'),
    isPerson: x => !!x && x.role !== 'look' && (x.role === 'character' || x.zone === 'character'),
    isSet: x =>
      !!x &&
      !x.terminal &&
      x.kind !== 'setting' &&
      x.role !== 'angle' &&
      (x.role === 'scene' || x.zone === 'design'),
    cameraText: id => M.cameraTextOf(wired(id)),
  };
}
// How the prompt names a person (lib/prompts.mjs castLabel): the code, else the short name.
const labelOf = x =>
  String(x?.code || '').trim() ||
  String(x?.name || '')
    .split(/\s*[(—–]\s*/)[0]
    .trim() ||
  x?.name ||
  '';

let open = null; // the editor on screen (one at a time)

export function openStage3d(setId) {
  if (open) open.close();
  const state = store.state;
  const g = graphOf(state);
  const set = g.node(setId);
  if (!set || !g.isSet(set)) return toast('Chọn node bối cảnh (cảnh toàn) để dàn dựng 3D.', true);
  const people = state.nodes.filter(n => !n.terminal && g.isPerson(n));
  if (!people.length) return toast('Project chưa có nhân vật. Tạo hình dàn biểu diễn trước.', true);
  // The nodes that keep this set's marks once they are pinned: the set staged as being edited
  // (wired straight in, or into the location they are filmed in) — the server's rule.
  const usersOf = (st, s0 = store.state) => {
    const base = graphOf(s0);
    const me = { ...base.node(setId), stage3d: { ...st, rev: 0 } };
    const swap = x => (x?.id === setId ? me : x);
    const gs = {
      ...base,
      node: id => swap(base.node(id)),
      parents: id => base.parents(id).map(swap),
    };
    return s0.nodes.filter(n => isShot(n) && M.setOf(n.id, gs)?.id === setId);
  };
  // who plays here: the saved stage, else everyone the set's shots show, else every character —
  // cleaned the way the server saves it (a character deleted since is no longer on it, everyone
  // on the floor), so what is drawn and captured is what will be stored
  const isPersonId = id => g.isPerson(g.node(id));
  const first = usersOf({ performers: people.map(p => ({ id: p.id })) });
  const used = [...new Set(first.flatMap(s => M.wiredPeople(s.id, g)))];
  const stage = M.cleanStage(
    set.stage3d?.performers?.length
      ? { size: set.stage3d.size, performers: set.stage3d.performers }
      : {
          size: { ...M.STAGE },
          performers: M.autoLayout(
            (used.length ? used.map(id => g.node(id)) : people).filter(Boolean),
          ),
        },
    isPersonId,
  );
  const nameOf = id => labelOf(g.node(id)) || 'performer';
  let shots = usersOf(stage);
  let dirty = false;

  // a renderer first: a machine without WebGL gets a message, not a stuck full-screen layer
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  } catch (e) {
    return toast('Máy này không chạy được 3D (WebGL): ' + e.message, true);
  }

  // --- DOM ---
  const root = document.createElement('div');
  root.id = 's3d';
  root.className = 's3d';
  root.innerHTML =
    `<header class="s3d-head"><h2>🧍 Dàn dựng 3D · ${esc(set.name)}</h2>` +
    `<span class="s3d-hint">Bấm chọn một người rồi kéo mũi tên dưới chân để dời · R / Shift+R xoay 15° · chuột trái xoay góc nhìn, chuột phải dời, cuộn phóng to</span>` +
    `<button type="button" class="button" id="s3dAuto">Tự xếp theo vai</button>` +
    `<button type="button" class="button primary" id="s3dSave">📌 Ghim vị trí</button>` +
    `<button type="button" class="button" id="s3dClose">✕ Đóng</button></header>` +
    `<aside class="s3d-left"><h3>Người trên sân khấu</h3><ul class="s3d-people" id="s3dPeople"></ul>` +
    `<h3>Sân khấu</h3><div class="s3d-size"><label>Rộng (m)<input id="s3dW" type="number" min="4" max="40" step="0.5"></label><label>Sâu (m)<input id="s3dD" type="number" min="3" max="30" step="0.5"></label></div>` +
    `<p class="field-hint">Mũi tên vàng ở mép sân khấu = phía khán giả. Trái/phải = trái/phải khung hình của góc toàn. Mỗi người một màu cố định — prompt cho mô hình ảnh biết màu nào là ai.</p>` +
    (set.image ? `<img class="s3d-set" src="${esc(set.image.url)}" alt="Ảnh bối cảnh">` : '') +
    `</aside><div class="s3d-view" id="s3dView"></div>` +
    `<aside class="s3d-right"><h3>Xem thử khung hình</h3>` +
    `<p class="field-hint">Ghim một lần ở đây. Mọi node dùng bối cảnh này — nối thẳng node này vào, hoặc nối node này vào bối cảnh của chúng — tự nhận vị trí; cỡ cảnh, góc máy và ai ở giữa khung tool tự lấy từ chính node đó. Node thêm hay sửa sau cũng tự nhận.</p>` +
    `<ul class="s3d-cams" id="s3dCams"></ul><h3>Câu vị trí tool tự thêm vào prompt</h3><div class="s3d-text" id="s3dText"></div></aside>`;
  document.body.appendChild(root);
  const $s = sel => root.querySelector(sel);

  // --- three.js ---
  const view = $s('#s3dView');
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  view.appendChild(renderer.domElement);
  const { scene, floor: floorGroup, people: people3d } = newScene();
  const editorCam = new THREE.PerspectiveCamera(50, 1, 0.05, 300);
  editorCam.position.set(8, 9, 13);
  const orbit = new OrbitControls(editorCam, renderer.domElement);
  orbit.target.set(0, 0.6, 0);
  orbit.update();
  const shotCam = new THREE.PerspectiveCamera(M.VFOV, M.ASPECT, 0.05, 300);
  const tc = new TransformControls(editorCam, renderer.domElement);
  tc.showY = false;
  tc.setMode('translate');
  scene.add(tc.getHelper());
  tc.addEventListener('dragging-changed', e => (orbit.enabled = !e.value && camKey === 'free'));
  // the move handles show only in the free view, on someone picked
  const showGizmo = () => (tc.getHelper().visible = camKey === 'free' && !!tc.object);

  const buildFloor = () => fillFloor(floorGroup, stage.size);
  let selected = null;
  function buildPeople() {
    tc.detach();
    fillPeople(people3d, stage, nameOf);
    if (selected) {
      const o = people3d.children.find(c => c.userData.pid === selected);
      if (o) tc.attach(o);
      else selected = null;
    }
    showGizmo();
  }
  const objOf = id => people3d.children.find(c => c.userData.pid === id);
  tc.addEventListener('objectChange', () => {
    const o = tc.object;
    const p = o && stage.performers.find(x => x.id === o.userData.pid);
    if (!p) return;
    const { w, d } = stage.size;
    o.position.x = Math.min(w / 2, Math.max(-w / 2, o.position.x));
    o.position.z = Math.min(d / 2, Math.max(-d / 2, o.position.z));
    p.x = Number(o.position.x.toFixed(2));
    p.z = Number(o.position.z.toFixed(2));
    dirty = true;
    showText();
  });

  // --- cameras: free (orbit) / the front wide / each node that uses the set (a preview: the
  // tool picks every node's framing) ---
  const graphNow = () => graphOf(store.state);
  const wideSpec = { target: null, size: 'WS', angle: { kind: 'eye', side: 0 } };
  // a node's framing on this stage — null for an insert / object shot the stage plays no part in
  const specOf = shot => (shot ? M.shotSpec(shot, stage, graphNow()) : null);
  let camKey = 'free';
  const camOf = key =>
    M.shotCamera(stage, (key !== 'wide' && specOf(shots.find(s => s.id === key))) || wideSpec);
  const shotLabel = s => `${esc(s.name)}<small>${esc(M.framingLabel(specOf(s), nameOf))}</small>`;
  function listCams() {
    shots = usersOf(stage);
    const staged = shots.filter(s => specOf(s));
    if (camKey !== 'free' && camKey !== 'wide' && !staged.some(s => s.id === camKey))
      camKey = 'wide';
    const inserts = shots.length - staged.length;
    $s('#s3dCams').innerHTML =
      `<li data-cam="free" class="${camKey === 'free' ? 'active' : ''}">🎛 Góc dựng tự do (kéo người ở đây)</li>` +
      `<li data-cam="wide" class="${camKey === 'wide' ? 'active' : ''}">🎥 Toàn cảnh (khán giả)</li>` +
      (staged.length
        ? `<li class="s3d-group"><details${staged.some(s => s.id === camKey) ? ' open' : ''}><summary>Từng node dùng bối cảnh này (${staged.length})</summary><ul>${staged
            .map(
              s =>
                `<li data-cam="${esc(s.id)}" class="${camKey === s.id ? 'active' : ''}">${shotLabel(s)}</li>`,
            )
            .join('')}</ul></details></li>`
        : '<li class="s3d-empty">Chưa có node nào dùng bối cảnh này. Nối node này vào các shot (hoặc vào bối cảnh của chúng) — chúng tự nhận vị trí.</li>') +
      (inserts
        ? `<li class="s3d-empty">${inserts} node cận đồ vật / chi tiết — không cần vị trí.</li>`
        : '');
    for (const li of root.querySelectorAll('#s3dCams [data-cam]'))
      li.onclick = () => {
        camKey = li.dataset.cam;
        // marks are moved in the free view; a node's view is its exact 16:9 frame, to look at
        const free = camKey === 'free';
        orbit.enabled = free;
        tc.enabled = free;
        showGizmo();
        listCams();
        showText();
      };
  }
  // The blocking sentence the selected camera's node gets (names; the prompt adds image numbers).
  function showText() {
    const key = camKey === 'free' ? 'wide' : camKey;
    const spec = specOf(shots.find(s => s.id === key)) || wideSpec;
    // in the front wide, nobody may hide straight behind someone else
    const hid = M.hidden(stage, M.shotCamera(stage, wideSpec));
    $s('#s3dText').textContent =
      (camKey !== 'free' && camKey !== 'wide'
        ? 'Đang xem khung hình tool chọn cho node này (chỉ xem). Về 🎛 Góc dựng tự do để kéo người.\n\n'
        : '') +
      (hid.length
        ? '⚠ Góc toàn bị che: ' +
          hid.map(h => `${nameOf(h.back)} đứng ngay sau ${nameOf(h.front)}`).join('; ') +
          ' — dời sang trái/phải một chút.\n\n'
        : '') +
      (M.blockingText(stage, spec, nameOf) || 'Không có ai trong khung của góc máy này.');
    if (camKey !== 'free') aim(shotCam, camOf(camKey));
  }

  // --- the performers panel ---
  const GEAR_VI = {
    mic: 'Micro (hát)',
    grand_piano: 'Đàn grand piano',
    keys: 'Đàn keyboard',
    drums: 'Bộ trống',
    guitar: 'Guitar',
    bass: 'Bass',
    violin: 'Violin',
    cello: 'Cello',
    none: '— không —',
  };
  function listPeople() {
    const on = new Map(stage.performers.map((p, i) => [p.id, i]));
    $s('#s3dPeople').innerHTML = people
      .map(n => {
        const i = on.get(n.id);
        const p = i === undefined ? null : stage.performers[i];
        return (
          `<li data-pid="${esc(n.id)}" class="${selected === n.id ? 'active' : ''}">` +
          `<label class="s3d-on"><input type="checkbox" ${p ? 'checked' : ''}>` +
          `<span class="s3d-dot" style="background:${p ? M.COLORS[i % M.COLORS.length] : 'transparent'}"></span>` +
          (n.image ? `<img src="${esc(n.image.url)}" alt="">` : '') +
          `<b>${esc(labelOf(n))}</b></label>` +
          (p
            ? `<div class="s3d-row"><select data-k="gear">${Object.entries(GEAR_VI)
                .map(
                  ([k, v]) =>
                    `<option value="${k}" ${p.gear === k ? 'selected' : ''}>${v}</option>`,
                )
                .join('')}</select>` +
              `<select data-k="pose"><option value="stand" ${p.pose !== 'sit' ? 'selected' : ''}>Đứng</option><option value="sit" ${p.pose === 'sit' ? 'selected' : ''}>Ngồi</option></select></div>` +
              `<label class="s3d-facing">Hướng mặt <input type="range" data-k="facing" min="-180" max="180" step="5" value="${p.facing}"><output>${p.facing}°</output></label>`
            : '') +
          `</li>`
        );
      })
      .join('');
    for (const li of root.querySelectorAll('#s3dPeople li')) {
      const pid = li.dataset.pid;
      li.querySelector('input[type=checkbox]').onchange = e => {
        if (e.target.checked) {
          if (stage.performers.length >= M.MAX_PERFORMERS)
            return (
              (e.target.checked = false),
              toast(`Tối đa ${M.MAX_PERFORMERS} người trên một sân khấu.`, true)
            );
          const [spot] = M.autoLayout([g.node(pid)]);
          // a free spot near its slot, on the floor
          const half = stage.size.w / 2;
          spot.x = Math.min(half, Math.max(-half, spot.x));
          spot.z = Math.min(stage.size.d / 2, Math.max(-stage.size.d / 2, spot.z));
          for (
            let k = 0;
            k < 20 && stage.performers.some(q => Math.hypot(q.x - spot.x, q.z - spot.z) < 1);
            k++
          )
            spot.x = spot.x + 1.1 > half ? -half + 0.5 : spot.x + 1.1;
          stage.performers.push(spot);
          selected = pid;
        } else {
          stage.performers = stage.performers.filter(q => q.id !== pid);
          if (selected === pid) selected = null;
        }
        dirty = true;
        rebuild();
      };
      li.querySelector('label.s3d-on b').onclick = e => {
        e.preventDefault();
        select(pid);
      };
      for (const el of li.querySelectorAll('[data-k]')) {
        const p = stage.performers.find(q => q.id === pid);
        if (!p) continue;
        if (el.dataset.k === 'facing')
          el.oninput = () => {
            p.facing = Number(el.value);
            el.nextElementSibling.textContent = p.facing + '°';
            const o = objOf(pid);
            if (o) o.rotation.y = THREE.MathUtils.degToRad(p.facing);
            dirty = true;
            showText();
          };
        else
          el.onchange = () => {
            p[el.dataset.k] = el.value;
            // seated gear seats its player; leaving it, the player stands again
            if (el.dataset.k === 'gear') p.pose = M.SEATED.has(p.gear) ? 'sit' : 'stand';
            dirty = true;
            rebuild();
          };
      }
    }
  }
  function select(pid) {
    selected = stage.performers.some(p => p.id === pid) ? pid : null;
    const o = selected && objOf(selected);
    if (o) tc.attach(o);
    else tc.detach();
    showGizmo();
    for (const li of root.querySelectorAll('#s3dPeople li'))
      li.classList.toggle('active', li.dataset.pid === selected);
  }
  function rebuild() {
    buildPeople();
    listPeople();
    listCams();
    showText();
  }
  // click a mannequin to pick it
  const ray = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', e => {
    if (tc.dragging || e.button !== 0 || camKey !== 'free') return;
    const r = renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    ray.setFromCamera(v, editorCam);
    const hit = ray.intersectObjects(people3d.children, true).find(h => h.object.userData.pid);
    if (hit) select(hit.object.userData.pid);
  });
  // keys: R / Shift+R turn the picked performer; Escape closes. Nothing reaches the canvas behind
  // (its Delete removes wires).
  function onKey(e) {
    if (e.target.closest?.('input, select, textarea') && e.key !== 'Escape')
      return e.stopPropagation();
    e.stopPropagation();
    if (e.key === 'Escape') return leave();
    if ((e.key === 'r' || e.key === 'R') && selected) {
      const p = stage.performers.find(q => q.id === selected);
      p.facing = ((((p.facing + (e.shiftKey ? -15 : 15)) % 360) + 540) % 360) - 180;
      const o = objOf(selected);
      if (o) o.rotation.y = THREE.MathUtils.degToRad(p.facing);
      dirty = true;
      listPeople();
      showText();
    }
  }
  window.addEventListener('keydown', onKey, true);

  // --- draw loop ---
  let raf = 0;
  function size() {
    const w = view.clientWidth || 800,
      h = view.clientHeight || 450;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    editorCam.aspect = w / h;
    editorCam.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(size);
  ro.observe(view);
  function frame() {
    raf = requestAnimationFrame(frame);
    if (camKey === 'free') renderer.render(scene, editorCam);
    else {
      // the node's 16:9 frame, letterboxed in the view
      const w = view.clientWidth,
        h = view.clientHeight;
      const fw = Math.min(w, h * M.ASPECT),
        fh = fw / M.ASPECT;
      renderer.setScissorTest(true);
      renderer.setViewport(0, 0, w, h);
      renderer.setScissor(0, 0, w, h);
      renderer.setClearColor(0x0b0c0f);
      renderer.clear();
      renderer.setViewport((w - fw) / 2, (h - fh) / 2, fw, fh);
      renderer.setScissor((w - fw) / 2, (h - fh) / 2, fw, fh);
      renderer.render(scene, shotCam);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
    }
  }

  // --- capture: a framing, 1280×720, no tags / grid / gizmo ---
  const capture = c => shoot(renderer, scene, c, [tc.getHelper()]);

  let saving = false,
    closed = false;
  // The stage as the server will store it (cleaned the same way), redrawn before it is captured:
  // the pictures show exactly the marks the prompts describe.
  function normalize(g2) {
    const clean = M.cleanStage(stage, id => g2.isPerson(g2.node(id)));
    stage.size = clean.size;
    stage.performers = clean.performers;
    buildFloor();
    rebuild();
  }
  async function save() {
    const btn = $s('#s3dSave');
    btn.disabled = true;
    btn.textContent = '⏳ Đang ghim…';
    saving = true;
    try {
      const g2 = graphNow();
      normalize(g2);
      const captures = usersOf(stage)
        .map(s => ({ s, spec: M.shotSpec(s, stage, g2) }))
        .filter(x => x.spec)
        .map(({ s, spec }) => ({
          shotId: s.id,
          key: M.layoutSig({ rev: 0 }, spec),
          image: capture(M.shotCamera(stage, spec)),
        }));
      const wide = capture(M.shotCamera(stage, wideSpec));
      store.state = await api('/api/stage3d', {
        method: 'POST',
        body: { sceneId: setId, stage, wide, captures },
      });
      const s = store.state.stage3dSummary || {};
      dirty = false;
      saving = false;
      render();
      if (!closed) {
        close();
        inspect(setId);
      }
      toast(
        s.performers
          ? `📌 Đã ghim ${s.performers} người · ${s.staged} node tự nhận vị trí (cỡ cảnh, góc máy tool tự tính)` +
              (s.shots > s.staged ? ` · bỏ qua ${s.shots - s.staged} node cận đồ vật` : '') +
              (s.wired ? ` · thêm ${s.wired} người vào các node toàn cảnh` : '') +
              (s.stale ? ` · ⚠ ${s.stale} node đã có ảnh cần tạo lại` : '')
          : 'Đã bỏ ghim — sân khấu không còn ai.',
      );
    } catch (e) {
      saving = false;
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '📌 Ghim vị trí';
    }
  }
  // Closing with marks moved but not pinned asks first.
  function leave() {
    if (saving) return;
    if (dirty && !confirm('Đóng mà chưa ghim? Vị trí vừa đặt sẽ mất.')) return;
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('keydown', onKey, true);
    tc.detach();
    tc.dispose();
    orbit.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    dispose(scene);
    root.remove();
    if (open?.root === root) open = null;
  }

  $s('#s3dClose').onclick = leave;
  $s('#s3dSave').onclick = save;
  $s('#s3dAuto').onclick = () => {
    stage.performers = M.autoLayout(stage.performers.map(p => g.node(p.id)).filter(Boolean));
    dirty = true;
    rebuild();
  };
  for (const [id, k] of [
    ['#s3dW', 'w'],
    ['#s3dD', 'd'],
  ]) {
    const el = $s(id);
    el.value = stage.size[k];
    el.onchange = () => {
      const v = Number(el.value);
      if (!(v > 0)) return;
      stage.size[k] = v;
      dirty = true;
      // the size within its limits, everyone kept on the new floor (as the server saves it)
      normalize(graphNow());
      el.value = stage.size[k];
    };
  }

  buildFloor();
  rebuild();
  size();
  frame();
  open = {
    close,
    root,
    stage,
    capture,
    camOf,
    get shots() {
      return shots;
    },
  };
  return open;
}
// For tests and the console: the editor on screen.
export const current = () => open;
