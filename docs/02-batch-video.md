# 02 · Tạo video theo khu vực

## Cách chạy

1. Chọn khu vực `Sản xuất`, `Phân cảnh ghép` hoặc `Hát nhép`.
2. Chọn nguồn: tất cả, Seedvis, Muse Chat hoặc Google Vids.
3. Chọn **Tổng số phiên bản mục tiêu** (1–8).
4. Bấm **Tạo video khu vực** và xác nhận hộp thoại trước khi gửi job vào queue.

Batch chọn node theo các quy tắc:

- Phải thuộc khu vực video và không phải node terminal/frame.
- Phải có ảnh đầu vào: ảnh riêng của node (`node.image`) hoặc ảnh tham chiếu từ node nối vào. Nếu không có ảnh riêng, batch tự chuyển sang `refs`, kể cả node đang để mặc định `self`.
- Ảnh cũ của node hoặc node tham chiếu cần xác nhận sử dụng. Xác nhận có hiệu lực trong suốt lượt batch và không xóa cờ cần cập nhật ảnh.
- Tool đếm video hiện có của từng node và chỉ tạo phần còn thiếu đến mục tiêu.
- Node đã đủ số phiên bản mục tiêu: bỏ qua. Node có ít hơn mục tiêu: tiếp tục tạo bổ sung.
- Shot thuộc Seedance group: vẫn được chạy độc lập.
- Có thể chạy bằng Command Console với điều kiện `chỉ chạy node có ảnh` hoặc `bỏ qua shot cận mặt`.
- Lệnh có điều kiện gửi bộ lọc xuống backend; không chỉ là preview ở giao diện.

## Mục tiêu v2, v3 và cao hơn

Ô số phiên bản mang nghĩa **tổng số cuối cùng**, không phải số video tạo thêm trong lần bấm:

- Chọn `2`: node đang có v1 chỉ tạo thêm 1 video; node chưa có video tạo 2.
- Chọn `3`: node đang có v1 tạo thêm 2; node đang có v2 tạo thêm 1; node đã có v3 bị bỏ qua.
- Video cũ không bị ghi đè hoặc xóa. Mỗi kết quả là một node video phiên bản độc lập.
- Seedvis có thể tạo toàn bộ phần thiếu trong một job nhiều kết quả.
- Muse Chat, Google Vids và Orbit tạo một file mỗi job. Bộ điều phối giữ node trong lượt chạy và tự xếp job kế tiếp cho đến khi đạt mục tiêu; nhiều node/tài khoản vẫn chạy song song theo giới hạn worker.

Hộp xác nhận trước khi chạy hiển thị mục tiêu, số node đủ điều kiện và tổng số video dự kiến cần bổ sung.

## Lưu ý

Node chưa có ảnh khung riêng vẫn được chạy nếu các đầu vào ảnh nối vào đã có ảnh; các node style/máy quay và sân khấu 3D không cần ảnh. Node không có cả ảnh riêng lẫn ảnh tham chiếu bị bỏ qua. Nếu số tham chiếu vượt giới hạn model Seedvis, batch tạo keyframe trước rồi mới quay. Take lip-sync vẫn cần ảnh khung để ghép với vocal.

Khi không có node phù hợp, thông báo nêu số node bị bỏ qua theo lý do: đã đủ mục tiêu, khác provider, thiếu ảnh, ảnh cũ chưa xác nhận hoặc loại node không quay riêng.

Sau khi cập nhật mã backend, khởi động lại server/tool rồi tải lại trang (`Ctrl+F5`). Chỉ tải lại trình duyệt không nạp lại mã backend đang chạy.
Nếu đang dùng nhiều project/cửa sổ, mỗi project có hàng đợi riêng.

## Command Console

Ví dụ:

```text
tạo video ở sản xuất, bỏ qua shot cận mặt
đổi toàn bộ video Production sang Muse Chat
```

Console luôn hiển thị preview trước khi sửa graph/provider. Các thao tác kết nối graph và đổi provider
được lưu vào Command History để Undo.

## Kiểm thử hồi quy

Chạy `node test-zone-video.mjs`. Test dùng server và project tạm, tái hiện shot ở cột ⑥ có 4 ảnh tham chiếu nhưng không có keyframe. Kiểm tra API batch, payload ảnh tới worker Muse, xác nhận ảnh cũ và một lượt mục tiêu v3 tạo đúng các job v1/v2/v3 mà không ghi đè kết quả cũ. Không gửi render tới dịch vụ trả phí.

## Ghi chú cập nhật 2026-10-09

- Module backend: `lib/auto.mjs`, `lib/routes/auto.mjs` — điều phối theo tổng số phiên bản mục tiêu.
- Module giao diện: `public/index.html`, `public/js/auto.js`, `public/js/commands.js` — bộ chọn 1–8 và xác nhận số video cần bù.
- Module đa ngôn ngữ: `public/locales/*.json` — chuẩn hóa nhãn mục tiêu phiên bản.
