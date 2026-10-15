# Bản án của ánh sáng (The Light Horizon)

Blueprint JSON chuẩn Drama Tool cho phim sci-fi drama ~30 phút, chia **4 hồi × 45 shot = 180 shot**.
Kết dùng **bản Mai còn sống** (đèn hiệu + giữ lời hứa ở cửa lớp), Hồi 1–3 bám khoa học/cấu trúc kịch bản gốc.

## File

| File | Nội dung | Số shot | Thời lượng |
|------|----------|--------:|-----------:|
| `hoi1.json` | Hồi 1 – Nghịch lý dưới lòng đất mẹ (hang karst, giảng khoa học) | 45 | 7:30 |
| `hoi2.json` | Hồi 2 – Miền sương khói & lễ xuất hành (chia tay + phóng tàu + warp) | 45 | 7:24 |
| `hoi3.json` | Hồi 3 – Vết nứt thời gian & bản án song song (sự cố + montage Mai già đi) | 45 | 7:26 |
| `hoi4.json` | Hồi 4 – Kẻ lưu đày và lời hứa muộn (hồi hương 2085 + đoàn tụ) | 45 | 7:22 |
| `bible.json` | Bible dùng chung (nhân vật/bối cảnh/đạo cụ/style/camera/audio) – chỉ để tham khảo/tái dùng | – | – |

Mỗi `hoiN.json` **tự chứa đầy đủ** (đã gộp sẵn bible + shot của hồi đó), import độc lập được ngay.

## Cách import

> ⚠️ Mỗi lần import vào Director > Blueprint sẽ **ghi đè graph hiện tại** và reset job. Vì phim 30 phút vượt sức một project (trần 400 node/project), mỗi hồi là **một project riêng**.

1. Tạo/mở một project trống cho Hồi 1 → Director > Blueprint → dán toàn bộ nội dung `hoi1.json` → Dựng.
2. Tạo project riêng cho Hồi 2, dán `hoi2.json`… tương tự Hồi 3, Hồi 4.
3. Vì các hồi dùng **chung key nhân vật/bối cảnh/đạo cụ** (tien, bemai, cubamai, maitruongthanh, aria, sc_*, pr_*), tool có thể tái dùng ảnh model-sheet đã render giữa các project.
4. Sau khi dựng: render ảnh assets → render clip → kiểm timeline → dựng/mix/xuất MP4. Nối 4 project ở khâu dựng cuối.

## Nhân vật (key cố định)

- `tien` (NV1) – Tiến, tiến sĩ vật lý, áo khoác rêu. Trang phục đổi: `wb_tien_linen` (áo đũi, bên vịnh), `wb_tien_suit` (đồ phi hành, trên tàu).
- `bemai` (NV2) – Bé Mai 8 tuổi; `maitruongthanh` (NV5) – Mai trưởng thành; `cubamai` (NV3) – cụ bà Mai 68. Neo nhận dạng chung: **nốt ruồi đuôi mắt trái**.
- `aria` (NV4) – lõi AI cyan (không mặt người).

## Vật dụng (node dùng lại, nối vào mọi shot xuất hiện >3 lần)

- `pr_dongho` – đồng hồ cơ Poljot (motif xuyên phim).
- `pr_anhgiadinh` – ảnh gia đình trên cầu.
- `pr_denhieu` – đèn hiệu mặt đất.
- `pr_tau` – tàu Chronos-1 (vành Toroid + thân) — nối vào ~32 shot ngoại cảnh tàu để giữ nhất quán thiết kế.
- `pr_khoang` – khoang hồi quyển cháy xém (Hồi 4, 4 shot).
- `pr_donghont` – cặp đồng hồ nguyên tử quang học (Hồi 1, 4 shot).

> Cụm hội thoại ghép (`setups`) cố ý KHÔNG mang prop: tool chỉ dựng khung từ bối cảnh + 2 nhân vật. Prop cần nổi bật đã được tách thành shot insert riêng.

## Lưu ý

- Cụm hội thoại ghép (`setups`) là clip 8 giây, tool tự dựng các cỡ cảnh — không có `videoPrompt` riêng là đúng chuẩn.
- Thoại để tiếng Anh cho khớp khẩu hình (lip-sync); tên/nhãn tiếng Việt.
- `beat_sheet`, `continuity_note`… là ghi chú biên tập, không điều khiển render; yêu cầu hình đã nằm trong `videoPrompt`/scene/camera.
- Toàn bộ nhân vật là hư cấu (đã ghi disclaimer trong prompt model-sheet).

Đã kiểm bằng `buildGraph` thật của tool: 0 lỗi, 0 cảnh báo, mỗi hồi 87–96/400 node, không dây lạc.
