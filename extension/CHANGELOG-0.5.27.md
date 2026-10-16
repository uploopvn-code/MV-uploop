# 0.5.27

- Sửa trạng thái ảnh đã hoàn tất nhưng bị treo ở “đang xác nhận”.
- Không còn coi mọi `aria-valuenow` trong trình xem ảnh là tiến độ tạo ảnh; progress 100% và slider của ảnh hoàn tất được bỏ qua.
- Marker ảnh tạo chính thức đã tải đủ và ổn định được nhận ngay khi không còn progress tạo ảnh thật, kể cả khi nút Stop hoặc trạng thái streaming/API còn sót lại.
