// 2D staging editor for ONE merged scene (zone ⑦). On the location plate the user drags the
// two people to their left/right positions and picks a camera framing per cut; they also tune
// the location's staging text. Saving writes the underlying fields (edge order = sides, each
// frame's `framing`, the scene node's `staging`) and the engine rebuilds the prompt live —
// no prompt is written here. Other shots are untouched; this is an opt-in per-scene tool.
import { store } from './store.js';
import { $, api, esc, toast } from './core.js';
import { closeInspector, inspect } from './inspector.js';

const FRAMING_LABEL = {
  ots_a: 'Qua vai (máy sau người TRÁI)',
  ots_b: 'Qua vai (máy sau người PHẢI)',
  two_shot: 'Trung đôi (máy trước mặt)',
};
const FRAMINGS = ['ots_a', 'ots_b', 'two_shot'];
// Where the camera dot sits for a framing, relative to the two character markers: behind the
// left person (ots_a), behind the right person (ots_b), or in front of both (two_shot).
function camPoint(framing, left, right) {
  if (framing === 'ots_a') return { x: clamp01(left.x - 0.08), y: clamp01(left.y + 0.22) };
  if (framing === 'ots_b') return { x: clamp01(right.x + 0.08), y: clamp01(right.y + 0.22) };
  return { x: (left.x + right.x) / 2, y: clamp01(Math.max(left.y, right.y) + 0.26) };
}
const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0));

