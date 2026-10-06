# Chế độ phim dài (Feature Mode) — 20 đến 60+ phút

Phim dài không phải một blueprint phình to. Nó là **một Bible dùng chung + nhiều phân đoạn**, mỗi phân đoạn dán vào VEO riêng. Tài liệu này cho công thức chia, cấu trúc file, và cách giữ đồng bộ xuyên suốt.

## Mục lục
1. Vì sao phải chia
2. Ba lớp file: Bible / Sequence / (Manifest)
3. Công thức tính số phân đoạn & số shot
4. Beat sheet cấp phim (3 hồi)
5. Ràng buộc ≤10 hình tham chiếu mỗi cảnh
6. Quy trình sản xuất tuần tự
7. Mẫu `bible.json` (rút gọn)
8. Mẫu `seq-XX.json` (rút gọn)
9. Continuity manifest (sequence map)

---

## 1. Vì sao phải chia
60 phút ≈ 3.600 giây. Mỗi shot VEO 5–7s → **550–700 shot**. Một file JSON như thế: không dán nổi một lần, dễ hỏng cú pháp, và VEO không thể giữ đồng bộ qua ngần ấy shot. Chia nhỏ để mỗi lần render chỉ lo một trường đoạn, còn đồng bộ thì dồn về Bible.

## 2. Ba lớp file
- **`bible.json`** — nguồn chân lý về asset. Chứa toàn bộ `assets` (nhân vật + bối cảnh + đạo cụ, mỗi cái một reference image/model sheet) và `cameras` dùng chung. Khai một lần, dùng cả phim → nhân vật/bối cảnh/giọng không trôi giữa các tập.
- **`seq-01.json`, `seq-02.json`, …** — mỗi phân đoạn 3–6 phút. Chứa `project` (có `part_of`, `sequence_index`, `act`), `shots`, và tùy chọn vài asset riêng chỉ xuất hiện trong phân đoạn đó. `shots.uses` trỏ về `key` trong Bible.
- **(tùy chọn) sequence map** — một bảng (markdown/ًcsv) liệt kê thứ tự phân đoạn, hồi, phút, số shot, asset chính, twist. Dùng để điều phối sản xuất.

## 3. Công thức số phân đoạn & số shot
- Độ dài trung bình 1 shot: lấy 6s (an toàn giữa 5–7).
- **Số shot của một phân đoạn = thời_lượng_giây ÷ 6.** Đây là phép tính bắt buộc kiểm trước khi viết.
  - 3 phút = 180s → ~30 shot
  - **5 phút = 300s → ~48–52 shot**
  - 6 phút = 360s → ~60 shot
- Phim 60 phút → ~600 shot tổng, chia ~12 phân đoạn × ~5 phút (~50 shot/phân đoạn).

Lỗi thường gặp: viết 12–15 shot rồi khai `duration_seconds: 300`. Sai — 15 shot chỉ ~90s. Hoặc viết đủ 50 shot nhưng mỗi shot kéo 20s cho "đủ phút" — cũng sai, VEO không render clip dài. **Giữ shot 5–7s và tăng SỐ LƯỢNG shot, không kéo dài shot.** Cách tăng số shot đúng nghề là "coverage" (mục 3b), không phải thêm cảnh rời rạc.

### 3b. Coverage — chia một beat thành nhiều shot (đạo diễn chuẩn)
Phim điện ảnh không quay một đoạn thoại bằng một cú máy. Mỗi "beat" (một nhịp kịch, một trao đổi) được **phủ (cover)** bằng một chùm shot từ nhiều góc, rồi dựng cắt qua lại. Một trao đổi thoại A–B điển hình nở thành 5–9 shot:
1. **Establishing / wide** — xác lập ai ở đâu (two-shot, thấy khoảng cách & thế lực).
2. **OTS lên A** — A nói (qua vai B).
3. **Reverse OTS lên B** — phản ứng B (giữ trục 180°, hướng nhìn ngược chiều A).
4. **Macro reaction** — cận mắt/tay nhân vật ở câu nặng nhất (vi biểu cảm).
5. **Insert đạo cụ** — cận vật chứng khi được nhắc/đặt xuống (điện thoại, nhẫn, lọ thuốc).
6. **Cutaway** — người thứ ba quan sát, hoặc chi tiết môi trường (mưa, nến, chân dung trên tường).
7. **Push-in / dutch / low-angle** — nhấn khoảnh khắc quyết định hoặc sụp đổ.

**Mục 2 + 3 (OTS lên A, reverse OTS lên B) — và cả một trung đôi kết nếu có — giờ viết thành MỘT cụm `setups`** (SKILL Bước 7b): một mục shot 8 giây, tool dựng 2–3 ảnh khung và quay chung một clip Veo có cú cắt. Không viết các OTS rời cho cùng một trao đổi nữa; các shot còn lại của chùm (establishing, macro, insert, cutaway, push-in) vẫn là shot thường.

