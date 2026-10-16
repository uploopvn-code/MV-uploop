# Phân cảnh ghép · nhịp cắt · nhận dạng nhân vật

Ghi chú thay đổi theo từng module, để lần sau sửa biết ngay phải mở file nào.

Hai việc lớn gộp ở đây vì chúng dùng chung một đường dữ liệu:

1. **Nhịp cắt tách rời khỏi ảnh** — một clip Veo 8 giây được tối đa **6 nhịp cắt** nhưng vẫn chỉ **≤3 ảnh tham chiếu**, vì các nhịp dùng lại cỡ cảnh (đối đáp nhanh A/B/A/B/trung đôi = 2–3 ảnh, 5 nhịp).
2. **Ảnh người dùng tự đưa vào là ảnh chính** — ảnh up tay được dùng thẳng, không bị đòi các trường Bible vốn chỉ cần khi hệ thống tự vẽ ảnh.

---

## Khái niệm phải nắm trước khi sửa

| Khái niệm | Nghĩa |
|---|---|
| **Khung (frame node)** | Một **ẢNH** cỡ cảnh, nằm ở cột ⑥ Sản xuất. Chỉ có 3 cỡ cảnh: `ots_a`, `ots_b`, `two_shot`. |
| **Nhịp (beat)** | Một **CÚ CẮT** trong clip 8s, có lời thoại riêng. Nhiều nhịp được dùng chung một khung. |
| `MAX_FRAMES = 3` | Trần **ẢNH** của Veo. Không phải trần cú cắt. |
| `MAX_BEATS = 6` | Trần **CÚ CẮT** trong một clip 8s. |
| `frameProblem` | "Có đủ dữ kiện để **VẼ** ảnh khung không?" → cần `identity_label`, `back_view`, câu staging. |
| `mergedProblem` | "Có đủ điều kiện để **QUAY** clip không?" → cần ảnh + dây nối + người nói hợp lệ. |

> **Đừng lẫn hai cái cuối.** Lẫn chính là nguồn gốc lỗi "up ảnh rồi mà vẫn không chạy".

---

## `lib/merged.mjs` — engine phân cảnh ghép (sửa nhiều nhất)

| Hàm | Thay đổi |
|---|---|
| `setupFrames(m)` | **MỚI.** Trả về các khung theo **cỡ cảnh khác nhau** (≤3) — đây mới là số ảnh gửi Veo. |
| `beatsOf(m)` | **MỚI.** Dòng nhịp cắt. Đọc `m.beats` nếu có; không có thì suy ra 1 nhịp/khung (giữ tương thích dự án cũ). |
| `split(counts, minBeat)` | Chia 8 giây. **Sàn động** `min(2, 8÷số nhịp)` để 5–6 nhịp ngắn vừa 8s. Khi làm tròn dư, **cắt bớt từ nhịp "rảnh" nhất (ít từ/giây nhất)**, không cắt từ nhịp dài nhất — cách cũ làm nhịp nhiều lời bị bóp còn 3s rồi báo "thoại quá nhanh". |
| `mergedPlan(m)` | Chạy theo nhịp. Nhịp im lặng `[Không thoại; …]` tính **0 từ**. |
| `mergedReferences(m)` | Trả **ảnh theo cỡ cảnh khác nhau** (≤3) — nhờ đó 6 nhịp vẫn lọt trần Veo. |
| `mergedPrompt(m)` | Mô tả ≤3 ảnh ở đầu (**đánh số `Image 1 = shot B…`**), nhận dạng nhân vật nêu **một lần** rồi các nhịp chỉ gọi mã NV. Luật khẩu hình ("chỉ người được nêu mới mấp máy môi") nêu **một lần** thay vì lặp sau mỗi cắt. Bỏ `@` và tên lặp trong `action`. Đuôi cuối và `roomSound` **không nhắc lại** các "no …" mà style/audio preset đã nói. Thiếu nhãn thì gọi bằng mã NV. |
| `mergedProblem(m)` | **Bỏ** lệnh cấm hai khung trùng cỡ cảnh (tái dùng giờ là tính năng). **Bỏ** gọi `frameProblem` — chỉ còn kiểm thứ clip thật sự cần: mỗi khung nối đủ **bối cảnh + 2 nhân vật**. Kiểm người nói / hướng mặt chạy **theo nhịp**. |
| `mergedInfo(m)` | Trả theo nhịp; thêm `images`, `beats`, `maxBeats`, `line`, `action`, `delivery`, `reuses`. Nhịp im lặng không bao giờ bị gắn cờ "quá nhanh". |

