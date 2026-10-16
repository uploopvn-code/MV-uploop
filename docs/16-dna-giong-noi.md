# DNA giọng nói (voice lock)

Gắn một "DNA giọng" cho từng nhân vật để **giọng không đổi giữa các clip**. Đặt ở Inspector của
node nhân vật → **🎙 DNA giọng nói**.

## Vì sao cần

Model video tự nghĩ ra giọng cho mỗi lần render. Không khoá thì cùng một nhân vật có thể nói
bằng ba giọng khác nhau ở ba clip. Khoá giọng là một câu mô tả cố định được gắn vào prompt video
mỗi lần nhân vật đó nói:

```
Voice lock for NV1: Female, Early 30s; timbre: bright, a little brittle;
accent: Southern Vietnamese (Saigon); pacing: quick when deflecting;
baseline: defensive cheerfulness. Delivery: <audio_delivery của riêng shot>
```

`Voice lock` giữ **chất giọng** cố định; `Delivery` của từng shot chỉ **điều biến** trên nền đó
(to/nhỏ, nhanh/chậm, run rẩy) — nên diễn xuất thay đổi được mà giọng vẫn là một người.

## Sáu thành phần

| Ô | Ví dụ |
|---|---|
| Giới tính giọng | `Female` |
| Tuổi nghe thấy | `Early 30s` |
| Âm sắc | `bright, a little brittle` |
| Giọng vùng / phát âm | `Southern Vietnamese (Saigon), everyday, not polished` |
| Nhịp nói | `quick when deflecting; short and flat when cornered` |
| Nền cảm xúc | `defensive cheerfulness covering something unadmitted` |

Viết bằng **tiếng Anh**. Sáu ô ghép thành chuỗi theo đúng khuôn mà import dùng
(`voiceOf()` trong `director.mjs`). Muốn tự viết cả câu thì dùng ô raw bên dưới — **nó thắng**.

## Áp ở đâu

| Đường render | Có khoá giọng |
|---|---|
| Shot thường | ✅ `voiceLine()` trong `lib/prompts.mjs` |
| Phân cảnh ghép | ✅ `Voice lock for …` mỗi người nói trong `lib/merged.mjs` |
| Nhóm Seedance | ✅ `lib/seedance.mjs` |
| Take lip-sync (Omni) | — không cần: nó nhận **file vocal thật** làm đầu vào |

Khoá chỉ gắn cho shot mà nhân vật đó **có mặt và nói** (nhận ra người nói qua tiền tố `Tên:`
của câu thoại — xem `docs/13`).

## Lưu trữ

- `n.voiceProfile` — bản có cấu trúc, để sửa từng ô.
- `n.voice` — chuỗi đã ghép; **đây mới là thứ prompt dùng**.

Điền cấu trúc → `voice` được ghép lại. Gửi thẳng `voice` → nó thắng. Xuất Bible ghi
`voice_profile: n.voiceProfile || n.voice`, nên import lại không mất DNA.

## Bẫy đã gặp

Panel nhân vật từng chỉ hiện khi `role === 'character'`, nhưng server nhận nhân vật qua
**role HOẶC cột** (`isCharacter`). Nhân vật cũ chỉ có `zone: 'character'` (vd node "Ca sĩ" mẫu)
không hiện được ô nhập nào. Giao diện nay dùng chung luật — `isCharacterNode()` trong
`public/js/wardrobe.js`.

## Kiểm tra

```powershell
node test-voice.mjs
```

Phủ: ghép sáu thành phần đúng khuôn; lưu cả bản cấu trúc lẫn chuỗi; khoá giọng xuất hiện trong
prompt video của shot nhân vật nói; sửa một thành phần thì khoá đổi theo; chuỗi tự viết thắng;
Bible xuất ra giữ được DNA.
