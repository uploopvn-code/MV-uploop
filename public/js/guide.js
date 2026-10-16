// Hướng dẫn sử dụng: hiện tự động lần đầu mở tool trên máy này, và mở lại bất cứ lúc nào bằng
// nút "？ Hướng dẫn" trên thanh tiêu đề. Chỉ là lớp phủ giải thích quy trình — không đụng gì
// vào project, nên bấm nhầm cũng không mất dữ liệu.
//
// Mỗi bước KHOANH VÙNG đúng các cột nó đang nói tới: cuộn cột đó vào tầm nhìn, khoét một ô
// sáng trên lớp phủ tối, và đặt thẻ hướng dẫn ngay cạnh ô đó với một mũi tên chỉ vào.
import { $ } from './core.js';
import { panIntoView } from './canvas.js';
import { ZONES } from './zones.js';

const SEEN_KEY = 'mv-guide-seen-v1';
// Chừa quanh ô sáng và giữa thẻ với mép màn hình.
const GAP = 18;
const EDGE = 16;
// Thẻ hẹp lại khi đứng cạnh ô sáng (phải vừa chỗ trống bên cạnh), rộng khi đứng giữa.
const CARD_SIDE = 420;
const CARD_MIN = 300;

// Các bước bám đúng thứ tự các cột trên canvas, nên đọc xong là biết đi từ đâu tới đâu.
// `zones` là id cột trong ZONES — chính các cột được khoanh sáng ở bước đó.
const STEPS = [
  {
    t: '⓪ START — bắt đầu ở đây',
    zones: ['start'],
    b: `Mọi project bắt đầu ở cột <b>START</b>, nơi có hai node mở đầu:
    <ul>
      <li><b>✍ Kịch bản (SCRIPT)</b> — nhập ý tưởng, xưởng viết truyện → bảng shot → blueprint JSON, tự kiểm rồi dựng ra cả graph.</li>
      <li><b>🎼 Nhạc (MUSIC)</b> — dán link hoặc tải file nhạc, tool phân tích cấu trúc bài theo giây.</li>
    </ul>
    Làm MV thì <b>nối node Nhạc sang node Kịch bản</b>: xưởng sẽ phân cảnh bám đúng mốc giây và lời bài hát.`,
  },
  {
    t: '① → ③ Chuẩn bị tài sản',
    zones: ['character', 'wardrobe', 'design'],
    b: `Ba cột tiếp theo là những thứ dùng lại suốt phim:
    <ul>
      <li><b>① Nhân vật</b> — mỗi người một model sheet (một chân dung lớn + 3 góc xoay). Nhớ điền <b>② Nhận dạng</b> và <b>🎙 DNA giọng nói</b> trong Inspector để mặt và giọng không đổi giữa các clip.</li>
      <li><b>② Trang phục & vật dụng</b> — bộ đồ và đạo cụ.</li>
      <li><b>③ Bối cảnh</b> — mỗi địa điểm một ảnh, có thể tách thành các góc máy.</li>
    </ul>`,
  },
  {
    t: '④ ⑤ Máy quay, phong cách, âm thanh',
    zones: ['setup', 'audio'],
    b: `<b>④ Máy quay & Phong cách</b> và <b>⑤ Âm thanh</b> là các node cài đặt. Nối chúng vào shot nào thì
    shot đó nhận cú máy, màu phim và tiếng hiện trường tương ứng. Một node nối được cho nhiều shot.`,
  },
  {
    t: '⑥ ⑦ Dựng hình',
    zones: ['production', 'merged'],
    b: `<b>⑥ Sản xuất</b> là từng shot: nối nhân vật + bối cảnh + cài đặt vào, tạo ảnh khung rồi quay video.
    <br><br><b>⑦ Phân cảnh ghép</b> dành cho đối thoại: 2–6 nhịp cắt trong MỘT clip 8 giây, dùng lại tối đa 3 ảnh cỡ cảnh
    (qua vai A / qua vai B / trung đôi) — đối đáp nhanh mà chỉ tốn 3 ảnh.`,
  },
  {
    t: '⑧ → ⑫ Kết quả',
    zones: ['output', 'seedance', 'seedance-video', 'lipsync', 'lipsync-video'],
    b: `Video render xong tự thành node riêng ở các cột kết quả: <b>⑧ Video</b> (từ shot), <b>⑩ Video nhóm</b>
    (từ nhóm Seedance) và <b>⑫ Video hát nhép</b> (từ take lip-sync). Mở <b>Timeline</b> để xem và dựng bản cuối.`,
  },
  {
    t: 'Vài điều nên biết trước',
    b: `<ul>
      <li><b>Khuôn hình</b> đặt một lần ở <b>Cài đặt project</b> — áp cho mọi ảnh và video. Đổi giữa chừng sẽ đánh dấu media cũ cần làm lại.</li>
      <li>Node viền vàng = <b>đầu vào đã đổi</b>, nên tạo lại trước khi quay.</li>
      <li>Trong lúc hàng đợi đang chạy, việc sửa bị khoá — bấm <b>Dừng</b> nếu cần sửa gấp.</li>
      <li>Mở lại hướng dẫn này bất cứ lúc nào bằng nút <b>？ Hướng dẫn</b> trên thanh tiêu đề.</li>
    </ul>`,
  },
];

