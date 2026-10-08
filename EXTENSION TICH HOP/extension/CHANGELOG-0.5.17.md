# 0.5.17 — nhận diện video Muse được render ngoài vùng hội thoại

## Nguyên nhân xác nhận từ phiên chạy thật

Trạng thái lưu trong Edge cho thấy extension liên tục ở bước `đang chờ video` dù video đã xuất hiện. Vì vậy job chưa hề đi tới bước đọc blob hay gửi file về Drama Tool.

Muse có thể render thẻ `<video>` bằng React portal ở ngoài phần tử hội thoại đã ghi nhận lúc gửi prompt. Bộ dò cũ chỉ quét phần tử hội thoại đó nên không thấy player.

## Sửa

- Quét cả tài liệu để tìm `video`, `source` và liên kết video mới.
- Vẫn ưu tiên vùng hội thoại và giữ baseline trước khi gửi để không lấy nhầm video mẫu hoặc video cũ.
- Vẫn bỏ qua media nằm trong tin nhắn của người dùng.
- Thêm chẩn đoán số player mới. Khi đã thấy thẻ video nhưng chưa đọc được dữ liệu, popup sẽ hiện `đã thấy ... player video, đang đọc dữ liệu` thay vì chỉ hiện `đang chờ video`.
- Thêm kiểm thử đúng cấu trúc Muse: player blob có class `h-full w-full bg-transparent object-cover` nằm ngoài conversation root.

## Cập nhật và kiểm thử trực tiếp

Tải lại extension tại `edge://extensions`, kiểm tra popup hiện `v0.5.17`, rồi chạy một job mới. Cần mở tab job sau khi extension đã được tải lại để hook `MediaSource` được cài ngay từ lúc trang bắt đầu chạy.
