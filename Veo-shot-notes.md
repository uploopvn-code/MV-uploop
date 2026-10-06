# Ghi chú cỡ cảnh Veo 3.1: những gì đã chạy được

Mục đích: lưu lại các cỡ cảnh và cách viết prompt đã test với Veo 3.1 cho phim "Di Chúc Nhà
Ashford", làm nền để cấu trúc lại tool (node shot, prompt ảnh khung hình, prompt video, thoại).
Ngày ghi: 2026-10-05. Cập nhật thêm mỗi lần test.

## 1. Kết quả test

| Cách làm | Kết quả | Ghi chú |
|---|---|---|
| **Góc qua vai A/B (shot / reverse shot), 2 nhân vật tương tác** | ✅ Thành công | Hai người nhìn nhau đúng hướng, phản ứng qua lại tốt. Ảnh khung ở mục 3. |
| **Một clip 8 giây, 2 ảnh khung A/B làm Ingredients, cắt cứng ở 00:04 (Cách 1)** | ✅ Thành công | Góc A có NV3 nói, cắt sang góc B có NV1 đáp. Prompt nguyên văn ở mục 4. Mỗi lần tạo được 2 shot. |
| **Một clip 8 giây, 3 góc A → B → trung đôi, 3 ảnh khung làm Ingredients, cắt ở 00:03 và 00:05** | ✅ Thành công | Mỗi góc một câu thoại, trung đôi là nhịp kết. Mỗi lần tạo được 3 shot. Prompt nguyên văn ở mục 6. |
| **Ảnh khung trung đôi (two-shot)** | ✅ Thành công | Dùng làm Ingredients trong clip 3 góc. Prompt ảnh và ảnh mẫu ở mục 5. |
| Clip trung đôi riêng 8 giây, hai người thoại qua lại trong cùng khung (Frames to video) | 🧪 Chưa test | Mục 5. |
| Cắt cảnh trong 1 clip 8 giây chỉ từ 3 ảnh gốc (bối cảnh + 2 character sheet), mốc `[00:00-00:04]` / `[00:04-00:08]` | ⚠️ Có cắt nhưng giật | Veo phải tự "chế" góc máy thứ hai lúc cắt. Thay bằng ảnh khung hình riêng cho từng góc (mục 3). |

Ảnh tham chiếu dùng khi test: [1] thư phòng nhà Ashford về đêm (không có người), [2] Vivienne
(NV3, character sheet tóc bạch kim, váy lụa champagne), [3] Eleanor (NV1, character sheet tóc
nâu đỏ búi thấp, váy len cổ cao màu xám than).

## 2. Quy tắc rút ra (áp dụng cho mọi cỡ cảnh)

**Bố cục và trục 180°**
- Mỗi nhân vật có **một bên khung cố định** cho cả cảnh, ghi bằng vị trí tuyệt đối:
  "NV1 is always on the left of frame, NV3 always on the right". Câu "180-degree rule" một
  mình không có tác dụng.
- Neo mỗi người vào **một vật cố định của bối cảnh** (NV1 ở đầu bàn phía cửa sổ, cạnh đèn xanh;
  NV3 trước lò sưởi, dưới bức chân dung). Mỗi shot dán nguyên văn khối vị trí này, vì mỗi lần
  tạo Veo không biết shot trước.
- Người nói quay **3/4, nhìn về phía người kia**, ghi rõ "looking frame left at the other woman,
  not into the lens". Ghi "facing the camera" thì nhân vật nhìn thẳng ống kính.
- Ánh sáng theo vị trí đứng: người quay lưng vào nguồn sáng thì nguồn sáng chỉ **viền tóc**,
  người đối diện nguồn sáng thì sáng **lên mặt**.

**Nhận dạng nhân vật**
- Veo **không ghép ảnh theo số thứ tự**, mà theo lời mô tả. Mỗi lần nhắc nhân vật cần mã NV kèm
  **nhãn nhận dạng ngắn 2–5 chữ**, ví dụ "NV3, the platinum-blonde woman", và vị trí trái/phải.
  Không tả lại khuôn mặt, quần áo dài dòng.
- Character sheet có chữ in sẵn (PORTRAIT/FRONT VIEW…): ghi "take only the women from the
  character sheets, none of the printed words", tốt nhất là crop bỏ chữ trước. Thêm "each
  woman appears only once" để tránh nhân đôi người do sheet có nhiều góc.

