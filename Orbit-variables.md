# Biến MV Director → Orbit

Trong bước nhập nội dung của kịch bản, dùng {{prompt}} hoặc {{mv_prompt}}.
Với App, khai báo các key này trong public_params rồi cập nhật/xuất bản App.
Orbit chỉ nhận inputs có key thuộc public_params; các key khác bị bỏ qua.

| Key | Ý nghĩa |
| --- | --- |
| prompt | Prompt ảnh hoặc prompt video của tác vụ |
| mv_prompt | Giống prompt |
| mv_job_id | ID duy nhất của tác vụ |
| mv_kind | image hoặc video |
| mv_duration | Thời lượng giây; node tham chiếu mặc định 8 |
| mv_start | Thời điểm bắt đầu giây; node tham chiếu mặc định 0 |
| mv_node_id | singer, stage, scene, wide, medium hoặc close |
| mv_aspect_ratio | 16:9 |

Ví dụ public_params tối thiểu:

```json
[
  {"key":"prompt","label":"Prompt từ MV Director","type":"text","required":true}
]
```

Trong bước Type của App/kịch bản: {{prompt}}
Trong bước cần thời lượng: {{mv_duration}}
Nếu App yêu cầu thêm input khác, phải có giá trị mặc định trong biến nội bộ
của App; giao diện MV Director chưa hỗ trợ nhập các input tùy ý.

Workflow/Flow nhận các giá trị trên qua vars. App nhận qua inputs, cùng
profile_id là nick đã chọn. App chạy bằng POST /api/apps/{id}/run, force=false.
Hỗ trợ App trên Hub local; chưa có chọn VPS/worker từ giao diện.
Chưa truyền file ảnh/audio hoặc URL media dùng được từ máy Orbit; chưa tự nhập
file đầu ra. Trạng thái kịch bản xong chưa có nghĩa media đã về node.

## Vị trí và tên file đầu ra
Trong ⚙ Project: đặt thư mục lưu tuyệt đối trên máy chạy Orbit.
Trong node → File đầu ra: đặt mẫu tên ảnh/video. Ví dụ:
`{node_id}_{job_id}.png` hoặc `concert_{node_id}_{job_id}.mp4`.
{job_id} bắt buộc để không trùng file. Mẫu chỉ áp dụng cho tác vụ mới.

Các biến Orbit nhận (App phải khai báo trong public_params):
- mv_output_dir: thư mục lưu trên máy Orbit.
- mv_output_filename: tên file đã thay các placeholder.
- mv_output_path: đường dẫn đầy đủ, ghép thư mục và tên file.

Trong bước download/save của kịch bản, dùng {{mv_output_path}} làm đường dẫn
đích nếu bước đó hỗ trợ path. Kịch bản cần tạo thư mục nếu chưa có.
Việc cấu hình không tự đổi Downloads của browser hoặc đổi định dạng ảnh.
Nếu website tải WebP, chọn mẫu đuôi .webp; đặt đuôi .png không chuyển đổi định dạng.
Chưa tự thu nhận file kết quả vào MV Director.
