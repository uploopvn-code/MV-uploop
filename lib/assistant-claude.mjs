// Claude for the Director Assistant, two ways:
//   'api'    — native Messages API with the user's API key (the key never enters a project or graph)
//   'claude' — Claude Code CLI on this machine, billed to the logged-in Claude plan (Pro/Max), no key
// Default: the API key when one is saved, otherwise the plan when Claude Code is installed.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL as PLAN_MODEL, claudeAvailable, claudeRun } from './claude-cli.mjs';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
export function createAssistantClaude(dataDir, send = fetch) {
  const keyFile = path.join(dataDir, 'assistant-claude-key.txt');
  const configFile = path.join(dataDir, 'assistant-claude.json');
  const key = () => {
    if (process.env.MV_ASSISTANT_CLAUDE_KEY) return process.env.MV_ASSISTANT_CLAUDE_KEY.trim();
    try { return fs.readFileSync(keyFile, 'utf8').trim(); } catch { return ''; }
  };
  const config = () => {
    try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; }
  };
  const model = () => process.env.MV_ASSISTANT_CLAUDE_MODEL || config().model || DEFAULT_MODEL;
  // The Claude Code CLI takes a family alias, not a dated model id — map the chosen model to it so
  // the plan (CLI) path honours the model picker too. Falls back to sonnet.
  const cliModel = () => {
    const m = model().toLowerCase();
    return m.includes('opus') ? 'opus' : m.includes('haiku') ? 'haiku' : 'sonnet';
  };
  const workspaceId = () =>
    String(process.env.MV_ASSISTANT_CLAUDE_WORKSPACE_ID || config().workspaceId || '').trim();
  // Web search for the assistant: Anthropic's server-side web_search tool on the API path, the
  // built-in WebSearch tool on the Claude plan (CLI) path. Off by default — each search costs.
  const webSearch = () =>
    process.env.MV_ASSISTANT_WEB_SEARCH
      ? /^(1|true|on|yes)$/i.test(process.env.MV_ASSISTANT_WEB_SEARCH.trim())
      : config().webSearch === true;
  const via = () =>
    config().via === 'api' || config().via === 'claude'
      ? config().via
      : !key() && claudeAvailable() ? 'claude' : 'api';
  const status = () => ({
    via: via(),
    planAvailable: claudeAvailable(),
    planModel: PLAN_MODEL,
    configured: via() === 'claude' ? claudeAvailable() : !!key(),
    model: model(),
    keyHint: key() ? '…' + key().slice(-4) : '',
    source: process.env.MV_ASSISTANT_CLAUDE_KEY ? 'env' : 'file',
    workspaceId: workspaceId(),
    workspaceConfigured: !!workspaceId(),
    workspaceSource: process.env.MV_ASSISTANT_CLAUDE_WORKSPACE_ID ? 'env' : 'file',
    webSearch: webSearch(),
  });
  const save = input => {
    if (input?.clearKey === true) {
      fs.rmSync(keyFile, { force: true });
    } else if (String(input?.key || '').trim()) {
      const value = String(input.key).trim();
      if (!/^[\x21-\x7e]{8,500}$/.test(value)) throw new Error('Claude API key không hợp lệ.');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(keyFile, value, { mode: 0o600 });
    }
    const nextConfig = config();
    let configChanged = false;
    if ('via' in (input || {})) {
      if (!['api', 'claude'].includes(input.via)) throw new Error('Nguồn Claude không hợp lệ.');
      nextConfig.via = input.via;
      configChanged = true;
    }
    if ('model' in (input || {})) {
      const value = String(input.model || '').trim();
      if (!/^claude-[a-z0-9-]{3,100}$/i.test(value)) throw new Error('Tên model Claude không hợp lệ.');
      nextConfig.model = value;
      configChanged = true;
    }
    if ('workspaceId' in (input || {})) {
      const value = String(input.workspaceId || '').trim();
      if (value && !/^[a-z0-9_-]{3,200}$/i.test(value))
        throw new Error('Anthropic Workspace ID không hợp lệ.');
      if (value) nextConfig.workspaceId = value;
      else delete nextConfig.workspaceId;
      configChanged = true;
    }
    if ('webSearch' in (input || {})) {
      nextConfig.webSearch = !!input.webSearch;
      configChanged = true;
    }
    if (configChanged) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(nextConfig, null, 2));
    }
    return status();
  };
  const complete = async (
    system,
    user,
    { maxTokens = 2400, webSearch: useSearchOpt, attachments = [] } = {},
  ) => {
    const useSearch = useSearchOpt ?? webSearch();
    if (via() === 'claude') {
      if (!claudeAvailable())
        throw new Error(
          'Chưa thấy Claude Code trên máy. Cài: npm i -g @anthropic-ai/claude-code, rồi chạy `claude` ' +
            'một lần và gõ /login để đăng nhập gói Claude (Pro/Max).',
        );
      // The CLI has no max_tokens/temperature flags; the plan is a short JSON answer either way.
      // With web search on, the built-in WebSearch tool is allowed (otherwise no tools at all).
      const r = await claudeRun(system, user, {
        timeoutMs: 180000,
        webSearch: useSearch,
        model: cliModel(),
        files: attachments.filter(a => a && a.base64),
      });
      if (!r.text.trim()) throw new Error('Claude không trả nội dung kế hoạch.');
      return { ...r, text: r.text.trim() };
    }
    const token = key();
    if (!token) throw new Error('Chưa nhập Claude API key cho Trợ lý đạo diễn.');
    const headers = {
      'content-type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    };
    if (workspaceId()) headers['anthropic-workspace-id'] = workspaceId();
    // Basic web_search variant: works on every Claude model, so it survives whatever model the
    // user configures. Anthropic runs the search server-side; the final text comes back in one
    // response (its tokens are billed, plus a per-search fee).
    // Tep dinh kem di truoc cau hoi: anh thanh block image, PDF thanh block document, con
    // tai lieu chu da duoc ghep thang vao `user` o tang goi.
    const blocks = [];
    for (const a of attachments) {
      if (!a || !a.base64) continue;
      const source = { type: 'base64', media_type: a.mime, data: a.base64 };
      if (a.mime === 'application/pdf') blocks.push({ type: 'document', source });
      else blocks.push({ type: 'image', source });
    }
    const content = blocks.length ? [...blocks, { type: 'text', text: user }] : user;
    const requestBody = { model: model(), max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content }] };
    if (useSearch) requestBody.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    const response = await send('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(useSearch ? 90000 : 45000),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const detail = String(payload?.error?.message || 'Không đọc được phản hồi').slice(0, 300);
      if (/anthropic-workspace-id/i.test(detail))
        throw new Error(
          'API key này cần Anthropic Workspace ID. Mở cấu hình Claude, nhập Workspace ID rồi lưu lại.',
        );
      if (response.status === 401 && /(?:invalid\s+x-api-key|invalid\s+api\s*key)/i.test(detail))
        throw new Error(
          'Claude API key không hợp lệ hoặc đã bị thu hồi. Hãy tạo/copy lại key trong Anthropic Console rồi lưu lại.',
        );
      throw new Error(`Claude API HTTP ${response.status}: ${detail}`);
    }
    const text = (payload.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
    if (!text) throw new Error('Claude không trả nội dung kế hoạch.');
    const usage = payload.usage || {};
    return { text, stopReason: String(payload.stop_reason || ''), model: String(payload.model || model()).slice(0, 100), usage: {
      inputTokens: Number(usage.input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
      cacheCreationTokens: Number(usage.cache_creation_input_tokens) || 0,
      cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
    } };
  };
  return { status, save, complete };
}
