import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { json, readBody, readJson, withRequestSignal } from './http-utils.mjs';
import { createAuth, createRateLimiter, requireSameOrigin } from './auth.mjs';
import { createRealtimeSession as brokerRealtimeSession, isSdp, makeFactCheck, REALTIME_TRANSCRIPTION_MODEL } from './openai.mjs';
import { transcribeAudio } from './mai.mjs';
import { getRealtimeProviders } from './mai-streaming.mjs';
import { createTranscriptLogger, telemetryCorrelation } from './telemetry.mjs';

export function createRouteHandler({ factCheck = makeFactCheck, transcribe = transcribeAudio, createRealtimeSession = brokerRealtimeSession, env = process.env, auth = createAuth({ env }), rateLimit = createRateLimiter(), telemetry = createTranscriptLogger({ env }) } = {}) {
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
    if (req.method === 'GET' && path === '/api/health') {
      const { providers, defaultProvider } = getRealtimeProviders(env);
      return json(res, 200, { ok: true, storage: 'browser', transcription: REALTIME_TRANSCRIPTION_MODEL, providers, defaultProvider });
    }
    if (req.method === 'POST' && path === '/api/realtime/session') {
      rateLimit('realtime:owner', 20, 60_000);
      const contentType = String(req.headers['content-type'] || '').split(';')[0];
      const sdp = contentType === 'application/sdp'
        ? (await readBody(req, 64_000)).toString('utf8')
        : (await readJson(req, 64_000)).sdp;
      if (!isSdp(sdp)) throw new ApiError(400, 'invalid_request', 'A valid WebRTC SDP offer is required.');
      const started = Date.now();
      const requestId = randomUUID();
      try {
        const answer = await withRequestSignal(req, res, (signal) => createRealtimeSession(sdp, { signal, env }), 27_000);
        await telemetry('realtime.session.completed', { requestId, durationMs: Date.now() - started, statusCode: 200 });
        return json(res, 200, { sdp: answer.sdp });
      } catch (error) {
        await telemetry('realtime.session.failed', { requestId, durationMs: Date.now() - started, errorCode: error.code, statusCode: error.statusCode });
        throw error;
      }
    }
    if (req.method === 'POST' && path === '/api/transcribe') {
      rateLimit('transcribe:owner', 20, 60_000);
      const mimeType = String(req.headers['content-type'] || '').split(';')[0];
      if (!['audio/wav', 'application/octet-stream'].includes(mimeType)) throw new ApiError(415, 'unsupported_audio', 'Send PCM WAV audio.');
      const audio = await readBody(req);
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new ApiError(400, 'invalid_audio', 'A valid WAV audio chunk is required.');
      const started = Date.now();
      const diagnostic = { requestId: randomUUID(), ...telemetryCorrelation(req), audioBytes: audio.length };
      try {
        const result = await withRequestSignal(req, res, (signal) => transcribe(audio, { mimeType: 'audio/wav', signal }), 65_000);
        await telemetry('transcription.completed', { ...diagnostic, durationMs: Date.now() - started, text: result.text, textLength: result.text.length, statusCode: 200 });
        return json(res, 200, result);
      } catch (error) {
        await telemetry('transcription.failed', { ...diagnostic, durationMs: Date.now() - started, errorCode: error.code, statusCode: error.statusCode });
        throw error;
      }
    }
    if (req.method === 'POST' && path === '/api/fact-check') {
      rateLimit('factcheck:owner', 30, 60_000);
      // Allow UTF-8 and JSON escapes within the validated character limits.
      const { claim, context, requireComplete } = await readJson(req, 64_000);
      if (typeof claim !== 'string' || !claim.trim() || claim.length > 2000) throw new ApiError(400, 'invalid_claim', 'Claim must contain 1–2000 characters.');
      if (context !== undefined && (typeof context !== 'string' || context.length > 6000)) throw new ApiError(400, 'invalid_context', 'Context must be a string of at most 6000 characters.');
      if (requireComplete !== undefined && typeof requireComplete !== 'boolean') throw new ApiError(400, 'invalid_request', 'requireComplete must be a boolean.');
      const started = Date.now();
      const diagnostic = { requestId: randomUUID(), ...telemetryCorrelation(req), claim: claim.trim(), context: context?.trim(), claimLength: claim.trim().length, contextLength: context?.trim().length || 0 };
      try {
        const { result, metadata } = await withRequestSignal(req, res, (signal) => factCheck(claim.trim(), { signal, ...(context?.trim() ? { context: context.trim() } : {}), ...(requireComplete !== undefined ? { requireComplete } : {}) }));
        if (result.incomplete === true) {
          await telemetry('fact_check.completed', { ...diagnostic, durationMs: Date.now() - started, incomplete: true, statusCode: 200 });
          return json(res, 200, { incomplete: true });
        }
        await telemetry('fact_check.completed', { ...diagnostic, durationMs: Date.now() - started, noClaim: result.hasClaim === false, verdict: result.verdict, confidence: result.confidence, statusCode: 200 });
        if (result.hasClaim === false) return json(res, 200, { noClaim: true });
        return json(res, 200, { ...result, id: randomUUID(), timestamp: new Date().toISOString(), fromCache: false, metadata });
      } catch (error) {
        await telemetry('fact_check.failed', { ...diagnostic, durationMs: Date.now() - started, errorCode: error.code, statusCode: error.statusCode });
        throw error;
      }
    }
    throw new ApiError(404, 'not_found', 'Not found');
  };
}
