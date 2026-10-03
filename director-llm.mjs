// Optional LLM backend for the Director's "auto" button. OpenAI-compatible
// /chat/completions, so it works with OpenAI, many gateways, or any compatible
// endpoint the user points it at. The key stays on the server, shared by projects.
import fs from 'node:fs';
import path from 'node:path';

export function createDirectorLLM(dataDir) {
  const keyFile = path.join(dataDir, 'director-key.txt');
  const cfgFile = path.join(dataDir, 'director-llm.json');
  const key = () => {
    if (process.env.MV_DIRECTOR_KEY) return process.env.MV_DIRECTOR_KEY.trim();
    try {
      return fs.readFileSync(keyFile, 'utf8').trim();
    } catch {
      return '';
    }
  };
  const cfg = () => {
    try {
      return JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const baseUrl = () =>
    (process.env.MV_DIRECTOR_URL || cfg().baseUrl || 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );
  const model = () => process.env.MV_DIRECTOR_MODEL || cfg().model || 'gpt-4o-mini';

  function status() {
    const k = key();
    return {
      configured: !!k,
      baseUrl: baseUrl(),
      model: model(),
      keyHint: k ? '…' + k.slice(-4) : '',
      source: process.env.MV_DIRECTOR_KEY ? 'env' : 'file',
    };
  }
  function save(b) {
    if ('key' in b) {
      const v = String(b.key || '').trim();
      if (v) {
        if (!/^[\x21-\x7e]{8,500}$/.test(v)) throw new Error('API key không hợp lệ.');
        fs.writeFileSync(keyFile, v, { mode: 0o600 });
      } else fs.rmSync(keyFile, { force: true });
    }
    const c = cfg();
    if (b.baseUrl) c.baseUrl = String(b.baseUrl).slice(0, 300);
    if (b.model) c.model = String(b.model).slice(0, 120);
    fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
    return status();
  }
  // Runs one chat turn, returns the assistant text.
  async function complete(system, user) {
    const k = key();
    if (!k) throw new Error('Chưa cấu hình API key LLM cho Đạo diễn.');
    const r = await fetch(baseUrl() + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify({
        model: model(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(Number(process.env.MV_DIRECTOR_TIMEOUT_MS) || 300000),
    });
    let j = null;
    try {
      j = await r.json();
    } catch {}
    if (!r.ok)
      throw new Error('LLM lỗi HTTP ' + r.status + ': ' + (j?.error?.message || j?.message || ''));
    const text = j?.choices?.[0]?.message?.content;
    if (!text) throw new Error('LLM không trả nội dung.');
    return text;
  }
  return { status, save, complete, configured: () => !!key() };
}
