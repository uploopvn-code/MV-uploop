// "Đạo diễn": turns a production blueprint (from the master prompt) into a full
// node graph — assets + style + camera setting nodes + storyboard shots — and
// wires every shot to the assets / style / camera it uses.
import crypto from 'node:crypto';
import { defaultNaming } from './output-config.mjs';
import { SHOT_LIST_HEADER } from './lib/shotlist.mjs';

// The master prompt the user pastes into an LLM, plus the output contract that
// makes its result machine-buildable. Served to the UI's "copy" button.
export const MASTER_PROMPT = `MASTER PROMPT — ĐẠO DIỄN SẢN XUẤT MV AI (XUẤT JSON BLUEPRINT)
Vai trò: Bạn là Đạo diễn Điện ảnh & Nhà sản xuất Âm nhạc chuẩn Hollywood. Từ một bài hát
(tên / link / lời / mô tả), hãy thiết kế TOÀN BỘ hồ sơ sản xuất MV Live Concert sân khấu lớn
rồi XUẤT RA DUY NHẤT một khối JSON (trong \`\`\`json ... \`\`\`) để công cụ tự dựng & nối node.

HÃY THIẾT KẾ ĐẦY ĐỦ CÁC PHẦN SAU rồi gói tất cả vào JSON:

1) TẠO HÌNH CA SĨ & NHẠC CÔNG (assets role="character")
   - Mỗi nhân vật dùng lại cho mọi cảnh; "prompt" là MODEL SHEET TURNAROUND 3 góc. DÙNG ĐÚNG
     công thức đã kiểm chứng và PHẢI kết thúc bằng câu disclaimer nhân vật hư cấu:
     "Character model sheet turnaround of a <tuổi> <sắc tộc/giới> <vai trò>, <nét mặt + tóc +
     vóc dáng + trang phục chính>, portrait on left, front, side and back views on right, neutral
     standing pose, solid gray background, studio lighting, consistent facial identity, cinematic
     35mm photorealistic. This is an original fictional AI-generated character, not a real person
     and not resembling any celebrity, public figure or existing model; any resemblance is purely
     coincidental."
   - Nhạc công / ca sĩ chơi nhạc cụ: THÊM "holding <instrument>" (vd "holding Spanish acoustic
     guitar") để nhạc cụ nằm trong model sheet.

2) TẠO HÌNH BỐI CẢNH / SÂN KHẤU (assets role="scene")
   - Sân khấu chính, hậu cảnh, ánh sáng concert, khán đài, đạo cụ... mỗi bối cảnh 1 asset,
     prompt wide 1 dòng. Đây là nơi nhân vật sẽ được ghép vào.

3) STYLE CHUNG (style)
   - Một chuỗi mô tả phong cách hình ảnh áp cho cả MV: định dạng phim (35mm/anamorphic),
     film stock (Kodak/Panavision), bảng màu, grain, "photorealistic, no CGI"...

4) CÁC CỠ CẢNH / MÁY QUAY (cameras)
   - Liệt kê các cỡ cảnh của nhân vật kết hợp với style: wide (toàn sân khấu), medium (nửa người),
     close-up (cận mặt/cảm xúc), macro (cận tay/nhạc cụ), và các góc đặc trưng khác nếu cần.
   - Mỗi camera là một "cỡ cảnh" tái sử dụng được, config mô tả khung hình + chuyển động + ánh sáng.

5) STORYBOARD (shots) — mỗi shot là MỘT cảnh video 8–10 giây
   - "uses": liệt kê đúng "key" của những asset (nhân vật + bối cảnh) ghép vào shot đó.
   - "camera": 1 "key" trong cameras (cỡ cảnh của nhân vật khi kết hợp style).
   - "lyric": đúng đoạn lời hát của cảnh (để lip-sync).
   - "videoPrompt": 1 dòng tiếng Anh "Pace: ... . Prompt Video: ...", nhúng mouth articulates: "...",
     dùng tag @Singer/@Guitarist..., KẾT THÚC bằng:
     , clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHỈ XUẤT MỘT KHỐI JSON duy nhất theo schema sau (không thêm bất kỳ chữ nào ngoài khối JSON):

\`\`\`json
{
  "project": { "name": "Tên MV", "theme": "music" },
  "style": "Cinematic 35mm, Kodak Vision3, teal-orange grade, fine film grain, photorealistic, no CGI.",
  "assets": [
    { "key": "singer",    "role": "character", "name": "Ca sĩ chính", "prompt": "Character model sheet turnaround of a 28yo female pop singer, ..., portrait on left, front, side and back views on right, neutral standing pose, solid gray background, studio lighting, consistent facial identity, cinematic 35mm photorealistic. This is an original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is purely coincidental." },
    { "key": "guitarist", "role": "character", "name": "Guitarist",   "prompt": "Character model sheet turnaround of a 40yo male guitarist, ..., holding an acoustic guitar, portrait on left, front, side and back views on right, neutral standing pose, solid gray background, studio lighting, consistent look, cinematic 35mm photorealistic. This is an original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is purely coincidental." },
    { "key": "stage",     "role": "scene",     "name": "Sân khấu chính", "prompt": "<wide stage prompt 1 dòng>" }
  ],
  "cameras": [
    { "key": "wide",   "name": "Wide",     "config": "Wide establishing shot, full stage, slow dolly, 35mm." },
    { "key": "medium", "name": "Medium",   "config": "Waist-up medium shot, rim light, shallow depth." },
    { "key": "close",  "name": "Close-up", "config": "Emotional close-up on face, catchlight, soft key." },
    { "key": "macro",  "name": "Macro",    "config": "Macro on hands/instrument, high detail." }
  ],
  "shots": [
    {
      "name": "Shot 1 — Intro",
      "start": 0, "duration": 8,
      "uses": ["singer", "stage"],
      "camera": "wide",
      "lyric": "lời hát đúng đoạn",
      "videoPrompt": "Pace: steady 68 BPM, slow push-in. Prompt Video: slow dolly-in on @Singer center stage, mouth articulates: \\"...\\", concert lights pulsing, clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm."
    },
    {
      "name": "Shot 2 — Verse",
      "start": 8, "duration": 8,
      "uses": ["singer", "guitarist"],
      "camera": "medium",
      "lyric": "lời hát đúng đoạn",
      "videoPrompt": "Pace: ... . Prompt Video: @Singer and @Guitarist, mouth articulates: \\"...\\", clean footage, no text, no subtitles, no lyrics on screen, no watermarks, cinematic 35mm."
    }
  ]
}
\`\`\`

QUY TẮC:
- "role" của asset chỉ nhận "character" (ca sĩ/nhạc công/nhân vật) hoặc "scene" (sân khấu/bối cảnh/đạo cụ).
- "uses" chỉ chứa các "key" có thật trong "assets"; "camera" chỉ là một "key" có thật trong "cameras".
- Giữ "key" ngắn, không dấu, không trùng. Tạo đủ shot để phủ hết bài hát.
- Công cụ tự xếp node vào 5 khu (Nhân vật · Bối cảnh · Style/Máy quay · Sản xuất · Video) và tự nối
  nhân vật + bối cảnh + cỡ máy + style vào từng shot. KHÔNG viết gì ngoài khối JSON.

LỆNH KÍCH HOẠT: "BẮT ĐẦU: [Tên bài hát / Link / Lời]".`;

