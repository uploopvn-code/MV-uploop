# Drama Tool · ChatGPT Worker (extension Chrome/Edge)

Extension này biến trình duyệt của bạn thành một **worker** cho Drama Tool: nó nhận job từ app và
chạy trên **ChatGPT** bằng chính phiên đăng nhập của bạn. Hai loại việc:

- **Tạo ảnh**: node ảnh đặt nguồn "ChatGPT (extension)" → extension tạo ảnh, trả về node.
- **Đạo diễn AI (văn bản)**: mục "3. Đạo diễn AI" bật **"Chạy qua extension"** → extension gõ
  prompt vào ChatGPT, chờ trả lời, bóc **văn bản** (kịch bản / blueprint) trả về app — **không cần
  API key**. Dùng chung đúng giao thức worker, chỉ khác job có `kind: "text"`.

Dùng chung giao thức worker có sẵn của app (`/api/worker/claim` → `heartbeat` → `complete`),
xác thực bằng **worker token**.

## 1. Cài extension (chế độ Developer)

1. Mở `chrome://extensions` (Chrome) hoặc `edge://extensions` (Edge).
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** → chọn thư mục `extension/` này.
4. Ghim extension ra thanh công cụ cho tiện.

## 2. Cấu hình

1. Mở Drama Tool (`npm start`, mặc định `http://127.0.0.1:7788`).
2. Lấy **worker token**: mở file `worker-token.txt` trong thư mục dữ liệu của app
   (mặc định `C:\Users\<bạn>\MV-Director-data\worker-token.txt`; app in đường dẫn dữ liệu ở
   mục "Kết nối web").
3. Bấm icon extension → dán **Địa chỉ Drama Tool** và **Worker token** → bấm **Kiểm tra kết nối**.
4. Đảm bảo đã **đăng nhập ChatGPT** trong trình duyệt này (mở chatgpt.com, đăng nhập một lần).
   Extension sẽ tự mở một tab ChatGPT nền dùng chung phiên đăng nhập đó.
5. Bấm **Bật worker**.

## 3. Giao việc từ app

Trong Drama Tool, mở một node ảnh → mục **Nguồn tạo** → chọn **ChatGPT (extension)** → Lưu.
Bấm **Tạo ảnh · ChatGPT**. Node tạo một job, extension nhận và chạy trên ChatGPT, ảnh xong tự
về node. Chuỗi ảnh tự động (`▶ tạo cả chuỗi`) cũng chạy được với node đặt nguồn ChatGPT.

## 4. Chạy song song (nhiều luồng / nhiều tài khoản)

- **Trong một tài khoản**: đặt **Số luồng cùng lúc** trong popup (mặc định 3, tối đa 6). Mỗi luồng
  là một tab ChatGPT riêng chạy song song. Lưu ý ChatGPT có thể tự giới hạn tần suất mỗi tài khoản.
- **Nhiều tài khoản (song song thật)**: mở nhiều **profile trình duyệt** (Chrome: biểu tượng người
  dùng → thêm profile), mỗi profile đăng nhập một tài khoản ChatGPT khác và cài extension này, trỏ
  về cùng Drama Tool + cùng token. Mỗi profile là một worker; app phát job cho tất cả. Badge trong
  app hiện số worker đang nối.
- **Nhiều project cùng lúc**: mỗi project mở ở một cửa sổ Drama Tool riêng, mỗi cửa sổ là một cổng
  riêng (7788, 7789…) và có hàng đợi riêng. **Dán địa chỉ cửa sổ nào cũng được** — extension hỏi
  `GET /api/worker/windows` để biết các cổng còn lại rồi rút việc luân phiên từ tất cả, nên không
  project nào bị bỏ đói và không cần đổi cấu hình khi bạn mở thêm project.
- **Trần phía app**: trần THẬT là số luồng tab ở trên, vì extension mới là nơi sở hữu tab ChatGPT.
  `MV_WORKER_CONCURRENCY` (mặc định 12) chỉ là van an toàn của **từng cửa sổ**, nên nhiều cửa sổ
  không cộng dồn thành trần thật — đừng dựa vào nó để giới hạn tài khoản.
- Chuỗi **"▶ tạo cả chuỗi"** vốn chạy **tuần tự theo phụ thuộc**; song song chỉ giúp khi có nhiều
  job độc lập trong hàng đợi (bấm Tạo ảnh nhiều node, hoặc nhiều account cùng rút hàng đợi).

## 5. Khi lỗi

- **Token sai / không gọi được máy chủ**: kiểm tra app đang chạy và token dán đúng.
- **Chưa đăng nhập ChatGPT**: mở tab chatgpt.com, đăng nhập, thử lại.
- **CAPTCHA / xác minh / ChatGPT từ chối**: job sẽ ở trạng thái *cần kiểm tra* trong app; xử lý
  thủ công trên tab rồi tạo lại. Worker không tự vượt xác minh.
- ChatGPT đổi giao diện → có thể phải chỉnh lại các selector trong `content-chatgpt.js`
  (các hằng `EDITOR`, `SEND`, `STOP`, `NEWCHAT`, và `resultImages()`).

## 6. Quyền (manifest)

- `http://127.0.0.1/*`, `http://localhost/*`: gọi API worker + tải ảnh tham chiếu của app.
- `https://chatgpt.com/*`, `https://chat.openai.com/*`: điều khiển trang ChatGPT.
- `https://*.oaiusercontent.com/*`: tải ảnh ChatGPT vừa tạo.
- `storage` (lưu cấu hình), `alarms` (đánh thức worker), `tabs`/`scripting` (điều khiển tab ChatGPT).

Extension **không** đọc mật khẩu và **không** gửi dữ liệu đi đâu ngoài máy chủ Drama Tool cục bộ
và ChatGPT.
