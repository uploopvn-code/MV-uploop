---
name: drama-veo-blueprint
description: "Dựng kịch bản phân cảnh drama điện ảnh thành MỘT khối JSON blueprint dán thẳng vào Google VEO. Hỗ trợ: đồng bộ nhân vật (model sheet + voice_profile + ma trận biểu cảm), đồng bộ bối cảnh (hệ vi-cảnh 4 góc neo), đồng bộ giọng nói giữa các shot, beat sheet 5 nhịp (setup→căng→cao trào→twist→hậu quả) chia cảnh theo đường cong cảm xúc, ngôn ngữ máy quay tâm lý (OTS, shot-reverse-shot, dutch, slow push-in), quy tắc trục 180 độ, cụm đối thoại 2–3 cỡ cảnh quay chung một clip Veo (setups). Kích hoạt khi nói 'BẮT ĐẦU DRAMA VEO', 'làm phim drama', 'kịch bản VEO', 'phân cảnh drama', 'json blueprint cho Veo'; đưa ý tưởng xung đột/logline + quốc gia rồi bảo dựng phim; hoặc thả kịch bản drama cần chuyển thành storyboard JSON. KHÔNG dùng cho: kịch bản cầu nguyện (→ cau-nguyen/mau-chua), tin tức (→ xuong-tin-tuc), sức khỏe Nhật (→ viet-kich-ban-suc-khoe-nhat), prompt ảnh tĩnh (→ prompt-anh-*), truyện dynasty drama tiếng Anh (→ prestige-dynasty-drama). Dùng cho MỌI yêu cầu dựng blueprint phim drama cho VEO — kể cả khi chỉ thả một ý tưởng xung đột trần và nói 'làm thành phim'.\n"
---

# Đạo diễn Drama cho Google VEO — JSON Blueprint

Skill này biến một **ý tưởng xung đột** thành một **blueprint JSON** mà Google VEO đọc được để render ra chuỗi shot có cảm giác như một đoạn phim điện ảnh thật, chứ không phải chuỗi clip rời rạc. Giá trị không nằm ở việc "viết JSON" mà ở bốn thứ VEO tự nó làm rất tệ nếu không ép: giữ cho một người giống chính họ qua mọi cỡ máy, giữ cho căn phòng không đổi hình giữa các góc quay, giữ giọng nói một người ổn định, và sắp các shot theo một nhịp kịch có chủ đích.

Ghi nhớ bốn trụ này suốt quá trình — mọi quyết định đều quy về chúng:

1. **Đồng bộ nhân vật** — VEO hay "vẽ lại" mặt mỗi shot. Ta chống bằng model sheet turnaround (khóa khuôn mặt + trang phục), cộng *ma trận biểu cảm* (khai báo sẵn vài trạng thái tâm lý) để diễn xuất không trôi dạt.
2. **Đồng bộ bối cảnh** — cùng một căn phòng quay từ 4 góc khác nhau sẽ ra 4 căn phòng khác nhau nếu để mặc. Ta phân rã địa điểm thành *hệ vi-cảnh* gồm 1 toàn cảnh neo + các góc cận đã cố định chi tiết.
3. **Đồng bộ giọng nói** — mỗi nhân vật có `voice_profile` chi tiết, lặp lại y nguyên ở mọi shot họ xuất hiện, để chất giọng không nhảy giữa các đoạn.
4. **Nhịp phim (dramatic pacing)** — đây là thứ nâng từ "clip đẹp" lên "phim". Ta không rải shot ngẫu nhiên mà bám *beat sheet 5 nhịp* và một *đường cong cảm xúc*; cảnh càng căng thì shot càng ngắn và máy càng siết vào.

---

## Khi nào kích hoạt

Dùng skill này khi Tiến muốn một đoạn phim drama (gia đấu, đấu trí hôn nhân, phản bội, trả thù, bí mật thượng lưu…) để đưa vào Google VEO. Dấu hiệu: lệnh `BẮT ĐẦU DRAMA VEO: …`, hoặc đưa một logline / tình huống xung đột, hoặc thả một kịch bản drama có sẵn và bảo "dựng thành phân cảnh / blueprint".

Không dùng cho nội dung cầu nguyện, tin tức, sức khỏe Nhật, hay bộ prompt ảnh tĩnh — những mảng đó đã có skill riêng (xem phần loại trừ trong description).

---

## Lệnh kích hoạt & tham số

Cú pháp gốc, giữ cho Tiến quen tay:

```
BẮT ĐẦU DRAMA VEO: [Tên kịch bản / Ý tưởng xung đột] | QUỐC GIA: [Việt Nam / Hàn Quốc / Mỹ / Pháp...]
```

Tham số tùy chọn, nối thêm bằng dấu `|` (bỏ qua cái nào thì tự chọn mặc định hợp lý):

| Tham số | Ví dụ | Mặc định nếu thiếu |
|---|---|---|
| `THỜI LƯỢNG` | `180s` | 160–200s |
| `SỐ NHÂN VẬT` | `2` | suy từ xung đột (2–3) |
| `TÔNG` | `noir lạnh` / `amber ấm` | chọn theo thể loại |
| `THỂ LOẠI` | `đấu trí hôn nhân` | suy từ ý tưởng |
| `NGÔN NGỮ THOẠI` | `tiếng Việt` | theo QUỐC GIA |
| `OUTPUT` | `file` / `inline` | `inline` |

Khi input chỉ là một ý tưởng trần ("làm phim về người vợ phát hiện chồng ngoại tình"), vẫn chạy — tự suy quốc gia, nhân vật, tông màu rồi nêu 1 dòng các giả định đã chọn trước khối JSON. Nếu input thiếu một mảnh *then chốt* làm lệch hẳn kết quả (ví dụ không rõ phim nghiêng về ai thắng), hỏi đúng 1 câu rồi mới dựng.

Nếu Tiến **thả sẵn một kịch bản/thoại**, nhiệm vụ là *bóc* nó thành blueprint: trích nhân vật → model sheet + voice, trích địa điểm → hệ vi-cảnh, cắt thoại theo beat sheet → shots. Không bịa thêm tình tiết lớn ngoài kịch bản gốc.

