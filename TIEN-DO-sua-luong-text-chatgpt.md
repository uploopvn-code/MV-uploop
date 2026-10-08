# Tiến độ — Sửa lỗi "ChatGPT chạy xong nhưng không trả kết quả về tool" (luồng text)

_Cập nhật: 2026-10-07 · Nhánh: `claude/trusting-einstein-66djj4`_

## 1. Vấn đề

Chạy một lượt LLM qua extension ChatGPT (phân tích nhạc một nút, hoặc Đạo diễn) thì
**ChatGPT đã in xong kết quả trên web** (ví dụ CSV 82 dòng trong khối code), **nhưng tool
không nhận được / không cập nhật**. Ảnh chụp cho thấy ChatGPT dùng công cụ phân tích
("Analyzed" ×7, "Result 82") rồi mới in CSV.

## 2. Nguyên nhân gốc

Luồng text đi: `runTurn('web')` → `runViaExtension` → job `kind:'text'` →
`background.js startChatgptJob` (nhánh text) → `runInTab cmd:'ask'` →
`content-chatgpt.js runAsk` → **`waitForReply` cạo `innerText` từ DOM** (đòi text "đứng yên 3s").

- CSV dài nằm trong **khối code bị ChatGPT ảo hóa (virtualize)** → `innerText` chỉ trả về
  các dòng đang hiển thị và **thay đổi liên tục** → text không bao giờ "đứng yên" → chờ tới
  hết watchdog 12 phút → job treo ("chưa cập nhật"), rồi cuối cùng trả về **CSV cắt cụt**.
- Các bước "Analyzed" (công cụ phân tích) còn làm nhiễu phân biệt "reply mới vs cũ".
- Khác với **luồng ảnh** đã làm chắc trước đây (đọc từ backend API của ChatGPT,
  DOM chỉ là dự phòng), luồng text vẫn hoàn toàn dựa vào DOM → đây là lỗ hổng.

## 3. Đã sửa (chỉ trong `extension/content-chatgpt.js`)

1. **`convState(cid)`**: phân loại tin nhắn sau lượt user cuối. Chỉ gom vào `said.assistant`
   các tin **hướng tới người dùng** (`role==='assistant' && recipient==='all' &&
   content_type ∈ {text, multimodal_text}`) — **loại** code Python/tool-call và reasoning;
   gom `said.tool` khi `role==='tool'`. Thêm trả về **`fullText = said.assistant.join('\n\n')`**
   (toàn bộ, không cắt). Phần gom `image_asset_pointer` và `finished` **giữ nguyên** → luồng ảnh
   không bị ảnh hưởng.
2. **`waitForText(job, timeout)`** (mới, thay `waitForReply`): mỗi 1.5s gọi `convState(cid)`;
   giữ `reply = st.fullText` khi nó lớn dần; khi `st.finished` → trả `st.fullText` (nếu rỗng thì
   lấy DOM `replyText()` cho trường hợp canvas). DOM chỉ dùng dự phòng khi `!cid` hoặc `apiErrs>=3`.
   Xử lý: `blocker()` (giới hạn tốc độ / Cloudflare / đăng xuất), backoff 429, `noSession`,
   kiểm "prompt chưa gửi" ở mốc 30s, và khi hết giờ trả về phần đầy đủ nhất đã thấy thay vì rỗng.
3. **`runAsk`**: gọi `waitForText(job, 600000)`; bỏ snapshot `before` trước khi gửi.
4. Xóa `waitForReply` và `replyCount` (chết). `replyText` / `isStreaming` vẫn dùng cho dự phòng DOM.

> Sửa này cải thiện **cả** phân tích nhạc một nút **và** Đạo diễn (đều qua `runAsk`).
> `extractCsv` (lib/music-auto.mjs) bắt khối ` ```csv ` trong `fullText` nên vẫn nhận đúng CSV
> kể cả khi có câu dẫn bao quanh.

## 4. Trạng thái

- [x] Viết code 4 chỗ sửa ở trên.
- [x] `npx prettier --write` sạch; `node --check` cú pháp OK.
- [ ] **Rà soát đối kháng CHƯA XONG** — workflow `review-chatgpt-text-fix`
      (run `wf_084b6a4b-acd`) đã chạy nền nhưng **bị ngắt trước khi hoàn tất** ở phiên trước
      (không có bản ghi kết quả). Cần chạy lại / rà soát lại.
- [ ] **CHƯA kiểm chứng live** (cần ChatGPT thật + bài nhạc thật; Demucs chậm).
- [ ] **CHƯA commit** (chờ yêu cầu).

## 5. Bước tiếp theo

1. Chạy lại rà soát: `Workflow({scriptPath: ".../review-chatgpt-text-fix-wf_084b6a4b-acd.js",
   resumeFromRunId: "wf_084b6a4b-acd"})` — hoặc tự rà soát thủ công 3 góc: đúng đắn trích text ·
   hồi quy luồng ảnh dùng chung `convState` · độ bền/biên.
2. Sửa nốt các lỗi được xác nhận (nếu có).
3. Người dùng test thật 1 bài → nếu còn lệch thì tinh chỉnh.
4. Commit khi được yêu cầu.

## 6. File liên quan

- `extension/content-chatgpt.js` — nơi sửa (convState, waitForText, runAsk).
- `extension/background.js` — `startChatgptJob` nhánh text (~dòng 518), `TEXT_WATCHDOG_MS` 12 phút.
- `lib/routes/jobs.mjs` — `/api/worker/complete` nhánh text (~dòng 184) lưu `job.result.text`.
- `lib/director-web.mjs` — `runViaExtension`, `runTurn`.
- `lib/music-auto.mjs` — `extractCsv` (~dòng 219).
