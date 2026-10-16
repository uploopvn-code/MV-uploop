# Hướng dẫn giao AI viết kịch bản và xuất một blueprint JSON cho Drama Tool

Tài liệu này dành cho phim/drama, không phải MV. Mẫu JSON chạy được với bộ dựng hiện tại: [film-blueprint-example.json](../examples/film-blueprint-example.json). Một file JSON có thể mô tả **toàn bộ graph sản xuất của một phim ngắn**: Bible nhân vật, bối cảnh, đạo cụ, trang phục, style, audio, camera và shot. Khi nhập, app dựng node và kết nối. **JSON không tự tạo ảnh, render clip, dựng âm thanh hay xuất một MP4 cuối**; các bước này vẫn phải chạy và kiểm tra trong app. Một lần dựng hiện giới hạn 200 node; phim dài phải chia phân đoạn/project, giữ chung Bible/key.

Bản dùng lại cho Claude nằm tại `.claude/skills/drama-tool-film-blueprint/SKILL.md` (Claude Code trong repo) và file ZIP `drama-tool-film-blueprint-claude-skill.zip` (để tải lên Claude chat). Skill gồm contract, shot-design và JSON ví dụ độc lập; khi đổi schema hãy cập nhật cả skill cùng tài liệu này.

## 1. Input người dùng nên đưa cho AI

Không đưa ý tưởng một câu rồi kỳ vọng AI tự đoán toàn bộ. Điền càng rõ càng tốt; chỗ chưa quyết định ghi “đề xuất” thay vì để AI bịa dữ kiện thực tế.

| Nhóm | Cần cung cấp | Ví dụ |
| --- | --- | --- |
| Mục tiêu | Tên phim, thể loại, khán giả, ngôn ngữ thoại, thời lượng mục tiêu, tỉ lệ khung | Drama 90 giây, tiếng Việt, 16:9 |
| Câu chuyện | Logline, xung đột, bí mật/twist, 5 beat: mở–leo thang–đối đầu–hé lộ–hậu quả | Hai anh em tranh một bức thư của mẹ |
| Nhân vật | Tuổi, quan hệ, vai trò, dáng vẻ bất biến, giọng, trang phục mặc định, thay đồ ở cảnh nào | Lan, 28, tóc bob, áo khoác xanh |
| Bối cảnh | Nơi chốn, thời điểm, bố trí vật thể cố định, thời tiết, nguồn sáng, hướng cửa/cửa sổ | Quán cà phê; cửa sổ mưa bên phải máy |
| Đạo cụ | Vật quan trọng, màu, kích thước, dấu nhận diện, ai giữ ở từng beat | Phong bì kem, góc phải gập |
| Âm thanh | Nhạc nền, room tone, hiệu ứng, ai nói, nội dung thoại nguyên văn; âm thanh nào không được có | Mưa, đồng hồ; không nhạc có lời |
| Hình ảnh | Look phim, palette, tương phản, nhịp cắt, mức hiện thực, điều cấm | 35mm, xanh lạnh ngoài trời/ấm trong nhà |
| Sản xuất | Provider dự kiến, ngân sách render, độ dài clip model hỗ trợ, shot nào cần lip-sync | Veo cho cảnh đối thoại |
| Quyền/giới hạn | Nhân vật hư cấu, không dùng mặt/giọng người thật khi chưa có quyền, không logo/chữ bản quyền | Nhân vật hoàn toàn hư cấu |

Nếu không có thoại/âm thanh chính xác, AI để trống phần không biết và ghi giả định trong tài liệu bàn giao; không tự bịa lời “chính thức” hoặc khẳng định đã nghe tệp chưa được cung cấp.

## 2. Output AI phải trả về

Một **JSON hợp lệ** duy nhất, không chú thích `//`, không dấu phẩy cuối, không Markdown nếu gửi dưới dạng `.json`. Tên trường/enum giữ tiếng Anh; tên phim và thoại có thể tiếng Việt. Các `key` là định danh ổn định: ngắn, ASCII, không dấu, không trùng. Mỗi shot dùng đúng key đã khai trong `assets`, `wardrobe`, `cameras`, `styles`, `audio`.

