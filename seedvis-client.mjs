// Seedvis API (https://seedvis.com/api/v1) for image and video generation.
// The API key stays on the local server (env SEEDVIS_API_KEY or data/seedvis-key.txt)
// and is never sent to the browser or written to project JSON.
import fs from 'node:fs';
import path from 'node:path';
import { sniffMime } from './media-io.mjs';

const MAX_BYTES = 100 * 1024 * 1024;
const base = () => (process.env.MV_SEEDVIS_URL || 'https://seedvis.com/api/v1').replace(/\/+$/, '');

// Model catalog from the Seedvis API v2.0 docs. GET /models is only used to mark
// which ids the account can currently use.
const nano = name => ({
  name,
  api: 'google',
  maxImages: 10,
  aspect: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  upscale: ['none', '2k', '4k'],
});
export const catalog = {
  image: [
    { id: 'GEM_PIX_2', ...nano('Nano Banana Pro') },
    { id: 'NARWHAL', ...nano('Nano Banana 2') },
    { id: 'HARBOR_SEAL', ...nano('Nano Banana Lite') },
    {
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      api: 'openai',
      maxImages: 10,
      aspect: ['16:9', 'auto', '1:1', '3:4', '9:16', '4:3', '2:3', '3:2', '21:9'],
      upscale: [],
    },
  ],
  video: [
    {
      id: 'Veo-3.1',
      name: 'Google Veo 3.1',
      // 1 image → image-to-video; 2–3 → multi-image-to-video.
      imageField: 'image',
      single: true,
      multi: { mode: 'multi-image-to-video', field: 'referenceImages' },
      maxImages: 3,
      countMax: 4,
      aspect: ['16:9', '9:16'],
      durations: [4, 6, 8],
      durationSuffix: 's',
      upscale: ['none', '1080p'],
    },
    {
      id: 'seedance_2.5',
      name: 'Seedance 2.5',
      note: 'Seedance kiểm duyệt chặt và thường từ chối ảnh có người thật; nên dùng Veo cho ca sĩ.',
      imageField: 'reference_images',
      maxImages: 10,
      countMax: 8,
      aspect: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
      durations: [5, 10, 15, 20, 25, 30],
      upscale: [],
    },
    {
      id: 'seedance_2.0_fast',
      name: 'Seedance 2.0 Fast',
      note: 'Seedance kiểm duyệt chặt và thường từ chối ảnh có người thật; nên dùng Veo cho ca sĩ.',
      imageField: 'reference_images',
      maxImages: 9, // ByteDance: Seedance 2.0 takes at most 9 reference images
      countMax: 8,
      aspect: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'],
      durations: [5, 10, 15],
      upscale: [],
    },
    {
      id: 'Omni-Flash',
      name: 'Omni Flash',
      imageField: 'image',
      single: true,
      multi: { mode: 'multi-image-to-video', field: 'images' },
      // video-to-video: one source video (+0–3 images); the result is as long as the source and
      // keeps its audio — a still keyframe + the vocal of one sung line becomes that line lip-synced.
      v2v: true,
      maxImages: 3,
      countMax: 4,
      aspect: ['16:9', '9:16'],
      upscale: [],
    },
  ],
};
// Can this video model take a source video (video-to-video)?
export const takesVideo = model => !!catalog.video.find(m => m.id === model)?.v2v;
export const defaultSeedvis = {
  image: { model: 'GEM_PIX_2', aspectRatio: '16:9', upscale: 'none' },
  video: { model: 'Veo-3.1', aspectRatio: '16:9', upscale: 'none' },
};
const modelOf = (kind, id) => catalog[kind].find(m => m.id === id);
// Max video versions (count) a model accepts; 1 for anything else.
export function videoCountMax(model) {
  return modelOf('video', model)?.countMax || 1;
}

export function validateSeedvisBinding(kind, b) {
  const m = modelOf(kind, b?.model);
  if (!m)
    throw new Error('Chọn model Seedvis hợp lệ cho ' + (kind === 'image' ? 'ảnh.' : 'video.'));
  const aspectRatio = m.aspect.includes(b.aspectRatio) ? b.aspectRatio : m.aspect[0];
  const upscale = m.upscale.includes(b.upscale) ? b.upscale : m.upscale[0] || null;
  return { model: m.id, modelName: m.name, aspectRatio, upscale };
}

