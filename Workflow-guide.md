# Workflow nối node và chạy tự động

## Cách sử dụng
1. Bấm + Thêm node ảnh; đặt tên, prompt, App/kịch bản, nick và tên file.
2. Bấm Ra ở nguồn, rồi Vào ở đích. Có thể nối nhiều nguồn vào một đích,
   hoặc một nguồn tới nhiều đích. Bỏ nối bằng nút × dưới canvas.
3. Chọn node đích ở thanh công cụ (chỉ chạy nhánh cần thiết), hoặc toàn bộ workflow.
4. Bấm Tự động tạo ảnh. Ảnh có sẵn và còn hợp lệ được dùng lại.
5. Dừng sau node hiện tại ngăn bước tiếp theo; không hủy tác vụ đang chạy trên Orbit.

Bản hiện tại tự động tạo ẢNH. Video vẫn chạy riêng trong từng node.
Canvas tự sắp xếp theo phụ thuộc; nối bằng hai lần bấm cổng, chưa kéo thả vị trí.

## Điều kiện chạy thực tế
Thư mục trong Project phải dùng được bằng CÙNG ĐƯỜNG DẪN trên máy MV Director
và máy chạy Orbit. Nếu khác máy, dùng thư mục mạng chia sẻ (UNC) được cả hai
truy cập. Không dùng đường dẫn ổ D của hai máy khác nhau như thể cùng một thư mục.

Tool sao chép ảnh tham chiếu vào thư mục inputs dưới thư mục project. Orbit nhận:
- {{mv_input_count}}: số ảnh đầu vào.
- {{mv_input_1_path}}, {{mv_input_2_path}}, ...: đường dẫn từng ảnh theo thứ tự nối.
- {{mv_inputs_json}}: chuỗi JSON gồm node_id, path, mime của từng ảnh.
- {{mv_output_path}}: đường dẫn file kết quả duy nhất cần lưu.

App phải khai báo những key muốn nhận trong public_params. Kịch bản phải upload
các ảnh đầu vào vào website, rồi lưu file thật đến mv_output_path. Truyền đường dẫn
không tự upload ảnh. Tool không sửa selector hay nội dung App của người dùng.

## Khi có kết quả
Sau Orbit báo chạy xong, tool chờ file tối đa 60 giây, kiểm tra kích thước ổn định
và dấu hiệu định dạng ảnh/video, nhập vào media của project và hiển thị ở node.
Sau đó mới chạy node kế tiếp. Giới hạn file 100 MB. Không tự chuyển đổi định dạng.
Đây là kiểm tra chữ ký định dạng, chưa phải kiểm tra chất lượng nội dung ảnh.

Nếu thiếu file/sai loại/lỗi Orbit, chuỗi dừng ở Cần kiểm tra. Dùng Hàng đợi → Nhận
file sau khi sửa vị trí lưu; thao tác này không chạy lại kịch bản. Sau khi nhận
thành công, bấm Tự động tạo ảnh để tiếp tục các node còn thiếu.

Khi khởi động lại ứng dụng, chuỗi đang chạy dừng và cần kiểm tra thủ công;
không tự gửi lại tác vụ có khả năng đã tạo ảnh. Không sửa graph/prompt khi có
job chờ/đang chạy để tránh dùng lẫn đầu vào. Lựa chọn App, nick và quyền được
kiểm tra lại trước mỗi lần chạy.

Kiểm thử với Hub giả lập: node test-graph.mjs. Bao gồm ghép 2 nguồn, chặn vòng lặp,
chạy chuỗi 2 node, truyền file thật, dừng khi thiếu output và nhận file không chạy lại.
