# Drama Tool · Web Worker (extension Chrome/Edge)

Extension này biến trình duyệt của bạn thành **worker** cho Drama Tool: nhận job từ app và chạy
bằng chính phiên đăng nhập của bạn. Có **ba worker bật/tắt riêng, chạy song song được**:

- **🖼️ ChatGPT** — `kind: image` và `kind: text`:
  - **Tạo ảnh**: node ảnh đặt nguồn "ChatGPT (extension)" → extension tạo ảnh, trả về node.
  - **Đạo diễn AI (văn bản)**: mục "Đạo diễn AI" bật "Chạy qua extension" → gõ prompt vào ChatGPT,
    bóc **văn bản** (kịch bản / blueprint) trả về app — **không cần API key**.
- **🎬 Google Vids** — `kind: video` (job gắn `site: googlevids`): node video đặt nguồn
  "Google Vids (extension)" → extension điều khiển Google Vids, điền prompt, chọn 1080p, bấm Tạo,
  bắt URL video 1080p rồi tải MP4 về node. **Không cần API key** — dùng phiên Google của bạn.
- **🎥 Muse chat** — `kind: image` hoặc `kind: video` (job gắn `site: musechat`): node ảnh/video đặt nguồn
  "Muse chat (extension)" → extension mở một tab muse.ai riêng cho từng job, điền prompt và ảnh tham
  chiếu tùy chọn, bắt asset mới rồi tải về node. **Không cần API key** — dùng phiên Muse của bạn.

Cả ba dùng chung giao thức worker có sẵn (`/api/worker/claim` → `heartbeat` → `complete`), xác
thực bằng **worker token** (một token dùng chung cho cả ba).

## 1. Cài extension (chế độ Developer)

1. Mở `chrome://extensions` (Chrome) hoặc `edge://extensions` (Edge).
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** → chọn thư mục `extension/` này.
4. Ghim extension ra thanh công cụ cho tiện.

## 2. Cấu hình chung

1. Mở Drama Tool (`npm start`, mặc định `http://127.0.0.1:7788`).
2. Lấy **worker token**: file `worker-token.txt` trong thư mục dữ liệu của app
   (mặc định `C:\Users\<bạn>\MV-Director-data\worker-token.txt`; app in đường dẫn ở mục "Kết nối web").
3. Bấm icon extension → dán **Địa chỉ Drama Tool** + **Worker token** → **Kiểm tra kết nối**.

## 3. Bật worker ChatGPT (tạo ảnh / Đạo diễn)

1. Đăng nhập **chatgpt.com** trong trình duyệt này (một lần).
2. Trong popup, phần **ChatGPT**: đặt **Số luồng** (mặc định 2, tối đa 6; nên để 1–2) → **Bật
   worker ChatGPT**. Số đã lưu từ bản cũ được giữ nguyên.
3. Trong app: node ảnh → **Nguồn tạo** → **ChatGPT (extension)** → Lưu → **Tạo ảnh**.
   Extension tự mở tab ChatGPT nền dùng chung phiên đăng nhập.

### Ảnh về muộn và lấy lại ảnh (từ 0.4.0)

ChatGPT vẽ ảnh **ngầm**: chữ trả lời xong và nút Dừng biến mất trước, ảnh tới sau vài chục giây đến
vài phút. Worker xử lý như sau:

- **Giữ worker sống**: khi còn job, extension gọi một API của Chrome mỗi 20 giây để Chrome không tắt
  service worker giữa chừng (trước đây đây là nguồn lỗi "Worker mất kết nối").
- **Báo đã gửi + link hội thoại**: ngay khi prompt được gửi và khi ChatGPT đặt link `/c/<id>`,
  extension báo cho app (kèm heartbeat 10 giây/lần). App lưu link này cho job.
- **Lỗi trước khi gửi** (chưa đăng nhập, tải ảnh tham chiếu lỗi, tab không mở…): job thành *lỗi*,
  chạy lại an toàn. **Lỗi sau khi gửi** (không thấy ảnh, quá giờ, mất kết nối tab): job thành *cần
  kiểm tra* kèm link hội thoại và đoạn chữ ChatGPT trả lời (nếu có) — ảnh có thể vẫn đang được vẽ.
- **Lấy lại ảnh** (job `recover`): app tự xếp lại job đó sau ít phút (tối đa 2 lần, chỉ khi đúng
  worker đã chạy nó còn online) hoặc khi bạn bấm nút trong hàng đợi. Extension mở lại **đúng hội
  thoại đó** và lấy ảnh mới nhất — **không gửi prompt lại, không tốn thêm lượt**.
- **Gửi kết quả bền hơn**: nếu app đang bận/khởi động lại, extension gửi lại kết quả sau 2, 5, 15,
  30, 60 giây; ảnh về muộn vẫn được app nhận (chỉ gắn vào node nếu node chưa đổi ảnh / chưa có job
  mới hơn).