---

## Quy trình 8 bước

Mở rộng từ quy trình 6 bước gốc; bước mới là **Beat Sheet & Nhịp** (bước 5) — chính nó tạo cảm giác điện ảnh.

### Bước 0 — Bản địa hóa quốc gia & văn hóa
Tên nhân vật, ngôn ngữ thoại, phong thái, tầng lớp xã hội, kiến trúc, nội thất, đạo cụ đều phải chuẩn văn hóa quốc gia chỉ định. Một biệt thự Thảo Điền khác một penthouse Gangnam khác một townhouse Paris — sai cái này là lộ ngay chất "AI generic".

### Bước 1 — Hồ sơ dự án & câu hỏi kịch tính
Viết `project`: title (song ngữ Việt + Anh), country_setting, genre, duration_seconds, logline, thematic_core, và `dramatic_question` (câu hỏi mà cả phim xoay quanh — "Người vợ có vạch mặt được chồng không?"). Câu hỏi này là la bàn: mọi shot phải đẩy khán giả tới hoặc ra xa câu trả lời.

### Bước 2 — Nhân vật: model sheet + voice + ma trận biểu cảm
Mỗi nhân vật là một asset `role: "character"` gồm:
- `prompt`: model sheet turnaround (chân dung trái + 3 góc toàn thân phải + trang phục gắn địa vị, nền xám trơn, studio lighting, cinematic 35mm photorealistic). Đây là cái khóa diện mạo.
- `physical_anchors`: 3–5 đặc điểm bất biến viết ngắn gọn (ví dụ "nốt ruồi dưới mắt trái, tóc búi thấp, bông tai ngọc trai") để nhắc lại khi cần chống trôi mặt.
- `code` + `short_desc`: mã định danh trung tính ổn định toàn phim (NV1, NV2…) và một cụm mô tả nhận dạng ngắn (không trang phục, vd "a poised woman with auburn hair"). Dùng @NVk trong videoPrompt thay tên riêng + chèn dòng cast; xem Bước 7 và mục "Tuân thủ Veo".
- **`identity_label` + `back_view`** (tiếng Anh, tool gửi nguyên văn vào prompt ẢNH KHUNG của cụm đối thoại — Bước 7b): nhãn nhận dạng 2–5 chữ, không trang phục, không tên ("the auburn-haired woman"); và những gì máy thấy từ **sau lưng** ở look chính ("her auburn bun and charcoal shoulder"). Node phối `worn` khai `back_view` riêng khi bộ đồ đổi cổ áo/vai/tóc. Nhân vật có cụm đối thoại **bắt buộc có `code`** (prompt gọi bằng mã, không bao giờ bằng tên).
- `voice_profile`: timbre, accent/dialect, pacing, emotional_baseline — xem Bước 3.
- `expression_matrix`: 3–4 trạng thái tâm lý đặc trưng của riêng nhân vật trong phim này, mỗi trạng thái là một câu tả cơ mặt dùng lại được trong shot (kìm nén / nghi ngờ dò xét / sụp đổ bàng hoàng / đắc thắng lạnh lùng…). Drama sống bằng vi biểu cảm, không bằng lời to.
- **Nhân vật gốc = 1 node xuyên suốt, khóa MẶT, mặc TRANG PHỤC CHÍNH (default look).** Cảnh dùng look chính → nối thẳng nhân vật gốc vào cảnh. Khi đổi look KHÁC, dùng **mô hình 3 node**:
  1. **Bộ đồ** `outfit_<tên>_<look>` (`kind:"outfit"`) — node ĐỘC LẬP, **KHÔNG input**; prompt = ảnh bộ đồ trên ma-nơ-canh không mặt. Chỉ có OUT.
  2. **Node phối** `costume_<tên>_<look>` (`kind:"worn"`) — **2 input: nhân vật + bộ đồ** (`uses:[nhân vật, outfit]`, `for`=nhân vật, `wears`=outfit); prompt = render nhân vật mặc bộ đồ đó (khóa mặt). OUT → cảnh.
  3. **Shot trỏ `uses` tới node PHỐI** (worn), không trỏ bộ đồ. Luồng: `nhân vật ─┐`, `bộ đồ ─┘→ node phối → cảnh`.
  Nhân vật gốc giữ `wardrobe` = từ điển look→key node phối (`"base"` = look chính trong model sheet). Chi tiết: `resources/feature-film-mode.md` mục 6c, schema mục 3c.

### Bước 3 — Đồng bộ giọng nói (voice persistence)
`voice_profile` của mỗi nhân vật phải đủ chi tiết để tái lập: chất giọng (timbre), vùng miền/ngữ điệu (accent), tốc độ nói (pacing), cảm xúc nền (emotional_baseline). Ở mỗi shot có nhân vật đó nói, trường `audio_delivery` chỉ *điều biến* trên nền voice_profile (vd "deadly calm, a smooth whisper") chứ không định nghĩa lại giọng. Nhờ vậy giọng không nhảy giữa các shot.

**Tool tự khóa giọng:** với mọi shot có thoại (kể cả voiceover, kể cả người nói ngoài khung), tool ghép sẵn vào prompt dòng `Voice lock for NV1: Female, Late 30s; timbre: …; accent: …; pacing: …; baseline: …. Delivery: <audio_delivery>.` Vì vậy **đừng tả giọng trong `videoPrompt`** (không "speaking with a low velvet voice") — trùng lặp chỉ làm loãng. Hai trường này **gửi nguyên văn** nên phải viết **tiếng Anh**, kể cả phim nói tiếng Việt.

### Những phần TOOL tự ghép — đừng viết tay vào blueprint
Tool node-graph dựng prompt gửi VEO từ blueprint, tự thêm các phần sau. Viết lại bằng tay chỉ gây trùng lặp và chọi với ảnh tham chiếu:

