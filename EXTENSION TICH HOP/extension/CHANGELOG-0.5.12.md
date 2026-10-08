# 0.5.12 — nhập prompt sau tải ảnh

- Điền prompt ngay sau khi đưa file vào ô tải ảnh, không chặn việc nhập vì chưa nhận diện được preview ảnh.
- Vẫn chờ xác nhận ảnh trước khi bấm gửi; không gửi thiếu ảnh.
- Lấy lại ô soạn thảo và điền lại nếu giao diện thay ô nhập hoặc xóa nội dung trong lúc tải ảnh.
- Hỗ trợ contenteditable rỗng/plaintext-only và cách nhập dự phòng khi execCommand không hoạt động.
- Kiểm tra nội dung thực tế thay vì chỉ dựa trên giá trị trả về của execCommand.
- Popup hiển thị bước đang chạy; lỗi ghi rõ bước điền prompt, chờ ảnh hay chờ nút gửi.

Kiểm tra: 7 ca mô phỏng, kiểm tra cú pháp JavaScript. Chưa kiểm thử trên phiên Muse đăng nhập thực tế.

Cập nhật: tải lại extension ở chrome://extensions hoặc edge://extensions, kiểm tra popup v0.5.12 rồi chạy job mới.
