# 0.5.28

- Dùng cấu trúc live `generated-image-gallery > generated-image-preview[aria-label^="Generated image"] > img` làm tín hiệu kết quả cuối.
- Ảnh gallery đã decode đủ kích thước và ổn định qua một nhịp được lấy ngay, không bị progress/streaming/API còn sót giữ ở “đang xác nhận”.
- Giữ các bộ chọn cũ làm tương thích dự phòng và vẫn loại ảnh trong lượt người dùng/composer.