| Tool tự thêm | Nguồn dữ liệu |
|---|---|
| `Reference subjects, in the order of the attached images: [1] NV3; [2] NV1; [3] the cemetery — …` (chỉ **ánh xạ ảnh ↔ mã**, KHÔNG mô tả ngoại hình) | thứ tự `uses` |
| Đổi `@NV1` → `NV1`, `@scene_x` → `the cemetery` | `code`, `key` |
| `The line is spoken by NV3 (reference image 1) only; everyone else stays silent and listens.` | mã đứng trước `mouth articulates`, hoặc tên mở đầu `dialogue` |
| `Voice lock for NV3: … Delivery: …` | `voice_profile` + `audio_delivery` |
| `No spoken dialogue in this shot… location sound only — …` | shot có `dialogue` rỗng / `[…]` |
| `Audio: …` | preset `audio` nối vào shot |
| `Camera: …`, `Style: …` | node camera/style nối vào shot |
| **Prompt ẢNH của shot**: `Still keyframe, one photographic moment of this shot, not a sequence: …` (bỏ nhãn "Veo Video Prompt", đổi câu thoại thành "lips parted mid-sentence", KHÔNG có dòng Audio) | chính `videoPrompt` của shot |
| Dây nhân vật → costume → "NV đã mặc" → cảnh; bối cảnh → góc → cảnh | `for`, `of`/`uses` |
| **Ảnh khung của cụm đối thoại** (`setups`, Bước 7b): mỗi cỡ cảnh một ảnh tĩnh dựng từ [1] bối cảnh, [2] người bên trái, [3] người bên phải, theo mẫu qua vai / trung đôi đã test ("Over-the-shoulder close-up: the auburn-haired woman from image 2 seen from behind, her auburn bun… The platinum-blonde woman from image 3 in sharp focus right of centre… looking frame left at the other woman, not into the lens…") | `identity_label`, `back_view`, `conversation`, `sides` |
| **Prompt cắt cảnh của cụm đối thoại**: "The 3 attached images are the 3 camera setups of one conversation… NV1 is always on the left of frame, NV3 always on the right… hard cuts at 00:03 and 00:05… [00:00-00:03] Shot A. NV3, the platinum-blonde woman, says coolly: "…" Only NV3 speaks; NV1's face stays turned away, lips closed…" + Voice lock từng người nói + Room sound + Style + đuôi chống chữ | `setups[].dialogue` / `audio_delivery` / `action`, preset `audio`, `style` |

Tool còn **tự xóa** câu giới thiệu ngoại hình ("In this shot, NV1 is a poised woman in her late 30s…") nếu lỡ lọt vào `videoPrompt`.

### Bước 4 — Hệ vi-bối-cảnh: bối cảnh chính → các góc phân cảnh (A/B)
Mỗi địa điểm chính là **một node bối cảnh master** (toàn cảnh, khóa kiến trúc/ánh sáng). Từ nó toả ra các **node góc phân cảnh** để VEO không vẽ sai hậu cảnh giữa các cỡ máy — đối xứng hệt luồng nhân vật→trang phục:
- Góc là node `role:"scene"`, `kind:"angle"`, có **`of:"<bối cảnh chính>"`** và **`uses:["<bối cảnh chính>"]`** (dây **bối cảnh chính → IN góc**).
- **`prompt` của góc PHẢI là một SETUP MÁY KHÁC HẲN**, không chỉ "cùng chỗ". Ảnh bối cảnh chính chỉ để **khóa kiến trúc + ánh sáng**, KHÔNG để copy bố cục. Prompt góc phải nêu rõ: *vị trí đặt máy, hướng nhìn, tiền cảnh, hậu cảnh, cỡ cảnh* — và khẳng định "composition clearly DISTINCT from the master and from the other angle". Nếu prompt chỉ nói "same location, keep consistent" mà thiếu phần khác biệt → render ra **giống hệt cảnh chính** (lỗi hay gặp). Góc A và góc B là hai hướng NGƯỢC nhau của trục 180 (tiền/hậu cảnh đảo chỗ).
- Cặp **góc A / góc B** là hai bên của trục 180 cho cảnh đối thoại (OTS lên A dùng góc A, reverse lên B dùng góc B). Thêm góc chi tiết (cận bàn, chân cầu thang…) khi cần.
- **Shot trỏ `uses` tới GÓC** (không trỏ master trực tiếp khi đã có góc) — y như shot trỏ costume chứ không trỏ nhân vật gốc. Bối cảnh chính được kéo vào qua `of`/`uses` của góc; cảnh cận/insert không cần hậu cảnh rõ thì dùng thẳng master.
Đặt key: `scene_<diadiem>` (master), `scene_<diadiem>_a` / `_b` (góc), `scene_<diadiem>_<chitiet>`.

**Địa điểm có đối thoại khai thêm `conversation`** — trên node bối cảnh mà cụm đối thoại (Bước 7b) ghi trong `uses` (một góc `kind:"angle"` tự quy về master qua `of`): `place` = câu mở của mọi ảnh khung ("The study from image 1 at night" — ảnh 1 luôn là bối cảnh), `two_shot` = máy đứng đâu khi quay trung đôi ("from the bookcase side of the room"), `left` / `right` = người đứng bên đó: `anchor` (đứng cạnh vật gì), `background` (thấy gì sau lưng họ), `light` (ánh sáng rơi lên họ). Viết tiếng Anh; đại từ her/his tool tự đổi theo giới người đứng bên đó. Tool dựng ảnh qua vai A/B và trung đôi từ đúng các câu này, nên hai bên phải **ngược nhau** (bên trái thấy cửa sổ thì bên phải thấy lò sưởi). Ví dụ đầy đủ: `resources/json-schema.md` mục 3b.
Phân rã địa điểm chính thành tối thiểu 4 asset `role: "scene"` để VEO không vẽ sai hậu cảnh giữa các cỡ máy:
1. `scene_master_wide` — toàn cảnh, xác lập kiến trúc & tương quan vị trí (bàn, cầu thang, cửa sổ, quầy bar).
2. `scene_sub_table` — góc cận bàn đối thoại.
3. `scene_sub_stairs` — góc cận cầu thang/hành lang (nơi nghe lén, bóng chiaroscuro).
4. `scene_sub_bar` — góc cận quầy rượu/đảo bếp (mặt kính phản chiếu, nơi trốn ánh mắt).

