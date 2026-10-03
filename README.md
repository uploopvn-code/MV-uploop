# MV Director — bản thử nghiệm local

Mở http://127.0.0.1:7788 hoặc chạy Start-MV-Director.ps1.

## Cài đặt & chạy
Yêu cầu Node.js 22 trở lên. Không cần `npm install` (không có thư viện phụ thuộc).

    npm start            # chạy server tại http://127.0.0.1:7788
    npm test             # chạy toàn bộ 8 bộ kiểm thử
    npm run format       # định dạng lại code bằng Prettier

Biến môi trường: `MV_PORT` (cổng, mặc định 7788), `MV_DATA_DIR` (thư mục dữ liệu,
mặc định `data/`). Thư mục `data/` chứa project, media và token worker; không đưa lên git.

Luồng cố định: Ca sĩ + Sân khấu → Ghép cảnh → Toàn / Trung / Cận → Video.
Bấm một thẻ để sửa prompt, upload ảnh/video hoặc xếp tác vụ. Mô tả nhân vật,
trang phục, nhạc cụ, ánh sáng được kế thừa từ Chỉnh mô tả chung.
Ảnh ở các node trước được đính kèm vào dữ liệu job của node sau.
Đây là bản thử giao diện 3 shot, chưa phải hệ thống sản xuất MV hàng loạt.

## Đạo diễn — dựng sơ đồ tự động từ master prompt
Mục **✦ Đạo diễn** biến một master prompt (đạo diễn MV) thành cả sơ đồ node và tự nối dây:
asset (ca sĩ, từng nhạc công, sân khấu) + node Style + node cỡ máy (Wide/Medium/Close) ở khu
Tạo hình, và các node storyboard ở khu Sản xuất — mỗi shot **tự nối** tới đúng asset nó dùng,
cỡ máy và style. Dựng xong bạn chỉ việc bấm Tạo ảnh / Tạo video, hoặc sửa prompt.

Hai cách chạy:
1. **Dán blueprint:** chép master prompt (nút trong mục Đạo diễn) → chạy ở ChatGPT/Claude kèm bài
   hát → model trả về khối JSON blueprint → dán vào ô, bấm **✦ Dựng sơ đồ**.
2. **Tự động qua API:** nhập API key một endpoint tương thích OpenAI (base URL + model + key) →
   gõ tên bài hát → **⚡ Chạy tự động & dựng** (công cụ tự gọi master prompt rồi dựng).

Blueprint là JSON: `{ project, style, assets[{key,name,prompt}], cameras[{key,name,config}],
shots[{name,start,duration,uses[],camera,lyric,videoPrompt}] }`. `uses` là các `key` asset shot
dùng; `camera` là 1 `key` trong `cameras`. **Dựng sơ đồ thay toàn bộ node của project đang mở** —
nên tạo Project mới cho mỗi bài hát. Key LLM dùng chung mọi project (lưu ở gốc `data/`).

## Nhiều project & chủ đề
- Thanh trên cùng có ô chọn **project** và nút **＋ Project**. Mỗi project lưu riêng
  node, ảnh, video, và cài đặt — không lẫn nhau (ở `data/projects/<id>/`).
- Tạo project mới: đặt tên + chọn **chủ đề** (Music/MV, Phim, Hoạt hình, Khác). Project
  được **nhân từ bộ node mẫu của chủ đề** (kèm node Style và Máy quay).
- Đổi/xóa project trong **⚙ Project**. Luôn còn ít nhất một project.
- API key Seedvis và worker token dùng chung cho mọi project (lưu ở gốc `data/`).

## Khu vực quy trình (zones)
Canvas chia 5 cột theo quy trình: **① Nhân vật** (thiết kế nhân vật / visual reference: ca sĩ, nhạc công), **② Bối cảnh** (sân khấu/cảnh), **③ Style & Máy quay** (node Style + các cỡ máy), **④ Sản xuất video** (các shot), **⑤ Video** (video đã tạo). Mỗi shot = nhân vật + bối cảnh + cỡ máy + style nối lại.
- Mỗi node thuộc một khu vực (tự gán theo loại; đổi trong node ở ô **Khu vực**, hoặc **kéo
  node sang cột khác** để chuyển).
