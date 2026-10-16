# 0.5.23 — tải ảnh ngay khi ChatGPT đã tạo xong

## Nguyên nhân xác nhận từ job thật

Có job hoàn thành trong khi tiến trình cuối vẫn là `ảnh sắp xong · 162s`. API đã trả asset nhưng `async_status` tiếp tục báo bận, nên code cũ có thể giữ pointer tới 90 giây trước khi thử tải. Đồng thời, ảnh đã hiển thị trên trang chỉ được đọc khi API lỗi và phải chờ ổn định 10 giây.

## Sửa

- Kiểm tra kết quả ảnh mỗi 1,5 giây thay vì mỗi 5 giây.
- Thử tải asset sau một chu kỳ ổn định dù `async_status` chưa về idle.
- Luôn kiểm tra ảnh kết quả của assistant trên DOM song song với API.
- Ảnh DOM hoàn chỉnh được đọc sau khoảng 1,2 giây; nếu giao diện còn streaming thì chờ tối đa khoảng 3 giây để tránh lấy preview đang thay đổi.
- Vẫn loại ảnh tham chiếu, ảnh thuộc user turn và ảnh chưa đủ kích thước.

## Kiểm thử

Có kiểm thử API giữ trạng thái busy nhưng đã trả asset; extension phải tải sau tối đa một chu kỳ 1,5 giây.
