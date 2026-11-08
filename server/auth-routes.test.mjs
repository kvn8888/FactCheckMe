import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAuth, createRateLimiter, hashPassword, requireSameOrigin } from './auth.mjs';
import { createRouteHandler } from './routes.mjs';
import { readBody, readJson, withRequestSignal } from './http-utils.mjs';

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
