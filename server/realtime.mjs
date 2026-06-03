import WebSocket, { WebSocketServer } from 'ws';
import { DEFAULT_MISTRAL_REALTIME_MODEL } from './config.mjs';

const getMistralRealtimeUrl = () => {
  const baseUrl = (process.env.MISTRAL_REALTIME_BASE_URL || 'wss://api.mistral.ai').replace(/\/+$/, '');
  const model = process.env.MISTRAL_REALTIME_TRANSCRIPTION_MODEL || DEFAULT_MISTRAL_REALTIME_MODEL;
  return `${baseUrl}/v1/audio/transcriptions/realtime?model=${encodeURIComponent(model)}`;
};

const sendSocketJson = (socket, payload) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
};

export const handleRealtimeTranscription = (clientSocket) => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    sendSocketJson(clientSocket, { type: 'error', error: 'MISTRAL_API_KEY is not configured' });
    clientSocket.close();
    return;
  }

  const upstreamSocket = new WebSocket(getMistralRealtimeUrl(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const queuedAudio = [];
  let isConfigured = false;
  let hasEndedAudio = false;

  const sendUpstream = (payload) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(JSON.stringify(payload));
    }
  };

  const endUpstreamAudio = () => {
    if (hasEndedAudio) return;
    hasEndedAudio = true;

    if (upstreamSocket.readyState === WebSocket.OPEN) {
      sendUpstream({ type: 'input_audio.flush' });
      sendUpstream({ type: 'input_audio.end' });
    }
  };

  upstreamSocket.on('message', (rawMessage) => {
    let event;
    try {
      event = JSON.parse(rawMessage.toString());
    } catch {
      sendSocketJson(clientSocket, { type: 'error', error: 'Mistral returned invalid realtime JSON' });
      return;
    }

    if (event.type === 'session.created') {
      sendUpstream({
        type: 'session.update',
        session: {
          audio_format: {
            encoding: 'pcm_s16le',
            sample_rate: 16000,
          },
          target_streaming_delay_ms: Number(process.env.MISTRAL_REALTIME_DELAY_MS) || 1000,
        },
      });
      return;
    }

    if (event.type === 'session.updated') {
      isConfigured = true;
      for (const audio of queuedAudio.splice(0)) {
        sendUpstream({ type: 'input_audio.append', audio });
      }
      sendSocketJson(clientSocket, { type: 'ready' });
      return;
    }

    if (event.type === 'transcription.text.delta') {
      sendSocketJson(clientSocket, { type: 'transcript_delta', text: event.text || '' });
      return;
    }

    if (event.type === 'transcription.done') {
      sendSocketJson(clientSocket, { type: 'done' });
      clientSocket.close();
      upstreamSocket.close();
      return;
    }

    if (event.type === 'error') {
      const message = event.error?.message?.detail || event.error?.message || 'Mistral realtime transcription error';
      sendSocketJson(clientSocket, { type: 'error', error: String(message) });
    }
  });

  upstreamSocket.on('error', (error) => {
    sendSocketJson(clientSocket, { type: 'error', error: `Mistral realtime connection failed: ${error.message}` });
  });

  clientSocket.on('message', (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      sendSocketJson(clientSocket, { type: 'error', error: 'Invalid realtime transcription message' });
      return;
    }

    if (message.type === 'audio' && typeof message.audio === 'string') {
      if (isConfigured) {
        sendUpstream({ type: 'input_audio.append', audio: message.audio });
      } else if (queuedAudio.length < 128) {
        queuedAudio.push(message.audio);
      }
      return;
    }

    if (message.type === 'end') {
      endUpstreamAudio();
    }
  });

  clientSocket.on('close', () => {
    endUpstreamAudio();
    setTimeout(() => upstreamSocket.close(), 1000);
  });
};

export function attachRealtimeTranscription(server) {
  const realtimeServer = new WebSocketServer({ noServer: true });
  realtimeServer.on('connection', handleRealtimeTranscription);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/api/transcribe/realtime') {
      socket.destroy();
      return;
    }

    realtimeServer.handleUpgrade(req, socket, head, (webSocket) => {
      realtimeServer.emit('connection', webSocket, req);
    });
  });

  return realtimeServer;
}