```text
project.title                   Tên và cờ nhận diện phim/drama.
project.theme                   "film".
project.beat_sheet              Kế hoạch 5 beat; không phải node render.
styles[]                       key, name, prompt → node style dùng lại.
audio[]                        key, name, prompt → node hướng dẫn âm thanh.
assets[] role="character"       Ảnh turnaround nhân vật, code NV1/NV2…, mốc nhận diện, giọng.
assets[] role="scene"           Mô tả bối cảnh + conversation nếu có thoại ghép.
assets[] role="prop"/kind="item" Đạo cụ; ảnh vật dụng riêng.
wardrobe[]                     Một entry cho mỗi bộ đồ thay đổi; for trỏ key nhân vật.
cameras[]                      key, name, config → node máy quay dùng lại.
shots[]                        name, start (giây), duration (giây), uses, camera/style/audio,
                               dialogue, videoPrompt; hoặc setups 2–3 khung cho cụm ghép.
```

`project.name` cũng được đọc, nhưng `project.title` nên dùng cho drama. `project.aspect_ratio` hiện là metadata kế hoạch; job video hiện có cấu hình 16:9 riêng, không đọc trường này để ép provider. Các trường như `beat`, `emotional_value`, `transition_to_next`, `axis_180`, `continuity_note`, `lighting_profile` hữu ích cho AI/biên tập viên **nhưng không phải tất cả đều thành thuộc tính node hoặc lệnh render**. Thông tin bắt buộc nhìn thấy trong clip phải được nhắc ở `videoPrompt`, node `camera.config`, `style.prompt` hoặc mô tả bối cảnh, không chỉ nằm trong “note”.

### Nhân vật và độ nhất quán

- Một nhân vật = một asset `role:"character"`; mọi shot dùng lại cùng `key` và `code` (`NV1`, `NV2`…). Không tạo bản sao nhân vật để thay quần áo.
- `prompt` là model sheet: chân dung + trước/nghiêng/sau, dáng trung tính, nền đơn sắc, ánh sáng studio. `physical_anchors` có 3–5 dấu hiệu bất biến, `identity_label` và `back_view` giúp shot qua vai; `voice_profile` mô tả giọng nếu có thoại.
- Trang phục mặc định nằm trong model sheet. Khi thay đồ, thêm một entry `wardrobe` với `for` trỏ nhân vật và prompt **chỉ mô tả bộ đồ**; shot dùng key costume, không đồng thời dùng key người gốc. App tạo node trang phục và node người đã mặc.
- Không dùng tên người thật/người nổi tiếng làm tham chiếu mặt hoặc giọng khi không có quyền; prompt nên khẳng định nhân vật hư cấu.

### Bối cảnh, ánh sáng và trục nhìn

- Một bối cảnh = một asset `role:"scene"`, với vật thể cố định, mặt bằng và nguồn sáng rõ ràng. Mặc định app tạo một ảnh tham chiếu dạng 3 góc trong cùng một sheet; `reverse_angles:false` để chỉ có góc toàn; `reverse_angles:{"a":"...","b":"..."}` để tạo hai ảnh góc rời.
- Bối cảnh đối thoại ghép cần `conversation.place`, `two_shot`, `left` và `right` (mỗi bên có `anchor`, `background`, `light`). Xác định trục 180°: ai bên trái/phải, cửa sổ nằm phía nào, hướng mắt của từng người. Không đảo vị trí giữa shot mà không có cảnh vượt trục.
- Viết ánh sáng bằng nguồn cụ thể, hướng, màu, độ mềm và động cơ thay đổi: “warm tungsten key camera-left, cool rainy-window fill camera-right, soft rim; same exposure across cuts”. Tránh “cinematic lighting” đơn độc.
- `lighting_profile` chỉ là note ở blueprint hiện tại; để nó tác động rõ lên render, lặp ý quan trọng vào `scene.prompt` hoặc `videoPrompt`/`style.prompt`.

### Cỡ cảnh và động tác máy

