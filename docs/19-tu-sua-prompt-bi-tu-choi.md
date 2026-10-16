# Tự sửa prompt khi model video từ chối, và sổ học của agent

## Hai lỗi thật, lấy từ một prompt bị từ chối nhiều lần

### ① An toàn — tả lại ngoại hình người thật, không có nhãn hư cấu

Shot chạy từ **ảnh keyframe của chính nó** là đường duy nhất `prompts.mjs` chèn mô tả ngoại
hình (`keyframeLine`, chỗ duy nhất comment ghi *"the only case where the appearance text earns
its place"*). Nó đổ nguyên `physical_anchors` trong Bible vào:

> In it: NV2 — Vietnamese woman, 30 years old, Slim body proportions, Oval face and dark-brown
> almond-shaped eyes; NV3 — Vietnamese man, 33 years old…

Tả chi tiết tuổi/mặt/mắt/dáng của ba người, gắn vào một ảnh photoreal, **không kèm câu nhân vật
hư cấu** → bộ lọc coi là người thật. `director.mjs` đã bắt buộc câu disclaimer cho prompt **ảnh**
model sheet, nhưng đường **video** thì chưa có câu nào.

Seedvis thật trả về: `bộ lọc an toàn từ chối`.

### ② Logic — hai người nói trong một shot

Một shot trong tool chỉ có **MỘT** người nói (trường `lyric`), nên `prompts.mjs` sinh ra:

> The line is spoken by NV2 only; everyone else stays silent and listens.

Nếu blueprint nhét câu thoại của người thứ hai vào văn xuôi `videoPrompt` thì:

- prompt **tự mâu thuẫn** (NV3 vừa có thoại lip-sync, vừa bị bảo là im lặng);
- NV3 **không được khoá giọng** — `voiceLine` chỉ khoá người nói mà tool biết.

Đây là shot viết sai thể loại: 2 người đối đáp trong 8 giây chính là **⑦ Phân cảnh ghép** (beats).

## Thang leo 5 lượt

Mỗi lần bị từ chối, lượt gửi lại kế tiếp leo một bậc — từ rẻ và an toàn tới đắt và can thiệp
sâu. Một lần chạy được là bộ đếm về 0 và thang về đầu (`clearRejects` trong `lib/jobs.mjs`).

| Lượt | Làm gì trước khi gửi | Đổi prompt? |
|---|---|---|
| 1 | gửi nguyên văn | — |
| 2 | **gửi lại nguyên văn** — bộ lọc đôi khi trả lời khác nhau cho cùng một đầu vào | không |
| 3 | **tool sửa** bằng luật cứng (bảng dưới) | có — bật CỜ, prompt vẫn sinh lại |
| 4 | **AI viết lại** cả prompt | có — chữ ĐÓNG BĂNG |
| 5 | gộp ảnh tham chiếu thành lưới | *(chưa bật — xem dưới)* |
| — | dừng, báo "cần xem tay — thường là ẢNH bị chặn" | |

Bảng nằm ở `STEPS` trong `lib/prompt-doctor.mjs`; thêm/bớt bậc là sửa đúng mảng đó.

- **Lượt 3 không tìm ra lỗi nào** → không tiêu một lượt gửi lại y hệt, leo thẳng lên bước AI.
- **Bước AI** chạy bằng API key đạo diễn (`director-key.txt`) nếu có, không thì qua extension
  ChatGPT đang bật. Không có cả hai → dừng và nói rõ, không im lặng. Bản AI bị **bỏ** nếu nó làm
  mất bất kỳ câu thoại nào trong ngoặc kép (`acceptAiRewrite`), hoặc dài bất thường.
- Bản AI là bước **đầu tiên đóng băng chữ**: sửa Bible/thoại sẽ không chảy vào cho tới khi bấm
  **↺ Gỡ bản sửa**.
- Bác sĩ chạy **nền** (không await): bước AI có thể chờ LLM hàng phút, không được giữ chỗ chạy
  job hay giữ response HTTP của extension lâu như vậy.
- Nếu **chuỗi tự động** đã nhận việc gửi lại shot này (`j.status === 'retried'`), bác sĩ chỉ sửa
  prompt, KHÔNG tạo job riêng — nếu không là 2 job cho 1 shot, tính tiền 2 lần.

### Lượt hỏng không tốn credit

Kiểm trên tài khoản thật: lượt Omni Flash bị `generation_failed` **không trừ credit** (46 258
trước và sau). Nên các lượt leo thang bị từ chối là miễn phí; chỉ lượt thành công mới tính tiền.

### Bước tool sửa — ba cờ

Ba thứ bác sĩ sửa — **không đụng nội dung cảnh, thoại hay nhịp**:

| Cờ | Sửa gì |
|---|---|
| `noAnchors` | Bỏ khối tả ngoại hình, thay bằng câu cấm tả lại + danh sách ai có trong khung |
| `fiction` | Thêm câu nhân vật hư cấu vào cuối prompt video |
| `dropExclusive` + `voices` | Bỏ câu "chỉ X nói", và khoá giọng cho **mọi** người nói tìm được |

`n.promptFix` là **cờ, không phải chữ đóng băng**: prompt vẫn sinh lại mỗi lần, nên sửa Bible hay
thoại thì prompt vẫn cập nhật theo. Gỡ bằng nút **↺ Gỡ bản sửa** trong Inspector
(`PATCH /api/node {promptFix: null}` — API chỉ cho GỠ, không cho bật tay).

## Chạy lẻ hay chạy hàng loạt đều được, nhưng chỉ ở hai đường này

Bác sĩ **không** quan tâm job đến từ đâu — nút "Tạo video" của một node, chuỗi tự động, hay batch
theo khu vực đều như nhau. Nó được gọi ở **cả hai** nơi một job video có thể hỏng:

| Nguồn video | Hỏng ở đâu | Tự sửa |
|---|---|---|
| Seedvis (Veo, Seedance, Omni), Orbit | `runJob` trong `lib/runner.mjs` | ✅ |
| Extension: Google Vids, Muse, ChatGPT | `/api/worker/fail` trong `lib/routes/jobs.mjs` | ✅ (chỉ khi `failed`) |

> ⚠ Ở đường extension, chỉ chạy khi job thành **`failed`**. Trạng thái `needs_review` nghĩa là
> trang web **đã nhận prompt** và có thể đã tốn một lượt — chạy lại lúc đó là tốn tiền hai lần.
> Cùng lý do mà route đó không bao giờ chuyển job cho worker khác sau khi đã gửi.

Những lúc **không** chạy, và đó là đúng:

- Lỗi báo **trước khi** job được tạo (vượt trần ảnh của model, chưa có ảnh khung, thiếu API key).
  Chưa có job thì không có gì để đếm, và chưa tốn credit nào.
- Lỗi **không phải kiểm duyệt** (mất mạng, hết credit, model chưa bật cho tài khoản).
- Chưa đủ **3 lần liên tiếp**. Một lần chạy được là bộ đếm về 0.
- Đã sửa đủ **2 vòng** mà vẫn bị từ chối → dừng hẳn và báo "cần xem tay".

## Phân biệt "bị từ chối" với lỗi khác

Chỉ lỗi **bộ lọc nội dung** mới sửa được bằng cách sửa prompt; lỗi mạng hay hết credit thì sửa
cũng vô ích, chỉ tốn thêm lượt.

### Lỗi THẬT Seedvis trả về (kiểm trên API thật)

```json
{"code": "generation_failed", "message": "Yêu cầu tạo nội dung thất bại."}
```

Đây là thứ Omni Flash trả về khi không dựng — **không** phải "từ chối" hay "content_policy". Mã
`generation_failed` chung chung: Seedvis không tách "bị kiểm duyệt" với lỗi khác. Nhưng trên
project thật, cùng một ảnh khung hỏng **20+/20 lần, ngay tức thì** — lỗi máy chủ tạm thời không
hỏng tất định như vậy. Và lượt 2 của thang là gửi lại nguyên văn: nếu chỉ là lỗi tạm, lượt đó
qua và không có gì bị sửa.

> ⚠ **Trước bản sửa này, thang leo KHÔNG BAO GIỜ chạy trên API thật.** Bộ phân loại chỉ biết
> "từ chối" / "content_policy"; test giả trả đúng những chữ đó nên vẫn xanh. Chỉ chạy thật mới
> lộ ra. Test giờ trả **nguyên văn** lỗi thật.

> ⚠ `seedvis-client.mjs` từng viết `e.message || e.code` — có câu là **mã bị vứt**. Giờ giữ cả
> hai: `Seedvis báo lỗi: Yêu cầu tạo nội dung thất bại. [generation_failed]`.

`isRejection()` khớp: `generation_failed`, `tạo nội dung thất bại`, `bộ lọc an toàn`, `từ chối`,
`safety`, `moderat`, `content_policy`, `violat`, `reject`, `refus`, `blocked`, `prohibited`,
`not allowed`, `inappropriate`, `sensitive content`, `nsfw`.

## Sổ học của agent

Mỗi luật rút ra ghi vào `<thư mục dữ liệu>/learned-rules.json` — **ngoài project**, vì bài học ở
phim này phải áp cho phim sau. Gặp lại cùng một lỗi thì chỉ tăng `count`.

`runStudio()` gắn `rulesText()` vào **mọi trạm** của Node Kịch bản (một chỗ duy nhất:
`turn(st.system + learned, …)`), nên cả drama Nhanh/Kỹ lẫn MV đều đọc. Luật gặp nhiều lần đứng
trước.

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/prompt-doctor.mjs` | **Mới** — `isRejection`, `speakersIn`, `diagnose`, `learn`/`rulesText`, `FICTION_LINE`, hằng số 3 lần / 2 vòng |
| `lib/prompts.mjs` | `keyframeLine(cast, fix)`, `withFiction`, `withExtraVoices`, bỏ câu độc quyền khi `dropExclusive` |
| `lib/runner.mjs` | `onVideoRejected()` — đếm, chẩn, sửa, ghi sổ, chạy lại; gọi ngay chỗ job thành `failed` |
| `lib/jobs.mjs` | `clearRejects()` ở cả hai chỗ job `completed` |
| `lib/script-studio.mjs` | Gắn `rulesText()` vào system prompt của mọi trạm |
| `lib/routes/nodes.mjs` | PATCH nhận `promptFix: null` để gỡ |
| `public/js/inspector.js` | Khung "🩺 Prompt đã tự sửa" + nút gỡ |

## Bẫy đã trả giá

> ⚠ **Đừng phát hiện "nhiều người nói" bằng cách đếm câu trong ngoặc kép.** Thoại của người
> **được khai** (trường `lyric`) thường KHÔNG nằm trong ngoặc kép ở prompt video — nó chỉ được
> nhắc tới. Phải lấy mã người nói từ chính câu "is spoken by X only" rồi so với các mã có thoại
> trong ngoặc kép.

> ⚠ **Tách câu theo dấu chấm là sai** với thoại tiếng Việt: `"Chín giờ sáng. Mẹ tự cất tiền vào
> tủ thờ."` có dấu chấm bên trong. `speakersIn()` quét từng đoạn trong ngoặc kép rồi lấy mã
> được nhắc gần nhất phía trước.

> ⚠ **`physical_anchors` trong blueprint phải là MẢNG** (`director.mjs:733` dùng `arr()`), chuỗi
> thì bị bỏ im lặng và node không có anchors.

## Kiểm thử

```powershell
node test-prompt-doctor.mjs
```

Chạy thật qua đúng hàng đợi, với một bản API Seedvis cục bộ luôn trả `content_policy` cho video
(ảnh vẫn cho qua, vì shot cần keyframe thật mới vào được đường prompt có mô tả ngoại hình).
Kiểm: phân loại lỗi, tìm người nói, chẩn đoán 3 lỗi, đủ 3 lần thì sửa, prompt sinh lại đã khác,
khoá giọng người bị bỏ sót, tự chạy lại với prompt mới, trần 2 vòng, sổ học ghi ra file, gỡ bản
sửa, và chạy được thì xoá bộ đếm.