- **Giãn cách gửi**: hai prompt không được gửi cách nhau dưới 15 giây (tránh ChatGPT trả chữ "đợi
  ảnh hiện tại" thay vì ảnh). Mỗi lệnh có giới hạn: 10 phút cho ảnh / lấy lại ảnh, 12 phút cho
  Đạo diễn.
- Tab worker được đặt **không bị Memory Saver loại bỏ** (`autoDiscardable: false`).

## 4. Bật worker Google Vids (tạo video)

1. **Đăng nhập Google** trong trình duyệt này (bắt buộc — worker tự mở/tạo video bằng phiên này).
   Không cần tự mở video: với mỗi job, worker **tự tạo một video Vids mới** trong một tab nền của
   riêng nó (không đụng vào video bạn đang mở, không chồng tab).
2. Trong popup, phần **Google Vids**: **Bật worker Google Vids**.
3. Trong app: node video → **Nguồn tạo · Tạo video** → **Google Vids (extension)** → Lưu →
   **Tạo video**. Prompt chỉ cần chữ; ảnh keyframe/ingredient là tùy chọn (nếu node có ảnh hoặc
   node nối vào, extension đính làm nhân vật/ingredient trong Vids).
4. Mỗi job, worker **tạo một video mới**, điền prompt, cố gắng chọn **1080p**, bấm **Tạo**, chờ dựng
   xong (tối đa 8 phút), bắt URL video đã ký rồi tải MP4 về node (một node video đầu ra trong cột
   Video). Video "nháp" mỗi lần render sẽ nằm lại trong Google Drive của bạn.

> Google Vids chạy **tuần tự từng video** (1 luồng). Hai worker độc lập: bật ChatGPT mà không bật
> Google Vids, hoặc ngược lại, hoặc bật cả hai cùng lúc — claim theo sức chứa nên worker này rảnh
> không giành slot của worker kia.
>
> **Tạo video mới mỗi lần render**: vì mỗi job là một tài liệu Vids mới tinh (trang chưa từng
> generate), **đường tắt replay sẽ không kích hoạt** — mỗi job chạy bằng UI automation. Replay chỉ
> nhanh khi tái dùng chung một doc. Muốn đổi cách này, báo để chỉnh `createFreshVidsDoc`/`startVidsJob`.

### Replay nhanh (bỏ qua giao diện)

Để tạo video nhanh hơn, worker có **đường tắt replay**: hook trong tab Vids ghi lại *hình dạng* của
một request "generate" thật (URL + header + payload) làm **mẫu**, rồi những job sau gửi thẳng request
đó với prompt mới — không cần điều khiển giao diện nữa.

- **Warm-up**: job **đầu tiên** mỗi phiên (khi chưa có mẫu) vẫn chạy bằng giao diện; chính nó dạy
  cho hook một mẫu. Các job **text-to-video** sau đó dùng replay và nhanh hơn hẳn.
- **Khi nào replay / khi nào giao diện**: job **chỉ có chữ** → replay; job **có ảnh nhân vật/ingredient**
  → luôn chạy giao diện (replay chưa đính được ảnh tải mới). Replay thất bại (token hết hạn, Google
  đổi payload, bị từ chối nội dung) → tự lùi về giao diện.
- **Không cần thêm quyền**: mẫu được đọc ngay trong trang (hook `fetch`/`XHR`), không dùng
  `webRequest` hay đọc cookie.
- **Chống tạo 2 lần**: một khi request replay đã được Google **chấp nhận** (có thể đã bắt đầu dựng và
  tính quota), worker **cam kết** đi theo replay và **không bao giờ** bấm Tạo trên giao diện lần nữa.
  Chỉ lùi về giao diện khi request replay **bị từ chối / lỗi HTTP** (chưa khởi tạo gì). Nếu replay
  được chấp nhận nhưng không trả preview đồng bộ, worker **tắt replay cho hết phiên** (các job sau
  dùng giao diện) để không phí thêm lượt.

## 5. Bật worker Muse chat (tạo video)

1. Đăng nhập **https://muse.ai** trong trình duyệt này.
2. Trong popup extension: bật **worker Muse chat**. Worker Muse mở **một tab nền riêng cho từng job**,
   nên có thể chạy song song nhiều video.
3. Trong app: node video → **Nguồn tạo** → **Muse chat (extension)** → Lưu → **Tạo video**.
   Hoặc đặt nguồn mặc định video của project là Muse chat.
4. Extension tự điền prompt và ảnh tham chiếu tùy chọn, chờ video khoảng 10 giây, tải MP4 về node rồi
   đóng tab. `MUSECHAT_NEW_CHAT_URL` trong `background.js` có thể chỉnh nếu Muse đổi URL chat mới.

### Job/site routing

Claim có thể gửi `sites` để server chỉ giao đúng site:

```json
{ "name": "Drama worker #a1b2c3", "kinds": ["video"], "sites": ["musechat"] }
```

Job Muse có `kind: "video"`, `payload.site: "musechat"`, `prompt` và `references`. Worker Vids không
claim nhầm job Muse; heartbeat/complete/fail giữ nguyên giao thức cũ.

### Hiệu chỉnh giao diện Muse

Các selector trong `museChatDriveUi` là heuristic. Nếu Muse đổi giao diện, mở F12 trên chat đã đăng nhập:

```js
document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]').length
```

Nếu không có ô chat hoặc nút gửi, chỉnh hàm `museChatDriveUi` trong `background.js`. Hook
`content-musechat-hook.js` bắt URL từ network/DOM theo `queueId`, sau đó worker tải MP4 bằng phiên Muse.

## 6. Chạy song song (nhiều luồng / nhiều tài khoản / nhiều project)

- **Số luồng ChatGPT**: mỗi luồng một tab, tối đa 6 mỗi tài khoản nhưng **nên để 1–2** (ChatGPT giới
  hạn số ảnh vẽ cùng lúc mỗi tài khoản). Nhiều hơn: cài extension ở nhiều **profile trình duyệt**,
  mỗi profile một tài khoản ChatGPT, trỏ cùng Drama Tool + cùng token. Job lấy lại ảnh chỉ chạy trên
  đúng profile (tên worker) đã gửi prompt, vì hội thoại nằm trong tài khoản đó.
- **Nhiều project**: mỗi project mở một cửa sổ Drama Tool (cổng 7788, 7789…), hàng đợi riêng. Dán
  địa chỉ cửa sổ nào cũng được — extension hỏi `GET /api/worker/windows` để rút việc luân phiên từ
  tất cả cửa sổ.
- **Trần phía app**: `MV_WORKER_CONCURRENCY` (mặc định 12) chỉ là van an toàn mỗi cửa sổ; trần thật
  của ChatGPT là số tab ở trên.

## 7. Khi lỗi

- **Token sai / không gọi được máy chủ**: kiểm tra app đang chạy và token đúng.
- **Chưa đăng nhập ChatGPT/Muse/Google**: mở trang tương ứng, đăng nhập, thử lại.
- **Muse chat: không điều khiển được giao diện**: kiểm tra đã đăng nhập muse.ai; nếu Muse đổi layout,
  hiệu chỉnh `museChatDriveUi` và selector trong `background.js`.
- **Muse chat: hết 10 phút không có video**: kiểm tra quota Muse và hook `content-musechat-hook.js`;
  job sẽ chuyển sang cần kiểm tra.
- **Google Vids: "Chưa mở tài liệu Google Vids"**: worker chỉ dùng tab Vids bạn mở sẵn — mở một
  video và để tab đó mở.
- **Google Vids: không thấy ô prompt / nút Tạo**: mở đúng một video và bảng tạo video (Video AI),
  rồi thử lại. Google hay đổi giao diện → có thể phải chỉnh selector trong
  `content-gvids-hook.js` (bắt URL) và hàm `gvidsDriveUi` trong `background.js` (điều khiển UI).
- **Replay báo "replay chưa dùng được…" rồi lùi về giao diện**: bình thường ở job đầu phiên (chưa có
  mẫu) hoặc khi token/payload của Google đổi. Nếu replay **luôn** hỏng, Google có thể đã đổi hình dạng
  payload generate → `gvidsReplay` trong `background.js` dò prompt bằng chuỗi văn bản dài nhất; chỉnh
  lại `GEN` (nhận diện endpoint) trong `content-gvids-hook.js` hoặc tạm chỉ dùng giao diện vẫn chạy tốt.
- **Hết lượt / quota Google Vids**: worker báo job *cần kiểm tra* trong app; chờ reset hoặc đổi
  tài khoản Google.
- **CAPTCHA / xác minh / bị từ chối nội dung**: job ở trạng thái *cần kiểm tra*; xử lý thủ công rồi
  tạo lại. Worker không tự vượt xác minh.
- ChatGPT đổi giao diện → chỉnh selector trong `content-chatgpt.js` (`EDITOR`, `SEND`, `STOP`,
  `NEWCHAT`, `resultImages()`).
- **Ảnh có trên ChatGPT nhưng chưa về app**: xem job *cần kiểm tra* trong hàng đợi — app tự lấy lại
  hoặc bấm nút lấy lại (cần worker ChatGPT bật, đúng profile). Đổi **tên worker** trong popup sẽ làm
  job lấy lại của tên cũ không còn ai nhận.

## 8. Quyền (manifest)

- `http://127.0.0.1/*`, `http://localhost/*`: gọi API worker + tải ảnh tham chiếu của app.
- `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://*.oaiusercontent.com/*`: điều khiển
  ChatGPT và tải ảnh vừa tạo.
- `https://docs.google.com/*`, `https://*.google.com/*`, `https://*.googleusercontent.com/*`: điều
  khiển Google Vids và tải video 1080p đã ký.
- `https://muse.ai/*`: điều khiển Muse chat và tải video bằng phiên đăng nhập.
- `storage` (cấu hình), `alarms` (đánh thức worker), `tabs`/`scripting` (điều khiển tab).

Extension **không** đọc mật khẩu và **không** gửi dữ liệu đi đâu ngoài máy chủ Drama Tool cục bộ,
ChatGPT, Google Vids và Muse. Việc tự động hóa các dịch vụ bằng phiên của bạn có thể vi phạm điều
khoản dịch vụ của họ và có rủi ro cho tài khoản — cân nhắc dùng tài khoản phụ.
