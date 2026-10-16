# 0.5.36

- Google Vids chạy được job khớp miệng (lip-sync) theo kiểu video-to-video: mở bảng "AI video clip", vào tab **Edit**, tải lên video nguồn (ảnh khung + vocal đã ghép) rồi điền prompt Omni và bấm tạo.
- Worker tải video nguồn của take từ server (/media) trước khi lên Google Vids; job lip-sync bỏ qua đường replay (replay không đính được video vừa tải lên).
- Mỗi bước của tab Edit (mở bảng, chọn Edit, tải video, điền prompt, bấm gửi) báo rõ đang ở đâu để dễ dò khi Google Vids đổi giao diện.