| Mã | Nội dung | Dùng khi |
| --- | --- | --- |
| EWS/WS | Cực toàn/toàn, giới thiệu địa lý và quan hệ người–cảnh | Mở bối cảnh, reset phương hướng |
| MS | Trung, nửa người hoặc hai người | Hành động, trao đổi |
| MCU/CU | Trung cận/cận mặt | Cảm xúc, phản ứng, quyết định |
| ECU/Macro | Đặc tả mắt, tay, đạo cụ | Thông tin then chốt; phải có vật tham chiếu |
| OTS | Qua vai A hoặc B | Đối thoại, giữ trục 180° |

Trong `cameras[].config`, ghi đồng thời **cỡ cảnh + góc + ống kính gợi ý + chuyển động + điểm dừng**. Ví dụ: “CU, eye level, 50mm, slow 40 cm push-in to the eyes, hold final frame.” Một shot nên có một chuyển động chính: `locked`, `slow push-in`, `pull-out`, `dolly left/right`, `tracking`, `crane up/down`, `orbit`, `handheld` hoặc `rack focus`. Chuyển động phải có mục đích kể chuyện; tránh yêu cầu vừa orbit, vừa dolly, vừa zoom trong clip 5 giây. Chỉ chuyển động an toàn với trục và không gian đã mô tả.

**Shot note kỹ thuật để AI lập cho từng shot** (không nhất thiết là các trường JSON riêng, vì bộ dựng hiện chưa đọc chúng trực tiếp):

| Note | Câu hỏi cần trả lời | Đặt ở đâu để có tác dụng |
| --- | --- | --- |
| Blocking | Ai đứng/ngồi ở đâu; bắt đầu và kết thúc ở vị trí nào? | `videoPrompt`, `scene.conversation` |
| Composition | Chủ thể ở trái/phải/giữa; foreground/background; khoảng trống nhìn | `cameras[].config`, `videoPrompt` |
| Lens/focus | Tiêu cự gợi ý, độ sâu trường ảnh, điểm lấy nét, rack focus nếu cần | `cameras[].config` |
| Camera path | Máy đứng đâu, đi hướng nào, bao xa/nhanh, dừng ở đâu? | `cameras[].config` và `videoPrompt` |
| Light | Nguồn key/fill/rim/practical; hướng, màu, độ mềm; đổi khi nào? | `scene.prompt`, `scene.conversation`, `videoPrompt` |
| Action beats | 0–2s, 2–4s, cuối shot người/vật làm gì; kết ở tư thế nào? | `videoPrompt` |
| Sound | Thoại, room tone, Foley, nhạc nền, khoảng lặng; cái gì cấm? | `dialogue`, `audio_delivery`, `audio[].prompt` |
| Continuity | Tay nào cầm vật, vết ướt, vị trí cửa, hướng mắt, costume | `videoPrompt`, asset prompt và checklist duyệt |

Thông số như 24 fps, màn trập 180°, 35/50/85 mm, nhiệt độ 3200K/5600K hoặc tỉ lệ sáng 2:1/4:1 chỉ là **ngôn ngữ định hướng hình ảnh** trong prompt; JSON hiện không có các control vật lý riêng và provider có thể không tuân thủ chính xác. Ưu tiên mô tả kết quả nhìn thấy: “warm soft key from camera-left, cooler low fill from rainy window, visible catchlight, shadows keep detail” hơn là chỉ ghi “3200K, f/2.8”. Đừng thay màu/hướng key giữa hai góc cùng thời điểm nếu không có nguồn sáng hoặc beat trong truyện giải thích.

Mẫu một shot thường có thể dùng trong AI: `WS/MS/CU + góc + ống kính gợi ý + chuyển động duy nhất → chủ thể/hành động đầu–giữa–cuối → nguồn sáng cố định → âm thanh/thoại → continuity phải giữ → điều cấm`. Chi tiết đó tách thành `camera.config`, `videoPrompt`, `dialogue` và `audio` theo contract bên trên.

### Shot, thoại, nhịp và tính liên tục

