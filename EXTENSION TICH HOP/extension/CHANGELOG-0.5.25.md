# 0.5.25 — lấy ảnh hoàn tất ngay cả khi API ChatGPT bị giới hạn tốc độ

## Nguyên nhân xác nhận từ phiên live

Job đang ở `ChatGPT giới hạn tốc độ, tạm ngừng hỏi · 272s`. API conversation trả HTTP 429 nên extension tạm dừng hỏi API theo từng khoảng 30 giây. 0.5.24 chỉ bật đường DOM sau ba lỗi API, khiến ảnh đã hoàn tất trên trang vẫn chưa được lấy ngay.

## Sửa

- Bật đường DOM an toàn ngay từ lỗi API đầu tiên hoặc trong thời gian backoff 429.
- Vẫn chỉ nhận marker ảnh tạo chính thức của assistant.
- Vẫn yêu cầu không còn phần trăm/progress, không streaming và ảnh đã tải hoàn chỉnh.
- Rút thời gian ổn định DOM xuống một chu kỳ 1,5 giây.
- API vẫn là đường chính khi không bị lỗi hoặc giới hạn tốc độ.

## Kiểm thử

Có kiểm thử API trả 429 trong khi DOM có ảnh tạo hoàn tất; extension phải lấy ảnh sau đúng một chu kỳ 1,5 giây và không chờ hết backoff 30 giây.
