import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { ApiError, toPublicError } from './errors.mjs';
import { createAuth, createRateLimiter, requireSameOrigin } from './auth.mjs';
import { createTranscriptLogger } from './telemetry.mjs';

export const MAI_STREAMING_MODEL = 'MAI-Transcribe-2-Streaming';
export const MAI_WS_PATH = '/api/realtime/mai-ws';
export const DEFAULT_ROLLOVER_MS = 265_000;
export const DEFAULT_HARD_CLOSE_MS = 292_000;
const MAX_CLIENT_MESSAGE_BYTES = 64_000;
const MAX_AUDIO_BASE64_CHARS = 48_000;
const MAX_PENDING_CLIENT_FRAMES = 32;

const AZURE_RESOURCE_HOST = /^([a-z0-9][a-z0-9-]*)\.(?:services\.ai\.azure\.com|openai\.azure\.com|cognitiveservices\.azure\.com)$/i;
const DEPLOYMENT_TRANSCRIPTION_PATH = /^\/openai\/deployments\/[a-z0-9][a-z0-9._-]{0,63}\/audio\/transcriptions$/i;

const safeToken = (value) => (typeof value === 'string' && /^[\w.:-]{1,100}$/.test(value) ? value : undefined);

export function getMaiStreamingConfig(env = process.env) {
  const apiKey = env.MAI_TRANSCRIBE_2_STREAMING_KEY;
  const endpointValue = env.MAI_TRANSCRIBE_2_STREAMING_ENDPOINT;
  if (!apiKey || !endpointValue) {
    throw new ApiError(503, 'configuration_error', 'MAI Streaming is not configured');
  }
  let parsed;
  try {
    parsed = new URL(endpointValue);
  } catch {
    throw new ApiError(503, 'configuration_error', 'MAI Streaming endpoint must be a valid Azure resource URL');
  }
  const hostMatch = parsed.hostname.match(AZURE_RESOURCE_HOST);
  const validProtocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const pathname = parsed.pathname || '/';
  const isOrigin = pathname === '/' && !parsed.search;
  const isRealtimePath = (pathname === '/mai/v1/realtime' || pathname === '/openai/v1/realtime') &&
    ([...parsed.searchParams].length === 0 || (parsed.searchParams.get('intent') === 'transcription' && [...parsed.searchParams].length === 1));
  const isDeploymentPath = DEPLOYMENT_TRANSCRIPTION_PATH.test(pathname);
  if (!validProtocol || !hostMatch || parsed.port || parsed.username || parsed.password || parsed.hash ||
      (!isOrigin && !isRealtimePath && !isDeploymentPath)) {
    throw new ApiError(503, 'configuration_error', 'MAI Streaming endpoint must be a valid Azure resource URL');
  }
  const model = (env.MAI_TRANSCRIBE_2_STREAMING_MODEL || MAI_STREAMING_MODEL).trim();
  if (model.toLowerCase() !== MAI_STREAMING_MODEL.toLowerCase()) {
    throw new ApiError(503, 'configuration_error', `MAI Streaming requires ${MAI_STREAMING_MODEL}`);
  }
  const resource = hostMatch[1].toLowerCase();
  return {
    apiKey,
    wsUrl: `wss://${resource}.services.ai.azure.com/mai/v1/realtime?intent=transcription`,
    model: MAI_STREAMING_MODEL,
  };
}

