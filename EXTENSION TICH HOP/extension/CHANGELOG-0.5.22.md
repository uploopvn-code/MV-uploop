# 0.5.22 — không để cấu trúc attachment mới chặn bước điền prompt

## Nguyên nhân xác nhận từ phiên live

Job đang chạy vẫn dừng ở `đính 4 ảnh tham chiếu` sau hơn 42 giây. Nó chưa gọi bước điền prompt. Thanh attachment của giao diện ChatGPT hiện có thể nằm ngoài thẻ `<form>`, nên bộ dò cũ không thấy đủ ảnh dù ảnh đã hiện trên màn hình.

## Sửa

- Tìm vùng composer bằng cách đi lên từ editor và nhận diện upload input/thanh attachment.
- Quét attachment trong cả composer, form và `main`, đồng thời loại ảnh thuộc các tin nhắn cũ.
- Nhận các biến thể mới như attachment bar, file tile và nút remove file.
- Nếu giao diện không còn báo upload bận qua tám lần kiểm tra, tiếp tục điền prompt thay vì chờ đủ 90 giây.
- Vẫn chờ nút Gửi được ChatGPT mở khóa tối đa 45 giây, nên không bấm gửi giữa lúc upload.
- Báo ngay nếu ChatGPT hiển thị lỗi upload rõ ràng.

## Kiểm thử

Có kiểm thử thanh attachment nằm ngoài form và job có nhiều ảnh hơn số thumbnail DOM mà ChatGPT đang hiển thị.
