// Wardrobe panel in the inspector (costumes, looks, items).
import { store } from './store.js';
import { esc } from './core.js';

// Inspector section for the wardrobe zone. Wardrobe node: the costume + items fields that
// drive its generated prompt, its character and the shots using it. Character node: its
// wardrobe nodes and a button to add one, pre-wired to it.
// Typed reference sheets: the user writes one description and the server builds the model
// sheet prompt around it, so a prop / character / location keeps the same shape, scale and
// lighting in every shot that references it.
const SHEET_COPY = {
  prop: {
    title: '🧰 Vật dụng — model sheet',
    hint: 'Tool dựng sẵn prompt: <b>một ảnh gồm 1 góc chính lớn + 2 góc xoay</b> của đúng vật này, cùng tỉ lệ, cùng nguồn sáng, nền xám trơn, <b>không có bàn tay và bối cảnh</b> — giống model sheet nhân vật, để vật dụng không đổi hình giữa các shot. Chỉ cần gõ mô tả, không cần viết prompt.',
    placeholder:
      'a tarnished Victorian silver locket, oval, engraved ivy, worn hinge, holding a faded photograph',
    empty: 'Bỏ trống thì tool dùng tên node làm mô tả.',
  },
  character: {
    title: '① Nhân vật — model sheet',
    hint: 'Tool dựng sẵn prompt: <b>chân dung lớn + 3 góc toàn thân</b> (trước, nghiêng, sau) cùng tỉ lệ trên một đường chân, nền xám, để Veo giữ đúng khuôn mặt và bộ đồ qua mọi shot.',
    placeholder:
      'a woman in her late thirties, sharp cheekbones, dark hair pinned up, charcoal high-neck mourning dress',
    empty:
      'Bỏ trống thì tool vẫn dựng model sheet nhưng để model tự nghĩ ra người — <b>tên node không được đưa vào prompt</b> (tên thật khiến model video dễ từ chối cảnh vì tưởng người có thật).',
  },
  scene: {
    title: '③ Bối cảnh — 3 cỡ cảnh / 1 ảnh',
    hint: 'Tool dựng sẵn prompt: <b>một ảnh gồm 3 cỡ cảnh</b> — cảnh toàn + cận góc A + cận góc B của cùng một không gian trống người — render một lần (như model sheet nhân vật). Chỉ cần gõ mô tả địa điểm.',
    placeholder:
      'a Victorian study, oak panelling, a desk by the tall window, rain outside, late afternoon',
    empty:
      'Bỏ trống thì tool vẫn dựng cảnh toàn nhưng để model tự nghĩ ra địa điểm — <b>tên node không được đưa vào prompt</b>.',
  },
};
export function sheetPanel(n) {
  const c = SHEET_COPY[n.role];
  if (!c) return '';
  // A node that carries its own written prompt (every character built from a blueprint) keeps
  // it: prompts() prefers a written prompt over the generated sheet, the same way a costume's
  // outfit fields step aside. Offering an editable description there would promise a rebuild
  // that never happens, so say what is actually in force and how to switch.
  if (String(n.prompt || '').trim())
    return (
      `<section class="inspector-section"><h3>${c.title}</h3>` +
      `<p class="field-hint">Node này đang dùng <b>prompt riêng</b> (viết trong blueprint hoặc do bạn sửa tay), nên prompt đó thắng và mô tả sẽ không có tác dụng. Muốn chuyển sang model sheet tool dựng sẵn: bấm <b>Dùng prompt kế thừa</b> ở dưới để xóa prompt riêng, rồi quay lại gõ mô tả.</p>` +
      `</section>`
    );
  return (
    `<section class="inspector-section"><h3>${c.title}</h3>` +
    `<p class="field-hint">${c.hint}</p>` +
    `<label>Mô tả (tiếng Anh)<textarea id="sheetDesc" rows="3" placeholder="${esc(c.placeholder)}">${esc(n.desc || '')}</textarea></label>` +
    `<p class="field-hint">${c.empty} Sửa mô tả rồi bấm <b>Lưu chỉnh sửa</b> — prompt ảnh bên dưới tự dựng lại.</p>` +
    `</section>`
  );
}

