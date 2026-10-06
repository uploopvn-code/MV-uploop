# Hợp đồng IN / OUT cho kịch bản Orbit — tạo ảnh & tạo video

Tài liệu này mô tả **chính xác những gì kịch bản Orbit nhận được** và **chính xác những gì nó
phải tạo ra** để MV Director nhận lại kết quả. Mọi mục đều đọc từ source, không phải từ tài liệu cũ.

Neo tham chiếu: `orbit-client.mjs` (`executeOrbit`), `media-io.mjs` (`prepareInputs`, `readOutput`),
`output-config.mjs` (`outputFor`), `server.mjs` (`createJob`, `runJob`, `storeResult`, `seedvisBinding`).
Số dòng của `server.mjs` ghi theo bản 2948 dòng; file này đang được sửa thường xuyên nên
**hãy neo bằng tên hàm, đừng tin số dòng**.

> ⚠️ `Orbit-variables.md` đã lỗi thời ở 3 điểm: nó nói "chưa truyền file ảnh", "chưa tự nhận file
> đầu ra", và giới hạn `mv_node_id` vào 6 tên `singer/stage/scene/wide/medium/close`. Code hiện tại
> **đã** truyền ảnh đầu vào, **đã** tự nhận file, và `mv_node_id` là id bất kỳ dạng `node-<uuid>`.

---

## 0. Cạm bẫy phải xử lý trước mọi thứ khác: HAI MÁY

MV Director đọc/ghi file bằng `fs` **cục bộ của máy chạy MV Director**
(`media-io.mjs` → `fs.mkdir`, `fs.copyFile`, `fs.lstat`, `fs.readFile`), trong khi Orbit Hub mặc định
nằm ở máy khác (`MV_ORBIT_URL` mặc định `http://192.168.100.5:8080`, `orbit-client.mjs:3`).

Nghĩa là: `mv_output_path` và `mv_input_N_path` **phải trỏ tới cùng một thư mục thật trên cả hai máy**.

- Cùng một máy → đường dẫn ổ đĩa bình thường là được.
- Hai máy → **bắt buộc dùng thư mục mạng UNC** (`\\MAY-CHU\share\results`) mà cả hai đều truy cập được.
- Tuyệt đối không đặt `D:\results` rồi tưởng hai máy dùng chung — kịch bản sẽ ghi vào ổ D của máy Orbit
  còn tool đi tìm ở ổ D của máy nó, và job treo ở `needs_review`.

Thông điệp lỗi của `validateDirectory` nói "thư mục trên máy chạy Orbit" (`output-config.mjs:6`) —
câu đó **gây hiểu nhầm**; đúng ra là thư mục cả hai máy cùng thấy.

---

## 1. Bật đường Orbit cho một node

Seedvis là **mặc định**. Node chỉ đi qua Orbit khi `seedvisBinding(n, kind)` trả `null`
(`server.mjs:837-853`):

| Trạng thái node | Nguồn chạy |
| --- | --- |
| `n.seedvis[kind] === false` | **Orbit** |
| `n.seedvis[kind]` có giá trị | Seedvis (thắng cả khi đã có `n.orbit[kind]`) |
| `n.seedvis[kind]` chưa set **và** có `n.orbit[kind]` | **Orbit** |
| Không có gì | Seedvis mặc định |

Gán binding:

```http
PATCH /api/node
{ "id": "<node id>",
  "orbit": { "image": { "type": "flow", "scriptId": "f", "profileId": "p" } } }
```

- `type`: `"flow"` | `"workflow"` | `"app"`.
- Chỉ cần 3 field; `scriptName` / `profileName` / `owner` server tự tra từ Hub rồi lưu lại.
- `orbit.image` và `orbit.video` **độc lập** — một node có thể tạo ảnh bằng Seedvis và video bằng Orbit.
- Giao diện chỉ hiện ô cấu hình Orbit video ở node shot, nhưng API nhận `orbit.video` cho mọi node.
- `PATCH /api/node` gọi `requireIdle()` → không sửa được khi còn job chờ/đang chạy.

Xem trước cấu hình và prompt thật sẽ gửi đi: `GET /api/state` → `nodes[].providers` và
`nodes[].resolvedPrompts` (`server.mjs:943`).

---

