// Một lượt LLM qua Claude Code CLI — dùng GÓI CLAUDE (Pro/Max) đã đăng nhập trên máy, không cần
// API key. Đây là cách duy nhất để tool dùng gói Max: gói Max không đi kèm API key, còn tích hợp
// Claude cũ của trợ lý (lib/assistant-claude.mjs) gọi Messages API bằng key, tính tiền riêng.
//
// Ba thứ ĐÃ ĐO trên máy thật trước khi viết (2026-10-12):
//
//  1. `ANTHROPIC_API_KEY` có trong môi trường → Claude Code dùng KEY thay cho gói Max. Nên lúc gọi
//     phải gỡ biến đó ra khỏi env của tiến trình con, nếu không là trừ tiền thật vào tài khoản API.
//
//  2. Gọi mặc định mang theo ~47.000 token ngữ cảnh (system prompt của Claude Code, công cụ, skill,
//     MCP, bộ nhớ…) để trả lời một chữ "OK" — trên Opus, ước tính $0.22/lượt. Thay system prompt,
//     tắt công cụ, tắt MCP, không nạp settings → còn 841 token (gọn ~56 lần), Sonnet, ~$0.0034.
//
//  3. `--bare` là chế độ gọn nhất NHƯNG chỉ nhận API key ("OAuth … not read") — không dùng được
//     với gói Max. Nên cắt ngữ cảnh bằng từng cờ riêng, không dùng --bare.
//
// Prompt đi qua STDIN và system prompt qua FILE: prompt của các trạm dài hàng chục nghìn ký tự,
// còn Windows giới hạn dòng lệnh ~32k. Đã thử 60.000 ký tự qua stdin — chạy được.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sonnet: đủ tốt cho viết kịch bản, và nhẹ hơn Opus nhiều so với giới hạn sử dụng của gói.
export const DEFAULT_MODEL = process.env.MV_CLAUDE_MODEL || 'sonnet';
const TIMEOUT_MS = Number(process.env.MV_CLAUDE_TIMEOUT_MS) || 600000;

// Tìm file chạy thật. Trên Windows `claude` là claude.cmd — Node không spawn .cmd mà không qua
// shell, và qua shell thì phải quoting JSON/chuỗi rỗng rất dễ vỡ. Bên dưới nó là claude.exe: gọi
// thẳng file đó.
export function claudeBin() {
  if (process.env.MV_CLAUDE_BIN) return process.env.MV_CLAUDE_BIN;
  if (process.platform === 'win32') {
    const exe = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    if (fs.existsSync(exe)) return exe;
  }
  return 'claude';
}

// Env cho tiến trình con: gỡ API key để Claude Code dùng đăng nhập gói (OAuth), không phải key.
const childEnv = () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
};

let installed = null;
// Có Claude Code trên máy không (kiểm một lần, ghi nhớ).
export function claudeAvailable() {
  if (installed !== null) return installed;
  try {
    const r = spawnSync(claudeBin(), ['--version'], { encoding: 'utf8', timeout: 20000 });
    installed = r.status === 0 && /Claude Code/i.test(r.stdout || '');
  } catch {
    installed = false;
  }
  return installed;
}

// Một lượt: system + user → văn bản trả lời.
export const claudeComplete = (system, user, opts) =>
  claudeRun(system, user, opts).then(r => r.text);

// Một lượt, trả đủ: { text, model, stopReason, usage } — usage cùng dạng với Messages API
// (input/output/cache tokens) để nơi nào đang ghi sổ token theo API vẫn ghi được.
export function claudeRun(system, user, { model = DEFAULT_MODEL, timeoutMs = TIMEOUT_MS, webSearch = false } = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-claude-'));
    const sysFile = path.join(dir, 'system.txt');
    const mcpFile = path.join(dir, 'mcp.json');
    fs.writeFileSync(sysFile, String(system || ''), 'utf8');
    fs.writeFileSync(mcpFile, '{"mcpServers":{}}', 'utf8');
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--system-prompt-file',
      sysFile, // THAY system prompt của Claude Code — phần nặng nhất
      '--tools',
      webSearch ? 'WebSearch' : '', // không công cụ; bật web search thì cho đúng tool WebSearch
      '--strict-mcp-config',
      '--mcp-config',
      mcpFile, // không nạp MCP server nào của người dùng
      '--setting-sources',
      '', // không nạp settings/hook/plugin
      '--no-session-persistence',
    ];
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    let out = '';
    let err = '';
    let child;
    try {
      // cwd trung tính: không có CLAUDE.md nào bị nạp theo thư mục
      child = spawn(claudeBin(), args, { cwd: dir, env: childEnv(), windowsHide: true });
    } catch (e) {
      cleanup();
      return reject(new Error('Không chạy được Claude Code: ' + e.message));
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude Code quá thời gian chờ.'));
    }, timeoutMs);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => {
      clearTimeout(timer);
      cleanup();
      reject(
        new Error(
          e.code === 'ENOENT'
            ? 'Chưa cài Claude Code (lệnh `claude`). Cài: npm i -g @anthropic-ai/claude-code, rồi chạy `claude` một lần để đăng nhập gói Max.'
            : 'Không chạy được Claude Code: ' + e.message,
        ),
      );
    });
    child.on('close', code => {
      clearTimeout(timer);
      cleanup();
      let j = null;
      try {
        j = JSON.parse(out);
      } catch {}
      if (j && !j.is_error && typeof j.result === 'string') {
        const u = j.usage || {};
        // `modelUsage` lists every model the call touched — Claude Code also runs a small
        // model for side tasks — so the answer's model is the one that wrote the most output.
        const main = Object.entries(j.modelUsage || {}).sort(
          (a, b) => (b[1]?.outputTokens || 0) - (a[1]?.outputTokens || 0),
        )[0]?.[0];
        return resolve({
          text: j.result,
          model: String(main || model).slice(0, 100),
          stopReason: String(j.stop_reason || ''),
          usage: {
            inputTokens: Number(u.input_tokens) || 0,
            outputTokens: Number(u.output_tokens) || 0,
            cacheCreationTokens: Number(u.cache_creation_input_tokens) || 0,
            cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
          },
        });
      }
      const msg = String(j?.result || err || out || `mã thoát ${code}`).trim();
      // Chưa đăng nhập gói: chỉ đúng cách sửa, đừng để người dùng đoán.
      if (/log ?in|not logged|authenticat|invalid api key|credit balance/i.test(msg))
        return reject(
          new Error(
            'Claude Code chưa đăng nhập gói Claude trên máy này. Mở terminal, chạy `claude`, ' +
              'gõ /login và chọn tài khoản Claude (Pro/Max). Chi tiết: ' +
              msg.slice(0, 200),
          ),
        );
      reject(new Error('Claude Code báo lỗi: ' + msg.slice(0, 400)));
    });
    child.stdin.end(String(user || ''), 'utf8');
  });
}