// A costume node by role, or any role-less image node the user dragged into the wardrobe
// column. Items (props) placed in that column keep their own role.
const isWardrobeNode = x =>
  !!x &&
  !x.terminal &&
  x.kind !== 'setting' &&
  (x.role === 'wardrobe' || (!x.role && x.zone === 'wardrobe' && !('duration' in x)));
export function wardrobePanel(n) {
  const byId = id => store.state.nodes.find(x => x.id === id);
  if (isWardrobeNode(n)) {
    // The costume records its character (charId) and takes no image input of its own;
    // graphs built before that still carry a character → costume wire.
    const chars = [
      byId(n.charId) ||
        store.state.edges
          .filter(e => e.target === n.id)
          .map(e => byId(e.source))
          .find(x => x && x.kind !== 'setting'),
    ].filter(Boolean);
    const outs = store.state.edges
      .filter(e => e.source === n.id)
      .map(e => byId(e.target))
      .filter(Boolean);
    const looks = outs.filter(x => x.role === 'look');
    const shots = outs.filter(x => x.role !== 'look');
    return (
      `<section class="inspector-section"><h3>👗 Trang phục (bộ đồ)</h3>` +
      `<p class="field-hint">Nhân vật: ${chars.length ? '<b>' + esc(chars.map(c => c.name).join(', ')) + '</b>' : '<b>chưa gắn</b> — tạo trang phục từ node nhân vật để gắn'}. ` +
      `Node này render <b>bộ đồ</b> trên ma-nơ-canh, <b>không nhận ảnh đầu vào</b> (đưa ảnh người vào chỉ khiến model vẽ lại người). Để Veo thấy đúng người mặc đúng bộ, tạo node <b>nhân vật đã mặc</b> từ đây (ghép ảnh nhân vật + ảnh bộ đồ, prompt tool đặt sẵn) rồi nối node đó vào shot — không nối node này thẳng vào shot.</p>` +
      `<label>Trang phục (tiếng Anh)<textarea id="wardrobeOutfit" rows="2" placeholder="charcoal high-neck mourning dress, black gloves, onyx brooch">${esc(n.outfit || '')}</textarea></label>` +
      `<label>Vật dụng / phụ kiện (tiếng Anh)<textarea id="wardrobeItems" rows="2" placeholder="black umbrella, antique silver locket">${esc(n.items || '')}</textarea></label>` +
      (looks.length
        ? `<p class="field-hint">Nhân vật đã mặc: ${looks.map(l => `<button type="button" class="link" data-open="${l.id}">${esc(l.name)}</button> · ${l.image ? 'đã có ảnh' : 'chưa có ảnh'}`).join(', ')}</p>`
        : `<button type="button" class="button" id="addLookFor">＋ Tạo node nhân vật đã mặc bộ này</button>`) +
      (shots.length
        ? `<p class="field-hint">⚠ Đang nối thẳng vào shot: ${esc(shots.map(s => s.name).join(', '))} — nên nối qua node nhân vật đã mặc.</p>`
        : '') +
      `</section>`
    );
  }
  if (n.role === 'look') {
    const parents = store.state.edges
      .filter(e => e.target === n.id)
      .map(e => byId(e.source))
      .filter(x => x && x.kind !== 'setting');
    const ch = parents.filter(x => x.role === 'character' || x.zone === 'character');
    const cs = parents.filter(isWardrobeNode);
    const shots = store.state.edges
      .filter(e => e.source === n.id)
      .map(e => byId(e.target))
      .filter(Boolean);
    return (
      `<section class="inspector-section"><h3>👤 Nhân vật đã mặc trang phục</h3>` +
      `<p class="field-hint">Ghép <b>ảnh nhân vật</b> (khuôn mặt, vóc dáng) với <b>ảnh trang phục</b> (bộ đồ) thành chính người đó mặc bộ này, ra đúng bố cục model sheet như nhân vật (chân dung + 3 góc toàn thân, cùng model ảnh và tỉ lệ khung với node nhân vật) — prompt tool đặt sẵn, không cần sửa. Cả hai node đầu vào phải có ảnh trước. Nối cổng Ra của node này vào các shot dùng look này.</p>` +
      `<p class="field-hint">Nhân vật: ${ch.length ? '<b>' + esc(ch.map(c => c.name).join(', ')) + '</b>' : '<b>chưa nối</b>'} · Trang phục: ${cs.length ? '<b>' + esc(cs.map(c => c.name).join(', ')) + '</b>' : '<b>chưa nối</b>'} · Dùng ở: ${shots.length ? esc(shots.map(s => s.name).join(', ')) : 'chưa nối shot nào'}</p></section>`
    );
  }
  // Scene column: a scene's derived angles (+ buttons), and an angle's own fields.
  const anglesBlock = () => {
    const angles = store.state.edges
      .filter(e => e.source === n.id)
      .map(e => byId(e.target))
      .filter(x => x?.role === 'angle');
    const item = a =>
      `<li><button type="button" class="link" data-open="${a.id}">${esc(a.name)}</button> · ${a.image ? 'đã có ảnh' : 'chưa có ảnh'}</li>`;
    return (
      (angles.length
        ? `<p class="field-hint">Góc máy từ node này:</p><ul class="wardrobe-list">${angles.map(item).join('')}</ul>`
        : '') +
      `<div class="actions"><button type="button" class="button" id="addReverseAngles">＋ 2 góc cận đối nghịch A/B</button><button type="button" class="button" id="addAngleFor">＋ Góc máy khác</button></div>`
    );
  };
  if (n.role === 'angle') {
    const master = store.state.edges
      .filter(e => e.target === n.id)
      .map(e => byId(e.source))
      .find(x => x && x.kind !== 'setting');
    const shots = store.state.edges
      .filter(e => e.source === n.id)
      .map(e => byId(e.target))
      .filter(x => x && x.role !== 'angle');
    return (
      `<section class="inspector-section"><h3>◧ Góc máy của bối cảnh</h3>` +
      `<p class="field-hint">Render <b>từ ảnh bối cảnh gốc</b> (${master ? '<b>' + esc(master.name) + '</b>' + (master.image ? '' : ' — chưa có ảnh, tạo ảnh gốc trước') : '<b>chưa nối</b> — nối cổng Ra của node bối cảnh vào đây'}): cùng kiến trúc, bài trí, ánh sáng, chỉ đổi vị trí máy, không có người. Prompt tool đặt sẵn từ mô tả góc dưới đây. Góc A = cái máy OTS A nhìn thấy (sau vai A nhìn B), góc B ngược lại 180°. <b>Ảnh ra giống cảnh toàn?</b> Tả góc cụ thể hơn (máy đứng cạnh vật gì, nhìn về vật gì, cỡ cận) rồi bấm Tạo ảnh lại.</p>` +
      `<label>Góc máy (tiếng Anh)<textarea id="angleText" rows="3" placeholder="camera at the fireplace looking toward the desk, medium-close, eye level">${esc(n.angle || '')}</textarea></label>` +
      `<p class="field-hint">Dùng ở: ${shots.length ? esc(shots.map(s => s.name).join(', ')) : 'chưa nối shot nào'}</p>` +
      anglesBlock() +
      `</section>`
    );
  }
  // A master scene: one built from the blueprint (no role) or typed from the toolbar
  // (role 'scene'). Both render angles from their image, so both offer the angle buttons.
  if (
    (!n.role || n.role === 'scene') &&
    n.zone === 'design' &&
    n.kind !== 'setting' &&
    !n.terminal
  ) {
    const st = n.stage3d;
    const k = st?.performers?.length || 0;
    // the nodes keeping this set's marks, and how their 3D captures stand
    const users = store.state.nodes.filter(x => x.stagePin?.setId === n.id);
    const framed = users.filter(x => x.stagePin.sig);
    const waiting = framed.filter(x => x.stagePin.capture === 'missing').length;
    const full = framed.filter(x => x.stagePin.capture === 'full').length;
    const redo = users.filter(x => x.stale && x.image).length;
    // a location whose marks come from a 3D stage node wired into it
    const from = store.state.edges
      .filter(e => e.target === n.id)
      .map(e => byId(e.source))
      .find(x => x?.stageOnly && x.stage3d?.performers?.length);
    return (
      `<section class="inspector-section"><h3>📌 Ghim vị trí trên sân khấu (3D)</h3>` +
      (n.stageOnly
        ? `<p class="field-hint">Node <b>sân khấu 3D</b>: chỉ giữ chỗ đứng và hướng mặt của từng người (không tạo ảnh). Ghim <b>một lần</b>, rồi nối node này vào các shot — hoặc vào bối cảnh của chúng: mọi node ở đó tự nhận đúng vị trí, kể cả node thêm sau, nhập lại CSV hay sửa tay. Cỡ cảnh, góc máy và ai ở giữa khung: tool tự tính theo từng node.</p>`
        : `<p class="field-hint">Đặt chỗ đứng và hướng mặt của từng người <b>một lần</b> — hoặc nối một node <b>🧍 Sân khấu 3D</b> vào bối cảnh này. Mọi node quay ở đây tự nhận đúng vị trí, kể cả node thêm sau, nhập lại CSV hay sửa tay. Cỡ cảnh, góc máy và ai ở giữa khung: tool tự tính theo từng node.</p>`) +
      (k
        ? `<p class="field-hint">✓ Đã ghim <b>${k} người</b> · dùng cho <b>${users.length} node</b>${users.length > framed.length ? `: ${framed.length} theo vị trí, ${users.length - framed.length} cận đồ vật (không cần)` : ''}.` +
          (framed.length
            ? waiting
              ? ` ⏳ ${waiting} node chưa có ảnh chụp 3D — tool đang tự chụp.`
              : ` Ảnh chụp 3D: ${framed.length - full}/${framed.length} node đã có.`
            : '') +
          (full ? ` ${full} node đủ 10 ảnh tham chiếu — chỉ gửi câu vị trí.` : '') +
          (redo ? ` ⚠ ${redo} node đã có ảnh cần tạo lại.` : '') +
          `</p>` +
          (st.capture
            ? `<img class="s3d-set" src="${esc(st.capture.url)}" alt="Ảnh toàn cảnh 3D">`
            : '')
        : from
          ? `<p class="field-hint">📌 Vị trí lấy từ node sân khấu 3D <b>${esc(from.name)}</b> nối vào đây.</p>`
          : `<p class="field-hint">Chưa ghim.</p>`) +
      `<div class="actions"><button type="button" class="button primary" id="openStage3d">${k ? '🧍 Sửa vị trí (mở 3D)' : '📌 Ghim vị trí (mở 3D)'}</button></div></section>` +
      // (a 3D stage node has no picture to render angles from)
      (n.stageOnly
        ? ''
        : `<section class="inspector-section"><h3>◧ Góc máy</h3>` +
          `<p class="field-hint">Node này là <b>cảnh toàn</b>. Mỗi góc khác (cận bàn, cầu thang, hai góc cận đối nghịch cho đối thoại) là một node góc máy render từ ảnh của node này, xếp ngay dưới. Tạo ảnh cảnh toàn trước, rồi tạo ảnh các góc (khu ③ chạy hai lượt).</p>` +
          anglesBlock() +
          `</section>`)
    );
  }
  if (n.role === 'character' || n.zone === 'character') {
    const outs = store.state.edges.filter(e => e.source === n.id).map(e => byId(e.target));
    const ws = store.state.nodes.filter(
      x => isWardrobeNode(x) && (x.charId === n.id || (!x.charId && outs.includes(x))),
    );
    const looks = outs.filter(x => x?.role === 'look');
    const item = w =>
      `<li><button type="button" class="link" data-open="${w.id}">${esc(w.name)}</button> · ${w.image ? 'đã có ảnh' : 'chưa có ảnh'}</li>`;
    return (
      `<section class="inspector-section"><h3>👗 Trang phục & vật dụng</h3>` +
      `<p class="field-hint">Mỗi bộ trang phục (theo bối cảnh) là một node riêng, lấy ảnh nhân vật này làm tham chiếu. Chuỗi: nhân vật → trang phục (bộ đồ) → <b>nhân vật đã mặc</b> (ghép mặt + đồ, xếp ngay dưới nhân vật này) → shot.</p>` +
      (ws.length
        ? '<ul class="wardrobe-list">' + ws.map(item).join('') + '</ul>'
        : '<p class="field-hint">Chưa có bộ nào.</p>') +
      (looks.length
        ? `<p class="field-hint">👤 Nhân vật đã mặc:</p><ul class="wardrobe-list">${looks.map(item).join('')}</ul>`
        : '') +
      `<button type="button" class="button" id="addWardrobeFor">＋ Thêm trang phục cho nhân vật này</button></section>`
    );
  }
  return '';
}
