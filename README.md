# MV Director — bản thử nghiệm local

Mở http://127.0.0.1:7788 hoặc chạy Start-MV-Director.ps1.

Luồng cố định: Ca sĩ + Sân khấu → Ghép cảnh → Toàn / Trung / Cận → Video.
Bấm một thẻ để sửa prompt, upload ảnh/video hoặc xếp tác vụ. Mô tả nhân vật,
trang phục, nhạc cụ, ánh sáng được kế thừa từ Chỉnh mô tả chung.
Ảnh ở các node trước được đính kèm vào dữ liệu job của node sau.
Đây là bản thử giao diện 3 shot, chưa phải hệ thống sản xuất MV hàng loạt.

## Trạng thái Orbit
Hub: http://192.168.100.5:8080
Mã nguồn Hub đã kiểm tra tại D:\Orbit\orbit; ứng dụng này không sửa mã nguồn Hub.
Vào Kết nối web → nhập email và mật khẩu Orbit → Đăng nhập.
Ứng dụng gọi POST /api/login của Hub và dùng cookie phiên cho các API tiếp theo.
Mật khẩu không lưu; cookie Orbit giữ trong bộ nhớ server. Trình duyệt nhận cookie
local HttpOnly, SameSite=Strict. Đóng server phải đăng nhập lại.
Đăng xuất thu hồi phiên Hub. Không dùng API key hoặc quyền admin dự phòng.

Mở từng node → Cài đặt Orbit → chọn kịch bản và nick → Lưu chỉnh sửa.
Node góc máy có hai cấu hình độc lập cho ảnh và video. Danh sách chứa cả
Kịch bản (workflow) và Khối (flow), theo quyền tài khoản đăng nhập.
Mỗi lần xếp job đều kiểm tra lại quyền đọc danh sách và chụp cấu hình đã chọn.
Quyền chạy thực tế còn do Hub kiểm tra khi triển khai bộ thực thi.

## Phần chạy được
- Prompt gắn với mỗi node; kế thừa mô tả và ảnh tham chiếu.
- Upload media, xem lại ảnh/video, chỉnh lời hát và thời gian từng shot.
- Prompt chuyển động nhúng lời hát, pace và đuôi cấm hiện chữ.
- Hàng đợi local, khóa một job chạy tại một thời điểm, chặn gửi trùng.
- Theo dõi worker; mất kết nối cần kiểm tra thay vì tự tạo lại có thể tốn lượt.
- Xuất JSON gồm prompt, thời gian, ảnh tham chiếu và metadata.
- Đăng nhập Orbit và đọc nick, workflow, flow theo quyền người dùng; lưu lựa chọn riêng từng node.

## Chưa chạy được
Chưa có kịch bản cụ thể trên website tạo ảnh/video và chưa có handler Orbit thật.
Nút Tạo ảnh/video hiện xếp hàng chờ worker; không đồng nghĩa đã gửi sang Orbit.
Không chạy orbit-handler.example.mjs như một kịch bản sản xuất: nó chỉ là hợp đồng mẫu.
Chưa có căn lời/audio tự động, lip-sync thật, ghép phim hay chỉnh graph kéo thả.
Timeline 3 × 8 giây chỉ là mẫu. Prompt consistency không bảo đảm model giữ đúng nhân vật.

## Điểm tích hợp đã đối chiếu với Hub
- GET /api/profiles và GET /api/flows: danh sách nick / khối kịch bản.
- POST /api/profiles/{id}/launch: mở nick.
- POST /api/profiles/{id}/run-flow: {flow_id, vars} hoặc {flow, vars}.
- GET /api/profiles/{id}/flow-progress: tiến độ.
- GET /api/profiles/{id}/downloads và /downloads/{name}: file kết quả.
run-flow đợi kết thúc và có thể hủy flow cũ trên cùng nick; phải kiểm tra nick rảnh
trước khi gọi. Chưa tự chọn nick hoặc chạy flow đang có của người dùng.

Để nối kịch bản thật: xác định website, nick, flow; ánh xạ prompt và ảnh tham chiếu
vào vars; xử lý upload ảnh đến đúng máy chạy trình duyệt; lấy đúng file của job.
Không truyền URL 127.0.0.1 cho một worker trên máy khác vì worker không truy cập được.
Sau khi có handler đã kiểm chứng, chạy:

    node worker-bridge.mjs orbit-handler.mjs

Handler export runJob(payload, context), trả {filePath, mime}.
Worker tải ảnh đầu vào qua context.downloadReference(asset).
Token worker tự sinh trong data/worker-token.txt; không chia sẻ thư mục data.
Server chỉ lắng nghe loopback, không mở cổng ra mạng LAN.

Kiểm tra: node test.mjs — kiểm thử xác thực worker, validation, kế thừa prompt,
ảnh đầu vào cũ, chống job trùng, chạy tuần tự và xử lý tác vụ gián đoạn.

## Cập nhật bộ thực thi Orbit
Bộ thực thi trực tiếp đã được bật: đăng nhập lại sẽ tiếp tục các job đang chờ
của đúng tài khoản. Mỗi job kiểm tra nick bận, mở nick, truyền prompt/mv_prompt,
mv_job_id, mv_kind, mv_duration và gọi đúng workflow/flow đã chọn.
Workflow dùng async=true, force=false và theo dõi flow-progress.
Không tự gửi lại khi timeout hoặc lỗi không rõ kết quả.
Trạng thái script_completed nghĩa là Orbit báo chạy xong, chưa phải đã nhập media.
Chưa ánh xạ các biến đặc thù của kịch bản hoặc upload ảnh tham chiếu; script phải
đọc biến prompt/mv_prompt hoặc dùng dữ liệu mặc định có sẵn của chính nó.
Test bộ chạy: node test-runner.mjs (Hub giả lập).
