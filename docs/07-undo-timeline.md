# Undo, lịch sử và Timeline

## Undo/history

Command Console lưu lịch sử theo project cho các thao tác đổi provider, nối graph và sắp xếp node. Lệnh `undo` khôi phục trạng thái trước đó và không xóa video đã render thành công.

## Timeline

Timeline sắp xếp clip theo thời gian thực từ metadata/start/duration, hỗ trợ:

- Kéo thả clip để đổi thứ tự.
- Chọn nhiều clip.
- Phát toàn bộ timeline liên tục.
- Track Video, Audio, Lip Sync và Captions.
- Thumbnail và player cho clip đã render.
- Hiển thị cảnh báo khi các block cùng luồng bị chồng thời gian.

Clip chưa render vẫn giữ vị trí thời gian của shot nguồn để không làm lệch bố cục dựng.
