# 0.5.19 — ràng buộc video với đúng prompt hiện tại

## Nguyên nhân

Muse có thể dựng lại một video cũ bằng thẻ `<video>` mới và URL `blob:` mới sau khi gửi. Vì cả node lẫn URL đều mới, baseline của 0.5.18 chưa đủ để nhận ra đó vẫn là kết quả cũ.

## Sửa

- Tìm chính tin nhắn người dùng chứa prompt của job hiện tại trong transcript.
- Chỉ nhận player nằm sau tin nhắn prompt đó trong thứ tự DOM.
- Loại video cũ nằm trước prompt, kể cả khi React dựng lại toàn bộ thẻ video và blob.
- Loại player mới được gắn trực tiếp vào một container cũ, trừ khi container có nhãn kết quả/assistant rõ ràng.
- Không lấy URL video từ một JSON response chung vì response có thể chứa tài sản của các lượt chat trước.
- Giữ các lớp bảo vệ trước: baseline URL/node, loại intro/autoplay/landing và loại video trong tin nhắn người dùng.

## Kiểm thử

Có kiểm thử mô phỏng đúng lỗi: video cũ trước prompt bị React thay bằng node và blob mới; extension bỏ qua nó nhưng vẫn nhận video mới nằm sau prompt.
