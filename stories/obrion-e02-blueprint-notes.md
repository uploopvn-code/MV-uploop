# Note nhập tool · Obrion Tập 2

## File

- Bible dùng chung: [obrion-e02-bible.json](../examples/obrion-e02-bible.json).
- Năm phân đoạn: [01](../examples/obrion-e02-seq01.json), [02](../examples/obrion-e02-seq02.json), [03](../examples/obrion-e02-seq03.json), [04](../examples/obrion-e02-seq04.json), [05](../examples/obrion-e02-seq05.json).
- Nguồn biên tập: [bản phân cảnh 10 giây](./obrion-episode-02-10s-cut-sheet.md). Script tạo lại file: [build-obrion-e02-blueprints.mjs](../scripts/build-obrion-e02-blueprints.mjs).

## Cách import và tái dùng ảnh

1. Tạo **năm project Phim khác nhau**, mỗi project có một thư mục làm việc riêng. Không dựng nhiều phân đoạn lên cùng một project vì thao tác dựng blueprint thay graph hiện có.
2. Trong từng project, vào **Đạo diễn → Chọn file JSON**, chọn cùng lúc `obrion-e02-bible.json` và **một** `obrion-e02-seq0X.json`, rồi xác nhận **Dựng sơ đồ**. Không chọn một mình Bible (không có shots), cũng không chọn cả năm sequence (quá trần 200 node).
3. `film.title` là `THE RECKLESS NEWCOMER / OBRION`, giống Tập 1. Asset Ami giữ `key: "ami"` và cùng định nghĩa model sheet của blueprint Tập 1. Các nhân vật/bối cảnh Tập 2 giữ key không đổi trong cả năm project. Nếu bạn đã có ảnh Ken/Gamma dưới key khác trong project trước, cần đổi key ở Bible hoặc nạp thủ công đúng asset; tên hiển thị giống nhau **không đủ** để tự ghép.
4. Vì project mới có thư mục làm việc riêng, sau import hãy dùng **Đạo diễn → Lấy ảnh từ project khác** cho những asset đã render trong project cùng phim. Nếu project cũ không có `film.title` tương ứng, app sẽ không tự nhận; khi đó nhập ảnh từ thư mục nguồn hoặc tải lên node.

## Kỹ thuật dựng

- Mỗi file sequence chứa **90 shot**, hợp thành 30 cảnh dựng × 10 giây. Mốc `start` tính cục bộ 0–300 giây; đặt năm phân đoạn nối nhau ở 00, 05, 10, 15 và 20 phút trong bản dựng tập.
- Một cảnh 10 giây được tách thành ba shot có `scene_id` chung và duration cộng đúng 10 giây. App tạo video từ từng shot; duration trong JSON là **ý đồ timeline**, không cam kết provider xuất file đúng 3–4 giây. Kiểm metadata, cắt đầu/cuối và ráp trên Timeline sau render.
- Prompt shot chứa hành động tiếng Việt từ cut sheet cùng chỉ dẫn kỹ thuật tiếng Anh. Duyệt các câu thoại và các shot nặng về hành động trước khi phát lệnh hàng loạt. App chưa tự tạo phụ đề hay mix âm liên tục chính xác theo JSON này.
- Kiểm tra tự động: [test-obrion-e02-blueprints.mjs](../scripts/test-obrion-e02-blueprints.mjs) đã dựng thử từng cặp Bible + sequence: mỗi graph 119 node, 0 cảnh báo, dưới trần 200 node.
