# 0.5.24 — không tải preview hoặc ảnh tham chiếu khi ChatGPT còn tạo

## Nguyên nhân

Ở 93% (`One last tweak...`), API có thể đã công bố asset của tool nhưng lượt assistant chưa hoàn tất. Asset trung gian đó có thể là ảnh tham chiếu. 0.5.23 thử tải asset quá sớm khi `async_status` vẫn bận.

## Sửa

- Chỉ tải asset API khi lượt assistant đã `finished` và conversation đã `idle`.
- Vẫn kiểm tra API mỗi 1,5 giây nên ảnh được tải trong tối đa khoảng một chu kỳ sau khi hoàn tất thật.
- DOM chỉ là đường dự phòng khi API không dùng được.
- DOM chỉ nhận marker ảnh tạo chính thức, không nhận ảnh thông thường trong assistant turn.
- Bỏ qua mọi màn hình còn phần trăm, progress bar, `One last tweak`, trạng thái tạo ảnh hoặc streaming.
- Ảnh DOM phải hoàn chỉnh và ổn định ít nhất 3 giây.

## Kiểm thử

Có kiểm thử asset trung gian không được tải khi API còn busy, và màn hình `One last tweak... 93%` phải được nhận diện là chưa hoàn tất.