export function isMaiStreamingConfigured(env = process.env) {
  try {
    getMaiStreamingConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function getRealtimeProviders(env = process.env) {
  const providers = [];
  if (env.OPENAI_API_KEY) providers.push('openai-realtime');
  if (isMaiStreamingConfigured(env)) providers.push('mai-streaming');
  const requested = typeof env.REALTIME_STT_PROVIDER === 'string' ? env.REALTIME_STT_PROVIDER.trim() : '';
  const defaultProvider = providers.includes(requested)
    ? requested
    : providers.includes('openai-realtime')
      ? 'openai-realtime'
      : providers[0] || 'openai-realtime';
  return { providers, defaultProvider };
}

function rejectUpgrade(socket, statusCode, payload, extraHeaders = {}) {
  if (socket.destroyed) return;
  const body = JSON.stringify(payload);
  const headers = [
    `HTTP/1.1 ${statusCode} Error`,
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
    '',
    body,
  ].join('\r\n');
  socket.write(headers);
  socket.destroy();
}

function sanitizeClientMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'input_audio_buffer.append') {
    if (typeof data.audio !== 'string' || !data.audio.length || data.audio.length > MAX_AUDIO_BASE64_CHARS) return null;
    return JSON.stringify({ type: 'input_audio_buffer.append', audio: data.audio });
  }
  if (data.type === 'input_audio_buffer.commit') {
    const eventId = safeToken(data.event_id);
    return JSON.stringify({ type: 'input_audio_buffer.commit', ...(eventId ? { event_id: eventId } : {}) });
  }
  return null;
}

function sanitizeUpstreamEvent(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'input_audio_buffer.committed':
      if (typeof event.item_id !== 'string') return null;
      return { type: event.type, item_id: event.item_id };
    case 'conversation.item.input_audio_transcription.intermediate':
      if (typeof event.item_id !== 'string' || typeof event.intermediate !== 'string') return null;
      return { type: event.type, item_id: event.item_id, intermediate: event.intermediate };
    case 'conversation.item.input_audio_transcription.delta':
      if (typeof event.item_id !== 'string' || typeof event.delta !== 'string') return null;
      return { type: event.type, item_id: event.item_id, delta: event.delta };
    case 'conversation.item.input_audio_transcription.completed':
      if (typeof event.item_id !== 'string' || typeof event.transcript !== 'string') return null;
      return { type: event.type, item_id: event.item_id, transcript: event.transcript };
    case 'conversation.item.input_audio_transcription.failed':
      if (typeof event.item_id !== 'string') return null;
      return { type: event.type, item_id: event.item_id };
    case 'error': {
      const code = safeToken(event.error?.code) || 'provider_error';
      const eventId = safeToken(event.error?.event_id);
      return { type: 'error', error: { code, ...(eventId ? { event_id: eventId } : {}) } };
    }
    default:
      return null;
  }
}