let at = 0;

// --- Khoanh vùng -------------------------------------------------------------------------
// Các dải cột nằm trong #graphCanvas, mà canvas có transform (pan + zoom), nên luôn đo bằng
// getBoundingClientRect() thay vì tự tính theo ZONE_W — đo thế là đã gồm cả pan lẫn zoom.
const bandsOf = ids => {
  const bands = [...document.querySelectorAll('#graphCanvas .zone-band')];
  return ids
    .map(id => bands[ZONES.findIndex(z => z.id === id)])
    .filter(Boolean)
    .map(el => el.getBoundingClientRect());
};

// Dời canvas ngang để dải cột của bước này lọt vào tầm nhìn.
function revealZones(ids) {
  const rects = bandsOf(ids);
  if (!rects.length) return;
  panIntoView(Math.min(...rects.map(r => r.left)), Math.max(...rects.map(r => r.right)), EDGE);
}

// Ô sáng = hợp của các dải cột, cắt theo khung nhìn của canvas (dải cao bằng cả canvas, để
// nguyên thì ô sáng tràn ra ngoài màn hình).
function spotRect(ids) {
  const scroll = document.querySelector('.graph-scroll');
  const rects = bandsOf(ids);
  if (!scroll || !rects.length) return null;
  const view = scroll.getBoundingClientRect();
  const left = Math.max(view.left, Math.min(...rects.map(r => r.left)));
  const right = Math.min(view.right, Math.max(...rects.map(r => r.right)));
  const top = Math.max(view.top, Math.min(...rects.map(r => r.top)));
  const bottom = Math.min(view.bottom, Math.max(...rects.map(r => r.bottom)));
  if (right - left < 40 || bottom - top < 40) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// Đặt thẻ cạnh ô sáng, phía nào còn nhiều chỗ hơn; không bên nào đủ thì xuống dưới (hoặc lên
// trên). Trả về hướng mũi tên để vẽ cho khớp.
function placeCard(card, spot) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const roomRight = W - spot.right - GAP - EDGE;
  const roomLeft = spot.left - GAP - EDGE;
  const side = roomRight >= roomLeft ? 'right' : 'left';
  const room = Math.max(roomRight, roomLeft);
  if (room >= CARD_MIN) {
    const w = Math.min(CARD_SIDE, room);
    card.style.width = w + 'px';
    card.style.left = (side === 'right' ? spot.right + GAP : spot.left - GAP - w) + 'px';
    const h = card.offsetHeight;
    const mid = spot.top + spot.height / 2 - h / 2;
    card.style.top = Math.max(EDGE, Math.min(mid, H - h - EDGE)) + 'px';
    // Mũi tên mọc ra từ cạnh thẻ quay về phía ô sáng.
    return side === 'right' ? 'left' : 'right';
  }
  // Hẹp cả hai bên: nằm dưới ô sáng nếu còn chỗ, không thì nằm trên.
  const w = Math.min(CARD_SIDE + 100, W - 2 * EDGE);
  card.style.width = w + 'px';
  card.style.left = Math.max(EDGE, Math.min(spot.left, W - w - EDGE)) + 'px';
  const h = card.offsetHeight;
  if (spot.bottom + GAP + h + EDGE <= H) {
    card.style.top = spot.bottom + GAP + 'px';
    return 'up';
  }
  if (spot.top - GAP - h >= EDGE) {
    card.style.top = spot.top - GAP - h + 'px';
    return 'down';
  }
  // Ô sáng chiếm gần hết màn hình (bước ⑧ → ⑫): không còn chỗ nào đứng ngoài nó. Đặt thẻ vào
  // giữa và bỏ mũi tên — lúc này chính ô sáng đã là thứ chỉ chỗ, mũi tên chỉ vào vùng ngay
  // dưới thẻ thì vô nghĩa.
  card.style.left = Math.max(EDGE, (W - w) / 2) + 'px';
  card.style.top = Math.max(EDGE, (H - h) / 2) + 'px';
  return '';
}

