# Lỗi AI hay mắc khi dựng Drama VEO & cách phòng

Đọc trước khi giao blueprint. Mỗi lỗi kèm triệu chứng và cách chặn.

## 1. Vỡ trục 180 độ (hội thoại hỏng)
**Triệu chứng:** hai người đối thoại trong các shot cắt luân phiên lại cùng nhìn một hướng → trông như không nói với nhau.
**Chặn:** mọi cặp đối thoại khai `axis_180` rõ hướng nhìn từng người; các shot reverse phải ngược hướng khớp nhau (A phải→trái thì B trái→phải). Máy chỉ ở một bên đường trục.

## 2. Tả lại diện mạo trong videoPrompt (dựng lại người mới)
**Triệu chứng:** mặt/tóc/trang phục nhân vật đổi giữa các shot.
**Chặn:** mặt + trang phục chính khóa ở model sheet nhân vật; look khác khóa ở node costume (render lại người mặc đồ mới). Trong `videoPrompt` tuyệt đối không tả lại quần áo/tóc/khuôn mặt; chỉ tham chiếu @nhân vật và tả hành động + biểu cảm + máy + ánh sáng. Khi cần nhắc đặc điểm, dùng ngắn gọn từ `physical_anchors`.

## 3. Bối cảnh đổi hình giữa các cỡ máy
**Triệu chứng:** căn phòng, cầu thang, quầy bar khác nhau giữa shot.
**Chặn:** luôn `uses` đúng góc neo (`scene_sub_table`, `scene_sub_stairs`...) thay vì tả phòng mới trong từng shot; giữ `lighting_profile` nhất quán và nhắc lại trong phần Lighting & Physics.

## 4. Đạo cụ biến dạng
**Triệu chứng:** điện thoại/nhẫn/ly đổi kiểu giữa cảnh.
**Chặn:** khai đạo cụ trong nhóm `wardrobe` với `kind:"item"` kèm `continuity_note`; tham chiếu @prop_key trong shot thay vì mô tả lại.

## 5. Giọng nói nhảy giữa các shot
**Triệu chứng:** chất giọng/ngữ điệu một nhân vật đổi giữa đoạn.
**Chặn:** `voice_profile` là nguồn chân lý; `audio_delivery` chỉ điều biến (vd "thì thầm", "gấp gáp") chứ không định nghĩa lại giọng.

## 6. Nhịp phẳng (chuỗi clip rời, không ra phim)
**Triệu chứng:** các shot đều đều một cường độ, không có cao trào.
**Chặn:** gán `beat` + `emotional_value` cho từng shot; kiểm chuỗi emotional_value có đường leo rồi đổ. Cảnh căng → shot ngắn + shot-reverse-shot; reveal → slow push-in; aftermath → shot dài, khoảng lặng.

## 7. Lệch phân bổ thời lượng
**Triệu chứng:** dồn quá nhiều giây vào setup, cao trào qua loa.
**Chặn:** đối chiếu tổng duration mỗi nhịp với tỉ lệ beat_sheet (~15/35/25/15/10). Confrontation + Reveal phải đủ sức nặng.