**Thứ tự kiểm trong `mergedProblem` rất quan trọng:** nó trả về **lỗi ĐẦU TIÊN**. Lỗi *"chưa có ảnh"* đứng trước nên **che** các kiểm tra sau. Muốn QC thật phải nạp ảnh cho mọi khung rồi mới đọc lại.

---

## `lib/prompts.mjs` — ai đang nói

`byName()` khớp tiền tố `Tên:` với nhân vật. Trước đây khớp cả khi **chỉ trùng từ đầu**, nên `"Người vợ"` khớp nhầm sang `"Người chồng"` (cùng chữ "Người") → nhép môi sai người. Nay chỉ khớp khi tên bắt đầu bằng cả cụm.

> Tiền tố thoại phải là **`name` của nhân vật trong Bible** (hoặc phần đầu của nó). Vai chung như `Chồng:` / `Vợ:` **không khớp** với nhân vật tên "Người chồng".

---

## `lib/library.mjs` — kho asset

Kho vốn chỉ nhớ `{image, name, role}` theo `assetKey`. Nay nhớ thêm **`label` + `back`**, và khi import lại chỉ **điền vào chỗ blueprint để trống** (blueprint luôn thắng).

Lý do: import từ một Bible cũ thiếu `identity_label` sẽ xoá sạch giá trị đã sửa tay, làm hỏng lại toàn bộ khung thoại.

> ⚠ **Cố ý KHÔNG nhớ `code` và `anchors`.** Hai trường đó đặt tên nhân vật trong *mọi* prompt; khôi phục nhầm sẽ đổi tên một nhân vật mà blueprint mới muốn gọi bằng tên thật (đã làm `test-director` đỏ: mong "Ann", nhận "NV1").

---

## `director.mjs` — import blueprint (`buildMerged`)

- Nhận tới **6 setup** (trước cắt còn 3).
- **Có cỡ cảnh lặp lại** → dựng **1 node khung cho mỗi cỡ cảnh khác nhau** (không mang lời) + ghi `beats` lên node ghép.
- **Không lặp** → giữ nguyên đường cũ: 1 khung/setup, lời nằm trên khung.

Nhờ nhánh đôi này, dự án cũ import lại vẫn ra đúng cấu trúc cũ.

---

## `lib/routes/nodes.mjs` — API sửa node

- `PATCH /api/node` nhận `code` / `label` / `back` / `anchors` cho **node nhân vật**. Các trường này chỉ nuôi prompt phân cảnh ghép (tính lại mỗi lần), nên **không** làm cũ ảnh hay clip đã render.
- `PATCH /api/node` nhận `beats` cho **node ghép**; đổi nhịp thì đánh dấu clip cần quay lại.

---

## Giao diện

| File | Thay đổi |
|---|---|
| `public/js/wardrobe.js` | **MỚI** `identityPanel(n)` — ô nhập *Mã · Nhãn nhận dạng · Tả lưng · Neo ngoại hình* cho node nhân vật. Trước đây các trường này chỉ vào được qua import, không sửa được ở đâu cả. |
| `public/js/inspector.js` | Gọi `identityPanel`, bind thay đổi, lưu 4 trường trong `saveNode()`. |
| `public/js/merged.js` | Danh sách nhịp hiện **lời từng nhịp**, đánh dấu **"↩ dùng lại ảnh cỡ cảnh này"**, và cho sửa lời ngay tại chỗ khi có tái dùng. |

---

## Ảnh tham chiếu nhân vật — tool sở hữu bố cục sheet

Model sheet nhân vật là **một chân dung lớn bên trái + 3 góc toàn thân (trước / nghiêng / sau)**
cùng tỉ lệ trên một đường chân, nền xám, cùng hướng sáng, không nền cảnh, không chữ.

