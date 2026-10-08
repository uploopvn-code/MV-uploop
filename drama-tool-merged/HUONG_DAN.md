# HƯỚNG DẪN ĐẦY ĐỦ — Drama Tool Web Worker (bản gộp 3 worker)

Bản này = extension gốc của bạn (v0.4.0) + worker **Muse chat** tích hợp sẵn.
Ba worker bật/tắt riêng, chạy song song:

| Worker | Việc | Site job |
|---|---|---|
| 🖼️ ChatGPT | tạo ảnh, Đạo diễn AI (text), lấy lại ảnh | `image` / `text` / `recover` |
| 🎬 Google Vids | tạo video (tuần tự) | `video` + `site: googlevids` |
| 🎥 Muse chat | tạo video qua web chat muse.ai (**không giới hạn tab, mỗi lệnh 1 tab riêng**) | `video` + `site: musechat` |

---

## 1. Chuẩn bị

1. Chrome/Edge bản mới.
2. Đăng nhập `https://muse.ai` (cho worker Muse chat), `chatgpt.com` (nếu dùng
   worker ChatGPT), Google (nếu dùng worker Google Vids) — mỗi thứ một lần.
3. App Drama Tool đang chạy (`npm start`, mặc định `http://127.0.0.1:7788`).
4. Worker token: file `worker-token.txt` trong thư mục dữ liệu app
   (thường `C:\Users\<bạn>\MV-Director-data\worker-token.txt`).

## 2. Cài extension (thay bản cũ)

1. Giải nén zip ra thư mục cố định.
2. `chrome://extensions` → bật **Developer mode** → **Remove** bản cũ (0.4.0)
   nếu còn → **Load unpacked** → chọn thư mục `extension/`.
   (Gỡ bản cũ để tránh hai worker cùng claim job.)
3. Ghim extension ra thanh công cụ.
4. Mở popup → nhập địa chỉ Drama Tool + token → **Kiểm tra kết nối** → bật
   **worker Muse chat** (và các worker khác nếu muốn).

## 3. Bổ sung phía máy chủ (một thay đổi duy nhất)

`POST /api/worker/claim` giờ gửi kèm `sites` (optional, tương thích ngược):

```json
{ "name": "Drama worker #a1b2c3", "kinds": ["video"], "sites": ["musechat"] }
```

Logic chọn job video (ví dụ Node.js):

```js
function pickVideoJob(body) {
  const q = videoQueue.filter(j => j.status === 'queued');
  if (Array.isArray(body.sites) && body.sites.length) {
    return q.find(j => body.sites.includes(j.payload && j.payload.site)) || null;
  }
  return q[0] || null; // hành vi cũ cho extension bản trước
}
```

`heartbeat` / `complete` / `fail` giữ nguyên.

**Format job cho worker Muse chat** (khi node video chọn nguồn
"Muse chat (extension)"):

```json
{
  "kind": "video",
  "nodeId": "node-abc123",
  "payload": {
    "site": "musechat",
    "prompt": "anh chàng mặt vui cười khi đánh đàn",
    "references": []
  }
}
```

- `payload.references`: ảnh tham chiếu, format y hệt job Google Vids:
  `[{ "asset": { "url": "/api/...", "mime": "image/png", "name": "ref.png" } }]`
- File trả về: `<nodeId>.mp4` (base64 qua `complete`).

## 4. Luồng một job Muse chat

1. Worker claim `kinds:["video"]`, `sites:["musechat"]` → nhận job.
2. Mở **tab nền mới** tới `MUSECHAT_NEW_CHAT_URL` (`background.js`,
   mặc định `https://muse.ai/` — hiệu chỉnh nếu URL chat mới khác).
3. Gắn hook, đánh dấu job active theo id.
4. Đính ảnh tham chiếu (nếu có) → gõ prompt → gửi.
5. Chờ video (tối đa 10 phút), heartbeat 10s/lần.
6. Hook bắt URL video **trùng id job** (qua network hoặc thẻ `<video>` trong DOM)
   → tải MP4 → base64 → `complete`.
7. **Đóng tab.** Lỗi → `fail`, job sang *cần kiểm tra*.

## 5. Hiệu chỉnh giao diện chat (một lần)

Selector trong `museChatDriveUi` (`background.js`, đánh dấu `CALIBRATE`) là
heuristic. Kiểm tra nhanh trên trang chat đã đăng nhập (F12 → Console):

```js
document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]').length
```

- Ra `0` → tìm selector đúng trong tab Elements (chuột phải ô chat → Inspect)
  rồi sửa trong `museChatDriveUi`.
- Nút gửi không tìm thấy → worker tự dùng phím **Enter** (đã có fallback).

Test: xếp 1 job → mở console Service Worker
(`chrome://extensions` → Service Worker) → thấy `✓ xong video xxxxxxxx`
và node trong app nhận MP4 là đạt. Test 3 job cùng lúc để kiểm tra
"mỗi lệnh 1 tab, tải đúng video".

## 6. Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| `Token sai` | copy lại từ `worker-token.txt` |
| `Không gọi được máy chủ` | kiểm tra app Drama Tool đã chạy |
| `không điều khiển được giao diện chat` | đăng nhập muse.ai; nếu vẫn lỗi → mục 5 |
| `fail` sau 10 phút | kiểm tra tay tab chat; hết quota → chờ reset/đổi tài khoản |
| Hai extension cùng claim job | gỡ bản cũ 0.4.0, chỉ giữ bản gộp |

## 7. Giới hạn đã biết

- Mỗi clip Muse tạo khoảng **10 giây** (không chỉnh được) → cần dài hơn thì
  xếp nhiều job rồi ghép.
- Tài khoản miễn phí có giới hạn sử dụng; bulk tốn quota nhanh.
- Tự động hóa giao diện chat có thể vi phạm điều khoản — cân nhắc tài khoản phụ.

## 8. Cấu trúc file

```
extension/
├── manifest.json              # 0.5.0 — thêm quyền muse.ai + content script
├── background.js              # 3 worker: chatgpt / vids / musechat
├── content-chatgpt.js         # (gốc, không đổi)
├── content-gvids-hook.js      # (gốc, không đổi)
├── content-musechat-hook.js   # MỚI — bắt video đúng id job trong chat
├── popup.html / popup.js      # thêm thẻ worker Muse chat
└── README.md                  # (gốc)
```