## 2. INPUT — 14 nhóm biến tool bơm sang Orbit

Dựng trong `executeOrbit` (`orbit-client.mjs:170-186`). Object **phẳng**, không lồng.

| Biến | Kiểu | Giá trị | Ghi chú cho người viết kịch bản |
| --- | --- | --- | --- |
| `prompt` | string | `prompts(n)[kind]` | Dùng nguyên văn. Tool đã ghép sẵn mô tả nhân vật, style, máy quay, khóa giọng — **đừng ghép thêm**. |
| `mv_prompt` | string | **y hệt** `prompt` | Trùng giá trị, dùng cái nào cũng được. |
| `mv_job_id` | string | UUID v4 | Không đoán được, không tăng dần. Dùng để log. |
| `mv_kind` | string | `"image"` hoặc `"video"` | Chữ thường, số ít. |
| `mv_duration` | **number** | `n.duration \|\| 8` | Có thể là số thập phân. Job ảnh cũng nhận biến này — tự bỏ qua. |
| `mv_start` | **number** | `n.start \|\| 0` | |
| `mv_node_id` | string | `n.id` | Dạng `node-<uuid>`. **Đừng** so sánh với `singer`/`stage`/`scene`. |
| `mv_aspect_ratio` | string | **luôn `"16:9"`** | Hard-code ở nhánh Orbit (`server.mjs:1225`). Cấu hình tỉ lệ trong UI chỉ ảnh hưởng Seedvis. |
| `mv_output_dir` | string | `db.outputDirectory` | Mặc định `<root>/results`; đổi qua `PATCH /api/project`. Tool **đã tạo sẵn** thư mục này. |
| `mv_output_filename` | string | mẫu đã thay placeholder | |
| `mv_output_path` | string | `dir` + `filename` | **Kênh đầu ra duy nhất.** |
| `mv_input_count` | **number** | số ảnh tham chiếu | Là số, không phải chuỗi — cẩn thận khi so sánh trong node `condition`. |
| `mv_inputs_json` | string | JSON của `[{node_id, path, mime}]` | Chuỗi JSON, phải tự parse. |
| `mv_input_1_path` … `mv_input_N_path` | string | đường dẫn từng ảnh | **Đánh số từ 1**, không có `mv_input_0_path`. |

Mọi biến chuỗi đều có fallback `''`, không bao giờ gửi `null`/`undefined`.

**Những thứ KHÔNG đến được kịch bản** (có trong `job.payload` nhưng không map thành biến):
`audio` (file nhạc — **không có đường truyền audio sang Orbit**), `website`, `references` (object),
`orbit` (binding), `projectRevision`, `kind` (chỉ có qua `mv_kind`).

### Ảnh tham chiếu — tool đưa đường dẫn, kịch bản tự upload

`prepareInputs` (`media-io.mjs:3-24`) chạy **trước** khi gọi Hub:

1. `fs.mkdir(mv_output_dir, {recursive:true})` — tool tạo, kịch bản không cần tạo.
2. `fs.mkdir(<mv_output_dir>/inputs, {recursive:true})`.
3. Copy từng ảnh tham chiếu sang `<mv_output_dir>/inputs/<asset-id>.(png|jpg|webp)`.
4. Gán `inputFiles = [{node_id, path, mime}]`.

- Tên file ảnh input là **uuid trần**, không mang tên vai → muốn biết vai nào thì đọc `node_id`
  trong `mv_inputs_json`.
- `node_id` nhận một trong: id node cha có ảnh, hoặc chuỗi cố định `"keyframe"` (video quay từ ảnh
  của chính shot đó).
- **Thứ tự** các phần tử = thứ tự dây nối vào node. Thứ tự này khớp với dòng
  `Reference subjects, in the order of the attached images: [1] NV3; [2] NV1; …` trong prompt — nên
  kịch bản **phải upload đúng thứ tự `mv_input_1_path`, `mv_input_2_path`, …**, nếu không Veo gán sai mặt.
- Chỉ có **đường dẫn file**, không có base64 và không có URL. Kịch bản phải tự upload từ đĩa.
- Thư mục `inputs/` **không bao giờ được tool dọn**.
- Không có giới hạn số ảnh ở nhánh Orbit (`videoRefLimit` trả `null` khi không phải Seedvis).