- `start` và `duration` tính bằng **giây**. Shot đầu `start:0`; `start` sau bằng `start + duration` shot trước nếu muốn phủ kín timeline. Đừng để hở/chồng ngoài chủ ý. Shot thường nên khoảng 4–8 giây; cụm ghép 8 giây theo bộ dựng hiện tại.
- `uses` liệt kê **đúng** nhân vật hoặc costume, bối cảnh, đạo cụ, camera, style, audio mà shot cần. Shot thông thường có `camera`/`style`/`audio` để nối node tương ứng. Nếu dùng costume, không thêm nhân vật gốc vào `uses`.
- `dialogue` có dạng `Tên: "câu thoại"`; `audio_delivery` mô tả cách nói. Nếu nhân vật hiện khẩu hình, `videoPrompt` ghi đúng câu trong `mouth articulates`. Không nhét nhiều câu dài vào clip ngắn.
- `videoPrompt` nêu hành động **thấy được**, thứ tự động tác, ai/cái gì trong khung, điều vật lý không được sai, ánh sáng, giới hạn (no text/subtitles/watermark). Mô tả động tác một nhịp cho một shot, không kể cả phân cảnh nhiều phút trong một prompt.
- `transition_to_next` là note biên tập; app hiện chưa tự dựng transition cuối chỉ từ trường này. Muốn match-cut, viết điểm kết khung của shot trước và điểm mở khung shot sau một cách tương ứng.
- Một cụm ghép `setups` có 2–3 phần tử, `framing` chỉ `ots_a`, `ots_b`, `two_shot` và không lặp; `sides.left/right` dùng đúng key nhân vật. `ots_a` nhìn người bên phải, `ots_b` nhìn người bên trái. Câu thoại ngắn đủ thời gian cho mỗi góc. Cụm ghép hiện xây ảnh frame từ **bối cảnh + hai nhân vật**; đạo cụ quan trọng nên dành một shot thường/insert riêng có asset prop nối vào.
- Note continuity nên có: vị trí tay giữ vật, trang phục/kiểu tóc, độ ướt, hướng nhìn, vị trí đạo cụ, thời gian trong ngày, ánh sáng, trạng thái cửa, hướng di chuyển. AI phải kiểm từng cut, nhất là shot đảo chiều/đổi cỡ cảnh.

## 3. Prompt có thể gửi nguyên văn cho AI

Thay phần trong ngoặc vuông bằng dữ liệu của bạn, rồi đính kèm kịch bản gốc nếu có:

```text
Bạn là biên kịch, đạo diễn, DOP, giám sát continuity và trưởng hậu kỳ cho Drama Tool.
Hãy tạo MỘT blueprint JSON hợp lệ để nhập trực tiếp vào mục Đạo diễn > Blueprint.

INPUT:
- Tên/định dạng/thời lượng: [..]
- Logline và 5 beat câu chuyện: [..]
- Nhân vật + quan hệ + giọng + ngoại hình bất biến: [..]
- Bối cảnh + mặt bằng + thời điểm + nguồn sáng: [..]
- Đạo cụ/trang phục quan trọng và đường đi của chúng: [..]
- Toàn bộ thoại chính xác: [..]
- Look, palette, nhịp dựng, âm thanh, điều cấm: [..]
- Provider và độ dài clip dự kiến: [..]

OUTPUT CONTRACT:
1. Chỉ trả về một JSON object, không Markdown, không lời dẫn, không comment.
2. Dùng cấu trúc project(title, theme="film", beat_sheet), styles[], audio[], assets[],
   wardrobe[], cameras[], shots[] như file mẫu film-blueprint-example.json được gửi kèm.
3. Mỗi nhân vật/bối cảnh/đạo cụ chỉ một key; mọi key trong uses/camera/style/audio/place/
   sides/wardrobe phải tồn tại. Không tạo đạo cụ/người/bối cảnh không có asset.
4. Một shot = một ý hình ảnh; nối start/duration liền mạch từ 0 đến thời lượng mục tiêu.
   Shot thường 4–8 giây; cụm đối thoại setups 2–3 góc = 8 giây.
5. Ghi cỡ cảnh, góc, ống kính, một động tác máy có điểm dừng và lý do kể chuyện trong
   cameras[].config. Ánh sáng ghi nguồn/hướng/màu/độ mềm vào scene.prompt và videoPrompt.
6. Khóa nhân vật bằng turnaround + physical_anchors + code NV; nếu thay đồ dùng wardrobe.for.
   Đối thoại ghép giữ trục 180°, sides trái/phải và conversation staging cố định.
7. videoPrompt của shot thường mô tả hành động thấy được, nhịp đầu–cuối, vật lý và continuity;
   có thoại thấy miệng thì mouth articulates phải khớp dialogue. Không chữ/phụ đề/watermark.
8. Không bịa thông tin chưa cung cấp. Nếu thiếu dữ liệu thiết yếu, hỏi tối đa 3 câu trước khi
   xuất JSON; nếu vẫn thiếu, chọn giả định an toàn và ghi trong project.pacing_profile.
9. Tự kiểm tra JSON parse được, các tham chiếu tồn tại, không key trùng, không shot hở/chồng,
   số node dự kiến dưới 200, mọi trang phục/đạo cụ có đường continuity.
```