// The MUSIC node's analyzer: from a song (title / YouTube link / lyrics / known length) the LLM
// returns ONLY a JSON block of the parameters the tool needs to lay out an MV storyboard — the
// song structure with timecodes, bpm, a suggested shot count, and visual/camera hints. A text
// LLM cannot "listen" to audio, so the prompt leans on the supplied lyrics + duration and says
// to state its assumptions when those are missing.
export const MUSIC_MASTER_PROMPT = `MASTER PROMPT — PHÂN TÍCH BÀI HÁT CHO MV (XUẤT JSON THÔNG SỐ)
Vai trò: Bạn là Giám đốc Âm nhạc kiêm Trợ lý sản xuất MV. Từ thông tin một bài hát (tên / link
YouTube / lời / mô tả / thời lượng), hãy PHÂN TÍCH bài hát rồi XUẤT RA DUY NHẤT một khối JSON
(trong \`\`\`json ... \`\`\`) chứa các THÔNG SỐ công cụ cần để dựng storyboard MV.

QUY TẮC PHÂN TÍCH:
- Nếu đã cho "Thời lượng (giây)", "durationSec" PHẢI đúng bằng con số đó; mọi mốc trong "sections"
  phải nằm trong [0, durationSec], liền mạch (đoạn sau nối tiếp đoạn trước), không chồng, không hở.
- Chia bài thành các đoạn (Intro, Verse, Pre-Chorus, Chorus, Bridge, Instrumental, Outro…), mỗi
  đoạn một phần tử "sections" với mốc bắt đầu/kết thúc (giây) và ĐÚNG đoạn lời của nó.
- Nếu không có lời: dựa vào hiểu biết về bài hát (nếu nhận ra) hoặc mô tả để ước lượng cấu trúc,
  và ghi rõ giả định trong "notes" (đừng bịa lời — để "lyric" trống nếu không chắc).
- "suggestedShots": số shot đề xuất phủ hết bài (mỗi shot 4–8 giây; Chorus/cao trào cắt nhanh hơn).
- Các trường gợi ý hình ảnh/máy quay viết bằng TIẾNG ANH (để đưa thẳng vào prompt ảnh/video).

CHỈ XUẤT MỘT KHỐI JSON duy nhất theo schema sau (không thêm chữ nào ngoài khối JSON):

\`\`\`json
{
  "title": "Tên bài hát",
  "artist": "Nghệ sĩ (nếu biết)",
  "language": "ngôn ngữ lời hát",
  "durationSec": 0,
  "bpm": 0,
  "timeSignature": "4/4",
  "key": "tông (nếu biết)",
  "genre": "thể loại",
  "mood": "cảm xúc chủ đạo",
  "energyCurve": "một dòng mô tả đường năng lượng theo thời gian",
  "sections": [
    { "name": "Intro", "startSec": 0, "endSec": 8, "energy": "low", "lyric": "đúng đoạn lời", "note": "" }
  ],
  "suggestedShotSeconds": 8,
  "suggestedShots": 0,
  "styleHints": "English: visual style / color / film-stock suggestions for the MV",
  "cameraHints": "English: camera movement & shot-size energy per section",
  "notes": "giả định / cảnh báo (vd: thời lượng ước lượng, chưa có lời)"
}
\`\`\`

LỆNH KÍCH HOẠT: "PHÂN TÍCH BÀI HÁT: [tên / link / lời / thời lượng]".`;