---

## 3. Cách tool gọi Hub — khóa nhận biến khác nhau theo loại kịch bản

Đây là chỗ **dễ sai nhất**.

| Loại | Endpoint | Body | Biến nằm ở khóa |
| --- | --- | --- | --- |
| `flow` | `POST /api/profiles/{profileId}/run-flow` | `{flow_id, vars}` | **`vars`** |
| `workflow` | `POST /api/profiles/{profileId}/run-workflow` | `{workflow_id, vars, async:true, force:false}` | **`vars`** |
| `app` | `POST /api/apps/{scriptId}/run` | `{profile_id, inputs, force:false}` | **`inputs`** |

Tiền kiểm tool tự làm — **kịch bản không được tự mở/đóng nick ở đầu**:

1. `GET /api/profiles/{id}/flow-progress` → `running` phải falsy, nếu không: *"Nick đang chạy kịch bản khác"*.
2. `POST /api/profiles/{id}/launch` (timeout 120 s).
3. `GET …/flow-progress` lần hai → vẫn phải rảnh.
4. Mới dispatch kịch bản.

Tool **không có lệnh đóng nick** — kịch bản tự đóng ở cuối nếu muốn, và **phải kết thúc sạch** để
`/flow-progress` không còn báo `running` (nếu không, job kế tiếp bị từ chối).

### Cách tool biết kịch bản đã xong

- **`flow` và `app`**: đồng bộ. Chỉ cần response cuối có `{ok: true}`. Tool **không** poll tiến độ.
  `ok` falsy → lỗi, lấy `detail` làm thông điệp. Timeout **30 phút**.
- **`workflow`**: phải trả `{ok:true, data:{started:true}}` trong **30 s**, rồi tool poll
  `/flow-progress` **mỗi 2 s** tới hạn **30 phút**:
  - `{done:true, ok:true}` → thành công.
  - `{done:true, ok:false}` → *"Kịch bản báo lỗi hoặc bị dừng"*.
  - `running` falsy mà chưa `done` → *"Mất trạng thái kịch bản"*.
  - `{step, i, total}` được hiển thị cho người dùng: `Đang chạy: <step> (<i>/<total>)` — nên cập nhật
    để thấy tiến độ thật; không ảnh hưởng kết quả.
- Các kiểm tra `running`/`done` là **truthy**, không strict.

### Riêng loại `app`: bắt buộc khai public_params

Nếu `type === 'app'` **và** job có ảnh đầu vào, tool đọc `app.public_params` và chặn nếu App không
công khai `mv_inputs_json` **hoặc** đủ `mv_input_1_path` … `mv_input_N_path`
(`orbit-client.mjs:140-151`).

- Orbit **bỏ qua mọi input không thuộc `public_params`** → App phải khai đủ cả `prompt` và
  `mv_output_path`, dù tool **không** kiểm hai key này (lỗi sẽ hiện muộn dưới dạng "chưa nhận được file").
- Số key `mv_input_N_path` cần khai **thay đổi theo số ảnh của job** → khai `mv_inputs_json` an toàn hơn.
- Kiểm tra này **bị bỏ qua hoàn toàn** khi job không có ảnh đầu vào.

### Hub phải trả JSON, không được redirect

`orbit-client.mjs` dùng `redirect: 'error'` và gọi `r.json()` **trước** khi xét `r.ok` → mọi phản hồi
30x (kể cả redirect về trang login) làm request throw. Phiên hết hạn phải trả **401 JSON**.

---

## 4. OUTPUT — ghi đúng một file vào `mv_output_path`

Đó là **kênh ra duy nhất**. Không có API nào để kịch bản báo kết quả về
(`/api/worker/claim` lọc bỏ job có `payload.orbit`, nên worker API không dùng được cho Orbit).

Luật của `readOutput` (`media-io.mjs:35-63`):