## 4. Nhập vào app và kiểm tra

1. Tạo/mở project đích. Vào **Đạo diễn → Blueprint**, dán JSON hoặc chọn file `.json`, bấm dựng graph. Bước này **thay graph hiện tại**; hãy đóng gói/sao lưu project trước nếu đang có công việc cần giữ. App có thể tái dùng ảnh asset theo key, nhưng không nên dựa vào đó để bảo toàn job/video cũ khi thay graph.
2. Đọc cảnh báo graph. Kiểm số node, kết nối, `uses`, cỡ cảnh, thoại, mốc thời gian và `scene` của từng shot. `buildGraph` chỉ kiểm tra một phần; JSON parse thành công chưa có nghĩa phim đúng nghệ thuật hay mọi key đã được nối.
3. Tạo ảnh nhân vật, bối cảnh, trang phục, đạo cụ, các frame cần thiết; duyệt những ảnh sai continuity. Sau đó render video theo shot/khu với provider đã cấu hình. Ảnh cũ/stale cần quyết định rõ có dùng hay tạo lại; clip đã có mặc định được bỏ qua.
4. Xem timeline, phát từng clip, kiểm lỗi mặt/tay/chữ/đạo cụ/ánh sáng/khẩu hình; chọn version tốt. App có Deliverables và tải clip/ZIP; **một file MP4 phim ghép hoàn chỉnh với audio, transition, color và mix cuối hiện chưa được xuất tự động chỉ từ blueprint**.

## 5. Checklist trước khi gửi AI / trước khi duyệt JSON

- [ ] Nhân vật/bối cảnh/đạo cụ/trang phục xuất hiện trong lời kể đều có asset hoặc wardrobe tương ứng.
- [ ] `key` duy nhất, không dấu; các `uses`, `camera`, `style`, `audio`, `place`, `sides`, `for` trỏ đúng key.
- [ ] Thời gian phủ kín mục tiêu; mỗi shot làm được trong giới hạn clip/provider; tổng node dưới 200.
- [ ] Cỡ cảnh/ống kính/động tác máy phù hợp địa lý, không phá trục 180° vô cớ.
- [ ] Ánh sáng giữ nguồn và hướng nhất quán qua những cut cùng thời điểm.
- [ ] Đạo cụ và trang phục giữ màu, hình, vị trí, tình trạng xuyên cảnh.
- [ ] Thoại nguyên văn; hành động môi trong prompt khớp câu nói; câu nói đủ ngắn cho duration.
- [ ] Các note chỉ mang tính kế hoạch đã được đưa vào prompt nếu cần tác động thật lên render.
- [ ] Đã duyệt story/nhân vật và sao lưu project trước khi dựng lại graph.

## Note module

Tài liệu này mô tả chính xác contract của `director.mjs`/`lib/apply-graph.mjs` tại thời điểm viết, không thêm trường nhập mới vào app. Mẫu JSON được kiểm bằng `test-film-blueprint-guide.mjs`. Khi đổi schema hoặc khả năng xuất phim, cập nhật tài liệu và mẫu trong cùng lần sửa module.
