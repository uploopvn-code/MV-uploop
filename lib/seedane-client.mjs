// Seedane — the desktop automation tool that drives Dola (video) and Muse (image / video) with
// the user's own logged-in accounts — through its LAN REST API (Seedane: Cài đặt → 🔌 API nội
// bộ; contract in its API-SERVER.md, tool 2.1.5-recode.32):
//   POST /v1/jobs (Idempotency-Key)  → 202 { jobId, status: QUEUED }
//   GET  /v1/jobs/:id                → { status: QUEUED|RUNNING|COMPLETED|FAILED, files, error }
//   GET  /v1/jobs/:id/file?n=i       → the bytes (409 while not done)
//   GET  /v1/accounts?platform=…     → its accounts;  GET /v1/health (no token)
// The token stays on this machine (data/seedane-token.txt or MV_SEEDANE_TOKEN) and is never
// sent to the browser or written into a project.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_URL = 'http://127.0.0.1:8787';
export const PLATFORMS = ['dola', 'muse'];
export const DOLA_MODELS = ['2.5', '2.0'];
const POLL_MS = Number(process.env.MV_SEEDANE_POLL_MS) || 5000;
// Dola 30 s "often takes a few minutes"; a full Seedane queue keeps a job QUEUED meanwhile.
const MAX_WAIT_MS = Number(process.env.MV_SEEDANE_TIMEOUT_MS) || 90 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

// The request body for one job. `images` are the reference images as { data (base64),
// file_name } — the same list the Seedvis path reads (same 20 MB / 40 MB limits, which are
// Seedane's too) — sent as data URLs.
export function buildBody(job, images = []) {
  const b = job.payload.seedane;
  const refs = images.map(
    im =>
      `data:${MIME[String(im.file_name || '').split('.').pop().toLowerCase()] || 'image/png'};base64,${im.data}`,
  );
  const common = {
    prompt: job.payload.prompt,
    aspect_ratio: job.payload.aspectRatio,
    ...(refs.length ? { reference_images: refs } : {}),
    ...(b.account ? { account: b.account } : {}),
  };
  if (b.platform === 'dola')
    return {
      platform: 'dola',
      model: DOLA_MODELS.includes(b.model) ? b.model : '2.5',
      // Seedane rounds UP to a length the model takes (2.5: 10/15/30, 2.0: 10/15)
      duration_sec: Math.max(1, Math.round(Number(b.duration) || 8)),
      count: Math.max(1, Math.min(8, Number(job.payload.count) || 1)),
      ...common,
    };
  return { platform: 'muse', kind: job.kind, ...common };
}

