# Đặc tả hệ Trang phục cho Tool Node (Costume Wiring Spec)

Tài liệu cho người sửa **tool node-graph** đọc blueprint JSON và vẽ dây đúng. Trọng tâm: **nhân vật xuyên suốt + trang phục theo bối cảnh**, và luồng `nhân vật → trang phục → cảnh`.

---

## 1. Vấn đề cần giải

1. **Nhân vật phải xuyên suốt**: cùng một khuôn mặt qua cả phim 60 phút, nhiều phân đoạn.
2. **Trang phục đổi theo bối cảnh**: cùng nhân vật nhưng tang lễ mặc đồ tang, dạ tiệc mặc gala, công sở mặc suit…
3. **VEO lấy trang phục từ ẢNH reference.** Nếu đưa "ảnh mặt nhân vật" + "ảnh bộ đồ" rời vào cùng một cảnh, hoặc nhiều bộ đồ rời cùng lúc, VEO **mặc lẫn**: gắn nhầm đồ cho người, hoặc trộn hai bộ.
4. ⇒ Cảnh phải nhận **một ảnh "nhân vật ĐÃ mặc đúng đồ"** (một look hoàn chỉnh), không nhận mảnh rời. Trang phục là **một bước xử lý/render trung gian** giữa nhân vật và cảnh.

**Lỗi tool hiện tại:** node trang phục báo *"0 ảnh đầu vào"* — tool mới chỉ đọc `shot.uses` để vẽ `trang phục → cảnh`, nhưng **chưa đọc input của node trang phục** để vẽ `nhân vật → trang phục`. Thiếu đúng đoạn đầu của luồng.

---

## 2. Các loại node & cổng (IN / OUT)

| Node | Nguồn trong JSON | IN | OUT | Ý nghĩa OUT |
|---|---|---|---|---|
| **Nhân vật** | `assets[]` role=`character` | — | 1 | Ảnh nhân vật mặc **trang phục chính** (model sheet gốc) |
| **Bộ đồ** | `wardrobe[]` kind=`outfit` | — (độc lập) | 1 | Ảnh BỘ ĐỒ trên ma-nơ-canh (không mặt) |
| **Node phối** | `wardrobe[]` kind=`worn` | **nhân vật + bộ đồ** | 1 | Ảnh **nhân vật đã mặc bộ đồ** (render lại, khóa mặt) |
| **Vật dụng** | `wardrobe[]` kind=`item` | (tuỳ chọn) | 1 | Ảnh đạo cụ (di chúc, nhẫn, điện thoại…) |
| **Bối cảnh** | `assets[]` role=`scene` | — | 1 | Ảnh bối cảnh |
| **Style** | `styles[]` | — | 1 | Tham số style (ống kính/tông màu) |
| **Máy quay** | `cameras[]` | — | 1 | Tham số chuyển động máy |
| **Âm thanh** | `audio[]` | — | 1 | Nhạc nền + tiếng hiện trường (cột riêng "Âm thanh"), chèn `Audio: …` vào prompt shot |
| **Cảnh/Shot** | `shots[]` | nhiều | 1 | Video của shot |

---

## 3. Luồng dây (wiring) — hai nhánh

```
NHÁNH A — look chính (default):
   [Nhân vật] ──OUT──────────────────────────► IN [Cảnh/Shot]

NHÁNH B — look khác (đổi đồ):
   [Nhân vật] ──OUT──► IN [Trang phục] ──(render lại: người + đồ mới)──► OUT ──► IN [Cảnh/Shot]

Luôn có, nối vào mọi Shot:
   [Bối cảnh] ──► [Shot]
   [Vật dụng] ──► [Shot]      (khi cảnh có đạo cụ)
   [Style]    ──► [Shot]
   [Máy quay] ──► [Shot]
```

- Nhân vật dùng **trang phục chính** → nối **thẳng** nhân vật vào cảnh (Nhánh A).
- Nhân vật **đổi đồ** → nối nhân vật vào node trang phục; node trang phục render lại rồi mới nối vào cảnh (Nhánh B).
- **Mỗi người trong một cảnh chỉ đi theo MỘT nhánh** (A hoặc B), không cả hai.

---

## 4. Cách tool đọc JSON để dựng graph

### 4.1 Tạo node
- Mỗi phần tử `assets[]` role=`character` → **node Nhân vật** (cột Nhân vật).
- Mỗi phần tử `assets[]` role=`scene` → **node Bối cảnh**.
- Mỗi phần tử `wardrobe[]`:
  - `kind="costume"` → **node Trang phục** (cột Trang phục - Vật dụng).
  - `kind="item"` → **node Vật dụng** (cùng cột).
