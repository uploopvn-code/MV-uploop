// Shared "run one LLM turn" helpers for the Director and the Music analyzer: either through an
// OpenAI-compatible API key, or through the ChatGPT extension (web) as an ephemeral text job.
import crypto from 'node:crypto';
import { claudeAvailable, claudeComplete, claudeRun } from './claude-cli.mjs';
import { directorLLM } from './config.mjs';
import { db, save } from './projects.mjs';

// Has a ChatGPT extension worker checked in within the last 20 seconds? (Same window
// publicState() uses to light the "worker online" badge.)
export const workerOnline = () => Object.values(db.workers || {}).some(t => Date.now() - t < 20000);

// Generous: reasoning models (GPT-5 / o-series) can think for minutes then stream a large answer.
// Override with MV_DIRECTOR_WEB_TIMEOUT_MS.
const TEXT_TIMEOUT_MS = Number(process.env.MV_DIRECTOR_WEB_TIMEOUT_MS) || 720000;

// Runs one LLM turn through the ChatGPT extension instead of an API key: enqueue a bare text job
// the extension claims (it types the prompt into ChatGPT web and scrapes the reply), then wait
// for its result. Unlike an image job there is no node and no media — the job is ephemeral and
// removed once read, so it never lingers in the queue. The extension's claim/heartbeat/complete
// contract is reused as-is (kind: 'text').
export async function runViaExtension(prompt) {
  const id = crypto.randomUUID();
  db.jobs.push({
    id,
    kind: 'text',
    nodeId: null,
    status: 'queued',
    createdAt: new Date().toISOString(),
    payload: { kind: 'text', site: 'chatgpt', prompt, projectRevision: db.revision },
    error: null,
  });
  save();
  const deadline = Date.now() + TEXT_TIMEOUT_MS;
  try {
    for (;;) {
      const j = db.jobs.find(x => x.id === id);
      if (!j) throw new Error('Tác vụ đã bị hủy.');
      if (j.status === 'completed') return j.result?.text || '';
      if (j.status === 'failed' || j.status === 'needs_review')
        throw new Error(j.error || 'Extension báo lỗi khi chạy trên ChatGPT web.');
      if (Date.now() > deadline)
        throw new Error(
          'Quá thời gian chờ ChatGPT web trả lời. Kiểm tra tab ChatGPT và worker extension.',
        );
      await new Promise(r => setTimeout(r, 500));
    }
  } finally {
    const i = db.jobs.findIndex(x => x.id === id);
    if (i >= 0) {
      db.jobs.splice(i, 1);
      save();
    }
  }
}

// The three ways the tool can reach an LLM. ONE normaliser and ONE guard: before this, the script
// route, the node PATCH and the music route each squashed `via` to 'web' | 'api', so any new way
// silently fell back to the API key.
export const VIAS = ['api', 'web', 'claude'];
export const normVia = v => (VIAS.includes(v) ? v : 'api');
export function requireLLM(via) {
  if (via === 'claude') {
    if (!claudeAvailable())
      throw new Error(
        'Chưa thấy Claude Code trên máy. Cài: npm i -g @anthropic-ai/claude-code, rồi chạy `claude` ' +
          'một lần và gõ /login để đăng nhập gói Claude (Pro/Max).',
      );
    return;
  }
  if (via === 'web') {
    if (!workerOnline())
      throw new Error(
        'Chưa thấy extension ChatGPT online. Mở tab ChatGPT và bật worker extension.',
      );
    return;
  }
  if (!directorLLM.configured())
    throw new Error(
      'Chưa cấu hình API key LLM cho Đạo diễn — hoặc chọn "Claude (gói của bạn)" / "Chạy qua extension".',
    );
}

// One LLM turn, three ways:
//   'web'    — ChatGPT extension (no API key)
//   'claude' — Claude Code CLI on this machine, billed to the user's Claude plan (Pro/Max), no key
//   'api'    — the OpenAI-compatible director key
export const runTurn = (via, system, user) =>
  via === 'web'
    ? runViaExtension(system + '\n\n' + user)
    : via === 'claude'
      ? claudeComplete(system, user)
      : directorLLM.complete(system, user);

// ~4 characters per token: what ChatGPT web spends is not reported, so it is estimated from the
// text in and out (flagged `estimated`).
const guess = text => Math.ceil(String(text || '').length / 4);
// The same turn, with what it cost: { text, model, usage: { inputTokens, outputTokens,
// cacheCreationTokens, cacheReadTokens }, estimated } — the API's and Claude Code's own counts,
// an estimate for the extension.
export async function runTurnFull(via, system, user) {
  if (via === 'claude') return { ...(await claudeRun(system, user)), estimated: false };
  if (via === 'api') return { ...(await directorLLM.completeFull(system, user)), estimated: false };
  const text = await runViaExtension(system + '\n\n' + user);
  return {
    text,
    model: 'chatgpt-web',
    usage: {
      inputTokens: guess(system) + guess(user),
      outputTokens: guess(text),
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    estimated: true,
  };
}