export function createSeedane(dataDir) {
  const tokenFile = path.join(dataDir, 'seedane-token.txt');
  const configFile = path.join(dataDir, 'seedane.json');
  const config = () => {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const token = () => {
    if (process.env.MV_SEEDANE_TOKEN) return process.env.MV_SEEDANE_TOKEN.trim();
    try {
      return fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      return '';
    }
  };
  const base = () =>
    String(process.env.MV_SEEDANE_URL || config().url || DEFAULT_URL).replace(/\/+$/, '');
  const configured = () => !!token();

  async function call(route, { method = 'GET', body, headers = {}, timeout = 30000, raw = false } = {}) {
    let r;
    try {
      r = await fetch(base() + route, {
        method,
        headers: {
          ...(route === '/v1/health' ? {} : { Authorization: 'Bearer ' + token() }),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      // not reached / no answer: whether Seedane took the request is unknown
      throw Object.assign(
        new Error(`Không kết nối được Seedane (${base()}): ${e.cause?.code || e.message}. Mở Seedane và bật API nội bộ.`),
        { network: true },
      );
    }
    if (raw && r.ok) return r;
    let json = null;
    try {
      json = await r.json();
    } catch {}
    if (!r.ok) {
      const msg = json?.error?.message || json?.message || json?.error || 'HTTP ' + r.status;
      const why =
        r.status === 401
          ? 'Token Seedane sai hoặc đã đổi — copy token mới trong Seedane (Cài đặt → API nội bộ).'
          : r.status === 403
            ? 'Seedane từ chối IP máy này — thêm IP vào "IP được phép" trong Seedane.'
            : '';
      throw Object.assign(new Error(`Seedane ${r.status}: ${why || msg}`), {
        status: r.status,
        code: json?.error?.code,
        // 409 = file not ready yet; 5xx may be transient; everything else is a definite no
        definite: r.status < 500 && r.status !== 409,
      });
    }
    return json;
  }

  async function status() {
    const out = { configured: configured(), url: base() };
    try {
      const h = await call('/v1/health', { timeout: 5000 });
      Object.assign(out, { ok: !!h?.ok, version: h?.version || '', platforms: h?.platforms || [] });
    } catch (e) {
      return { ...out, ok: false, error: e.message };
    }
    if (!out.configured) return out;
    try {
      out.accounts = {};
      for (const p of PLATFORMS) {
        const a = await call('/v1/accounts?platform=' + p, { timeout: 8000 });
        const list = a?.accounts?.[p] || [];
        out.accounts[p] = {
          total: list.length,
          ready: list.filter(x => x.status === 'READY').length,
          names: list.map(x => ({ id: x.id, name: x.name, status: x.status })).slice(0, 50),
        };
      }
    } catch (e) {
      out.error = e.message;
    }
    return out;
  }

  function save({ url, token: t } = {}) {
    if (url !== undefined) {
      const u = String(url || '').trim();
      if (u && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(u))
        throw new Error('Địa chỉ Seedane phải dạng http://IP:cổng, vd http://127.0.0.1:8787');
      const next = { ...config() };
      if (u) next.url = u.replace(/\/+$/, '');
      else delete next.url;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(next, null, 2));
    }
    if (t !== undefined) {
      const v = String(t || '').trim();
      if (!v) fs.rmSync(tokenFile, { force: true });
      else {
        if (!/^[\x21-\x7e]{8,500}$/.test(v)) throw new Error('Token Seedane không hợp lệ.');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(tokenFile, v, { mode: 0o600 });
      }
    }
  }

  // One job to the end: submit (or, sent before, find it again under the same Idempotency-Key —
  // Seedane hands back the same job, nothing is made twice), wait, download every file.
  // Returns [{ mime, base64, name }], the shape the Seedvis path stores.
  async function run(job, images, onProgress = () => {}, onSave = () => {}) {
    if (!configured())
      throw Object.assign(new Error('Chưa nhập token Seedane (Kết nối web → Seedane).'), {
        definite: true,
      });
    const label = job.payload.seedane.platform === 'dola' ? 'Dola' : 'Muse';
    if (!job.seedaneId) {
      onProgress(`Đang gửi lệnh tới Seedane · ${label}`);
      let r;
      for (let attempt = 1; ; attempt++) {
        try {
          r = await call('/v1/jobs', {
            method: 'POST',
            body: buildBody(job, images),
            headers: { 'Idempotency-Key': job.id },
            timeout: 60000,
          });
          break;
        } catch (e) {
          // no answer: the same key may be sent again safely
          if (e.network && attempt < 3) {
            await sleep(3000 * attempt);
            continue;
          }
          throw e;
        }
      }
      if (!r?.jobId) throw Object.assign(new Error('Seedane không trả mã job.'), { definite: true });
      job.seedaneId = r.jobId;
      onSave();
    }
    const started = Date.now();
    let misses = 0;
    for (;;) {
      let s;
      try {
        s = await call('/v1/jobs/' + encodeURIComponent(job.seedaneId), { timeout: 20000 });
        misses = 0;
      } catch (e) {
        if (e.definite) throw e; // 4xx: the job is unknown to Seedane / no longer ours
        if (++misses >= 24) throw e; // ~2 min without an answer: check later, never re-submit
        await sleep(POLL_MS);
        continue;
      }
      if (s.status === 'COMPLETED') {
        const files = Array.isArray(s.files) && s.files.length ? s.files : [{}];
        const out = [];
        for (let i = 0; i < files.length; i++) {
          onProgress(`Đang tải file ${i + 1}/${files.length} từ Seedane`);
          const r = await call(`/v1/jobs/${encodeURIComponent(job.seedaneId)}/file?n=${i}`, {
            raw: true,
            timeout: 300000,
          });
          const bytes = Buffer.from(await r.arrayBuffer());
          if (!bytes.length) throw new Error('Seedane trả file rỗng.');
          const mime = (r.headers.get('content-type') || files[i].mime || '').split(';')[0] ||
            (job.kind === 'video' ? 'video/mp4' : 'image/png');
          out.push({ mime, base64: bytes.toString('base64'), name: 'seedane-' + (files[i].name || `${job.kind}-${i + 1}`) });
        }
        return out;
      }
      if (s.status === 'FAILED') {
        // A job Seedane CANCELLED ("Đã hủy") was not refused for its content: tagging it
        // generation_failed would set the prompt doctor re-sending — another Dola render spent.
        const cancelled = /hủy|huy|cancel/i.test(String(s.error?.message || ''));
        const code = cancelled ? 'cancelled' : s.error?.code || 'internal';
        // timeout / rate_limited: Seedane keeps the job (NEEDS_REVIEW) and may still deliver it,
        // so it is NOT definite — the app leaves it as "Kiểm tra lại", which re-asks under the
        // same Idempotency-Key, instead of a dead failure that would re-render on retry.
        const recheck = code === 'timeout' || code === 'rate_limited';
        // "Seedane báo lỗi: … [content_policy]" — the prompt doctor reads the code
        throw Object.assign(new Error(`Seedane báo lỗi: ${s.error?.message || 'không rõ'} [${code}]`), {
          definite: !recheck,
          code,
        });
      }
      onProgress(
        `Seedane · ${label} · ${s.status === 'RUNNING' ? 'đang tạo' : 'đang chờ'}` +
          (s.progress ? ' · ' + String(s.progress).slice(0, 120) : ''),
      );
      if (Date.now() - started > MAX_WAIT_MS)
        throw new Error('Seedane chạy quá lâu — bấm "Kiểm tra lại" để hỏi tiếp, không tạo mới.');
      await sleep(POLL_MS);
    }
  }

  return { configured, status, save, run, url: base };
}