Thêm góc nếu kịch bản cần (phòng ngủ, xe hơi trời mưa, ban công…). Mỗi scene khai `lighting_profile` để ánh sáng nhất quán. Đạo cụ then chốt (điện thoại hiện tin nhắn, nhẫn cưới, đơn ly hôn, ly rượu…) khai trong **nhóm `wardrobe` với `kind:"item"`** (cùng cột Trang phục - Vật dụng), kèm `continuity_note` để không biến dạng giữa các cảnh.

### Bước 5 — Beat Sheet & nhịp phim ⭐ (bước nâng cấp)
Đây là thứ biến chuỗi shot thành phim. Làm 3 việc:

**(a) Beat sheet 5 nhịp.** Viết trường `beat_sheet` trong `project`, mỗi nhịp một câu mô tả xảy ra gì:
`setup` → `tension_rising` → `confrontation` (cao trào) → `reveal` (lật twist) → `aftermath` (dư âm).

**(b) Phân bổ thời lượng theo nhịp.** Chia tổng duration theo tỉ lệ gợi ý (co giãn ±5% tùy chuyện):

| Nhịp | % thời lượng |
|---|---|
| Setup | ~15% |
| Tension Rising | ~35% |
| Confrontation / Climax | ~25% |
| Reveal / Twist | ~15% |
| Aftermath | ~10% |

**(c) Đường cong cảm xúc + pacing.** Mỗi shot mang một `beat` (thuộc nhịp nào) và một `emotional_value` (số từ -5 đến +5: âm = dồn nén/thấp, dương = bùng nổ/cao). Chuỗi emotional_value phải vẽ nên một đường leo dốc rồi đổ — không đi ngang. Và cho nhịp quyết định độ dài shot:
- Cảnh căng / cao trào → shot **ngắn** (4–5s), cắt nhanh, shot-reverse-shot để tăng áp lực.
- Cảnh lắng / dò xét / dư âm → shot có thể **dài** (6–7s), máy đứng yên hoặc đẩy chậm.
- Khoảnh khắc *reveal* → một `slow push-in` vào mắt/gương mặt, kéo giãn thời gian để khán giả thấm.

### Bước 6 — Máy quay & trục 180 độ
Khai `cameras` là các preset chuyển động điện ảnh (xem `resources/cinematic-language.md`): `slow horizontal truck`, `creeping push-in`, `over-the-shoulder lock`, `shot-reverse-shot`, `dutch angle tilt`, `macro rack-focus`, `low-angle pedestal`.

**Quy tắc trục 180 độ** — lỗi AI chí mạng: hai người nói chuyện mà cùng nhìn một hướng thì hỏng hội thoại. Với mọi cặp đối thoại, xác lập một đường trục giữa 2 diễn viên; máy chỉ đứng một bên bán cầu. Ghi hướng nhìn vào trường `axis_180` của shot (vd "@wife nhìn phải→trái, @husband nhìn trái→phải") để các shot luân phiên khớp mắt nhau.

**Blocking quyền lực**: ai đứng cao (nắm quyền), ai ngồi thấp (thế yếu), khoảng cách vật lý (gần gũi hay lạnh nhạt) — ghi vào `blocking`. Vị trí kể chuyện trước cả khi thoại cất lên.

### Bước 7 — Storyboard shots & cú pháp videoPrompt
Mỗi shot (4–7s) gồm: `name`, `start`, `duration`, `beat`, `emotional_value`, `uses`, `camera`, `style`, **`audio`**, `axis_180`, `blocking`, `dialogue`, `audio_delivery`, `internal_subtext`, `videoPrompt`, `transition_to_next`.

**`uses` nối node — luồng theo look:** công cụ vẽ dây từ `uses`. Với mỗi người trong khung, chọn 1 trong 2 nhánh: (a) **look chính** → nối thẳng **nhân vật gốc**; (b) **look khác** → nối **costume** của họ (costume đã có input nhân vật qua `costume.uses`, nên dây đi nhân vật → trang phục → cảnh). Cộng **bối cảnh + vật dụng + đúng 1 camera + đúng 1 style**; giữ scalar `camera`/`style`. Tuyệt đối KHÔNG đưa cả nhân vật gốc lẫn costume của họ, cũng không 2 costume cùng một người → tránh mặc lẫn. `@mention` trong videoPrompt dùng tên nhân vật; hợp lệ khi nhân vật gốc HOẶC costume `for` họ có trong uses. Trần ≤10 chỉ tính ẢNH; camera + style không tính.

**Cú pháp `videoPrompt`** (dòng VEO sẽ render) — điểm sống còn: **cấm mọi mô tả ngoại hình**. Ảnh tham chiếu đã là diện mạo; thêm chữ về mặt/tóc/vóc/tuổi/quần áo chỉ chọi với ảnh và làm VEO dựng người khác. KHÔNG viết câu giới thiệu kiểu "In this shot, NV1 is a poised woman in her late 30s…" (tool tự ghép dòng cast chỉ gồm mã NV + thứ tự ảnh, và tự xóa câu giới thiệu đó nếu lỡ viết). videoPrompt chỉ gồm 5 thứ: **định vị nhân vật (blocking) → hành động vi mô + ánh mắt + nhịp thở → khẩu hình & thoại → máy quay → ánh sáng/vật lý**; âm thanh đã nằm ở preset `audio`. Khung:

> `Veo Video Prompt: Compose connected reference subjects seamlessly. [Vị trí & blocking quyền lực: ai đứng/ngồi đâu so với ai, so với bối cảnh]. @NV1 [hành động vi mô, nhịp thở, ánh mắt], mouth articulates perfectly: "[thoại — vẫn dùng TÊN nhân vật trong lời nói]". @NV2 [phản ứng cơ mặt, kìm nén]. Camera: [cấu hình VEO]. Lighting & Physics: [ánh sáng tâm lý, bóng đổ, tương tác mặt bàn/cầu thang], 16:9, cinematic 35mm, photorealistic, no text, no artifacts, fictional characters only, no resemblance to any real person or celebrity.`

