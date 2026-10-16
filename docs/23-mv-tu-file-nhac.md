# MV từ file nhạc: node Nhạc → node Kịch bản (máy đo, LLM viết)

## Trước khi sửa: xưởng gần như mù nhạc

Nối node Nhạc vào node Kịch bản, node Nhạc **"Chưa phân tích"** → đây là nguyên văn thứ xưởng nhận
về bài hát:

```
BÀI HÁT (node Nhạc nối vào node này):
(node nhạc chưa phân tích — chỉ có file/lời)
```

Không thời lượng, không cấu trúc, không mốc giây — LLM tự bịa. Còn bấm "Phân tích" thì đó là LLM
đọc **tên file + lời dạng chữ**, không hề nghe audio. Mốc giây LLM đoán từng lệch tới 25 giây.

Trong khi tool **đã có** đo thật (nút ✨ Tạo storyboard tự động): Demucs tách vocal + đo đường
năng lượng, dựng khung shot theo giây, căn lời theo vocal, dựng hai luồng. Hai đường MV mọc song
song và không nói chuyện với nhau.

## Giờ: ba chế độ, một chỗ quyết định

`lib/studio-kind.mjs` — `studioKind(scriptNode)`:

| Chế độ | Khi nào | Đường |
|---|---|---|
| `drama` | không nối node Nhạc | như cũ |
| `mv` | nối node Nhạc, **chưa có file** (chỉ lời/link) | như cũ, một luồng — không có gì để đo |
| **`mvaudio`** | nối node Nhạc **có file nhạc** | **máy đo, LLM viết, hai luồng** |

## Luồng `mvaudio`

```
① ĐO (lib/music-measure.mjs) — tự chạy khi bấm Chạy xưởng
   mp3 → Demucs: tách vocal + đường năng lượng + nhạc cụ
       → KHUNG: các chặng + ô shot đã khoá giây
   lưu trên node Nhạc theo đúng file + lời → chạy lại không đo lại

② CÁC TRẠM SÁNG TẠO — giữ nguyên
   Nhanh: ① Treatment MV
   Kỹ:    ① Treatment → ② Đạo diễn hình ảnh → ④ Biểu cảm
   đọc tóm tắt số đo THẬT (thời lượng, chặng, năng lượng) thay cho "chưa phân tích"

③ ĐIỀN KHUNG (thay "chia mốc giây" + "ráp JSON")
   LLM nhận: hướng sáng tạo (brief + skill + các trạm trước) + khung CSV
   → CHỈ điền cột sáng tạo; KHÔNG đổi Start/End/Section/Lyric, không thêm/bớt hàng

④ QC = validateFilled + tự sửa ≤2 vòng, giữ bản ít lỗi nhất

⑤ DỰNG = /api/music/import (đúng bộ của nút ✨)
   căn lại giây theo vocal thật → luồng A phủ cảnh + luồng B hát nhép
```

Skill vẫn nguyên giá trị: skill quyết định *nhìn thấy gì* trong mỗi ô, máy đo quyết định *ô nằm
ở giây nào*.

## Node Nhạc cần gì

| Cần | Vì sao |
|---|---|
| **File nhạc** | không có file thì không có gì để đo → rơi về chế độ `mv` cũ |
| **Lời bài hát** | khung chia theo từng câu hát; luồng hát nhép cần lời để căn khẩu hình. Thiếu là bị chặn ngay khi bấm chạy, không đợi chạy xong treatment mới hỏng |

Không cần bấm "Phân tích" nữa — Chạy xưởng tự đo. Đo lần đầu mất vài phút (Demucs; nhanh hơn
nhiều nếu có GPU), lần sau dùng lại.

## Lỗi phát hiện nhân tiện