**Thoại**
- Khoảng **2–3 từ mỗi giây**. Một shot 3–4 giây chỉ nên có **một câu ≤ 6–8 từ**, có một nhịp
  nghỉ ở đầu ("After a short beat") và ở cuối ("Then she holds the look").
- Mỗi khối chỉ **một người nói**. Người nghe tả bằng hình ảnh tích cực: "lips closed", "face
  stays turned away". Câu phủ định ("stays silent") vẫn hay bị mấp máy môi.
- Cú pháp: `NV3, the platinum-blonde woman, says coolly, bright and brittle: "…"`, gợi ý
  giọng đặt ngay cạnh câu thoại.
- **Voice lock** cho từng người, giữ **nguyên văn** ở mọi clip, và làm hai giọng khác hẳn nhau
  ("clearly lower and slower than NV3"). Hai giọng cùng "female, late 30s" dễ bị tráo.
- Tiếng hiện trường **chạy liền qua cú cắt** (mưa, lửa, đồng hồ), để tai không nhận ra cú cắt.

**Chống chữ trên hình**
- Viết tích cực: "Clean frame, empty lower third", kèm "no subtitles, no captions, no
  on-screen text".
- Nếu có ô negative prompt: `subtitles, captions, on-screen text, text overlay, watermark,
  labels, split screen, duplicate person`.
- Vẫn ra phụ đề thì thử bỏ dấu ngoặc kép quanh câu thoại (`says: He changed the will…`), cách
  Vertex khuyên dùng.

**Giới hạn của Veo 3.1 khi có ảnh tham chiếu**
- Tối đa **3 ảnh**, clip bắt buộc **8 giây**, tỉ lệ **16:9 hoặc 9:16**.
- Thoại tiếng Anh ổn định nhất. Google chưa đánh giá các ngôn ngữ khác.
- **Ingredients** (ảnh làm tham chiếu) khác **Frames to video** (khung đầu, khung cuối). Đặt
  ảnh A làm khung đầu và ảnh B làm khung cuối thì Veo biến hình từ A sang B, gây giật hoặc méo.
  Muốn cắt cảnh thì dùng Ingredients, hoặc mỗi góc một lần tạo chỉ với khung đầu.
- Mốc thời gian `[00:00-00:04]` được Google ghi trong hướng dẫn Veo 3.1. Dùng mốc thời gian
  để đặt thoại là mẹo của cộng đồng, nên tạo 2–4 bản rồi chọn.

## 3. Bước 1: tạo ảnh khung qua vai A/B, "ảnh back" (✅ Nano Banana)

Mỗi góc máy là một ảnh khung hình riêng: người nghe quay lưng ở tiền cảnh, người nói quay 3/4 về
phía máy, mắt nhìn người nghe chứ không nhìn ống kính. Đây là bước quyết định để cú cắt không giật. Hai ảnh dưới đây đã cho clip A/B thành công
(mục 4).

**Đầu vào, đính kèm đúng thứ tự này:**

| Ảnh | Nội dung | File mẫu |
|---|---|---|
| [1] | Bối cảnh toàn, **không có người**, đúng giờ và ánh sáng của cảnh | [input-study.jpg](docs/veo-samples/input-study.jpg) |
| [2] | Character sheet NV3, có ô **BACK VIEW** | [input-sheet-nv3-vivienne.jpg](docs/veo-samples/input-sheet-nv3-vivienne.jpg) |
| [3] | Character sheet NV1, có ô **BACK VIEW** | [input-sheet-nv1-eleanor.jpg](docs/veo-samples/input-sheet-nv1-eleanor.jpg) |

Character sheet phải có ô nhìn từ sau lưng. Người nghe chỉ lộ lưng, tóc phía sau và vai, nên
chi tiết lưng ghi trong prompt (búi tóc, cổ áo, vai trần) phải lấy đúng từ ô BACK VIEW. Nhờ vậy
nhìn lưng vẫn nhận ra ai.

