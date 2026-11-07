import { ApiError } from './errors.mjs';

// The file endpoint is distinct from MAI-Transcribe-2-Streaming (public preview).
// https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe
const AUDIO_TYPES = new Map([
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/wave', 'wav'],
  ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['audio/flac', 'flac'], ['audio/x-flac', 'flac'],
]);
export const MAX_AUDIO_BYTES = 4_000_000;

export function getMaiConfig(env = process.env) {
  const apiKey = env.AZURE_SPEECH_KEY || env.MAI_TRANSCRIBE_KEY;
  const endpointValue = env.AZURE_SPEECH_ENDPOINT || env.MAI_TRANSCRIBE_ENDPOINT;
  if (!apiKey || !endpointValue) {
    throw new ApiError(503, 'configuration_error', 'Azure Speech is not configured');
  }
  let endpoint;
  try { endpoint = new URL(endpointValue); } catch {
    throw new ApiError(503, 'configuration_error', 'MAI endpoint must be an HTTPS Azure resource origin or supported file transcription endpoint');
  }
  // Do not forward a credential to a configurable arbitrary host or redirect.
  const azureHost = /^[a-z0-9][a-z0-9-]*\.(?:cognitiveservices\.azure\.com|services\.ai\.azure\.com|api\.cognitive\.microsoft\.com)$/i;
  const filePath = '/speechtotext/transcriptions:transcribe';
  const isOrigin = endpoint.pathname === '/' && !endpoint.search;
  const params = [...endpoint.searchParams];
  const isFileEndpoint = endpoint.pathname === filePath &&
    (params.length === 0 || (params.length === 1 && params[0][0] === 'api-version' && params[0][1] === '2025-10-15'));
  if (endpoint.protocol !== 'https:' || !azureHost.test(endpoint.hostname) || endpoint.port ||
      endpoint.username || endpoint.password || endpoint.hash || (!isOrigin && !isFileEndpoint)) {
    throw new ApiError(503, 'configuration_error', 'MAI endpoint must be an HTTPS Azure resource origin or supported file transcription endpoint');
  }
  const model = env.MAI_TRANSCRIPTION_MODEL || env.MAI_TRANSCRIBE_MODEL || 'MAI-Transcribe-2';
  if (model !== 'MAI-Transcribe-2') {
    throw new ApiError(503, 'configuration_error', 'This file adapter requires MAI-Transcribe-2');
  }
  return { apiKey, endpoint: endpoint.origin, model };
}

export async function transcribeAudio(buffer, {
  mimeType = 'audio/wav', signal, fetchImpl = globalThis.fetch, env = process.env,
} = {}) {
  const format = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  if (!AUDIO_TYPES.has(format)) {
    throw new ApiError(415, 'unsupported_audio', 'Send WAV, MP3, or FLAC audio');
  }
  if (!(buffer instanceof Uint8Array) || buffer.byteLength === 0) {
    throw new ApiError(400, 'invalid_audio', 'Audio must not be empty');
  }
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'Audio chunks must be at most 4 MB');
  }
  const config = getMaiConfig(env);
  const body = new FormData();
  body.append('audio', new Blob([buffer], { type: format }), `audio.${AUDIO_TYPES.get(format)}`);
  body.append('definition', JSON.stringify({
    enhancedMode: { enabled: true, model: config.model, modelOptions: { transcribeStyle: 'verbatim' } },
    diarization: { enabled: false },
  }));
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  try {
    const response = await fetchImpl(`${config.endpoint}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`, {
      method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': config.apiKey }, body,
      signal: requestSignal, redirect: 'error',
    });
    if (!response.ok) throw new ApiError(502, 'provider_error', 'Azure transcription request failed');
    const raw = await response.json();
    if (!Array.isArray(raw.combinedPhrases) || raw.combinedPhrases.some((part) => typeof part?.text !== 'string')) {
      throw new ApiError(502, 'provider_error', 'Azure returned an invalid transcription');
    }
    return { text: raw.combinedPhrases.map((part) => part.text).join(' ').trim() };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    if (error instanceof ApiError) throw error;
    if (requestSignal.aborted) throw new ApiError(504, 'provider_timeout', 'Azure transcription timed out');
    throw new ApiError(502, 'provider_error', 'Azure transcription request failed');
  }
}
