# Trợ lý đạo diễn · Command Console

Tab **Trợ lý đạo diễn** nằm cạnh **Công cụ** trên thanh canvas. Bấm để mở/đóng khi cần; tab này nhận yêu cầu bằng ngôn ngữ tự nhiên và chuyển thành những thao tác studio hiện được hỗ trợ. Có thể nhập nhiều dòng và nhấn **Ctrl+Enter** để gửi.

Các lệnh sửa graph, đổi provider, sắp xếp hoặc hoàn tác hiện một bảng xem trước các node/kết nối liên quan. Chỉ sau khi bấm **Xác nhận thực hiện** app mới ghi thay đổi; **Hủy** không gửi lệnh ghi. Lệnh tạo ảnh/video dùng hộp xác nhận của luồng render tương ứng. Lệnh chưa được nhận diện sẽ báo không hỗ trợ, không tự đoán hành động.

Tab **Công cụ** giữ các nút điều khiển thủ công như thêm node và chạy nhanh theo khu; Trợ lý đạo diễn có thể gọi lại các luồng đó.

## Đóng gói dự án

```text
Đóng gói dự án
Đóng gói tất cả dự án
Đóng gói dự án hiện tại
Zip 1 project này
Sao lưu project Episode B thành zip
```

Hai lệnh đầu đóng gói **toàn bộ project trong workspace**; “1/một/project này/hiện tại” chọn project đang mở. Có thể nêu tên một project đã lưu để đóng gói riêng, không cần mở nó. Trợ lý nhận các động từ tương đương như `zip`, `nén`, `sao lưu`, `backup`, `package`; không cần đúng một mẫu câu. Nếu vừa yêu cầu “tất cả” vừa yêu cầu “một”, trợ lý báo mâu thuẫn thay vì đoán. Nếu tên project được chỉ rõ mà không tìm thấy, trợ lý báo lỗi. Trợ lý gọi `/api/projects/package/plan` để hiện danh sách project, số tệp media và dung lượng ước tính. Chỉ khi bấm xác nhận mới bắt đầu tải ZIP từ `/api/projects/package`. Hủy xem trước không tạo file hay sửa dữ liệu. Lệnh tải được ghi vào lịch sử nhưng không nằm trong `undo` vì không đổi project. Chi tiết cấu trúc và giới hạn gói xem [module đóng gói](./09-project-package.md).

## Lệnh đổi provider

```text
Đổi toàn bộ video Production sang Muse Chat
```

Console chỉ chọn các shot phù hợp, hiển thị số lượng node sẽ đổi và yêu cầu xác nhận. Thao tác được lưu vào lịch sử để có thể `undo`.

## Lệnh nối graph theo tên

```text
Nối Main Stage vào các shot Chorus
Nối tất cả Sân khấu 3D vào các node ở cột 6
```

Console hiển thị node nguồn, node đích và số kết nối mới trước khi ghi graph. Kết nối đã tồn tại không bị nhân đôi.

## Điều kiện chạy

```text
Bỏ qua shot cận mặt
Chỉ chạy node có ảnh
Tạo version 2 cho node đã có video
```

Batch video mặc định bỏ qua node không có ảnh riêng lẫn ảnh tham chiếu và node đã có video. Ảnh cũ/stale vẫn được phép dùng sau khi người dùng xác nhận.

## Lịch sử và hoàn tác

`undo` hoàn tác lần thay đổi graph, provider hoặc thứ tự gần nhất của project hiện tại. Video đã render thành công không bị xóa khi hoàn tác.

## Ngôn ngữ

Alias lệnh hỗ trợ Vietnamese, English, Chinese, Japanese và Korean. English là biểu diễn nội bộ; mỗi lệnh vẫn đi qua cùng một bộ kiểm tra và preview.

## Nâng cấp Claude API (2026-10-09)

Tab Trợ lý đạo diễn có hai đường: **Claude lập kế hoạch** cho lời nhắc tự nhiên, và **Lệnh nhanh (không AI)** giữ parser alias ở trên. Claude nhận ngữ cảnh rút gọn, đề xuất tối đa 5 bước trong danh sách hành động cho phép; server xác minh ID/bộ lọc và frontend buộc xem trước, xác nhận trước khi gọi API app. Khóa Claude lưu phía server, không nằm trong project. Batch ảnh/video là bước cuối vì chạy nền; hiện chưa tự tiếp tục sang bước render tiếp theo khi batch trước hoàn tất. Xem [hướng dẫn và note module Claude](./11-director-assistant-claude.md).