- Nút **⬓ Xếp khu vực**: tự xếp mọi node vào đúng cột, theo thứ tự (khu Tạo hình/Sản xuất theo
  số thứ tự #; khu Video theo thứ tự node sản xuất rồi tới phiên bản).
- Số thứ tự **#N** đánh **riêng theo từng khu vực** (Tạo hình 1,2,3…; Sản xuất 1,2,3…; Video 1,2,3…).
  Sửa ô **STT trong khu vực** của node và gõ vị trí mới để chèn node vào đúng chỗ; hệ thống tự
  đánh lại 1..n. Tên video tải về dùng số của node sản xuất nguồn (vd `01_Toàn cảnh_v2.mp4`).

## Node Style & Máy quay
- Là node trên canvas (nét đứt). Nội dung của chúng được **chèn vào prompt** của mọi
  node mà bạn nối cổng **Ra** của chúng vào.
- Thêm bằng **＋ Style** / **＋ Máy quay** trên thanh công cụ; bấm node để sửa nội dung.
- Style = mô tả phong cách/màu/chất liệu; Máy quay = góc máy/ống kính/chuyển động.
- Node cài đặt không tạo ảnh/video và không nằm trong chạy tự động; đổi nội dung sẽ đánh
  dấu các node nối sau cần cập nhật.

## Tạo ảnh / video bằng Seedvis API
1. Kết nối web → Seedvis API → dán API key → Lưu key → Kiểm tra kết nối.
   Key lưu ở `data/seedvis-key.txt` (hoặc biến môi trường `SEEDVIS_API_KEY`),
   không gửi về trình duyệt, không ghi vào project.json.
2. Mở node → Nguồn tạo: chọn Seedvis hoặc Orbit riêng cho ảnh và video, chọn model,
   tỉ lệ khung, upscale. Node chưa có cấu hình Orbit mặc định dùng Seedvis.
   - Ảnh: Nano Banana Pro / 2 / Lite, GPT Image 2. Có ảnh đầu vào → ảnh → ảnh.
   - Video: Veo 3.1, Seedance 2.5 / 2.0 Fast, Omni Flash.
     Thời lượng shot được làm tròn về giá trị model hỗ trợ (Veo 4/6/8 giây, Seedance 5/10/…).
3. Node → Video của shot → Ảnh đầu vào cho video, chọn một trong hai:
   - **Ảnh của node này (keyframe):** dùng chính ảnh đã tạo/duyệt của node. Mỗi node
     tạo ảnh trước rồi tạo video từ ảnh đó.
   - **Ảnh từ node nối vào:** dùng thẳng ảnh của các node nối vào (ví dụ dùng lại ảnh
     ban nhạc để tạo video), không cần tạo ảnh riêng cho node này. Số ảnh gửi đi theo
     giới hạn model: Veo / Omni 1 ảnh (image-to-video) hoặc 2–3 ảnh (multi-image-to-video),
     Seedance tới 10 ảnh.
4. Bấm Tạo ảnh · Seedvis / Tạo video · Seedvis, hoặc ▶ Tự động tạo ảnh cho cả chuỗi.
   Kết quả được tải về và gắn vào node.

## Tự động tạo video (song song, nhiều phiên bản)
Thanh công cụ: chọn **Phiên bản** (1–4) rồi bấm **▶ Tự động tạo video**.
- Mọi node đã sẵn ảnh đầu vào (ảnh của chính node, hoặc ảnh node nối vào tùy chế độ) và
  dùng Seedvis cho video sẽ **chạy song song qua API** (tối đa `MV_SEEDVIS_CONCURRENCY`
  node cùng lúc, mặc định 3) — không chạy lần lượt từng node.
- Mỗi node gửi một request `count = số phiên bản`; mỗi video trả về **tự tách thành một
  node mới** (node phiên bản, viền xanh, bấm để xem/tải/xóa). Node nguồn không bị ghi đè.
- Bấm lại để **tạo thêm** phiên bản (không xóa bản cũ). **Dừng tạo video** ngừng xếp thêm;
  các tác vụ đã gửi Seedvis vẫn chạy.
- Trong một node, mục Video của shot có **Số phiên bản**: từ 2 bản trở lên, bản tạo thủ công
  cũng tách thành node riêng; 1 bản thì gắn thẳng vào node như cũ.
- Giới hạn phiên bản theo model: Veo / Omni 4, Seedance 8. Node phiên bản và node bạn thêm
  đều có nút xóa.

An toàn chi phí: mỗi tác vụ gửi `Idempotency-Key` = mã job nên gửi lại khi lỗi mạng không
tạo lượt mới. Không bao giờ tự gửi lại sau khi Seedvis đã nhận. Quá thời gian hoặc khởi động lại
khi đang chạy → job ở Cần kiểm tra; bấm Kiểm tra lại trong Hàng đợi để đọc tiếp đúng job đó.
Seedvis từ chối (lỗi 4xx hoặc failed) → job Lỗi, sửa prompt/ảnh rồi tạo lại.

## Thư viện Video & số thứ tự node
- Thanh bên trái có mục **🎬 Video**: gom mọi video đã tạo theo node nguồn (kèm số thứ tự
  và tên node). Mỗi video có nút xem, tải, và **ô tick** để chọn nhiều bản của cùng node.
  Thanh trên cùng: **Chọn tất cả / Bỏ chọn / Tải đã chọn / Xóa đã chọn** (xóa áp dụng cho
  node phiên bản).
- **Số thứ tự (STT)** hiện trên mỗi node (badge `#3`), tự đánh khi tạo node, sửa được trong
  node (ô "Số thứ tự").
- **Tên file tải về** theo STT + tên node để nhận đúng nguồn:
  - Node thường: `03_Toàn cảnh.mp4`
  - Node phiên bản: `03_Toàn cảnh_v2.mp4`

## Dây nối
Bấm vào một dây để chọn (dây chuyển đỏ nét đứt), rồi bấm nút × ở giữa dây hoặc phím Delete.
Vẫn có danh sách dây kèm nút × dưới canvas. Không sửa dây khi đang có job chờ/chạy.

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