**Định danh nhân vật bằng mã NV (không dùng tên khi chỉ huy VEO):** mỗi nhân vật có một mã `code` ổn định toàn phim (NV1, NV2…). Trong videoPrompt/blocking, tham chiếu diễn xuất bằng **@NV1, @NV2…** thay cho tên riêng (tên riêng nghe như người thật, dễ góp phần kích lọc; mã NV trung tính hơn). **Không kèm mô tả nhận dạng** — tool tự mở prompt bằng dòng `Reference subjects, in the order of the attached images: [1] NV3; [2] NV1; [3] the cemetery — …`, tức là chỉ ánh xạ ảnh ↔ mã, để VEO gắn @NVk vào đúng ảnh. Bối cảnh/vật dụng giữ @key (@scene_…, @prop_…). **Lời thoại vẫn giữ tên nhân vật** (trong ngoặc kép) cho tự nhiên — tên hư cấu trong câu nói không kích lọc người nổi tiếng.

Tham chiếu @asset bằng đúng `key` đã khai, để VEO gắn lại đúng mặt/bối cảnh/đạo cụ.

### Ràng buộc hình tham chiếu mỗi cảnh (bắt buộc)
VEO (và công cụ reference-to-video nói chung) chỉ nhận một số ảnh tham chiếu giới hạn mỗi lần render. Vì vậy `uses` của mỗi shot chính là **tập hình tham chiếu** nạp cho shot đó, và phải thoả 2 chiều:
- **Đủ:** mọi asset được nhắc bằng `@key` trong `videoPrompt`/`blocking` đều phải có mặt trong `uses` — thiếu thì VEO không có hình để gắn, nhân vật/bối cảnh sẽ bị dựng sai.
- **Không quá:** `len(uses)` **≤ 10** (trần cứng). Lý tưởng ≤ 6 để VEO bám tốt; nhiều bản VEO thực tế chỉ ăn ~3 ảnh/lần — anh chỉnh ngưỡng theo công cụ đang dùng.

Khi một cảnh đông cần hơn 10 asset: **tách thành nhiều shot** (mỗi shot chỉ gồm những ai/vật thật sự trong khung), hoặc gộp đạo cụ phụ vào mô tả thường thay vì làm asset riêng. Giữ nhân vật đang thoại + bối cảnh đang dùng là ưu tiên số 1 trong `uses`.

### Bước 7b — Cụm đối thoại (`setups`): 2–3 cỡ cảnh quay chung MỘT clip Veo

Một trao đổi thoại ngắn (2–3 câu qua lại) **không viết thành 2–3 shot OTS rời** nữa. Viết nó thành **một mục shot** có `setups`: tool dựng mỗi cỡ cảnh một **ảnh khung** riêng (qua vai A, qua vai B, trung đôi — từ bối cảnh + hai character sheet, theo mẫu đã test), rồi quay **một clip Veo 8 giây** với cú cắt cứng ở từng mốc giây, 2–3 ảnh khung làm ảnh tham chiếu. Đã test thành công cả A→B và A→B→trung đôi (xem `Veo-shot-notes.md` của tool).

```json
{
  "name": "Cảnh 09 — Di chúc đã đổi", "start": 72, "duration": 8,
  "beat": "tension_rising", "emotional_value": -2,
  "uses": ["eleanor", "costume_vivienne_mourning", "scene_master_study", "style_main", "aud_study_rain"],
  "style": "style_main", "audio": "aud_study_rain",
  "sides": { "left": "eleanor", "right": "costume_vivienne_mourning" },
  "setups": [
    { "framing": "ots_a",    "dialogue": "Vivienne: \"He changed the will, Eleanor.\"", "audio_delivery": "coolly, bright and brittle" },
    { "framing": "ots_b",    "dialogue": "Eleanor: \"I know.\"",                         "audio_delivery": "low and slow" },
    { "framing": "two_shot", "dialogue": "Vivienne: \"Then you leave with nothing.\"",  "action": "takes one step toward NV1" }
  ],
  "internal_subtext": "Vivienne thử đòn, Eleanor không nhúc nhích."
}
```

Quy tắc (validator bắt từng dòng):
- **`setups` có 2–3 phần tử**, mỗi phần tử một cỡ cảnh **khác nhau**: `ots_a` (qua vai người **bên trái**, nhìn người **bên phải** đang nói), `ots_b` (ngược lại: người bên trái nói), `two_shot` (trung đôi, cả hai trong khung, ai nói cũng được). Thứ tự `setups` là thứ tự cắt; thứ tự đã test là **A → B** và **A → B → trung đôi** (trung đôi làm nhịp kết). Trung đôi mở đầu chưa test.
- **`sides`** chốt ai bên trái, ai bên phải cho cả cuộc nói chuyện (key nhân vật, hoặc key costume họ mặc trong cảnh). Người nói của `ots_a` **phải** là người bên phải, của `ots_b` **phải** là người bên trái — sai là tool từ chối quay. Khi cần đổi người nói, đổi cỡ cảnh (A↔B), không đổi `sides` giữa chừng.
- **Mỗi setup một câu thoại** dạng `Tên: "…"`, tên là tên gọi đầu trong `name` của asset. `audio_delivery` tả cách nói (tiếng Anh, đặt ngay cạnh câu). `action` (tùy chọn) là một hành động nhỏ của người nói ("takes one step toward NV1"), thường ở trung đôi. Câu không ai trong hai người nói được (người thứ ba, thiếu tên) → tool từ chối.
- **Thoại ngắn — ≤ 3 từ mỗi giây.** Tool chia 8 giây theo số từ: 2 setups → 4 + 4 giây (mỗi câu ≤ 8–10 từ); 3 setups → ví dụ 5/2/5 từ → 3/2/3 giây (câu giữa 1–3 từ, hai câu kia ≤ 6–8 từ). Dài hơn Veo nuốt chữ; validator và tool cảnh báo.
- **`uses`** = đúng **2 người** (nhân vật gốc hoặc costume của họ, không cả hai) + **bối cảnh** (cảnh toàn / bối cảnh của địa điểm có `conversation`; góc A/B không cần, tool tự dựng góc từ ảnh khung) + `style` + `audio`. **Không `camera`** (cỡ cảnh nằm trong `setups`), **không `videoPrompt`** (tool tự dựng prompt cắt cảnh; sửa tay trong tool nếu cần). `duration` luôn 8.
- **Bible phải có:** nhân vật `code` + `identity_label` (+ `back_view` khi có cỡ qua vai); bối cảnh `conversation` đủ `place`, `left`/`right` (`background` + `light`, thêm `anchor` khi có trung đôi), `two_shot` khi có trung đôi.
- Trong timeline, cụm chiếm 8 giây và tính là **một shot**; coverage còn lại của beat (establishing, macro reaction, insert đạo cụ, cutaway) vẫn là shot thường 4–7 giây.

