import { createRouteHandler } from './routes.mjs';
import { toPublicError } from './errors.mjs';
import { json } from './http-utils.mjs';

const route = createRouteHandler();
export default async function handler(req, res) {
  try { await route(req, res); }
  catch (error) {
    const { statusCode, payload } = toPublicError(error);
    // Never log request bodies, provider responses, credentials or transcripts.
    if (statusCode >= 500) console.error('FactCheckMe API failure', payload.code);
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) json(res, statusCode, payload, statusCode === 429 && Number.isSafeInteger(error.retryAfter) ? { 'Retry-After': String(error.retryAfter) } : {});
    else res.end();
  }
}
