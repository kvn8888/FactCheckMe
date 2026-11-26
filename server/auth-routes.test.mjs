import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAuth, createRateLimiter, hashPassword, requireSameOrigin } from './auth.mjs';
import { createRouteHandler } from './routes.mjs';
import { readBody, readJson, withRequestSignal } from './http-utils.mjs';
import { createRealtimeSession } from './openai.mjs';

const password = 'a test-only password, never a deployed credential';
const env = { APP_PASSWORD_HASH: hashPassword(password), APP_SESSION_SECRET: 'test-only-session-signing-secret-not-for-deployment' };
const request = (path, { method = 'GET', body, cookie, origin = 'http://localhost:8080', contentType = 'application/json', ...headers } = {}) => {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)]);
  req.method = method; req.url = path;
  req.headers = { host: 'localhost:8080', origin, 'content-type': contentType, ...(cookie ? { cookie } : {}), ...headers };
  return req;
};
const response = () => ({ status: 0, headers: {}, payload: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(raw) { this.payload = JSON.parse(raw); } });
const cookie = createAuth({ env }).login(password).split(';')[0];
const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

describe('private authentication', () => {
  it('fails closed without configuration', () => {
    const auth = createAuth({ env: {} });
    expect(auth.configured()).toBe(false);
    expect(() => auth.require(request('/api/health'))).toThrow('not configured');
    expect(() => auth.login(password)).toThrow('not configured');
  });
  it('only enables native protection mode on Vercel with an explicit owner assertion', () => {
    expect(createAuth({ env: { VERCEL_AUTH_PROTECTED: 'true' } }).configured()).toBe(false);
    expect(createAuth({ env: { VERCEL: '1' } }).configured()).toBe(false);
    const auth = createAuth({ env: { VERCEL: '1', VERCEL_AUTH_PROTECTED: 'true' } });
    expect(auth.mode()).toBe('vercel'); expect(auth.authenticated(request('/'))).toBe(true);
  });
  it('issues HttpOnly, Strict cookies and production Secure cookies', () => {
    const auth = createAuth({ env: { ...env, VERCEL: '1' } });
    const issued = auth.login(password);
    expect(issued).toContain('HttpOnly'); expect(issued).toContain('SameSite=Strict'); expect(issued).toContain('Secure');
    expect(auth.authenticated(request('/', { cookie: issued.split(';')[0] }))).toBe(true);
    expect(auth.logout()).toContain('Max-Age=0');
  });
  it('rejects incorrect passwords, tampered tokens and expired tokens', () => {
    let time = Date.now(); const auth = createAuth({ env, now: () => time });
    expect(() => auth.login('wrong')).toThrow('Incorrect password');
    const issued = auth.login(password).split(';')[0];
    expect(auth.authenticated(request('/', { cookie: `${issued}x` }))).toBe(false);
    time += 8 * 3600_000 + 1000;
    expect(auth.authenticated(request('/', { cookie: issued }))).toBe(false);
  });
  it('changing password hash revokes existing cookies', () => {
    const changed = createAuth({ env: { ...env, APP_PASSWORD_HASH: hashPassword('different password') } });
    expect(changed.authenticated(request('/', { cookie }))).toBe(false);
  });
  it('rejects absent and cross-origin POST origins', () => {
    expect(() => requireSameOrigin(request('/', { origin: 'https://attacker.example' }), env)).toThrow('Cross-origin');
    expect(() => requireSameOrigin(request('/', { origin: '' }), env)).toThrow('same-origin');
    expect(() => requireSameOrigin(request('/'), env)).not.toThrow();
  });
  it('limits attempts and resets buckets after the window', () => {
    let time = 0; const limit = createRateLimiter({ now: () => time });
    limit('test', 1, 1000); expect(() => limit('test', 1, 1000)).toThrow('Too many');
    time = 1001; expect(() => limit('test', 1, 1000)).not.toThrow();
  });
});

