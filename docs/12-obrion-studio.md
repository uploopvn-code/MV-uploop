# OBRION trong Đạo diễn

Mở **Đạo diễn → OBRION · Xưởng kịch bản & phân cảnh**. Lấy kịch bản ở bước 1 hoặc nhập `.txt`, nhập Asset Bible và quy tắc camera/diễn xuất, rồi bấm **Phân cảnh với OBRION**. Mỗi lần chạy có nhiều lượt gọi API tính phí theo nhà cung cấp. UI dùng cấu hình OpenAI-compatible đã lưu ở Đạo diễn; OBRION chưa dùng extension ChatGPT. CLI hỗ trợ OpenAI và Anthropic.

## Cài đặt

Python 3.10+ (khuyến nghị 3.12). Tại thư mục dự án trên Windows:

```powershell
py -3.12 -m venv obrion/.venv
obrion/.venv/Scripts/python.exe -m pip install -r obrion/requirements.txt
npm start
```

Nếu Python không có `ensurepip`, có thể dùng `uv --no-cache pip install --python obrion/.venv/Scripts/python.exe -r obrion/requirements.txt`.
Server ưu tiên `OBRION_PYTHON`, sau đó `obrion/.venv`, cuối cùng `py -3.12` trên Windows / `python3` trên Linux. Bấm **Kiểm tra Python** để kiểm tra thư viện. Khóa API chỉ được truyền sang tiến trình Python qua stdin, không đưa vào lệnh hay JSON tải về.

## Đầu vào và duyệt kết quả

Nhập kịch bản thô tối đa 100000 ký tự và Bible dạng object. Ví dụ Bible tối thiểu:

```json
{
  "characters": [{"key": "ami", "description": "Ami, phi công mặc flight suit màu xám"}],
  "scenes": [{"key": "hangar", "description": "Nhà chứa tàu phủ bụi sa mạc"}]
}
```

Dán nội dung tài liệu camera và cảm xúc vào hai ô quy tắc. Đây là tài liệu người dùng cung cấp, không có sẵn nội dung từ aicameramovements hoặc seedance. Bible có thể chứa các thuộc tính LoRA, URL ảnh, mỏ neo nhận diện để các agent tham chiếu.

## Quy tắc camera và diễn xuất lấy ở đâu?

Hai ô này là **nguồn chỉ đạo của đạo diễn**, không phải dữ liệu tự động lấy từ web. Chúng đi thẳng vào prompt của Agent_Cinematography và Agent_Performance. Có ba nguồn phù hợp:

1. **Gu và quy ước của chính dự án:** cách quay đối thoại, cỡ cảnh ưa dùng, giới hạn handheld, nhịp diễn, cách nhân vật thể hiện căng thẳng.
2. **Tài liệu được cấp quyền sử dụng:** sổ tay quay phim của đội ngũ, tài liệu đào tạo nội bộ hoặc trích yếu do bạn tự soạn từ nguồn tham khảo có giấy phép phù hợp.
3. **Bộ mẫu đi kèm:** [quy tắc camera](../examples/obrion-camera-rules.txt) và [quy tắc diễn xuất/FACS](../examples/obrion-emotion-rules.txt). Đây là mẫu gốc do project tạo ra, không sao chép nội dung từ aicameramovements hay seedance; hãy coi nó là điểm khởi đầu và sửa theo phim của bạn.

Không cần dán cả một bài dài. Mỗi quy tắc nên viết theo dạng **khi nào dùng → làm gì → giới hạn**, ví dụ: “Trong đối thoại căng thẳng, dùng 50mm medium và giữ trục; chỉ push-in khi nhân vật nhận ra sự thật.” Sau khi bạn sửa shot JSON và bấm **Học từ bản sửa**, các ví dụ chỉnh sửa đó mới trở thành lớp “gu đạo diễn” được truy xuất cho các lần chạy sau.

**Lưu bản nháp** giữ đầu vào trong project. Kết quả thành công tự lưu cùng bản AI gốc. Có thể sửa shot JSON rồi **Kiểm tra & lưu chỉnh sửa**. JSON buộc timeline liên tục từ 0, duration dương, end = start + duration, mã shot duy nhất và intensity trong 0..1. Tối đa 300 shot; khi chuyển sơ đồ còn chịu giới hạn 200 node hiện có, nên chia phim dài thành phân đoạn.