**Góc qua vai A**, qua vai NV1 nhìn sang NV3 đang nói:
```text
Still frame, photorealistic, cinematic 35mm, 16:9. The study from image 1 at night. Over-the-shoulder close-up: the auburn-haired woman from image 3 seen from behind, her auburn bun and charcoal shoulder out of focus, filling the left third of the frame. The platinum-blonde woman from image 2 in sharp focus right of centre, chest-up, three-quarter view, looking frame left at the other woman, not into the lens. Behind her the marble fireplace and gilt portrait; firelight rims her hair, cool blue window light on her face. Each woman appears once, with the same face, hair and clothes as her image; take only the women from the character sheets, none of the printed words. Shallow depth of field, clean frame.
```

**Góc qua vai ngược B**, qua vai NV3 nhìn sang NV1 đang nói:
```text
Still frame, photorealistic, cinematic 35mm, 16:9. The study from image 1 at night. Reverse over-the-shoulder close-up: the platinum-blonde woman from image 2 seen from behind, her platinum hair and bare shoulder out of focus, filling the right third of the frame. The auburn-haired woman from image 3 in sharp focus left of centre, chest-up, three-quarter view, looking frame right at the other woman, not into the lens. Behind her the rain-streaked arched windows; warm firelight and green banker's-lamp light on her face. Each woman appears once, with the same face, hair and clothes as her image; take only the women from the character sheets, none of the printed words. Shallow depth of field, clean frame.
```

Quy luật của cặp A/B: vai tiền cảnh **cùng bên** với vị trí cố định của người đó. NV1 luôn bên
trái nên vai NV1 nằm mép trái ở góc A. NV3 luôn bên phải nên vai NV3 nằm mép phải ở góc B. Hậu
cảnh sau người nói đổi theo hướng nhìn: góc A là lò sưởi, góc B là cửa sổ.

**Mẫu dùng lại cho cặp nhân vật hoặc bối cảnh khác.** Góc A là góc qua vai người bên trái, nhìn
sang người bên phải. Góc B là góc ngược lại. Thay các ô `<…>`, giữ nguyên phần còn lại:
```text
Still frame, photorealistic, cinematic 35mm, 16:9. <The place> from image 1 <at night>. Over-the-shoulder close-up: <the LEFT person's label> from image <n> seen from behind, <her back details> out of focus, filling the left third of the frame. <The RIGHT person's label> from image <m> in sharp focus right of centre, chest-up, three-quarter view, looking frame left at the other <woman>, not into the lens. Behind her <what stands behind the RIGHT person>; <light on the RIGHT person>. Each <woman> appears once, with the same face, hair and clothes as her image; take only the <women> from the character sheets, none of the printed words. Shallow depth of field, clean frame.
```
```text
Still frame, photorealistic, cinematic 35mm, 16:9. <The place> from image 1 <at night>. Reverse over-the-shoulder close-up: <the RIGHT person's label> from image <m> seen from behind, <her back details> out of focus, filling the right third of the frame. <The LEFT person's label> from image <n> in sharp focus left of centre, chest-up, three-quarter view, looking frame right at the other <woman>, not into the lens. Behind her <what stands behind the LEFT person>; <light on the LEFT person>. Each <woman> appears once, with the same face, hair and clothes as her image; take only the <women> from the character sheets, none of the printed words. Shallow depth of field, clean frame.
```

Cách điền, kèm giá trị đã dùng cho cảnh thư phòng:

| Ô | Lấy từ đâu | Góc A | Góc B |
|---|---|---|---|
| Người quay lưng (tiền cảnh) | Nhãn nhận dạng 2–5 chữ | the auburn-haired woman (NV1) | the platinum-blonde woman (NV3) |
| Chi tiết lưng | Ô BACK VIEW của sheet | her auburn bun and charcoal shoulder | her platinum hair and bare shoulder |
| Người nói | Nhãn nhận dạng 2–5 chữ | the platinum-blonde woman (NV3) | the auburn-haired woman (NV1) |
| Hậu cảnh sau người nói | Vật cố định nơi người nói đứng, nhìn từ phía người kia | the marble fireplace and gilt portrait | the rain-streaked arched windows |
| Ánh sáng lên người nói | Nguồn sáng thật của bối cảnh: quay lưng vào nguồn thì viền tóc, đối diện nguồn thì sáng mặt | firelight rims her hair, cool blue window light on her face | warm firelight and green banker's-lamp light on her face |

