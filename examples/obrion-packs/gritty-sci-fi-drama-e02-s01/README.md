# OBRION Pack mẫu — Sci‑Fi Gritty Realism / Drama ngắn

Pack này là một bộ đầu vào hoàn chỉnh cho một phân đoạn drama ngắn: **E02-S01 · Tấm thẻ Titan**. Dùng nó làm mẫu cấu trúc, sau đó nhân bản thư mục cho phim của bạn.

## Cách dùng trong Đạo diễn → OBRION

1. Dán `01-script.txt` vào **Kịch bản thô**.
2. Nhập `02-asset-bible.json` vào **Asset Bible**.
3. Dán `03-camera-rules.txt` vào **Quy tắc camera**.
4. Dán `04-performance-rules.txt` vào **Quy tắc diễn xuất / FACS**.
5. Dán `05-sound-rules.txt` vào cuối ô **Quy tắc diễn xuất / FACS**. Hiện UI có hai ô rule; Agent_Sound vẫn nhận cùng ngữ cảnh rule, nên file này đặt ở đó là đúng.
6. Đặt tên `E02-S01 · Tấm thẻ Titan`, bấm **Lưu bản nháp**, sau đó bấm **Phân cảnh với OBRION**.
7. Duyệt shot JSON. Khi ổn, bấm **Chuyển sang Blueprint bước 3** rồi duyệt blueprint trước khi dựng sơ đồ.

## Các lớp tái sử dụng

- `03–05`: bộ định dạng **Sci‑Fi gritty drama**. Giữ lại cho mọi tập cùng phong cách.
- `02-asset-bible.json`: phụ lục của bộ phim/tập. Thay nhân vật, bối cảnh, đạo cụ, URL ảnh và LoRA ở đây.
- `01-script.txt`: chỉ dùng cho phân đoạn này.

Với MV, sitcom hay quảng cáo, tạo một thư mục pack mới, thay nhất là quy tắc nhịp dựng, camera, diễn xuất và âm thanh. Không nên dùng nguyên bộ này cho mọi định dạng vì “gu” shot và nhịp của chúng khác nhau.

## Kết quả mong đợi

Kịch bản dài khoảng 30 giây, một không gian, hai nhân vật, có đối thoại và vật chứng. Đây là kích thước phù hợp để kiểm tra continuity, FACS, âm thanh và chuyển Blueprint mà chưa chạm giới hạn node. OBRION sẽ tự quyết định số shot; không coi đây là shot list cố định.
