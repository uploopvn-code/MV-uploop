# MV Director — bản thử nghiệm local

Mở http://127.0.0.1:7788 hoặc dùng file khởi động nhanh.

## Khởi động nhanh (Windows)
Nhấp đúp **`start.cmd`** (hoặc chuột phải **`Start-MV-Director.ps1`** → Run with PowerShell).
File sẽ tự: tắt server cũ ở cổng 7788 → `git pull` cập nhật code → chạy server → mở trình duyệt.
Để dừng: đóng cửa sổ đó hoặc nhấn Ctrl+C.

## Cài đặt & chạy (thủ công)
Yêu cầu Node.js 22 trở lên. Không cần `npm install` (không có thư viện phụ thuộc).

    npm start            # chạy server tại http://127.0.0.1:7788
    npm test             # chạy toàn bộ 8 bộ kiểm thử
    npm run format       # định dạng lại code bằng Prettier

## Nơi lưu project (quan trọng)
Project được lưu ở thư mục **`MV-Director-data`** trong thư mục home của bạn
(ví dụ Windows: `C:\Users\<Tên>\MV-Director-data`), **nằm NGOÀI thư mục ứng dụng** —
nên cập nhật code, `git pull`, hay chép lại thư mục app sẽ **không làm mất project**.
Dữ liệu cũ trong `data/` của app (nếu có) được tự chuyển sang đây một lần.
Đường dẫn lưu hiện ra ngay dưới tên project trên giao diện.

**Thư mục làm việc của project** (bắt buộc khi tạo project mới, ví dụ `D:\PHIM AI\PHIM 1\Seq2`):
ảnh/video sinh ra được chép vào đó (`thu-vien/nhan-vat`, `thu-vien/boi-canh`, `thu-vien/trang-phuc`,
`khung-hinh/<seq>`, `video/<seq>`). Khi dựng sơ đồ, node nhân vật / bối cảnh / trang phục chưa có ảnh
sẽ tự lấy file cùng key trong `thu-vien` của thư mục đó — **và chỉ từ đó**: project khác không bị lấy
sang sau lưng, dù cùng phim. Thư mục mới còn trống → hộp thoại hỏi lấy ảnh tham chiếu từ thư mục khác
(liệt kê thư mục của các project khác): chọn nếu cùng phim (cùng bộ nhân vật / bối cảnh), ảnh được chép
sang và gắn vào node cùng key; không thì **Bắt đầu mới**. Làm sau cũng được, ở tab Đạo diễn:
**📥 Nhập ảnh tham chiếu từ thư mục…**, **↻ Lấy ảnh có sẵn từ project khác**, và **🧹 Bỏ ảnh tham chiếu
đang gắn** (xoá ảnh ở node nhân vật / trang phục / bối cảnh để render lại từ đầu; file đã xuất ra thư
mục làm việc vẫn còn). Project cũ chưa có thư mục làm việc vẫn tự mượn ảnh của project khác cùng phim
như trước.

Sao lưu / khôi phục: nút **💾 Backup** tải project hiện tại ra một file `.mvproj.json`
(kèm cả ảnh/video); nút **📂 Nhập** đưa file đó trở lại thành một project mới. Muốn
sao lưu toàn bộ thì chép cả thư mục `MV-Director-data`.

Biến môi trường: `MV_PORT` (cổng, mặc định 7788), `MV_DATA_DIR` (đổi thư mục dữ liệu;
mặc định `~/MV-Director-data`). Thư mục này chứa project, media và token worker.

Luồng cố định: Ca sĩ + Sân khấu → Ghép cảnh → Toàn / Trung / Cận → Video.
Bấm một thẻ để sửa prompt, upload ảnh/video hoặc xếp tác vụ. Mô tả nhân vật,
trang phục, nhạc cụ, ánh sáng được kế thừa từ Chỉnh mô tả chung.
Ảnh ở các node trước được đính kèm vào dữ liệu job của node sau.
Đây là bản thử giao diện 3 shot, chưa phải hệ thống sản xuất MV hàng loạt.

## Đạo diễn — dựng sơ đồ tự động từ master prompt
Mục **✦ Đạo diễn** biến một master prompt (đạo diễn MV) thành cả sơ đồ node và tự nối dây:
asset (ca sĩ, từng nhạc công, sân khấu) + node Style + node cỡ máy (Wide/Medium/Close) ở khu
Tạo hình, và các node storyboard ở khu Sản xuất — mỗi shot **tự nối** tới đúng asset nó dùng,
cỡ máy và style. Dựng xong bạn chỉ việc bấm Tạo ảnh / Tạo video, hoặc sửa prompt.

Hai cách chạy:
1. **Dán blueprint:** chép master prompt (nút trong mục Đạo diễn) → chạy ở ChatGPT/Claude kèm bài
   hát → model trả về khối JSON blueprint → dán vào ô, bấm **✦ Dựng sơ đồ**.
2. **Tự động qua API:** nhập API key một endpoint tương thích OpenAI (base URL + model + key) →
   gõ tên bài hát → **⚡ Chạy tự động & dựng** (công cụ tự gọi master prompt rồi dựng).

Blueprint là JSON: `{ project, style, assets[{key,name,prompt}], cameras[{key,name,config}],
shots[{name,start,duration,uses[],camera,lyric,videoPrompt}] }`. `uses` là các `key` asset shot
dùng; `camera` là 1 `key` trong `cameras`. **Dựng sơ đồ thay toàn bộ node của project đang mở** —
nên tạo Project mới cho mỗi bài hát. Key LLM dùng chung mọi project (lưu ở gốc `data/`).

Blueprint **phim/drama VEO** (skill drama-veo-blueprint, `bible.json` + `seq-XX.json`): style là
mảng `styles[{key,name,prompt}]` → mỗi phần tử thành một node Style; mỗi shot có `camera` và
`style` (và lặp hai key đó trong `uses`). Tool nối **ảnh tham chiếu + node Máy quay + node Style**
vào từng shot; nội dung hai node này được chèn vào prompt ảnh/video ("Camera: … Style: …"), nên
câu "Camera: …" viết sẵn trong `videoPrompt` được bỏ để không lặp (phần Lighting & Physics giữ
nguyên). Sửa một node Máy quay/Style → mọi shot dùng nó cập nhật theo.

## Nhiều project & chủ đề
- Thanh trên cùng có ô chọn **project** và nút **＋ Project**. Mỗi project lưu riêng
  node, ảnh, video, và cài đặt — không lẫn nhau (ở `data/projects/<id>/`).
- Tạo project mới: đặt tên + chọn **chủ đề** (Music/MV, Phim, Hoạt hình, Khác). Project
  được **nhân từ bộ node mẫu của chủ đề** (kèm node Style và Máy quay).
- Đổi/xóa project trong **⚙ Project**. Luôn còn ít nhất một project.
- API key Seedvis và worker token dùng chung cho mọi project (lưu ở gốc `data/`).

