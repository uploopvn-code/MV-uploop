# 04 · Timeline dựng và xem video

Timeline nằm dưới canvas trong tab Studio.

## Nội dung timeline

- Hiển thị shot/take có video render thành công ở chính node hoặc ở node đầu ra. Mặc định dùng version mới nhất; nếu người dùng đã chọn một version trên canvas thì timeline dùng đúng version đó.
- Sắp xếp theo stream và vị trí dựng của từng đoạn (mặc định là mốc thời gian của shot).
- Làn A là phủ cảnh/sản xuất; làn B là hát nhép.
- Khi đã có video đầu ra, shot chưa có video không xuất hiện trong phần xem trước. Trước khi có video nào, timeline vẫn hiện các shot theo mốc thời gian để bố trí.

## Thumbnail và phát

Mỗi block dùng khung hình đầu của video làm thumbnail. Nút **Phát toàn bộ** mở trình xem riêng dưới timeline và phát các clip đã render theo thứ tự thời gian. Nút **Dừng xem** dừng danh sách phát. Trình xem nằm ngoài phần timeline vẽ lại định kỳ nên không bị tải lại giữa lúc phát.

Thanh điều khiển của trình xem cho phép:

- Phát/dừng clip.
- Kéo vị trí phát.
- Điều chỉnh âm lượng. Nếu project có bài hát, phần xem trước dùng bài hát theo mốc thời gian của từng clip.

Timeline là màn hình kiểm tra và dựng thứ tự nhanh; video gốc vẫn có thể xem/tải trong inspector và Gallery.

## Chọn version từ chồng video trên canvas

- Tất cả video render từ cùng một node được xếp thành một chồng duy nhất ở cột Video đầu ra; huy hiệu trên card hiển thị tổng số phiên bản.
- Bấm chồng video để làm tối canvas và mở toàn bộ phiên bản dưới dạng lưới thumbnail video có thanh phát.
- Có thể phát thử từng bản ngay trong cửa sổ. Bấm card hoặc nút **Dùng trên timeline** để chọn.
- Lựa chọn được lưu vào project trên node nguồn (`timelineClipId`) và lập tức thay video tương ứng trên timeline; các version còn lại vẫn được giữ nguyên.
- Nếu xóa đúng version đang dùng, timeline tự chuyển sang version mới nhất còn lại. Nếu không còn version nào, lựa chọn được xóa.

## Con trỏ và cắt clip

- Kéo con trỏ màu vàng trên thước thời gian hoặc bấm vào khoảng trống của track để xem khung hình ở mốc đó. Nút **Phát toàn bộ** bắt đầu từ vị trí con trỏ.
- Bấm một clip để chọn; nhập **Vị trí**, **Cắt đầu (In)** và **Cắt cuối (Out)** rồi bấm **Áp dụng cắt**. Có thể kéo hai tay nắm sáng ở mép clip để cắt trực tiếp.
- Đặt con trỏ giữa clip rồi bấm **Tách tại con trỏ** để tạo hai đoạn từ cùng file video. Chọn một đoạn và bấm **Bỏ đoạn** để gỡ đoạn đó khỏi timeline; file video gốc vẫn còn.
- Kéo cả clip trên track để thay đổi vị trí. Điểm In/Out và vị trí được lưu trên video đầu ra, không cắt lại file gốc hoặc đổi thông số render của shot.
- Điểm In/Out tính theo giây của file video; khi trình duyệt đọc được metadata, giới hạn cắt cuối theo thời lượng thực của file.

## Ghi chú cập nhật 2026-10-09

- Module canvas: `public/js/cards.js`, `public/js/canvas.js`, `public/style.css` — chồng video và cửa sổ chọn/phát phiên bản.
- Module timeline: `public/js/render.js` — ưu tiên version đã chọn thay vì luôn lấy bản mới nhất.
- Module API: `lib/routes/nodes.mjs` — lưu lựa chọn timeline mà không làm stale video hay tăng revision của graph.