// The MV SHOT LIST master prompt — run OUTSIDE the app with the mp3 attached (e.g. ChatGPT). It
// writes ONE CSV with the standard header the importer reads (lib/shotlist.mjs): the COVERAGE
// stream (luồng A), which tiles the WHOLE song with what the editor cuts TO while it plays — band
// wide/medium/close, the instrument playing at that moment, the full stage, the audience. The
// singer's lip-sync stream (luồng B) is cut by the tool itself from the vocal, so the CSV never
// spends a row on the singer performing to camera. The app then re-times every sung row to the GPU
// reading of the vocal, so the prompt spends the model's effort on what the tool cannot measure:
// exact lyrics in order, rhythm, emotion per line, set and camera.
// The MUSIC node's copy button appends the song's facts (title, exact length, official lyrics).
export const DEEP_MUSIC_ANALYSIS_PROMPT = `MASTER PROMPT — MV SHOT LIST · LUỒNG A "PHỦ CẢNH" (1 FILE CSV CHUẨN CHO TOOL)

Bạn là Đạo diễn MV + Dựng phim âm nhạc + Giám sát hình ảnh sân khấu. Phân tích file nhạc ĐÍNH KÈM,
đọc phần THÔNG TIN BÀI HÁT ở cuối, rồi viết MỘT bảng shot list CSV để tool dựng MV.

HAI LUỒNG HÌNH — CSV NÀY CHỈ LÀ LUỒNG A:
- LUỒNG A (chính là CSV bạn viết) = PHỦ CẢNH: toàn / trung / cận ban nhạc, đúng nhạc cụ đang chơi ở
  khoảnh khắc đó, toàn cảnh sân khấu, khán giả và cảm xúc của họ, chi tiết và bối cảnh. Đây là những
  hình người dựng CẮT SANG trong khi bài hát đang chạy.
- LUỒNG B (tool tự dựng, bạn KHÔNG viết hàng nào) = HÁT NHÉP: tool lấy giọng hát thật, cắt từng câu
  rồi gộp các câu liền nhau thành từng take 7–10 giây, mỗi take một cỡ cảnh của ca sĩ hát khớp giọng.
- VÌ VẬY: KHÔNG được có hàng nào là "ca sĩ hát vào ống kính". Ca sĩ VẪN được xuất hiện trong luồng A
  — từ phía sau, bóng ngược sáng, bàn tay, bước đi, nhìn sang ban nhạc — nhưng không bao giờ thấy
  khẩu hình đang hát. Cột "Lip Sync" vì vậy LUÔN là NO (cột chỉ còn để đọc được file cũ).
- Hai luồng chạy SONG SONG trên cùng một bài: luồng A phải phủ kín cả những giây đang có tiếng hát
  (lúc đó khung là ban nhạc / nhạc cụ / khán giả đang nghe chính câu hát ấy), để người dựng cắt
  sang ban nhạc được ở BẤT KỲ giây nào.

TOOL SẼ LÀM GÌ VỚI CSV (để bạn ưu tiên đúng):
- Tool tách giọng hát và dùng GPU tìm đúng chỗ từng câu được hát, rồi tự đặt mốc cắt của mỗi hàng
  có lời ngay trước khi giọng vào, tự giữ các khoảng nghỉ và tự cắt hàng dài quá 8 giây. Vì vậy
  LỜI và THỨ TỰ hàng phải đúng tuyệt đối; Start/End chỉ cần ước lượng hợp lý. Tool sửa được thời
  gian, KHÔNG sửa được thứ tự.
- Mỗi hàng = MỘT nhát cắt (một góc máy), dài TỐI ĐA 8 giây. Tool ghép các hàng liền nhau thành MỘT
  clip ≤ 8 giây: một prompt duy nhất tả cả cụm, kèm ảnh tham chiếu của MỌI người và vật cụm đó cho
  thấy. Vì vậy hãy xếp các hàng cùng một Location và cùng MỘT ý (cùng khoảnh khắc nhạc, cùng nhóm
  người) nằm CẠNH NHAU, để prompt ghép đọc liền mạch.
- Subject và người được nhắc trong Action → tool gắn ảnh nhân vật; Location → tool gắn ảnh bối cảnh
  (tool chỉ biết bối cảnh qua TÊN Location, nên ô này KHÔNG được để trống). Emotion, Energy, Shot
  Size, Angle, Camera Movement, Action → vào prompt ảnh/video. Lyric → phụ đề, và là chỗ tool dựa
  vào để căn hàng vào giọng thật.

LÀM THEO THỨ TỰ:
1. Âm thanh: dùng Python đo độ to theo thời gian (và BPM nếu được) để xác định cấu trúc đoạn
   (Intro / Verse / Pre-Chorus / Chorus / Bridge / Instrumental / Outro), năng lượng từng đoạn, và
   NHẠC CỤ nào nghe rõ nhất ở từng đoạn. Không đo được thì ghi "ước lượng", không bịa số.
2. Hành trình cảm xúc: mỗi Section một cảm xúc gốc (đổi tối đa một lần khi lời rẽ nghĩa); cả bài
   là một đường đi (vd: cô độc → thú nhận → nhẹ nhõm → bình yên), đỉnh ở đoạn to và dày nhất;
   đoạn kết lắng thì giữ lắng.
3. Dàn và bối cảnh: theo dòng "Ý tưởng MV" ở cuối (QUY TẮC BỐI CẢNH). Singer + nhạc công cho các
   nhạc cụ ghi ở dòng "Nhạc cụ" (tối đa 3). Dòng đó "không rõ": chỉ MỘT nhạc công — Pianist cho
   ballad, thánh ca, nhạc thờ phượng; Guitarist cho thể loại khác. Choir chỉ khi dòng "Nhạc cụ"
   có hợp xướng. Liệt kê luôn các Location: sân khấu, hàng ghế khán giả, và nơi khác nếu có thấy.
4. Chia hàng theo lời (QUY TẮC NHỊP), phủ từng Section theo CÔNG THỨC PHỦ CẢNH, rồi viết từng hàng.
5. Tự kiểm tra (VALIDATION) rồi mới xuất.

CÁC CỘT — đúng tên, đúng thứ tự, mỗi ô MỘT giá trị:
${SHOT_LIST_HEADER}

- Shot: 001, 002, 003… mỗi hàng một số riêng, liên tục, không trùng, không thêm a/b.
- Start, End: mm:ss.mmm. Hàng đầu Start = 00:00.000; Start hàng sau = End hàng trước; End hàng
  cuối = TOTAL_DURATION. Không hở, không chồng. Mỗi hàng dài 2–8 giây: KHÔNG hàng nào quá 8 giây
  (tool phải cắt, và chỗ cắt không còn khớp khung bạn viết).
- Section: Intro, Verse 1, Pre-Chorus 1, Chorus 1, Verse 2, Bridge, Instrumental 1, Final Chorus,
  Outro…
- Lyric: câu ĐANG ĐƯỢC HÁT trong khoảng thời gian của hàng (người và nhạc cụ trong khung đang phản
  ứng với chính câu đó; tool cũng dùng ô này để căn hàng vào giọng thật). Chép NGUYÊN VĂN từ LỜI
  CHÍNH THỨC — lời đó đã đúng thứ tự và số lần hát trong bản thu. Không thêm lần lặp, không bỏ câu,
  không đổi chữ (ngoại lệ duy nhất: số viết thành chữ như được hát, "2000" → "dos mil"), không
  dịch, không ghi chú, không [Chorus], không (x2), không ad-lib. Để TRỐNG khi không có giọng. Không
  dùng dấu gạch nối "-" và dấu ngoặc kép trong Lyric.
- Lip Sync: LUÔN là NO, ở mọi hàng, không ngoại lệ (luồng hát nhép do tool tự cắt từ giọng thật).
- Energy: 1–10 theo độ to đo được (1 = đoạn lặng nhất, 10 = đoạn to và dày nhất); không đo được
  thì ước lượng theo cấu trúc bài (ghi "ước lượng" trong phần Tóm tắt).
- Emotion: cảm xúc NHÌN THẤY ĐƯỢC, tiếng Anh. Người (nhạc công, ban nhạc, khán giả, ca sĩ):
  "<cảm xúc> — <nét mặt, cơ thể>; <cách chơi hoặc cách phản ứng>" (vd "driving focus — brows down,
  shoulders forward; hammering the low keys", "quiet awe — eyes wet, hands still; leaning
  forward"). Không chắc phần sau thì bỏ phần sau dấu ";". Khung không có người (kể cả vật):
  "<tâm trạng> — <hình ảnh>" (vd "stillness — untouched candles, cold blue air").
- Subject: ai / cái gì trong khung — CHỈ dùng: Band, Singer, Pianist, Guitarist, Violinist,
  Cellist, Drummer, Bassist, Choir, Audience, Stage, hoặc một vật (danh từ tiếng Anh, không mạo từ:
  Piano keys, Guitar strings, Drum skin, Microphone, Candle). KHÔNG tự nghĩ tên mới: Ensemble,
  Full Ensemble, Orchestra, Musicians, All performers, "Choir + Strings" đều phải viết là "Band".
  - "Band" = 3 người trở lên. Action PHẢI gọi tên từng nhạc công thấy trong khung ("Pianist at
    stage left, Drummer behind, Guitarist at stage right") — tool gắn ảnh nhạc công theo câu đó.
  - Hai người: "Pianist + Drummer".
  - Một nhạc cụ ("Piano keys", "Guitar strings"): tool gắn ảnh người chơi nhạc cụ đó.
  - Có Singer: CHỈ cho khung không thấy đang hát — Angle phải là rear, profile hoặc overhead, hoặc
    khung chỉ thấy bàn tay / bóng / dáng người; không bao giờ MCU hay CU chính diện mặt ca sĩ.
  - Khung chỉ có bối cảnh, không có người: để TRỐNG (Location vẫn phải điền).
- Location: BẮT BUỘC điền ở MỌI hàng. Tên tiếng Anh 2–5 chữ, đủ để vẽ, viết GIỐNG HỆT nhau ở mọi
  hàng của cùng một nơi (vd "Candlelit opera stage"). Mỗi nơi NHÌN KHÁC nhau là một Location riêng
  có tên riêng: hàng ghế khán giả là "Audience rows", ban công là "Opera balcony", hậu trường là
  "Backstage wing". KHÔNG nhét tên nơi vào cột Subject.
- Shot Size: CHỈ dùng mã EWS, WS, MS, MCU, CU, ECU, Macro — không viết "Wide", "Medium", "Close".
- Angle: eye level, low, high, 3/4, profile, overhead, rear.
- Camera Movement: locked, slow push-in, pull-out, dolly left, dolly right, orbit, tracking,
  crane up, crane down, handheld, rack focus.
- Action: một câu tiếng Anh tả việc nhìn thấy được (động tác, tay trên phím đàn, ánh sáng đổi…).
  Chỉ nhắc người và nhạc cụ thật sự có trong khung — hàng Band phải nhắc đủ tên các nhạc công thấy
  trong khung. Không lặp lại Emotion, không tả khẩu hình, không viết ca sĩ đang hát.
- Vocal Delivery: CHỈ điền ở hàng CÓ Lyric; hàng không lời để TRỐNG. Tả CA SĨ hát câu đó thế nào —
  cảm xúc TRONG GIỌNG + độ to (soft / medium / full voice), tiếng Anh (vd "aching, almost
  whispered — soft voice"; "defiant, lifting — full voice"). Đây là dữ liệu DUY NHẤT cho luồng
  hát nhép (luồng B): tool cắt các câu ca sĩ hát từ giọng thật rồi dùng ô này làm cảm xúc + cách
  hát cho từng câu. KHÁC với Emotion (Emotion tả người/vật TRONG KHUNG của luồng A — thường là
  band hoặc khán giả, không phải ca sĩ).

QUY TẮC NHỊP (chia hàng theo TỪ — từ = các chữ cách nhau bởi dấu cách, không đếm âm tiết):
- "Câu" = một dòng của LỜI CHÍNH THỨC. Mỗi câu bắt đầu một hàng mới (hàng đó là hình phủ cảnh
  trong lúc câu ấy được hát), trừ hai trường hợp ghép và tách dưới đây.
- Ghép (Intro, Verse, Bridge, Outro, phần nói): hai câu liền nhau đều ≤ 4 từ thì ghép vào một
  hàng, nối bằng dấu cách — miễn hàng vẫn ≤ 8 giây.
- Tách (Pre-Chorus, Chorus, Final Chorus): câu dài hơn 8 từ, hoặc câu hát lâu hơn 8 giây, tách 2
  hàng ở dấu phẩy hoặc ranh giới từ. Bài nhanh: ở Final Chorus tách cả câu dài hơn 5 từ — đó là
  chỗ cắt nhanh nhất của bài.
- Khi tách: chia đúng từ theo thứ tự, không lặp từ; nửa sau phải là khung KHÁC (Subject khác hoặc
  Shot Size khác).
- Hàng không lời chỉ ở chỗ thật sự không có giọng: intro trước câu đầu, gian tấu giữa hai câu khi
  khoảng lặng ≥ 1 giây, outro sau câu cuối; mỗi hàng 2–6 giây. Gian tấu từ 8 giây trở lên là
  Section riêng "Instrumental N", phủ bằng nhiều hàng ≤ 8 giây (cận người đang solo → nhạc cụ →
  toàn cảnh). Không chèn hàng không lời vào chỗ hai câu hát sát nhau (khoảng lặng < 1 giây).

CÔNG THỨC PHỦ CẢNH (phần việc chính của luồng A):
- Trong mỗi Section, luân phiên 6 loại khung sau theo THỨ TỰ ƯU TIÊN 3 → 1 → 4 → 6 → 2 → 5, lấy
  được bao nhiêu loại thì tùy số hàng của Section (Section dài đủ cả 6; Section ngắn chỉ vài loại
  đầu). Muốn thêm một loại khung mà không đủ hàng thì TÁCH một câu dài thành 2 hàng, mỗi nửa một
  góc khác.
  1) WS hoặc EWS cả ban nhạc trên sân khấu (toàn);
  2) MS một nhóm 2–3 người đang chơi (trung);
  3) CU hoặc MCU một nhạc công đang chơi (cận) — chọn người có tiếng nghe rõ nhất ở Section đó;
  4) Macro hoặc ECU đúng nhạc cụ đang dẫn Section (phím đàn, dây guitar, mặt trống, cần kéo);
  5) EWS toàn cảnh sân khấu trong không gian (thấy cả khán phòng hoặc cả chiều cao sân khấu);
  6) khán giả phản ứng — CU một khuôn mặt hoặc WS hàng ghế, Location "Audience rows".
- Nhạc cụ phải ĐÚNG LÚC: chỉ cận hay Macro nhạc cụ nào thật sự đang nghe thấy ở giây đó.
- Thứ tự luân phiên theo Energy, để một Section không lặp một cỡ cảnh:
  Energy 1–3: mở bằng Macro hoặc CU chi tiết, ít người; kết Section bằng một WS.
  Energy 4–6: MS nhóm → CU nhạc công → WS cả band, lặp vòng đó.
  Energy 7–8: mở bằng WS hoặc EWS cả band → CU nhạc công theo nhịp → chèn một hàng khán giả.
  Energy 9–10: EWS toàn cảnh, khán giả và CU nhạc công dồn dập; Macro nhiều nhất một hàng.
- Không lặp cùng (Subject + Shot Size) ở hai hàng liền nhau; cùng một Shot Size không quá 2 lần
  trong một Section. Chorus hát lại không lặp lại thứ tự khung của Chorus trước.
- Ca sĩ xuất hiện nhiều nhất ở 1/5 số hàng, và luôn theo luật Subject ở trên.

QUY TẮC CẢM XÚC:
- Mỗi Section có MỘT cảm xúc gốc (từ bước 2); nếu lời rẽ nghĩa giữa Section (vd câu mở bằng
  "Pero…", "Nhưng…"), cảm xúc gốc đổi MỘT lần tại câu đó và giữ đến hết Section. Từng hàng đổi
  BIỂU HIỆN (mắt, tay, hơi thở, hướng nhìn, lực đánh đàn) theo nghĩa của chính câu đang hát.
- Độ mạnh của biểu cảm theo Energy. Khuôn Verse kìm nén → Pre-Chorus dồn lên → Chorus bung ra →
  Bridge vỡ hoặc lắng → Final Chorus đỉnh chỉ là mặc định khi nghĩa câu không nói khác. Ballad,
  thánh ca: "bung" là nước mắt, nhẹ nhõm, biết ơn — không gào.
- Nhạc công và khán giả phản chiếu cảm xúc gốc đang áp dụng tại hàng đó: nhạc công qua cách chơi
  (lực, biên độ tay, người gập xuống hay mở ra), khán giả qua mắt, tay và thế người.
- Cùng một câu hát lại ở các Chorus phải có Emotion khác, đi tiếp hành trình (lần đầu ngỡ ngàng,
  lần sau tin, lần cuối trọn vẹn).

QUY TẮC MÁY:
- Chỉ dùng giá trị trong danh sách Camera Movement.
- Theo Energy: 1–3 locked, slow push-in; 4–6 dolly left, dolly right, pull-out, rack focus; 7–8
  orbit, tracking, crane up; 9–10 crane up, crane down, tracking, handheld.
- Macro và ECU: locked hoặc rack focus (giữ nét vào chi tiết). Hàng khán giả: locked, slow push-in,
  dolly left hoặc dolly right — không orbit, không handheld.
- Bài chậm hay nhanh xét theo thể loại và mật độ lời, không chỉ theo số BPM (máy đo hay nhân đôi
  hoặc chia đôi). Ballad, thánh ca, nhạc thờ phượng luôn là bài chậm: bỏ handheld và tracking khỏi
  bảng trên; Energy 7–10 dùng crane up, crane down hoặc orbit.
- WS và EWS cho khung cả band, toàn cảnh sân khấu, hàng ghế khán giả. MS cho nhóm 2–3 người. CU và
  MCU cho một nhạc công. Macro và ECU cho nhạc cụ, bàn tay, chi tiết đạo cụ.

QUY TẮC BỐI CẢNH:
- Live concert: nơi biểu diễn là Location chính, nhưng mỗi khu NHÌN KHÁC nhau trong cùng khán
  phòng (hàng ghế khán giả, ban công, hậu trường) phải là một Location riêng — đó là cách duy nhất
  để chúng có ảnh bối cảnh riêng thay vì dùng lại ảnh sân khấu. Ánh sáng đổi theo cảm xúc thì ghi
  trong Action ("stage wash shifts to warm gold") — KHÔNG đổi Location.
- MV kể chuyện hoặc kết hợp: thêm tối đa 2 Location ngoài khán phòng, lấy từ hình ảnh trong lời; ở
  đó Subject chỉ là Singer (theo luật Singer ở trên) hoặc một vật.
- Tool luôn cắt clip khi đổi Location, nên các hàng cùng một Location phải nằm liền nhau: mỗi lần
  sang khán giả hoặc ban công thì gom 1–2 hàng liền nhau rồi quay lại sân khấu; trong một Section
  đổi Location nhiều nhất hai lần.

XUẤT KẾT QUẢ:
1. Tóm tắt ngắn: BPM, nhịp, cấu trúc + năng lượng + nhạc cụ dẫn từng đoạn (ghi rõ đo hay ước
   lượng), hành trình cảm xúc, danh sách Subject và Location.
2. ĐÚNG MỘT khối \`\`\`csv … \`\`\` với header ở trên (dấu phẩy phân cách; bọc "…" mọi ô có dấu
   phẩy — luôn bọc Lyric, Emotion, Action khi có chữ; ô trống để trống). Tạo luôn file .csv để
   tải về.
3. VALIDATION — dùng Python kiểm, sai thì sửa trước khi xuất:
   - tổng thời lượng = TOTAL_DURATION; số chỗ hở = 0; số chỗ chồng = 0; số hàng dài quá 8 giây = 0;
   - Lip Sync = NO ở 100% số hàng; số hàng là ca sĩ hát vào ống kính = 0 (mọi hàng có Singer đều
     có Angle rear, profile hoặc overhead, hoặc chỉ thấy tay / bóng / dáng);
   - số hàng Location trống = 0; mỗi tên Location viết giống hệt ở mọi hàng của nó;
   - Subject chỉ nằm trong danh sách cho phép; Shot Size chỉ là EWS, WS, MS, MCU, CU, ECU, Macro;
   - mọi hàng Subject = Band có Action gọi tên ít nhất 2 nhạc công;
   - mỗi hàng CÓ Lyric đều có Vocal Delivery; mỗi hàng KHÔNG Lyric có Vocal Delivery trống;
   - mỗi Section luân phiên cỡ cảnh theo CÔNG THỨC PHỦ CẢNH (không lặp Subject + Shot Size ở hai
     hàng liền nhau);
   - nối cột Lyric theo thứ tự, bỏ dấu câu, so từng từ với LỜI CHÍNH THỨC (sau khi đổi số trong đó
     thành chữ như ở cột Lyric): số từ thừa = 0, số từ thiếu = 0.
Ưu tiên: PHỦ KÍN BÀI → LỜI ĐÚNG → THỨ TỰ → CẢM XÚC → BỐI CẢNH, MÁY → ĐẸP.`;

