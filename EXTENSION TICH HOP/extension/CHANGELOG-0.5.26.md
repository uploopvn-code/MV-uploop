# 0.5.26

- Luôn kiểm tra ảnh kết quả đã render trong lượt trả lời mới nhất, kể cả khi API hội thoại của ChatGPT vẫn giữ trạng thái đang chạy.
- Chỉ nhận marker ảnh tạo chính thức, ảnh đã tải đủ kích thước, ổn định qua một nhịp quét và không còn progress/streaming; ảnh tham chiếu trong lượt người dùng hoặc composer vẫn bị loại.
- Thêm kiểm thử cho trường hợp ảnh giao diện đã hoàn tất nhưng `async_status/end_turn` của API chưa cập nhật.
