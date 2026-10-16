# Chạy LLM bằng gói Claude (Pro/Max) — không cần API key

## Gói Max ≠ API

Gói Claude Pro/Max **không đi kèm API key**. Tích hợp Claude cũ của trợ lý đạo diễn
(`lib/assistant-claude.mjs`) gọi Messages API bằng key trong `assistant-claude-key.txt` — tính tiền
theo token vào tài khoản Anthropic Console, **không** trừ vào gói Max.

Cửa vào gói Max là **Claude Code CLI** (`claude`) đã đăng nhập trên máy. Tool gọi nó ở chế độ
không giao diện (`claude -p`).

## Cài đặt

| Bước | Lệnh |
|---|---|
| 1. Cài Claude Code (nếu chưa có) | `npm i -g @anthropic-ai/claude-code` |
| 2. Đăng nhập gói | mở terminal, chạy `claude`, gõ `/login`, chọn tài khoản Claude (Pro/Max) |
| 3. Chọn trong tool | node Kịch bản → **Chạy qua: Claude (gói Pro/Max của bạn)** |

Không cần API key, không cần mở tab trình duyệt.

## Ba thứ đo trên máy thật trước khi viết

**① `ANTHROPIC_API_KEY` trong môi trường → Claude Code dùng KEY, không dùng gói.** Tool gỡ biến
này (và `ANTHROPIC_AUTH_TOKEN`) khỏi môi trường tiến trình con mỗi lần gọi. Test cài một key **giả**
vào môi trường: Claude vẫn trả lời, tức là đi bằng đăng nhập gói.

**② Gọi mặc định nặng gấp ~56 lần cần thiết.**

| | Mặc định | Tool gọi |
|---|---|---|
| Ngữ cảnh mang theo | ~47.000 token | **841 token** |
| Model | Opus | **Sonnet** |
| Ước tính / lượt | $0.22 | $0.0034 |

Mặc định, `claude -p` mang theo system prompt của Claude Code, công cụ, skill, MCP server, bộ
nhớ… chỉ để trả lời một chữ. Tool cắt bằng: `--system-prompt-file` (thay system prompt),
`--tools ""`, `--strict-mcp-config` với MCP rỗng, `--setting-sources ""`,
`--no-session-persistence`, chạy từ thư mục trung tính. Với gói Max bạn không trả theo token,
nhưng mỗi lượt nhẹ hơn là chạy được nhiều xưởng hơn trước khi chạm giới hạn sử dụng của gói.

**③ `--bare` (chế độ gọn nhất) KHÔNG dùng được với gói Max** — nó chỉ nhận API key (*"OAuth … not
read"*). Nên cắt ngữ cảnh bằng từng cờ riêng, không dùng `--bare`.

Prompt đi qua **stdin**, system prompt qua **file**: prompt các trạm dài hàng chục nghìn ký tự,
Windows giới hạn dòng lệnh ~32k. Đã thử 60.000 ký tự — chạy được.

Trên Windows `claude` là `claude.cmd`; Node không spawn `.cmd` nếu không qua shell, mà qua shell
thì quoting JSON và chuỗi rỗng rất dễ vỡ. Tool gọi thẳng `claude.exe` bên dưới.

## Đổi model

Mặc định Sonnet. Đổi bằng biến môi trường khi khởi động server: `MV_CLAUDE_MODEL=opus`
(nặng hơn nhiều so với giới hạn của gói). `MV_CLAUDE_BIN` trỏ tới file chạy khác nếu cần.

## Vì sao tool KHÔNG nạp skill Claude

Nạp skill (như `vibe-xuong-phim-drama`) nghĩa là nạp lại settings/skill → quay về ~47.000 token mỗi
lượt. Các trạm của node Kịch bản **chính là** 7 agent của skill đó, và thư viện skill theo thể loại
(`docs/22`) giữ phần khoá cấu trúc. Muốn dùng đúng skill Claude: chạy nó trong Claude Code /
claude.ai rồi **nhập JSON blueprint** vào tool — hai đường đều hợp lệ.

## Nơi dùng được

`runTurn(via, …)` nhận `'claude'`, nên mọi chỗ gọi LLM đều dùng được: xưởng kịch bản, phân tích
nhạc, nút ✨, bước "AI viết lại" của thang leo tự sửa prompt (tự chọn: API key → Claude → extension).

### Trợ lý đạo diễn

Ô **Claude · Bộ não trợ lý** có thêm **Nguồn**: "Gói Claude (Pro/Max) — không cần key" hoặc
"Claude API key". Mặc định: đã lưu API key → dùng key; chưa có key mà máy có Claude Code → dùng gói.
Chọn rồi bấm **Lưu cấu hình Claude** (ghi `via` vào `assistant-claude.json`, key không bị đụng tới).

Qua gói, `claudeRun` trả `usage` cùng dạng Messages API nên sổ token của trợ lý vẫn ghi đủ. Khác
biệt: CLI không có cờ `max_tokens`/`temperature`, và mỗi lượt khởi động `claude.exe` (~vài giây);
chờ tối đa 180 giây.

Một chỗ chuẩn hoá duy nhất (`normVia`, `requireLLM` trong `lib/director-web.mjs`) — trước đây ba
nơi tự ép `via` về `'web' | 'api'`, nên mọi đường mới đều lặng lẽ rơi về API key.

## Thay đổi theo module

| File | Thay đổi |
|---|---|
| `lib/claude-cli.mjs` | **Mới** — `claudeComplete`, `claudeRun` (text + model + usage), `claudeAvailable`, `claudeBin` |
| `lib/assistant-claude.mjs` | nguồn `via: 'api' \| 'claude'`; `complete()` đi qua `claudeRun` khi chọn gói |
| `public/index.html`, `public/js/commands.js`, `public/locales/*` | ô chọn Nguồn trong cấu hình trợ lý |
| `lib/director-web.mjs` | `runTurn` thêm `'claude'`; `VIAS`, `normVia`, `requireLLM` dùng chung |
| `lib/routes/script.mjs`, `music.mjs`, `nodes.mjs` | bỏ bản `requireLLM` / ép via riêng |
| `lib/runner.mjs` | bước AI của thang leo chọn được Claude |
| `public/js/script.js` | lựa chọn "Claude (gói Pro/Max của bạn)" |

## Kiểm thử

```powershell
node test-claude-cli.mjs
```

**Không nằm trong `npm test`** — nó gọi Claude thật và tiêu quota gói. Máy không có Claude Code thì
báo SKIP (không giả vờ PASS). Test thang leo (`test-prompt-doctor.mjs`) đặt `MV_CLAUDE_BIN=none`
để không tự gọi Claude thật.