### Mở nhiều project cùng lúc
Cửa sổ chính (cổng 7788) chỉ mở một project tại một thời điểm, vì server giữ một project đang
mở cho mọi tab. Để làm song song nhiều project, bấm **⧉ Cửa sổ mới** → chọn project → tool
**chạy thêm một tiến trình server riêng trên cổng kế tiếp** (7789, 7790…) ghim vào project đó
và mở tab mới. Mỗi cửa sổ có hàng đợi tạo ảnh/video riêng, chạy song song với cửa sổ chính.
- Một project chỉ mở được ở **một** cửa sổ: tool ghi khóa `.lock` trong thư mục project; project
  đang mở ở cửa sổ khác bị mờ trong ô chọn (ghi rõ cổng), không đổi vào và không xóa được cho
  tới khi đóng cửa sổ đó (nút **✕ Đóng** trong bảng Cửa sổ mới, hoặc đóng cửa sổ chính).
- Cửa sổ phụ hiện nhãn "CỬA SỔ PHỤ · CỔNG N"; tại đó chỉ làm việc với project của nó (không
  tạo/nhập/xóa project). Các cửa sổ phụ **tắt cùng cửa sổ chính** (Ctrl+C hoặc đóng cửa sổ
  server), nên `start.cmd` chỉ cần tắt cổng 7788 như trước.
- Chạy tay một cửa sổ ghim project: `MV_PORT=7790 MV_PROJECT=<id> node server.mjs` (id là tên
  thư mục trong `projects/`). Khóa của tiến trình đã chết được bỏ qua. **Phải dùng cùng
  `MV_DATA_DIR`** với cửa sổ chính, nếu không nó là một cửa sổ chính thứ hai và ghi đè danh
  sách project.
- **Tạo project mới không phải đợi hàng chờ.** Nếu cửa sổ này đang chạy tác vụ, project vừa tạo
  **mở thẳng ở cửa sổ riêng** và cửa sổ hiện tại giữ nguyên project đang chạy. Chỉ thao tác
  **đổi** project trong cùng một cửa sổ mới phải đợi, vì nó kéo cả tiến trình sang project khác
  và clip đã trả tiền sẽ rơi nhầm chỗ.

### Hàng đợi riêng từng project, trần dùng chung theo nhà cung cấp
Mỗi project đặt hàng độc lập: project 2 không chờ project 1. Thứ duy nhất dùng chung là **sức
chứa của nhà cung cấp**, vì đó mới là tài nguyên thật.
- **Seedvis**: 48 chỗ (`MV_SEEDVIS_CONCURRENCY`) là trần của **TÀI KHOẢN**, không phải của mỗi
  cửa sổ. Mọi tiến trình giành chỗ trong thư mục `seedvis-slots/` ở gốc thư mục dữ liệu (mỗi chỗ
  một file, giành bằng cờ `wx` nên hai cửa sổ không thể cùng chiếm). Hết chỗ thì tác vụ **đứng
  chờ ở trạng thái "Chờ chỗ trống"**, không báo lỗi và không gửi đi. Đóng cửa sổ là nhả chỗ ngay;
  cửa sổ bị kill để lại file có pid, cửa sổ sau thu hồi.
- Seedvis trả **422 hàng chờ đầy** sau khi đã thử lại hết lượt: tác vụ **quay lại hàng đợi** để
  gửi sau (422 nghĩa là Seedvis chưa tạo gì), tối đa 20 lượt chờ rồi mới báo lỗi.
- **ChatGPT**: trần thật là số tab của extension (1–6, mặc định 3), vì extension là nơi sở hữu
  tab. `MV_WORKER_CONCURRENCY` chỉ còn là van an toàn của từng cửa sổ.
- **Extension phục vụ mọi cửa sổ**: dán địa chỉ cửa sổ nào cũng được — nó hỏi
  `GET /api/worker/windows` để biết các cổng còn lại rồi rút việc luân phiên, nên project ở cửa
  sổ phụ cũng được tạo ảnh. Trước đây extension chỉ gọi 7788 nên job ChatGPT của cửa sổ phụ nằm
  chờ mãi mãi.

## Khu vực quy trình (zones)
Canvas chia 10 cột theo quy trình: **① Nhân vật** (thiết kế nhân vật / visual reference: ca sĩ, nhạc công), **② Trang phục & vật dụng** (mỗi bộ đồ + vật dụng của một nhân vật cho một bối cảnh), **③ Bối cảnh** (sân khấu/cảnh/đạo cụ), **④ Style & Máy quay** (node Style + các cỡ máy), **⑤ Âm thanh** (nhạc nền + tiếng hiện trường), **⑥ Sản xuất video** (các shot), **⑦ Phân cảnh ghép** (2–3 cỡ cảnh của một đoạn hội thoại quay chung một clip Veo), **⑧ Video** (video từng shot đã tạo), **⑨ Seedance** (nhóm nhiều shot quay một lần, xem mục Seedance), **⑩ Video Seedance** (video do các nhóm Seedance tạo). Mỗi shot = nhân vật (hoặc bộ trang phục của nhân vật) + bối cảnh + cỡ máy + style nối lại.
- Mỗi node thuộc một khu vực (tự gán theo loại; đổi trong node ở ô **Khu vực**, hoặc **kéo
  node sang cột khác** để chuyển).