- Mỗi phần tử `styles[]` → **node Style**; `cameras[]` → **node Máy quay** (cột Style & Máy quay).
- Mỗi phần tử `shots[]` → **node Cảnh/Shot** (cột Sản xuất video).

### 4.2 Vẽ dây (đây là phần cần sửa)
> **QUY TẮC NỐI TỔNG QUÁT:** bất kỳ node nào có trường `uses` đều vẽ dây **mỗi key trong `uses` → cổng IN của node đó**. Áp cho: node phối `worn` (`uses:[nhân vật, bộ đồ]`), góc phân cảnh (`uses:[bối cảnh chính]`), và shot (`uses:[...]`). Các node KHÔNG có `uses` là nguồn thuần (chỉ OUT): nhân vật gốc, **bộ đồ `outfit` (độc lập, không input)**, bối cảnh master, camera, style.
>
> **Trang phục = 3 node:** `nhân vật ─┐`, `bộ đồ (outfit, độc lập) ─┘→ node phối (worn) → cảnh`. Bộ đồ KHÔNG nhận input; node phối nhận 2 input (nhân vật + bộ đồ) qua `worn.uses`. **Bối cảnh = master + góc:** `bối cảnh chính → góc (angle, uses:[master]) → cảnh`. Shot trỏ tới node phối (worn) và góc (angle), không trỏ bộ đồ/master trực tiếp.

**(a) Vẽ dây cho mọi node có `uses`** (node phối, góc, shot):
```
# QUY TAC TONG QUAT: moi node co 'uses' -> ve day tu moi key trong uses vao node do
for node in (wardrobe + scene_angles):   # worn: uses=[nhan vat, bo do]; angle: uses=[master]; outfit: khong uses
    for k in (node.uses or []):
        draw_edge(node[k].OUT  ->  node[node.key].IN)
```

**(b) Dây các node → cảnh** — đọc từ `shot.uses`:
```
for shot in shots:
    for key in shot.uses:
        src = node[key]
        draw_edge(src.OUT  →  node[shot].IN)
```
Khi `key` là:
- `character` → `Nhân vật → Shot` (Nhánh A, look chính).
- `costume`   → `Trang phục → Shot` (Nhánh B; đầu kia của trang phục đã nối nhân vật ở bước a).
- `scene` → `Bối cảnh → Shot`; `item` → `Vật dụng → Shot`.
- `camera` → `Máy quay → Shot`; `style` → `Style → Shot`.

> Phân loại `key` bằng cách tra nó thuộc nhóm nào: `assets`(character/scene) / `wardrobe`(costume/item) / `cameras` / `styles`.

---

## 5. Quy tắc RENDER (quan trọng)

| Node | Khi nào render | Dùng gì | Kết quả (OUT) |
|---|---|---|---|
| **Nhân vật** | Một lần | `assets[].prompt` (model sheet: mặt + trang phục chính) | Ảnh nhân vật gốc |
| **Trang phục** | Khi có nhân vật nối vào IN | `wardrobe[].prompt` (render LẠI người đó mặc đồ mới) + ảnh nhân vật ở IN để **khóa mặt** | Ảnh "nhân vật đã mặc đồ mới" |
| **Vật dụng** | Một lần | `wardrobe[].prompt` | Ảnh đạo cụ |
| **Cảnh/Shot** | Khi đủ input | `shot.videoPrompt` + mọi ảnh/look/bối cảnh/vật dụng ở IN + style + máy | Video clip |

- Node Trang phục **phải render lại** (không phải chỉ hiển thị ảnh bộ đồ). Input là ảnh nhân vật → output là chính người đó mặc đồ mới, giữ nguyên mặt. Đây là ảnh "nhân vật mới" đẩy sang cảnh.
- Nếu đổi trang phục ở nhiều cảnh khác nhau, OUT của node trang phục có thể tái dùng cho mọi cảnh dùng look đó.

---

## 6. Ràng buộc kiểm tra trong tool (validation)

1. **Mỗi node Trang phục có đúng 1 input nhân vật** (`costume.uses` chứa đúng 1 character; nếu trống → lỗi "thiếu dây nhân vật → trang phục").
2. **Mỗi người trong một cảnh chỉ một look:** trong `shot.uses`, với một nhân vật P, chỉ được xuất hiện **một** trong hai: node Nhân vật P, hoặc một node Trang phục có `for=P`. Không cả hai; không hai costume cùng `for=P` → chống mặc lẫn.
3. **Số ẢNH vào một shot ≤ 10:** đếm các input là ảnh (node Nhân vật + Trang phục + Vật dụng + Bối cảnh). **KHÔNG** đếm Style và Máy quay.
4. **@mention khớp look:** nếu `videoPrompt` nhắc `@P` (một nhân vật), thì `shot.uses` phải có node Nhân vật P hoặc một costume `for=P`.
5. **Camera/Style:** mỗi shot đúng 1 camera + 1 style trong `uses`.

