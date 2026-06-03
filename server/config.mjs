import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');

export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '127.0.0.1';
export const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');
export const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'factcheckme.sqlite');

export const DEFAULT_CONFIDENCE = 75;

export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

export const MISTRAL_API_URL = 'https://api.mistral.ai/v1';
export const DEFAULT_MISTRAL_TTS_MODEL = 'voxtral-mini-tts-2603';
export const DEFAULT_MISTRAL_REALTIME_MODEL = 'voxtral-mini-transcribe-realtime-2602';
export const DEFAULT_TTS_RESPONSE_FORMAT = 'mp3';
