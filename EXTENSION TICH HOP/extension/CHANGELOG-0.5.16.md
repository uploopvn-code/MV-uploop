# 0.5.16 — lấy trực tiếp dữ liệu MediaSource, loại bỏ trạng thái treo

## Nguyên nhân còn lại

Video Muse trong giao diện là URL `blob:` được tạo từ `MediaSource`. Bản 0.5.15 có thể phải thu lại player bằng `MediaRecorder`. Ở tab nền, trình phát hoặc sự kiện `MediaRecorder.stop` có thể bị trì hoãn, làm bước tải trông như bị treo.

## Sửa

- Cài bộ theo dõi `MediaSource` ngay từ `document_start`.
- Lưu các segment Muse đưa vào `SourceBuffer` của đúng job đang chạy.
- Khi video đã buffer đủ hoặc MediaSource kết thúc, ghép các segment thành MP4/WebM và gửi thẳng về Drama Tool, không cần phát lại theo thời gian thực.
- Vẫn ưu tiên URL video thật nếu Muse cung cấp trong fetch/XHR.
- Chỉ dùng `captureStream` + `MediaRecorder` khi không thu được segment hợp lệ.
- Bước bắt đầu player có hạn 8 giây; bước kết thúc recorder có hạn bằng thời lượng clip cộng 10 giây. Timer được hủy ngay khi xong, nên không còn promise chờ vô hạn.
- Giới hạn dữ liệu MediaSource 200 MB và giữ nguyên quy tắc chỉ đóng tab sau khi Drama Tool lưu thành công.

## Cập nhật

Tải lại extension tại `chrome://extensions` hoặc `edge://extensions`, kiểm tra popup hiện `v0.5.16`, rồi chạy một job mới. Extension cần được tải lại trước khi mở tab job mới để bộ theo dõi MediaSource được cài từ đầu trang.

## Kiểm chứng

Có kiểm thử riêng cho MediaSource: tạo blob, append segment MP4, đánh dấu buffer hoàn tất, đọc lại đúng dữ liệu mà không phát player. Toàn bộ bộ kiểm thử Muse cũng bao gồm gửi prompt, video xuất hiện muộn, blob fallback, tải trực tiếp, lưu kết quả và giữ tab khi lỗi.

Chưa kiểm thử trực tiếp trên phiên Muse đăng nhập của người dùng.
