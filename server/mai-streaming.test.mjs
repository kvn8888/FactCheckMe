// @vitest-environment node
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createAuth, createRateLimiter, hashPassword } from './auth.mjs';
import { attachMaiStreamingUpgrade, getMaiStreamingConfig, getRealtimeProviders } from './mai-streaming.mjs';

const password = 'test-only-password-never-deployed';
const baseEnv = {
  APP_PASSWORD_HASH: hashPassword(password),
  APP_SESSION_SECRET: 'test-only-session-signing-secret-not-for-deployment',
  MAI_TRANSCRIBE_2_STREAMING_ENDPOINT:
    'https://mai-transcribe-2-stream-kvn.openai.azure.com/openai/deployments/MAI-Transcribe-2-Streaming/audio/transcriptions?api-version=2025-03-01-preview',
  MAI_TRANSCRIBE_2_STREAMING_KEY: 'test-mai-streaming-key',
  MAI_TRANSCRIBE_2_STREAMING_MODEL: 'MAI-Transcribe-2-Streaming',
};
const cookie = createAuth({ env: baseEnv }).login(password).split(';')[0];

class FakeUpstreamSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent = [];
  closed = false;

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  receive(event) {
    this.emit('message', JSON.stringify(event));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000, '');
  }
}

const servers = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await new Promise(resolve => server.close(() => resolve()));
  }
});