// First stage of the conversational director: turn a bare idea / logline / lyrics into a
// readable KỊCH BẢN (treatment) a human reviews and edits before any JSON is built. Plain
// prose, no JSON — the blueprint stage reuses the master prompt to turn this into JSON.
export const SCRIPT_SYSTEM = `Bạn là Đạo diễn Điện ảnh kiêm Nhà biên kịch. Từ ý tưởng/logline/lời
bài hát người dùng đưa, hãy viết một KỊCH BẢN (treatment) ngắn gọn, mạch lạc bằng tiếng Việt để
con người duyệt trước khi dựng sản xuất. Bố cục:

1) LOGLINE: 1–2 câu.
2) NHÂN VẬT: mỗi nhân vật 1 dòng (tên, ngoại hình, tính cách, vai trò).
3) BỐI CẢNH: các địa điểm/sân khấu chính, mỗi nơi 1 dòng.
4) PHONG CÁCH & TÔNG: hình ảnh, ánh sáng, nhịp.
5) PHÂN CẢNH: đánh số từng cảnh (Cảnh 1, 2, 3…), mỗi cảnh ghi: ai, ở đâu, hành động, và DÒNG
   THOẠI/LỜI đúng của cảnh (đặt trong ngoặc kép). Đủ cảnh để phủ hết câu chuyện/bài hát.

CHỈ viết kịch bản dạng văn xuôi có đánh số, KHÔNG xuất JSON, KHÔNG thêm lời dẫn ngoài kịch bản.
Nếu người dùng đã đưa kịch bản sẵn thì chỉnh trang lại cho đủ bố cục trên.`;

// The blueprint stage feeds the approved script back through the master prompt. This wraps the
// script as the activation command the master prompt expects.
export const blueprintFromScript = script =>
  'BẮT ĐẦU — dựng blueprint từ KỊCH BẢN đã được duyệt dưới đây. Giữ đúng nhân vật, bối cảnh, ' +
  'phân cảnh và lời thoại của kịch bản; mỗi cảnh thành một shot với "lyric" là đúng dòng thoại/lời ' +
  'của cảnh đó.\n\n=== KỊCH BẢN ===\n' +
  script +
  '\n=== HẾT ===\n\nChỉ trả về đúng khối JSON blueprint theo schema đã mô tả, không thêm chữ nào ngoài khối JSON.';

// Extracts the blueprint object from LLM text (handles a ```json fence or a bare object).
export function parseBlueprint(input) {
  if (input && typeof input === 'object') return input;
  const text = String(input || '');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf('{'),
    last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  throw new Error('Không đọc được JSON blueprint. Dán đúng khối JSON từ master prompt.');
}