Với nhân vật nam, đổi `woman`/`women` thành `man`/`men`, hoặc `person`/`people` khi có một
nam một nữ; khi đó `as her image` thành `as their image`. Các chữ `her` khác đổi theo giới của
người được nhắc tới. Nhãn nhận dạng và vật neo phải giống hệt
nhau giữa ảnh A, ảnh B và prompt video.

**Ảnh khung mẫu đã chạy được**: [góc A, NV3 nói](docs/veo-samples/ots-a-vivienne.png) và
[góc B, NV1 đáp](docs/veo-samples/ots-b-eleanor.png). Kiểm tra ảnh khung trước khi đưa sang
Veo:
- Đầu và vai người nghe ở tiền cảnh, mờ, chiếm khoảng một phần ba khung, nằm ở mép của bên
  cố định của người đó (NV1 mép trái ở góc A, NV3 mép phải ở góc B).
- Người nói nét, quay 3/4, nhìn sang người nghe, không nhìn ống kính.
- Hậu cảnh ngay sau người nói khác nhau giữa hai góc: góc A, sau NV3 là lò sưởi, bức chân dung
  và đồng hồ trên bệ lò; góc B, sau NV1 là cửa sổ mưa. Mép khung phía người nghe vẫn có thể lộ
  một phần phía bên kia phòng (góc A mẫu thấy cửa sổ và đèn xanh ở mép trái), không sao.
- Ánh sáng khớp nhau giữa hai góc: lửa lò sưởi ấm, ánh cửa sổ xanh lạnh, đèn xanh trên bàn.
- Mặt, tóc và quần áo giống character sheet. Không có chữ, không có người thứ ba.

Ảnh nào sai một điểm trong danh sách thì tạo lại ảnh đó trước khi đưa sang Veo. Prompt video
bảo Veo dựng lại đúng ảnh khung, nên lỗi trong ảnh sẽ vào luôn video.

## 4. Bước 2: video góc qua vai, 2 người nói qua lại (✅)

**Cách 1, một clip 8 giây có cú cắt (✅ đã chạy được, 2026-10-05).** Đính kèm ảnh A và B ở chế
độ Ingredients. Prompt dưới đây là bản đã cho kết quả tốt, giữ nguyên văn. Đổi câu thoại thì
giữ khoảng 2–3 từ mỗi giây cho mỗi nửa 4 giây.
```text
The two attached images are the two camera setups of one conversation in the same room. Shot A is the image where the platinum-blonde woman (NV3) faces us over the blurred shoulder of the auburn-haired woman. Shot B is the image where the auburn-haired woman (NV1) faces us over the blurred shoulder of the platinum-blonde woman. Recreate each setup exactly as its image shows: framing, focus, lighting, colour, faces, hair and clothes. Each woman appears only once.
A dialogue in two shots, shot / reverse shot, with one clean hard cut at 00:04: no transition, no morph, no dissolve, no camera movement.
[00:00-00:04] Shot A. After a short beat, NV3, the platinum-blonde woman, says coolly, bright and brittle: "He changed the will last month. Did you know?" Only NV3 speaks; NV1's face stays turned away, lips closed.
[00:04-00:08] Hard cut to shot B. NV1, the auburn-haired woman, answers without moving, low and slow: "I know everything that happens here." Then she holds the look. Only NV1 speaks; NV3 stays still, lips closed.
Voice lock for NV3: female, late 30s, bright and brittle, honeyed cruelty, polished American socialite accent, quick barbed pacing.
Voice lock for NV1: female, late 30s, clearly lower and slower than NV3, smooth and composed, quiet contempt, deliberate pacing.
Room sound runs unbroken across the cut: rain on the windows, the fire crackling, a mantel clock ticking. No other voices, no narration, no music.
Photorealistic, cinematic 35mm. Clean frame, empty lower third, no subtitles, no captions, no on-screen text. Fictional characters only, no resemblance to any real person.
```

**Cách 2, dự phòng.** Dùng khi Cách 1 bị nhân đôi người, cắt sai chỗ hoặc thoại lệch. Mỗi
góc một lần tạo, chế độ Frames to video, chỉ đặt **khung đầu**
là ảnh góc đó. Prompt chỉ có một câu thoại, thay câu về cú cắt bằng `Single continuous shot, no
cuts.` rồi ghép xen kẽ A/B khi dựng. Tool hiện quay từng shot theo đúng cách này.

Đoạn hội thoại mẫu, mỗi clip một cặp A rồi B (với Cách 1, thay câu thoại trong hai khối
`[00:00-00:04]` và `[00:04-00:08]`):