| Luật | Chi tiết |
| --- | --- |
| **File đích không được tồn tại trước** | `prepareInputs` throw *"File đích đã tồn tại"*. Đừng ghi file rỗng/placeholder trước. |
| **Ghi nguyên tử** | Tool poll mỗi 1 s và chỉ đọc khi `size:mtimeMs` **trùng nhau 2 vòng liên tiếp**. File ghi dần (streaming) sẽ bị bỏ qua tới khi dừng. **Ghi file tạm rồi `rename`** là cách an toàn nhất. |
| **Nội dung quyết định, không phải đuôi file** | Chỉ nhận 5 chữ ký: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WEBP `RIFF…WEBP`, MP4 `'ftyp'` tại byte 4, WEBM `1A 45 DF A3`. Mime phải bắt đầu bằng `mv_kind + '/'`. |
| **AVIF / GIF / MOV bị từ chối** | Site chỉ xuất AVIF/GIF → kịch bản phải tự chuyển sang PNG/JPEG/WEBP trước khi lưu. (`.mov`/`.m4v` lọt qua vì cũng có `ftyp`, nhưng file lưu đuôi `.mp4` có thể không phát được.) |
| **≤ 100 MB, không symlink** | `st.size > 100*1024*1024` hoặc symlink → từ chối ngay. |
| **Chờ 60 s** | `MV_OUTPUT_WAIT_MS`, mặc định 60000. Đặt `0` **không** tắt được (0 là falsy → về 60000). |
| **Lỗi khác "chưa có file" không được chờ lại** | Chỉ `ENOENT` mới tiếp tục poll; sai định dạng / quá lớn → fail ngay. |
| **Mất ≥ 1 giây** | Vòng lặp luôn sleep 1 s trước lần so sánh thứ hai, kể cả khi file đã nằm sẵn. |

Thứ tự chạy một job Orbit (`runJob`, `server.mjs:1650-1675`):

```
status=running, executor='orbit-direct'
  → prepareInputs()        (tạo thư mục + copy ảnh đầu vào)
  → executeOrbit()         (mở nick, gọi kịch bản, chờ xong)
  → progress='Đang chờ file đầu ra'
  → collectJob() → readOutput()
```

Kịch bản báo "xong" **không** nghĩa là job xong — tool vẫn phải tìm thấy file hợp lệ.

### Mẫu tên file đầu ra

`outputFor(db.outputDirectory, n.outputNaming, n.id, kind, jobId)` (`output-config.mjs:32-40`).

- Chỉ **3 placeholder**: `{node_id}`, `{job_id}`, `{kind}`.
- **`{job_id}` bắt buộc** — thiếu thì bị chặn ngay khi lưu cấu hình.
- Mặc định: ảnh `{node_id}_{job_id}.png`, video `{node_id}_{job_id}.mp4`.
- Đuôi phải là `png|jpg|jpeg|webp` (ảnh) hoặc `mp4|webm` (video).
- Cấm ký tự đường dẫn `< > : " / \ | ? * { }`, ≤ 200 ký tự, không kết thúc bằng `.` hay khoảng trắng,
  cấm tên Windows `con/prn/aux/nul/com1-9/lpt1-9`.
- Mẫu đặt **ở từng node** (`n.outputNaming`) — **không có** mẫu cấp project.
- Thư mục phải **tuyệt đối** (`PATCH /api/project {outputDirectory}`); `PATCH` chỉ validate chuỗi,
  **không** kiểm quyền ghi.
- Website tải về WebP thì hãy đặt mẫu đuôi `.webp` — đặt `.png` **không** tự chuyển định dạng.

---

## 5. Thứ tự thao tác bắt buộc

Theo đúng luồng test thật trong `test-graph.mjs:65-94`:

1. `POST /api/orbit/login` `{email, password}`
2. `PATCH /api/project` `{outputDirectory}` — đường dẫn tuyệt đối, cả hai máy thấy được
3. Ảnh của các node cha đã có (upload `POST /api/upload` hoặc tạo trước)
4. `PUT /api/edges` `{edges}` — nối dây
5. `PATCH /api/node` `{id, orbit:{image:{type, scriptId, profileId}}}`
6. Chạy:
   - một node: `POST /api/jobs` `{nodeId, kind}` → `201 {job}`
   - cả chuỗi ảnh: `POST /api/auto/start` `{target}`

Lưu ý `POST /api/jobs` **có thể trả về job cũ** (cùng `nodeId` + `kind` đang `queued`/`running`) mà
vẫn trả HTTP 201 — đừng coi đó là job mới.

### Hợp đồng response của Hub (trích Hub giả lập trong `test-graph.mjs:15-35`)