Prompt đó do **tool dựng** (`lib/prompts.mjs`, biến `character`). Blueprint **chỉ cung cấp MÔ TẢ
NGOẠI HÌNH**, và import đặt nó vào `desc` để tool bọc — **giống hệt** cách xử lý vật dụng, trang
phục và bối cảnh (`director.mjs`, chỗ `isItem || isWardrobe || isChar || (isScene && !ofKey)`).

> **Lỗi cũ:** nhân vật là loại asset DUY NHẤT bị bỏ sót khỏi luật này — `prompt` của blueprint
> ghi đè lên sheet. Một dòng blueprint kiểu *"Photorealistic character reference @NV1, a
> 59-year-old woman…"* không hề nói turnaround, nên ảnh ra chỉ là một chân dung đơn.

Hệ quả cần nhớ khi sửa:
- `lib/bible.mjs` xuất `prompt: n.prompt || n.desc` cho nhân vật — nếu chỉ lấy `n.prompt` thì vòng
  xuất/nhập lại sẽ mất mô tả.
- Muốn **tự viết sheet riêng** cho một nhân vật: import xong rồi sửa ô *Prompt ảnh* của node trong
  Inspector (prompt viết tay vẫn thắng `desc`).
- Mô tả nên **thuần ngoại hình**. Câu chỉ đạo diễn xuất ("Expressions progress…"), ghi chú liên tục
  ("Preserve exact identity across all scenes") và thông số render ("vertical 9:16, no text") làm
  nhiễu sheet — sheet đã tự lo các phần đó.

---

## Tra lỗi nhanh

| Triệu chứng | Mở file nào |
|---|---|
| *"thiếu identity_label"* khi **tạo ảnh khung** | Đúng nghiệp vụ — điền ở Inspector → panel **② Nhận dạng**, hoặc sửa Bible nguồn. |
| *"thiếu identity_label"* khi **quay clip ghép** | Sai — `mergedProblem` không được gọi `frameProblem`. Xem `lib/merged.mjs`. |
| Sửa nhãn xong, import lại **mất tiếp** | `lib/library.mjs` — kho phải nhớ `label`/`back`. Và vá luôn Bible nguồn. |
| *"thoại quá nhanh"* ở nhịp **im lặng** | `mergedInfo` — nhịp `noLine` phải tính 0 từ. |
| *"thoại quá nhanh"* mà lời đã ngắn | `split()` — kiểm cách cắt bớt giây theo từ/giây. |
| *"phải viết Tên: …"* | Tiền tố thoại phải khớp `name` nhân vật. Xem `byName` trong `lib/prompts.mjs`. |
| *"Hãy tạo hoặc tải ảnh các node nối vào trước"* | Đúng nghiệp vụ: muốn **vẽ** ảnh khung thì bối cảnh + cả 2 nhân vật phải có ảnh. |
| Bị ép 3 cú cắt | `MAX_BEATS` trong `lib/merged.mjs` + `buildMerged` trong `director.mjs`. |

---

## Ngân sách chữ theo số nhịp

Tool chia 8 giây theo số từ rồi **làm tròn về giây nguyên**, nên:

| Số nhịp | Mỗi nhịp | Lời nên ≤ |
|---|---|---|
| 4 | ~2s | 5–6 chữ |
| 5 | 1–2s | 4–5 chữ |
| 6 | phần lớn 1s | **3 chữ** |

Dùng 6 nhịp đúng chỗ staccato (truy vấn, cao trào); đoạn cần câu dài thì giảm còn 4–5 nhịp.

---

## Kiểm tra

```powershell
node test-seedvis.mjs
```

Bao gồm: cụm `setups` → khung + 1 clip Veo, chia 8s theo độ dài lời, **đối đáp nhanh dùng lại ≤3 ảnh cho tới 6 cú cắt**, và **import lại từ Bible cũ không xoá `identity_label`, thay ảnh bằng upload vẫn chạy**.

Script này còn **cảnh báo mô tả bạo lực** trong `videoPrompt`/`action` (model video sẽ từ chối dựng và shot sẽ fail — mất tiền render). Cách sửa là **viết lại cảnh cho chỉ tả thứ máy quay thấy**, bỏ hẳn câu tả cú đánh; không phải đổi chữ cho lọt bộ lọc.

Blueprint JSON kiểm bằng script của skill `vibe-xuong-phim-drama`:

```powershell
python scripts/validate_blueprint.py seq-01.json --bible bible.json
```
