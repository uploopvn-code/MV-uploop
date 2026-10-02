// Orbit credentials and cookies stay on the local server, never in project JSON.
import crypto from 'node:crypto';
const base = process.env.MV_ORBIT_URL || 'http://192.168.100.5:8080';
const sessions = new Map();
const sid = req =>
  String(req.headers.cookie || '')
    .split(';')
    .map(s => s.trim())
    .find(s => s.startsWith('mv_orbit='))
    ?.slice(9);
const session = req => sessions.get(sid(req));
// The Orbit user of this browser session, without calling the Hub.
export const sessionUser = req => session(req)?.user || null;
async function request(endpoint, cookie, options = {}) {
  const r = await fetch(base + endpoint, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    signal: options.signal || AbortSignal.timeout(12000),
    redirect: 'error',
  });
  const b = await r.json();
  if (!r.ok)
    throw Object.assign(
      new Error(typeof b.detail === 'string' ? b.detail : 'Orbit HTTP ' + r.status),
      { status: r.status },
    );
  return { r, b };
}
export async function loginOrbit(req, res, b) {
  if (!b.email || !b.password) throw new Error('Điền email và mật khẩu Orbit.');
  const { r } = await request('/api/login', '', {
    method: 'POST',
    body: JSON.stringify({ email: String(b.email).trim(), password: String(b.password) }),
  });
  const cookie = r.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .find(c => c.startsWith('orbit_session='));
  if (!cookie) throw new Error('Hub không trả phiên đăng nhập.');
  const { b: auth } = await request('/api/auth-status', cookie);
  if (!auth.user) throw new Error('Hub chưa xác nhận người dùng.');
  const old = session(req);
  if (old) await request('/api/logout', old.cookie, { method: 'POST', body: '{}' }).catch(() => {});
  sessions.delete(sid(req));
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { cookie, user: auth.user });
  res.setHeader('Set-Cookie', `mv_orbit=${id}; HttpOnly; SameSite=Strict; Path=/`);
  return {
    url: base,
    authenticated: true,
    connected: true,
    user: auth.user,
    message: 'Đã đăng nhập Orbit. Mở node để chọn kịch bản và nick.',
  };
}
export async function logoutOrbit(req, res) {
  const s = session(req);
  sessions.delete(sid(req));
  res.setHeader('Set-Cookie', 'mv_orbit=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  if (s) await request('/api/logout', s.cookie, { method: 'POST', body: '{}' }).catch(() => {});
  return { ok: true };
}
export async function inspectOrbit(req) {
  const s = session(req);
  const empty = {
    url: base,
    authenticated: false,
    profiles: [],
    flows: [],
    workflows: [],
    apps: [],
  };
  try {
    const { b: auth } = await request('/api/auth-status', s?.cookie);
    if (!auth.user) {
      sessions.delete(sid(req));
      return {
        ...empty,
        connected: true,
        message: 'Đăng nhập bằng tài khoản Orbit để chọn nick và kịch bản.',
      };
    }
    const results = await Promise.all(
      ['/api/profiles', '/api/flows', '/api/workflows?light=true', '/api/apps'].map(p =>
        request(p, s.cookie),
      ),
    );
    return {
      url: base,
      connected: true,
      authenticated: true,
      user: auth.user,
      profiles: results[0].b.map(p => ({ id: p.id, name: p.name })),
      flows: results[1].b.map(f => ({ id: f.id, name: f.name })),
      workflows: results[2].b.map(w => ({ id: w.id, name: w.name })),
      apps: results[3].b
        .filter(a => a.enabled)
        .map(a => ({ id: a.id, name: a.name, public_params: a.public_params || [] })),
      message: 'Đã đăng nhập: ' + auth.user.email,
    };
  } catch (e) {
    if (e.status === 401) sessions.delete(sid(req));
    return {
      ...empty,
      connected: !!e.status,
      message:
        e.status === 401
          ? 'Phiên hết hạn. Hãy đăng nhập lại.'
          : 'Không đọc được Orbit: ' + e.message,
    };
  }
}
export async function validateBinding(req, b) {
  if (!b || !['flow', 'workflow', 'app'].includes(b.type) || !b.scriptId || !b.profileId)
    throw new Error('Chọn đủ kịch bản và nick chạy.');
  const c = await inspectOrbit(req);
  if (!c.authenticated) throw Object.assign(new Error(c.message), { status: 401 });
  const script = (b.type === 'app' ? c.apps : b.type === 'workflow' ? c.workflows : c.flows).find(
      x => x.id === b.scriptId,
    ),
    profile = c.profiles.find(x => x.id === b.profileId);
  if (!script || !profile)
    throw new Error('Kịch bản hoặc nick không còn trong danh sách của tài khoản này.');
  return {
    type: b.type,
    scriptId: script.id,
    scriptName: script.name,
    profileId: profile.id,
    profileName: profile.name,
    owner: c.user.email,
  };
}

export async function executeOrbit(req, job, onProgress) {
  const binding = await validateBinding(req, job.payload.orbit);
  if (binding.owner !== job.payload.orbit.owner)
    throw new Error('Đăng nhập đúng tài khoản đã tạo tác vụ.');
  const s = session(req);
  if (!s) throw new Error('Phiên Orbit hết hạn.');
  if (binding.type === 'app' && job.payload.inputFiles?.length) {
    const inventory = await inspectOrbit(req);
    const app = inventory.apps.find(a => a.id === binding.scriptId);
    const keys = new Set((app?.public_params || []).map(p => p.key));
    if (
      !keys.has('mv_inputs_json') &&
      !job.payload.inputFiles.every((_, i) => keys.has('mv_input_' + (i + 1) + '_path'))
    )
      throw new Error(
        'App cần công khai mv_inputs_json hoặc đủ mv_input_1_path, mv_input_2_path… để nhận ảnh đầu vào.',
      );
  }
  const prefix = '/api/profiles/' + encodeURIComponent(binding.profileId);
  const call = async (p, body, timeout = 12000) => {
    const { b } = await request(
      prefix + p,
      s.cookie,
      body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) },
    );
    return b;
  };
  const busy = await call('/flow-progress');
  if (busy.running) throw new Error('Nick đang chạy kịch bản khác. Không khởi chạy đè.');
  onProgress('Đang mở nick ' + binding.profileName);
  const launched = await call('/launch', {}, 120000);
  if (launched.ok === false) throw new Error(launched.detail || 'Không mở được nick');
  const check = await call('/flow-progress');
  if (check.running) throw new Error('Nick đang bận sau khi mở.');
  const vars = {
    prompt: job.payload.prompt,
    mv_prompt: job.payload.prompt,
    mv_job_id: job.id,
    mv_kind: job.kind,
    mv_duration: job.payload.timing.duration,
    mv_start: job.payload.timing.start || 0,
    mv_node_id: job.payload.nodeId || '',
    mv_aspect_ratio: job.payload.aspectRatio || '16:9',
    mv_output_dir: job.payload.output?.directory || '',
    mv_output_filename: job.payload.output?.filename || '',
    mv_output_path: job.payload.output?.path || '',
  };
  vars.mv_input_count = (job.payload.inputFiles || []).length;
  vars.mv_inputs_json = JSON.stringify(job.payload.inputFiles || []);
  for (const [i, ref] of (job.payload.inputFiles || []).entries())
    vars['mv_input_' + (i + 1) + '_path'] = ref.path;
  onProgress('Đang gọi kịch bản ' + binding.scriptName);
  if (binding.type === 'app') {
    const { b: result } = await request(
      '/api/apps/' + encodeURIComponent(binding.scriptId) + '/run',
      s.cookie,
      {
        method: 'POST',
        body: JSON.stringify({ profile_id: binding.profileId, inputs: vars, force: false }),
        signal: AbortSignal.timeout(1800000),
      },
    );
    if (!result.ok) throw new Error(result.detail || 'App chạy lỗi');
    return;
  }
  if (binding.type === 'flow') {
    // The flow endpoint is synchronous. Never retry an uncertain submission.
    const result = await call('/run-flow', { flow_id: binding.scriptId, vars }, 1800000);
    if (!result.ok) throw new Error(result.detail || 'Khối chạy lỗi');
    return;
  }
  const start = await call(
    '/run-workflow',
    { workflow_id: binding.scriptId, vars, async: true, force: false },
    30000,
  );
  if (!start.ok || !start.data?.started)
    throw new Error(start.detail || 'Hub chưa xác nhận bắt đầu');
  const deadline = Date.now() + 1800000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const p = await call('/flow-progress');
    onProgress(
      'Đang chạy: ' +
        String(p.step || 'kịch bản') +
        ' (' +
        (p.i || 0) +
        '/' +
        (p.total || '?') +
        ')',
    );
    if (p.done) {
      if (!p.ok) throw new Error('Kịch bản báo lỗi hoặc bị dừng. Xem nhật ký trên Orbit.');
      return;
    }
    if (!p.running)
      throw new Error('Mất trạng thái kịch bản. Kiểm tra nhật ký Orbit trước khi chạy lại.');
  }
  throw new Error('Quá thời gian theo dõi. Kịch bản có thể còn chạy trên Orbit.');
}
