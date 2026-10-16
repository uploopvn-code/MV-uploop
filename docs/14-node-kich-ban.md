# Node Kịch bản (SCRIPT) — xưởng viết kịch bản trong tool

Đưa dây chuyền viết kịch bản vào thẳng tool: nhập ý tưởng trên một node, tool viết truyện →
bảng shot → blueprint JSON, **tự kiểm bằng chính validator của mình**, tự sửa, rồi dựng graph.

Khác với **Trợ lý đạo diễn** (tab Đạo diễn, một lượt LLM cho mỗi bước, không tự kiểm): node
này chạy nhiều trạm nối tiếp và có vòng QC tự sửa.

---

## Luồng

```
⓪ Kịch bản ─ brief (ý tưởng, quốc gia, thời lượng, thể loại, tông, số NV, ngôn ngữ)
      │  ▶ Chạy xưởng
      ▼
   ① truyện ──► ②–⑤ bảng shot ──► ⑥ ráp JSON        (Nhanh: 3 lượt LLM)
   ① truyện ─► ② hình ảnh ─► ③ trục ─► ④ biểu cảm ─► ⑤ nhịp ─► ⑥ ráp JSON   (Kỹ: 6 lượt)
      ▼
   ⑦ QC bằng validator THẬT ──lỗi──► LLM sửa (tối đa 2 vòng) ──► QC lại
      ▼
   Blueprint trên node ──► ⤓ Dựng graph
```

**Nhanh / Kỹ** chọn ngay trên node. **Chạy qua** chọn API key LLM hoặc extension ChatGPT.

---

## QC dùng validator thật — điểm mạnh so với chạy skill bên ngoài

`qcBlueprint()` trong `lib/script-studio.mjs` làm 2 tầng:

1. **`buildGraph()` dựng thử** — bắt mọi lỗi key / dây nối, đúng như lúc import thật.
2. **Luật phân cảnh ghép** mà builder không tự kiểm, dùng **đúng hằng số và thuật toán của
   `lib/merged.mjs`** (`beatSeconds`, `MAX_BEATS`, `MAX_FRAMES`, `WORDS_PER_SECOND`):
   - 2–6 nhịp/cụm; số cỡ cảnh khác nhau ≤ 3
   - `identity_label` (và `back_view` nếu cụm có khung qua vai)
   - tiền tố `Tên:` khớp tên/code nhân vật trong `sides`
   - trong `ots_a` người nói ở bên phải, `ots_b` bên trái
   - nhịp thoại tính bằng **đúng hàm chia 8 giây** của clip (không ước lượng)
   - shot thường có thoại phải có khẩu hình trong `videoPrompt`

Lỗi → chặn và đẩy lại cho LLM sửa. Cảnh báo → hiện cho người dùng, không chặn.