## 8. JSON hỏng cú pháp
**Triệu chứng:** VEO/công cụ không parse được.
**Chặn:** kiểm dấu phẩy, ngoặc; escape dấu nháy kép trong thoại tiếng Việt (\\"); không để lời dẫn lọt vào trong khối JSON.

## 9. Thoại "kịch" quá / không đời
**Triệu chứng:** nhân vật nói như đọc khẩu hiệu.
**Chặn:** ưu tiên subtext — miệng nói một đằng, cơ thể nói một nẻo (ghi ở `internal_subtext`). Để khoảng lặng và hành động vi mô gánh cảm xúc, không nhồi thoại giải thích.

## 11. Mặc lẫn trang phục / nhân vật mặc sai đồ
**Triệu chứng:** nhân vật mặc nhầm bộ của người khác, hoặc trộn hai bộ trong một cảnh.
**Chặn:** mỗi người trong một cảnh chỉ một look — hoặc nối thẳng **nhân vật gốc** (look chính), hoặc **một node costume** của họ (look khác), KHÔNG đưa cả hai, KHÔNG hai costume cùng người. Node costume phải có input là nhân vật (`uses:[nhân vật]`) và render lại người đó mặc đồ mới; cảnh chỉ nhận look hoàn chỉnh, không nhận "ảnh mặt" + "ảnh đồ" rời. Validator `--bible` bắt các vi phạm này.

## 12. Veo chặn "nghi là người nổi tiếng" (false-positive)
**Triệu chứng:** Veo báo không tạo được vì ảnh/nhân vật giống người nổi tiếng, dù nhân vật do AI tạo.
**Chặn:** mọi model sheet + costume + style + đuôi videoPrompt phải mang **nhãn hư cấu**: "original fictional AI-generated character, not a real person and not resembling any celebrity, public figure or existing model; any resemblance is coincidental". Không nêu tên người thật, không "looks like [tên]", không "celebrity/supermodel"; không nạp ảnh người thật/tạp chí/model stock làm reference. Nếu vẫn bị chặn: bật `person_generation=allow_adult` khi gọi API hoặc xin allowlist realistic-person-likeness của Vertex. Tránh "pills/prescription", từ trẻ em, vũ khí/bạo lực đồ hoạ. (Chi tiết: SKILL mục "Tuân thủ Veo".)

## 13. Góc phân cảnh render GIỐNG HỆT cảnh chính
**Triệu chứng:** node góc (scene_X_a/_b) ra ảnh na ná bối cảnh chính, không thấy khác góc.
**Nguyên nhân:** prompt góc nhấn "same location / keep consistent" nhưng thiếu mô tả bố cục khác → model lấy ảnh chính làm reference rồi tái tạo gần y hệt.
**Chặn:** prompt góc = **một setup máy KHÁC HẲN** — nêu rõ *vị trí máy, hướng nhìn, tiền cảnh, hậu cảnh, cỡ cảnh*; thêm "composition clearly DISTINCT from the master and from the other angle"; góc A/B là hai hướng NGƯỢC của trục 180 (tiền/hậu cảnh đảo chỗ). Ảnh chính chỉ khóa kiến trúc + ánh sáng. Về phía tool: khi render góc, dùng ảnh chính như reference NHẸ (giảm reference weight / tăng mức sáng tạo) để không copy nguyên bố cục.

## 14. Cụm đối thoại: người nói ở sai bên, thoại quá dài, thứ tự chưa test
**Triệu chứng:** clip cắt cảnh đúng nhưng Veo lip-sync nhầm người (người quay lưng "nói"), hoặc thoại bị nói dồn/nuốt chữ, hoặc trung đôi mở đầu ra hai người đứng lệch so với hai khung qua vai.
**Chặn:** `ots_a` = người **bên phải** nói, `ots_b` = người **bên trái** nói — đổi cỡ cảnh chứ không đổi `sides` giữa cụm; mỗi câu ≤ 3 từ/giây (2 setups: ≤ 8–10 từ/câu; 3 setups: ≤ 6–8 từ, câu giữa 1–3 từ); thứ tự đã test là A → B và A → B → trung đôi (trung đôi làm nhịp kết). Tên người nói phải là một trong hai người của cụm. Chạy `validate_blueprint.py`: nó báo đúng setup nào sai.

## 10. Bản địa hóa sai
**Triệu chứng:** biệt thự Việt trông như set phim Mỹ, tên nhân vật lệch văn hóa.
**Chặn:** bám Bước 0 — tên, ngôn ngữ, kiến trúc, nội thất, phong thái đúng quốc gia chỉ định.

## Canh im lang bi VEO tu them thoai / nhac
**Triệu chứng:** shot chỉ có hành động (đặt hoa, rót trà, nhìn qua cửa sổ) nhưng clip ra lại có người lẩm bẩm, tiếng đám đông, hoặc một bản nhạc piano tự chế.
**Nguyên nhân:** prompt không nói gì về âm thanh, VEO tự lấp khoảng trống; hoặc `videoPrompt` lỡ viết "she says", "a whisper is heard".
**Chặn:** `dialogue` ghi `[Không thoại; …]`, `audio_delivery` tả tiếng hiện trường bằng tiếng Anh, và khai `audio[]` + `shot.audio` cho nhạc nền. Tool tự thêm "No spoken dialogue in this shot… location sound only… no added music, no voice-over, no narration". Trong `videoPrompt` của shot im lặng tuyệt đối không có động từ nói.