- Nút **⬓ Xếp khu vực**: tự xếp mọi node vào đúng cột, theo thứ tự (khu Tạo hình/Sản xuất theo
  số thứ tự #; khu Video theo thứ tự node sản xuất rồi tới phiên bản).
- Số thứ tự **#N** đánh **riêng theo từng khu vực** (Tạo hình 1,2,3…; Sản xuất 1,2,3…; Video 1,2,3…).
  Sửa ô **STT trong khu vực** của node và gõ vị trí mới để chèn node vào đúng chỗ; hệ thống tự
  đánh lại 1..n. Tên video tải về dùng số của node sản xuất nguồn (vd `01_Toàn cảnh_v2.mp4`).

## Trang phục & vật dụng (khu ②)
Veo chỉ giữ đúng trang phục khi ảnh tham chiếu đưa vào shot đã mặc đúng bộ đó. Model sheet nhân vật
chỉ có một bộ, nên khi đổi bối cảnh (tang lễ → dạ tiệc) trang phục dễ "nhảy" giữa các cảnh. Khu ②
giải quyết việc này:
- Chuỗi ba node: **nhân vật** → **trang phục** (khu ②, chỉ render bộ đồ; ra ma-nơ-canh cũng được)
  → **nhân vật đã mặc** (khu ①, xếp ngay dưới nhân vật gốc; ghép ảnh nhân vật + ảnh trang phục thành
  chính người đó mặc bộ này, ra đúng bố cục model sheet như nhân vật: chân dung + 3 góc toàn thân,
  cùng model ảnh và tỉ lệ khung với node nhân vật; prompt do tool đặt sẵn) → **shot**. Shot chỉ nhận node "nhân vật đã
  mặc": không nhận node trang phục trần (Veo thiếu mặt), không nhận thêm node nhân vật gốc của cùng
  người (Veo mặc lẫn).
- Thêm trang phục từ node nhân vật (**＋ Thêm trang phục cho nhân vật này** — node mới ghi nhớ nhân
  vật đó) hoặc nút **＋ Trang phục** trên thanh công cụ. Node trang phục có hai ô **Trang phục**
  và **Vật dụng / phụ kiện** (tiếng Anh) để sinh prompt bộ đồ, hoặc dán prompt riêng.
- Trong node trang phục bấm **＋ Tạo node nhân vật đã mặc bộ này** → node mới nối từ nhân vật và
  trang phục. Nhân vật và bộ đồ render song song; node nhân vật đã mặc chạy khi cả hai đã có ảnh. Dựng từ blueprint thì tool tự tạo và nối đủ chuỗi này cho mọi costume.
- Tạo ảnh nhanh theo khu: khu ① ra nhân vật, khu ② ra trang phục, rồi khu ① lần nữa ra nhân vật đã
  mặc (node chỉ chạy khi đã đủ ảnh đầu vào); hoặc dùng ▶ Tạo ảnh (chuỗi). Ảnh trang phục xuất ra
  `thu-vien/trang-phuc/`, nhân vật đã mặc ra `thu-vien/nhan-vat/`; tái dùng giữa các phân đoạn theo
  `assetKey`, kể cả **giữa các project của cùng phim**: nạp tập 2 vào project mới (hay cửa sổ phụ)
  → tool tìm ảnh cùng key trong các project khác có cùng `film.title` trong Bible, sao chép sang
  media của project này, chỉ còn node mới phải render. Ảnh render sau khi đã nạp: tab Đạo diễn →
  **↻ Lấy ảnh có sẵn từ project khác**.
- Blueprint (theo spec costume của skill drama-veo-blueprint): danh sách `wardrobe[]` ngang hàng
  `assets`. **costume** `{ "key": "costume_julian_mourning", "kind": "costume", "for": "julian",
  "uses": ["julian"], "name": "Julian — đồ tang", "prompt": "Costume reference sheet: black
  three-piece mourning suit … on a neutral mannequin" }` (prompt chỉ tả bộ đồ, không "render lại
  người") → node trang phục **không nhận ảnh đầu vào**, chỉ ghi nhớ nhân vật nó mặc (từ `for`, hoặc
  key nhân vật trong `uses`) nên render được ngay song song với nhân vật; kèm node **nhân vật đã mặc**
  tự tạo (`look_<costume>`, đầu vào = ảnh nhân vật + ảnh bộ đồ), và shot nối vào node nhân vật đã mặc đó. **item**
  `{ "key": "prop_will", "kind": "item", "prompt": "…" }` → node vật dụng cùng khu, render riêng theo
  **model sheet vật dụng** (xem mục dưới): `prompt` của item được dùng làm **mô tả**, tool dựng prompt. Shot
  ghi **một look cho mỗi người** trong `uses`: key nhân vật (look chính) HOẶC key costume của họ;
  lỡ ghi cả hai thì tool bỏ nhân vật gốc. Costume thiếu
  nhân vật hoặc một người có 2 costume trong một shot → cảnh báo sau khi dựng. Cách khai cũ
  (`role: "wardrobe"` + `character` + `outfit`/`items`) vẫn nhận.

## Node tham chiếu gõ tay: chỉ cần tên + mô tả
Ba nút trên thanh công cụ — **＋ Nhân vật**, **＋ Vật dụng**, **＋ Bối cảnh** — tạo node mà **tool sở hữu
prompt**. Bạn chỉ gõ **Tên node** và ô **Mô tả (tiếng Anh)**; prompt chuẩn được dựng lại mỗi lần lưu,
và **không** bị chèn `identity`/`wardrobe`/`stage` của project (trước đây node vật dụng bị dính mô tả
ca sĩ + sân khấu vào prompt).
- **Vật dụng** → *model sheet vật dụng*: **một ảnh gồm 1 góc chính lớn + 2 góc xoay** của đúng vật đó,
  cùng tỉ lệ, cùng một nguồn sáng, nền xám trơn, **không bàn tay, không bối cảnh, không bản sao xếp cảnh** —
  đúng cách node nhân vật làm, để vật dụng không đổi hình giữa các shot. Vật dẹt (thẻ, giấy, điện thoại)
  tự đổi sang mặt thẳng + three-quarter nghiêng thay vì cạnh mỏng; vật đối xứng tròn đổi góc theo
  cao độ và khoảng cách. Chữ/logo in trên vật được giữ nguyên vị trí ở cả ba góc.
- **Nhân vật** → chân dung lớn + 3 góc toàn thân cùng tỉ lệ trên một đường chân.
- **Bối cảnh** → cảnh toàn trống người, làm gốc cho node góc máy.
- Nối ảnh vào node vật dụng thì prompt tự chuyển sang *giữ đúng vật trong ảnh tham chiếu*, không vẽ lại.
- Sửa ô Mô tả đánh dấu ảnh cũ **cần cập nhật**. Mô tả để trống vẫn dựng được sheet: vật dụng lấy tên
  node làm mô tả, còn nhân vật và bối cảnh để model tự nghĩ — **tên node không bao giờ vào prompt**
  của hai loại này, vì tên thật khiến model video dễ từ chối cảnh.
- **Prompt riêng luôn thắng.** Node đã có prompt viết sẵn (mọi nhân vật dựng từ blueprint, hoặc node
  bạn tự sửa ô Prompt ảnh) thì mô tả không có tác dụng — giống hệt cách node trang phục bỏ qua ô
  Trang phục/Vật dụng khi đã có prompt tay. Khi đó inspector nói rõ điều này và không cho sửa mô tả;
  muốn chuyển sang model sheet thì bấm **Dùng prompt kế thừa** để xóa prompt riêng rồi gõ mô tả.
  Riêng `kind: "item"` của blueprint đi thẳng vào ô Mô tả nên nhận sheet ngay (xem mục trên).

## Bối cảnh: cảnh toàn + góc cận đối nghịch
- Node bối cảnh gốc = **cảnh toàn**. Từ nó tạo **node góc máy** (cùng cột, xếp ngay dưới): ảnh gốc là
  tham chiếu, prompt do tool đặt ("Same location as the reference image… New camera angle: …", không
  người), nên mọi góc đều cùng một không gian, bài trí, ánh sáng. Trong node bối cảnh bấm
  **＋ 2 góc cận đối nghịch A/B** (góc A = cái máy OTS A nhìn thấy: sau vai A nhìn B; góc B ngược lại
  180°) hoặc **＋ Góc máy khác** rồi tự tả góc (tiếng Anh). Tạo ảnh cảnh toàn trước, rồi tạo ảnh các
  góc (khu ③ chạy hai lượt). Góc máy kế thừa model ảnh/tỉ lệ của bối cảnh gốc.
- Nếu ảnh góc ra gần giống cảnh toàn: mô tả góc còn chung chung, model ảnh-sang-ảnh chép lại bố cục
  gốc. Hãy tả góc cụ thể theo địa điểm (máy đứng cạnh vật gì, nhìn về vật gì, cỡ cận, ngang mắt) trong ô
  **Góc máy** rồi Tạo ảnh lại; prompt tool đặt góc máy lên đầu và cấm lặp bố cục ảnh gốc.
- Blueprint: scene có `"reverse_angles": true` (góc A/B chung) hoặc
  `"reverse_angles": { "a": "…", "b": "…" }` (mô tả cụ thể từng góc, nên dùng) → tool tự tạo
  `<key>_a`, `<key>_b`; scene có
  `"of": "<scene gốc>"` + `"angle": "…"` → góc phái sinh (vd `scene_study_table` of
  `scene_master_study`, có thể có góc A/B riêng). Shot ghi `uses` cảnh toàn + máy quay OTS A/B
  (`veo_ots_a`/`veo_ots_b`, hay tên có "Over-Shoulder A/B") → tool tự nối góc A/B tương ứng; ghi
  thẳng `scene_x_a` trong `uses` cũng được. Trong dòng "Reference subjects" góc vẫn gọi theo tên bối
  cảnh (`the cemetery — … góc cận A`).

## Node Âm thanh & cảnh không thoại
- Khu **⑤ Âm thanh** chứa các **preset âm thanh** (nét đứt như Style/Máy quay, không render ảnh).
  Thêm bằng **＋ Âm thanh** trên thanh công cụ, nội dung viết tiếng Anh: nhạc nền + tiếng hiện
  trường + điều cấm, ví dụ `low sustained cello drone under light rain on umbrellas, distant chapel
  bell; no melody, no percussion, no crowd chatter`. Nối cổng **Ra** vào shot nào thì prompt shot đó
  được chèn `Audio: …`.
- Blueprint: khai mảng `audio[]` ngang hàng `cameras`/`styles` (`key`, `name`, `prompt`); shot ghi
  `"audio": "aud_funeral"` và lặp key đó trong `uses`. Cả blueprint chỉ có một preset thì tool tự
  nối vào mọi shot (giống style đơn).
- **Cảnh không thoại**: shot nào `dialogue` để trống hoặc mở đầu bằng `[` (vd `[Không thoại; chuông
  nhà nguyện ngân trong sương]`) được tool thêm vào prompt video câu *No spoken dialogue in this
  shot: nobody speaks and no lips move. Audio is location sound only — &lt;tiếng hiện trường&gt;; no
  added music, no voice-over, no narration.* Phần tiếng hiện trường lấy từ `audio_delivery` của shot
  (viết tiếng Anh, tool tự bỏ tiền tố "Không thoại"/"No dialogue"). Shot có thoại hoặc voiceover
  không nhận câu này; lời hát trong blueprint nhạc cũng không bị coi là im lặng.

## Node Style & Máy quay
- Là node trên canvas (nét đứt). Nội dung của chúng được **chèn vào prompt** của mọi
  node mà bạn nối cổng **Ra** của chúng vào.
- Thêm bằng **＋ Style** / **＋ Máy quay** trên thanh công cụ; bấm node để sửa nội dung.
- Style = mô tả phong cách/màu/chất liệu; Máy quay = góc máy/ống kính/chuyển động.
- Node cài đặt không tạo ảnh/video và không nằm trong chạy tự động; đổi nội dung sẽ đánh
  dấu các node nối sau cần cập nhật.

## Tạo ảnh / video bằng Seedvis API
1. Kết nối web → Seedvis API → dán API key → Lưu key → Kiểm tra kết nối.
   Key lưu ở `data/seedvis-key.txt` (hoặc biến môi trường `SEEDVIS_API_KEY`),
   không gửi về trình duyệt, không ghi vào project.json.
2. Mở node → Nguồn tạo: chọn Seedvis hoặc Orbit riêng cho ảnh và video, chọn model,
   tỉ lệ khung, upscale. Node chưa có cấu hình Orbit mặc định dùng Seedvis.
   - Ảnh: Nano Banana Pro / 2 / Lite, GPT Image 2. Có ảnh đầu vào → ảnh → ảnh.
   - Video: Veo 3.1, Seedance 2.5 / 2.0 Fast, Omni Flash.
     Thời lượng shot được làm tròn về giá trị model hỗ trợ (Veo 4/6/8 giây, Seedance 5/10/…).
3. Node → Video của shot → Ảnh đầu vào cho video, chọn một trong hai:
   - **Ảnh của node này (keyframe):** dùng chính ảnh đã tạo/duyệt của node. Mỗi node
     tạo ảnh trước rồi tạo video từ ảnh đó.
   - **Ảnh từ node nối vào:** dùng thẳng ảnh của các node nối vào (ví dụ dùng lại ảnh
     ban nhạc để tạo video), không cần tạo ảnh riêng cho node này. Số ảnh gửi đi theo
     giới hạn model: Veo / Omni 1 ảnh (image-to-video) hoặc 2–3 ảnh (multi-image-to-video),
     Seedance tới 10 ảnh.
   - **Quy tắc theo số ảnh tham chiếu** (node hiện rõ "🖼 N ảnh"): nếu N **≤ giới hạn của
     model video** (Veo/Omni 3, Seedance 10) thì video chạy thẳng với N ảnh đó. Nếu N **vượt
     giới hạn** thì shot **bắt buộc tạo ảnh khung hình trước** (model ảnh gộp tới 10 ảnh tham
     chiếu thành một khung), rồi video chạy từ khung hình đó. Nút Tạo video thủ công sẽ từ
     chối kèm hướng dẫn; **▶ Tạo video** tự động xếp job tạo ảnh trước rồi mới tạo video.
4. Bấm Tạo ảnh · Seedvis / Tạo video · Seedvis, hoặc ▶ Tự động tạo ảnh cho cả chuỗi.
   Kết quả được tải về và gắn vào node.

### Cảnh nhiều nhân vật: ai là ai, ai nói (gọi bằng mã NV)
Veo nhận ảnh tham chiếu theo thứ tự và không hiểu các tag `@key` trong prompt, nên cảnh hai người
dễ bị gán nhầm mặt và lời thoại. Ngoài ra **tên thật của nhân vật trong nhãn tham chiếu hay dòng
khóa giọng làm Veo dễ từ chối "dùng người thật"**, nên tool chỉ gọi người bằng **mã `code`** trong
Bible (NV1, NV2…); tên thật chỉ còn trong lời thoại. Khi dựng prompt gửi đi (cũng là nội dung hiện
trong ô Prompt video), tool tự:
- mở đầu bằng dòng **"Reference subjects, in the order of the attached images: [1] NV3; [2] NV1;
  [3] the cemetery — …"** đúng thứ tự ảnh gửi đi. Người **chỉ có mã, không mô tả ngoại hình**: ảnh
  tham chiếu đã là diện mạo, thêm chữ về mặt/tóc/tuổi/quần áo chỉ chọi với ảnh. Chỉ bối cảnh và đạo
  cụ kèm tên cho dễ nhận. Nhân vật không khai `code` thì dùng tên gọi đầu như trước;
- **xóa câu giới thiệu ngoại hình** nếu blueprint lỡ viết ("In this shot, NV1 is a poised woman in her
  late 30s…"). Câu định vị ("NV1 is standing by the window") vẫn giữ. Prompt còn lại đúng 5 phần:
  định vị nhân vật → hành động → thoại → máy quay → ánh sáng, cộng dòng âm thanh;
- thay mọi tag bằng nhãn đó (`@NV1's` → `NV1's`), bối cảnh/đạo cụ thành "the cemetery", "the locket";
- **người nói**: lấy mã đứng ngay trước `mouth articulates` trong `videoPrompt` (`Over @NV1's shoulder
  onto @NV3 … mouth articulates:` → NV3), rồi thêm *The line is spoken by NV3 (reference image N)
  only; everyone else stays silent and listens*. Không có dấu hiệu đó thì lấy tên mở đầu `dialogue`
  (`Vivienne: "…"`) rồi quy về mã. Người nói ngoài khung: *spoken by NV3 off-screen; no one in frame
  mouths it*; voiceover: không thêm câu khẩu hình;
- **prompt ảnh của shot** (khung hình đầu) không phải prompt video: tool bỏ nhãn *Veo Video Prompt*, đổi
  câu thoại thành *lips parted mid-sentence*, bỏ dòng Audio, và mở đầu bằng *Still keyframe, one
  photographic moment of this shot, not a sequence: …* kèm *no motion blur, no sound*. Nếu blueprint
  khai riêng `shot.prompt` thì tool dùng đúng prompt đó, không đụng tới;
- **khóa giọng**: shot có thoại (kể cả voiceover) nhận thêm *Voice lock for NV3: giới tính, tuổi giọng;
  timbre; accent; pacing; baseline. Delivery: …* lấy từ `voice_profile` trong Bible và `audio_delivery`
  của shot, nên giọng không nhảy giữa các shot. Hai trường này được gửi nguyên văn, hãy viết bằng
  tiếng Anh.
Tên file ảnh gửi Seedvis cũng mang key (`eleanor-<id>.png`). Prompt bạn đã lưu tay sau khi tool
thêm các phần này sẽ không bị thêm lần hai.

## Tự động tạo video (song song, nhiều phiên bản)
Thanh công cụ: chọn **Phiên bản** (1–4) rồi bấm **▶ Tự động tạo video**.
- Mọi node đã sẵn ảnh đầu vào (ảnh của chính node, hoặc ảnh node nối vào tùy chế độ) và
  dùng Seedvis cho video sẽ **chạy song song qua API** — không chạy lần lượt từng node.
  Tool đẩy tối đa **48 tác vụ** sang Seedvis cùng lúc, đúng sức chứa của tài khoản (16 luồng
  tạo đồng thời + 32 chờ); Seedvis tự xếp hàng phần chưa chạy. Đổi bằng `MV_SEEDVIS_CONCURRENCY`.
- **Video luôn gửi ở thời lượng tối đa của model** (Veo 3.1: 8 giây), kể cả khi shot ngắn hơn,
  để còn dư đầu đuôi mà cắt khi dựng. Ô *Thời lượng (giây)* của shot vẫn là độ dài trên
  timeline và biến `{{mv_duration}}` cho Orbit. Lưu ý model có thang dài (Seedance: tới 30 giây)
  cũng sẽ gửi ở mức dài nhất.
- **Tự chạy lại cảnh lỗi, tối đa 3 lần** (đổi bằng `MV_AUTO_RETRIES`): shot nào Seedvis báo lỗi
  chắc chắn (failed) được xếp lại ngay trong cùng lượt chạy, tối đa 1 + 3 lần thử; lần lỗi cũ
  ghi trong Hàng đợi là "Lỗi · đã tự chạy lại". Ảnh khung hình (bước trước video) cũng được thử
  lại như vậy. Hết 3 lần vẫn lỗi thì lượt chạy kết thúc với danh sách lỗi và nút **↻ Chạy lại
  video lỗi** để thử tiếp. Tác vụ ở trạng thái "Cần kiểm tra" (không rõ kết quả, có thể vẫn đang
  tạo trên Seedvis) **không** tự gửi lại để không tính lượt hai lần.
- **Mở lại project cũ:** nút **✚ Tạo N video còn thiếu · đã có X/Y** gồm mọi shot chưa có
  video, dù lý do là chưa quay, lỗi, đã dừng hay "Cần kiểm tra" (ví dụ app khởi động lại khi
  đang chạy). Shot đã có video thì bỏ qua. Shot "Cần kiểm tra" được **hỏi lại Seedvis** trước
  (miễn phí): Seedvis làm xong rồi thì video tự về cột Video; Seedvis báo lỗi thì tạo mới. Tác
  vụ chưa được Seedvis xác nhận đã nhận thì gửi lại với **cùng mã chống trùng**, nên Seedvis trả
  lại tác vụ cũ chứ không tính lượt mới. Shot chưa đủ ảnh đầu vào hoặc keyframe đã cũ thì chưa
  tính vào nút. Yêu cầu bị từ chối trước khi gửi (ví dụ quá số ảnh tham chiếu) được ghi là lỗi
  thường, không còn là "Cần kiểm tra".
- Mỗi node gửi một request `count = số phiên bản`; mỗi video trả về **tự tách thành một
  node mới** (node phiên bản, viền xanh, bấm để xem/tải/xóa). Node nguồn không bị ghi đè.
- Bấm lại để **tạo thêm** phiên bản (không xóa bản cũ).
- **Dừng tạo video** (và **Dừng tạo ảnh**) bật bất cứ khi nào còn tác vụ đang chờ/đang chạy —
  kể cả tác vụ tạo từ nút của một node, không riêng chuỗi tự động. Bấm Dừng: tác vụ **đang chờ**
  (chưa gửi) bị hủy; tác vụ **đã gửi Seedvis** được tách khỏi khóa (workflow mở lại sửa được
  ngay) và vẫn chạy tiếp, kết quả tự thêm vào workflow khi xong. Tool có thử gọi hủy trên Seedvis:
  nếu bên đó còn xếp hàng thì hủy và không tính lượt, nếu đang tạo thì chạy tiếp.
- Trong một node, mục Video của shot có **Số phiên bản**: từ 2 bản trở lên, bản tạo thủ công
  cũng tách thành node riêng; 1 bản thì gắn thẳng vào node như cũ.
- Giới hạn phiên bản theo model: Veo / Omni 4, Seedance 8. Node phiên bản và node bạn thêm
  đều có nút xóa.

An toàn chi phí: mỗi tác vụ gửi `Idempotency-Key` = mã job nên gửi lại khi lỗi mạng không
tạo lượt mới. Không bao giờ tự gửi lại sau khi Seedvis đã nhận. Quá thời gian hoặc khởi động lại
khi đang chạy → job ở Cần kiểm tra; bấm Kiểm tra lại trong Hàng đợi để đọc tiếp đúng job đó.
Seedvis từ chối (lỗi 4xx hoặc failed) → job Lỗi, sửa prompt/ảnh rồi tạo lại.

## Phân cảnh ghép: 2–3 cỡ cảnh của một hội thoại trong một clip Veo

Một đoạn đối thoại ngắn (2–3 câu) không cần quay từng shot. Khai nó trong blueprint như **một
mục shot có `setups`**: tool dựng **mỗi cỡ cảnh một node khung** ở cột ⑥ (ảnh tĩnh riêng,
đánh số 1, 2, 3) và **một node phân cảnh ghép** ở cột **⑦ Phân cảnh ghép** nối từ các khung.
Node ghép gửi 2–3 ảnh khung đó làm ảnh tham chiếu (Veo gọi là Ingredients) cùng một prompt cắt
cứng ở từng mốc giây, ra **một clip 8 giây** về cột ⑧ Video, cùng hàng với phân cảnh. Công
thức và prompt đã test nằm trong `Veo-shot-notes.md` (mục 3–6).

Các cỡ cảnh: `ots_a` (qua vai người bên trái, nhìn người bên phải đang nói), `ots_b` (ngược
lại), `two_shot` (trung đôi, cả hai trong khung). Thứ tự `setups` là thứ tự cắt; 8 giây chia
theo số từ của từng câu (2 khung: 4/4; 3 khung: ví dụ 5/2/5 từ → 3/2/3 giây).

Blueprint cần thêm các trường sau (tiếng Anh, tool gửi nguyên văn):

```json
"assets": [
  { "key": "eleanor", "role": "character", "code": "NV1",
    "identity_label": "the auburn-haired woman",
    "back_view": "her auburn bun and charcoal shoulder", "...": "..." },
  { "key": "scene_study", "role": "scene",
    "conversation": {
      "place": "The study from image 1 at night",
      "two_shot": "from the bookcase side of the room",
      "left":  { "anchor": "standing at the window end of the long desk beside the green banker's lamp",
                 "background": "the rain-streaked arched windows",
                 "light": "warm firelight and green banker's-lamp light on her face" },
      "right": { "anchor": "standing in front of the marble fireplace",
                 "background": "the marble fireplace and gilt portrait",
                 "light": "firelight rims her hair, cool blue window light on her face" } } }
],
"shots": [
  { "name": "Cảnh 09 — Di chúc", "start": 72,
    "uses": ["costume_vivienne_mourning", "eleanor", "scene_study", "style_main", "aud_rain"],
    "style": "style_main", "audio": "aud_rain",
    "sides": { "left": "eleanor", "right": "costume_vivienne_mourning" },
    "setups": [
      { "framing": "ots_a", "dialogue": "Vivienne: \"He changed the will, Eleanor.\"", "audio_delivery": "coolly, bright and brittle" },
      { "framing": "ots_b", "dialogue": "Eleanor: \"I know.\"", "audio_delivery": "low and slow" },
      { "framing": "two_shot", "dialogue": "Vivienne: \"Then you leave with nothing.\"", "action": "takes one step toward NV1" }
    ] }
]
```

- `identity_label`: nhãn nhận dạng 2–5 chữ, thay cho tên thật trong prompt ảnh.
  `back_view`: lưng, tóc sau và vai của bộ đang mặc (costume có thể khai `back_view` riêng).
- `conversation` của bối cảnh: `place` là câu mở của mọi ảnh khung (ảnh 1 luôn là bối cảnh);
  `left`/`right` tả chỗ đứng, hậu cảnh và ánh sáng của người đứng bên đó; `two_shot` là vị
  trí máy cho trung đôi. Ảnh khung dùng **cảnh toàn** (không có người), như bản đã test.
  Đại từ trong `anchor`/`background`/`light` (her, his…) được tool đổi theo giới của người đứng
  bên đó (đọc từ `voice_profile.gender`), nên viết theo một giới nào cũng được.
- `sides` chốt ai bên trái, ai bên phải cho cả cuộc nói chuyện (key nhân vật hoặc costume).
  Thiếu thì lấy theo thứ tự trong `uses`. Mỗi khung được nối theo thứ tự **[1] bối cảnh,
  [2] người bên trái, [3] người bên phải** — prompt ảnh gọi đúng số đó.
- Mỗi `setup`: `framing`, `dialogue` dạng `Tên: "…"` (một người nói), `audio_delivery`
  (cách nói, nằm ngay cạnh câu), `action` (một hành động nhỏ, tùy chọn). Không viết
  `videoPrompt` cho mục shot này: tool tự dựng prompt cắt cảnh; sửa tay trong node ghép nếu cần.
- Thiếu trường nào, node khung báo rõ trường đó khi tạo ảnh. Node khung **không bao giờ bị
  quay riêng** (▶, ✚ và nhóm Seedance đều bỏ qua); ✚ Tạo video còn thiếu quay node ghép khi
  các khung đã có ảnh. Khung đổi ảnh thì phân cảnh báo "Đầu vào đã thay đổi".
- Nhóm Seedance hiện chưa gom phân cảnh ghép (chỉ gom shot thường); sẽ làm sau.

## Seedance: quay cả nhóm shot trong một lần render

Ngoài cách quay từng shot bằng Veo (8 giây/lần), có thể gộp các shot liên tiếp thành **nhóm
Seedance** và quay cả nhóm trong một lần (Seedance 2.5: tới 30 giây). Veo vẫn là cách mặc
định; một phim có thể trộn nhóm Seedance với shot Veo.

1. Tạo ảnh khung hình (keyframe) cho các shot như bình thường.
2. Bấm **🧩 Chia nhóm Seedance** (cột phải). Tool gộp các shot **chưa thuộc nhóm nào** theo
   thứ tự timeline: mỗi nhóm tối đa bằng thời lượng dài nhất của model (2.5: 30 giây, 2.0
   Fast: 15 giây), **ngắt khi đổi bối cảnh**, và không vượt số ảnh tham chiếu model nhận. Nhóm
   là node ở cột **⑨ Seedance**, nối dây từ các shot của nó; storyboard của nhóm tự dựng ngay
   nếu các shot đã có ảnh.
3. Chỉnh nhóm bằng dây: nối thêm shot vào nhóm, hoặc cắt dây để bỏ shot ra. Xóa nhóm rồi bấm
   lại nút để chia lại các shot còn lẻ.
4. Mở nhóm: xem danh sách shot với mốc thời gian, ảnh gửi đi, chọn model, xem/sửa prompt, rồi
   **Tạo video Seedance**. Video về cột **⑩ Video Seedance**, cùng hàng với nhóm, số phiên bản
   tăng dần (video từng shot vẫn ở cột ⑧ Video).

Cách tool dựng lần render:
- **Giữ đúng thời lượng từng shot.** Lần render dài bằng mức nhỏ nhất model nhận mà chứa đủ
  các shot (Seedance nhận 5, 10, … 30 giây); **giây dư thành đuôi giữ khung** ở cuối để cắt
  khi dựng (ví dụ nhóm 26 giây gửi 30 giây, 4 giây cuối giữ khung).
- **Storyboard** ghép từ keyframe các shot theo thứ tự, mỗi ô **chỉ có số** (1, 2, 3…) — chữ
  mô tả trên ảnh dễ làm Seedance nhầm nhân vật. Bố cục gần 16:9, không quá 2,5:1. File
  storyboard cũng được lưu vào `storyboard/<tên project>/` trong thư mục làm việc để dùng tay
  trên seedvis.com nếu cần. Ảnh shot đổi thì nhóm báo "Đầu vào đã thay đổi": bấm **🧩 Dựng
  storyboard** để dựng lại.
- **Ảnh gửi đi:** [1] storyboard, rồi nhân vật (ưu tiên), bối cảnh/góc máy, đạo cụ — theo số
  shot dùng; Seedance 2.5 nhận tối đa 10 ảnh, 2.0 Fast 9. Luôn gửi ít nhất 3 ảnh (thiếu thì
  thêm keyframe shot) để Seedance coi là ảnh tham chiếu, không phải khung đầu/cuối.
- **Prompt tiếng Anh** theo mẫu: "Create a N-second … Shot 1 (0–7s): … Shot 2 (7–13s): …",
  cắt cứng ở mỗi mốc, mã NV thay tên, ai nói câu nào, khóa giọng mỗi nhân vật một lần, âm
  thanh theo từng dải shot, style một lần, cấm phụ đề/chữ/viền storyboard.

Lưu ý: Seedance qua Seedvis duyệt mặt người rất gắt (ảnh người trông như thật dễ bị từ chối),
và đắt hơn Veo khoảng 5 lần mỗi giây phim (20/25/30 giây cùng giá). Nên thử một nhóm trước.

## Thư viện Video & số thứ tự node
- **Trên canvas, mọi phiên bản video của một node nguồn hiện trong một card** ở cột video,
  cùng hàng với nguồn: card hiện bản đang chọn, nhãn "3 video" và nút **‹ ›** để lật bản.
  Bấm vào card để xem: trong bảng bên phải có **‹ Bản trước / Bản sau ›**, **Giữ bản này,
  xóa các bản khác** và **Xóa phiên bản này**. Trên server mỗi bản vẫn là một node phiên bản
  riêng (tên file, thư viện, cảnh báo "đầu vào đã thay đổi" không đổi).
- Thanh bên trái có mục **🎬 Video**: gom mọi video đã tạo theo node nguồn (kèm số thứ tự
  và tên node). Mỗi video có nút xem, tải, và **ô tick** để chọn nhiều bản của cùng node.
  Thanh trên cùng: **Chọn tất cả / Bỏ chọn / Tải đã chọn / Xóa đã chọn** (xóa áp dụng cho
  node phiên bản).
- **Số thứ tự (STT)** hiện trên mỗi node (badge `#3`), tự đánh khi tạo node, sửa được trong
  node (ô "Số thứ tự").
- **Tên file tải về** theo STT + tên node để nhận đúng nguồn:
  - Node thường: `03_Toàn cảnh.mp4`
  - Node phiên bản: `03_Toàn cảnh_v2.mp4`

## Dây nối
Node ảnh/shot có **hai cổng vào** riêng: 🖼 **ảnh tham chiếu** (nhân vật, trang phục, bối cảnh,
đạo cụ, shot khác — đếm số ảnh node nhận) và 🎨🎥 **Style / Máy quay** (chỉ chèn chữ vào prompt,
không tính là ảnh). Thả dây vào cổng nào cũng được; tool tự phân loại theo node nguồn. Trong
inspector có dòng "Đầu vào" tổng hợp: số ảnh tham chiếu, số đã có ảnh, số style/máy quay và
giới hạn ảnh của model video.
Bấm vào một dây để chọn (dây chuyển đỏ nét đứt), rồi bấm nút × ở giữa dây hoặc phím Delete.
Vẫn có danh sách dây kèm nút × dưới canvas. Không sửa dây khi đang có job chờ/chạy.

## Trạng thái Orbit
Hub: http://192.168.100.5:8080
Mã nguồn Hub đã kiểm tra tại D:\Orbit\orbit; ứng dụng này không sửa mã nguồn Hub.
Vào Kết nối web → nhập email và mật khẩu Orbit → Đăng nhập.
Ứng dụng gọi POST /api/login của Hub và dùng cookie phiên cho các API tiếp theo.
Mật khẩu không lưu; cookie Orbit giữ trong bộ nhớ server. Trình duyệt nhận cookie
local HttpOnly, SameSite=Strict. Đóng server phải đăng nhập lại.
Đăng xuất thu hồi phiên Hub. Không dùng API key hoặc quyền admin dự phòng.

Mở từng node → Cài đặt Orbit → chọn kịch bản và nick → Lưu chỉnh sửa.
Node góc máy có hai cấu hình độc lập cho ảnh và video. Danh sách chứa cả
Kịch bản (workflow) và Khối (flow), theo quyền tài khoản đăng nhập.
Mỗi lần xếp job đều kiểm tra lại quyền đọc danh sách và chụp cấu hình đã chọn.
Quyền chạy thực tế còn do Hub kiểm tra khi triển khai bộ thực thi.

## Cấu trúc code: sửa chức năng nào thì vào file nào

Mỗi chức năng nằm trong file riêng. Dòng đầu mỗi file ghi file đó làm gì.
`server.mjs` chỉ còn phần khởi động; logic nằm trong `lib/`, các đường dẫn API
nằm trong `lib/routes/`. Giao diện nằm trong `public/js/`, bắt đầu từ `main.js`.

| Chức năng | Server | Giao diện (`public/js/`) |
|---|---|---|
| Prompt gửi đi: mã NV, người nói, khóa giọng, cảnh không thoại, khung hình | `lib/prompts.mjs` | — |
| Tạo ảnh/video, sửa ảnh, nhận kết quả, node clip | `lib/jobs.mjs`, `lib/runner.mjs`, `lib/image-size.mjs` | `inspector.js`, `edit-image.js` |
| Cảnh báo "Đầu vào đã thay đổi"; gán ảnh mới cho node (`setImage`, cũng lưu vào thư viện) | `lib/staleness.mjs` | `cards.js` |
| Chạy hàng loạt ảnh/video, chạy lại lỗi, video còn thiếu | `lib/auto.mjs`, `lib/routes/auto.mjs` | `auto.js` |
| Thư viện ảnh tham chiếu, thư mục làm việc | `lib/library.mjs`, `lib/routes/assets.mjs` | `director.js`, `projects.js` |
| Project, cửa sổ phụ, sao lưu | `lib/projects.mjs`, `lib/windows.mjs`, `lib/routes/projects.mjs` | `projects.js` |
| Đạo diễn dựng sơ đồ từ JSON | `director.mjs`, `lib/apply-graph.mjs`, `lib/routes/director.mjs` | `director.js` |
| Node, dây nối, cột, sắp xếp | `lib/nodes.mjs`, `lib/zones.mjs`, `lib/routes/nodes.mjs` | `canvas.js`, `add-nodes.js`, `wardrobe.js`, `zones.js` |
| Seedvis, Orbit | `seedvis-client.mjs`, `orbit-client.mjs`, `lib/providers.mjs`, `lib/routes/connections.mjs` | `providers.js` |
| Nhóm Seedance: chia nhóm, timeline, prompt, storyboard | `lib/seedance.mjs`, `lib/routes/seedance.mjs` | `seedance.js` |
| Phân cảnh ghép: khung A/B/trung đôi, prompt ảnh khung, prompt cắt cảnh, một clip Veo | `lib/merged.mjs`, `lib/routes/merged.mjs` | `merged.js` |
| Thư viện video, ZIP, file media | `lib/media.mjs`, `lib/routes/files.mjs` | `gallery.js` |
| Hàng đợi, canh worker mất kết nối | `lib/routes/jobs.mjs`, `lib/runner.mjs` | `jobs.js` |
| Bài hát ở thanh bên | `lib/routes/nodes.mjs` (upload) | `render.js` |

Quy tắc giữ các chức năng tách biệt:
- File nào cần hàm của file khác thì `import` rõ tên hàm đó. Muốn biết sửa một hàm
  ảnh hưởng tới đâu, tìm tên hàm trong `lib/` hoặc `public/js/`.
- Project đang mở là biến `db`, chỉ được gán lại trong `lib/projects.mjs`. Các file
  khác chỉ đọc và sửa bên trong nó.
- Trạng thái giao diện dùng chung nằm trong `store` (`public/js/store.js`):
  `store.state`, `store.selected`, `store.dirty`. Biến chỉ một chức năng dùng thì để
  trong file của chức năng đó.
- Thêm API: thêm một khối `if (p === '/api/…')` vào file nhóm phù hợp trong
  `lib/routes/`. Mỗi file nhóm trả `NEXT` cho đường dẫn không phải của nó.
- Thêm phần giao diện: tạo file trong `public/js/` rồi `import` nó trong `main.js`.
- Chạy `npm test` sau mỗi lần sửa: 8 bộ test chạy server thật qua HTTP.

## Phần chạy được
- Prompt gắn với mỗi node; kế thừa mô tả và ảnh tham chiếu.
- Upload media, xem lại ảnh/video, chỉnh lời hát và thời gian từng shot.
- Prompt chuyển động nhúng lời hát, pace và đuôi cấm hiện chữ.
- Hàng đợi local, khóa một job chạy tại một thời điểm, chặn gửi trùng.
- Theo dõi worker; mất kết nối cần kiểm tra thay vì tự tạo lại có thể tốn lượt.
- Xuất JSON gồm prompt, thời gian, ảnh tham chiếu và metadata.
- Đăng nhập Orbit và đọc nick, workflow, flow theo quyền người dùng; lưu lựa chọn riêng từng node.

## Chưa chạy được
Chưa có kịch bản cụ thể trên website tạo ảnh/video và chưa có handler Orbit thật.
Nút Tạo ảnh/video hiện xếp hàng chờ worker; không đồng nghĩa đã gửi sang Orbit.
Không chạy orbit-handler.example.mjs như một kịch bản sản xuất: nó chỉ là hợp đồng mẫu.
Chưa có căn lời/audio tự động, lip-sync thật, ghép phim hay chỉnh graph kéo thả.
Timeline 3 × 8 giây chỉ là mẫu. Prompt consistency không bảo đảm model giữ đúng nhân vật.

## Điểm tích hợp đã đối chiếu với Hub
- GET /api/profiles và GET /api/flows: danh sách nick / khối kịch bản.
- POST /api/profiles/{id}/launch: mở nick.
- POST /api/profiles/{id}/run-flow: {flow_id, vars} hoặc {flow, vars}.
- GET /api/profiles/{id}/flow-progress: tiến độ.
- GET /api/profiles/{id}/downloads và /downloads/{name}: file kết quả.
run-flow đợi kết thúc và có thể hủy flow cũ trên cùng nick; phải kiểm tra nick rảnh
trước khi gọi. Chưa tự chọn nick hoặc chạy flow đang có của người dùng.

Để nối kịch bản thật: xác định website, nick, flow; ánh xạ prompt và ảnh tham chiếu
vào vars; xử lý upload ảnh đến đúng máy chạy trình duyệt; lấy đúng file của job.
Không truyền URL 127.0.0.1 cho một worker trên máy khác vì worker không truy cập được.
Sau khi có handler đã kiểm chứng, chạy:

    node worker-bridge.mjs orbit-handler.mjs

Handler export runJob(payload, context), trả {filePath, mime}.
Worker tải ảnh đầu vào qua context.downloadReference(asset).
Token worker tự sinh trong data/worker-token.txt; không chia sẻ thư mục data.
Server chỉ lắng nghe loopback, không mở cổng ra mạng LAN.

Kiểm tra: node test.mjs — kiểm thử xác thực worker, validation, kế thừa prompt,
ảnh đầu vào cũ, chống job trùng, chạy tuần tự và xử lý tác vụ gián đoạn.

## Cập nhật bộ thực thi Orbit
Bộ thực thi trực tiếp đã được bật: đăng nhập lại sẽ tiếp tục các job đang chờ
của đúng tài khoản. Mỗi job kiểm tra nick bận, mở nick, truyền prompt/mv_prompt,
mv_job_id, mv_kind, mv_duration và gọi đúng workflow/flow đã chọn.
Workflow dùng async=true, force=false và theo dõi flow-progress.
Không tự gửi lại khi timeout hoặc lỗi không rõ kết quả.
Trạng thái script_completed nghĩa là Orbit báo chạy xong, chưa phải đã nhập media.
Chưa ánh xạ các biến đặc thù của kịch bản hoặc upload ảnh tham chiếu; script phải
đọc biến prompt/mv_prompt hoặc dùng dữ liệu mặc định có sẵn của chính nó.
Test bộ chạy: node test-runner.mjs (Hub giả lập).