// Seedvis accepts a fixed set of durations per model; we always ask for the LONGEST one
// (Veo 3.1: 8s). A shot is cut to length in the edit, and the extra head and tail give
// room for that; a clip that ends exactly on the beat cannot be trimmed.
export function videoDuration(model) {
  const m = modelOf('video', model);
  if (!m?.durations) return null;
  return Math.max(...m.durations);
}

export function buildRequest(kind, binding, prompt, images, count = 1, video = null) {
  const m = modelOf(kind, binding.model);
  if (!m) throw new Error('Model Seedvis không còn hỗ trợ: ' + binding.model);
  if (kind === 'image') {
    const refs = images.slice(0, m.maxImages);
    if (images.length > m.maxImages)
      throw new Error(m.name + ' nhận tối đa ' + m.maxImages + ' ảnh tham chiếu.');
    if (m.api === 'openai')
      return refs.length
        ? {
            endpoint: '/images/edits',
            body: {
              model: m.id,
              prompt,
              image: refs,
              n: 1,
              size: binding.aspectRatio,
              quality: 'auto',
              response_format: 'url',
            },
          }
        : {
            endpoint: '/images/generations',
            body: {
              model: m.id,
              prompt,
              n: 1,
              size: binding.aspectRatio,
              quality: 'auto',
              response_format: 'url',
            },
          };
    return {
      endpoint: '/google/v1beta/interactions',
      body: {
        model: m.id,
        input: prompt,
        mode: refs.length ? 'image-to-image' : 'text-to-image',
        aspect_ratio: binding.aspectRatio,
        upscale_image: binding.upscale || 'none',
        count: 1,
        ...(refs.length ? { reference_images: refs } : {}),
      },
    };
  }
  const body = {
    model: m.id,
    prompt,
    aspect_ratio: binding.aspectRatio,
    count: Math.max(1, Math.min(count, m.countMax || 1)),
  };
  // A source video (e.g. a lip-sync take: keyframe + vocal): video-to-video, with any images as
  // optional references. No duration — the result is exactly as long as the source.
  if (video) {
    if (!m.v2v) throw new Error(m.name + ' không nhận video đầu vào (video-to-video).');
    if (images.length > m.maxImages)
      throw new Error(m.name + ' nhận tối đa ' + m.maxImages + ' ảnh kèm video.');
    body.mode = 'video-to-video';
    body.video = video;
    if (images.length) body.images = images;
    return { endpoint: '/developer/generations', body };
  }
  if (images.length) {
    const max = m.maxImages || 1;
    if (images.length > max) throw new Error(m.name + ' nhận tối đa ' + max + ' ảnh cho video.');
    if (m.multi && images.length > 1) {
      // Several images: use the model's multi-image-to-video mode.
      body.mode = m.multi.mode;
      body[m.multi.field] = images;
    } else {
      body.mode = 'image-to-video';
      body[m.imageField] = m.single ? images[0] : images;
    }
  } else body.mode = 'text-to-video';
  if (m.durations) {
    // The longest the model takes (room to trim), unless the job asks for a length it offers
    // (a Seedance group: its shots' total, rounded up to the next step).
    const d = m.durations.includes(Number(binding.duration))
      ? Number(binding.duration)
      : videoDuration(m.id);
    body.duration = m.durationSuffix ? d + m.durationSuffix : d;
  }
  if (m.id === 'Veo-3.1') body.upscale_video = binding.upscale || 'none';
  return { endpoint: '/developer/generations', body };
}

// Every 2xx body carries the same lifecycle fields, either at the root (Google
// style), under `data` (native) or as OpenAI `data: [{url}]`.
export function lifecycle(json) {
  if (Array.isArray(json?.data))
    return {
      status: 'completed',
      is_final: true,
      outputs: json.data.map(d => ({ url: d.url, b64: d.b64_json })),
      references: json.references,
    };
  const d = json?.data && typeof json.data === 'object' ? json.data : json || {};
  return d;
}

