# Khuôn hình project (aspect ratio)

Một cài đặt duy nhất quyết định tỉ lệ khung cho **mọi ảnh tham chiếu, mọi khung hình và video
cuối**. Đặt ở **Cài đặt project → 🖼 Khuôn hình**.

## Vì sao cần

Trước đây tỉ lệ nằm rải rác ở **4 nhóm chỗ**, nên cùng một project có ảnh 16:9 lẫn 9:16:

| Chỗ | Trước |
|---|---|
| Mặc định Seedvis | `'16:9'` ghi cứng trong `seedvis-client.mjs` |
| Payload của worker | `'16:9'` ghi cứng 4 lần trong `lib/jobs.mjs` (ChatGPT / Google Vids / Muse / Orbit) |
| Node sinh tự động | `'16:9'` trong `lib/seedance.mjs` và `lib/routes/music.mjs` |
| **Nội dung prompt** | `"cinematic 35mm, 16:9"` trong `lib/merged.mjs`, và 4 chỗ trong `lib/prompts.mjs` |

Nhóm cuối là thứ dễ bỏ sót nhất: dù tham số gửi model là 9:16, **câu prompt vẫn bảo model vẽ 16:9**.

## Giờ hoạt động thế nào

`lib/aspect.mjs` là nguồn chân lý duy nhất:

- `projectAspect()` → `db.defaults.aspect`, mặc định `16:9`.
- `aspectPhrase()` → `"9:16 vertical"` / `"16:9 horizontal"` / `"1:1 square"` để nhét vào câu prompt.

Mọi chỗ ở bảng trên đều đọc từ đây.

## Khi đổi khuôn hình

`PATCH /api/project` với `defaults.aspect`:

1. Lưu vào project **và** app-wide (project mới kế thừa — `writeAppDefaults`).
2. **Ghi đè `aspectRatio` của MỌI node đã có binding Seedvis riêng.** Không làm bước này thì các
   node từng tự chọn model vẫn giữ khuôn cũ — đúng cái đã gây ra tình trạng lẫn lộn.
3. Gọi `markAll()` → ảnh/video đã tạo bị đánh dấu **cần làm lại**, vì chúng đang ở khuôn cũ.

Model nào không hỗ trợ tỉ lệ đã chọn thì `validateSeedvisBinding` tự lùi về tỉ lệ đầu tiên model
đó nhận — chỉ `16:9` và `9:16` là mọi model đều có.

## Lưu ý

- Preset **Style** là văn bản của bạn. Nếu trong đó tự ghi `"vertical 9:16"` mà project để 16:9 thì
  hai bên đá nhau — sửa preset cho khớp, tool không tự viết lại chữ bạn đặt.
- Khi **sửa ảnh** (`edit`), tỉ lệ bám theo ảnh gốc (`nearestAspect`), không theo project — cố ý,
  vì một lần sửa phải giữ nguyên khung của ảnh đang sửa.

## Kiểm tra

```powershell
node test-aspect.mjs
```

Phủ: mặc định 16:9; đổi sang 9:16 thì node có binding riêng cũng theo; media khuôn cũ bị đánh dấu
làm lại; **nội dung prompt đổi theo và không sót `16:9`**; node mới kế thừa; tỉ lệ không hợp lệ bị
bỏ qua; đổi lại áp ngay.
