# Đa ngôn ngữ

English là khóa nội bộ chuẩn. UI hiện có:

- English
- Vietnamese
- Chinese
- Japanese
- Korean

Locale nằm trong `public/locales/`. `test-i18n.mjs` kiểm tra tất cả locale có cùng bộ khóa và kiểm tra alias Command Console. Các panel Canvas, Inspector, Gallery, Timeline, Render Queue, Director, Staging và Stage 3D cập nhật theo locale hiện tại.

Các nhãn thao tác chính, thông báo lỗi/xác nhận render, bộ lọc Queue/Gallery và `aria-label` của các control chính đều đi qua locale. Command Console giữ alias tiếng Việt, English, Chinese, Japanese và Korean nhưng dùng English làm tên nội bộ. Module đóng gói bổ sung nhãn lệnh mẫu, preview số project/media/dung lượng, thông báo bắt đầu tải, lỗi phạm vi mâu thuẫn và tên project không khớp trong cả 5 locale; alias `package project` cũng được nhận diện bằng từng ngôn ngữ.

Khi thêm text UI mới, thêm cùng một khóa vào cả 5 file locale; dùng `data-i18n`, `data-i18n-placeholder`, `data-i18n-title` hoặc `data-i18n-aria` cho HTML. Không đặt chuỗi người dùng trực tiếp trong module nếu chuỗi đó không phải prompt kỹ thuật hoặc dữ liệu người dùng. Chạy `node test-i18n.mjs` trước khi kết thúc thay đổi giao diện.
