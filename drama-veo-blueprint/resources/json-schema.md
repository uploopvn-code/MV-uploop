# Đặc tả JSON Blueprint (mở rộng)

Schema mở rộng từ mẫu gốc. Các trường **in đậm** là phần nâng cấp thêm so với bản mẫu ban đầu. Tất cả tên trường giữ nguyên tiếng Anh để VEO và công cụ parse ổn định; nội dung giá trị có thể là tiếng Việt.

## Cấu trúc tổng

```
{
  "project"/"film": { ... },
  "styles":   [ {style}, ... ],
  "assets":   [ {character}, {scene}, ... ],
  "wardrobe": [ {costume}, {item}, ... ],   // cột Trang phục - Vật dụng
  "cameras":  [ {camera}, ... ],
  "audio":    [ {audio}, ... ],     // cột Âm thanh (nhạc nền + tiếng hiện trường)
  "shots":    [ {shot}, ... ]
}
```

---

## 1. project

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `title` | string | Song ngữ: "Tên Việt (English Title)" |
| `country_setting` | string | Quốc gia + địa danh cụ thể (vd "Việt Nam (Biệt thự Thảo Điền)") |
| `genre` | string | Thể loại con (Domestic Psychological Thriller / Marital Deception...) |
| `duration_seconds` | number | Tổng thời lượng |
| `logline` | string | 1–2 câu: ai muốn gì, ai cản, hậu quả nếu thất bại |
| `thematic_core` | string | Chủ đề ngầm (phản bội sau bình phong danh giá...) |
| **`dramatic_question`** | string | Câu hỏi cả phim xoay quanh — la bàn cho mọi shot |
| **`beat_sheet`** | object | 5 nhịp, mỗi nhịp 1 câu (xem dưới) |
| **`pacing_profile`** | string | Mô tả nhịp tổng (vd "slow-burn dồn nén, nổ ở 2/3 cuối") |
| **`aspect_ratio`** | string | Mặc định "16:9" |
| **`target_platform`** | string | "Google VEO" |
| **`part_of`** | string | (phim dài) Tên phim tổng mà phân đoạn này thuộc về |
| **`sequence_index`** | number | (phim dài) Số thứ tự phân đoạn trong phim (1, 2, 3...) |
| **`act`** | string | (phim dài) Hồi: "I" / "II" / "III" |
| **`reference_limit`** | number | Trần hình tham chiếu/shot áp cho phân đoạn (mặc định 10) |

### beat_sheet
```
"beat_sheet": {
  "setup": "...",
  "tension_rising": "...",
  "confrontation": "...",
  "reveal": "...",
  "aftermath": "..."
}
```

---

## 2. style → dùng `styles` (mục 4b)

Trước đây style là một chuỗi cấp phim; nay style là **node có key trong mảng `styles`** (xem mục 4b) để công cụ node tạo được node Style và shot nối vào qua `uses`. Mỗi shot chọn style bằng `shot.style` + lặp key đó trong `shot.uses`. Phần lớn phim chỉ cần một style `style_main`; thêm style khác (hồi tưởng, mơ) khi cần.

---

## 3. assets

Mảng gộp cả 3 loại, phân biệt bằng `role`.

### 3a. character (role: "character")

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `key` | string | Định danh ngắn, dùng tham chiếu @key trong shot (vd "wife") |
| `role` | string | "character" |
| `name` | string | Tên + vai trò xã hội |
| `voice_profile` | object | Khóa giọng (xem dưới) |
| `prompt` | string | Model sheet turnaround prompt (khóa diện mạo) |
| **`physical_anchors`** | array[string] | 3–5 đặc điểm bất biến để chống trôi mặt |
| **`code`** | string | Mã định danh trung tính ổn định toàn phim (NV1, NV2…) — dùng @NVk trong videoPrompt thay tên riêng (an toàn lọc Veo) |
| **`short_desc`** | string | Cụm nhận dạng ngắn (không trang phục) cho dòng cast "NVk is …" đầu videoPrompt, giúp VEO gắn đúng reference |
| **`identity_label`** | string | **Tiếng Anh**, 2–5 chữ, không trang phục, không tên: cách prompt ẢNH KHUNG của cụm đối thoại gọi người này ("the auburn-haired woman"). Bắt buộc khi nhân vật có cụm đối thoại (mục 5b) |
| **`back_view`** | string | **Tiếng Anh**: những gì máy thấy từ sau lưng ở look chính — tóc sau, cổ áo, vai ("her auburn bun and charcoal shoulder"). Dùng cho khung qua vai; node phối `worn` khai `back_view` riêng khi bộ đồ đổi |
| **`expression_matrix`** | object | 3–4 trạng thái tâm lý tái dùng (xem dưới) |
| **`wardrobe`** | object | Từ điển look → **key node costume** (trong nhóm `wardrobe`) hoặc `null` nếu look đó chưa dựng; khóa `default` chỉ look mặc định. Vd `{"default":"mourning","mourning":"costume_julian_mourning","business":null}` |
| **`relationship`** | string | Quan hệ & thế lực so với nhân vật khác |