| Clip | Góc A: NV3 nói | Góc B: NV1 đáp |
|---|---|---|
| 1 | "He changed the will last month. Did you know?" | "I know everything that happens here." |
| 2 | "Then you know you'll leave with nothing." | "Read it again, Vivienne. Slowly." |
| 3 | "Is that a threat, Eleanor?" | "It's a warning. The last one." |

## 5. Góc trung đôi, đặt cuối cảnh, có thoại (ảnh khung ✅, clip riêng 🧪)

Thứ tự cảnh: góc A → góc B → trung đôi. Góc trung đôi là nhịp kết: hai người cùng trong khung, nói câu chốt.

Ảnh khung hình (✅). Đính kèm [1] bối cảnh, [2] NV3, [3] NV1, giống mục 3.
```text
Still frame, photorealistic, cinematic 35mm, 16:9. The study from image 1 at night. Medium two-shot from the bookcase side of the room, eye level: both women seen waist-up, a few steps apart, facing each other in three-quarter profile, neither looking into the lens. The auburn-haired woman from image 3 at frame left, standing at the window end of the long desk beside the green banker's lamp, the rain-streaked arched windows behind her; warm firelight and green lamplight on her face. The platinum-blonde woman from image 2 at frame right, standing in front of the marble fireplace, the gilt portrait above her; firelight rims her hair, cool blue window light on her face. The corner bookcase and a leather armchair between them in the background. Each woman appears once, with the same face, hair and clothes as her image; take only the women from the character sheets, none of the printed words. Moderate depth of field, both women in focus, clean frame.
```

**Ảnh khung mẫu đã chạy được**: [trung đôi](docs/veo-samples/two-shot.png). Kiểm tra trước khi
đưa sang Veo:
- NV1 bên trái, cạnh bàn và đèn xanh, cửa sổ mưa sau lưng. NV3 bên phải, trước lò sưởi, bức
  chân dung phía trên. Hai bên phải khớp với ảnh A và B, để ba góc không ngược trục.
- Hai người quay 3/4 nhìn nhau, không ai nhìn ống kính, cả hai đều nét.
- Ở giữa, phía sau là góc kệ sách và ghế da.
- Ảnh mẫu ra rộng hơn "waist-up" (thấy tới đùi) mà vẫn chạy tốt.

Clip trung đôi riêng (🧪 chưa test). Video 8 giây, Frames to video, khung đầu là ảnh trung đôi,
ghép sau clip A/B. Dùng khi clip 3 góc (mục 6) bị lỗi, hoặc khi cần hai người thoại qua lại
trong cùng khung:
```text
Single continuous shot, no cuts. The attached image is the first frame: a medium two-shot in the study at night, the auburn-haired woman (NV1) at frame left by the desk, the platinum-blonde woman (NV3) at frame right by the fireplace, facing each other. Keep the framing, faces, hair, clothes and lighting exactly as in the image. Locked-off camera, no movement, no zoom.
First, NV3, the platinum-blonde woman on the right, takes one slow step toward NV1 and says coolly, bright and brittle: "Then you'll leave with nothing." Only NV3 speaks; NV1 keeps her lips closed, eyes on NV3.
Then NV1, the auburn-haired woman on the left, does not move and answers, low and slow: "Read it again, Vivienne. Slowly." Only NV1 speaks; NV3 stops, lips closed, her smile faltering. Both hold the look until the end.
Voice lock for NV3: female, late 30s, bright and brittle, honeyed cruelty, polished American socialite accent, quick barbed pacing.
Voice lock for NV1: female, late 30s, clearly lower and slower than NV3, smooth and composed, quiet contempt, deliberate pacing.
Room sound: rain on the windows, the fire crackling, a mantel clock ticking. No other voices, no narration, no music.
Photorealistic, cinematic 35mm. Clean frame, empty lower third, no subtitles, no captions, no on-screen text. Fictional characters only, no resemblance to any real person.
```

Góc trung đôi lộ cả hai khuôn mặt nên dễ gán nhầm câu thoại hơn góc qua vai. Vì vậy câu rất
ngắn, gọi người bằng "on the left / on the right" kèm màu tóc, và ghi rõ thứ tự.