Xen **máy tĩnh** (locked, cho khoảnh khắc nặng, để khán giả tập trung) với **máy động** (truck/push-in/handheld, cho leo thang) — đừng để mọi shot đều động. Mỗi shot vẫn 5–7s; chính coverage làm một trường đoạn 40–60s nở ra 8–12 shot mà vẫn liền mạch, và cả phân đoạn đạt ~50 shot/5 phút một cách tự nhiên.

**Phân cảnh phụ phải an toàn VEO như cảnh chính.** Mỗi phân cảnh phụ (sub-shot coverage) là một shot đầy đủ → `videoPrompt` của nó cũng phải mang **dòng cast + @NV + đuôi nhãn hư cấu** (xem SKILL mục "Tuân thủ Veo"). Sau khi vẽ thêm phân cảnh phụ, chạy `scripts/make_veo_safe.py` một lần để tự áp cho tất cả, rồi `validate_blueprint.py` kiểm lại.

### 3c. Tận dụng tới 10 hình tham chiếu (khi tạo ảnh trước)
Nếu quy trình của anh là **tạo ảnh reference trước rồi mới render video** (khuyến nghị cho phim dài), thì mỗi shot có thể nạp tới 10 hình: nhân vật trong khung + (các) góc bối cảnh + đạo cụ liên quan. Cảnh đông (establishing nhiều người) cứ dùng 6–8 refs cho VEO bám đúng mọi người/vật; cảnh cận một người thì 2–3 refs là đủ. Nguyên tắc vẫn giữ: **đủ** (mọi @key trong prompt có trong uses) và **≤10**.

## 4. Beat sheet cấp phim (3 hồi)
Trải 5 nhịp lên quy mô lớn:

