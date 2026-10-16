# Gói giao hàng (nút 📦 Đóng gói)

Một file zip duy nhất để giao cho người dựng hoặc lưu trữ: video đã render + đủ các bước kịch
bản + prompt/Bible/manifest.

```
<Tên project>-2026-10-12.zip
├── video/
│   ├── S01_Accusation Hook_v1.mp4
│   ├── S02_Denial and Reversal_v1.mp4
│   └── …
├── kich-ban/
│   ├── 01-bien-kich.md
│   ├── 02-dao-dien-hinh-anh.md
│   ├── 03-truc-blocking.md
│   ├── 04-bieu-cam.md
│   ├── 05-nhip-phim.md
│   ├── 06-rap-json.json
│   └── 07-qc-validator.md
├── prompts.json          prompt ảnh/video đã giải của từng shot + tham chiếu
├── bible.json            nhân vật, bối cảnh, trang phục, máy quay (dùng lại cho tập sau)
├── manifest-luong-A.csv  bảng dựng; cột ClipFile khớp đúng tên file trong video/
└── DOC-TRUOC.txt         tờ khai: trong gói có gì, thiếu gì
```

Khác hai thứ đã có: `/api/projects/package` là **sao lưu** cả project để mở lại, `/api/videos/zip`
chỉ tải **các clip được tick**. Gói này là bản giao hàng hoàn chỉnh.

## Tên file clip lấy số cảnh từ TÊN shot, không lấy `seq`

`videoFileName()` trong `lib/media.mjs` giờ đọc `S<số>` ở đầu tên shot và dùng nó làm tiền tố.

> ⚠ **`seq` KHÔNG đáng tin cho thứ tự cảnh.** Đo trên project thật
> ("MẸ CHỒNG MẤT 5 TRIỆU…"): hai shot **cùng seq 1** (S01 và S02 → trùng tên file), **seq 4 lại
> là cảnh S12** còn seq 5 là S03, và seq nhảy 6 → 9 → 10 → 13. Sắp file theo seq ra thứ tự loạn.
> Số S trong tên mới là thứ tự kịch bản.

| Tên shot | File |
|---|---|
| `S11 — Evidence Changes the Balance` | `S11_Evidence Changes the Balance_v1.mp4` |
| `S9 - Playback Decision` | `S09_Playback Decision_v1.mp4` |
| `Verse 1 — Chorus` (không có số S) | `07_Verse 1 — Chorus_v1.mp4` (theo `seq`, như cũ) |

Phần `S11 —` bị cắt khỏi tên để không thành `S11_S11 — …`.

> ⚠ **Độ rộng số phải đồng nhất trong cả project**, nếu không `S100` sắp trước `S11`. Phim 15
> phút có hơn trăm shot nên chuyện này xảy ra thật — `sceneWidth()` quét số cảnh lớn nhất rồi
> đệm theo nó (project có cảnh 100 thì S02 thành `S002`).

Đổi ở một chỗ nên **manifest, zip và thư mục làm việc đều đổi theo** — cột `ClipFile` vẫn khớp
tên file thật.

## Bảy bước kịch bản lấy động từ `stages()`

Không chép cứng danh sách: thêm/bớt trạm là gói đổi theo.

| Chế độ | Số bước |
|---|---|
| Drama **Kỹ** | 6 trạm + QC = **7** |
| Drama Nhanh | 3 trạm + QC = 4 |
| MV Kỹ | 5 trạm + QC = 6 |

Trạm chưa chạy **vẫn xuất file**, ghi rõ `(Trạm này chưa chạy)` — thiếu file thì người nhận phải
đoán, có file rỗng thì nhìn là biết.

## Hỏi trước khi tải

`GET /api/package/plan` trả bản kê (số clip, số bước, dung lượng, danh sách mục) → UI hiện hộp
xác nhận → `GET /api/package` mới dựng zip. Zip dựng hết trong RAM (trần 3 GB) nên không để
người dùng bấm mù.

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/package.mjs` | **Mới** — `buildPackage()`, `scriptFiles()`, `packageName()` |
| `lib/media.mjs` | `sceneTag()` + `sceneWidth()`; `videoFileName()` đặt S lên đầu |
| `lib/routes/files.mjs` | `GET /api/package` và `/api/package/plan` |
| `public/index.html`, `public/js/projects.js` | Nút 📦 Đóng gói + hộp xác nhận |
| `public/locales/*.json` | `header.package` |

## Kiểm thử

```powershell
node test-package.mjs
```

Tự **giải nén lại zip** (đọc central directory, inflate) rồi kiểm từng mục — không dùng thư viện
ngoài, nên kiểm đúng cái zip thật gửi cho người dùng. Gồm ca `S02 / S11 / S100` để bắt lỗi đệm
số, và ca shot không có số S.
