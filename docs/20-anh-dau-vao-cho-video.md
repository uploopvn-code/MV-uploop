# Ô chọn "Ảnh đầu vào cho video"

Mỗi shot chọn một trong hai nguồn ảnh cho lượt render video:

| Lựa chọn | Gửi gì cho model |
|---|---|
| **Ảnh của node này (keyframe)** — mặc định | 1 ảnh: khung hình đã render của chính shot |
| **Ảnh từ node nối vào** | Toàn bộ ảnh của các node nối vào (nhân vật, bối cảnh, đạo cụ…) |

Ngoại lệ **duy nhất**: số ảnh nối vào vượt trần của model video (Veo nhận 3) thì không có cách
nào gửi hết, nên shot buộc phải dựng một keyframe rồi quay từ đó. Ô chú thích nói rõ điều này.

## Hai lỗi đã sửa

### ① Lựa chọn bị bỏ qua khi node đã có ảnh render

Luật cũ là `videoInput === 'refs' && !n.image`, kèm comment ghi rõ ý đồ:

> *"Once the node has composed its own image, that exact keyframe drives the video — refs only
> seed it beforehand."*

Nghĩa là `refs` chỉ có tác dụng **khi node chưa có ảnh**. Vừa render ảnh khung xong là lựa chọn
hết hiệu lực — ô chọn trông như hỏng.

Tệ hơn: luật đó được **chép ở 4 chỗ** (`jobs.mjs`, `prompts.mjs`, `stage3d.mjs`, `auto.mjs`).
Giờ cả bốn gọi chung **`videoRunsFromRefs(n)`** trong `lib/providers.mjs`:

```js
export const videoRunsFromRefs = n => n?.videoInput === 'refs' && !videoNeedsKeyframe(n);
```

### ② Đổi ô chọn không hề lưu

`#videoInput` chỉ cập nhật chú thích; giá trị mới chỉ xuống server khi bấm **Lưu** (hoặc **Tạo
video**, vì nó gọi `saveNode()` trước). Đổi xong rồi rời đi là mất, không báo gì — trông y hệt
lỗi ①. Đây là ô chọn **chế độ**, nên giờ nó lưu ngay khi đổi.

## Mặc định và dữ liệu cũ

`director.mjs` trước đây dựng mọi shot với `videoInput: 'refs'`, dựa vào luật `&& !n.image` để
tự chuyển sang keyframe sau khi có ảnh. Khi cờ này đúng nghĩa đen thì mặc định đó sai, nên:

- shot mới dựng từ blueprint mang **`'self'`** (quay từ ảnh khung đã render — khung đã duyệt,
  và là cách duy nhất giữ bố cục/ánh sáng giữa ảnh và video);
- **phân cảnh ghép ⑦ vẫn là `'refs'`** — các frame của nó CHÍNH LÀ ảnh tham chiếu;
- `normalize()` migrate một lần: shot cũ nào mang `'refs'` mà **đã có ảnh** chuyển về `'self'`,
  giữ nguyên hành vi mà project đó vẫn đang chạy. Đánh dấu bằng `d.videoInputMigrated`.

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/providers.mjs` | `videoRunsFromRefs()` — luật duy nhất, 4 chỗ kia gọi vào |
| `lib/jobs.mjs` | `videoFromRefs` dùng helper; lỗi "chưa có ảnh" nói đúng lý do khi vượt trần |
| `lib/prompts.mjs`, `lib/stage3d.mjs` | `fromKeyframe` dùng helper |
| `lib/auto.mjs` | Đủ-điều-kiện chạy tự động: refs trong trần → gửi thẳng; vượt trần & chưa có ảnh → dựng keyframe trước |
| `director.mjs` | Shot mặc định `'self'` (phân cảnh ghép giữ `'refs'`) |
| `lib/projects.mjs` | Migrate một lần cho project cũ |
| `public/js/inspector.js` | Ô chọn lưu ngay; chú thích nói đúng cho từng chế độ |
| `public/locales/*.json` | `inspector.referenceVideoInput` viết lại (bỏ "Node chưa có ảnh") |

## Bẫy

> ⚠ Đổi ý nghĩa một cờ đã lưu trong dữ liệu thì **phải migrate**, nếu không mọi project cũ lặng
> lẽ đổi hành vi. Ở đây mọi shot đều mang `'refs'` nên nếu không migrate thì tất cả sẽ chuyển
> sang gửi ảnh tham chiếu — ngược hẳn thứ người dùng vẫn thấy.

> ⚠ Luật bị chép ở 4 chỗ chính là lý do lỗi này sống lâu. Thêm nhánh mới thì sửa
> `videoRunsFromRefs`, đừng viết lại điều kiện.

## Kiểm thử

```powershell
node test-video-input.mjs
```

Chạy thật, đếm **số ảnh thực sự gửi lên model** ở từng lượt: mặc định 1 ảnh keyframe → chọn
refs khi node **đã có** ảnh render thì gửi đúng 3 ảnh của các node nối vào (lỗi cũ) → đổi lại
thì về 1 ảnh → nối thêm node cho vượt trần thì lại về 1 ảnh keyframe.