**Nhân vật gốc = một node xuyên suốt, khóa MẶT + TRANG PHỤC CHÍNH.** `prompt` model sheet tả **khuôn mặt + tóc + vóc dáng + trang phục chính (default look)**. Cảnh dùng look chính → nối thẳng nhân vật vào cảnh. Khi đổi sang look khác, KHÔNG nhân bản nhân vật — tạo **node costume** trong nhóm `wardrobe` (mục 3c) có input là nhân vật; costume render lại người đó mặc đồ mới rồi mới vào cảnh.

#### voice_profile
```
"voice_profile": {
  "gender": "Female",
  "age_sound": "Late 30s",
  "timbre": "Trầm, mượt, sắc lạnh",
  "accent": "Giọng Hà Nội chuẩn, đài từ quý phái",
  "pacing": "Chậm, nhả chữ dứt khoát, không cao giọng",
  "emotional_baseline": "Khinh miệt kìm nén sau nụ cười lịch thiệp"
}
```

#### expression_matrix (mới)
```
"expression_matrix": {
  "suppressed": "jaw clenching, lips pressed, eyes welling but not falling",
  "suspicious": "cold side-eye, one brow subtly raised, chin tilted",
  "collapse": "shocked realization, trembling lips, pupils dilating",
  "triumph": "a subtle lethal smirk, serene aristocratic composure"
}
```

### 3b. scene (role: "scene")

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `key` | string | master: `scene_<diadiem>`; góc: `scene_<diadiem>_a` / `_b` / `_<chitiet>` |
| `role` | string | "scene" |
| `kind` | string | (góc) "angle" — bỏ trống nghĩa là bối cảnh master |
| `of` | string | (góc) key bối cảnh chính mà góc này thuộc về |
| `uses` | array[string] | (góc) `= ["<bối cảnh chính>"]` — INPUT: dây bối cảnh chính → IN góc (bắt buộc với góc) |
| `name` | string | Tên bối cảnh / góc |
| `prompt` | string | master: neo kiến trúc tổng; góc: tả CÙNG địa điểm từ một góc/hướng, giữ nguyên nền |
| **`lighting_profile`** | string | Ánh sáng cố định (để nhất quán giữa các shot) |
| **`conversation`** | object | Địa điểm có đối thoại: dàn cảnh hai bên khung cho cụm đối thoại (mục 5b). Khai trên bối cảnh mà cụm ghi trong `uses` (góc `kind:"angle"` quy về master qua `of`). Xem khối dưới |

#### conversation (địa điểm có đối thoại)
```
"conversation": {
  "place": "The study from image 1 at night.",
  "two_shot": "from the bookcase side of the room",
  "left":  { "anchor": "standing at the window end of the long desk beside the green banker's lamp",
             "background": "the rain-streaked arched windows",
             "light": "warm firelight and green banker's-lamp light on her face" },
  "right": { "anchor": "standing in front of the marble fireplace",
             "background": "the marble fireplace and gilt portrait",
             "light": "firelight rims her hair, cool blue window light on her face" }
}
```
`place` = câu mở của mọi ảnh khung (ảnh 1 luôn là bối cảnh). `left`/`right` = người đứng bên đó của khung: `anchor` (cạnh vật gì — cần cho trung đôi), `background` (thấy gì sau lưng họ — là hậu cảnh của khung qua vai lên người đó), `light` (ánh sáng rơi lên họ). Hai bên **ngược nhau** như hai đầu trục 180. Tiếng Anh; đại từ her/his tool tự đổi theo giới của người đứng bên đó. Ảnh khung dùng **cảnh toàn** (không người) làm ảnh 1 — đúng bản đã test.

