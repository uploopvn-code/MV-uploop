# Ngôn ngữ điện ảnh cho Drama VEO

Bảng tra để chọn đúng cỡ cảnh, chuyển động máy, ánh sáng, nhịp và biểu cảm cho từng shot. Mỗi lựa chọn phải phục vụ một mục tiêu tâm lý — drama không có shot "cho đẹp".

## Mục lục
1. Cỡ cảnh chuyên dụng cho drama
2. Chuyển động máy VEO (camera moves)
3. Ánh sáng tâm lý & tông màu
4. Quy tắc trục 180 độ & blocking quyền lực
5. Beat sheet 5 nhịp & phân bổ thời lượng
6. Đường cong cảm xúc & pacing theo nhịp
7. Ma trận biểu cảm (expression matrix)

---

## 1. Cỡ cảnh chuyên dụng cho drama

| Cỡ cảnh | Khi nào dùng | Hiệu ứng tâm lý |
|---|---|---|
| Two-Shot (2 người trong khung) | Mở màn đối thoại, xác lập tương quan | Thấy rõ khoảng cách & thế đối đầu giữa 2 nhân vật |
| OTS — Over-The-Shoulder (qua vai) | Đối thoại căng thẳng | Góc chuẩn mực, kéo khán giả vào thế của người nghe |
| Shot-Reverse-Shot (cắt luân phiên) | Trao đổi lời qua lại | Cận phản ứng mặt người A khi nghe người B — tăng áp lực |
| Medium Close-Up (bán thân cận) | Lời chất vấn, dò xét | Đủ gần để đọc vi biểu cảm, đủ xa để thấy thế ngồi |
| Extreme Close-Up / Macro | Khoảnh khắc nhận ra sự thật | Mắt giật, đồng tử co, mồ hôi rịn — nội tâm phơi bày |
| Low-Angle (góc thấp nhìn lên) | Nhân vật nắm quyền ở cao trào | Đối tượng thống trị khung hình, uy lực |
| High-Angle (góc cao nhìn xuống) | Nhân vật thế yếu | Đè nén, cô lập, dễ tổn thương |

## 2. Chuyển động máy VEO

VEO render mượt các chuyển động có chủ đích. Tránh pan/zoom ngẫu nhiên kiểu MV.

| Preset | Cấu hình gợi ý | Dùng cho |
|---|---|---|
| `slow horizontal truck` | Trượt ngang chậm qua bàn, DOF nông, giữ cả hai mặt nét căng | Mở cảnh đối thoại, dựng không khí |
| `creeping push-in` | Đẩy máy chậm dần vào gương mặt | Dồn áp lực, tiến tới quyết định |
| `slow push-in to eyes` | Đẩy rất chậm tới mắt, kéo giãn thời gian | Khoảnh khắc REVEAL / nhận ra sự thật |
| `over-the-shoulder lock` | Khóa sau vai, nhẹ rung cảm xúc | Đối thoại căng qua vai |
| `shot-reverse-shot` | Cắt luân phiên 2 cận cảnh đối diện | Lời qua tiếng lại, cao trào |
| `dutch angle tilt` | Nghiêng trục ngang 8–15° | Báo hiệu dối trá, mất cân bằng, nguy hiểm |
| `macro rack-focus` | Lấy nét dời từ đạo cụ sang mặt | Hé lộ vật chứng (điện thoại, nhẫn) |
| `low-angle pedestal` | Nâng máy từ thấp lên, bóng dọc như song sắt | Nhân vật đắc thắng khống chế đối phương |

## 3. Ánh sáng tâm lý & tông màu

Ánh sáng là nội tâm nhìn thấy được.

| Phong cách | Mô tả | Hợp với |
|---|---|---|
| Chiaroscuro / Film Noir | Tương phản sáng–tối gắt, nửa mặt sáng nửa tối | Nhân vật có dã tâm, che giấu bí mật |
| Cool Clinical / Desaturated | Xanh lạnh, nhạt màu | Gia đấu, công sở tàn nhẫn, điều tra phản bội |
| Warm Amber Chandelier | Đèn chùm hổ phách ấm, pool sáng tập trung | Bàn tiệc kỷ niệm có vết nứt ngầm |
| Motivated Light | Sáng rọi qua khe rèm, đèn đường qua kính xe mưa | Gợi hiện thực, tạo chiều sâu bối cảnh |

