# Quy trình tự chạy (recipe) — kịch bản → ảnh → video → zip, tự học

Ngày: 2026-10-13. Yêu cầu: nhắn trợ lý "chạy toàn bộ từng bước để ra sản phẩm cuối cùng" thì tool
tự chạy kịch bản, dừng hỏi, chạy ảnh, video, đóng gói; **lần sau không cần gọi agent** — tool tự
hiểu cần chạy gì.

## Trước đây

Trợ lý chỉ có thao tác rời (tạo/sửa node, nối dây, ảnh một khu, video một khu, sửa một trạm),
tối đa 5 thao tác, và ảnh/video phải là thao tác cuối. Không có "chạy xưởng", "dựng graph", hay
"đợi bước này xong rồi làm bước sau" — nên kể cả gọi Claude cũng không lập được "chạy toàn bộ".

## Bây giờ

**Quy trình** = danh sách bước trừu tượng (theo khu, không theo ID node → dùng được ở mọi
project), chạy bằng máy trên server:

| Bước | Làm gì |
|---|---|
| `script` (fast/full) | chạy xưởng kịch bản + tự dựng graph; kịch bản đã xong thì dùng lại, không chạy lại |
| `confirm` | ⏸ dừng hỏi trong ô Quy trình của Trợ lý (Tiếp tục / Dừng) |
| `images` (khu…) | tạo ảnh từng khu như nút ⚡ khu, đợi xong |
| `videos` (khu…, provider) | tạo video từng khu như nút ▶ khu, đợi xong |
| `package` | gói giao hàng (video theo số cảnh + 7 bước kịch bản) ghi ra đĩa cạnh project |

**Quy trình dựng sẵn** "Toàn bộ: kịch bản → ảnh → video → zip" — điểm dừng theo yêu cầu:
1. sau khi dựng graph
2. sau khi tạo ảnh nhân vật, trang phục, bối cảnh
3. sau khi tạo video (ảnh khung shot + video phủ cảnh, phân cảnh ghép, hát nhép)
rồi đóng gói zip.

**Ba cách chạy, đều 0 token cho phần điều khiển:**
- nhắn trợ lý câu kích hoạt ("chạy toàn bộ", "chạy hết", "ra sản phẩm cuối cùng"…; thêm "không
  hỏi" / "chạy thẳng" để chạy xuyên qua mọi điểm dừng);
- bấm ▶ Chạy (có dừng hỏi) / ▶ Chạy hết trong ô **Quy trình** của Trợ lý;
- câu lạ → Claude lập quy trình (`run_recipe` với các bước + 3–5 câu kích hoạt) — **lần duy nhất
  tốn token**; chạy xong trót lọt tool **nhớ** quy trình đó (`recipes.json`, chung mọi project),
  lần sau câu khớp → chạy thẳng không gọi Claude.

Phần *viết* trong xưởng kịch bản vẫn tốn token như cũ — đó là nội dung, không phải điều khiển.

## An toàn (bài học từ xưởng kịch bản, áp từ đầu)

- Mỗi lượt có mã riêng; Dừng kiểm GIỮA các bước; Dừng = dừng cả batch ảnh/video/xưởng nó khởi động.
- Một quy trình một lúc; batch sau đợi hàng đợi rảnh.
- App khởi động lại giữa bước → quy trình "chờ chạy lại bước này", bấm Tiếp tục là làm lại đúng bước đó.
- Bước lỗi (vd không tạo được ảnh nào) → dừng, báo lỗi, Tiếp tục = chạy lại bước đó.

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/recipe-def.mjs` | **Mới** — từ vựng bước, `normalizeSteps`, `stepLabel`, quy trình dựng sẵn, `matchRecipe` (khớp câu không dấu) |
| `lib/recipes.mjs` | **Mới** — thư viện (`recipes.json`), bộ chạy (start/continue/stop, đợi batch, ghi zip, học) |
| `lib/routes/recipes.mjs` | **Mới** — `/api/recipes`, `/start`, `/continue`, `/stop`, `/save`, `/delete` |
| `lib/routes/script.mjs` | tách `startStudioRun(n, b)` khỏi route (quy trình gọi trực tiếp); export `buildFromStudio` |
| `lib/projects.mjs` | `recipeTasks`; lượt mồ côi sau khởi động lại → paused + redo |
| `lib/assistant-plan.mjs` | thao tác `run_recipe` + hướng dẫn cho Claude |
| `lib/assistant-router.mjs`, `lib/routes/assistant.mjs` | câu khớp quy trình → kế hoạch nhanh 0 token |
| `public/index.html`, `public/js/commands.js` | ô **Quy trình** (tiến trình từng bước, Tiếp tục/Dừng/Tải zip, danh sách + nút chạy) |
| `test-recipes.mjs` | **Mới** (trong `npm test`) — đủ chuỗi thật với worker giả, 3 điểm dừng, zip, dùng lại kịch bản (0 lượt LLM), học + khớp lại 0 token, dừng, khởi động lại giữa bước |
| `test-claude-cli.mjs` | Claude thật lập `run_recipe` cho câu tuỳ biến (ngoài `npm test`) |
