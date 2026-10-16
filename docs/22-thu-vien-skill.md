# Thư viện SKILL theo thể loại + trợ lý can thiệp vào từng bước

## Thư viện skill

Thư viện master prompt giờ xếp theo **thể loại** (`GENRES` trong `lib/master-prompts.mjs`), không
theo "có sẵn / của tôi" — khi chọn, người dùng nghĩ *"mình đang làm phim kinh dị"*, không nghĩ
*"cái này ai viết"*.

| Thể loại | Skill dựng sẵn |
|---|---|
| MV ca nhạc | MV ca nhạc (concert) · **MV ballad Tây Ban Nha (sân khấu nhỏ)** |
| Drama / Phim truyện | Drama ngắn · Phim drama dài |
| Kinh dị · Hồi hộp | **Phim ngắn kinh dị 60–90 giây** |
| Hài · Đời thường | **Hài tình huống 30–45 giây** |
| Quảng cáo · TVC | **TVC sản phẩm 15 / 30 giây** |

`theme` (music/film) và `genre` là hai thứ khác nhau: một project `film` có thể là drama, kinh dị
hay quảng cáo.

### Mỗi skill khoá CẤU TRÚC, không tả cảm hứng

Đây là điểm khác giữa "một cục prompt" và một skill dùng được. Mỗi skill khoá luật riêng của
thể loại nó:

- **Kinh dị** — cấm tả bạo lực/máu (model video **từ chối dựng**, mất lượt render); tối đa MỘT
  shot thấy "thứ đó" và để ở hồi ba; sợ đến từ âm thanh **biến mất**, không từ tiếng rít.
- **Hài** — mặt tỉnh bơ, không nhìn ống kính; leo thang theo bộ ba; **máy tĩnh, cấm cận mặt**
  (cận mặt giết tiếng cười); cấm chế giễu ngoại hình/vùng miền/khuyết tật.
- **TVC** — MỘT lời hứa duy nhất; khoá nhãn/màu/tỉ lệ sản phẩm giữa các shot; nhịp cố định theo
  15s (2 shot) hay 30s (4 shot); cấm bịa công dụng.
- **MV ballad TBN** — một sân khấu duy nhất; `lyric` giữ **nguyên văn tiếng Tây Ban Nha** (tool
  nhúng thẳng chuỗi đó để nhép miệng, dịch là sai khẩu hình); nhịp 4 chặng.

Luật chung mọi skill, test kiểm tự động: phải nêu khối ```json xuất ra, phải khoá thời lượng
shot, và skill nào có nhân vật thì **bắt buộc câu nhân vật hư cấu** (thiếu là bộ lọc an toàn từ
chối).

Tên shot phải bắt đầu **S01, S02…** — tên file video lấy số đó để sắp thứ tự (xem `docs/21`).

## Trợ lý đạo diễn can thiệp vào từng bước

Hành động mới **`edit_stage`**: sửa kết quả một trạm của xưởng kịch bản rồi (mặc định) chạy tiếp
các trạm sau.

```
"Viết lại bước biên kịch: đổi kết thúc thành người mẹ tự nhận lỗi"
   → sửa n.stages.story
   → chạy tiếp ② ③ ④ ⑤ ⑥ → blueprint mới
```

Trước đây trợ lý chỉ sửa được **chữ trên node** (`name`, `prompt`, `videoPrompt`, `lyric`,
`desc`, `config`, `start`, `duration`). Giờ nó đụng được vào **thứ sinh ra cả graph**.

Bốn chốt an toàn (đều có test):

| Chặn | Vì sao |
|---|---|
| Bước không có trong chế độ đang chạy | nối node Nhạc vào thì bước của drama (`blocking`) không còn; báo kèm danh sách bước hợp lệ |
| Nội dung trống | xoá sạch một bước là hỏng cả chuỗi phía sau |
| Chạy tiếp khi bước TRƯỚC chưa chạy | xưởng sẽ chạy vào chỗ trống |
| Không có node Kịch bản | báo rõ thay vì lỗi khó hiểu |

Vẫn đi qua **preview + xác nhận** như mọi hành động khác, và lưu `before` để hoàn tác.

> ⚠ `edit_stage` phải gửi **nguyên văn bước mới**, không gửi diff — đã dặn trong
> `ASSISTANT_SYSTEM`.

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/master-prompts.mjs` | `GENRES`, `genreLabel()`, `genre` trên từng preset |
| `lib/master-prompts/*.txt` | **Mới**: `horror-short`, `comedy-short`, `tvc-product` (+ `mv-ballad-es`) |
| `lib/public-state.mjs` | gửi `promptGenres` cho trình duyệt |
| `public/js/director.js` | dropdown nhóm theo thể loại |
| `lib/assistant-plan.mjs` | hành động `edit_stage` + mô tả cho Claude |
| `public/js/commands.js` | áp `edit_stage`, gọi `/api/script/run?from=` |

## Kiểm thử

```powershell
node test-skill-library.mjs
```