export function openStaging(n) {
  const st = n.merged?.stage;
  if (!st || !st.left || !st.right) {
    toast('Cần đủ bối cảnh + hai nhân vật (nối dây vào các khung) trước khi dàn dựng.', true);
    return;
  }
  const id = n.id;
  const text = st.text || {};
  const side = x => x || { anchor: '', background: '', light: '' };
  // Local state: each character's marker position (keyed by node id) and each frame's framing.
  const pos = {
    [st.left.id]: st.blocking?.left || { x: 0.28, y: 0.52 },
    [st.right.id]: st.blocking?.right || { x: 0.72, y: 0.52 },
  };
  const framing = {};
  for (const f of n.merged.frames)
    framing[f.id] = FRAMINGS.includes(f.framing) ? f.framing : 'two_shot';

  const frameRows = n.merged.frames
    .map(
      (f, i) =>
        `<li data-frame="${f.id}"><div class="stage-frame-head"><b>Khung ${i + 1}</b> · ${esc(f.name)}</div>` +
        `<div class="stage-framing">${FRAMINGS.map(fr => `<button type="button" class="button small" data-fr="${fr}">${esc(FRAMING_LABEL[fr])}</button>`).join('')}</div></li>`,
    )
    .join('');

  const field = (idp, label, val) =>
    `<label class="field-sm">${label}<input id="${idp}" value="${esc(val || '')}"></label>`;
  $('#overlay').hidden = false;
  $('#inspector').hidden = false;
  $('#inspector').innerHTML =
    `<div class="inspector-head"><h2>🎬 Dàn dựng · ${esc(n.name)}</h2><button class="close" aria-label="Đóng">×</button></div>` +
    `<p class="field-hint">Kéo hai nhân vật về vị trí trái/phải trên ảnh bối cảnh (quyết định trục 180°). Với mỗi khung, chọn góc máy. Chỉnh mô tả nền/ánh sáng từng bên. Lưu xong, prompt tự cập nhật và ảnh khung được đánh dấu cần tạo lại.</p>` +
    `<div class="stage-plate${st.place?.image ? '' : ' empty'}" id="stagePlate"${st.place?.image ? ` style="background-image:url('${esc(st.place.image)}')"` : ''}>` +
    (st.place?.image
      ? ''
      : `<span class="stage-empty-note">Chưa có ảnh bối cảnh — vẫn đặt được vị trí</span>`) +
    `<div class="stage-marker char" data-char="${st.left.id}">${esc(st.left.name || 'A')}</div>` +
    `<div class="stage-marker char" data-char="${st.right.id}">${esc(st.right.name || 'B')}</div>` +
    `<div class="stage-cams" id="stageCams"></div></div>` +
    `<p class="field-hint" id="sidesHint"></p>` +
    `<section class="inspector-section"><h3>Góc máy từng khung</h3><ol class="stage-frames">${frameRows}</ol></section>` +
    `<section class="inspector-section"><h3>Mô tả bối cảnh (staging)</h3>` +
    field('stPlace', 'Câu mở bối cảnh', text.place) +
    `<div class="two"><fieldset class="stage-side"><legend>Bên TRÁI khung</legend>` +
    field('stLa', 'Đứng cạnh', side(text.left).anchor) +
    field('stLb', 'Nền phía sau', side(text.left).background) +
    field('stLl', 'Ánh sáng', side(text.left).light) +
    `</fieldset><fieldset class="stage-side"><legend>Bên PHẢI khung</legend>` +
    field('stRa', 'Đứng cạnh', side(text.right).anchor) +
    field('stRb', 'Nền phía sau', side(text.right).background) +
    field('stRl', 'Ánh sáng', side(text.right).light) +
    `</fieldset></div>` +
    field('stTwo', 'Bố cục trung đôi (two_shot)', text.two_shot) +
    `</section>` +
    `<div class="actions"><button class="button primary" id="stSave">💾 Lưu dàn dựng</button><button class="button" id="stBack">← Quay lại phân cảnh</button></div>`;

  const plate = $('#stagePlate');
  // Draws the two character markers and the per-frame camera dots at their current positions.
  function draw() {
    for (const el of plate.querySelectorAll('.stage-marker.char')) {
      const p = pos[el.dataset.char];
      el.style.left = p.x * 100 + '%';
      el.style.top = p.y * 100 + '%';
    }
    const order = [st.left.id, st.right.id].sort((a, b) => pos[a].x - pos[b].x);
    const [leftId, rightId] = order;
    $('#sidesHint').textContent =
      'Bên trái: ' +
      esc(nameOf(leftId)) +
      ' · Bên phải: ' +
      esc(nameOf(rightId)) +
      ' (ots_a = máy sau người trái nhìn người phải; người nói nên là người quay mặt về máy).';
    const cams = n.merged.frames
      .map((f, i) => {
        const c = camPoint(framing[f.id], pos[leftId], pos[rightId]);
        return `<div class="stage-cam" style="left:${c.x * 100}%;top:${c.y * 100}%" title="${esc(f.name)}">📷${i + 1}</div>`;
      })
      .join('');
    $('#stageCams').innerHTML = cams;
  }
  const nameOf = cid => (cid === st.left.id ? st.left.name : st.right.name) || cid;

  // Pointer drag for the character markers (works with mouse + touch).
  let dragging = null;
  plate.querySelectorAll('.stage-marker.char').forEach(el => {
    el.onpointerdown = e => {
      dragging = el.dataset.char;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
  });
  plate.onpointermove = e => {
    if (!dragging) return;
    const r = plate.getBoundingClientRect();
    pos[dragging] = {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01((e.clientY - r.top) / r.height),
    };
    draw();
  };
  plate.onpointerup = plate.onpointercancel = () => (dragging = null);

  // Framing buttons per frame.
  for (const li of $('#inspector').querySelectorAll('.stage-frames li')) {
    const fid = li.dataset.frame;
    const paint = () =>
      li
        .querySelectorAll('[data-fr]')
        .forEach(b => b.classList.toggle('active', b.dataset.fr === framing[fid]));
    paint();
    li.querySelectorAll('[data-fr]').forEach(
      b =>
        (b.onclick = () => {
          framing[fid] = b.dataset.fr;
          paint();
          draw();
        }),
    );
  }

  $('.close').onclick = closeInspector;
  $('#stBack').onclick = () => inspect(id);
  $('#stSave').onclick = async () => {
    const order = [st.left.id, st.right.id].sort((a, b) => pos[a].x - pos[b].x);
    const body = {
      id,
      sides: { left: order[0], right: order[1] },
      frames: n.merged.frames.map(f => ({ id: f.id, framing: framing[f.id] })),
      staging: {
        place: $('#stPlace').value,
        two_shot: $('#stTwo').value,
        left: { anchor: $('#stLa').value, background: $('#stLb').value, light: $('#stLl').value },
        right: { anchor: $('#stRa').value, background: $('#stRb').value, light: $('#stRl').value },
      },
      blocking: { left: pos[order[0]], right: pos[order[1]] },
    };
    try {
      store.state = await api('/api/merged/staging', { method: 'POST', body });
      toast('Đã lưu dàn dựng · prompt cập nhật, tạo lại ảnh khung rồi quay video');
      inspect(id); // back to the merged panel, now showing the new prompt + stale frames
    } catch (e) {
      toast(e.message, true);
    }
  };
  draw();
}