---

### Bước 8 — Âm thanh: nhạc nền & tiếng hiện trường
Khai mảng **`audio[]`** ngang hàng `cameras`/`styles` — mỗi phần tử là một **preset âm thanh** cho một hoàn cảnh (tang lễ, đọc di chúc, rượt đuổi, hồi tưởng…), thành node riêng ở **cột "Âm thanh"** của tool và được chèn vào prompt mọi shot dùng nó dưới dạng `Audio: …`.

| Trường | Ghi chú |
|---|---|
| `key` | vd `aud_funeral`, `aud_will_reading`, `aud_storm_night` |
| `name` | Tên gợi nhớ (tiếng Việt được) |
| `prompt` | **Tiếng Anh**, gửi nguyên văn: nhạc nền (nhạc cụ, tiết tấu, cường độ) + tiếng hiện trường (thời tiết, không gian, đạo cụ) + điều cấm. Vd: `low sustained cello drone under light rain on umbrellas, distant chapel bell, wet gravel footsteps; no melody, no percussion, no crowd chatter` |

Mỗi shot chọn một preset: ghi `"audio": "aud_funeral"` **và** lặp key đó trong `uses` (như `camera`/`style`). Cả phim chỉ có đúng một preset thì tool tự nối cho mọi shot.

**Nguyên tắc chọn:** âm thanh đi theo **nhịp** chứ không theo cảnh — setup thưa và lạnh, tension_rising thêm một lớp trầm, confrontation gần như chỉ còn tiếng người và tiếng thở, reveal cắt nhạc (khoảng lặng) rồi một nốt trầm, aftermath để tiếng hiện trường dẫn. Đừng rải nhạc nền dày lên mọi shot.

**Cảnh KHÔNG thoại** (chiếm phần lớn phim): `dialogue` ghi `[Không thoại; <chuyện đang xảy ra>]`, `audio_delivery` tả **tiếng hiện trường bằng tiếng Anh** (`No dialogue; cold wind, distant crows, boots on wet gravel.`). Tool tự thêm câu cấm thoại; nếu shot có preset `audio` thì câu đó giữ nguyên nhạc nền (*Keep the location sound … under the audio bed described below; no voice-over, no narration.*), nếu không có preset thì cấm luôn nhạc (*Audio is location sound only …; no added music…*). Vì vậy **đừng tự viết** câu cấm nhạc/thoại vào `videoPrompt`, và **tuyệt đối không** viết thoại, voiceover hay "she says" vào những shot này.

## Chế độ phim dài (Feature Mode) — 20–60+ phút

Một phim dài KHÔNG phải một khối JSON khổng lồ. 60 phút ≈ 3.600s, mỗi shot 5–7s → 550–700 shot — không dán nổi vào VEO một lần và vỡ đồng bộ. Kiến trúc đúng là **Bible dùng chung + nhiều phân đoạn (sequence)**:

1. **Asset Bible (`bible.json`)** — một file chứa TẤT CẢ `assets` (nhân vật, bối cảnh, đạo cụ) và `cameras` dùng chung cho cả phim. Mỗi asset có đúng một reference image/model sheet, khai một lần, tái dùng xuyên suốt → đồng bộ tuyệt đối. Đây là nơi đồng bộ nhân vật/bối cảnh/giọng cho toàn phim.
2. **Phân đoạn (`seq-01.json`, `seq-02.json`...)** — mỗi file là một blueprint 3–6 phút (một màn/một trường đoạn), chỉ chứa `project` (ghi rõ `part_of` + `sequence_index`), `shots`, và (tùy chọn) vài asset riêng của phân đoạn. Shots trỏ `uses` về key trong Bible. Dán từng phân đoạn vào VEO lần lượt.
3. **Beat sheet cấp phim (3 hồi)** — trải 5 nhịp lên quy mô lớn: Hồi I Setup (~25%), Hồi II Tension+Confrontation với một *midpoint twist* (~50%), Hồi III Reveal+Aftermath (~25%). Mỗi hồi gồm vài phân đoạn; mỗi phân đoạn vẫn có đường cong cảm xúc nhỏ của riêng nó (mini beat sheet) để từng tập tự đứng được.

Quy trình dựng phim dài: (a) chốt logline + twist ladder cấp phim → (b) viết **Bible** trước → (c) lập **bảng phân đoạn** (sequence map: mỗi dòng = tên, hồi, phút, số shot, asset chính, twist) → (d) sản xuất lần lượt từng `seq-XX.json`, mỗi phân đoạn vẫn chạy đủ Bước 5–7 và tuân thủ trần ≤10 hình/shot. Chi tiết công thức chia & continuity manifest: đọc `resources/feature-film-mode.md`.

