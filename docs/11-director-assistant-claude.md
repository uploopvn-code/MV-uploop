# 11 · Trợ lý đạo diễn có Claude API

## Cấu hình

Vào **Studio → Trợ lý đạo diễn → Claude API · Bộ não trợ lý**. Nhập API key Claude và model, mặc định `claude-sonnet-4-6`, rồi lưu. Nếu Anthropic báo key không được gắn với workspace, nhập thêm **Anthropic Workspace ID** (thường có dạng `wrkspc_…`); backend sẽ gửi nó bằng header `anthropic-workspace-id`.

Key nằm ở thư mục dữ liệu của app (`assistant-claude-key.txt`), không ghi trong project, graph, blueprint hay lịch sử lệnh; giao diện chỉ nhận trạng thái và 4 ký tự cuối. Có thể dùng biến môi trường `MV_ASSISTANT_CLAUDE_KEY`, `MV_ASSISTANT_CLAUDE_MODEL` và `MV_ASSISTANT_CLAUDE_WORKSPACE_ID` thay file. Backend dùng Claude Messages API gốc qua HTTPS; không gửi key tới URL tùy ý.

Sau khi sửa mã server, **khởi động lại app/server**, rồi tải lại trang để route API mới hoạt động.

## Cách giao việc

Nhập yêu cầu bằng ngôn ngữ tự nhiên và bấm **Gửi**. Trợ lý gửi cho Claude yêu cầu cùng bản tóm tắt project hiện tại: cấu hình và mô tả dự án; bản nháp ý tưởng/kịch bản/blueprint đang mở; node với prompt được giới hạn độ dài, provider, mốc timeline, trạng thái ảnh/video, đầu ra, thông tin ghim 3D và trục đối thoại; các dây nối và tối đa 120 job gần đây. Nội dung dài được cắt ngắn để kiểm soát token. Không gửi tệp ảnh/video hay API key. Claude trả về tối đa năm bước thuộc danh sách cho phép; server kiểm ID và bộ lọc, rồi trình bày preview. Chỉ sau khi người dùng bấm **Xác nhận thực hiện**, frontend mới gọi API app tương ứng. Nếu project đổi trong lúc chờ, preview hết hạn.

Mỗi lần gọi Claude hiển thị token đầu vào/đầu ra ngay dưới câu trả lời. Mục **Token Claude** phía trên chat hiển thị tổng và lịch sử theo project, gồm token cache khi API trả về. Lịch sử lưu ở thư mục dữ liệu của app (`assistant-token-history.json`), tối đa 2.000 lần gọi toàn app; 100 lần gần nhất của project được hiển thị. Xóa chat không xóa lịch sử token. Token được ghi ngay sau phản hồi Claude, kể cả khi kế hoạch JSON không hợp lệ hoặc project đổi trong khi chờ.

Trợ lý có thể đề xuất tạo shot/node tham chiếu/thiết lập và sửa tên, prompt, mô tả, config hoặc thời điểm shot. Server kiểm trường được phép, ID, tên trùng và giới hạn thời lượng; UI cho xem trước rồi mới thực hiện. Chỉnh sửa node có thể hoàn tác giá trị văn bản/timeline bằng nút Undo. Việc hoàn tác prompt vẫn có thể giữ cờ media cũ để tránh coi ảnh/video cũ là còn hợp lệ. Tạo node mới không tự nối dây trong cùng kế hoạch vì ID chỉ được cấp sau khi tạo; có thể yêu cầu trợ lý nối ở lượt kế tiếp.

Yêu cầu sửa ảnh như “shot #4, đưa 2 nhân vật gần nhau hơn” được nối với ảnh hiện có của shot Production số 4 và chạy qua API sửa ảnh (Seedvis hoặc ChatGPT extension). Ảnh cũ vẫn được giữ để đổi lại. Tác vụ chạy nền phải là bước cuối của kế hoạch. Với yêu cầu gọi đích danh một shot, ngữ cảnh Claude tập trung vào shot đó và các node đầu vào để giảm token. Nếu Claude trả sai định dạng JSON, app thử lại một lần với ngữ cảnh gọn hơn; cả hai lần đều được ghi trong lịch sử token. Một số yêu cầu sửa ảnh nêu rõ shot còn có đường dự phòng xác định để không bị dừng chỉ vì JSON sai định dạng.