async function startProxy(options = {}) {
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  attachMaiStreamingUpgrade(server, { env: baseEnv, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  return { server, port, origin: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/api/realtime/mai-ws` };
}

describe('MAI Streaming configuration & provider discovery', () => {
  it('canonicalizes Doppler Azure deployment endpoints to Foundry realtime WebSocket URLs', () => {
    expect(getMaiStreamingConfig(baseEnv)).toEqual({
      apiKey: 'test-mai-streaming-key',
      wsUrl: 'wss://mai-transcribe-2-stream-kvn.services.ai.azure.com/mai/v1/realtime?intent=transcription',
      model: 'MAI-Transcribe-2-Streaming',
    });
    expect(getMaiStreamingConfig({
      MAI_TRANSCRIBE_2_STREAMING_ENDPOINT: 'https://my-resource.services.ai.azure.com',
      MAI_TRANSCRIBE_2_STREAMING_KEY: 'key',
      MAI_TRANSCRIBE_2_STREAMING_MODEL: 'mai-transcribe-2-streaming',
    })).toEqual({
      apiKey: 'key',
      wsUrl: 'wss://my-resource.services.ai.azure.com/mai/v1/realtime?intent=transcription',
      model: 'MAI-Transcribe-2-Streaming',
    });
  });

  it.each([
    'http://my-resource.services.ai.azure.com',
    'https://evil.example',
    'https://my-resource.services.ai.azure.com.evil.example',
    'https://user:pass@my-resource.services.ai.azure.com',
    'https://my-resource.services.ai.azure.com:8443',
    'https://my-resource.services.ai.azure.com/arbitrary/path',
  ])('rejects unsafe endpoint %s', (endpoint) => {
    expect(() => getMaiStreamingConfig({ ...baseEnv, MAI_TRANSCRIBE_2_STREAMING_ENDPOINT: endpoint }))
      .toThrow('valid Azure resource URL');
  });

  it('lists configured realtime providers and honors REALTIME_STT_PROVIDER when available', () => {
    expect(getRealtimeProviders({ ...baseEnv, OPENAI_API_KEY: 'sk-test' })).toEqual({
      providers: ['openai-realtime', 'mai-streaming'],
      defaultProvider: 'openai-realtime',
    });
    expect(getRealtimeProviders({ ...baseEnv, OPENAI_API_KEY: 'sk-test', REALTIME_STT_PROVIDER: 'mai-streaming' })).toEqual({
      providers: ['openai-realtime', 'mai-streaming'],
      defaultProvider: 'mai-streaming',
    });
    expect(getRealtimeProviders(baseEnv)).toEqual({
      providers: ['mai-streaming'],
      defaultProvider: 'mai-streaming',
    });
  });
});

describe('MAI Streaming WebSocket proxy', () => {
  it('rejects unauthenticated, cross-origin, and unknown-path upgrades before contacting Azure', async () => {
    const createUpstreamSocket = vi.fn();
    const { port, origin, wsUrl } = await startProxy({ createUpstreamSocket });

    const expectReject = (url, headers, expectedStatus) => new Promise((resolve, reject) => {
      const client = new WebSocket(url, { headers });
      client.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(expectedStatus);
        res.resume();
        resolve();
      });
      client.on('open', () => { client.close(); reject(new Error('Expected rejection')); });
      client.on('error', () => {});
    });

    await expectReject(wsUrl, { Origin: origin }, 401);
    await expectReject(wsUrl, { Origin: 'https://attacker.example', Cookie: cookie }, 403);
    await expectReject(`ws://127.0.0.1:${port}/api/other`, { Origin: origin, Cookie: cookie }, 404);
    expect(createUpstreamSocket).not.toHaveBeenCalled();
  });

  it('configures upstream with 16kHz PCM, filters messages, sanitizes errors, and signals rollover', async () => {
    const upstream = new FakeUpstreamSocket();
    const telemetry = vi.fn();
    const { origin, wsUrl } = await startProxy({
      createUpstreamSocket: () => upstream,
      telemetry,
      rolloverMs: 120,
      hardCloseMs: 2000,
    });

    const received = [];
    const client = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: cookie } });
    await new Promise(resolve => client.once('open', resolve));
    client.on('message', raw => received.push(JSON.parse(raw.toString('utf8'))));

    upstream.open();
    upstream.receive({ type: 'session.created' });
    expect(upstream.sent).toEqual([{
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 16000 },
            transcription: { model: 'MAI-Transcribe-2-Streaming' },
            turn_detection: null,
          },
        },
      },
    }]);

    upstream.receive({ type: 'session.updated' });
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: 'proxy.ready' })));

    // Client attempts an illicit session.update (must be dropped) alongside valid append + commit.
    client.send(JSON.stringify({ type: 'session.update', session: { model: 'evil' } }));
    client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
    client.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: 'c1' }));
    await vi.waitFor(() => expect(upstream.sent).toHaveLength(3));
    expect(upstream.sent.slice(1)).toEqual([
      { type: 'input_audio_buffer.append', audio: 'AAAA' },
      { type: 'input_audio_buffer.commit', event_id: 'c1' },
    ]);

    upstream.receive({ type: 'conversation.item.input_audio_transcription.intermediate', item_id: 'i1', intermediate: 'Earth', obfuscation: 'secret' });
    upstream.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Earth' });
    upstream.receive({ type: 'input_audio_buffer.committed', item_id: 'i1' });
    upstream.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Earth orbits the Sun.' });
    upstream.receive({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', event_id: 'c2', message: 'private upstream stack' } });

    await vi.waitFor(() => {
      expect(received).toContainEqual({ type: 'proxy.rollover' });
      expect(received).toContainEqual({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', event_id: 'c2' } });
    });
    expect(received).toContainEqual({ type: 'conversation.item.input_audio_transcription.intermediate', item_id: 'i1', intermediate: 'Earth' });
    expect(received).toContainEqual({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Earth' });
    expect(received).toContainEqual({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Earth orbits the Sun.' });
    expect(JSON.stringify(received)).not.toContain('private upstream stack');

    client.close();
    await vi.waitFor(() => expect(upstream.closed).toBe(true));
    expect(telemetry).toHaveBeenCalledWith('realtime.mai.session.started', expect.objectContaining({ statusCode: 101 }));
    expect(telemetry).toHaveBeenCalledWith('realtime.mai.session.closed', expect.objectContaining({ reason: 'client_closed' }));
  });

  it('enforces the realtime rate limiter on upgrades', async () => {
    const rateLimit = createRateLimiter();
    for (let i = 0; i < 20; i++) rateLimit('realtime:owner', 20, 60_000);
    const { origin, wsUrl } = await startProxy({ rateLimit });
    await new Promise((resolve, reject) => {
      const client = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: cookie } });
      client.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(429);
        res.resume();
        resolve();
      });
      client.on('open', () => { client.close(); reject(new Error('Expected 429')); });
      client.on('error', () => {});
    });
  });
});
