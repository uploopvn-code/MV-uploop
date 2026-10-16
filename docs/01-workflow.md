# 01 · Workflow tổng quan

## Các khu vực chính

1. Nhân vật
2. Trang phục và vật dụng
3. Bối cảnh
4. Style và máy quay
5. Âm thanh
6. Sản xuất/phân cảnh
7. Phân cảnh ghép
8. Video đầu ra
9. Nhóm Seedance
10. Video nhóm Seedance
11. Đồng bộ môi
12. Video đồng bộ môi

## Trình tự đề nghị

1. Tạo hoặc nhập blueprint.
2. Tạo ảnh nhân vật, trang phục, vật dụng và bối cảnh.
3. Kiểm tra ảnh tham chiếu và nối chúng vào shot.
4. Chọn provider video cho từng node.
5. Tạo video theo khu vực hoặc tạo từng shot.
6. Kiểm tra video trong timeline và gallery.

## Ảnh và trạng thái

- Không có ảnh: node chưa đủ đầu vào để batch video.
- Ảnh stale: ảnh cũ do prompt/input thay đổi; vẫn có thể dùng để render video theo khu vực.
- Needs review: job cần kiểm tra; batch video vẫn có thể chạy lại nếu node còn ảnh và chưa có video.
- Có video: batch mặc định bỏ qua để tránh tạo trùng.
- Có nhiều version: các version nằm ở node output và vẫn giữ video đã render trước đó.

## Điều khiển canvas và nhóm Seedance

- Lăn chuột: cuộn dọc canvas. Giữ `Shift` rồi lăn: cuộn ngang. Giữ `Ctrl` rồi lăn: zoom tại vị trí con trỏ.
- Nhóm Seedance chứa tối đa 10 shot. Giới hạn này áp dụng khi bấm **Chia nhóm Seedance**; nhóm còn bị giới hạn bởi thời lượng và số ảnh tham chiếu của model.
- Node nhóm Seedance ở cột ⑨ có nút **▼ Ẩn / ▶ Mở**. Khi ẩn, các shot thành viên và output riêng cũ của chúng biến khỏi canvas để cột Production gọn hơn; graph, storyboard, render job và dữ liệu project không thay đổi. Bấm **▶ Mở** để hiện lại.

## Tạo project và nhập phân đoạn cùng phim

- Nút **＋ Project** mở panel tạo project ở mép phải. Nhập tên, **thư mục làm việc là đường dẫn tuyệt đối**, chọn chủ đề Phim rồi bấm **Tạo project**. Nếu thư mục trống, panel kế tiếp cho chọn nguồn ảnh tham chiếu hoặc bắt đầu mới.
- Sửa lỗi giao diện 2026-10-09: các panel **Project mới**, **Cửa sổ mới** và **Nhập ảnh tham chiếu** nay đều dùng chung cơ chế `openInspector`; trước đây chúng hiện trong DOM nhưng thiếu lớp `is-open`, bị CSS đẩy ra ngoài màn hình và trông như nút không phản hồi.
- Blueprint nhiều phân đoạn: chọn **Bible JSON + đúng một file sequence JSON** cùng lúc trong Đạo diễn → Chọn file JSON. `film.title` phải giống nhau và `asset.key` phải ổn định để app tái sử dụng ảnh đã render. Mỗi lần dựng graph sẽ thay graph hiện tại; tạo project riêng cho mỗi phân đoạn.
- Nếu ảnh có sẵn trong project khác cùng phim nhưng chưa tự xuất hiện, mở Đạo diễn và bấm **Lấy ảnh từ project khác**. Project có thư mục làm việc chỉ tự lấy ảnh từ thư mục của nó; việc kéo ảnh project khác là bước rõ ràng, tránh dùng nhầm media.
## Làm việc khi job đang chạy

Một job tạo ảnh hoặc video đơn lẻ không còn khóa toàn bộ canvas. Có thể tiếp tục mở node khác, sửa prompt/node/dây nối, sắp xếp hoặc gửi thêm job đơn lẻ. Mỗi job giữ đầu vào lúc tạo; nếu chính đầu vào của nó thay đổi trước khi kết quả về, kết quả được đánh dấu cũ. Chỉnh sửa node khác không làm kết quả bị báo cũ oan. Dây nối từ shot sang video đầu ra được giữ khi một bản canvas cũ gửi cập nhật dây cùng lúc video về.

Khi chuỗi tự động theo khu hoặc toàn workflow đang chạy, vẫn có thể tạo node mới, sửa node không liên quan và gửi job đơn lẻ cho node đó. Node trong danh sách của chuỗi cùng các node đầu vào của chúng được bảo vệ; sửa prompt, upload, đổi dây vào hoặc gửi job riêng cho những node này sẽ báo lý do cụ thể. Không khởi động chồng một chuỗi tự động mới. Có thể dừng chuỗi hoặc đợi chuỗi hoàn tất để sắp xếp lại toàn bộ graph; thao tác đổi/xóa project tiếp tục được bảo vệ khi còn job đang chạy.