---

## 7. Hợp đồng dữ liệu (các trường tool phải đọc)

```jsonc
// NHÂN VẬT
assets[] = {
  key, role:"character", name,
  prompt,              // model sheet: mặt + tóc + vóc + TRANG PHỤC CHÍNH
  physical_anchors[],  // đặc điểm khóa mặt
  voice_profile{}, expression_matrix{},
  wardrobe{ default:"<look>", "<look>":"<costume_key>|base|null", ... }  // từ điển look
}
// BỐI CẢNH
assets[] = { key, role:"scene", name, prompt, lighting_profile }

// TRANG PHỤC & VẬT DỤNG  (nhóm riêng, cột "Trang phục - Vật dụng")
wardrobe[] = {
  key, kind:"costume", for:"<nhân vật>", uses:["<nhân vật>"],   // INPUT nhân vật
  name, prompt,          // render lại người đó mặc đồ mới (khóa mặt)
  continuity_note
}
wardrobe[] = { key, kind:"item", for?:"<nhân vật>", name, prompt, continuity_note }

styles[]  = { key, name, prompt }
cameras[] = { key, name, config }

// CẢNH / SHOT
shots[] = {
  name, start, duration, beat, emotional_value,
  uses:[ ... ],   // LOOK (nhân vật gốc HOẶC costume) + bối cảnh + vật dụng + 1 camera + 1 style
  camera:"<key>", style:"<key>",
  axis_180, blocking, dialogue, audio_delivery, internal_subtext,
  videoPrompt, transition_to_next
}
```

Quy ước `wardrobe` dict trên nhân vật: giá trị `"base"` = look chính (nằm trong model sheet, nối thẳng); `"<costume_key>"` = look khác (có node trang phục); `null` = look dự kiến chưa dựng.

---

## 8. Ví dụ cụ thể (seq-01, bối cảnh tang lễ)

- **Eleanor**: look chính = đồ tang (đã ở model sheet) → nối **thẳng** `eleanor → shot`.
- **Thomas / Reyes**: look chính (lễ phục / áo trench) → nối thẳng.
- **Julian**: look chính = business suit; tang lễ cần đồ tang → node `costume_julian_mourning` với `uses:["julian"]`. Dây: `julian → costume_julian_mourning → shot`.
- **Vivienne**: tương tự → `vivienne → costume_vivienne_mourning → shot`.

Shot 01-03 (`uses = [eleanor, costume_julian_mourning, costume_vivienne_mourning, scene_cemetery, veo_truck_table, style_main]`) vẽ thành:
```
eleanor ───────────────────────────► [Shot 01-03] ─► video
julian ──► costume_julian_mourning ──► [Shot 01-03]
vivienne ► costume_vivienne_mourning ► [Shot 01-03]
scene_cemetery ─────────────────────► [Shot 01-03]
veo_truck_table ────────────────────► [Shot 01-03]
style_main ─────────────────────────► [Shot 01-03]
```

---

## 9. Pseudo-code dựng graph + validate

```python
# 1) TAO NODE
for a in assets:
    if a.role == "character": make_node("character", a.key)
    if a.role == "scene":     make_node("scene", a.key)
for w in wardrobe:
    make_node(w.kind, w.key)        # "costume" | "item"
for s in styles:  make_node("style", s.key)
for c in cameras: make_node("camera", c.key)
for sh in shots:  make_node("shot", sh.name)

# 2) DAY: nhan vat -> trang phuc   (PHAN DANG THIEU)
for w in wardrobe:
    if w.kind == "costume":
        src = (w.uses[0] if w.uses else w.for)
        edge(node[src], node[w.key])     # character.OUT -> costume.IN

# 3) DAY: moi thu -> shot
for sh in shots:
    for key in sh.uses:
        edge(node[key], node[sh.name])   # *.OUT -> shot.IN

# 4) VALIDATE
for w in wardrobe:
    if w.kind=="costume" and not (w.uses or w.for):
        error(f"{w.key}: thieu input nhan vat")
for sh in shots:
    imgs = [k for k in sh.uses if group(k) in ("character","scene","costume","item")]
    assert len(imgs) <= 10
    forset = [costume_for(k) for k in sh.uses if group(k)=="costume"]
    # moi nguoi 1 look:
    for p in set(forset):
        assert forset.count(p) == 1
        assert p not in sh.uses           # khong vua nhan vat goc vua costume
```