**Bối cảnh chính → góc phân cảnh (đối xứng nhân vật → trang phục):** một địa điểm = 1 node master + N node góc (`kind:"angle"`, `of`+`uses:[master]`). Cặp **góc A/B** = hai bên trục 180 cho đối thoại. Shot trỏ `uses` tới **góc** (master được kéo vào qua `of`); cảnh cận/insert không cần hậu cảnh rõ thì dùng thẳng master.

### 3c. wardrobe — nhóm "Trang phục - Vật dụng" (node riêng, ngoài `assets`)

Mảng cấp cao `wardrobe` (song song `assets`, `cameras`, `styles`) = cột "Trang phục - Vật dụng" trong công cụ node. Gồm 2 loại node, phân biệt bằng `kind`:

Một LOOK KHÁC trang phục chính = **3 node** (nhân vật gốc + bộ đồ độc lập + node phối):

**outfit** (bộ đồ — node ĐỘC LẬP, không input):
| Trường | Kiểu | Ghi chú |
|---|---|---|
| `key` | string | `outfit_<tên>_<look>` |
| `kind` | string | "outfit" |
| `for` | string | (gợi ý) bộ đồ của nhân vật nào — KHÔNG phải input |
| `prompt` | string | Ảnh BỘ ĐỒ trên ma-nơ-canh không đầu/mặt. KHÔNG có `uses` (độc lập) |

**worn** (node phối "NV đã mặc" — nhận 2 input):
| Trường | Kiểu | Ghi chú |
|---|---|---|
| `key` | string | `costume_<tên>_<look>` (shot trỏ vào node này) |
| `kind` | string | "worn" |
| `for` | string | key nhân vật gốc |
| `wears` | string | key bộ đồ (`outfit_*`) |
| `uses` | array[string] | **= `[<nhân vật>, <bộ đồ>]`** — 2 INPUT: nhân vật (OUT) + bộ đồ (OUT) → IN node phối |
| `prompt` | string | Render nhân vật (khóa mặt từ input nhân vật) MẶC bộ đồ (từ input bộ đồ) — OUTPUT "nhân vật đã mặc đồ" → cảnh |
| `back_view` | string | (tùy chọn) sau lưng ở bộ đồ này ("her auburn bun above a black fur collar") — thay cho `back_view` của nhân vật trong khung qua vai |

Luồng: `nhân vật ─┐` , `bộ đồ (độc lập) ─┘→ node phối → cảnh`. **Shot trỏ `uses` tới node PHỐI** (worn), không trỏ bộ đồ. Trang phục chính (default) nằm trong model sheet nhân vật gốc → cảnh dùng look chính nối THẲNG nhân vật gốc vào cảnh.

**item** (vật dụng / đạo cụ then chốt — di chúc, điện thoại, nhẫn…):
| Trường | Kiểu | Ghi chú |
|---|---|---|
| `key` | string | `prop_<tên>` |
| `kind` | string | "item" |
| `for` | string | (tùy chọn) nhân vật cầm/đeo, nếu gắn riêng |
| `name` | string | Tên vật dụng |
| `prompt` | string | Macro/hero shot |
| `continuity_note` | string | Giữ nhất quán giữa các cảnh |

Tất cả node `wardrobe` (costume + item) đều là **ẢNH tham chiếu** → tính vào trần ≤10/shot.

**Luồng nối đúng (2 nhánh):**
- **Look chính (default):** nhân vật gốc đã mặc sẵn trang phục chính trong model sheet → `shot.uses` nối **thẳng nhân vật gốc** vào cảnh.
- **Look khác:** nhân vật gốc (OUT) → **IN node costume** (khai qua `costume.uses = [nhân vật]`) → node costume **render lại nhân vật mặc đồ mới** → OUT → cảnh; `shot.uses` nối **costume** (không nối nhân vật gốc). Mỗi người trong một cảnh = đúng một look (hoặc nhân vật gốc, hoặc một costume), không đưa cả hai, không hai costume → tránh mặc lẫn.

---

## 4. cameras

