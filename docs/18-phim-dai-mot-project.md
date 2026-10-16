# Phim dài trong MỘT project — trần node 400 và dọn lịch sử job

## Vấn đề

Một phim 15 phút = 900 giây ≈ 113 lượt render 8 giây. Đo mật độ thật của một dự án thoại nhiều
ở đây (51 node làm việc cho 120 giây) thì 15 phút cần khoảng **385 node**. Trần cũ là **200**,
nên phải chia thành 2–3 project riêng — mà tool **không có timeline hay export xuyên project**,
nghĩa là bản dựng 15 phút cuối cùng phải ghép bên ngoài.

Trần 200 không phải giới hạn kiến trúc: nó chỉ là hai dòng `if`. Không có chỗ nào trong data
model, canvas hay runner giả định một con số nào. Cái **thật sự** chặn phim dài là project
phình to: project là một file, giữ nguyên trong RAM, và browser gọi `/api/state` lại **mỗi 4
giây**.

## Đo trước khi sửa (dữ liệu thật, 24 project)

| Thành phần | Dung lượng | |
|---|---|---|
| Cả file project (243 node) | 2 810 KB | |
| → job | 1 967 KB | **86 %** |
| → riêng chữ `prompt` trong job | 825 KB | 36 % cả file |
| → `references` | 292 KB | |
| → node (thứ thật sự là đồ án) | 219 KB | 9 % |

Nói cách khác: cái làm project nặng không phải số node, mà là **lịch sử job** — mỗi job giữ
nguyên prompt đã gửi đi (~4 KB). Và `save()` ghi lại **toàn bộ** file mỗi lần có thay đổi.

## Ba thay đổi

### ① Trần node 200 → 400 — `lib/limits.mjs` (mới)

`NODE_CAP = 400`, `NODE_WARN = 250`, khai báo một chỗ để hai cổng chặn không lệch nhau:

- `director.mjs` — khi import/dựng blueprint
- `lib/routes/nodes.mjs` — khi thêm node tay

Clip đã render và node nhóm Seedance **không tính** vào trần (chúng là kết quả, không phải
node làm việc) — giữ nguyên quy tắc cũ.

`publicState()` gửi kèm `nodeBudget: { used, cap, warn }`; `public/js/render.js` hiện
`294/400 node` trên dòng trạng thái canvas khi đã qua mốc 250, và tô vàng (`.badge.warn`) khi
chạm trần.

### ② `/api/state` không gửi prompt của job đã xong — `lib/public-state.mjs`

`statePayload(j)` bỏ **duy nhất** `payload.prompt` khỏi job đã settle. Mọi trường khác giữ
nguyên — hàng đợi và badge trên node đọc chúng; `references` cũng giữ vì có chỗ kiểm tra
dựa vào nó.

### ③ Dọn lịch sử job — `lib/job-history.mjs` (mới)

`compactJobs(d)` chạy trong `normalize()` (lúc nạp project) và trong `save()` (mỗi lần ghi —
một vòng duyệt danh sách job, không đáng gì so với stringify cả project).

**Giữ nguyên payload** với:

- job chưa settle (`queued`, `running`, `needs_review`, `script_completed`, hay status mới nào
  thêm sau này — danh sách settle là allowlist, không phải denylist);
- job còn bị theo dõi: `maybeSent`, `conflict`, `recheck`, `recover`, `late` — đây là những
  job `lib/auto.mjs` đối chiếu lại với prompt đã gửi (`uncertainJobs → madeFromCurrentInputs`,
  nhánh `unsent`), tức một lần render **có thể đã tốn tiền** mà chưa về;
- **job mới nhất của mỗi node VÀ mỗi loại** — per kind, vì phép so sánh đó là per kind
  (`prompts(n)[j.kind]`): job ảnh cuối của một node vẫn phải đọc được sau khi node đó chạy video.

Job còn lại bị bỏ `prompt`, `references`, `timing` (chỉ cần lúc đang bay). Quá
`JOB_HISTORY = 400` job thì xóa hẳn từ cũ nhất — không bao giờ xóa nhóm "giữ nguyên" ở trên.

> ⚠ **Không đưa `j.remote` vào nhóm được bảo vệ.** `uncertainJobs` báo các job đó từ chính
> `j.remote`, không hề đọc prompt — mà job Seedvis nào cũng mang `remote`, nên bảo vệ nó sẽ
> miễn trừ gần như toàn bộ lịch sử khỏi việc dọn (đo được: giảm 30 % → 14 %).

## Kết quả đo lại (cùng dữ liệu thật)

| | Trước | Sau | |
|---|---|---|---|
| File project lớn nhất (243 node) | 2 810 KB | 1 366 KB | **−51 %** |
| Tổng 24 project | 13,90 MB | 10,50 MB | −24 % |
| Phần job trong `/api/state` | 1 967 KB | 567 KB | **−71 %** |
| Băng thông poll mỗi 4 giây | 492 KB/s | 142 KB/s | |

## Kiểm thử

```powershell
node test-capacity.mjs
```

Chạy thật, không mock: dựng blueprint 294 node qua `/api/director/build` (trần cũ đã chặn),
chặn đúng ở 404, kiểm `nodeBudget` trong state, tạo job thật rồi hủy và đối chiếu cả
`/api/state` lẫn **file project trên đĩa** trước/sau khi dọn.

## Còn lại

Tool vẫn **không có timeline hay export xuyên project** — nhưng với trần 400 thì một phim 15
phút không cần đến nó nữa: cả phim nằm trong một project, một timeline, một lần export.
