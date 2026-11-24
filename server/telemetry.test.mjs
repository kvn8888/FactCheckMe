import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createTranscriptLogger, redactTranscript, telemetryCorrelation } from './telemetry.mjs';
import { createRouteHandler } from './routes.mjs';
import { ApiError } from './errors.mjs';

const env = { AXIOM_TRANSCRIPT_LOGGING: 'true', AXIOM_TOKEN: 'test-only-axiom-token', AXIOM_DATASET: 'test-transcripts' };
const accepted = () => ({ ok: true, json: async () => ({ ingested: 1, failed: 0 }) });
const req = (url, body, headers = {}) => Object.assign(Readable.from([Buffer.isBuffer(body) ? body : JSON.stringify(body)]), { url, method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers } });
const res = () => ({ writeHead: vi.fn(), end: vi.fn() });
const auth = { require: vi.fn() };
const wav = () => { const value = Buffer.alloc(48); value.write('RIFF'); value.write('WAVE', 8); return value; };

describe('Axiom transcript telemetry', () => {
  it.each([{}, { ...env, AXIOM_TRANSCRIPT_LOGGING: 'false' }, { ...env, AXIOM_TOKEN: '' }, { ...env, AXIOM_DATASET: '' }])('does nothing without explicit enablement and complete configuration %#', async configuration => {
    const fetchImpl = vi.fn(); const log = createTranscriptLogger({ env: configuration, fetchImpl });
    expect(log.enabled).toBe(false); expect(await log('transcription.completed', { text: 'secret' })).toBe(false); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('sends only allowed fields to the fixed Axiom host, with redirects blocked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(accepted());
    const log = createTranscriptLogger({ env: { ...env, AXIOM_ENDPOINT: 'https://evil.example', AXIOM_DATASET: 'name/../evil' }, fetchImpl });
    expect(await log('transcription.completed', { requestId: 'uuid', text: 'The Earth orbits the Sun.', audioBytes: 192044, authorization: 'private', audio: Buffer.from('never'), cookie: 'private', error: new Error('never'), providerResponse: { private: true } })).toBe(true);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.axiom.co/v1/datasets/name%2F..%2Fevil/ingest'); expect(options.redirect).toBe('error');
    const [record] = JSON.parse(options.body);
    expect(record).toMatchObject({ service: 'factcheckme', schemaVersion: 1, event: 'transcription.completed', requestId: 'uuid', text: 'The Earth orbits the Sun.', audioBytes: 192044 });
    expect(Object.keys(record).sort()).toEqual(['_time', 'audioBytes', 'event', 'requestId', 'schemaVersion', 'service', 'text'].sort());
    expect(options.headers.Authorization).toBe(`Bearer ${env.AXIOM_TOKEN}`);
  });
  it('redacts configured secrets and common credential formats before truncation', () => {
    const text = 'OPENAI private-known-secret Bearer abc.def password=shhh api_key:"quoted secret" sk-testtoken12345 ghp_token123456 eyJabc.xyz.def';
    const redacted = redactTranscript(text, { OPENAI_API_KEY: 'private-known-secret' });
    for (const secret of ['private-known-secret', 'abc.def', 'shhh', 'quoted secret', 'sk-testtoken12345', 'ghp_token123456', 'eyJabc.xyz.def']) expect(redacted).not.toContain(secret);
    expect(redacted).toContain('[REDACTED]');
    expect(redactTranscript('some-long-secret', { AXIOM_TOKEN: 'some-long-secret' }, 5)).toBe('[REDA');
  });
  it('bounds text/context/claim, strips arbitrary errors and invalid numeric fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(accepted()); const log = createTranscriptLogger({ env, fetchImpl });
    await log('fact_check.failed', { text: 't'.repeat(20000), claim: 'c'.repeat(4000), context: 'x'.repeat(7000), errorCode: 'secret', statusCode: 999, confidence: NaN, durationMs: -1, audioBytes: Infinity, revision: 'Bearer secret', noClaim: false });
    const [record] = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(record.text).toHaveLength(16000); expect(record.claim).toHaveLength(2000); expect(record.context).toHaveLength(6000);
    expect(record).toMatchObject({ textTruncated: true, claimTruncated: true, contextTruncated: true, noClaim: false });
    for (const field of ['errorCode', 'statusCode', 'confidence', 'durationMs', 'audioBytes', 'revision']) expect(record).not.toHaveProperty(field);
  });
  it('accepts bounded correlation identifiers only', () => {
    expect(telemetryCorrelation({ headers: { 'x-session-id': 'session-1', 'x-transcript-run-id': 'run:1', 'x-transcript-chunk-index': '12', 'x-segment-id': 'span-50', 'x-segment-revision': '2' } })).toEqual({ sessionId: 'session-1', transcriptRunId: 'run:1', chunkIndex: '12', segmentId: 'span-50', revision: '2' });
    expect(telemetryCorrelation({ headers: { 'x-session-id': 'private text', 'x-transcript-run-id': 'a'.repeat(129) } }).sessionId).toBeUndefined();
  });
  it('rejects unknown event types without sending them', async () => {
    const fetchImpl = vi.fn(); await createTranscriptLogger({ env, fetchImpl })('anything', { text: 'hi' }); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    () => ({ ok: false, status: 401, json: async () => ({ error: 'private response' }) }),
    () => ({ ok: true, json: async () => ({ ingested: 0, failed: 1 }) }),
    () => ({ ok: true, json: async () => { throw new Error('private response'); } }),
    () => { throw new Error('private network detail'); },
  ])('fails open and logs only a generic diagnostic for failed ingestion %#', async response => {
    const warn = vi.fn(); const log = createTranscriptLogger({ env, fetchImpl: vi.fn(response), warn });
    expect(await log('transcription.completed', { text: 'private transcript' })).toBe(false);
    expect(warn).toHaveBeenCalledOnce(); expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  });
  it('bounds a hung network call even if the fetch implementation ignores abort', async () => {
    const warn = vi.fn(); const fetchImpl = vi.fn(() => new Promise(() => {}));
    const log = createTranscriptLogger({ env, fetchImpl, warn, timeoutMs: 5 });
    expect(await log('transcription.completed', { text: 'test' })).toBe(false);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true); expect(warn).toHaveBeenCalledWith('FactCheckMe telemetry failure', 'ingest_timeout');
  });
});

