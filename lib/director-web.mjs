// Shared "run one LLM turn" helpers for the Director and the Music analyzer: either through an
// OpenAI-compatible API key, or through the ChatGPT extension (web) as an ephemeral text job.
import crypto from 'node:crypto';
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

// One LLM turn: through the ChatGPT extension (via === 'web', no API key) or the API key.
export const runTurn = (via, system, user) =>
  via === 'web' ? runViaExtension(system + '\n\n' + user) : directorLLM.complete(system, user);