Mỗi preset:

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `key` | string | vd "veo_ots_husband" |
| `name` | string | Tên gợi nhớ |
| `config` | string | Cấu hình chuyển động máy VEO cụ thể |

Nên có tối thiểu: 1 truck/establishing, 1 OTS, 1 shot-reverse-shot hoặc macro reaction, 1 slow push-in cho reveal, 1 low-angle hoặc dutch cho cao trào.

---

## 4b. styles

Mảng node style cấp phim/blueprint, **song song `cameras`** (thay cho trường `style` dạng string cũ, để công cụ node tạo node có key và shot nối vào được). Một phim có thể có nhiều style (chính, hồi tưởng sepia, v.v.).

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `key` | string | vd "style_main", "style_flashback" |
| `name` | string | Tên gợi nhớ |
| `prompt` | string | Chuỗi mô tả style điện ảnh (ống kính, film stock, tông màu, tương phản) áp cho shot dùng style này |

Mỗi shot chọn style qua `shot.style` = key, và lặp lại key đó trong `shot.uses`.

## 4c. audio

Preset âm thanh cho một hoàn cảnh; mỗi phần tử thành một node ở cột **Âm thanh**, nội dung được chèn vào prompt của shot nối tới dưới dạng `Audio: …`.

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `key` | string | vd "aud_funeral", "aud_will_reading" |
| `name` | string | Tên gợi nhớ |
| `prompt` | string | **Tiếng Anh** (gửi nguyên văn): nhạc nền + tiếng hiện trường + điều cấm. Vd `low sustained cello drone under light rain on umbrellas, distant chapel bell; no melody, no percussion, no crowd chatter` |

Mỗi shot chọn preset qua `shot.audio` = key, và lặp key đó trong `shot.uses`. Một preset duy nhất cho cả phim thì tool tự nối vào mọi shot.

## 5. shots

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `name` | string | "Shot 01 — ..." |
| `start` | number | Giây bắt đầu |
| `duration` | number | 4–7 giây |
| **`beat`** | string | Thuộc nhịp nào: setup / tension_rising / confrontation / reveal / aftermath |
| **`emotional_value`** | number | -5…+5, vẽ đường cong cảm xúc |
| `uses` | array[string] | Các node shot nối tới: **mỗi người trong khung = ĐÚNG 1 `costume` của họ** (KHÔNG kèm nhân vật gốc — nhân vật vào cảnh gián tiếp qua `costume.for`) + bối cảnh + vật dụng + đúng 1 `camera` + đúng 1 `style`. Luồng: nhân vật → IN costume → OUT costume → cảnh. Trần **≤ 10 chỉ áp cho ẢNH** (costume + bối cảnh + vật dụng [+ nhân vật gốc nếu dùng look base]); camera + style không tính. KHÔNG để 2 costume cùng một người, KHÔNG để cả nhân vật gốc lẫn costume của họ (gây mặc lẫn). `@mention` nhân vật trong prompt hợp lệ khi có costume `for` người đó trong uses. |
| `camera` | string | `key` của camera preset — key này cũng PHẢI có trong `uses` để node Máy quay nối vào shot |
| **`style`** | string | `key` của style — key này cũng PHẢI có trong `uses` để node Style nối vào shot (mặc định `style_main`) |
| **`audio`** | string | `key` của preset âm thanh (mục 4c) — lặp trong `uses` để node Âm thanh nối vào shot |
| **`axis_180`** | string | Hướng nhìn từng nhân vật để giữ trục |
| `blocking` | string | Bố trí vị trí & thế lực |
| `dialogue` | string | Thoại, mở đầu bằng **tên người nói** + dấu hai chấm (`Vivienne: "…"`; voiceover ghi `Eleanor (voiceover): "…"`). Cảnh im lặng ghi `[Không thoại; <chuyện đang xảy ra>]` — tool đọc dấu ngoặc vuông để biết shot không có thoại |
| `audio_delivery` | string | **Tiếng Anh** (gửi nguyên văn). Shot có thoại: cách nói, điều biến trên nền voice_profile (`Low, smooth, a blade hidden underneath.`). Shot im lặng: **tiếng hiện trường** (`No dialogue; cold wind, distant crows.`) — tool ghép vào câu "Audio is location sound only — …" |
| `internal_subtext` | string | Ý ngầm / mục tiêu tâm lý của shot |
| `videoPrompt` | string | Dòng VEO render — xem cú pháp ở SKILL.md (CẤM tả lại quần áo/tóc/mặt) |
| **`transition_to_next`** | string | Cách chuyển sang shot kế (cut thẳng, match-cut, dissolve, hard cut on action...) |
| **`setups`** | array[object] | **Cụm đối thoại** (mục 5b): 2–3 cỡ cảnh của cùng một trao đổi, quay chung một clip Veo 8 giây. Có `setups` thì shot này KHÔNG có `camera`, KHÔNG có `videoPrompt`, `dialogue` nằm trong từng setup |
| **`sides`** | object | (cụm đối thoại) `{ "left": "<key người bên trái>", "right": "<key người bên phải>" }` — key nhân vật hoặc costume họ mặc trong cảnh, phải có trong `uses` |
| **`place`** | string | (cụm đối thoại, tùy chọn) key bối cảnh dùng làm ảnh 1 của các ảnh khung; mặc định bối cảnh đầu tiên trong `uses` |

