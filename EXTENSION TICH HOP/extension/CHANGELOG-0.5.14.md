# 0.5.14 — tiếp tục lấy video khi chưa đọc được xác nhận gửi

## Nguyên nhân lỗi trong ảnh

Bản 0.5.13 chờ 30 giây để tìm toàn bộ prompt trong tin nhắn hoặc nhận request gửi tương ứng. Khi không thấy, worker kết thúc job và xóa trạng thái theo dõi. Muse vẫn có thể đã nhận lệnh và tạo video sau đó, nhưng extension không còn thu kết quả.

## Sửa

- Sau một lần bấm gửi, thiếu xác nhận được coi là đang chờ, không phải lỗi gửi. Tiếp tục chờ video tối đa 10 phút tính từ thời điểm bấm gửi, không gửi lại prompt.
- Video mới xuất hiện trong vùng chat của job là bằng chứng để xác nhận và lấy kết quả, không bắt buộc nhìn thấy lại prompt.
- Giữ vùng chat và danh sách URL có sẵn từ trước khi gửi. Vẫn theo dõi khi ô nhập bị khóa, bị ẩn/xóa hoặc trang chuyển hướng. Không nhận video mẫu cũ hoặc ảnh blob làm kết quả.
- Lỗi đọc giao diện sau lúc bấm gửi, mất phản hồi mạng hoặc HTTP 5xx không xóa job đang chờ. Phản hồi từ chối rõ ràng, ví dụ HTTP 401/403/429, vẫn báo lỗi.
- Tải và lưu video về Drama Tool theo luồng hiện có; chỉ đóng tab sau khi lưu thành công.

## Cập nhật

Tải lại extension ở chrome://extensions hoặc edge://extensions; kiểm tra popup hiện v0.5.14.

Bản cập nhật áp dụng cho job mới. Không tự gửi lại các job đã tạo ra video bằng bản cũ; bản cũ đã xóa trạng thái theo dõi nên cập nhật không tự gắn lại video đó vào job đã thất bại.

## Kiểm chứng

30 kiểm thử DOM/mạng mô phỏng qua, bao gồm tái hiện lỗi trong ảnh: hết 30 giây chưa xác nhận được gửi → video xuất hiện muộn → tải và lưu thành công, chỉ gửi một lần. Có kiểm tra ô nhập bị khóa/xóa, chuyển trang, khôi phục trạng thái chờ, video cũ, hết hạn 10 phút và HTTP 500/429.

Chạy: `npm ci --prefix tests` rồi `npm test --prefix tests`.
Chưa kiểm thử trực tiếp trên phiên Muse đăng nhập của người dùng.
