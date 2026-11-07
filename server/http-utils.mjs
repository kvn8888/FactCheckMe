import { ApiError } from './errors.mjs';

export const json = (res, statusCode, payload, extraHeaders = {}) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
};

export async function readBody(req, maxBytes = 3_500_000) {
  if (Number(req.headers['content-length']) > maxBytes) throw new ApiError(413, 'payload_too_large', 'Request body is too large');
  // Vercel may supply an already parsed body. Never bypass the size check.
  if (req.body !== undefined) {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (body.length > maxBytes) throw new ApiError(413, 'payload_too_large', 'Request body is too large');
    return body;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    total += data.length;
    if (total > maxBytes) throw new ApiError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes = 16_000) {
  if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw new ApiError(415, 'json_required', 'Content-Type must be application/json');
  try {
    const parsed = JSON.parse((await readBody(req, maxBytes)).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object');
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'Request body must be a JSON object');
  }
}

export async function withRequestSignal(req, res, operation, timeoutMs = 115_000) {
  const controller = new AbortController();
  const abort = () => controller.abort(new ApiError(499, 'request_cancelled', 'Request was cancelled'));
  const timer = setTimeout(() => controller.abort(new ApiError(504, 'request_timeout', 'Request timed out')), timeoutMs);
  timer.unref?.();
  req.once?.('aborted', abort);
  res.once?.('close', abort);
  try { return await operation(controller.signal); }
  finally {
    clearTimeout(timer);
    req.removeListener?.('aborted', abort);
    res.removeListener?.('close', abort);
  }
}
