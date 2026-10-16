# Note sản xuất · Obrion E01 · Phân đoạn 01

Blueprint dùng để nhập: [obrion-e01-seq01.json](../examples/obrion-e01-seq01.json). Nguồn truyện: [Tập 1 — Vết nứt](./obrion-episode-01-five-segments.md), đoạn 00:00–05:00.

## Phạm vi

- `film.title`: `THE RECKLESS NEWCOMER / OBRION` — giữ **giống hệt** ở các phân đoạn sau để hỗ trợ nhận diện cùng phim.
- Project này chỉ chứa phân đoạn 1. Mốc shot tính **tương đối** từ 0 đến 300 giây; khi dựng 5 phân đoạn, đặt lần lượt vào timeline tập ở 00:00, 05:00, 10:00, 15:00, 20:00.
- 40 shot video 6–8 giây; 63 node, 205 dây nối khi chạy `buildGraph`; không có cảnh báo. Đây là **40 lượt render clip nếu chạy đủ**, có thể phát sinh chi phí provider. Chưa có job render nào được gửi.
- Asset nhân vật/xe/cảnh có `key` ổn định: `ami`, `squid_soldier`, `leviathan`, `bike86`, `squid_truck`, `city_gate`, `border`, `dead_sea`. Bốn phân đoạn sau phải dùng lại các key này nếu cùng thực thể. Các vật chỉ xuất hiện đoạn sau (Ken, Weirdo, Tamaya, thẻ ID…) cần thêm ở file sau, không dựng sớm ở đoạn 1.

## Cấu trúc nhịp

| Mốc cục bộ | Shot | Ý đồ |
| --- | --- | --- |
| 00:00–01:00 | 01–08 | Thành phố bó chặt → ranh giới mưa/cát → Ami nhỏ giữa sa mạc |
| 01:00–02:00 | 09–16 | Xe Squid bám sát, thấy kẻ đuổi là con người, Ami tìm dây cung |
| 02:00–03:00 | 17–24 | Ami chần chừ, mũi tên trượt, chiếc 86 trúng đạn và mất lái |
| 03:00–04:00 | 25–32 | Im lặng, mặt cát chuyển động, chiếc xe đầu bị nuốt |
| 04:00–05:00 | 33–40 | Ami văng khỏi xe, cố với tới lính Squid, rồi bị bóng Leviathan phủ kín |

## Ranh giới giữa blueprint và hậu kỳ

- Cảnh **màn đen mở đầu**, **hai giây hút sạch âm thanh** trước Leviathan và âm thanh đồng bộ chính xác cần chỉnh trong timeline/NLE. Trường `audio[].prompt` là chỉ dẫn cho render, không phải tự động hóa cắt/mix âm chính xác từng giây.
- Mẫu không render Ken hoặc cú bắn cứu Ami: đó là mở đầu phân đoạn 2. Shot 40 kết trên bóng Leviathan để giữ cliffhanger.
- Các góc máy thành phố dùng tele, sa mạc dùng siêu rộng tĩnh. Handheld chỉ bắt đầu khi Ami hoặc xe **thật sự mất thăng bằng**; không áp dụng rung cho toàn bộ cuộc đuổi bắt.
- Leviathan nên xuất hiện bằng dấu hiệu/fin/bóng và biến dạng địa hình, không quay toàn thân. Cú nuốt xe là xa và tránh cận cảnh thương tích; chất kinh hoàng đến từ quy mô và sự im lặng.
- Một vài video model khó giữ **chính xác 40 clip nối liền 300 giây** dù `start/duration` đúng trong graph. Sau render cần xem metadata duration, trim/retime ở Timeline và kiểm tra nhịp 5 phút thật.

## Cách nhập an toàn

Tạo project Film mới `Obrion E01 - Seq01` và chọn thư mục làm việc riêng. Vào **Đạo diễn → Bước 3 → Chọn file JSON**, chọn đúng file blueprint; thao tác chọn file sẽ dẫn đến xác nhận dựng graph. Dựng graph **thay toàn bộ node** của project hiện tại, nên không chọn project đã có công việc chưa sao lưu. Sau khi nhập, kiểm 40 shot/asset rồi mới tạo ảnh và render; không nhấn chạy toàn bộ khi chưa duyệt provider và chi phí.