**Số shot phải khớp thời lượng.** Số shot ≈ giây ÷ 6. Một phân đoạn 5 phút = 300s → **~48–52 shot**, KHÔNG phải 12–15. Đừng kéo dài shot để "đủ phút" (VEO không render clip dài) — giữ shot 5–7s và tăng SỐ LƯỢNG bằng **coverage**: mỗi beat thoại nở thành chùm 5–9 shot qua nhiều góc (establishing → OTS A → reverse OTS B → macro reaction → insert đạo cụ → cutaway → push-in/dutch/low-angle), xen máy tĩnh với máy động, giữ trục 180°. Nếu anh **tạo ảnh reference trước** thì mỗi shot nạp tới 10 hình thoải mái (nhân vật + góc bối cảnh + đạo cụ). Chi tiết coverage: `resources/feature-film-mode.md` mục 3b–3c. **Trao đổi thoại 2–3 câu viết thành một cụm `setups`** (Bước 7b: 8 giây, 2–3 cỡ cảnh, một lần render) thay cho các shot OTS rời; chỉ phần coverage không thoại (establishing, macro, insert, cutaway) còn là shot thường.

**Bible-first (bắt buộc):** Bible là nguồn chân lý DUY NHẤT về asset. Trước khi viết mỗi phân đoạn, liệt kê asset nó cần; cái nào **chưa có trong `bible.json` thì BỔ SUNG vào Bible trước** (append asset mới đủ trường), rồi seq mới trỏ `uses` tới key — không khai asset local trong file seq, để các seq sau tái dùng đúng reference image và không vỡ đồng bộ.

**Luôn chạy validator** `scripts/validate_blueprint.py` trên mỗi phân đoạn (kèm `--bible bible.json`) trước khi giao — nó kiểm đủ/không-quá-10 hình, ref hợp lệ, timeline, nhịp, và cảnh báo nếu seq khai asset local thay vì bỏ vào Bible. Đừng tự tin bằng mắt; để script bắt lỗi.

---

## Tuân thủ Veo — viết prompt KHÔNG bị cấm vì "dùng người" (BẮT BUỘC)

> **Áp cho MỌI cảnh — cảnh chính VÀ mọi phân cảnh phụ (sub-scene / coverage) mà công cụ vẽ ra.** Mỗi phân cảnh phụ vẫn là một shot đầy đủ: nó phải mang **dòng cast + @NV + đuôi nhãn hư cấu** y như cảnh chính. Không cảnh nào được bỏ nhãn an toàn.

Veo soi gắt mọi chân dung người photoreal (cả prompt lẫn ảnh reference) và có **bộ lọc Celebrity** từ chối "photorealistic representation of a prominent person". Nó cực nhạy: một gương mặt AI chỉ cần **hơi giống** một người thật/một người mẫu là bị chặn — dù nhân vật do AI tự tạo. Để giảm false-positive:

- **Nhãn hư cấu bắt buộc.** Mọi model sheet nhân vật + costume ghi rõ cuối prompt: *"original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is purely coincidental."* `style` cũng mang câu tương tự; đuôi mỗi `videoPrompt` thêm *"fictional characters only, no resemblance to any real person or celebrity."*
- **Không nêu tên người thật**, không "looks like / in the style of [tên]", không "celebrity/famous/supermodel".
- **Chỉ huy nhân vật bằng mã NV** (@NV1, @NV2…) thay tên riêng trong videoPrompt/blocking, kèm dòng cast "NV1 is …" để VEO bind reference. Tên riêng chỉ còn trong lời thoại (tự nhiên, không kích lọc).
- **Không nạp ảnh người thật / ảnh tạp chí / ảnh người mẫu stock** làm reference (vừa dính Celebrity vừa dính bản quyền). Chỉ dùng model sheet AITạo của mình.
- **Đa dạng hoá nét mặt**, tránh superlatives ("người đẹp nhất") và tổ hợp quốc tịch+nghề dễ trùng một ngôi sao cụ thể.
- **Cấp nền tảng:** nếu vẫn bị chặn, bật `person_generation` phù hợp (vd `allow_adult`) khi gọi API, hoặc xin **allowlist "realistic person likeness"** của Vertex cho project (dùng hợp pháp). Đây là tham số API, không nằm trong blueprint.
- Các từ dễ dính lọc khác: "pills/prescription" (ma tuý/thuốc) → nếu lọ thuốc bị chặn, đổi thành "a small glass vial" bỏ chữ pills/prescription; tránh mô tả vũ khí/bạo lực đồ hoạ; tuyệt đối không dùng từ trẻ em (child/kid/boy/girl) cho nhân vật.

### Đuôi an toàn bắt buộc cho MỌI videoPrompt (chính & phụ)
Mỗi `videoPrompt` — kể cả phân cảnh phụ — phải:
- **Mở đầu**: không cần gì — tool tự ghép dòng `Reference subjects, in the order of the attached images: [1] NV1; …`. Đừng tự viết mô tả nhận dạng.
- **Chỉ huy diễn xuất** bằng `@NV1, @NV2…` (không bằng tên riêng); bối cảnh/vật dụng giữ `@scene_… / @prop_…`.
- **Kết thúc** bằng: `… 16:9, no artifacts` + `fictional characters only, no resemblance to any real person or celebrity.` **chỉ khi trong khung có người**. Đừng lặp lại `cinematic 35mm, photorealistic, no text` ở đuôi shot: node Style đã mang sẵn và tool nối vào mọi shot — lặp hai lần chỉ làm loãng prompt.

### Checklist trước khi gửi VEO (soát từng shot & từng phân cảnh phụ)
1. Không tên người thật/nổi tiếng ở bất kỳ đâu (thoại chỉ giữ tên nhân vật hư cấu trong ngoặc kép).
2. Người trong khung → tham chiếu `@NVk` trong prompt, **không mô tả ngoại hình** (tool tự ghép dòng ánh xạ ảnh ↔ mã).
3. Đuôi prompt có nhãn hư cấu "no resemblance to any real person or celebrity".
4. Reference chỉ là model sheet / costume AI tạo — KHÔNG ảnh người thật/tạp chí/model stock.
5. Không từ cấm: celebrity / famous / supermodel / "looks like [tên]"; pills / prescription; child / kid / boy / girl; vũ khí–bạo lực đồ hoạ.
6. Nếu vẫn bị chặn: bật `person_generation=allow_adult` hoặc xin allowlist realistic-person-likeness (cấp API).