```
POST /api/login              → Set-Cookie: orbit_session=...
GET  /api/auth-status        → {user:{email}}
GET  /api/profiles           → [{id, name}]
GET  /api/flows              → [{id, name}]
GET  /api/workflows?light=true → [{id, name}]
GET  /api/apps               → [{id, name, enabled, public_params:[{key}]}]   // chỉ enabled được dùng
GET  …/{profileId}/flow-progress → {running, done, ok, step, i, total}
POST …/{profileId}/launch        → {ok:true}
POST …/{profileId}/run-flow      → {ok:true}
POST …/{profileId}/run-workflow  → {ok:true, data:{started:true}}
POST /api/apps/{id}/run          → {ok:true}
```

Trong test, kịch bản giả lập làm đúng hai việc — và đó là toàn bộ nghĩa vụ của một kịch bản thật:

```js
for (const file of JSON.parse(vars.mv_inputs_json)) assert.ok(fs.existsSync(file.path));
fs.writeFileSync(vars.mv_output_path, png);
```

---

## 6. Giới hạn của đường Orbit (so với Seedvis)

| Tính năng | Orbit |
| --- | --- |
| Chạy song song | ❌ **Tuần tự, đúng 1 job một lúc** (`orbitBusy`) |
| Nhiều phiên bản (`count > 1`) | ❌ *"Nhiều phiên bản / tách node chỉ hỗ trợ Seedvis"* |
| Sửa ảnh (`edit`) | ❌ *"Sửa ảnh chạy qua Seedvis"* |
| Batch ảnh theo khu vực | ❌ lọc bỏ node không phải Seedvis |
| `POST /api/auto/start` (chuỗi ảnh) | ✅ có hỗ trợ — tool tự `validateBinding` từng node + kiểm quyền ghi thư mục |
| `POST /api/auto/video/start` | ❌ đòi API key Seedvis và lọc bỏ node Orbit → **video Orbit phải tạo từng node** |
| Tách node video khi xong | ✅ có — `storeResult` luôn gọi `createBranchNode` cho `kind='video'` |
| Tự chạy lại khi lỗi | ❌ job Orbit lỗi luôn là `needs_review` (cờ `definite` chỉ Seedvis dùng) nên auto-retry không kích hoạt |

**Điều kiện phát job**: job Orbit chỉ chạy khi trình duyệt đang có phiên Orbit đăng nhập **đúng email**
đã tạo job (`payload.orbit.owner`). Đổi tài khoản → job đứng chờ. `executeOrbit` kiểm lại owner lần nữa.

---

## 7. Khi lỗi — cứu job mà không tốn lượt tạo

- Lỗi Orbit hoặc không thấy file → `status = 'needs_review'`, progress *"Cần kiểm tra Orbit trước khi
  chạy lại"*. Chuỗi auto dừng ở `blocked`.
- Khởi động lại server khi đang chạy → mọi job `running` → `needs_review`.
- Mất heartbeat > 90 s → `needs_review` (sweeper chạy mỗi 10 s).
- **Nhận lại file đã có sẵn trên đĩa**: `POST /api/jobs/collect` `{id}` — đọc lại `mv_output_path` và
  **không chạy lại kịch bản**. Dùng sau khi sửa vị trí lưu. Yêu cầu `requireIdle()`.

Tra cứu nhanh khi job treo: so `mv_output_path` trong nhật ký Orbit với file thật trên đĩa; 90% lỗi là
**sai ranh giới hai máy** (mục 0) hoặc **ghi file dần** nên tool không bắt được size ổn định (mục 4).

---

## 8. Biến môi trường

| Biến | Mặc định | Tác dụng |
| --- | --- | --- |
| `MV_ORBIT_URL` | `http://192.168.100.5:8080` | Địa chỉ Orbit Hub |
| `MV_OUTPUT_WAIT_MS` | `60000` | Thời gian chờ file đầu ra |
| `MV_SEEDVIS_CONCURRENCY` | `48` | Chỉ ảnh hưởng Seedvis; Orbit luôn tuần tự |
| `MV_BASE_URL` | `http://127.0.0.1:7788` | Dùng cho `worker-bridge.mjs` (đường thứ ba, không dùng cho Orbit) |
