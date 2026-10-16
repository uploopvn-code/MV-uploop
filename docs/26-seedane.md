# Seedane — tạo video Dola, ảnh/video Muse qua API nội bộ

Ngày: 2026-10-13. Seedane là tool desktop (Electron) tự động hoá Dola và Muse bằng nick của bạn.
Nó mở một API REST trên LAN (Seedane → Cài đặt → 🔌 API nội bộ; hợp đồng: `API-SERVER.md`
của Seedane, bản `2.1.5-recode.32`). Drama Tool gọi API đó như một **nguồn tạo** mới, chạy
thẳng từ server của tool — không cần extension, không cần mở tab.

## Cài

1. Seedane: bật API nội bộ (mặc định `0.0.0.0:8787`, IP được phép có `127.0.0.1`), copy token.
2. Drama Tool → **Kết nối web → Seedane**: địa chỉ (mặc định `http://127.0.0.1:8787`) + token →
   **Lưu**. Dòng trạng thái hiện phiên bản Seedane và số nick Dola/Muse sẵn sàng.
   Token lưu ở `data/seedane-token.txt` (hoặc biến `MV_SEEDANE_TOKEN`), không gửi về trình duyệt.

## Dùng

- Từng node: Inspector → **Nguồn tạo** → `Seedane · Dola` (video; model 2.5 = 10/15/30 giây,
  2.0 = 10/15 giây) hoặc `Seedane · Muse` (ảnh hoặc video). Ô **Nick** để trống = nick sẵn sàng
  đầu tiên.
- Cả project: ⚙ Project → nguồn mặc định `Seedane · Dola` / `Seedane · Muse`.
- Tạo video theo khu: bộ lọc nguồn có `Seedane (Dola / Muse)`. Quy trình tự chạy (docs/25) cũng
  chạy được qua Seedane vì nó dùng chung batch khu.
- Nhóm Seedance và phân cảnh ghép quay được qua `Seedane · Dola` (Dola chính là Seedance).

## Cách tool gọi

| Việc | Seedane API |
|---|---|
| gửi | `POST /v1/jobs` + `Idempotency-Key: <mã job của tool>` |
| Dola | `{platform:"dola", model, duration_sec, aspect_ratio, count, prompt, reference_images}` |
| Muse | `{platform:"muse", kind:"image"|"video", prompt, aspect_ratio, account?, reference_images}` |
| chờ | `GET /v1/jobs/:id` mỗi 5 giây (QUEUED/RUNNING/COMPLETED/FAILED) |
| lấy file | `GET /v1/jobs/:id/file?n=i` → lưu vào node (video thành node ở cột Video) |

- Ảnh tham chiếu gửi dạng data URL base64, cùng giới hạn 20 MB/ảnh, 40 MB/lệnh như Seedvis.
  Dola nhận tối đa 10 ảnh (2.5) / 9 ảnh (2.0); vượt thì tool dựng ảnh khung trước như với Seedvis.
- `duration_sec` = độ dài shot (nhóm Seedance: tổng các shot); Seedane tự làm tròn lên.
- Dola chỉ ra 16:9 hoặc 9:16 (Seedane tự ép tỉ lệ khác).
- Không có ảnh → text-to-video.
- **Không bao giờ tạo trùng:** mất phản hồi khi gửi → gửi lại cùng Idempotency-Key; app khởi
  động lại giữa chừng → tự hỏi lại Seedane đúng job đó; nút "Kiểm tra lại" cũng chỉ hỏi lại.
- Lỗi Seedane giữ nguyên mã (`[content_policy]`, `[generation_failed]`…) → thang tự sửa prompt
  (docs/19) nhận ra bị từ chối và tự sửa như với Seedvis.