### 5b. Cụm đối thoại (`setups`) — 2–3 cỡ cảnh, một clip Veo

Một mục shot có `setups` là một **cụm**: tool dựng mỗi setup một node ảnh khung (cột ⑥, đánh số 1, 2, 3) nối từ [1] bối cảnh, [2] người bên trái, [3] người bên phải; rồi một node "Phân cảnh ghép" (cột ⑦) gửi 2–3 ảnh khung đó làm ảnh tham chiếu cùng prompt cắt cảnh có mốc giây, ra một clip 8 giây.

| Trường của một setup | Kiểu | Ghi chú |
|---|---|---|
| `framing` | string | `ots_a` (qua vai người bên trái, nhìn người bên phải — **người bên phải nói**), `ots_b` (ngược lại — **người bên trái nói**), `two_shot` (trung đôi, ai nói cũng được). Mỗi cỡ một lần trong cụm. Thứ tự đã test: A → B, A → B → trung đôi |
| `dialogue` | string | Một câu, dạng `Tên: "…"` (tên gọi đầu trong `name` của asset), một người nói. Không có dạng im lặng ở đây trừ khi cả setup không thoại (`[Không thoại; …]`) |
| `audio_delivery` | string | Tiếng Anh, cách nói, đặt ngay cạnh câu ("coolly, bright and brittle") |
| `action` | string | (tùy chọn) hành động nhỏ của người nói, tiếng Anh ("takes one step toward NV1") |
| `prompt` | string | (tùy chọn) prompt ảnh khung viết tay thay cho mẫu của tool — bình thường bỏ trống |

Tốc độ thoại: tool chia 8 giây theo số từ — 2 setups → 4/4 giây; 3 setups → ví dụ 5/2/5 từ → 3/2/3 giây, tối thiểu 2 giây mỗi khung. **≤ 3 từ mỗi giây** (2 setups: mỗi câu ≤ 8–10 từ; 3 setups: hai câu ≤ 6–8 từ, câu giữa 1–3 từ).

Ví dụ: xem SKILL.md Bước 7b.

### Ràng buộc kiểm tra trước khi xuất
1. Mọi `key` trong `uses` tồn tại trong `assets`.
2. Mọi `camera` tồn tại trong `cameras`.
3. Tổng `duration` các shot của mỗi nhịp xấp xỉ % trong beat_sheet.
4. Chuỗi `emotional_value` có lên có xuống (không phẳng).
5. Các cặp đối thoại khớp `axis_180` (không cùng hướng nhìn).
6. JSON parse hợp lệ; dấu nháy trong thoại tiếng Việt được escape.
7. Cụm đối thoại: `setups` 2–3 phần tử, cỡ cảnh khác nhau; có `sides` trỏ 2 người trong `uses`; người nói của `ots_a` là bên phải, của `ots_b` là bên trái; mỗi câu có tên người nói là một trong hai; ≤ 3 từ/giây; không `camera`/`videoPrompt`.
8. Nhân vật trong cụm có `code` + `identity_label` (+ `back_view` khi có cỡ qua vai); bối cảnh của cụm có `conversation` đủ `place`, `left`/`right` (`background`, `light`; `anchor` và `two_shot` khi có trung đôi).