export function attachMaiStreamingUpgrade(server, {
  env = process.env,
  auth = createAuth({ env }),
  rateLimit = createRateLimiter(),
  telemetry = createTranscriptLogger({ env }),
  createUpstreamSocket,
  rolloverMs = DEFAULT_ROLLOVER_MS,
  hardCloseMs = DEFAULT_HARD_CLOSE_MS,
  heartbeatMs = 25_000,
  handshakeTimeoutMs = 15_000,
  acceptAnyPath = false,
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });

  function bridgeClient(clientWs, config) {
    const requestId = randomUUID();
    const started = Date.now();
    let closed = false;
    let upstreamReady = false;
    let sessionSent = false;
    const pendingClientFrames = [];
    let handshakeTimer;
    let rolloverTimer;
    let hardCloseTimer;
    let heartbeatTimer;

    const sendClient = (payload) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(payload));
    };

    const upstream = createUpstreamSocket
      ? createUpstreamSocket(config)
      : new WebSocket(config.wsUrl, {
          headers: { 'api-key': config.apiKey },
          handshakeTimeout: handshakeTimeoutMs,
        });

    const cleanup = (reason, clientCode = 1000, clientReason = '') => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      clearTimeout(rolloverTimer);
      clearTimeout(hardCloseTimer);
      clearInterval(heartbeatTimer);
      pendingClientFrames.length = 0;
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        try { upstream.close(); } catch { try { upstream.terminate?.(); } catch {} }
      }
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        try { clientWs.close(clientCode, clientReason); } catch { try { clientWs.terminate?.(); } catch {} }
      }
      void telemetry('realtime.mai.session.closed', {
        requestId,
        durationMs: Date.now() - started,
        reason,
      });
    };

    const sendSessionUpdate = () => {
      if (sessionSent || upstream.readyState !== WebSocket.OPEN) return;
      sessionSent = true;
      upstream.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 16000 },
              transcription: { model: config.model },
              turn_detection: null,
            },
          },
        },
      }));
    };

    handshakeTimer = setTimeout(() => {
      sendClient({ type: 'error', error: { code: 'provider_timeout' } });
      cleanup('handshake_timeout', 1011, 'Upstream handshake timed out');
    }, handshakeTimeoutMs);

    upstream.on('open', () => {
      sendSessionUpdate();
    });

    upstream.on('message', (raw) => {
      if (closed) return;
      let event;
      try {
        event = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        return;
      }
      if (event?.type === 'session.created') {
        sendSessionUpdate();
        return;
      }
      if (event?.type === 'session.updated' && !upstreamReady) {
        upstreamReady = true;
        clearTimeout(handshakeTimer);
        sendClient({ type: 'proxy.ready', rolloverMs, maxDurationMs: hardCloseMs });
        for (const frame of pendingClientFrames.splice(0)) {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        }
        rolloverTimer = setTimeout(() => {
          sendClient({ type: 'proxy.rollover' });
        }, rolloverMs);
        hardCloseTimer = setTimeout(() => {
          cleanup('max_duration', 1000, 'Session duration limit reached');
        }, hardCloseMs);
        heartbeatTimer = setInterval(() => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.ping?.();
          if (upstream.readyState === WebSocket.OPEN) upstream.ping?.();
        }, heartbeatMs);
        void telemetry('realtime.mai.session.started', {
          requestId,
          durationMs: Date.now() - started,
          statusCode: 101,
        });
        return;
      }
      if (!upstreamReady && event?.type === 'error') {
        sendClient({ type: 'error', error: { code: safeToken(event.error?.code) || 'provider_error' } });
        cleanup('upstream_config_error', 1011, 'Upstream configuration error');
        return;
      }
      const safe = sanitizeUpstreamEvent(event);
      if (safe) sendClient(safe);
    });

    upstream.on('error', () => {
      sendClient({ type: 'error', error: { code: 'provider_error' } });
      cleanup('upstream_error', 1011, 'Upstream connection failed');
    });

    upstream.on('close', () => {
      cleanup('upstream_closed', 1000, 'Upstream closed');
    });

    clientWs.on('message', (raw, isBinary) => {
      if (closed || isBinary) return;
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (Buffer.byteLength(text) > MAX_CLIENT_MESSAGE_BYTES) return;
      const safe = sanitizeClientMessage(text);
      if (!safe) return;
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        upstream.send(safe);
      } else if (pendingClientFrames.length < MAX_PENDING_CLIENT_FRAMES) {
        pendingClientFrames.push(safe);
      }
    });

    clientWs.on('error', () => cleanup('client_error'));
    clientWs.on('close', () => cleanup('client_closed'));
  }

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (!acceptAnyPath && pathname !== MAI_WS_PATH) {
      rejectUpgrade(socket, 404, { error: 'Not found', code: 'not_found' });
      return;
    }
    try {
      requireSameOrigin(req, env);
      auth.require(req);
      rateLimit('realtime:owner', 20, 60_000);
      const config = getMaiStreamingConfig(env);
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        bridgeClient(clientWs, config);
      });
    } catch (error) {
      const { statusCode, payload } = toPublicError(error);
      const extraHeaders = statusCode === 429 && Number.isSafeInteger(error?.retryAfter)
        ? { 'Retry-After': String(error.retryAfter) }
        : {};
      rejectUpgrade(socket, statusCode, payload, extraHeaders);
    }
  });

  return wss;
}