Khai `lighting_profile` trong mỗi scene và nhắc lại trong `Lighting & Physics` của videoPrompt để ánh sáng không nhảy giữa các shot.

## 4. Quy tắc trục 180 độ & blocking quyền lực

**Trục 180°:** kẻ một đường tưởng tượng nối 2 diễn viên; mọi máy đứng về *một* bên đường đó. Nếu nhảy sang bên kia, hướng nhìn hai người sẽ cùng chiều và hội thoại trông như hỏng. Ghi hướng nhìn vào `axis_180`:
- Ví dụ đúng: `@wife nhìn phải→trái, @husband nhìn trái→phải` (hai người "nhìn vào nhau" khi cắt luân phiên).

**Blocking quyền lực:** vị trí vật lý kể chuyện trước cả thoại.
- Đứng cao / đầu bàn = nắm quyền. Ngồi thấp / co người = thế yếu.
- Khoảng cách gần = thân mật hoặc đe dọa; xa = lạnh nhạt, rạn nứt.
- Quay lưng = từ chối, trốn tránh. Tiến tới = áp đảo.

## 5. Beat sheet 5 nhịp & phân bổ thời lượng

| Nhịp | Nội dung | % thời lượng |
|---|---|---|
| Setup | Thiết lập thế giới, quan hệ, vẻ ngoài bình yên có vết nứt | ~15% |
| Tension Rising | Căng thẳng leo thang, nghi ngờ nhen lên, dò xét | ~35% |
| Confrontation / Climax | Đối đầu trực diện, lời chất vấn nổ ra | ~25% |
| Reveal / Twist | Lật mở bí mật, cán cân quyền lực đảo chiều | ~15% |
| Aftermath | Dư âm, tâm trạng còn lại, câu kết lạnh | ~10% |

Co giãn ±5% tùy chuyện. Phim ngắn (dưới 60s) có thể gộp Setup vào Tension.

## 6. Đường cong cảm xúc & pacing theo nhịp

`emotional_value` mỗi shot: thang -5 (dồn nén/thấp nhất) đến +5 (bùng nổ/cao nhất). Chuỗi phải vẽ đường leo rồi đổ, không đi ngang.

Ví dụ đường cong 8 shot (180s):
`-1 (setup) → -2 → +1 → +2 (tension) → +4 (climax) → +5 (climax đỉnh) → +3 (reveal, lạnh) → -3 (aftermath)`

Pacing bám nhịp:
- Setup: shot dài 6–7s, máy thong thả, hai-shot.
- Tension: shot vừa 5–6s, bắt đầu push-in, dò xét.
- Climax: shot ngắn 4–5s, shot-reverse-shot, cắt nhanh.
- Reveal: một slow push-in 6–7s kéo giãn thời gian.
- Aftermath: shot dài, máy đứng yên hoặc lùi ra, để lại khoảng lặng.

## 7. Ma trận biểu cảm (expression matrix)

Mỗi nhân vật khai 3–4 trạng thái, mỗi trạng thái là một câu tả cơ mặt tái dùng được trong `videoPrompt`. Ngân hàng trạng thái thường gặp:

- **Kìm nén** — "jaw clenching, lips pressed thin, eyes welling with tears but not falling" (nghiến hàm, môi mím, ngấn lệ không rơi).
- **Nghi ngờ / dò xét** — "suspicious side-eye, one brow subtly raised, chin tilted" (liếc dò, nhướn mày, hất nhẹ cằm).
- **Sụp đổ / bàng hoàng** — "shocked realization, trembling lips, pupils dilating, color draining" (bàng hoàng, môi run, đồng tử giãn).
- **Đắc thắng lạnh lùng** — "a subtle lethal smirk at the corner of the mouth, serene composure" (nhếch môi chết người, điềm tĩnh).
- **Hoảng loạn che giấu** — "shallow rapid breathing, throat gulping, eyes darting under a forced calm" (thở nông gấp, nuốt khan, mắt đảo dưới vẻ bình tĩnh gượng).

Chọn trạng thái khớp beat: dò xét ở Tension, bùng ở Climax, bàng hoàng/đắc thắng ở Reveal.