## 6. Ba góc trong một clip: A → B → trung đôi (✅ đã chạy được, 2026-10-05)

Đính kèm đúng 3 ảnh ở chế độ Ingredients, theo thứ tự xuất hiện: ảnh góc A, ảnh góc B (mục 3),
ảnh trung đôi (mục 5). Mỗi lần tạo được 3 shot. Prompt dưới đây là bản đã cho kết quả tốt, giữ
nguyên văn:
```text
The three attached images are the three camera setups of one conversation in the same room: shot A, where the platinum-blonde woman (NV3) faces us over the blurred shoulder of the auburn-haired woman; shot B, where the auburn-haired woman (NV1) faces us over the blurred shoulder of the platinum-blonde woman; and the medium two-shot of both women. Recreate each setup exactly as its image shows. Each woman appears only once in any shot. NV1 is always on the left of frame, NV3 always on the right.
Three shots with clean hard cuts at 00:03 and 00:05: no transition, no morph, no dissolve, no camera movement.
[00:00-00:03] Shot A. NV3, the platinum-blonde woman, says coolly, bright and brittle: "He changed the will, Eleanor." Only NV3 speaks; NV1's face stays turned away, lips closed.
[00:03-00:05] Hard cut to shot B. NV1, the auburn-haired woman, answers low and slow: "I know." Only NV1 speaks; NV3 stays still, lips closed.
[00:05-00:08] Hard cut to the medium two-shot. NV3, on the right, takes one step toward NV1 and says: "Then you leave with nothing." Only NV3 speaks; NV1, on the left, does not move, lips closed, the faintest smile.
Voice lock for NV3: female, late 30s, bright and brittle, honeyed cruelty, polished American socialite accent, quick barbed pacing.
Voice lock for NV1: female, late 30s, clearly lower and slower than NV3, smooth and composed, quiet contempt, deliberate pacing.
Room sound runs unbroken across the cuts: rain on the windows, the fire crackling, a mantel clock ticking. No other voices, no narration, no music.
Photorealistic, cinematic 35mm. Clean frame, empty lower third, no subtitles, no captions, no on-screen text. Fictional characters only, no resemblance to any real person.
```

Nhịp và độ dài câu trong bản thành công:

| Khối | Góc | Người nói | Câu | Số từ |
|---|---|---|---|---|
| 00:00–00:03 | A | NV3 | "He changed the will, Eleanor." | 5 |
| 00:03–00:05 | B | NV1 | "I know." | 2 |
| 00:05–00:08 | Trung đôi | NV3, bước lên một bước | "Then you leave with nothing." | 5 |

Bản thành công có các điểm sau. Giữ chúng khi viết cảnh khác:
- Ba ảnh được mô tả theo đúng thứ tự đính kèm và thứ tự xuất hiện. Mỗi ảnh gọi bằng mô tả (ai
  đối diện máy, qua vai ai), không gọi bằng số.
- Một câu khóa vị trí cho cả clip: "NV1 is always on the left of frame, NV3 always on the
  right", cùng câu "Each woman appears only once in any shot".
