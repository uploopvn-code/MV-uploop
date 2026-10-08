# 0.5.18 — bỏ qua video intro của Muse

## Nguyên nhân

Video intro có thể tồn tại trước khi gửi prompt nhưng được Muse thay URL `blob:` sau đó. Baseline cũ chỉ ghi URL, nên URL mới của cùng player intro bị hiểu nhầm là kết quả vừa tạo. Ngoài ra, các request tải video nền dùng cùng đường dẫn media với video kết quả.

## Sửa

- Ghi nhận cả phần tử media đã có trước khi gửi, không chỉ URL của chúng.
- Bỏ qua player có sẵn dù Muse đổi `src` hoặc `blob:` sau đó.
- Bỏ qua video `autoplay` và media trong khu vực intro, hero, landing, banner hoặc thanh điều hướng.
- Không nhận một request tải video rời rạc làm kết quả. URL chỉ được nhận từ phản hồi gắn với đúng prompt hoặc từ player kết quả mới trong DOM.
- Giữ hỗ trợ player kết quả nằm ngoài conversation root và cơ chế đọc `MediaSource`.

## Kiểm thử

Có kiểm thử riêng cho intro đổi blob sau khi arm và intro autoplay được thêm động sau khi gửi prompt.
