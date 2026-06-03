import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_MISTRAL_TTS_MODEL,
  DEFAULT_TTS_RESPONSE_FORMAT,
  MISTRAL_API_URL,
} from './config.mjs';

const getMistralConfig = () => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is not configured');

  return {
    apiKey,
    model: process.env.MISTRAL_TTS_MODEL || DEFAULT_MISTRAL_TTS_MODEL,
    voiceId: process.env.MISTRAL_TTS_VOICE_ID || null,
    refAudioPath: process.env.MISTRAL_TTS_REF_AUDIO_PATH || null,
    responseFormat: process.env.MISTRAL_TTS_RESPONSE_FORMAT || DEFAULT_TTS_RESPONSE_FORMAT,
  };
};

const getAudioMimeType = (format) => {
  const mimeTypes = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    pcm: 'audio/L16',
    flac: 'audio/flac',
    opus: 'audio/opus',
  };
  return mimeTypes[format] || 'audio/mpeg';
};

export async function synthesizeSpeech(input) {
  const { apiKey, model, voiceId, refAudioPath, responseFormat } = getMistralConfig();
  const trimmedInput = input.trim();
  if (!trimmedInput) throw new Error('Text is required');
  if (trimmedInput.length > 4000) throw new Error('Text is too long for speech generation');

  const body = {
    model,
    input: trimmedInput,
    response_format: responseFormat,
  };

  if (voiceId) {
    body.voice_id = voiceId;
  } else if (refAudioPath) {
    if (!existsSync(refAudioPath)) {
      throw new Error(`MISTRAL_TTS_REF_AUDIO_PATH does not exist: ${refAudioPath}`);
    }
    body.ref_audio = readFileSync(refAudioPath).toString('base64');
  } else {
    throw new Error('MISTRAL_TTS_VOICE_ID or MISTRAL_TTS_REF_AUDIO_PATH is required');
  }

  const response = await fetch(`${MISTRAL_API_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Mistral TTS error (${response.status}): ${message}`);
  }

  const data = await response.json();
  if (!data.audio_data) throw new Error('Mistral TTS response did not include audio data');

  return {
    audioData: data.audio_data,
    mimeType: getAudioMimeType(responseFormat),
    model,
  };
}