`lib/package.mjs` đọc `scriptNode.kind === 'mv'` để chọn tên bước — mà `kind` của node Kịch bản
**luôn là `'script'`**, nên **gói giao hàng của project MV luôn xuất tên bước của drama**. Gom về
`studioKind()` dùng chung cho cả bốn nơi (route, public-state, trợ lý đạo diễn, gói giao hàng).
Trợ lý nhận `db` qua tham số nên có bản thuần `studioKindIn(db, node)`.

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/studio-kind.mjs` | **Mới** — `studioKind`, `studioKindIn`, `songOf`, `songIn` |
| `lib/music-measure.mjs` | **Mới** — `measureSong` (lưu đệm theo file+lời), `measuredBrief`, `measuredOf` |
| `lib/script-studio.mjs` | `stages()` thêm `mvaudio`; `runStudio({skeleton})` có bước điền + QC khung |
| `lib/routes/script.mjs` | đo trước các trạm; lưu `n.mvCsv`; `/api/script/build` từ chối `mvaudio` và chỉ đường |
| `lib/public-state.mjs`, `lib/assistant-plan.mjs`, `lib/package.mjs` | dùng `studioKind` |
| `public/js/script.js` | nút Dựng gọi `/api/music/import` (takes: true) cho `mvaudio` |

## Kiểm thử

```powershell
node test-mv-audio.mjs
```

Chạy **Demucs thật** trên một file WAV thật sinh ra trong test (24 giây, hai mức âm lượng). Kiểm:
đo đúng 24s, tách vocal, khung khoá giây, trạm sáng tạo đọc số đo thật, bước điền giữ đúng mốc
giây, đo một lần dùng lại, gói giao hàng xuất đúng tên bước MV, dựng qua bộ hai luồng.

> Luồng B ra 0 take trong test là **đúng**: file thử là âm thuần, không có giọng hát, nên máy căn
> lời không tìm thấy chữ nào. Với bài hát thật có giọng, luồng B cắt theo từng câu.


## Dàn nhân vật theo treatment — khối `cast` (2026-10-13)

**Lỗi thật:** chạy MV "Bajo Tu protección" (bài ru, lời kể về người bà đi quanh nhà cầu nguyện):
treatment viết đúng câu chuyện, nhưng bước điền khung chỉ biết từ vựng sân khấu (Singer / Guitarist /
Audience, Location khoá "Dim concert hall stage"), nên bảng shot thành buổi diễn ban nhạc; dựng xong
mọi shot nối vào mẫu "Ca sĩ" (một cô ca sĩ váy nhung) chứ không phải người bà; nhân vật phụ của câu
chuyện không có node nào; lời tiếng Tây Ban Nha `[Verso] [Coro] [Puente]` bị đọc thành Verse 1–10.

**Sửa:**
- Trạm ① (chế độ có file nhạc) kết bằng **một khối ```cast (JSON)**: ai hát (`singer`), từng người
  xuất hiện (`people`: name, look, identity_label, back_view), các bối cảnh (`places`), và nơi ca sĩ
  hát nhép (`lipsync_place`). Treatment cũ không có khối này → bước điền hỏi riêng khối đó một lượt.
- Bước điền + QC: Subject chỉ dùng tên trong dàn (`"Abuela + Guitarist"` nối nhiều người bằng " + "),
  **Location do LLM chọn trong các bối cảnh của treatment** (khung để trống cột này); ô sai được
  thay như trước. Không có khối cast (nút ✨ của node Nhạc) thì giữ từ vựng sân khấu cũ.
- Dựng: `musicImport({ cast })` đưa dàn qua đúng bộ dựng blueprint (`castBlueprint` → model sheet
  nhân vật, location sheet 3-trong-1, key = slug tên), đánh dấu ca sĩ chính `lead: true` (đường
  "Singer" và take hát nhép dùng người này, không dùng mẫu cũ), nối **mọi** người của "A + B", take
  đặt ở `lipsync_place`. Mẫu cũ không còn shot nào dùng được liệt kê trên thanh tiến trình để xoá.
- Tên đoạn đa ngôn ngữ (`lyricSections`): Verso/Estrofa → Verse, Coro/Estribillo/Điệp khúc → Chorus,
  Pre-Coro → Pre-Chorus, Puente/Ponte → Bridge, Interludio → Instrumental, Coro final → Final Chorus,
  Outro/Cierre/Đoạn kết → Outro. Khung đã đo được dựng lại khi đổi cách đọc (`SKELETON_V`), không
  chạy Demucs lại.

Chạy thật trên project của user (Claude, Kỹ): 6 nhân vật + 4 bối cảnh từ treatment, 78 shot phủ cảnh
+ 50 take, 0 shot thiếu dây, đoạn đọc đúng Intro → Final Chorus → Outro, QC sạch sau 1 vòng.

| File | Thay đổi |
|---|---|
| `lib/music-auto.mjs` | `lyricSections` đa ngôn ngữ; `placeKey`; `CAST_SPEC`, `parseCast`, `castBlueprint`; `fillPrompt`/`fixPrompt`/`validateFilled` nhận `cast` |
| `lib/script-studio.mjs` | `MVAUDIO_STORY` (+ CAST_SPEC), hỏi riêng khối cast khi thiếu, QC theo cast |
| `lib/music-measure.mjs` | `SKELETON_V`, dựng lại khung đã đệm |
| `lib/routes/music.mjs` | `musicImport({cast})` → `applyCast`; `lead`; nối mọi người của "A + B"; take ở `lipsync_place`; `unusedCast` |
| `lib/routes/script.mjs`, `public/js/script.js` | nút Dựng mvaudio đi qua `/api/script/build` (cùng đường tự dựng) |
| `test-mv-audio.mjs` | dàn kể chuyện (Abuela, Adult son, 2 bối cảnh) → điền, kiểm, dựng, nối đủ người |
