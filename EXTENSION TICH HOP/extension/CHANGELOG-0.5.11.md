# Bản 0.5.11 — sửa luồng Muse Chat

- Tạo chat mới bằng nút New side chat, chờ ô nhập sẵn sàng và kiểm tra tin nhắn trong vùng chat; bỏ cách đếm mọi khối chữ theo tọa độ.
- Nhận input file bị ẩn; không bấm nhầm nút tạo chat khi tìm nút đính kèm.
- Dừng và báo lỗi nếu tải ảnh thất bại hoặc không xác nhận được ảnh đính kèm. Không âm thầm bỏ ảnh, cắt còn 4 ảnh hoặc gửi prompt thiếu ảnh.
- Lấy lại ô nhập sau tải ảnh; chờ nút gửi khả dụng. Đánh dấu thời điểm trước khi bấm gửi và kiểm tra ô nhập đã trống cùng nội dung tin nhắn.
- Không tự gửi lại khi chưa rõ lần gửi trước thành công hay chưa.
- Giữ tab khi lỗi để kiểm tra; chỉ đóng sau khi video đã được lưu thành công.
- Cho phép nhận video trong vùng Side chat; giới hạn thời gian chờ cả khi trang điều hướng lỗi liên tục.

## Cài bản cập nhật

1. Mở chrome://extensions (hoặc edge://extensions).
2. Bấm tải lại extension đã nạp từ thư mục này. Kiểm tra popup hiển thị v0.5.11.
3. Đăng nhập Muse trên cùng trình duyệt, bật worker Muse Chat và chạy một job có ảnh tham chiếu.
4. Nếu lỗi, giữ tab đó và xem thông báo cụ thể trong popup để đối chiếu giao diện.

## Kiểm tra

`node --test tests/musechat.test.cjs`: 5 ca mô phỏng qua (file input ẩn, không có preview ảnh, gửi không thành công, nhận diện chat mới, giữ tab khi tải ảnh lỗi).
JavaScript đã kiểm tra cú pháp. Chưa kiểm thử tạo video thực tế trên phiên Muse đăng nhập; giao diện và selector cần được xác nhận trên phiên sử dụng thật.
