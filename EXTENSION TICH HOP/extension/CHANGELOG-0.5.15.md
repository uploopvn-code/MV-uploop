# 0.5.15 — tải video blob của Muse

## Nguyên nhân

Muse hiển thị video kết quả bằng thẻ `<video>` có `src="blob:https://muse.ai/..."`. Blob này có thể là `MediaSource`, không phải file Blob thông thường, nên `fetch(blobUrl)` không trả về MP4/WebM và worker tiếp tục chờ dù video đã phát được.

## Sửa

- Phát hiện ngay thẻ video mới trong vùng chat, gồm đúng dạng `video.h-full.w-full.bg-transparent.object-cover` được thấy trên giao diện Muse.
- Theo dõi phản hồi `fetch` và XHR có nội dung video để giữ URL media thật trước khi Muse đổi nó thành URL blob.
- Nếu URL media thật có thể tải được, tải và kiểm tra MP4/WebM như trước.
- Nếu chỉ có MediaSource blob, tìm đúng thẻ video mang URL đó, chờ metadata và track video sẵn sàng, sau đó thu đúng một vòng phát bằng `captureStream` + `MediaRecorder` thành WebM.
- Dừng track thu, khôi phục trạng thái player và gửi file về Drama Tool. Tab chỉ đóng sau khi Drama Tool xác nhận đã lưu.
- Blob được thử trực tiếp tối đa 5 giây trước khi chuyển sang thu từ player; không tiếp tục chờ vô ích 45 giây.

## Cập nhật

Tải lại extension tại `chrome://extensions` hoặc `edge://extensions`, kiểm tra popup hiện `v0.5.15`, rồi chạy một job mới.

## Kiểm chứng

31 kiểm thử qua, gồm ca MediaSource blob không thể `fetch`, chọn đúng player Muse, thu WebM, và toàn bộ luồng gửi → chờ video → lấy video → lưu vào Drama Tool → đóng tab.

Chưa chạy trực tiếp trên phiên Muse đăng nhập của người dùng. Trong phương án blob fallback, video được thu lại theo thời gian thực nên clip 10 giây cần khoảng 10–12 giây để tạo file WebM sau khi xuất hiện.