---

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/script-studio.mjs` | **MỚI.** Prompt 7 trạm, `stages(mode)`, `qcBlueprint()`, `runStudio()`, `MAX_FIX=2`. |
| `lib/routes/script.mjs` | **MỚI.** `/api/script/run` (chạy nền), `/stop`, `/qc`, `/build`. |
| `lib/merged.mjs` | Export `CLIP_SECONDS`, `MAX_FRAMES`, `MAX_BEATS`, `WORDS_PER_SECOND` và **`beatSeconds()`** để QC dùng đúng thuật toán chia nhịp. |
| `lib/apply-graph.mjs` | Node `script` sống sót qua lần thay graph (như node `music`). |
| `lib/routes/nodes.mjs` | Tạo node `kind:'script'`; PATCH `brief` / `mode` / `via` / `blueprint`. |
| `lib/zones.mjs` | Thêm zone `'script'` + `defaultZone`. |
| `public/js/zones.js` | Cột **⓪ Screenplay · Kịch bản** đặt đầu. |
| `public/js/canvas.js` | `LAYOUT_KEY` → `mv-canvas-v3` (**bắt buộc khi thêm cột**), fallback đọc v2/v1. |
| `public/js/script.js` | **MỚI.** Inspector: brief, Nhanh/Kỹ, tiến trình, kết quả QC, ô blueprint, nút Dựng. |
| `public/js/inspector.js`, `cards.js`, `add-nodes.js`, `index.html` | Định tuyến inspector, thẻ trên canvas, nút ＋ Kịch bản (SCRIPT). |
| `server.mjs` | Đăng ký `scriptRoutes`. |

> ⚠ **Thêm cột mới thì PHẢI bump `LAYOUT_KEY`** trong `public/js/canvas.js`, nếu không mọi vị
> trí node đã lưu sẽ lệch một cột. Và phải sửa luôn khoá trong `test-canvas.mjs` (3 chỗ).

---

## Chế độ MV — nối node Nhạc vào node Kịch bản

Kéo dây từ cổng **OUT 🎵** của node **Nhạc (MUSIC)** sang cổng **IN 🎵** của node Kịch bản. Khi có
bài hát nối vào, xưởng tự chuyển sang **chế độ MV**:

| | Không có nhạc | Có nhạc nối vào |
|---|---|---|
| Trạm ① | Story bible (truyện, beat sheet, thoại + subtext) | **Treatment MV** (concept, nhân vật, mạch hình theo từng đoạn bài) |
| Trạm ②–⑤ | Bảng shot theo nhịp kịch | **Bảng shot phủ kín bài** theo đúng mốc giây của `sections` |
| Trạm ⑥ | Blueprint drama (cụm thoại) | Blueprint MV: shot nối liền từ 0 → hết bài, shot hát nhép có `dialogue` + khẩu hình |

Brief gửi cho LLM tự động kèm: tên/nghệ sĩ/bpm/tông/thể loại/mood, đường năng lượng, gợi ý
style + máy quay, **bảng cấu trúc theo giây kèm lời từng đoạn**, và toàn bộ lời bài hát.

> Nên **phân tích bài hát ở node Nhạc trước** (nút phân tích trong inspector của nó). Chưa phân
> tích thì không có mốc giây, phân cảnh sẽ không khớp bài — Inspector node Kịch bản cảnh báo việc này.

Code liên quan: `songOf()` + `songText()` trong `lib/routes/script.mjs`; các prompt `MV_STORY` /
`MV_SHOTS` / `MV_ASSEMBLE` và `stages(mode, kind)` trong `lib/script-studio.mjs`; cổng nối trong
`public/js/canvas.js` (node nhạc trước đây cố tình không có cổng nào).

---

## Chạy tiếp từ một bước · sửa tay rồi chạy tiếp

Kết quả **từng trạm được lưu ngay khi trạm đó xong** (`n.stages`, khoá theo key trạm). Nhờ vậy:

- **Trạm hỏng không làm mất công sức trạm trước.** `n.run.failedAt` ghi đúng trạm hỏng, Inspector
  hiện nút **▶ Chạy tiếp từ bước lỗi** — chỉ chạy lại từ đó, không gọi lại LLM cho trạm đã xong.
- **Mỗi trạm có ô sửa tay** + nút **▶ Chạy tiếp từ đây** = chạy lại chính trạm đó **và mọi trạm sau**.
  Muốn giữ bản mình vừa sửa ở trạm ①? Sửa ô ①, rồi bấm nút của trạm **kế tiếp** — các trạm sau sẽ
  đọc đúng bản đã sửa.
- Bấm **▶ Chạy xưởng** ở mục ② là chạy lại **từ đầu** và xoá kết quả cũ.

Chặn an toàn: chạy tiếp từ trạm X mà một trạm trước X còn trống → báo lỗi *"còn thiếu kết quả của…"*
thay vì gửi prompt rỗng cho LLM.

Code: `runStudio({ from, prior, onStage })` + `missingBefore()` + `StageError` trong
`lib/script-studio.mjs`; `n.stages` lưu trong `lib/routes/script.mjs` (gọi `save()` sau mỗi trạm);
danh sách trạm gửi xuống UI qua `runStages` trong `lib/public-state.mjs`.

---

## Tra lỗi nhanh

| Triệu chứng | Chỗ xem |
|---|---|
| "Chưa cấu hình API key LLM…" | Tab Đạo diễn → nhập key, hoặc đổi **Chạy qua** = extension |
| "Chưa thấy extension ChatGPT online" | Mở tab ChatGPT và bật worker trong extension |
| Chạy xong nhưng QC còn lỗi | Lỗi hiện ngay trên node; sửa tay trong ô JSON rồi bấm **↻ Kiểm lại** |
| "QC còn lỗi: …" khi bấm Dựng | Cố ý — sửa cho sạch, hoặc gửi `force:true` qua API |
| Node biến mất sau khi dựng | `lib/apply-graph.mjs` phải giữ `kind === 'script'` |
| Node nằm sai cột | `defaultZone` trong `lib/zones.mjs` |

---

## Kiểm tra

```powershell
node test-script.mjs
```

Gồm: QC thuần bắt 5 loại lỗi (thiếu `identity_label`, sai hướng mặt, sai tiền tố người nói,
quá 6 nhịp, cảnh báo nhịp thoại), node vào đúng cột, chặn khi thiếu ý tưởng, chạy trọn xưởng
với **một vòng tự sửa** tới khi QC sạch, dựng graph và node sống sót, và QC tay chặn dựng khi
còn lỗi. LLM là một server HTTP đứng thay (như `test-director`), cố tình trả blueprint sai ở
lượt ráp đầu để vòng tự sửa thật sự được chạy.

## Dừng và chạy lại (sửa 2026-10-12)

Ba lỗi người dùng gặp sau khi chạy xong 7/7, cùng một gốc: **vòng lặp xưởng không biết nó đã bị dừng**.

### ① "Chạy xưởng" xoá sạch kết quả, lặng lẽ

`else n.stages = {}` — chạy lại từ đầu xoá hết các bước đã có, không hỏi gì. Chạy xong 7/7 rồi
lỡ bấm nút là mất sạch.

Giờ route **từ chối** khi đã có kết quả, trừ khi client gửi `restart: true`; UI hỏi xác nhận và
chỉ sang `▶ Chạy tiếp từ đây`.

### ② Bấm Dừng không dừng được

`/api/script/stop` chỉ đặt `n.run.status = 'stopped'`, nhưng `runStudio()` **không hề kiểm cờ**
— nó chạy nốt cả bảy trạm (mỗi trạm một lượt LLM, tốn tiền và thời gian) rồi mới ngó tới trạng
thái. Giờ `runStudio` nhận `stopped()` và kiểm **trước mỗi trạm**, **ngay sau khi LLM trả lời**,
và **trong vòng QC**; dừng thì ném `StudioStopped` (không phải lỗi — route báo "Đã dừng").

> Lượt LLM **đang bay** vẫn không huỷ được (extension đã nhận prompt). Nên sau khi bấm Dừng còn
> tối đa **một** lượt nữa chạy nốt rồi thôi, thay vì sáu lượt.

### ③ Dừng xong chạy lại → hai lượt cùng ghi vào một node

Stop xoá node khỏi `running`, nên lượt mới được phép khởi động trong khi lượt cũ vẫn đang chạy.
Hai lượt cùng ghi `n.stages`, `n.run`; lượt cũ về sau sẽ **đè** trạng thái của lượt mới.

Giờ mỗi lượt có **`n.run.id` riêng**. Lượt cũ khi trả về thấy id khác thì im lặng: không ghi
stage, không đổi trạng thái, không báo lỗi. `finally` cũng chỉ xoá khỏi `running` nếu đúng task
của mình.

Test: `node test-script-stop.mjs`

## Tiến trình sống, mở lại app giữa chừng, tự dựng graph (2026-10-12)

- **Thanh tiến trình dính trên đầu inspector**, tự cập nhật mỗi giây: trạm đang chạy (⏳ ở cả tiêu đề
  trạm), thời gian của trạm này và tổng, đang chạy qua đâu (Claude / ChatGPT / API). Trạm vừa xong thì
  chữ hiện ngay vào ô của nó (trừ ô bạn đang sửa tay).
- **Mở lại app khi xưởng đang chạy**: lượt dở không còn treo "đang chạy" mãi — nó thành lỗi ở đúng
  trạm bị cắt; bấm **▶ Chạy tiếp từ bước lỗi**, các trạm đã xong vẫn giữ.
- **Chạy xong tự dựng graph** (ô tick, mặc định bật): MV có file nhạc → bộ dựng hai luồng (căn giây
  theo vocal, phủ cảnh + hát nhép); drama → dựng từ blueprint khi QC sạch. Dựng không được thì báo lý
  do trên thanh tiến trình, kết quả xưởng vẫn giữ để bấm Dựng tay.

| File | Thay đổi |
|---|---|
| `lib/projects.mjs` | `scriptTasks`; `normalize()` đánh lỗi lượt chạy mồ côi |
| `lib/script-studio.mjs` | `onStep` truyền khoá trạm |
| `lib/routes/script.mjs` | `run.key`, `run.stepAt`, `autoBuild`, `buildFromStudio()` |
| `lib/routes/music.mjs` | tách `musicImport()` khỏi route; trần node dùng `NODE_CAP` |
| `public/js/script.js`, `public/style.css` | thanh tiến trình dính + `watchRun()`, ô tự dựng |
| `test-script-stop.mjs` | phần ④: tắt/mở server thật giữa trạm ② rồi chạy tiếp |

## Token dùng trực tiếp khi chạy xưởng (2026-10-13)

Thanh tiến trình có thêm dòng **Token: N vào · M ra · k lượt LLM · model**, cộng dồn sau mỗi lượt
LLM (cập nhật mỗi giây cùng thanh tiến trình). Nguồn số:

| Đường | Số token |
|---|---|
| Claude (gói Pro/Max) | Claude Code báo (`usage` + `modelUsage`); "vào" gồm cả cache đọc/ghi |
| API key | khối `usage` của API (prompt/completion tokens) |
| Extension ChatGPT | **ước tính** từ độ dài chữ (~4 ký tự/token) — ChatGPT web không báo số; dòng ghi rõ "ước tính" |

Lưu trên `n.run.tokens {in, out, turns, estimated, model}`; xong lượt vẫn giữ để xem lại.

| File | Thay đổi |
|---|---|
| `director-llm.mjs` | `completeFull()` trả text + usage |
| `lib/director-web.mjs` | `runTurnFull(via, …)` — ba đường, cùng dạng usage |
| `lib/claude-cli.mjs` | model = model viết nhiều output nhất trong `modelUsage` (Claude Code còn chạy model nhỏ cho việc phụ) |
| `lib/routes/script.mjs` | cộng dồn `run.tokens` sau mỗi lượt |
| `public/js/script.js` | dòng Token trên thanh tiến trình |
| `test-script-stop.mjs` | đếm đủ lượt, có số vào/ra, qua extension = ước tính |


## Skill thể loại trên node Kịch bản (2026-10-13)

Mục ① Brief có **Skill thể loại**: chọn từ thư viện (các mẫu dựng sẵn theo thể loại + "Mẫu của tôi"
lưu ở tab Đạo diễn), nội dung nạp vào ô bên dưới để **sửa riêng cho node này**, hoặc **Nạp file
.txt/.md**. Lưu trên node (`skillId`, `skillText`); mọi trạm của xưởng (drama, MV, MV có file nhạc)
đọc nó trong brief dưới tiêu đề *SKILL THỂ LOẠI* — tiêu đề nói rõ định dạng đầu ra vẫn theo trạm
đang chạy, vì nhiều mẫu thư viện kết bằng "xuất JSON blueprint" (bước điền khung MV trả CSV).

| File | Thay đổi |
|---|---|
| `lib/routes/nodes.mjs` | PATCH `skillId`, `skillText` |
| `lib/routes/script.mjs` | `briefText` nối skill dưới tiêu đề riêng |
| `public/js/script.js` | ô chọn skill theo thể loại, ô sửa, nạp file |
| `test-script-stop.mjs` | skill vào prompt của trạm với đúng tiêu đề |

## Chọn khuôn hình phim ngay trên node Kịch bản (2026-10-13)

Mục ② có thêm **🖼 Khuôn hình phim** (Ngang 16:9 / Dọc 9:16 / Vuông 1:1 / 4:3 / 3:4). Chọn
**trước khi chạy xưởng** để mọi ảnh và video render đúng chiều. Nó đặt thẳng khuôn hình của project
(giống ⚙ Project), nên áp cho cả tham số gửi model lẫn nội dung prompt.

Sửa gốc kèm theo: câu tỉ lệ (`aspectPhrase`) trước đây chỉ có trong prompt shot/ghép, **thiếu** ở
các prompt model-sheet tool tự viết (nhân vật, bối cảnh, đạo cụ, trang phục, look, góc máy). Vì thế
khi render qua extension (ChatGPT/Muse — không có tham số tỉ lệ) model tự chọn, ảnh nhân vật/bối
cảnh hay ra dọc. Giờ mọi prompt model-sheet đều ghi "16:9 horizontal frame" / "9:16 vertical frame"
theo khuôn hình project, nên render đúng chiều ở cả Seedvis lẫn extension.

| File | Thay đổi |
|---|---|
| `lib/prompts.mjs` | thêm `aspectPhrase()` vào 7 prompt model-sheet |
| `public/js/script.js` | ô "🖼 Khuôn hình phim" đặt `defaults.aspect` qua `/api/project` |

> Bổ sung: prompt **video** (và ảnh khung của shot) cũng ghi tỉ lệ khung — `withAspect()` trong
> `lib/prompts.mjs` bọc cả `image` lẫn `video`. Nhờ đó Google Vids / Muse (tạo video qua extension,
> không gửi tham số tỉ lệ) render đúng chiều. Take hát nhép (Omni video-to-video) giữ chiều video nguồn.
