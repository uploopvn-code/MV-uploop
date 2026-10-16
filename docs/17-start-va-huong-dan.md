# Cột ⓪ START và hệ thống hướng dẫn

## Cột ⓪ START

Hai node mở đầu một dự án đứng chung cột đầu tiên:

- **✍ Kịch bản (SCRIPT)** — ý tưởng → truyện → blueprint → dựng graph.
- **🎼 Nhạc (MUSIC)** — link/file nhạc + phân tích cấu trúc bài.

Nối Nhạc → Kịch bản thì xưởng phân cảnh bám mốc giây của bài (xem `docs/14`).

### Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/zones.mjs` | Zone `'script'` đổi id thành `'start'`; `defaultZone` cho **cả** `kind==='script'` và `kind==='music'` |
| `lib/projects.mjs` | `normalize()` migrate dự án cũ: node nhạc ở `zone:'audio'` và node cũ ở `zone:'script'` → `'start'` |
| `lib/routes/nodes.mjs` | Tạo node script/music đều vào `zone:'start'` |
| `public/js/zones.js` | Nhãn cột `⓪ START · Kịch bản & Nhạc`, `labelKey: 'zone.start'` |
| `public/locales/*.json` | **Thêm key `zone.start` cho cả 5 ngôn ngữ** |
| `public/js/canvas.js` | `LAYOUT_KEY` → `mv-canvas-v4` (node đổi cột ⇒ vị trí đã lưu lệch) |

> ⚠ **Bẫy i18n:** `t = key => messages[key] || key` — thiếu key thì canvas hiện **nguyên chuỗi khoá**
> (`"zone.script"`). Thêm cột mới là phải thêm key vào **cả 5** file locale, nếu không `test-i18n`
> vẫn xanh (nó chỉ so khớp key giữa các ngôn ngữ) mà giao diện lại hiện chữ thô.

> ⚠ Đổi cột của một node thì phải **bump `LAYOUT_KEY`** và sửa khoá đó trong `test-canvas.mjs` (3 chỗ).

## Hệ thống hướng dẫn

`public/js/guide.js` — lớp phủ 6 bước, bám đúng thứ tự các cột: ⓪ START → ①–③ tài sản →
④⑤ máy quay/phong cách/âm thanh → ⑥⑦ dựng hình → ⑧–⑫ kết quả → vài điều nên biết.

- **Tự hiện lần đầu** mở tool trên máy đó; sau khi đóng thì nhớ bằng `localStorage['mv-guide-seen-v1']`.
- Mở lại bất cứ lúc nào bằng nút **？ Hướng dẫn** trên thanh tiêu đề.
- Điều hướng: nút Trước/Tiếp, phím ←/→, Esc hoặc bấm ra ngoài để đóng.
- Thuần giao diện, không gọi API và không đụng dữ liệu project.

Sửa nội dung: mảng `STEPS` trong `public/js/guide.js`. Đổi nội dung đáng kể thì tăng `SEEN_KEY`
(`mv-guide-seen-v2`) để người đã xem bản cũ thấy lại bản mới.

### Khoanh vùng trên canvas

Mỗi bước gắn `zones: [...]` (id cột trong `ZONES`). Khi tới bước đó, hướng dẫn:

1. **Dời canvas** để các cột ấy lọt vào tầm nhìn — `panIntoView()` trong `canvas.js`.
2. **Khoét một ô sáng** đúng các cột đó: `#guideSpot` đổ `box-shadow 0 0 0 9999px` ra ngoài, nên
   vùng bên trong nhìn rõ nguyên trạng còn xung quanh thì tối đi.
3. **Đặt thẻ** cạnh ô sáng ở phía còn nhiều chỗ hơn, kèm **mũi tên** chỉ vào.

| File | Thay đổi |
|---|---|
| `public/js/guide.js` | `STEPS[].zones`, `revealZones` / `spotRect` / `placeCard`, nghe `resize` + `graphviewchange` |
| `public/js/canvas.js` | `panIntoView(left, right)` (export mới); `applyGraphView()` đặt `--graph-z` và bắn `graphviewchange` |
| `public/style.css` | `.guide-overlay.spot`, `.guide-spot`, `.guide-arrow`; `.zone-label` to hơn + chống-scale |
| `public/locales/*.json` | `zone.lipsyncVideo` sửa ⑪ → ⑫ (sai số ở cả 5 ngôn ngữ) |
| `test-canvas.mjs` | Stub thêm `style.setProperty`, `document.dispatchEvent`, `CustomEvent` |

Bốn cái bẫy đã trả giá để biết — đừng lặp lại:

> ⚠ **Canvas dời bằng CSS `transform`, không phải scroll.** Chỉnh `.graph-scroll.scrollLeft` là
> vô tác dụng; phải dịch `graphView.x` (translate đứng trước scale nên 1 đơn vị = 1 pixel màn hình).

> ⚠ **Đừng đo trong `requestAnimationFrame`.** rAF *không chạy* khi cửa sổ ở nền — hướng dẫn sẽ
> mở ra mà không khoanh được gì. Đọc `offsetHeight` đã buộc tính layout nên đo đồng bộ là đủ.

> ⚠ **`fitCanvas` chạy SAU khi hướng dẫn mở** (nó cũng nằm trong rAF), nên ô sáng phải đo lại khi
> khung nhìn đổi → `applyGraphView()` bắn `graphviewchange`, `guide.js` nghe và vẽ lại. Có cờ
> `placing` chặn vòng lặp (dời canvas → sự kiện → vẽ lại → dời canvas…).

> ⚠ **Không `transition` vị trí/kích thước cho `.guide-spot`.** Nó kẹt giữa chừng: inline style
> đúng mà `getBoundingClientRect()` vẫn trả về ô của bước trước.

### Tên cột đọc được ở mọi mức zoom

`.zone-label` lên **14–15px** và **chống lại scale của canvas**: `applyGraphView()` ghi
`--graph-z`, CSS nhân ngược `transform: scale(calc(1 / var(--graph-z, 1)))`. Không có nó thì ở
chế độ vừa-màn-hình (≈69 %) chữ 15px chỉ còn ~10px và không đọc nổi — đúng chỗ người dùng kêu.