// Vẽ ô sáng + mũi tên cho bước hiện tại. Bước không gắn cột nào thì thẻ về giữa màn hình.
// Cờ `placing` chặn vòng lặp: revealZones dời canvas → 'graphviewchange' → place() lần nữa.
let placing = false;
function place() {
  if (placing) return;
  placing = true;
  try {
    draw();
  } finally {
    placing = false;
  }
}
function draw() {
  const overlay = $('#guideOverlay');
  const card = overlay?.querySelector('.guide-card');
  const hole = $('#guideSpot');
  const arrow = $('#guideArrow');
  if (!overlay || !card) return;
  const ids = STEPS[at].zones;
  if (ids) revealZones(ids);
  const spot = ids ? spotRect(ids) : null;
  if (!spot) {
    overlay.classList.remove('spot');
    card.removeAttribute('style');
    hole.hidden = true;
    arrow.hidden = true;
    return;
  }
  overlay.classList.add('spot');
  hole.hidden = false;
  Object.assign(hole.style, {
    left: spot.left + 'px',
    top: spot.top + 'px',
    width: spot.width + 'px',
    height: spot.height + 'px',
  });
  const dir = placeCard(card, spot);
  arrow.hidden = !dir;
  if (!dir) return;
  arrow.className = 'guide-arrow ' + dir;
  const box = card.getBoundingClientRect();
  if (dir === 'left' || dir === 'right') {
    const y = Math.max(box.top + 18, Math.min(spot.top + spot.height / 2, box.bottom - 18));
    arrow.style.top = y + 'px';
    arrow.style.left = (dir === 'left' ? box.left - 10 : box.right) + 'px';
  } else {
    const x = Math.max(box.left + 18, Math.min(spot.left + spot.width / 2, box.right - 18));
    arrow.style.left = x + 'px';
    arrow.style.top = (dir === 'up' ? box.top - 10 : box.bottom) + 'px';
  }
}

function paint() {
  const box = $('#guideBody');
  if (!box) return;
  const s = STEPS[at];
  box.innerHTML = `<h3>${s.t}</h3><div class="guide-text">${s.b}</div>`;
  $('#guideStep').textContent = `${at + 1} / ${STEPS.length}`;
  $('#guidePrev').disabled = at === 0;
  $('#guideNext').textContent = at === STEPS.length - 1 ? 'Xong' : 'Tiếp →';
  for (const [i, d] of [...document.querySelectorAll('#guideDots span')].entries())
    d.className = i === at ? 'on' : '';
  // Đo ngay, không qua requestAnimationFrame: rAF không chạy khi cửa sổ đang ở nền, và lúc đó
  // hướng dẫn sẽ mở ra mà không khoanh vùng gì. Đọc offsetHeight đã buộc trình duyệt tính
  // layout nên số đo vẫn đúng.
  place();
}

// Khung nhìn canvas đổi (fit-to-screen, zoom, dời) hoặc cửa sổ đổi cỡ → đo lại ô sáng.
const onViewChange = () => {
  if ($('#guideOverlay')) place();
};

export function closeGuide() {
  const el = $('#guideOverlay');
  if (el) el.remove();
  window.removeEventListener('resize', onViewChange);
  document.removeEventListener('graphviewchange', onViewChange);
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {}
}

export function openGuide(step = 0) {
  if ($('#guideOverlay')) return;
  at = Math.min(Math.max(step, 0), STEPS.length - 1);
  const el = document.createElement('div');
  el.id = 'guideOverlay';
  el.className = 'guide-overlay';
  el.innerHTML =
    '<div class="guide-spot" id="guideSpot" hidden></div>' +
    '<div class="guide-arrow" id="guideArrow" hidden></div>' +
    '<div class="guide-card" role="dialog" aria-modal="true" aria-labelledby="guideTitle">' +
    '<div class="guide-head"><b id="guideTitle">Hướng dẫn sử dụng</b>' +
    '<button class="button" id="guideClose" aria-label="Đóng hướng dẫn">×</button></div>' +
    '<div id="guideBody" class="guide-body"></div>' +
    '<div class="guide-foot"><span id="guideDots">' +
    STEPS.map(() => '<span></span>').join('') +
    '</span><span class="field-hint" id="guideStep"></span>' +
    '<button class="button" id="guidePrev">← Trước</button>' +
    '<button class="button primary" id="guideNext">Tiếp →</button></div></div>';
  document.body.appendChild(el);
  paint();
  window.addEventListener('resize', onViewChange);
  document.addEventListener('graphviewchange', onViewChange);
  $('#guideClose').onclick = closeGuide;
  $('#guidePrev').onclick = () => {
    if (at > 0) (at--, paint());
  };
  $('#guideNext').onclick = () => {
    if (at < STEPS.length - 1) (at++, paint());
    else closeGuide();
  };
  // Bấm ra ngoài thẻ hoặc Esc thì đóng — không khoá người dùng lại.
  el.onclick = e => {
    if (e.target === el || e.target === $('#guideSpot')) closeGuide();
  };
  const key = e => {
    if (e.key === 'Escape') (closeGuide(), document.removeEventListener('keydown', key));
    if (e.key === 'ArrowRight') $('#guideNext')?.click();
    if (e.key === 'ArrowLeft') $('#guidePrev')?.click();
  };
  document.addEventListener('keydown', key);
}

// Lần đầu mở tool trên máy này thì hiện luôn; sau đó chỉ mở khi bấm nút.
export function initGuide() {
  if ($('#openGuide')) $('#openGuide').onclick = () => openGuide();
  let seen = '1';
  try {
    seen = localStorage.getItem(SEEN_KEY);
  } catch {}
  if (!seen) setTimeout(() => openGuide(), 600);
}
