# Topview 3D — Ảnh tham chiếu & Video preview 3D

Tích hợp **topview-3d-builder** (CLI local) vào Drama Tool để dựng **previz 3D** cho từng cảnh:
một **ảnh layout 3D** (nhân vật có pose, đúng vị trí/hướng/góc máy) và/hoặc một **video preview 3D**
(camera chuyển động). Đây là **tham chiếu bố cục** — danh tính nhân vật vẫn do model ảnh vẽ từ
model-sheet; mannequin 3D chỉ khoá *ai đứng đâu, quay mặt hướng nào, máy đặt góc nào*.

## 1. Cài đặt (đã cài sẵn)

- CLI ở `C:\Users\PC\AppData\Local\topview-3d-cli\venv\Scripts\topview-3d-cli.exe` (đổi bằng biến
  môi trường `TOPVIEW3D_CLI`). Mã nguồn vendored ở `tools/topview-3d-builder/` (đã gitignore).
- Kiểm tra: `topview-3d-cli doctor` phải báo `ready`. Cần `ffmpeg` trên PATH để ghép video.
- Cài lại từ đầu: `powershell -ExecutionPolicy Bypass -File tools\topview-3d-builder\scripts\install.ps1`
  (đã vá sẵn: whitelist build `esbuild/sharp/unrs-resolver` trong `pnpm-workspace.yaml`, và tắt
  autocrlf khi checkout để asset builtin không lệch byte).

## 2. Làm ẢNH tham chiếu 3D

### Cách thủ công (panel Dàn dựng 3D)
1. Chọn **node bối cảnh** (cảnh toàn) → mở **🧍 Dàn dựng 3D**.
2. Kéo đặt từng nhân vật: vị trí (x trái−/phải+, z chiều sâu, phía khán giả là +), hướng mặt; với
   cảnh hội thoại dùng **Trục hội thoại** (A/B) để giữ luật 180°.
3. Bấm **📌 Ghim** để lưu marks.
4. Bấm **🎬 Layout 3D** → tool render ảnh 3D thật cho MỌI shot đã dàn dựng của cảnh, nhét vào đúng
   ô *ảnh layout tham chiếu* (`n.layout`) — job tạo ảnh sẽ đính nó làm ảnh tham chiếu cuối cùng.

### Qua Trợ lý đạo diễn (tự động)
Nói tự nhiên, ví dụ: *"vẽ lại cảnh phòng khách thành 3D"*, *"dựng mô phỏng 3D cho cảnh X"*.
Trợ lý dùng action `stage_3d`:
- **Chưa ghim** → Trợ lý **tự đề xuất marks** (vị trí/hướng nhân vật, trục hội thoại) từ bối cảnh +
  nhân vật; bạn **xem preview rồi duyệt** mới ghim + render.
- **Đã ghim** → dùng luôn marks có sẵn.
- `render: "image"` cho ảnh layout.

## 3. Làm VIDEO animation 3D preview

### Thủ công (panel Dàn dựng 3D)
- Chọn **kiểu chuyển động máy** ở ô select (Orbit, Dolly vào, Đẩy nhẹ, Kéo lùi, Lia trái/phải,
  Cẩu nâng, Mở cảnh).
- **🎥 Video 3D**: render 1 cảnh dàn dựng thành clip camera-move (mp4), gắn vào node.
- **🎞 Video cụm**: render MỌI cảnh đã dàn dựng rồi **ghép thành 1 video duy nhất** (ffmpeg concat).

### Qua Trợ lý
`stage_3d` với `render: "video"` (hoặc `"both"`), `move` = preset camera, `cluster: true` để ghép cụm,
`seconds` độ dài mỗi clip. Trợ lý chọn kiểu máy theo cảnh rồi tự render.

### Preset camera move
| key | Mô tả |
|-----|-------|
| `orbit` | Xoay vòng quanh nhân vật (turntable) |
| `arc_left` / `arc_right` | Lia vòng một bên |
| `dolly_in` | Dolly tiến vào |
| `pull_back` | Kéo lùi mở rộng |
| `push_in` | Đẩy nhẹ vào mặt |
| `crane_up` | Cẩu nâng lên |
| `reveal` | Mở cảnh (lùi + nâng) |

## 4. Ghép cụm cảnh → 1 video
`🎞 Video cụm` (hoặc `cluster:true`) render từng cảnh rồi nối. Dùng khi có một **cụm cảnh** cần xem
liền mạch thành một video preview duy nhất.

## 5. Giới hạn & mẹo
- **Tốc độ**: render từng frame qua Chromium (~1.4 s/frame). Clip 2.5 s @ 12 fps ≈ 30 frame ≈ 40 s.
  Cụm nhiều cảnh sẽ lâu — ưu tiên clip ngắn (1.5–2.5 s).
- **Nhân vật generic**: topview chỉ có 4 mannequin builtin (man/female/child/youth) — tự chọn theo
  giới tính/tuổi; đặt `node.topview3d.libraryId` để ép. Danh tính thật do model ảnh vẽ.
- **Tên tiếng Việt**: CLI được gọi với `PYTHONUTF8=1` nên tên có dấu ("Bé Mai") không làm crash.
- **Chuyển động nhân vật** (motion/pose động): giai đoạn sau — hiện mannequin đứng pose tĩnh, chuyển
  động đến từ camera. (topview có clip `motion` nhưng cần asset motion, chưa tích hợp.)

## 6. Chỗ nối trong mã
- Adapter: `lib/topview3d.mjs` — `renderLayout`, `renderPreview` (+ `CAMERA_MOVES`), `stitchPreviews`.
- Route: `lib/routes/stage3d.mjs` — `POST /api/stage3d/topview` (ảnh), `POST /api/stage3d/topview-video`
  (video, có `cluster`).
- UI: `public/js/stage3d.js` — nút 🎬 Layout 3D, 🎥 Video 3D, 🎞 Video cụm + select camera move.
- Trợ lý: action `stage_3d` khai ở `lib/assistant-plan.mjs` (`ASSISTANT_SYSTEM` + validator), apply ở
  `public/js/commands.js`.