// Extracts the music-analysis object from the LLM's reply (a ```json fence or a bare object),
// the same tolerance as parseBlueprint but with its own error message.
export function parseMusicAnalysis(input) {
  if (input && typeof input === 'object') return input;
  const text = String(input || '');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf('{'),
    last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch {}
  }
  throw new Error('Không đọc được JSON thông số bài hát từ kết quả phân tích.');
}

const str = (v, n = 20000) => String(v ?? '').slice(0, n);
// One line from a Bible voice_profile — "Female, Late 30s; timbre: …; accent: …; pacing: …;
// baseline: …" (a plain-string profile passes through). Sent with every line the character speaks.
function voiceOf(vp) {
  if (!vp) return '';
  if (typeof vp !== 'object') return str(vp, 1000).trim();
  const label = {
    timbre: 'timbre',
    accent: 'accent',
    pacing: 'pacing',
    emotional_baseline: 'baseline',
  };
  const parts = [[vp.gender, vp.age_sound].filter(Boolean).join(', ')];
  for (const [k, v] of Object.entries(vp))
    if (k !== 'gender' && k !== 'age_sound' && v != null && String(v).trim())
      parts.push(`${label[k] || k.replace(/_/g, ' ')}: ${String(v).trim()}`);
  return str(parts.filter(Boolean).join('; '), 1000);
}
// The two opposing close angles of a dialogue location, derived from the master view:
// "a" is what camera OTS A sees (over A's shoulder, looking at B), "b" the 180° reverse.
export const ANGLE_PRESETS = {
  a: {
    name: 'góc cận A (sau vai A nhìn B)',
    angle:
      'Reverse angle A of the dialogue: medium-close, looking in the same general direction as the reference view but from much closer, right at the spot where the two speakers stand, eye level, the far side of the location filling the background',
  },
  b: {
    name: 'góc cận B (sau vai B nhìn A)',
    angle:
      'Reverse angle B of the dialogue, the 180-degree counterpart of angle A: the camera now stands at the far end of the playing area and looks back toward where the reference view was taken, medium-close, eye level, showing the side of the location that lies behind the reference camera, designed to match everything visible in the reference',
  },
};
// Which side of a dialogue a camera preset covers: "a" for an over-shoulder-A camera
// (ots_a / "over character A's shoulder"), "b" for its reverse, '' otherwise.
const otsSide = c => {
  if (!c) return '';
  const t = [c.key, c.id, c.name, c.config, c.prompt].map(x => str(x, 500)).join(' ');
  if (
    /over[-_ ]?(the[-_ ]?)?shoulder[-_ ]?a(?![a-z0-9])|(^|[^a-z])ots[-_ ]?a(?![a-z0-9])|character a'?s shoulder/i.test(
      t,
    )
  )
    return 'a';
  if (
    /over[-_ ]?(the[-_ ]?)?shoulder[-_ ]?b(?![a-z0-9])|(^|[^a-z])ots[-_ ]?b(?![a-z0-9])|character b'?s shoulder/i.test(
      t,
    )
  )
    return 'b';
  return '';
};
// A dialogue location's staging, as a merged scene's camera setups need it: the opening
// sentence of every still ("The study from image 1 at night."), then, for each side of the
// frame, what the person standing there has behind them and what light falls on them.
function stagingOf(c) {
  if (!c || typeof c !== 'object') return null;
  const side = s =>
    s && typeof s === 'object'
      ? {
          anchor: str(s.anchor, 500),
          background: str(s.background, 500),
          light: str(s.light || s.lighting, 500),
        }
      : { anchor: '', background: '', light: '' };
  const staging = {
    place: str(c.place, 500),
    two_shot: str(c.two_shot, 500),
    left: side(c.left),
    right: side(c.right),
  };
  return staging.place || staging.left.background || staging.right.background ? staging : null;
}
// The camera setups a merged scene can be written from, and what the frame node is called.
const FRAMINGS = ['ots_a', 'ots_b', 'two_shot'];
const FRAMING_LABEL = {
  ots_a: 'qua vai A',
  ots_b: 'qua vai B',
  two_shot: 'trung đôi',
};
const nid = () => 'node-' + crypto.randomUUID();

// Collects every JSON blueprint from the input: an object, an array of objects, or text
// with one or more ```json blocks. Lets the user paste a feature-mode bible together with a
// sequence file (two blocks) and have them merged.
function collectBlueprints(input) {
  if (Array.isArray(input)) return input.filter(x => x && typeof x === 'object');
  if (input && typeof input === 'object') return [input];
  const text = String(input || '');
  const out = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {}
  }
  if (out.length) return out;
  const first = text.indexOf('{'),
    last = text.lastIndexOf('}');
  for (const c of [first !== -1 && last > first ? text.slice(first, last + 1) : null, text]) {
    if (!c) continue;
    try {
      return [JSON.parse(c)];
    } catch {}
  }
  throw new Error('Không đọc được JSON blueprint. Dán đúng khối JSON từ master prompt / skill.');
}
const arr = v => (Array.isArray(v) ? v : []);

// A blueprint usually bakes "Camera: … Style: …" into each videoPrompt, but the tool
// injects those from the wired camera + style setting nodes. Strip that trailing clause
// so they are not duplicated, leaving the composition + staging description that drives
// both the keyframe image and the video motion.
function baseShotPrompt(sh) {
  const vp = str(sh.videoPrompt);
  const i = vp.search(/\s*Camera\s*:/i);
  const base = (i >= 0 ? vp.slice(0, i) : vp).trim();
  return base;
}

