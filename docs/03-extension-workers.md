# 03 · Extension workers

Extension nhận job từ Drama Tool qua các endpoint worker:

`claim → heartbeat → complete/fail`

## Muse Chat

- Bật worker Muse Chat trong popup extension.
- Mỗi tài khoản/profile có worker ID riêng.
- Mỗi tài khoản chạy tối đa **10 luồng** Muse Chat.
- Nhiều tài khoản có thể chạy đồng thời; giới hạn được tính riêng từng worker ID.
- Job vượt giới hạn được giữ ở trạng thái queued và tự nhận khi có tab rảnh.
- Render Queue hiển thị worker ID, provider/site, trạng thái online, số Muse đang chạy và số job Muse đang chờ.
- Metadata worker được cập nhật ngay cả khi tài khoản chưa nhận job, nên tài khoản Muse nhàn rỗi vẫn hiện đúng giới hạn 10.

Server có thể thay đổi trần bằng biến môi trường:

```powershell
$env:MV_MUSECHAT_CONCURRENCY = "10"
npm start
```

## ChatGPT và Google Vids

- ChatGPT dùng các tab riêng và giới hạn theo cấu hình extension.
- Google Vids chạy tuần tự để tránh xung đột tài liệu/tab.
- Muse Chat, ChatGPT và Google Vids có thể bật độc lập.

## Khi nhiều tài khoản

Mỗi tài khoản nên chạy một Chrome profile hoặc một extension profile riêng, đăng nhập tài khoản tương ứng,
nhưng cùng trỏ về Drama Tool và worker token. Không dùng chung một worker ID giữa các tài khoản.

## Điều khiển theo nhóm

Trong Render Queue có thể Pause, Resume hoặc Retry theo provider. Retry chỉ đưa các job `failed` của
đúng nhóm trở lại `queued`; job đang chạy và video đã hoàn tất không bị thay đổi. `gvids` trên giao diện
được chuẩn hóa với site nội bộ `googlevids`.

## Lọc theo project

Render Queue có bộ chọn Project. Vì mỗi project có database và hàng đợi riêng, việc chọn project sẽ
chuyển sang queue của project đó qua cơ chế switch an toàn hiện có; không ghép job của nhiều project
vào cùng một queue. Project đang được mở ở cửa sổ khác không thể chọn trong cửa sổ hiện tại.
