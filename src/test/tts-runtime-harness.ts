/// <reference types="node" />
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRouteHandler } from '../../server/routes.mjs';
import { createRateLimiter } from '../../server/auth.mjs';
import { toPublicError } from '../../server/errors.mjs';
import { json } from '../../server/http-utils.mjs';
import {
  analyzeSegments, CHUNK_SECONDS, decodeTtsWav, INPUT_RATE, transcribeFixtureChunk,
} from '../../scripts/tts-stream-fixture.mjs';
import { useMaiSTT } from '@/hooks/useMaiSTT';
import { useFactChecker } from '@/hooks/useFactChecker';
import { sentenceBoundaries } from '@/lib/sentences';
import { localClear, localGetFacts, localGetSessions, STORAGE_KEY } from '@/services/storage';
import type { TranscriptSegment } from '@/types/factCheck';

type Fixture = Awaited<ReturnType<typeof import('../../scripts/tts-stream-fixture.mjs').buildTtsFixture>>;
type AudioChunk = ReturnType<typeof transcribeFixtureChunk>;
type Phase = 'live' | 'reconcile';
interface RequestLog {
  path: string;
  headers: IncomingHttpHeaders;
  phase: Phase;
  status: number;
  durationMs: number;
  claim?: string;
}
interface TelemetryEvent {
  event: string;
  fields: Record<string, unknown>;
}
interface Options {
  chunkBoundaryPunctuation?: boolean;
  backpressure?: boolean;
  rateLimit?: ReturnType<typeof createRateLimiter>;
  liveTranscribe?: (wav: Buffer, options: { signal: AbortSignal }) => Promise<{ text: string }>;
}
const FRAME_SIZE = 4096;
const CHUNK_SAMPLES = INPUT_RATE * CHUNK_SECONDS;

async function bodyForNode(body: RequestInit['body']) {
  if (!(body instanceof Blob)) return body;
  if (typeof body.arrayBuffer === 'function') return body.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(body);
  });
}