describe('API gate and input limits', () => {
  it('blocks direct unauthenticated provider requests before any upstream call', async () => {
    const factCheck = vi.fn(); const transcribe = vi.fn(); const route = createRouteHandler({ env, factCheck, transcribe });
    await expect(route(request('/api/fact-check', { method: 'POST', body: { claim: 'claim' } }), response())).rejects.toMatchObject({ statusCode: 401 });
    await expect(route(request('/api/transcribe', { method: 'POST', contentType: 'audio/wav', body: Buffer.alloc(44) }), response())).rejects.toMatchObject({ statusCode: 401 });
    expect(factCheck).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
  });
  it('supports login/session/logout with a server cookie only', async () => {
    const route = createRouteHandler({ env }); const res = response();
    await route(request('/api/auth/login', { method: 'POST', body: { password } }), res);
    expect(res.status).toBe(200); expect(res.payload).toEqual({ authenticated: true });
    const session = response();
    await route(request('/api/auth/session', { cookie: res.headers['Set-Cookie'].split(';')[0] }), session);
    expect(session.payload).toEqual({ authenticated: true, configured: true, mode: 'password' });
    const logout = response(); await route(request('/api/auth/logout', { method: 'POST' }), logout);
    expect(logout.headers['Set-Cookie']).toContain('Max-Age=0');
  });
  it('returns ephemeral facts without database writes and passes no session ID upstream', async () => {
    const factCheck = vi.fn().mockResolvedValue({ result: { hasClaim: true, claim: 'Earth orbits the Sun', verdict: 'true', confidence: 95, sources: [] }, metadata: {} });
    const route = createRouteHandler({ env, factCheck }); const res = response();
    await route(request('/api/fact-check', { method: 'POST', cookie, body: { claim: ' Earth orbits the Sun ', sessionId: 'browser-only' } }), res);
    expect(factCheck).toHaveBeenCalledWith('Earth orbits the Sun', { signal: expect.any(AbortSignal) }); expect(res.payload.id).toBeTypeOf('string'); expect(res.payload.timestamp).toBeTypeOf('string');
  });
  it('passes trimmed transcript context without changing the no-claim response', async () => {
    const factCheck = vi.fn().mockResolvedValue({ result: { hasClaim: false }, metadata: {} });
    const route = createRouteHandler({ env, factCheck }); const res = response();
    await route(request('/api/fact-check', { method: 'POST', cookie, body: { claim: ' Hello! ', context: ' Earth orbits the Sun. ' } }), res);
    expect(factCheck).toHaveBeenCalledWith('Hello!', { context: 'Earth orbits the Sun.', signal: expect.any(AbortSignal) });
    expect(res.payload).toEqual({ noClaim: true });
  });
  it.each([null, 1, false, {}, [], 'x'.repeat(6001)])('rejects invalid JSON context before providers %#', async (context) => {
    const factCheck = vi.fn(); const route = createRouteHandler({ env, factCheck });
    await expect(route(request('/api/fact-check', { method: 'POST', cookie, body: { claim: 'An assertion.', context } }), response())).rejects.toMatchObject({ statusCode: 400, code: 'invalid_context' });
    expect(factCheck).not.toHaveBeenCalled();
  });
  it.each(['', '  ', 'x'.repeat(6000)])('accepts empty or maximum-length context %#', async (context) => {
    const factCheck = vi.fn().mockResolvedValue({ result: { hasClaim: false }, metadata: {} });
    const route = createRouteHandler({ env, factCheck });
    await route(request('/api/fact-check', { method: 'POST', cookie, body: { claim: 'An assertion.', context } }), response());
    expect(factCheck).toHaveBeenCalledWith('An assertion.', { signal: expect.any(AbortSignal), ...(context.trim() ? { context: context.trim() } : {}) });
  });
  it.each(['漢', '\u0001'])('accepts maximum-length multibyte or JSON-escaped input %#', async (character) => {
    const factCheck = vi.fn().mockResolvedValue({ result: { hasClaim: false }, metadata: {} });
    const route = createRouteHandler({ env, factCheck });
    const claim = character.repeat(2000); const context = character.repeat(6000);
    const body = JSON.stringify({ claim, context });
    expect(Buffer.byteLength(body)).toBeGreaterThan(16000);
    await route(request('/api/fact-check', { method: 'POST', cookie, body }), response());
    expect(factCheck).toHaveBeenCalledWith(claim, { context, signal: expect.any(AbortSignal) });
  });
  it('still bounds fact-check JSON bodies before provider calls', async () => {
    const factCheck = vi.fn(); const route = createRouteHandler({ env, factCheck });
    await expect(route(request('/api/fact-check', { method: 'POST', cookie, body: { claim: 'A claim.', context: 'x'.repeat(64000) } }), response())).rejects.toMatchObject({ statusCode: 413 });
    expect(factCheck).not.toHaveBeenCalled();
  });
  it('enforces claim length and WAV signatures before providers', async () => {
    const factCheck = vi.fn(); const transcribe = vi.fn(); const route = createRouteHandler({ env, factCheck, transcribe });
    await expect(route(request('/api/fact-check', { method: 'POST', cookie, body: { claim: 'x'.repeat(2001) } }), response())).rejects.toMatchObject({ statusCode: 400 });
    await expect(route(request('/api/transcribe', { method: 'POST', cookie, contentType: 'audio/wav', body: Buffer.alloc(44) }), response())).rejects.toMatchObject({ statusCode: 400 });
    expect(factCheck).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
  });
  it('accepts Vercel pre-parsed binary buffers and forwards WAV MIME to MAI', async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: 'Test audio.' });
    const route = createRouteHandler({ env, transcribe });
    const req = request('/api/transcribe', { method: 'POST', cookie, contentType: 'application/octet-stream' });
    req.body = Buffer.alloc(48); req.body.write('RIFF', 0); req.body.write('WAVE', 8);
    const res = response(); await route(req, res);
    expect(transcribe).toHaveBeenCalledWith(req.body, { mimeType: 'audio/wav', signal: expect.any(AbortSignal) });
    expect(res.payload).toEqual({ text: 'Test audio.' });
  });
  it('cancels upstream work when the browser disconnects', async () => {
    const req = request('/'); const res = new EventEmitter();
    let upstreamSignal;
    const pending = withRequestSignal(req, res, (signal) => new Promise((resolve, reject) => { upstreamSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
    res.emit('close');
    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
    expect(upstreamSignal.aborted).toBe(true); expect(res.listenerCount('close')).toBe(0);
  });
  it('enforces body caps for streaming and pre-parsed Vercel bodies', async () => {
    await expect(readBody(request('/', { body: 'long' }), 2)).rejects.toMatchObject({ statusCode: 413 });
    const parsed = request('/'); parsed.body = { a: 'long' };
    await expect(readBody(parsed, 2)).rejects.toMatchObject({ statusCode: 413 });
    await expect(readJson(request('/', { contentType: 'text/plain', body: '{}' }))).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe('Realtime transcription session broker', () => {
  const post = (overrides = {}) => request('/api/realtime/session', { method: 'POST', cookie, body: { sdp }, ...overrides });

  it('requires a same-origin owner before accepting an SDP offer', async () => {
    const createRealtimeSession = vi.fn();
    const route = createRouteHandler({ env, createRealtimeSession });
    await expect(route(post({ cookie: undefined }), response())).rejects.toMatchObject({ statusCode: 401 });
    await expect(route(post({ origin: 'https://other.example' }), response())).rejects.toMatchObject({ statusCode: 403 });
    await expect(route(post({ origin: '' }), response())).rejects.toMatchObject({ statusCode: 403 });
    expect(createRealtimeSession).not.toHaveBeenCalled();
  });

  it('accepts JSON and raw browser SDP and returns only the SDP answer', async () => {
    const createRealtimeSession = vi.fn().mockResolvedValue({ sdp, extra: 'server-only' });
    const telemetry = vi.fn();
    const route = createRouteHandler({ env, createRealtimeSession, telemetry });
    for (const req of [post(), post({ contentType: 'application/sdp', body: sdp })]) {
      const res = response();
      await route(req, res);
      expect(res.payload).toEqual({ sdp });
      expect(res.headers['Cache-Control']).toBe('no-store');
    }
    expect(createRealtimeSession).toHaveBeenCalledTimes(2);
    expect(createRealtimeSession).toHaveBeenCalledWith(sdp, { signal: expect.any(AbortSignal), env });
    expect(telemetry).toHaveBeenCalledWith('realtime.session.completed', { requestId: expect.any(String), durationMs: expect.any(Number), statusCode: 200 });
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('m=audio');
    const health = response();
    await route(request('/api/health', { cookie }), health);
    expect(health.payload).toEqual({
      ok: true,
      storage: 'browser',
      transcription: 'gpt-live-transcribe',
      providers: [],
      defaultProvider: 'openai-realtime',
    });
  });

  it('rejects invalid or oversized SDP and unsupported media before calling OpenAI', async () => {
    const createRealtimeSession = vi.fn();
    const route = createRouteHandler({ env, createRealtimeSession });
    for (const body of [{}, { sdp: 1 }, { sdp: 'v=0\r\n' }, { sdp: sdp + '\0' }]) {
      await expect(route(post({ body }), response())).rejects.toMatchObject({ statusCode: 400, code: 'invalid_request' });
    }
    await expect(route(post({ contentType: 'application/sdp', body: sdp + 'x'.repeat(64_000) }), response())).rejects.toMatchObject({ statusCode: 413 });
    await expect(route(post({ contentType: 'text/plain', body: sdp }), response())).rejects.toMatchObject({ statusCode: 415 });
    expect(createRealtimeSession).not.toHaveBeenCalled();
  });

  it('limits the owner to 20 exchanges per minute and advertises the reset', async () => {
    let time = 0;
    const createRealtimeSession = vi.fn().mockResolvedValue({ sdp });
    const route = createRouteHandler({ env, createRealtimeSession, rateLimit: createRateLimiter({ now: () => time }) });
    for (let attempt = 0; attempt < 20; attempt++) await route(post(), response());
    time = 42_200;
    await expect(route(post(), response())).rejects.toMatchObject({ statusCode: 429, code: 'rate_limited', retryAfter: 18 });
    expect(createRealtimeSession).toHaveBeenCalledTimes(20);
  });

  it('logs only error codes and timings when the upstream rejects the offer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('secret upstream message', { status: 400 }));
    const telemetry = vi.fn();
    const route = createRouteHandler({
      env: { ...env, OPENAI_API_KEY: 'test-openai-key' }, telemetry,
      createRealtimeSession: (sdp, options) => createRealtimeSession(sdp, { ...options, fetchImpl }),
    });
    await expect(route(post(), response())).rejects.toMatchObject({
      statusCode: 502, code: 'provider_error', message: 'OpenAI Realtime session could not be created',
    });
    expect(telemetry).toHaveBeenCalledWith('realtime.session.failed', {
      requestId: expect.any(String), durationMs: expect.any(Number), errorCode: 'provider_error', statusCode: 502,
    });
  });
});

describe('Fact-check completion gate route', () => {
  const post = (requireComplete) => request('/api/fact-check', { method: 'POST', cookie, body: { claim: ' That journey takes ', requireComplete } });

  it('returns incomplete as a successful result and records it without a verdict', async () => {
    const factCheck = vi.fn().mockResolvedValue({ result: { incomplete: true }, metadata: {} });
    const telemetry = vi.fn();
    const route = createRouteHandler({ env, factCheck, telemetry });
    const res = response();
    await route(post(true), res);
    expect(factCheck).toHaveBeenCalledWith('That journey takes', { signal: expect.any(AbortSignal), requireComplete: true });
    expect(res.payload).toEqual({ incomplete: true });
    expect(telemetry).toHaveBeenCalledWith('fact_check.completed', expect.objectContaining({ incomplete: true, statusCode: 200 }));
    expect(telemetry.mock.calls[0][1]).not.toHaveProperty('verdict');
  });

  it.each([null, 'false', 1, {}])('rejects non-boolean requireComplete values %#', async value => {
    const factCheck = vi.fn();
    await expect(createRouteHandler({ env, factCheck })(post(value), response())).rejects.toMatchObject({ statusCode: 400, code: 'invalid_request' });
    expect(factCheck).not.toHaveBeenCalled();
  });
});
