# Module đóng gói project

Lệnh của Trợ lý đạo diễn: `Đóng gói dự án` (toàn bộ workspace), `Zip 1 project này` (project đang mở) hoặc `Sao lưu project <tên>` (project được nêu tên). Alias tương ứng có ở năm ngôn ngữ UI. Phần phân tích ý định nhận các cách nói tương đương, kiểm tra phạm vi mâu thuẫn và không tự chọn một project khác khi tên không khớp.

## Luồng xử lý

1. `GET /api/projects/package/plan?scope=all|current|project` đọc `project.json` và thống kê media. `scope=project` kèm `id` hợp lệ trong workspace. Không sửa dự án.
2. Trợ lý hiện preview: tên project, số file media, dung lượng ước tính. Hủy ở bước này không tải gì.
3. Xác nhận → trình duyệt tải `GET /api/projects/package?scope=...` dưới dạng ZIP. Server tạo ZIP theo luồng bằng `writeZipStream` trong `zip.mjs`, có ZIP64 cho file/gói lớn; không gom video vào RAM hay ghi một ZIP tạm trên đĩa.

ZIP giữ cấu trúc `manifest.json`, `workspace.json`, `projects/<id>/project.json`, `projects/<id>/media/<id>.<ext>`. Media gồm ảnh, video và âm thanh lưu trong project, kể cả file chưa còn gắn vào node. Các thư mục xuất bản sao bên ngoài project, file tạm, `.lock` và thông tin tài khoản/API key toàn cục không được đóng gói. Đây là bản lưu trữ để tải về và giữ dữ liệu; chức năng import ZIP trực tiếp chưa có (import hiện tại nhận `.mvproj.json`). Nếu project khác đang ghi media đúng lúc tải, snapshot có thể thay đổi và trình duyệt sẽ báo tải lỗi; thử lại sau khi hàng đợi dừng.

## Kiểm tra

`node test-project-package.mjs` dùng workspace tạm, xác minh hai project, ảnh/video và các file JSON có trong ZIP, đồng thời loại trừ file ẩn và cấu hình toàn cục. `node test-assistant.mjs` kiểm tra preview, hủy, xác nhận và chọn phạm vi.
