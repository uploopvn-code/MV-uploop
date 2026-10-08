# 0.5.20 — giữ prompt sau khi ChatGPT tải ảnh

## Nguyên nhân

Sau khi ảnh tham chiếu tải xong, ChatGPT có thể thay thế phần tử `contenteditable` của composer thêm một hoặc nhiều lần. Extension điền prompt một lần vào node cũ, nên React/Lexical bỏ node đó và ô nhập mới trở lại trống.

## Sửa

- Luôn tìm lại composer đang hoạt động sau khi upload.
- Điền lại prompt nếu ChatGPT thay node hoặc xóa nội dung.
- Chỉ tiếp tục tới nút Gửi khi prompt còn nguyên qua ba chu kỳ render liên tiếp.
- Trả về đúng editor còn kết nối để phím Enter dự phòng không bị gửi vào node cũ.
- Thêm phương án điền `contenteditable` bằng cấu trúc đoạn văn và sự kiện `beforeinput`/`input` cho các bản ChatGPT bỏ qua `execCommand` và paste tổng hợp.

## Kiểm thử

Có kiểm thử mô phỏng composer bị thay sau upload và kiểm thử prompt nhiều dòng bằng đường fallback mới.