describe('authenticated route diagnostics', () => {
  it('records every transcription including silence, without audio bytes or request headers', async () => {
    const telemetry = vi.fn(); const route = createRouteHandler({ env: {}, auth, transcribe: vi.fn().mockResolvedValue({ text: '' }), telemetry });
    await route(req('/api/transcribe', wav(), { 'x-transcript-run-id': 'run-1', 'x-transcript-chunk-index': '0', cookie: 'private' }), res());
    expect(telemetry).toHaveBeenCalledWith('transcription.completed', expect.objectContaining({ text: '', textLength: 0, audioBytes: 48, transcriptRunId: 'run-1', chunkIndex: '0', statusCode: 200 }));
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('private');
  });
  it.each([true, false])('records checked/nonclaim outcomes with original claim and contextual correlation %s', async hasClaim => {
    const telemetry = vi.fn(); const factCheck = vi.fn().mockResolvedValue({ result: { hasClaim, verdict: hasClaim ? 'true' : undefined, confidence: 97 }, metadata: { private: 'never copied' } });
    const response = res(); const route = createRouteHandler({ env: {}, auth, factCheck, telemetry });
    await route(req('/api/fact-check', { claim: ' Earth orbits the Sun. ', context: 'Context here.' }, { 'x-session-id': 'session-1', 'x-segment-id': 'span-0', 'x-segment-revision': '2' }), response);
    expect(telemetry).toHaveBeenCalledWith('fact_check.completed', expect.objectContaining({ claim: 'Earth orbits the Sun.', context: 'Context here.', sessionId: 'session-1', segmentId: 'span-0', revision: '2', noClaim: !hasClaim }));
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('never copied');
  });
  it('records provider failures and preserves the original safe API error', async () => {
    const telemetry = vi.fn(); const error = new ApiError(502, 'provider_error', 'private provider detail');
    const route = createRouteHandler({ env: {}, auth, factCheck: vi.fn().mockRejectedValue(error), telemetry });
    await expect(route(req('/api/fact-check', { claim: 'A claim.' }), res())).rejects.toBe(error);
    expect(telemetry).toHaveBeenCalledWith('fact_check.failed', expect.objectContaining({ claim: 'A claim.', errorCode: 'provider_error', statusCode: 502 }));
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('private provider detail');
  });
  it('does not log unauthorized or invalid input', async () => {
    const telemetry = vi.fn(); const denied = createRouteHandler({ env: {}, auth: { require() { throw new ApiError(401, 'unauthorized', 'Sign in'); } }, telemetry });
    await expect(denied(req('/api/fact-check', { claim: 'private' }), res())).rejects.toMatchObject({ statusCode: 401 });
    const route = createRouteHandler({ env: {}, auth, telemetry });
    await expect(route(req('/api/fact-check', { claim: '' }), res())).rejects.toMatchObject({ statusCode: 400 });
    expect(telemetry).not.toHaveBeenCalled();
  });
  it('Axiom failure never changes successful provider responses', async () => {
    const telemetry = createTranscriptLogger({ env, fetchImpl: vi.fn().mockRejectedValue(new Error('offline')), warn: vi.fn() });
    const response = res(); const route = createRouteHandler({ env: {}, auth, transcribe: vi.fn().mockResolvedValue({ text: 'Hello.' }), telemetry });
    await route(req('/api/transcribe', wav()), response);
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object)); expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ text: 'Hello.' });
  });
});