function errorText(json, status) {
  const e = json?.error;
  const fields = json?.errors && typeof json.errors === 'object' ? json.errors : null;
  const detail = fields
    ? Object.entries(fields)
        .map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v))
        .join('; ')
    : '';
  return (
    [typeof e === 'string' ? e : e?.message || e?.code, json?.message, detail]
      .filter(Boolean)
      .join(' · ') || 'Seedvis HTTP ' + status
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createSeedvis(dataDir) {
  const keyFile = path.join(dataDir, 'seedvis-key.txt');
  const key = () => {
    if (process.env.SEEDVIS_API_KEY) return process.env.SEEDVIS_API_KEY.trim();
    try {
      return fs.readFileSync(keyFile, 'utf8').trim();
    } catch {
      return '';
    }
  };
  async function call(url, options = {}) {
    const k = key();
    if (!k) throw Object.assign(new Error('Chưa nhập API key Seedvis.'), { definite: true });
    // Relative paths are under the API base (/api/v1); next.url values are absolute.
    const absolute = /^https?:\/\//.test(url) ? url : base() + url;
    const r = await fetch(absolute, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + k,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(options.timeout || 120000),
      redirect: 'follow',
    });
    let json = null;
    try {
      json = await r.json();
    } catch {}
    if (!r.ok)
      throw Object.assign(new Error(errorText(json, r.status)), {
        status: r.status,
        retryAfter: Number(r.headers.get('retry-after')) || 0,
        code: json?.error?.code || json?.code,
      });
    return json;
  }

  async function status() {
    const k = key();
    if (!k) return { configured: false, message: 'Chưa nhập API key Seedvis.', catalog };
    const out = {
      configured: true,
      source: process.env.SEEDVIS_API_KEY ? 'env' : 'file',
      keyHint: '…' + k.slice(-4),
      catalog,
    };
    try {
      const info = await call('/account/info', { timeout: 15000 });
      const d = info?.data || info || {};
      out.account = {
        plan: d.plan?.name || d.plan || d.package || null,
        balance: d.balance ?? d.credits ?? d.credit ?? null,
      };
      out.message = 'Đã kết nối Seedvis';
    } catch (e) {
      // Only a 401 means the key itself is bad. /account/info may simply be absent
      // (404) or unreachable — the key is still saved and generation still works.
      if (e.status === 401) {
        out.message = 'API key Seedvis không hợp lệ (401). Kiểm tra lại key.';
        out.error = true;
      } else {
        out.message = 'Đã lưu key Seedvis. Chưa đọc được thông tin tài khoản — vẫn dùng được.';
      }
    }
    try {
      const j = await call('/models', { timeout: 15000 });
      const list = [j, j?.data, j?.models, j?.data?.models].find(Array.isArray) || [];
      const ids = list.map(m => (typeof m === 'string' ? m : m.id || m.model)).filter(Boolean);
      if (ids.length) out.available = ids;
    } catch {}
    return out;
  }

  function saveKey(value) {
    const v = String(value || '').trim();
    if (!/^[\x21-\x7e]{8,500}$/.test(v)) throw new Error('API key không hợp lệ.');
    fs.writeFileSync(keyFile, v, { mode: 0o600 });
  }
  function removeKey() {
    fs.rmSync(keyFile, { force: true });
  }

  async function download(output, kind) {
    let bytes;
    if (output.b64) bytes = Buffer.from(output.b64, 'base64');
    else if (output.url) {
      // Signed CDN URLs must be used exactly as returned; only send the key to Seedvis itself.
      const sameHost = new URL(output.url).origin === new URL(base()).origin;
      const r = await fetch(output.url, {
        headers: sameHost ? { Authorization: 'Bearer ' + key() } : {},
        signal: AbortSignal.timeout(600000),
      });
      if (!r.ok)
        throw Object.assign(
          new Error(
            [403, 404, 410].includes(r.status)
              ? 'Seedvis đã làm xong nhưng file kết quả đã hết hạn lưu (HTTP ' + r.status + ').'
              : 'Không tải được file kết quả Seedvis (HTTP ' + r.status + ').',
          ),
          // an expired file will not come back: a plain failure, so the shot can be filmed again
          { definite: [403, 404, 410].includes(r.status) },
        );
      if (Number(r.headers.get('content-length')) > MAX_BYTES)
        throw new Error('File kết quả lớn hơn 100 MB.');
      bytes = Buffer.from(await r.arrayBuffer());
    } else throw new Error('Seedvis không trả file kết quả.');
    if (!bytes.length || bytes.length > MAX_BYTES)
      throw new Error('File kết quả trống hoặc lớn hơn 100 MB.');
    const mime = sniffMime(bytes);
    if (!mime.startsWith(kind + '/'))
      throw new Error(
        'Seedvis trả về file không đúng loại ' + (kind === 'image' ? 'ảnh.' : 'video.'),
      );
    const name = path.basename(new URL(output.url || 'file:///result').pathname) || 'seedvis';
    return { mime, base64: bytes.toString('base64'), name: 'seedvis-' + name };
  }

  // Follows next.url until is_final. Never resubmits: a resend is a new charge.
  async function poll(job, state, onProgress) {
    const timeout = Number(
      process.env.MV_SEEDVIS_TIMEOUT_MS || (job.kind === 'video' ? 1800000 : 600000),
    );
    const deadline = Date.now() + timeout;
    let failures = 0;
    while (!state.is_final) {
      // Note: a job the user cancelled keeps polling here on purpose. If Seedvis could
      // cancel it (still queued) the next poll returns failed/cancelled and we stop; if it
      // was already generating (and charged), we let it finish so the result is not wasted.
      if (Date.now() > deadline)
        throw new Error(
          'Quá thời gian chờ Seedvis. Tác vụ có thể vẫn chạy; bấm Kiểm tra lại, không tạo mới.',
        );
      const wait = Math.min(120, Math.max(1, Number(state.next?.after_seconds) || 5));
      await sleep(Number(process.env.MV_SEEDVIS_POLL_MS) || wait * 1000);
      const url =
        state.next?.url ||
        job.remote?.pollUrl ||
        '/developer/generations/' + encodeURIComponent(job.remote.id) + '?wait=0';
      try {
        const next = lifecycle(await call(url, { timeout: 90000 }));
        failures = 0;
        state = next;
        job.remote.status = state.status;
        if (state.next?.url) job.remote.pollUrl = state.next.url;
        const q = state.queue?.position ? ' · vị trí ' + state.queue.position : '';
        onProgress(
          'Seedvis: ' +
            ({ queued: 'đang xếp hàng', processing: 'đang tạo' }[state.status] || state.status) +
            q,
        );
      } catch (e) {
        // Seedvis has no such job (long gone, or never made): nothing is running, so it is a
        // plain failure — the shot can be filmed again.
        if (e.status === 404 || e.status === 410) {
          e.definite = true;
          e.message =
            'Seedvis không còn tác vụ này (không tồn tại hoặc đã quá hạn lưu). ' + e.message;
          throw e;
        }
        if (e.status && e.status !== 429 && e.status < 500) throw e;
        failures++;
        onProgress('Mất kết nối Seedvis, thử đọc lại trạng thái (' + failures + ')');
        await sleep(Math.min(60000, 2000 * failures));
      }
    }
    if (state.status === 'failed') {
      const e = state.error || {};
      // A job we asked to stop (or that Seedvis reports as cancelled) is not a real failure.
      if (job.cancelRequested || e.code === 'cancelled')
        throw Object.assign(new Error('Đã dừng theo yêu cầu.'), { aborted: true, definite: true });
      throw Object.assign(
        new Error('Seedvis báo lỗi: ' + (e.message || e.code || 'không rõ lý do')),
        { definite: true },
      );
    }
    const outs = (state.outputs || []).filter(o => o.url || o.b64);
    if (!outs.length)
      throw Object.assign(new Error('Seedvis không trả file kết quả.'), { definite: true });
    onProgress('Đang tải ' + outs.length + ' kết quả từ Seedvis');
    // Download every output (one per requested version), in order.
    const results = [];
    for (const o of outs) results.push(await download(o, job.kind));
    return results;
  }

  async function run(job, images, onProgress, onSave, video = null) {
    let request;
    try {
      request = buildRequest(
        job.kind,
        job.payload.seedvis,
        job.payload.prompt,
        images,
        job.payload.count || 1,
        video,
      );
    } catch (e) {
      // Refused before anything was sent (e.g. too many reference images): a plain failure,
      // not "check Seedvis" — there is nothing pending there.
      e.definite = true;
      throw e;
    }
    const { endpoint, body } = request;
    onProgress('Đang gửi yêu cầu tới Seedvis · ' + job.payload.seedvis.modelName);
    let json;
    let maybeSent = false; // an earlier attempt ended with no clear answer
    for (let attempt = 1; ; attempt++) {
      if (job.cancelRequested) {
        // Stopped while a lost reply leaves it unknown whether Seedvis took the request: not
        // "never sent" — it is re-sent later under the same key, never as a new request.
        if (maybeSent)
          throw new Error(
            'Đã dừng khi chưa rõ Seedvis đã nhận yêu cầu chưa (mất phản hồi). "✚ Tạo video còn thiếu" gửi lại cùng mã chống trùng, không tạo trùng.',
          );
        // Cancelled before the request even left: abort, nothing to collect upstream.
        throw Object.assign(new Error('Đã dừng theo yêu cầu.'), { aborted: true, definite: true });
      }
      try {
        // Same Idempotency-Key on every retry: Seedvis returns the same job, no second charge.
        json = await call(endpoint, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Idempotency-Key': job.id },
          timeout: 150000,
        });
        break;
      } catch (e) {
        // The plan's concurrency+queue is full (422): wait for a slot instead of failing,
        // so pushing every job at once degrades to queueing rather than errors.
        const queueFull =
          e.status === 422 && /queue|concurren|limit|capacity|too many/i.test(e.message || '');
        const transient = !e.status || e.status === 429 || e.status === 503 || queueFull;
        // no status, or a 5xx other than 503 server_busy: Seedvis may have taken it
        if (!e.status || (e.status >= 500 && e.status !== 503)) maybeSent = job.maybeSent = true;
        const maxAttempts = queueFull ? 12 : 4;
        if (!transient || attempt >= maxAttempts) {
          // A clear 4xx means Seedvis created nothing; a network error leaves it uncertain.
          // Except 409 idempotency_conflict: Seedvis already HAS a job under this key (sent
          // earlier with another body) — making a new one could pay for the shot twice.
          if (e.status === 409) {
            e.conflict = true;
            e.message =
              'Seedvis đã có một tác vụ với mã này (gửi trước đó). Kiểm tra lịch sử trên seedvis.com trước khi tạo lại. ' +
              e.message;
          } else if (queueFull) {
            // Still full after every retry. 422 on the create call means Seedvis made
            // nothing, so the job goes back in the queue to be sent later instead of
            // failing: a busy account is a reason to wait, never a lost run.
            e.requeue = true;
            e.definite = true; // nothing is pending remotely
          } else if (e.status && e.status < 500) e.definite = true;
          throw e;
        }
        onProgress(
          queueFull
            ? 'Hàng chờ Seedvis đầy, chờ chỗ trống (' + attempt + ')'
            : 'Seedvis bận, gửi lại cùng mã chống trùng (' + attempt + ')',
        );
        await sleep(e.retryAfter ? e.retryAfter * 1000 : Math.min(30000, 2000 * 2 ** attempt));
      }
    }
    const state = lifecycle(json);
    job.remote = {
      id: state.id || null,
      pollUrl: state.next?.url || null,
      status: state.status,
      mode: state.mode || body.mode || null,
      sent: images.length,
      used: Array.isArray(state.references) ? state.references.length : null,
    };
    if (job.remote.used !== null && job.remote.used !== images.length)
      job.warning =
        'Seedvis chỉ dùng ' + job.remote.used + '/' + images.length + ' ảnh tham chiếu.';
    onSave();
    if (!state.is_final && !job.remote.id && !job.remote.pollUrl)
      throw new Error('Seedvis không trả mã tác vụ để theo dõi.');
    return poll(job, state, onProgress);
  }

  async function resume(job, onProgress) {
    if (!job.remote?.id && !job.remote?.pollUrl)
      throw new Error(
        'Chưa xác nhận Seedvis đã nhận yêu cầu. Kiểm tra lịch sử trên seedvis.com; tạo lại sẽ là lượt mới.',
      );
    return poll(job, { is_final: false, next: { after_seconds: 1 } }, onProgress);
  }

  // Asks Seedvis to cancel a job. A still-queued job is stopped and refunded in full;
  // a job already at the provider replies 409 not_cancellable (nothing to refund).
  // Idempotent and best-effort: returns an outcome, never throws.
  async function cancel(job) {
    const id = job.remote?.id;
    if (!id) return { ok: false, outcome: 'no_id' };
    const url =
      job.kind === 'image'
        ? '/google/v1beta/operations/' + encodeURIComponent(id) + ':cancel'
        : '/developer/generations/' + encodeURIComponent(id) + '/cancel';
    try {
      const data = await call(url, { method: 'POST', timeout: 15000 });
      return { ok: true, outcome: data?.cancellation?.outcome || 'cancelled', data };
    } catch (e) {
      // 409 = already running/finished (cannot refund); anything else = transient/unknown.
      return {
        ok: false,
        outcome: e.status === 409 ? 'not_cancellable' : 'error',
        error: e.message,
      };
    }
  }

  return { status, saveKey, removeKey, run, resume, cancel, configured: () => !!key() };
}
