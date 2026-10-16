# Render Queue và nhiều tài khoản

## Theo dõi queue

Render Queue cho phép lọc theo provider, account, project và trạng thái. Mỗi account hiển thị worker ID, số luồng tối đa, số luồng đang chạy và job hiện tại.

Các nhóm job có thể pause/resume riêng và retry theo provider. Job đã gửi provider được theo dõi bằng heartbeat; khi mất kết nối, hệ thống kiểm tra lại trước khi tạo job mới để tránh trả phí hai lần.

## Muse Chat

Muse Chat giới hạn tối đa 10 luồng trên từng account/worker profile. Nhiều account có thể chạy đồng thời; bộ phân phối cân bằng job qua các account còn slot thay vì áp một trần chung cho toàn bộ tool.

## Quy tắc batch video

- Mặc định bỏ qua node chưa có ảnh.
- Bỏ qua node đã có video đầu ra.
- Ảnh cũ, ảnh mới và ảnh cần kiểm tra vẫn được chạy nếu node có ảnh.
- Có tùy chọn tạo version 2 cho node đã có video; UI yêu cầu xác nhận trước khi chạy toàn khu vực.
- Shot trong Seedance group vẫn có thể render độc lập.