Trước khi gọi Claude, server thử phân tuyến một số lệnh xác định: sửa ảnh shot có số thứ tự, thống kê, sắp xếp và tạo ảnh theo khu. Các lệnh này vẫn đi qua validator, xem trước và xác nhận nhưng dùng 0 token Claude; không cần cấu hình key. Sau khi một kế hoạch Claude chỉ gồm sửa node/đổi provider/sửa ảnh được xác nhận và chạy thành công, app lưu câu lệnh đã chuẩn hóa cùng hành động vào `assistant-learned-commands.json` theo project. Lần sau cùng câu lệnh (không phân biệt hoa/thường, dấu tiếng Việt và khoảng trắng) được kiểm lại trên project hiện tại rồi chạy như lệnh nhanh. Sửa ảnh chỉ được kích hoạt trong kho lệnh đã học sau khi job hoàn tất; job lỗi/hủy không được học. Mục **Lệnh đã học** trên UI cho biết lệnh nào đã sẵn sàng hoặc đang chờ job. Đây là ghi nhớ thao tác chính xác, không tự suy diễn câu lệnh gần giống để tránh sửa nhầm node.

## Giao diện trò chuyện (2026-10-09)

Trợ lý hiển thị tin nhắn người dùng, câu hỏi làm rõ, kế hoạch, lỗi và kết quả thành một chuỗi chat. Mỗi project có chuỗi riêng trong `localStorage`; giới hạn 60 tin nhắn hiển thị và có nút xóa. Tối đa 12 tin nhắn gần nhất, sau khi lọc role và giới hạn ký tự phía server, được gửi kèm để Claude hiểu các câu tiếp nối. Lịch sử này chỉ là ngữ cảnh dữ liệu, không nới quyền thực thi.

Nhấn **Enter** để gửi, **Shift+Enter** để xuống dòng. Kế hoạch thay đổi graph/provider/render vẫn mở khung preview và chờ xác nhận. Câu trả lời thống kê chỉ đọc dữ liệu nên hiển thị trực tiếp, không yêu cầu xác nhận.

Hành động được hỗ trợ: nối graph theo tên/khu; đổi provider video Muse Chat, Seedvis, Google Vids; bắt đầu batch ảnh/video theo khu; sắp xếp; thống kê; đóng gói ZIP. Các thay đổi graph/provider/thu tự có lịch sử undo như lệnh nhanh. Nút **Lệnh nhanh (không AI)** giữ parser cũ cho câu lệnh đã định nghĩa.

## Ranh giới an toàn và hiện trạng

- Claude **không** được chạy shell, tự gọi API tùy ý, sửa file, xóa node/video hoặc tự quyết định hành động ngoài allowlist. Tên node và dữ liệu project được coi là dữ liệu, không phải chỉ dẫn cho AI.
- Tạo ảnh/video là tác vụ bất đồng bộ. Batch phải là **bước cuối** trong một kế hoạch; khi batch hoàn tất, người dùng giao bước tiếp theo. Chưa có bộ điều phối nền chạy trọn “ảnh → video → dựng phim” khi đóng trình duyệt. Không diễn giải câu trả lời AI như cam kết tác vụ đã hoàn tất.
- Render video vẫn giữ xác nhận ảnh cũ và xác nhận batch của app. Trước khi duyệt, kiểm số node, provider và chi phí render. Nếu AI không tìm đúng node hoặc yêu cầu mơ hồ, nó phải hỏi lại.
- API key do người dùng tự nhập vào app; không dán vào chat này. Phản hồi HTTP lỗi từ Claude được báo ngắn gọn, key không được log.

## Kiểm thử / ghi chú module

- `lib/assistant-claude.mjs`: khóa bí mật, model, Workspace ID và Claude Messages API.
- `lib/assistant-plan.mjs`: ngữ cảnh rút gọn, lọc lịch sử chat, parser JSON, allowlist và preview đã xác thực.
- `lib/routes/assistant.mjs`: route trạng thái/cấu hình/lập kế hoạch, kiểm revision/project.
- `public/js/commands.js`, `public/index.html`, `public/style.css`, `public/locales/*.json`: chuỗi chat theo project, composer, trạng thái đang suy nghĩ, xác nhận và thực thi qua API studio sẵn có.
- `test-assistant-claude.mjs`: dùng mock HTTP, không gọi Claude thật; kiểm key, payload, selector, loại bỏ hành động lạ.