### Tự động gắn nhãn an toàn
Chạy `python scripts/make_veo_safe.py <seq.json> --bible bible.json` để **tự áp cho toàn bộ shot (gồm phân cảnh phụ)**: đổi `@tên`→`@NV`, **xóa câu giới thiệu ngoại hình** "In this shot, NVk is a …" (tool tự ghép dòng ánh xạ, mô tả thừa chỉ chọi với ảnh), thêm đuôi nhãn hư cấu. Rồi `validate_blueprint.py` kiểm lại. Nhờ vậy dù phân cảnh phụ mới sinh ra, một lệnh là toàn bộ "an toàn Veo".

Skill cũng đã nhúng sẵn nhãn hư cấu vào model sheet nhân vật, costume và style — nên blueprint xuất ra "an toàn Veo" mặc định.

## Định dạng output

- Mặc định (`OUTPUT: inline`): xuất **một khối ```json duy nhất**, không lời dẫn thừa bên trong khối. Nếu phải nêu giả định đã tự chọn, viết 1–2 dòng *trước* khối JSON rồi mới tới khối.
- Blueprint dài (nhiều shot) hoặc khi `OUTPUT: file`: lưu ra `.json` trong outputs và present để Tiến tải, kèm khối JSON trong chat để copy nhanh.
- JSON phải hợp lệ (parse được): dấu phẩy đúng, thoại tiếng Việt escape dấu nháy trong chuỗi.

Trước khi trả, soát nhanh 10 điểm: (1) mọi `uses` trỏ đúng `key` Bible VÀ mọi `@key` ảnh trong videoPrompt đều nằm trong `uses`; (2) **mỗi shot có đúng 1 camera + 1 style trong `uses`** (khớp scalar); **mỗi người trong khung đại diện bằng ĐÚNG 1 costume** (không kèm nhân vật gốc, không 2 costume cùng người → chống mặc lẫn); (3) **số ẢNH/shot ≤ 10** (costume + bối cảnh + vật dụng; camera/style không tính); (4) mỗi nhân vật đủ voice_profile + expression_matrix; (5) tổng duration khớp beat sheet; (6) đường emotional_value có lên-xuống; (7) cặp đối thoại khớp `axis_180`; (8) **mỗi shot có đúng 1 preset `audio`** trong `uses` (khớp scalar), shot im lặng ghi `dialogue: "[Không thoại; …]"` + `audio_delivery` tả tiếng hiện trường bằng tiếng Anh; (9) **videoPrompt không có mô tả ngoại hình/giọng** (không "NV1 is a … woman", không tả tóc/quần áo/tuổi/giọng); (10) **cụm đối thoại** (`setups`, Bước 7b): 2–3 cỡ cảnh khác nhau, có `sides`, người nói của `ots_a` ở bên phải / `ots_b` ở bên trái, ≤ 3 từ mỗi giây, không `camera`/`videoPrompt`, nhân vật có `code` + `identity_label` + `back_view`, bối cảnh có `conversation`. Chạy `python scripts/validate_blueprint.py <file.json> [--bible bible.json]` để máy kiểm thay vì soát tay.

---

## Tài nguyên mở rộng

Mở khi cần, không nạp sẵn:
- `resources/json-schema.md` — đặc tả đầy đủ mọi trường JSON mở rộng + giải thích từng trường. Đọc khi cần nhớ chính xác tên/ý nghĩa field.
- `resources/cinematic-language.md` — bảng tra cỡ cảnh, chuyển động máy VEO, ánh sáng tâm lý, 180 độ, beat sheet, ma trận biểu cảm. Đọc khi cần chọn ngôn ngữ điện ảnh cho một shot.
- `resources/template-expanded.json` — một blueprint mẫu **đã mở rộng đầy đủ** (nhiều nhân vật có expression_matrix, 4 góc neo, nhiều đạo cụ, nhiều máy, 8 shot bám beat sheet). Dùng làm khuôn chuẩn để nhân bản — copy cấu trúc rồi thay nội dung theo chuyện mới.
- `resources/anti-errors.md` — các lỗi AI hay mắc (sai trục, tả lại quần áo, vỡ continuity, nhịp phẳng) và cách phòng. Đọc khi review blueprint trước khi giao.
- `resources/feature-film-mode.md` — kiến trúc phim dài 20–60+ phút: Bible dùng chung, cách chia hồi/màn/phân đoạn, công thức tính số shot, continuity manifest, mẫu `bible.json` + `seq-XX.json`. Đọc khi làm phim dài.
- `scripts/validate_blueprint.py` — script Python kiểm một blueprint (hoặc nhiều phân đoạn + `--bible`): ép trần ≤10 hình tham chiếu/shot, ref đủ-và-hợp-lệ, timeline liền mạch, nhịp beat, đường cảm xúc, và **cụm đối thoại** (`setups`: cỡ cảnh, bên người nói, tốc độ thoại, trường Bible cần có). Chạy trước khi giao mỗi phân đoạn.
- `resources/tool-integration-spec.md` — đặc tả cho người làm **tool node-graph**: mô hình node/cổng, luồng dây `nhân vật → trang phục → cảnh`, cách đọc JSON để vẽ dây, quy tắc render, validation. Đọc khi sửa/đồng bộ tool với blueprint.
- `scripts/make_veo_safe.py` — tự gắn nhãn an toàn VEO cho MỌI shot của một phân đoạn (gồm phân cảnh phụ): đổi `@tên`→`@NV`, xóa câu giới thiệu ngoại hình, thêm đuôi nhãn hư cấu. Chạy sau khi dựng/vẽ thêm phân cảnh phụ, rồi validate lại.
- `scripts/split_bible.py` — sinh `bible-seq-XX.json` (subset self-contained) từ `bible.json` master + một seq, để giao mỗi tập dưới dạng cặp bible-seqX + seqX mà vẫn đồng bộ với master. Đọc mục 6d trong feature-film-mode để nắm điều kiện đồng bộ ảnh.