export async function runTtsRuntime(fixture: Fixture, options: Options = {}) {
  const started = performance.now();
  const samples = decodeTtsWav(fixture.wav);
  const chunks: AudioChunk[] = [];
  const requests: RequestLog[] = [];
  const factInputs: string[] = [];
  const events: TelemetryEvent[] = [];
  const snapshots: TranscriptSegment[][] = [];
  const received: string[] = [];
  const speechErrors: string[] = [];
  const factErrors: string[] = [];
  const env = { VERCEL: '1', VERCEL_AUTH_PROTECTED: 'true', APP_ORIGIN: '' };
  let phase: Phase = 'live';
  let liveReconcileMs = 0;
  let encodeAndResampleMs = 0;
  let encodedChunks = 0;
  let dispatchedChunks = 0;
  let peakWaiting = 0;
  let peakOutstanding = 0;
  let completedTranscriptions = 0;
  let cursor = 0;
  let trackStops = 0;
  let contextCloses = 0;
  let stopCallbacks = 0;
  let processor: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
  let releaseTranscription: () => void;
  const heldTranscription = new Promise<void>(resolve => { releaseTranscription = resolve; });

  const route = createRouteHandler({
    env,
    rateLimit: options.rateLimit,
    telemetry: (event, fields) => { events.push({ event, fields }); },
    transcribe: async (wav, routeOptions) => {
      const chunk = transcribeFixtureChunk(wav, fixture, chunks.length, options);
      chunks.push(chunk);
      if (chunk.index === 0 && options.backpressure) await heldTranscription;
      return options.liveTranscribe ? options.liveTranscribe(wav, routeOptions) : { text: chunk.text };
    },
    factCheck: async claim => ({
      // Classify only exact fixture utterances, so stored facts can be traced back to known input.
      result: fixture.utterances.some(utterance => utterance.kind === 'claim' && utterance.text === claim)
        ? { hasClaim: true, claim, verdict: 'unverifiable', confidence: 0, explanation: 'Local fixture result.', sources: [] }
        : { hasClaim: false },
    }),
  });
  const server = createServer(async (req, res) => {
    const startedRequest = performance.now();
    const request: RequestLog = { path: req.url, headers: req.headers, phase, status: 0, durationMs: 0 };
    if (req.url === '/api/fact-check') request.claim = factInputs.shift();
    requests.push(request);
    res.once('finish', () => {
      request.status = res.statusCode;
      request.durationMs = performance.now() - startedRequest;
      if (request.path === '/api/transcribe') completedTranscriptions++;
    });
    try {
      await route(req, res);
    } catch (error) {
      const { statusCode, payload } = toPublicError(error);
      json(res, statusCode, payload);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP loopback address');
  env.APP_ORIGIN = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  const nativeBlob = globalThis.Blob;
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const blobDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Blob');
  const audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const windowAudioDescriptor = Object.getOwnPropertyDescriptor(window, 'AudioContext');
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  class FixtureAudioContext {
    sampleRate = INPUT_RATE;
    state = 'running';
    destination = {};
    async resume() {}
    async close() { contextCloses++; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor(size: number) {
      if (size !== FRAME_SIZE) throw new Error(`Unexpected capture frame size ${size}`);
      return { set onaudioprocess(callback: typeof processor) { processor = callback; }, connect() {}, disconnect() {} };
    }
  }
  function observeDepth() {
    peakWaiting = Math.max(peakWaiting, encodedChunks - dispatchedChunks);
    peakOutstanding = Math.max(peakOutstanding, encodedChunks - completedTranscriptions);
  }
  function feedUntil(end: number) {
    const before = performance.now();
    while (processor && cursor < end) {
      const frame = samples.subarray(cursor, cursor + FRAME_SIZE);
      cursor += frame.length;
      processor({ inputBuffer: { getChannelData: () => frame } });
      observeDepth();
    }
    encodeAndResampleMs += performance.now() - before;
  }
  let unmount: (() => void) | undefined;
  try {
    localClear();
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FixtureAudioContext });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FixtureAudioContext });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => { trackStops++; } }] }),
    } });
    // Observe encoder output without inspecting or changing the hook's queue.
    globalThis.Blob = class TimedWavBlob extends nativeBlob {
      constructor(parts?: BlobPart[], init?: BlobPropertyBag) {
        super(parts, init);
        if (init?.type === 'audio/wav' && parts?.[0] instanceof ArrayBuffer) encodedChunks++;
      }
    };
    globalThis.fetch = async (path, init: RequestInit = {}) => {
      if (path !== '/api/transcribe' && path !== '/api/fact-check') throw new Error(`Unexpected request: ${path}`);
      if (path === '/api/transcribe') dispatchedChunks++;
      else factInputs.push(JSON.parse(String(init.body)).claim);
      const headers = new Headers(init.headers);
      headers.set('origin', env.APP_ORIGIN);
      return nativeFetch(new URL(path, env.APP_ORIGIN), { ...init, headers, body: await bodyForNode(init.body) });
    };
    const { result, unmount: cleanup } = renderHook(() => {
      const checker = useFactChecker({ onError: error => factErrors.push(error) });
      const speech = useMaiSTT({
        onChunk: value => {
          received.push(value);
          const before = performance.now();
          checker.processText(value);
          liveReconcileMs += performance.now() - before;
        },
        onError: error => speechErrors.push(error),
        onStopped: () => { stopCallbacks++; },
      });
      return { checker, speech };
    });
    unmount = cleanup;
    await act(async () => {
      await result.current.checker.startMonitoring();
      if (!await result.current.speech.startListening()) throw new Error('Capture failed to start');
    });

    const snapshot = () => snapshots.push(result.current.checker.segments.map(span => ({ ...span })));
    const waitUntilDrained = async (count: number) => {
      await waitFor(() => {
        if (!options.backpressure && speechErrors.length) return;
        if (received.length !== count || result.current.checker.isProcessing) {
          throw new Error(`Waiting for chunk ${count}; received ${received.length}`);
        }
      }, { timeout: options.liveTranscribe ? 47000 : 5000, interval: 5 });
      if (!options.backpressure && speechErrors.length) throw new Error(speechErrors.join(' '));
    };

    let afterThreeChunks;
    let atQueueLimit;
    if (options.backpressure) {
      await act(async () => { feedUntil(CHUNK_SAMPLES * 3); });
      await waitFor(() => { if (chunks.length !== 1) throw new Error('First upload has not arrived'); });
      afterThreeChunks = { encoded: encodedChunks, dispatched: dispatchedChunks, listening: result.current.speech.isListening, errors: [...speechErrors] };
      await act(async () => { feedUntil(CHUNK_SAMPLES * 5); });
      atQueueLimit = {
        encoded: encodedChunks, dispatched: dispatchedChunks, listening: result.current.speech.isListening,
        finishing: result.current.speech.isFinishing, trackStops,
      };
      releaseTranscription();
    } else {
      for (let count = 1; count <= Math.floor(samples.length / CHUNK_SAMPLES); count++) {
        await act(async () => { feedUntil(count * CHUNK_SAMPLES); });
        await waitUntilDrained(count);
        snapshot();
      }
      await act(async () => { feedUntil(samples.length); });
    }

    await act(async () => {
      const before = performance.now();
      const stop = result.current.speech.stopListening();
      observeDepth();
      encodeAndResampleMs += performance.now() - before;
      await stop;
    });
    await waitUntilDrained(chunks.length);
    snapshot();
    const liveSegments = snapshots[snapshots.length - 1];
    const factsBeforeStop = localGetFacts();
    phase = 'reconcile';
    const finalStarted = performance.now();
    let finalReconcileMs = 0;
    await act(async () => {
      const before = performance.now();
      const stop = result.current.checker.stopMonitoring();
      finalReconcileMs = performance.now() - before;
      await stop;
    });
    const finalDrainMs = performance.now() - finalStarted;
    const [session] = localGetSessions();
    const facts = localGetFacts();
    const analysis = !options.liveTranscribe && analyzeSegments(
      fixture, chunks, session.transcript, session.segments, sentenceBoundaries, snapshots,
    );
    const storageBytes = Buffer.byteLength(localStorage.getItem(STORAGE_KEY) ?? '', 'utf8');
    return {
      chunks, requests, events, snapshots, liveSegments, session, facts, factsBeforeStop, analysis, received,
      speechErrors, factErrors, trackStops, contextCloses, stopCallbacks, peakWaiting, peakOutstanding,
      afterThreeChunks, atQueueLimit, encodeAndResampleMs, liveReconcileMs, finalReconcileMs, finalDrainMs,
      storageBytes, wallMs: performance.now() - started,
      listening: result.current.speech.isListening, finishing: result.current.speech.isFinishing,
      processing: result.current.checker.isProcessing, monitoring: result.current.checker.status.isActive,
    };
  } finally {
    releaseTranscription();
    unmount?.();
    if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
    if (blobDescriptor) Object.defineProperty(globalThis, 'Blob', blobDescriptor);
    if (audioDescriptor) Object.defineProperty(globalThis, 'AudioContext', audioDescriptor);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
    if (windowAudioDescriptor) Object.defineProperty(window, 'AudioContext', windowAudioDescriptor);
    else Reflect.deleteProperty(window, 'AudioContext');
    if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}
