// HTTP helpers: JSON replies, request bodies, worker auth, and the "not mine" route marker.
import { workerToken } from './config.mjs';

export function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}
export async function body(req) {
  let chunks = [],
    size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 150 * 1024 * 1024) throw new Error('File quá lớn. Giới hạn 100 MB cho một file.');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export function requireWorker(req) {
  if (req.headers.authorization !== 'Bearer ' + workerToken)
    throw Object.assign(new Error('Worker authentication required'), { status: 401 });
}

// A route group returns this when the request is not one of its routes.
export const NEXT = Symbol('next route');