**Chuyển sang Blueprint bước 3** chỉ điền blueprint để duyệt. Bấm **Dựng sơ đồ** ở bước 4 mới áp dụng vào project. Nhân vật được nối bằng `generation_assets.primary_character`; bối cảnh được nối khi `scene_id` trùng key trong Bible. Camera và âm thanh được tạo riêng cho mỗi shot. JSON chi tiết gốc vẫn lưu trong OBRION.

OBRION hiện chuyển mỗi kết quả thành **shot thường**. Nếu một đoạn đối thoại ngắn cần một clip gồm nhiều góc máy, hãy sửa Blueprint trước khi dựng để dùng `setups`; xem phần [Phân cảnh ghép](#phan-canh-ghep-va-video-dau-ra) bên dưới.

**Tải OTIO** xuất timeline 24 fps có clip giữ chỗ `MissingReference`, giữ metadata shot; chưa có video được render. Import bằng phần mềm/plugin có hỗ trợ OTIO, sau đó liên kết media. Không tự tạo clip video hay audio stems thực tế.

## Workflow và trí nhớ

`graph.py` dùng LangGraph: Narrative → Cinematography → Performance → Sound → Prompt → Validator → Export_OTIO. Mỗi chuyên môn dùng LangChain `with_structured_output` và Pydantic. Schema lỗi quay về đúng chuyên môn; lỗi toàn timeline quay lại Narrative, chạy lại các bước phụ thuộc. Ngân sách chung tối đa 3 lần sửa, sau đó trả lỗi và không xuất kết quả không hợp lệ.

**Học từ bản sửa** so sánh theo `shot_id` với bản AI gốc, chỉ lưu shot thực sự thay đổi, không lưu lại cặp trùng. Bộ nhớ SQLite ở `<MV_DATA_DIR>/director_memory.sqlite3` dùng chung giữa project. Mỗi chuyên môn lấy tối đa 3 ví dụ theo độ trùng từ và trường đã sửa, đưa vào prompt. Đây là truy xuất ví dụ, không phải huấn luyện model hay bảo đảm bắt chước hoàn toàn gu đạo diễn. Shot mới/xóa không được dùng làm ví dụ chỉnh sửa.

Trong lúc chạy nên giữ nguyên project. Server chặn lưu kết quả vào project khác nếu bạn chuyển project; lỗi này không ghi đè kết quả cũ. Tiến trình có giới hạn 30 phút. Khởi động lại server sẽ hủy lượt chạy hiện tại.

## Ghi chú module OBRION

| Thành phần | Vai trò |
| --- | --- |
| Panel OBRION trong Đạo diễn | Nhập/lưu script, Bible và rule theo từng project; xem/sửa shot JSON; tải JSON/OTIO; chuyển sang Blueprint để bạn duyệt. |
| `obrion/models.py` | Hợp đồng Pydantic cho shot, timecode, camera, diễn xuất và âm thanh. Chặn timeline sai, ID trùng và intensity ngoài 0–1. |
| `obrion/graph.py` | LangGraph: Narrative → Cinematography → Performance → Sound → Prompt → Validator → Export_OTIO. Lỗi quay về agent gây lỗi, tối đa 3 lần. |
| `obrion/memory.py` + `ingest_feedback.py` | SQLite lưu cặp AI gốc/bản đạo diễn sửa, bỏ dữ liệu trùng, lấy tối đa ba ví dụ liên quan cho từng chuyên môn. |
| `obrion/export.py` | Xuất OTIO 24 fps với `MissingReference` và metadata đầy đủ cho từng shot. |
| `lib/routes/obrion.mjs` | Cầu nối UI–Python, giữ kết quả theo project và không cho kết quả của project cũ ghi sang project mới. |
| `lib/obrion.mjs` | Gọi Python bằng stdin, không đưa API key vào lệnh; chuyển output OBRION thành blueprint hiện có. |

Module không tạo video hay audio thật. Sau khi blueprint được duyệt và dựng sơ đồ, pipeline render hiện có của Drama Tool mới tạo asset/video.

## Phân cảnh ghép và Video đầu ra

Trên canvas, **⑦ Phân cảnh ghép** không phải là nơi chứa video cuối. Nó nhận 2–3 ảnh khung của cùng một cuộc đối thoại và gửi chúng cùng prompt cắt cảnh vào một lần render Seedvis/Veo. Kết quả clip 8 giây xuất hiện ở **⑧ Video đầu ra**.

Dùng phân cảnh ghép khi cả đoạn đáp ứng các điều kiện sau:

- Chỉ có hai nhân vật, một bối cảnh, cùng trang phục và ánh sáng.
- Có 2–3 câu thoại/hành động ngắn cần cắt qua lại giữa hai người.
- Bạn muốn model giữ liền mạch diễn xuất qua các góc trong một clip 8 giây.

Không dùng nó cho insert đạo cụ, hành động kéo dài, đổi bối cảnh, hơn hai người, hoặc khi cần kiểm soát từng góc/từng clip riêng. Khi đó dùng các shot thường ở cột ⑥.

Để dùng qua Blueprint, một shot cần `setups` gồm đúng 2 hoặc 3 góc không trùng: `ots_a`, `ots_b`, `two_shot`. Thứ tự mảng là thứ tự cắt. Tool tự tạo ảnh khung ở cột ⑥; tạo ảnh cho từng khung trước, sau đó mở node ở cột ⑦ và bấm **Tạo video**. Khung không quay thành video riêng. Với hai setup, mỗi góc có khoảng 4 giây; với ba setup, thời lượng chia theo độ dài câu thoại, tối thiểu 2 giây mỗi góc.

Ví dụ cấu trúc rút gọn:

```json
{
  "name": "Ami và Ken ở nhà chứa tàu",
  "start": 12,
  "uses": ["ami", "ken", "abandoned_hangar_night"],
  "sides": {"left": "ami", "right": "ken"},
  "setups": [
    {"framing": "ots_a", "dialogue": "Ken: \"Nó đã quét số serial chưa?\""},
    {"framing": "ots_b", "dialogue": "Ami: \"Chưa. Nhưng chúng biết tôi có nó.\""},
    {"framing": "two_shot", "dialogue": "Ken: \"Giấu nó đi.\""}
  ]
}
```

`ots_a` nhìn người bên phải qua vai người bên trái; `ots_b` là góc ngược lại; `two_shot` giữ cả hai người. Bối cảnh phải có dữ liệu `conversation` đầy đủ, nhân vật cần `code`, `identity_label` và `back_view`, vì hệ thống dùng các dữ liệu này để tạo ảnh keyframe ổn định. Hướng dẫn đầy đủ và contract Blueprint nằm trong [README, mục Phân cảnh ghép](../README.md#phân-cảnh-ghép-2–3-cỡ-cảnh-của-một-hội-thoại-trong-một-clip-veo).

## CLI

```powershell
$env:OPENAI_API_KEY = "your-key"
obrion/.venv/Scripts/python.exe obrion/main.py --script input_script.txt --bible obrion-master-bible.json --camera-rules camera_rules.txt --emotion-rules emotion_rules.txt --output obrion-output
obrion/.venv/Scripts/python.exe obrion/ingest_feedback.py obrion-output/shots.json corrected.json --memory director_memory.sqlite3
```

Dùng `--provider anthropic --model <model-id>` với `ANTHROPIC_API_KEY` để chạy Anthropic. `--memory` chọn file nhớ, cần thư mục cha đã tồn tại. CLI mặc định dùng bộ nhớ trong thư mục hiện hành; chỉ định đường dẫn bộ nhớ của app nếu muốn dùng chung. Log từng node ra stderr; đầu ra `shots.json` và `timeline.otio` trong thư mục `--output`.

## Kiểm tra

```powershell
obrion/.venv/Scripts/python.exe -m unittest discover -s obrion -p "test_*.py" -v
node test-obrion.mjs
```

Kiểm tra không gọi API tính phí: dùng dữ liệu giả lập cho agent, chạy LangGraph và OTIO thật. Tham khảo API chính thức: [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api), [OpenTimelineIO](https://opentimelineio.readthedocs.io/en/latest/).
