# 0.5.13 — gửi prompt, chờ và lưu video Muse

Bản sửa nằm trực tiếp trong thư mục extension. Không thêm quyền trình duyệt.

## Luồng đã sửa

- Nhận diện nút gửi có nhãn, nút chỉ có biểu tượng và nút ở cạnh phải ô nhập. Nếu không có nút nhận diện được, dùng Enter một lần. Nút gửi bị khóa thì tiếp tục chờ, không dùng Enter để vượt qua.
- Nhận ảnh đính kèm hiển thị bằng img, ảnh nền CSS hoặc điều khiển attachment. Điền lại prompt sau khi giao diện cập nhật.
- Xác nhận gửi bằng tin nhắn ngoài ô nhập hoặc phản hồi của request có chứa đúng prompt. Không tự gửi lại một lần gửi chưa rõ kết quả.
- Giữ dấu job khi trang chuyển hướng. Theo dõi DOM, source video và phản hồi mạng của job; bỏ qua video có sẵn, ảnh blob và request nền không liên quan.
- Chờ tối đa 10 phút. URL chưa tải được thì tiếp tục thử, không tạo video lần nữa. Nhận URL video không có đuôi file và link file thay cho MediaSource blob nếu Muse cung cấp.
- Mỗi lần tải có giới hạn 45 giây; kiểm tra MP4/WebM, loại HTML/trang đăng nhập, playlist và file tải thiếu.
- Gửi file về Drama Tool bằng giao thức worker hiện có. Chỉ đóng tab sau khi máy chủ xác nhận đã lưu; giữ tab và hiện lỗi nếu thất bại.
- Hiện bước đang chạy ngay góc dưới trái tab Muse và popup extension.

## Cập nhật

1. Vào chrome://extensions hoặc edge://extensions, tải lại extension đã nạp từ thư mục này.
2. Kiểm tra popup hiện v0.5.13.
3. Chạy một job mới có ảnh và prompt. Kết quả video được lưu vào Drama Tool; không tạo thêm bản trong thư mục Downloads của trình duyệt.

## Kiểm chứng

21 kiểm thử DOM + mạng mô phỏng qua, gồm luồng ghép gửi → quan sát video → tải → lưu → đóng tab, lỗi tạm thời khi tải, lỗi lưu máy chủ, HTTP 429, gửi qua Enter, nút icon, chuyển trang, giữ tab và không gửi trùng.

Chạy lại: `npm ci --prefix tests`, sau đó `npm test --prefix tests`.

Chưa kiểm thử trên phiên Muse đăng nhập thực tế do trình duyệt kết nối không có tab Muse. Nếu Muse chỉ cung cấp HLS/DASH hoặc MediaSource mà không có link MP4/WebM truy cập được, worker sẽ báo lỗi tải thay vì lưu nhầm playlist. Các ca kiểm thử mô phỏng không thay thế việc xác nhận giao diện đang dùng thực tế.
