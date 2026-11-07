import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { json, readBody, readJson, withRequestSignal } from './http-utils.mjs';
import { createAuth, createRateLimiter, requireSameOrigin } from './auth.mjs';
import { makeFactCheck } from './openai.mjs';
import { transcribeAudio } from './mai.mjs';

export function createRouteHandler({ factCheck = makeFactCheck, transcribe = transcribeAudio, env = process.env, auth = createAuth({ env }), rateLimit = createRateLimiter() } = {}) {
  return async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/auth/session') return json(res, 200, { authenticated: auth.authenticated(req), configured: auth.configured(), mode: auth.mode() });
    if (req.method === 'POST') requireSameOrigin(req, env);
    if (req.method === 'POST' && path === '/api/auth/login') {
      const address = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      rateLimit(`login:${address}`, 8, 15 * 60_000);
      const { password } = await readJson(req, 4096);
      const cookie = auth.login(password);
      return json(res, 200, { authenticated: true }, { 'Set-Cookie': cookie });
    }
    if (req.method === 'POST' && path === '/api/auth/logout') return json(res, 200, { authenticated: false }, { 'Set-Cookie': auth.logout() });

    // Fail closed even for health and unknown routes. All paid upstream calls
    // are behind the same server-side check, not merely the React login screen.
    auth.require(req);
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, storage: 'browser', transcription: 'MAI-Transcribe-2' });
    if (req.method === 'POST' && path === '/api/transcribe') {
      rateLimit('transcribe:owner', 20, 60_000);
      const mimeType = String(req.headers['content-type'] || '').split(';')[0];
      if (!['audio/wav', 'application/octet-stream'].includes(mimeType)) throw new ApiError(415, 'unsupported_audio', 'Send PCM WAV audio.');
      const audio = await readBody(req);
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new ApiError(400, 'invalid_audio', 'A valid WAV audio chunk is required.');
      return json(res, 200, await withRequestSignal(req, res, (signal) => transcribe(audio, { mimeType: 'audio/wav', signal }), 65_000));
    }
    if (req.method === 'POST' && path === '/api/fact-check') {
      rateLimit('factcheck:owner', 30, 60_000);
      const { claim } = await readJson(req);
      if (typeof claim !== 'string' || !claim.trim() || claim.length > 2000) throw new ApiError(400, 'invalid_claim', 'Claim must contain 1–2000 characters.');
      const { result, metadata } = await withRequestSignal(req, res, (signal) => factCheck(claim.trim(), { signal }));
      if (result.hasClaim === false) return json(res, 200, { noClaim: true });
      return json(res, 200, { ...result, id: randomUUID(), timestamp: new Date().toISOString(), fromCache: false, metadata });
    }
    throw new ApiError(404, 'not_found', 'Not found');
  };
}