// Drama (VEO) prompts carry "Camera: <config>." mid-prompt, right before "Lighting &
// Physics: …". When the shot is wired to a camera node that node injects "Camera: …", so
// drop just that sentence and keep the staging + lighting + safety tail intact. A prompt
// with no recognisable camera sentence is left untouched.
function stripInlineCamera(vp) {
  return vp
    .replace(/\s*Camera\s*:\s*.*?\.(?=\s+(?:[A-Z]|lighting)|\s*$)/, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Builds nodes + edges from a blueprint and returns { nodes, edges, name, theme }.
// Throws on invalid input. Does not touch audio/fields/output settings.
export function buildGraph(bp) {
  const parts = collectBlueprints(bp).map(p => p.blueprint || p);
  // Merge assets / cameras / styles / shots across all parts, pulling from a feature-mode
  // bible and from split character/scene/prop arrays too. Dedupe each list by key.
  let project = null;
  let film = null; // the film this sequence belongs to (assets are shared across its projects)
  const assets = [],
    cameras = [],
    styles = [],
    audio = [],
    shots = [];
  for (const p of parts) {
    project = project || p.project;
    film = film || p.film || p.bible?.film;
    for (const a of [p.assets, p.bible?.assets, p.characters, p.scenes, p.props].flatMap(arr))
      assets.push(a);
    for (const c of [p.cameras, p.bible?.cameras].flatMap(arr)) cameras.push(c);
    // Background music / on-set sound presets, wired into the shots that use them.
    for (const a of [p.audio, p.sound, p.bible?.audio, p.bible?.sound].flatMap(arr)) audio.push(a);
    // Wardrobe list (costume wiring spec): kind "costume" = one character re-rendered in a
    // new look (input: that character's image), kind "item" = a prop kept in the same
    // column. Older files declare costumes as assets with role "wardrobe"; both work.
    for (const w of [p.wardrobe, p.wardrobes, p.outfits, p.bible?.wardrobe, p.bible?.wardrobes]
      .flatMap(arr)
      .filter(w => w && typeof w === 'object'))
      assets.push({ ...w, role: w.kind === 'item' || w.role === 'item' ? 'item' : 'wardrobe' });
    // Style: a keyed "styles" array (drama bible) and/or one film-level "style" string.
    for (const s of [p.styles, p.bible?.styles].flatMap(arr)) styles.push(s);
    const plain = p.style ?? p.bible?.style;
    if (plain && typeof plain === 'object') styles.push(plain);
    else if (str(plain, 5000).trim()) styles.push({ key: 'style', name: 'Style', prompt: plain });
    for (const s of arr(p.shots)) shots.push(s);
  }
  const b = { project, assets, cameras, shots };
  const dedupe = list => {
    const seen = new Set();
    return list.filter(x => {
      const k = str(x?.key || x?.id || x?.name, 200);
      if (!k || seen.has(k)) return !!k && false;
      seen.add(k);
      return true;
    });
  };
  const uniqAssets = dedupe(assets);
  const uniqCameras = dedupe(cameras);
  const uniqAudio = dedupe(audio);
  const uniqStyles = dedupe(styles);
  if (!uniqAssets.length) {
    const keys = [...new Set(parts.flatMap(p => Object.keys(p)))].join(', ') || '(trống)';
    throw new Error(
      'Blueprint thiếu "assets" (không thấy nhân vật/bối cảnh). Nếu đây là file phân đoạn ' +
        'seq-XX của phim dài, hãy dán kèm cả bible.json (dán cả hai khối JSON vào ô này). ' +
        'Khóa JSON tìm thấy: ' +
        keys +
        '.',
    );
  }
  if (!shots.length) throw new Error('Blueprint thiếu "shots".');

  // Drama (Google VEO) blueprints use project.title, role:"prop" assets and a keyed
  // "styles" array; each shot's videoPrompt bakes in "Camera: … Lighting & Physics: …".
  // A drama shot is wired to its camera + style nodes exactly like a music shot (so
  // editing one node updates every shot that uses it); only the inline "Camera:" sentence
  // is dropped so the wired camera node is the single source — the lighting + safety tail
  // of the VEO prompt stays verbatim.
  const isDrama =
    !!(b.project && b.project.title && !b.project.name) ||
    assets.some(a => ['prop', 'item', 'wardrobe'].includes(a.role));

  const nodes = [],
    edges = [];
  const assetId = {},
    camId = {},
    audioId = {},
    styleId = {};

  // Style nodes (Style/Camera setup zone): one per "styles" entry, or the single
  // film-level "style" string. A shot picks one by key; a lone style is wired to every shot.
  for (const s of uniqStyles) {
    const key = str(s.key || s.id || s.name, 100);
    const config = str(s.prompt || s.config, 5000);
    if (!key || !config.trim()) continue;
    const id = nid();
    styleId[key] = id;
    nodes.push({
      id,
      kind: 'setting',
      settingType: 'style',
      zone: 'setup',
      name: str(s.name || key, 100),
      config,
    });
  }

  const charRe = /singer|char|vocal|ca s[iĩ]|nh[aâ]n v[aậ]t|artist/i;
  const assetKeyOf = a => str(a.key || a.id || a.name, 100);
  // Character by role/zone, or (role-less music assets) by a name hint.
  const isCharAsset = a =>
    a.role === 'character' ||
    a.zone === 'character' ||
    (!a.role && !a.kind && charRe.test(assetKeyOf(a) + ' ' + str(a.name, 100)));
  const charKeys = new Set(uniqAssets.filter(isCharAsset).map(assetKeyOf));
  const sceneKeys = new Set(
    uniqAssets
      .filter(a => a.role === 'scene' || (!a.role && !a.kind && !isCharAsset(a)))
      .map(assetKeyOf),
  );
  const wardrobeOf = {}; // costume key → the character key it dresses ('' when unknown)
  const angleOf = {}; // derived scene key → the scene it is a view of ("of")
  const reverse = new Set(); // scenes that get the two opposing dialogue angles
  const reverseText = {}; // scene key → { a, b } angle descriptions written for that place
  const warnings = [];
  for (const a of uniqAssets) {
    const key = assetKeyOf(a);
    if (!key) continue;
    const id = nid();
    assetId[key] = id;
    // Item (prop/vật dụng) → Trang phục & vật dụng column, rendered on its own as a
    // 3-angle object sheet; costume → same column, rendered FROM its character's image;
    // character → Nhân vật; scenes → Bối cảnh. A prop is an object, never a location, so
    // role:"prop" is treated exactly like an item (the LLM often writes "prop", not "item").
    const isItem = a.role === 'item' || a.role === 'prop' || a.kind === 'item';
    const isWardrobe =
      !isItem && (a.role === 'wardrobe' || a.zone === 'wardrobe' || a.kind === 'costume');
    const isChar = !isItem && !isWardrobe && isCharAsset(a);
    // A scene with "of" is another camera position of that scene (rendered from its image).
    const isScene = !isItem && !isWardrobe && !isChar;
    const sceneUses = arr(a.uses).map(k => str(k, 100));
    const ofKey = isScene
      ? str(a.of || a.master || a.parent, 100) || sceneUses.find(k => sceneKeys.has(k)) || ''
      : '';
    if (ofKey) angleOf[key] = ofKey;
    // A plain location shows all THREE shot sizes — wide + close A + close B — in ONE
    // reference image (a location model sheet, like the character turnaround), rendered once
    // (`sheet3`). reverse_angles:{ a, b } (or true) instead splits them into SEPARATE angle
    // plates, each its own node/render, for over-the-shoulder coverage shots that wire one
    // side; reverse_angles:false (or 'none' / 'off') keeps just the plain wide (for an insert
    // or flashback). A derived angle (it has an "of") is always its own single view.
    const rev = a.reverse_angles ?? a.angles;
    const wantsReverse = rev === true || rev === 'ab' || (rev && typeof rev === 'object');
    const optOutAngles = isScene && !ofKey && (rev === false || rev === 'none' || rev === 'off');
    // The 3-in-1 sheet is the default for a plain scene; a Bible round-trips the opt-out via
    // `noAngles` (it carries no angle children to suppress the sheet otherwise).
    const sheet3 = isScene && !ofKey && !wantsReverse && !optOutAngles;
    if (isScene && !ofKey && wantsReverse) {
      reverse.add(key);
      if (rev && typeof rev === 'object')
        reverseText[key] = { a: str(rev.a, 2000), b: str(rev.b, 2000) };
    }
    if (isWardrobe) {
      // The character this look dresses: "for" / "character" (spec), else the first
      // character key in the costume's own "uses" list.
      const uses = arr(a.uses).map(k => str(k, 100));
      wardrobeOf[key] =
        str(a.for || a.character || a.characterKey || a.of, 100) ||
        uses.find(k => charKeys.has(k)) ||
        '';
    }
    const items = Array.isArray(a.items) ? a.items.join(', ') : a.items;
    nodes.push({
      id,
      zone: isWardrobe || isItem ? 'wardrobe' : isChar ? 'character' : 'design',
      // A master scene carries role:'scene' so the tool owns its reference sheet (prompts.mjs
      // keys the location sheet off role==='scene', and the inspector lets its desc be edited);
      // a derived view takes role:'angle' via the ofKey spread below.
      role: isWardrobe
        ? 'wardrobe'
        : isItem
          ? 'prop'
          : isChar
            ? 'character'
            : isScene && !ofKey
              ? 'scene'
              : undefined,
      assetKey: key, // stable id across sequences → lets the project reuse its image
      name: str(a.name || key, 100),
      // An item's / outfit's / location's blueprint prompt describes the object, garment or
      // place, so it becomes the DESCRIPTION the server wraps in its own reference sheet (a
      // prop turnaround, a headless-mannequin outfit turnaround, or a 3-view location sheet)
      // instead of replacing that sheet — so props, clothing and scenes always come out as the
      // tool's clean references. A derived angle (isScene && ofKey) keeps its own prompt.
      prompt: isItem || isWardrobe || (isScene && !ofKey) ? '' : str(a.prompt),
      ...(isItem || (isScene && !ofKey) ? { desc: str(a.prompt, 2000) } : {}),
      // Physical anchors identify the person to the video model (the prompt's "@key" tags
      // mean nothing to it): the server lists them per reference image, in order.
      ...(isChar && arr(a.physical_anchors).length
        ? { anchors: str(arr(a.physical_anchors).join(', '), 1000) }
        : {}),
      ...(isChar && voiceOf(a.voice_profile) ? { voice: voiceOf(a.voice_profile) } : {}),
      // Code (NV1, NV2…): what the prompt calls this person. Real names raise the odds
      // of the video model refusing "a real person", so they never leave the Bible.
      ...(isChar && str(a.code, 20).trim() ? { code: str(a.code, 20).trim() } : {}),
      // What an over-the-shoulder frame may call this person ("the auburn-haired woman")
      // and what the camera sees of them from behind — the only two things those stills
      // say about a face the attached sheet already shows.
      ...(str(a.identity_label, 200).trim() ? { label: str(a.identity_label, 200).trim() } : {}),
      ...(str(a.back_view, 500).trim() ? { back: str(a.back_view, 500).trim() } : {}),
      // Where the two speakers stand in this location, and the light on each side: a merged
      // scene builds every one of its camera setups from it.
      ...(stagingOf(a.conversation) ? { staging: stagingOf(a.conversation) } : {}),
      ...(sheet3 ? { sheet3: true } : {}),
      ...(optOutAngles ? { noAngles: true } : {}),
      ...(ofKey ? { role: 'angle', ofKey, angle: str(a.angle || a.prompt, 2000) } : {}),
      ...(isWardrobe
        ? { outfit: str(a.outfit || a.wardrobe || a.prompt, 2000), items: str(items, 2000) }
        : {}),
      videoPrompt: '',
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
  }
  // The costume node renders the GARMENT alone (on a mannequin), so it takes no image
  // input — feeding it the person only invites the model to redraw them. It just records
  // which character it dresses; the "NV đã mặc" node below does the try-on.
  for (const [w, c] of Object.entries(wardrobeOf)) {
    if (c && assetId[c]) {
      const node = nodes.find(n => n.id === assetId[w]);
      node.charId = assetId[c];
    } else
      warnings.push(
        `Trang phục "${w}": ` +
          (c ? `nhân vật "${c}" không có trong Bible` : 'thiếu "for" trỏ nhân vật') +
          ' — không dựng được node "NV đã mặc", cảnh sẽ thiếu look này.',
      );
  }
  // Two-stage dressing (virtual try-on). The costume node renders the OUTFIT with its own
  // prompt (a garment on a mannequin is fine); a "look" node then composes character +
  // costume into that same person wearing the outfit, with a prompt the tool controls.
  // Shots use the look, never the raw costume, so Veo always sees a complete, face-locked
  // reference.
  const lookId = {}; // costume key → look node id
  const lookChar = {}; // look node id → its character's node id (for placement)
  for (const [w, c] of Object.entries(wardrobeOf)) {
    if (!c || !assetId[c]) continue;
    const id = nid();
    lookId[w] = id;
    lookChar[id] = assetId[c];
    const costumeName = nodes.find(n => n.id === assetId[w])?.name || w;
    nodes.push({
      id,
      zone: 'character', // a dressed version of the character: Nhân vật column, under them
      role: 'look',
      assetKey: 'look_' + w,
      name: str('NV đã mặc: ' + costumeName, 100),
      prompt: '',
      videoPrompt: '',
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
    edges.push({ source: assetId[c], target: id }); // the face
    edges.push({ source: assetId[w], target: id }); // the outfit
  }
  // Order within a column follows the node list, so slot each look right after its
  // character (and after that character's earlier looks).
  for (const id of Object.values(lookId)) {
    const look = nodes.splice(
      nodes.findIndex(n => n.id === id),
      1,
    )[0];
    let at = nodes.findIndex(n => n.id === lookChar[id]);
    while (nodes[at + 1]?.role === 'look' && lookChar[nodes[at + 1].id] === lookChar[id]) at++;
    nodes.splice(at + 1, 0, look);
  }
  // Scene angles: a scene declared with "of": "<scene>" (+ "angle": what this camera sees)
  // is a derived view of that scene, rendered FROM its image so every angle shows the same
  // place, dressing and light (anti "the room changes between shot sizes").
  const angleMaster = {}; // angle node id → its scene's node id (for wiring + placement)
  for (const [k, of] of Object.entries(angleOf)) {
    const node = nodes.find(n => n.id === assetId[k]);
    const master = nodes.find(n => n.id === assetId[of]);
    if (master && !['character', 'wardrobe', 'prop'].includes(master.role)) {
      edges.push({ source: master.id, target: node.id });
      angleMaster[node.id] = master.id;
      // A scene that has its own separate angle plates is no longer the 3-in-1 sheet: it is a
      // plain wide, and each derived angle renders from that clean wide (not from a sheet). This
      // also round-trips an opt-in: a Bible exports the angles as `of` children, and re-ingesting
      // them drops the master back to a plain wide here instead of letting it default to a sheet.
      if (master.sheet3) delete master.sheet3;
    } else {
      warnings.push(
        `Bối cảnh "${k}": "of" trỏ tới "${of}" không phải bối cảnh trong Bible — giữ như bối cảnh thường.`,
      );
      delete node.role;
      delete node.ofKey;
    }
  }
  // Dialogue locations: two opposing close angles (what camera OTS A sees / what OTS B
  // sees), derived from the scene. A shot that names the scene with an OTS camera is wired
  // to the matching side below; explicit "<key>_a" / "<key>_b" in uses work too.
  const reverseId = {}; // scene key → { a: node id, b: node id }
  for (const k of reverse) {
    const master = nodes.find(n => n.id === assetId[k]);
    if (!master) continue;
    reverseId[k] = {};
    for (const side of ['a', 'b']) {
      const key = `${k}_${side}`;
      if (!assetId[key]) {
        const id = nid();
        assetId[key] = id;
        nodes.push({
          id,
          zone: 'design',
          role: 'angle',
          assetKey: key,
          ofKey: k,
          preset: side,
          name: str(`${master.name} — ${ANGLE_PRESETS[side].name}`, 100),
          angle: reverseText[k]?.[side] || ANGLE_PRESETS[side].angle,
          prompt: '',
          videoPrompt: '',
          image: null,
          video: null,
          outputNaming: { ...defaultNaming },
        });
        edges.push({ source: master.id, target: id });
        angleMaster[id] = master.id;
      }
      reverseId[k][side] = assetId[key];
    }
  }
  // An angle sits right under its scene (after that scene's earlier angles), like a look.
  for (const id of Object.keys(angleMaster)) {
    const angle = nodes.splice(
      nodes.findIndex(n => n.id === id),
      1,
    )[0];
    let at = nodes.findIndex(n => n.id === angleMaster[id]);
    while (nodes[at + 1]?.role === 'angle' && angleMaster[nodes[at + 1].id] === angleMaster[id])
      at++;
    nodes.splice(at + 1, 0, angle);
  }
  for (const c of uniqCameras) {
    const key = str(c.key || c.id || c.name, 100);
    if (!key) continue;
    const id = nid();
    camId[key] = id;
    nodes.push({
      id,
      kind: 'setting',
      settingType: 'camera',
      zone: 'setup',
      name: str(c.name || key, 100),
      config: str(c.config || c.prompt, 5000),
    });
  }

  for (const a of uniqAudio) {
    const key = str(a.key || a.id || a.name, 100);
    const config = str(a.config || a.prompt || a.sound, 5000);
    if (!key || !config.trim()) continue;
    const id = nid();
    audioId[key] = id;
    nodes.push({
      id,
      kind: 'setting',
      settingType: 'audio',
      zone: 'audio',
      name: str(a.name || key, 100),
      config,
    });
  }

  shots.forEach((sh, i) => {
    const id = nid();
    const dur = Number(sh.duration);
    // Everything the shot connects to: the "uses" list (drama blueprints list the camera +
    // style keys there too) plus the scalar "camera" / "style" keys.
    const uses = Array.isArray(sh.uses) ? sh.uses : [];
    const outfits = Array.isArray(sh.wardrobe) ? sh.wardrobe : [sh.wardrobe];
    const keys = [
      ...new Set(
        [...uses, sh.camera, sh.style, sh.audio, sh.sound, ...outfits]
          .map(k => str(k, 100))
          .filter(Boolean),
      ),
    ];
    const camWired = keys.some(k => camId[k]);
    // A shot that names no style gets the blueprint's only style (music blueprints).
    if (!keys.some(k => styleId[k]) && Object.keys(styleId).length === 1)
      keys.push(Object.keys(styleId)[0]);
    // …same for a lone audio preset: one sound bed for the whole piece.
    if (!keys.some(k => audioId[k]) && Object.keys(audioId).length === 1)
      keys.push(Object.keys(audioId)[0]);
    // A shot written as 2–3 camera setups of one conversation ("setups") is a merged scene:
    // a frame node per setup in the production column, all wired into one node in the
    // "Phân cảnh ghép" column that films them as a single 8-second Veo clip.
    if (arr(sh.setups).length >= 2) {
      buildMerged(sh, i, keys);
      return;
    }
    // One setup alone is just a shot: keep its line and say so.
    if (arr(sh.setups).length === 1) {
      const s0 = sh.setups[0] && typeof sh.setups[0] === 'object' ? sh.setups[0] : {};
      warnings.push(
        `${str(sh.name || 'Shot ' + (i + 1), 100)}: "setups" cần 2–3 cỡ cảnh — dựng như shot thường.`,
      );
      sh = {
        ...sh,
        dialogue: sh.dialogue ?? s0.dialogue,
        audio_delivery: sh.audio_delivery ?? s0.audio_delivery,
      };
    }
    // Music: strip the baked "Camera:/Style:" tail so the wired setting nodes are the source.
    // Drama: keep the VEO prompt, minus its inline camera sentence once a camera node is wired.
    const base = isDrama
      ? camWired
        ? stripInlineCamera(str(sh.videoPrompt))
        : str(sh.videoPrompt)
      : baseShotPrompt(sh);
    nodes.push({
      id,
      zone: 'production',
      name: str(sh.name || 'Shot ' + (i + 1), 100),
      prompt: str(sh.prompt) || base,
      videoPrompt: str(sh.videoPrompt) ? base : '',
      // Drama shots carry a spoken line in "dialogue"; music shots in "lyric".
      lyric: str(sh.lyric ?? sh.dialogue, 5000),
      audioDelivery: str(sh.audio_delivery, 500), // modulates the speaker's voice_profile
      start: Number.isFinite(Number(sh.start)) ? Number(sh.start) : i * 8,
      duration: Number.isFinite(dur) && dur > 0 ? dur : 8,
      videoInput: 'refs', // a storyboard shot is driven by the connected asset images
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
    // Wire the shot to each asset, camera and style it names (edge order = prompt order:
    // reference images first, then "Camera: …", then "Style: …"). A shot that uses a
    // wardrobe gets that image INSTEAD of the bare character: same face, the right
    // costume, and one fewer reference image to spend.
    const dressed = new Set(keys.map(k => wardrobeOf[k]).filter(Boolean));
    // An over-shoulder camera on a scene that has reverse angles → that side's plate.
    const camKey = keys.find(k => camId[k]) || str(sh.camera, 100);
    const side = otsSide(uniqCameras.find(c => str(c.key || c.id || c.name, 100) === camKey));
    // One look per person: two costumes of the same character in one shot would make
    // VEO mix the outfits — keep both wires (we cannot pick) but say so.
    const looks = {};
    for (const k of keys)
      if (wardrobeOf[k]) {
        const c = wardrobeOf[k];
        if (looks[c])
          warnings.push(
            `${str(sh.name || 'Shot ' + (i + 1), 100)}: nhân vật "${c}" có 2 bộ trang phục (${looks[c]}, ${k}) — giữ một bộ để Veo không mặc lẫn.`,
          );
        looks[c] = k;
      }
    for (const k of keys) {
      if (dressed.has(k)) continue;
      // A costume key resolves to its look node (the dressed character), when it has one.
      const src =
        (side && reverseId[k]?.[side]) ||
        lookId[k] ||
        assetId[k] ||
        camId[k] ||
        styleId[k] ||
        audioId[k];
      if (src) edges.push({ source: src, target: id });
    }
  });

  // One shot written as 2–3 camera setups of the same conversation. Each setup becomes a
  // frame node (its own still, built from the location + the two character sheets); all of
  // them wire into a merged node that films them as one 8-second Veo clip with a hard cut
  // at each timecode. See lib/merged.mjs and Veo-shot-notes.md, sections 3–6.
  function buildMerged(sh, i, keys) {
    const shotName = str(sh.name || 'Shot ' + (i + 1), 100);
    const warn = msg => warnings.push(`${shotName}: ${msg}`);
    const setups = arr(sh.setups).slice(0, 3);
    if (arr(sh.setups).length > 3) warn('Veo nhận tối đa 3 ảnh — chỉ lấy 3 cỡ cảnh đầu.');
    // The people in frame, each as ONE node: the look when this shot dresses them in a
    // costume (the bare character stays out then, as in a normal shot), else the character.
    const nodeFor = {}; // character key → the node that stands for them in this shot
    const people = []; // character keys, in the order "uses" names them
    for (const k of keys) {
      const c = wardrobeOf[k] && lookId[k] ? wardrobeOf[k] : charKeys.has(k) ? k : '';
      if (!c) continue;
      if (!people.includes(c)) people.push(c);
      if (!nodeFor[c] || lookId[k]) nodeFor[c] = lookId[k] || assetId[c];
    }
    // "sides" says who stands where (a character key, or the costume they wear here);
    // without it, the order they appear in "uses" decides.
    const sides = sh.sides && typeof sh.sides === 'object' ? sh.sides : {};
    const sideKey = v => {
      const k = str(v, 100);
      return k && wardrobeOf[k] && lookId[k] ? wardrobeOf[k] : k;
    };
    let leftKey = sideKey(sides.left),
      rightKey = sideKey(sides.right);
    if (leftKey && !nodeFor[leftKey]) {
      warn(`"sides.left" (${leftKey}) không có trong "uses" của shot.`);
      leftKey = '';
    }
    if (rightKey && !nodeFor[rightKey]) {
      warn(`"sides.right" (${rightKey}) không có trong "uses" của shot.`);
      rightKey = '';
    }
    if (leftKey && leftKey === rightKey) {
      warn(`"sides" trái và phải cùng một người (${leftKey}).`);
      rightKey = '';
    }
    leftKey = leftKey || people.find(k => k !== rightKey) || '';
    rightKey = rightKey || people.find(k => k !== leftKey) || '';
    const extra = people.filter(k => k !== leftKey && k !== rightKey);
    if (extra.length)
      warn(`phân cảnh ghép chỉ lấy 2 người (${leftKey}, ${rightKey}); bỏ: ${extra.join(', ')}.`);
    const left = nodeFor[leftKey],
      right = nodeFor[rightKey];
    if (!left || !right)
      warn('phân cảnh ghép cần đúng 2 nhân vật — khai "sides": {"left": …, "right": …}.');
    // The location image the frames are built from. Prefer the scene that carries the
    // conversation staging (lib/merged.mjs reads it from the frame's own scene parent); it
    // may sit on an angle the shot lists in `uses` or on the master it is a view of, so walk
    // each candidate's `of`-chain and pick the first with staging, else the master view.
    const sceneNode = k => nodes.find(n => n.id === assetId[k]);
    const ofChain = k => {
      const out = [];
      let c = k,
        seen = new Set();
      while (c && !seen.has(c)) {
        out.push(c);
        seen.add(c);
        c = angleOf[c] || sceneNode(c)?.ofKey;
      }
      return out;
    };
    const candidates = [str(sh.place, 100), ...keys.filter(k => sceneKeys.has(k))]
      .filter(Boolean)
      .flatMap(ofChain);
    const placeKey = candidates.find(k => sceneNode(k)?.staging) || candidates[0] || '';
    const place = placeKey && assetId[placeKey];
    if (!place)
      warn('không tìm thấy node bối cảnh cho phân cảnh ghép (khai "place" hoặc trong "uses").');
    const start = Number.isFinite(Number(sh.start)) ? Number(sh.start) : i * 8;
    const mergedId = nid();
    nodes.push({
      id: mergedId,
      zone: 'merged',
      role: 'merged',
      name: shotName,
      prompt: '',
      videoPrompt: '', // the tool composes the cut list from the frames
      lyric: '',
      audioDelivery: str(sh.audio_delivery, 500),
      start,
      duration: 8, // a Veo clip is always 8 seconds
      videoInput: 'refs', // the frames are the reference images
      image: null,
      video: null,
      outputNaming: { ...defaultNaming },
    });
    // Style and sound presets go on the merged node: they belong to the clip, not to a still.
    for (const k of keys) {
      const src = styleId[k] || audioId[k];
      if (src) edges.push({ source: src, target: mergedId });
    }
    setups.forEach((s, k) => {
      const framing = FRAMINGS.includes(str(s.framing, 20)) ? str(s.framing, 20) : '';
      if (!framing) warn(`cỡ cảnh "${str(s.framing, 20)}" không hợp lệ (ots_a, ots_b, two_shot).`);
      const suffix = ` · ${k + 1}${FRAMING_LABEL[framing] ? ' ' + FRAMING_LABEL[framing] : ''}`;
      const frameId = nid();
      nodes.push({
        id: frameId,
        zone: 'production',
        role: 'frame',
        frameNo: k + 1,
        framing: framing || 'two_shot',
        name: shotName.slice(0, 100 - suffix.length) + suffix,
        prompt: str(s.prompt), // empty: built from the location + the two sheets
        videoPrompt: '',
        lyric: str(s.dialogue ?? s.lyric, 5000),
        audioDelivery: str(s.audio_delivery, 500),
        frameAction: str(s.action, 500), // "takes one step toward NV1"
        start, // keeps the frames beside their scene when the column is arranged by time
        image: null,
        video: null,
        outputNaming: { ...defaultNaming },
      });
      // Wire order IS the image order the still prompt names: [1] place, [2] left, [3] right.
      for (const src of [place, left, right]) if (src) edges.push({ source: src, target: frameId });
      edges.push({ source: frameId, target: mergedId });
    });
  }

  if (nodes.length > 200)
    throw new Error(`Blueprint quá lớn (${nodes.length} node > 200). Giảm số asset/shot.`);

  // Drop duplicate edges.
  const seen = new Set();
  const uniqueEdges = edges.filter(e => {
    const k = e.source + '>' + e.target;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    nodes,
    edges: uniqueEdges,
    name: b.project?.name || b.project?.title ? str(b.project.name || b.project.title, 100) : null,
    theme: b.project?.theme || (isDrama ? 'film' : null),
    film: str(typeof film === 'string' ? film : film?.title, 200).trim() || null,
    warnings, // non-fatal wiring problems, surfaced to the user after the build
  };
}