| Hồi | Nội dung | % | Phân đoạn gợi ý (phim 60') |
|---|---|---|---|
| Hồi I — Setup | Giới thiệu thế giới, nhân vật, mầm xung đột, cú hích mở màn | ~25% (15') | seq 01–03 |
| Hồi II — Tension + Confrontation | Leo thang, âm mưu, **midpoint twist** lật bàn giữa phim, dồn ép | ~50% (30') | seq 04–09 |
| Hồi III — Reveal + Aftermath | Bùng nổ sự thật, chuỗi twist cuối, kết | ~25% (15') | seq 10–12 |

Mỗi phân đoạn vẫn có **mini beat sheet** của riêng nó (một đường cong cảm xúc nhỏ) để tự đứng được như một "tập". Rải các cú twist của twist-ladder vào cuối các phân đoạn để giữ khán giả qua từng tập.

## 5. Ràng buộc ≤10 hình tham chiếu mỗi cảnh
`uses` của mỗi shot = tập ảnh reference nạp cho shot đó. Quy tắc:
- **Đủ:** mọi `@key` trong `videoPrompt`/`blocking` phải có trong `uses`.
- **Không quá:** `len(uses)` ≤ 10 (lý tưởng ≤ 6). Công cụ của anh cho bao nhiêu thì đặt `reference_limit` trong `project` bấy nhiêu.
- Cảnh đông → tách shot theo ai thật sự trong khung; đạo cụ phụ gộp vào mô tả thay vì làm asset.
Chạy `scripts/validate_blueprint.py seq-XX.json --bible bible.json` để máy ép ràng buộc này.

## 6. Quy trình sản xuất tuần tự
1. Chốt logline + twist-ladder cấp phim (5–7 cú lật rải 3 hồi).
2. Viết **`bible.json`** trước: tất cả nhân vật (model sheet + voice + expression_matrix), bối cảnh (các góc neo cho mọi địa điểm), đạo cụ, camera presets.
3. Lập **sequence map** (mục 9).
4. **Với MỖI phân đoạn, theo đúng thứ tự Bible-first (mục 6b):**
   a. Liệt kê mọi asset phân đoạn sẽ cần (nhân vật/bối cảnh/góc/đạo cụ).
   b. Đối chiếu Bible — cái nào **chưa có thì BỔ SUNG vào `bible.json` trước** (nhân vật đủ model sheet + voice + expression_matrix; bối cảnh đủ prompt + lighting_profile; đạo cụ đủ prompt + continuity_note).
   c. Cập nhật sequence map cho biết Bible vừa thêm gì.
   d. Mới viết `seq-XX.json`, `uses` chỉ trỏ key trong Bible, chạy đủ Bước 5–7, giữ `start` nối tiếp *trong phân đoạn* (tự đếm từ 0).
5. Validate từng phân đoạn với `--bible`. Sửa tới khi hết ERROR (lỗi "key khong co trong assets" = quên bước 4b, thêm vào Bible).
6. (Tùy chọn) khi ghép toàn phim để kiểm tổng, chạy validator với `--no-timeline`.

### 6c. Nhân vật xuyên suốt + Trang phục là node riêng
Một nhân vật KHÔNG mặc một bộ suốt 60 phút, nhưng MẶT phải xuyên suốt. Mô hình:
- **Nhân vật gốc** là MỘT node trong `assets` (role character), model sheet khóa **mặt + tóc + vóc + TRANG PHỤC CHÍNH (default look)** — dùng ở MỌI phân đoạn. Không bao giờ nhân bản nhân vật.
- **Look chính:** cảnh nào dùng trang phục chính → `shot.uses` nối **thẳng nhân vật gốc** vào cảnh (không cần costume).
- **Look khác:** node costume (`kind:"costume"`, `costume_<tên>_<look>`) có **`uses:[nhân vật gốc]`** (input) + `for`. Luồng: nhân vật (OUT) → **IN costume** → costume **render lại nhân vật mặc đồ mới** (khóa mặt) → **OUT** → cảnh. `shot.uses` nối **costume** (không nối nhân vật gốc). Phải render ảnh "nhân vật đã mặc đồ mới" rồi mới đẩy sang node video.
- Mỗi cảnh, mỗi người = ĐÚNG 1 look (nhân vật gốc HOẶC 1 costume), không cả hai, không 2 costume cùng người → tránh **mặc lẫn**.
- Nhân vật gốc giữ `wardrobe` = từ điển look→key costume (`"base"` = look chính trong model sheet; `null` = chưa dựng).
- **Vật dụng / đạo cụ** (di chúc, điện thoại, nhẫn…) cũng ở nhóm `wardrobe` nhưng `kind:"item"`.

Mỗi phân đoạn chọn look đúng bối cảnh: seq tang → Julian/Vivienne dùng `costume_*_mourning` (look khác), còn Eleanor/Thomas/Reyes dùng look chính (nối thẳng). Thiếu costume nào thì **bổ sung vào Bible trước** (quy tắc 6b). Validator cảnh báo nếu costume thiếu input nhân vật, hoặc shot đưa cả nhân vật gốc lẫn costume.

### 6b. Quy tắc Bible-first (bắt buộc)
**Bible là nguồn chân lý DUY NHẤT về asset.** Mọi nhân vật/bối cảnh/đạo cụ — kể cả cái chỉ xuất hiện một lần — đều khai trong `bible.json`, KHÔNG khai rải rác (`assets` local) trong file seq. Lý do: nhân vật phụ ở seq 03 có thể quay lại seq 09; bối cảnh mới ở seq 05 có thể tái dùng seq 11 — khai local thì các seq sau mất reference image gốc, VEO dựng ra người/cảnh khác → vỡ đồng bộ. Vì vậy **thấy thiếu asset → thêm vào Bible trước, rồi mới dùng.** Validator chạy với `--bible` sẽ cảnh báo nếu seq còn khai asset local, và báo lỗi nếu seq trỏ key chưa có trong Bible. Khi thêm asset mới: đặt `key` nhất quán (`scene_<diadiem>_<goc>`, `prop_<ten>`, tên riêng cho nhân vật) và điền đủ trường như asset cũ để reference image đồng đều.

## 6d. Tùy chọn: `bible-seqX.json` riêng cho mỗi tập
Có thể giao mỗi tập dưới dạng CẶP **`bible-seq-XX.json` + `seq-XX.json`** (self-contained, nạp vào tool chỉ hiện asset của tập đó). **Điều kiện đồng bộ hình ảnh:** tách file KHÔNG tự đồng bộ — đồng bộ đến từ việc **mọi tập dùng CHUNG một reference image cho mỗi key** (ảnh tạo một lần, tái dùng). Vì vậy:
- Giữ MỘT **`bible.json` master** làm nguồn chân lý.
- **Sinh** `bible-seq-XX.json` tự động từ master bằng `scripts/split_bible.py <bible.json> <seq-XX.json>` — nó trích đúng asset tập đó dùng, tự kéo theo nhân vật gốc của mỗi costume (giữ dây nhân vật→trang phục), copy Y NGUYÊN mọi trường từ master → không lệch.
- Khi sửa một asset: sửa ở **master** rồi **sinh lại** các bible-seqX (đừng sửa tay từng file → dễ lệch).
- Khi tạo ảnh: asset xuất hiện nhiều tập (nhân vật chính) chỉ tạo ảnh MỘT LẦN và tái dùng cùng file cho mọi tập (cùng key). Nếu tool tạo ảnh theo prompt mỗi lần, phải trỏ lại ảnh đã có cho key đó.
- Validate mỗi tập với chính bible của nó: `validate_blueprint.py seq-XX.json --bible bible-seq-XX.json`.

## 7. Mẫu `bible.json` (rút gọn)
```json
{
  "film": { "title": "...", "country_setting": "...", "genre": "...",
            "total_minutes": 60, "reference_limit": 10 },
  "styles": [
    { "key": "style_main", "name": "...", "prompt": "Cinematic 35mm ..." }
  ],
  "assets": [
    { "key": "eleanor", "role": "character", "name": "...",
      "voice_profile": { ... }, "prompt": "model sheet — MAT + toc + voc + bo nen trung tinh ...",
      "physical_anchors": [ "...mat/toc/voc, KHONG trang phuc cot truyen..." ],
      "expression_matrix": { ... },
      "wardrobe": { "default": "mourning", "mourning": "base", "gala": null },
      "relationship": "..." },
    { "key": "scene_master_wide", "role": "scene", "name": "...",
      "prompt": "...", "lighting_profile": "..." }
  ],
  "wardrobe": [
    { "key": "costume_julian_mourning", "kind": "costume", "for": "julian",
      "uses": ["julian"],
      "name": "Julian - look do tang",
      "prompt": "Full-length turnaround RE-RENDERING the same person as the connected character (face/hair/build locked), now wearing a black three-piece mourning suit ...; neutral pose, grey background, cinematic 35mm.",
      "continuity_note": "Look khac cho boi canh tang; nhan vat vao qua uses." },
    { "key": "prop_will", "kind": "item", "name": "Di chuc",
      "prompt": "macro ...", "continuity_note": "..." }
  ],
  "cameras": [ { "key": "veo_ots_a", "name": "...", "config": "..." } ]
}
```

## 8. Mẫu `seq-XX.json` (rút gọn)
```json
{
  "project": {
    "title": "Seq 04 — Midpoint: Bức thư nặc danh",
    "part_of": "Di Chúc Nhà Ashford",
    "sequence_index": 4,
    "act": "II",
    "duration_seconds": 300,
    "reference_limit": 10,
    "beat_sheet": { "setup": "...", "tension_rising": "...",
      "confrontation": "...", "reveal": "...", "aftermath": "..." }
  },
  "shots": [
    { "name": "Shot 04-01 — ...", "start": 0, "duration": 6,
      "beat": "setup", "emotional_value": -1,
      "uses": ["costume_eleanor_mourning", "scene_sub_table", "prop_will", "veo_ots_a", "style_main"],
      "camera": "veo_ots_a", "style": "style_main",
      "axis_180": "...", "blocking": "...",
      "dialogue": "...", "audio_delivery": "...",
      "internal_subtext": "...", "videoPrompt": "... @eleanor ...",
      "transition_to_next": "..." }
  ]
}
```
Lưu ý: `seq-XX.json` KHÔNG lặp lại `assets`/`cameras`/`styles` đã có trong Bible — chỉ trỏ `uses` tới key (bổ sung node mới vào Bible trước, mục 6b).

**Liên kết Bible qua `uses` (quan trọng cho công cụ node):** công cụ node vẽ dây từ MỘT cổng IN của shot, đọc danh sách `uses`. Vì vậy `uses` phải liệt kê **mọi node Bible shot nối tới**: nhân vật + bối cảnh + đạo cụ (ảnh) **+ 1 camera key + 1 style key**. Nếu chỉ để camera/style ở trường riêng mà không đưa vào `uses`, node Máy quay và Style sẽ không có dây nối vào cảnh. Shot vẫn giữ scalar `camera` và `style` (bằng đúng key trong uses) để dựng `videoPrompt` và cho người đọc. Trần ≤10 chỉ tính ẢNH, không tính camera/style.

## 9. Continuity manifest (sequence map)
Một bảng điều phối, ví dụ phim 60 phút:

| Seq | Hồi | Phút | ~Shot | Asset chính | Twist / cột mốc |
|---|---|---|---|---|---|
| 01 | I | 5 | 50 | eleanor, julian, scene_master_wide | Thiết lập: nàng dâu bị khinh |
| 02 | I | 5 | 50 | eleanor, augustus(portrait) | Mầm nghi ngờ về cái chết |
| 03 | I | 5 | 50 | julian, prop_vial | Cú hích: di chúc bị niêm phong |
| 04 | II | 5 | 50 | atticus, prop_will | Midpoint twist: di chúc trao cho Eleanor |
| … | … | … | … | … | … |
| 12 | III | 5 | 50 | eleanor, augustus, prop_signet | Twist cuối: Eleanor là mastermind |

Giữ manifest cập nhật để biết asset nào đã khai ở Bible, phân đoạn nào còn thiếu, twist đã rải đều chưa.