---

## 9b. Âm thanh & cảnh im lặng

- Mỗi `audio[]` → **node Âm thanh** (cột riêng, như Style/Máy quay: chỉ có OUT, không render ảnh). Shot ghi key preset trong `uses` (+ scalar `audio`) → dây `âm thanh → shot`; nội dung vào prompt thành `Audio: <prompt>`. Cả blueprint chỉ có 1 preset thì tool nối cho mọi shot (như style đơn).
- **Shot không thoại** (`dialogue` rỗng hoặc mở đầu bằng `[`): tool tự nối thêm câu
  `No spoken dialogue in this shot: nobody speaks and no lips move. Audio is location sound only — <audio_delivery đã bỏ tiền tố "Không thoại/No dialogue">; no added music, no voice-over, no narration.`
  Shot có thoại (kể cả voiceover) không nhận câu này. Lời hát (blueprint nhạc) cũng không bị coi là im lặng.

## 9c. Cụm đối thoại (`setups`) → node khung + node "Phân cảnh ghép"

Một mục shot có `setups` (2–3 phần tử) KHÔNG thành một node shot. Tool dựng:

```
[Bối cảnh] ─┐                       (ảnh 1)
[Người trái] ┼─► [Khung 1 · qua vai A] ─┐
[Người phải] ┘   [Khung 2 · qua vai B] ─┼─► [Phân cảnh ghép] ─► video 8 giây (cột ⑧)
                 [Khung 3 · trung đôi]  ┘       ▲
[Style], [Âm thanh] ────────────────────────────┘
```

- **Node khung** (cột ⑥ Sản xuất, `role:"frame"`, `frameNo` 1..3, `framing`): một ảnh tĩnh mỗi cỡ cảnh. Dây vào theo đúng thứ tự **[1] bối cảnh, [2] người bên trái, [3] người bên phải** — prompt ảnh gọi "from image 2 / image 3" theo thứ tự này. Prompt ảnh do tool dựng từ `identity_label`, `back_view`, `conversation` (mẫu qua vai / trung đôi đã test); `setups[].prompt` viết tay sẽ thay mẫu. Node khung **không bao giờ được quay riêng**; mọi chạy hàng loạt bỏ qua nó.
- **Người bên trái/phải**: `sides` (key nhân vật hoặc costume) → node nhân vật gốc, hoặc node phối `worn` khi cảnh dùng costume của họ (nhân vật gốc không nối thêm). Thiếu `sides` thì theo thứ tự trong `uses`.
- **Bối cảnh**: `place`, hoặc bối cảnh đầu tiên trong `uses`; góc `kind:"angle"` quy về master qua `of`. Cần `conversation` trên node đó (hoặc trên master của nó).
- **Node Phân cảnh ghép** (cột ⑦, `role:"merged"`, `duration` 8, `videoInput` refs): nối từ các khung + style + âm thanh. Ảnh gửi Veo = ảnh của 2–3 khung theo thứ tự cắt (mode multi-image-to-video = Ingredients). Prompt = tool dựng: mô tả từng ảnh là setup nào, khóa trái/phải, mốc cắt (2 khung: 00:04; 3 khung: theo số từ, ví dụ 00:03 và 00:05), mỗi khối một câu + "Only X speaks; Y … lips closed", Voice lock từng người nói, Room sound từ preset `audio`, Style, đuôi chống chữ. Clip về cột ⑧ Video cùng hàng.
- **Tool từ chối quay** khi: thiếu khung/ảnh khung, ảnh khung cũ, thiếu trường Bible, hai khung cùng cỡ, khung nối khác bối cảnh/người, câu không ai trong hai người nói được, người nói của qua vai không phải người quay mặt về máy. Chỉ **cảnh báo** khi > 3 từ/giây.
- `camera`, `videoPrompt`, `dialogue` ở cấp shot của cụm bị bỏ qua.

## 10. Tóm tắt một dòng
Nhân vật là node gốc (mặc trang phục chính). Cảnh dùng look chính thì nối **nhân vật → cảnh**. Cảnh đổi đồ thì nối **nhân vật → trang phục (render lại người mặc đồ mới) → cảnh**. Node trang phục BẮT BUỘC có input là nhân vật; cảnh chỉ nhận look hoàn chỉnh, mỗi người đúng một look.
