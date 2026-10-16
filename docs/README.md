# Tài liệu Drama Tool

Tài liệu được chia theo module để cập nhật độc lập:

- [Tổng quan workflow](./01-workflow.md)
- [Tạo ảnh và video theo khu vực](./02-batch-video.md)
- [Web Worker và Muse Chat](./03-extension-workers.md)
- [Timeline dựng và xem video](./04-video-timeline.md)
- [Command Console](./05-command-console.md)
- [Render Queue và nhiều tài khoản](./06-render-queue-accounts.md)
- [Undo và Timeline](./07-undo-timeline.md)
- [Đa ngôn ngữ](./08-localization.md)
- [Đóng gói project thành ZIP](./09-project-package.md)
- [Hướng dẫn AI viết phim và xuất blueprint JSON](./10-ai-film-blueprint-guide.md)
- [OBRION · Xưởng kịch bản, shot JSON và timeline OTIO](./12-obrion-studio.md)
- [Phân cảnh ghép · nhịp cắt · nhận dạng nhân vật](./13-phan-canh-ghep-nhan-dang.md)
- [Node Kịch bản (SCRIPT) · xưởng viết kịch bản trong tool](./14-node-kich-ban.md)
- [Khuôn hình project (aspect ratio)](./15-khuon-hinh-project.md)
- [DNA giọng nói (voice lock)](./16-dna-giong-noi.md)
- [Cột ⓪ START và hệ thống hướng dẫn](./17-start-va-huong-dan.md)
- [Phim dài trong một project · trần node 400 · dọn lịch sử job](./18-phim-dai-mot-project.md)
- [Tự sửa prompt khi model video từ chối · sổ học của agent](./19-tu-sua-prompt-bi-tu-choi.md)
- [Ô chọn "Ảnh đầu vào cho video" (keyframe vs ảnh node nối vào)](./20-anh-dau-vao-cho-video.md)
- [Gói giao hàng · video theo thứ tự cảnh + 7 bước kịch bản](./21-dong-goi-giao-hang.md)
- [Thư viện SKILL theo thể loại · trợ lý can thiệp từng bước](./22-thu-vien-skill.md)
- [MV từ file nhạc · máy đo, LLM viết, hai luồng](./23-mv-tu-file-nhac.md)
- [Chạy LLM bằng gói Claude Pro/Max (không cần API key)](./24-claude-goi-max.md)
- Skill Claude cho blueprint phim: `.claude/skills/drama-tool-film-blueprint/` (bản ZIP ở gốc repo).
- Command Console hỗ trợ alias English, Vietnamese, Chinese, Japanese và Korean; English là khóa nội bộ.
- Locale được kiểm tra bằng `node test-i18n.mjs` (parity key giữa 5 ngôn ngữ và alias Command Console).
- [Orbit và giao thức I/O](../Orbit-IO-contract.md)

## Quy tắc quan trọng hiện tại

- Batch video chỉ bỏ qua node chưa có ảnh hoặc node đã có video đầu ra.
- Ảnh cũ, ảnh mới, ảnh stale và node cần kiểm tra vẫn được phép chạy lại nếu chưa có video.
- Shot thuộc Seedance group vẫn có thể render độc lập.
- Muse Chat giới hạn 10 luồng trên mỗi tài khoản/worker profile; nhiều tài khoản được cộng dồn.

## Command Console nâng cao

- Đổi provider theo vùng: `Đổi toàn bộ video Production sang Muse Chat`.
- Nối theo tên: `Nối Main Stage vào các shot Chorus`.
- Điều kiện: `Bỏ qua shot cận mặt`, `Chỉ chạy node có ảnh`.
- Mọi lệnh thay đổi graph đều hiện preview và yêu cầu xác nhận trước khi áp dụng.
- `undo` hoàn tác graph, provider hoặc thứ tự node; video đã render thành công không bị xóa.

## Đa ngôn ngữ

UI và alias lệnh dùng English làm khóa nội bộ, hiện có Vietnamese, English, Chinese, Japanese và Korean. Đổi ngôn ngữ ở bộ chọn trên thanh tiêu đề; các Canvas, Inspector, Gallery, Timeline, Queue và panel dựng sẽ cập nhật theo locale.

Kiểm tra parity locale và alias:

```powershell
node test-i18n.mjs
```