- Khối 2 giây chỉ một câu 1–2 từ, khối 3 giây một câu khoảng 5 từ.
- Ở góc trung đôi, gọi cả người nói lẫn người nghe kèm vị trí ("NV3, on the right", "NV1, on
  the left"). Shot kết có một hành động nhỏ (bước lên một bước) và một phản ứng (thoáng cười).

Nếu bị nhân đôi người hoặc trộn khung, tách thành 2 lần tạo: clip A/B theo mục 4 cách 1, rồi
clip trung đôi riêng theo mục 5. Ghép A/B 8 giây → trung đôi 8 giây.

## 7. Đề xuất cấu trúc lại tool

Đã làm (2026-10-05) phần **Phân cảnh ghép**: một mục shot có `setups` (2–3 cỡ cảnh `ots_a`,
`ots_b`, `two_shot`, mỗi cỡ một câu thoại) dựng thành 2–3 node khung ở cột ⑥ và một node ghép ở
cột ⑦, quay chung một clip Veo 8 giây với mốc cắt chia theo số từ. Prompt ảnh khung theo mục 3 và
5, prompt video theo mục 4 và 6. Bible thêm `identity_label`, `back_view` (nhân vật) và
`conversation` (bối cảnh). Trường cụ thể: README, mục "Phân cảnh ghép". Skill
drama-veo-blueprint chưa cập nhật (đợi test thêm các cỡ cảnh khác). Các ý dưới đây ghi lại đề
xuất gốc; ý 1, 3, 4, 5 đã có trong phần vừa làm, ý 2 thay bằng `conversation` + `sides`.

1. **Loại cỡ cảnh là trường riêng của shot**: `ots_a`, `ots_b`, `two_shot`, `single`,
   `insert`. Mỗi loại có một mẫu prompt ảnh khung hình (mục 3, 5) và một mẫu prompt video (mục
   4, 5), thay cho việc viết tay toàn bộ trong blueprint.
2. **Vị trí cố định theo cảnh**: blueprint khai một lần cho mỗi cảnh hội thoại, gồm ai bên
   trái, ai bên phải, mỗi người neo vào vật gì, và nguồn sáng ở đâu. Tool tự ghép khối vị trí,
   hướng nhìn và ánh sáng theo mục 2 vào mọi shot của cảnh.
3. **Nhận dạng bằng mô tả + vị trí**: dòng cast hiện chỉ ghi mã (`[1] NV1`). Cần thêm nhãn
   nhận dạng ngắn 2–5 chữ của từng nhân vật, lấy từ Bible, kèm vị trí trái/phải trong khung.
4. **Nhiều câu thoại trong một shot**: đọc nhiều dòng `Tên: "…"` theo thứ tự, chia mốc thời
   gian, ghi "Only X speaks; Y lips closed" theo từng khối, khóa giọng cho mọi người nói, bỏ câu
   "spoken by X only" khi có từ hai người nói, và cảnh báo khi vượt khoảng 2–3 từ mỗi giây.
5. **Ảnh khung hình theo góc máy**: tận dụng node góc bối cảnh A/B đã có để dựng ảnh khung hình
   qua vai theo mẫu ở mục 3, thêm góc trung đôi. Character sheet cần có ô nhìn từ sau lưng. Gộp
   shot vào một clip 8 giây, ảnh khung làm Ingredients:
   - Cặp shot qua vai A/B liền nhau: một lần tạo ra 2 shot, cắt ở 00:04 (mục 4 Cách 1), tốn
     một nửa chi phí so với quay riêng.
   - Ba shot liền nhau theo thứ tự A → B → trung đôi: một lần tạo ra 3 shot (mục 6). Thứ tự
     khác chưa test (mục 8).
   - Giống nhóm Seedance ở chỗ gộp nhiều shot vào một lần render. Khác ở chỗ nhóm Seedance giữ
     độ dài thật của từng shot và để phần dư thành đuôi tĩnh, còn clip Veo cố định 8 giây, nên
     tool phải tự chia 8 giây thành các khối giây nguyên theo số từ của từng câu (bản mục 6:
     5/2/5 từ → 3/2/3 giây).
   - Clip 3 góc hỏng thì lùi về 2 lần tạo như mục 6: clip A/B (Cách 1) rồi clip trung đôi riêng
     (mục 5). Cách 2 (mỗi shot một lần từ khung đầu của nó) là dự phòng khi Cách 1 cũng hỏng, và
     là cách cho shot lẻ.
6. **Chống chữ**: thêm "Clean frame, empty lower third" vào đuôi prompt. Kiểm tra Seedvis có ô
   negative prompt cho Veo không; nếu có thì gửi danh sách ở mục 2.
7. **Nhóm Seedance** dùng chung các quy tắc trên khi ghép prompt nhiều shot.

## 8. Còn phải test

- Clip trung đôi riêng có hai người thoại qua lại trong cùng khung (mục 5).
- Các cỡ cảnh còn lại ở mục 7 ý 1: cận đơn (`single`), insert đạo cụ (`insert`).
- Clip 3 góc theo thứ tự khác A → B → trung đôi (mục 6), ví dụ trung đôi mở đầu.
- Câu thoại có ngoặc kép so với không ngoặc kép: lần nào ra phụ đề nhiều hơn.
- Giọng có giữ nguyên qua nhiều clip không khi voice lock giống hệt nhau.
- Seedvis gửi Veo nhiều ảnh theo chế độ Ingredients hay khung đầu/cuối. Đọc trường `mode` trong
  kết quả job: `multi-image-to-video` là Ingredients, `batch-frame` là khung đầu/cuối.
