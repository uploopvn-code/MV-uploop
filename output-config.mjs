import path from 'node:path';
export const defaultNaming = { image: '{node_id}_{job_id}.png', video: '{node_id}_{job_id}.mp4' };
export function validateDirectory(value) {
  const v = String(value || '').trim();
  if (!v || (!path.win32.isAbsolute(v) && !path.posix.isAbsolute(v)))
    throw new Error('Nhập đường dẫn tuyệt đối tới thư mục trên máy chạy Orbit.');
  if (/[\x00-\x1f]/.test(v) || v.includes('"')) throw new Error('Đường dẫn không hợp lệ.');
  return v;
}
export function validatePattern(value, kind) {
  const s = String(value || '').trim();
  if (!s.includes('{job_id}')) throw new Error('Tên file phải có {job_id} để tránh trùng kết quả.');
  const sample = s
    .replaceAll('{node_id}', 'scene')
    .replaceAll('{job_id}', 'job-123')
    .replaceAll('{kind}', kind);
  if (
    sample.length > 200 ||
    /[<>:"/\\|?*{}\x00-\x1f]/.test(sample) ||
    sample.endsWith('.') ||
    sample.endsWith(' ')
  )
    throw new Error(
      'Tên file chỉ dùng {node_id}, {job_id}, {kind}; không chứa đường dẫn hoặc ký tự cấm.',
    );
  if (!(kind === 'image' ? /\.(png|jpg|jpeg|webp)$/i : /\.(mp4|webm)$/i).test(sample))
    throw new Error('Đuôi file không phù hợp loại ảnh/video.');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(sample))
    throw new Error('Tên file dành riêng của Windows.');
  return s;
}
export function outputFor(directory, naming, nodeId, kind, jobId) {
  const dir = validateDirectory(directory),
    pattern = validatePattern(naming?.[kind] || defaultNaming[kind], kind);
  const filename = pattern
    .replaceAll('{node_id}', nodeId)
    .replaceAll('{job_id}', jobId)
    .replaceAll('{kind}', kind);
  const impl = dir.startsWith('/') ? path.posix : path.win32;
  return { directory: dir, filename, path: impl.join(dir, filename) };
}