- Extension không bao giờ nhận job Seedane.
- Chưa hỗ trợ: sửa ảnh, take hát nhép (Omni) — hai việc này vẫn qua Seedvis.

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/seedane-client.mjs` | **Mới** — gửi/chờ/tải, trạng thái, lưu địa chỉ + token |
| `lib/config.mjs`, `lib/public-state.mjs` | client `seedane`, cờ `seedaneConfigured` |
| `lib/routes/connections.mjs` | `GET/POST /api/seedane` |
| `lib/providers.mjs` | nguồn `seedane` (`seedaneSource`), mặc định project, trần ảnh Dola |
| `lib/projects.mjs`, `lib/routes/nodes.mjs` | mặc định `seedane-dola/muse`; PATCH `seedane` |
| `lib/jobs.mjs` | job Seedane (gồm nhóm Seedance + phân cảnh ghép qua Dola) |
| `lib/runner.mjs` | chạy job Seedane (16 song song), hỏi lại sau khởi động lại |
| `lib/routes/jobs.mjs` | extension không nhận job Seedane; "Kiểm tra lại" = hỏi lại cùng mã |
| `lib/auto.mjs` | batch ảnh/video theo khu nhận nguồn Seedane |
| `public/…` | ô chọn nguồn, mặc định project, bộ lọc khu, ô Kết nối Seedane |
| `test-seedane.mjs` | body đúng hợp đồng (trong `npm test`); `SEEDANE_LIVE=1` chạy thật Dola + Muse |

## Nhóm Seedance chọn Seedvis hoặc Dola (2026-10-13)

Dola chính là Seedance, nên **nhóm ở cột ⑨/⑩** chọn được nguồn quay: mở nhóm → **Nguồn**:
- **Seedance · Seedvis (API key)** — như cũ, chọn model (2.5 / 2.0 Fast).
- **Seedance · Dola (Seedane)** — qua nick Dola của Seedane; model **Dola 2.5** (tới 30 giây, 10 ảnh
  tham chiếu) hoặc **Dola 2.0** (tới 15 giây, 9 ảnh).

Cùng một storyboard + ảnh tham chiếu + prompt theo mốc giây; chỉ khác đường gửi. Nhóm chạy Dola
cũng có nút "↻ Kiểm tra lại" khi job treo (hỏi lại Seedane cùng mã, không render lại).

| File | Thay đổi |
|---|---|
| `lib/seedance.mjs` | `groupSource()` (seedvis/dola), `groupModel` map Dola→Seedance để tính độ dài & trần ảnh; `groupInfo` thêm `source`/`dolaModel`/`dolaConfigured` |
| `lib/auto.mjs` | `uncertainJobs` tính cả job Seedane của nhóm |
| `lib/routes/seedance.mjs` | recheck chỉ đòi key của đúng nguồn (Seedvis/Seedane) |
| `public/js/seedance.js` | ô Nguồn + model Dola, lưu `seedane.video`/tắt `seedvis.video` |
| `test-seedane.mjs` | nhóm chuyển Dola 2.0: trần 9, độ dài cả nhóm, job Seedane Dola |

## Phân cảnh ghép (⑦) chọn nguồn Seedvis / Dola (2026-10-13)

Giống nhóm Seedance, mở node **Phân cảnh ghép** → **Nguồn**:
- **Seedvis API** — chọn model (Veo 3.1 / Seedance 2.5 / 2.0 Fast / Omni Flash) + tỉ lệ.
- **Seedane · Dola** — Dola 2.5 (10 ảnh khung) hoặc Dola 2.0 (9 ảnh khung).

Phân cảnh ghép quay 2–3 khung trong một clip, nên model phải nhận đủ số ảnh khung đó. Lưu
`seedane.video={platform:'dola',model}` + tắt `seedvis.video` (và ngược lại).

| File | Thay đổi |
|---|---|
| `public/js/merged.js` | ô Nguồn + model Dola; `applyModel` lưu seedvis/seedane |
| `test-director.mjs` | phân cảnh ghép chuyển Dola 2.0 (trần 9) rồi về Seedvis |
