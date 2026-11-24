import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { getMaiConfig, transcribeAudio } from '../server/mai.mjs';
import { buildTtsFixture } from './tts-stream-fixture.mjs';

const live = process.argv.includes('--live');
const jsonOutput = process.argv.includes('--json');
const LIVE_CAP = 20;
const LIVE_DEADLINE_MS = 180_000;
const src = new URL('../src/', import.meta.url);
const harness = new URL('test/tts-runtime-harness.ts', src);

function loadHarness() {
  // Match Vite's local TS aliases and extensionless imports for the same
  // harness used by Vitest. Leave Node and package resolution alone.
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(src.href)) {
        const target = specifier.startsWith('@/') ? new URL(specifier.slice(2), src)
          : specifier.startsWith('.') ? new URL(specifier, context.parentURL) : undefined;
        if (target && existsSync(fileURLToPath(`${target.href}.ts`))) return next(`${target.href}.ts`, context);
      }
      return next(specifier, context);
    },
  });
  return import(harness.href).finally(() => hook.deregister());
}

function latency(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return {};
  return {
    min: sorted[0],
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted[sorted.length - 1],
  };
}

function summarize(run, name) {
  const transcriptions = run.requests.filter(request => request.path === '/api/transcribe');
  const checks = run.requests.filter(request => request.path === '/api/fact-check');
  const initial = checks.filter(request => request.phase === 'live' && request.headers['x-segment-revision'] === '1');
  const revisions = checks.filter(request => request.phase === 'live' && request.headers['x-segment-revision'] !== '1');
  const final = checks.filter(request => request.phase === 'reconcile');
  const previous = new Map();
  let sameTextLiveRetriesAfter429 = 0;
  for (const request of checks) {
    const id = request.headers['x-segment-id'];
    const last = previous.get(id);
    if (request.phase === 'live' && last?.status === 429 && last.claim === request.claim) sameTextLiveRetriesAfter429++;
    previous.set(id, request);
  }
  const breakdown = requests => ({ attempted: requests.length, accepted: requests.filter(request => request.status === 200).length, limited: requests.filter(request => request.status === 429).length });
  return {
    name, transcribe: { ...breakdown(transcriptions), limitPerMinute: 20, latencyMs: latency(transcriptions.map(request => request.durationMs)) },
    factCheck: { ...breakdown(checks), limitPerMinute: 30, initial: breakdown(initial), revisions: breakdown(revisions), final: breakdown(final), sameTextLiveRetriesAfter429 },
    resampleAndEncodeMs: run.encodeAndResampleMs, liveReconcileMs: run.liveReconcileMs,
    finalReconcileMs: run.finalReconcileMs, finalDrainMs: run.finalDrainMs,
    waitingPeak: run.peakWaiting, outstandingPeak: run.peakOutstanding,
    storageUtf8Bytes: run.storageBytes, wallMs: run.wallMs, storedFacts: run.facts.length,
    analysis: run.analysis || undefined,
    chunks: run.chunks.map(({ words: _words, ...chunk }, index) => ({
      ...chunk, text: run.received[index],
      liveSegments: run.snapshots[index]?.length,
      provisional: run.snapshots[index]?.find(span => !span.final)?.id,
    })),
    segments: run.session.segments,
    speechErrors: run.speechErrors,
  };
}

const ms = value => value.toFixed(1);
const status = result => `${result.attempted} attempted, ${result.accepted} accepted, ${result.limited} HTTP 429`;
function printReport(report) {
  const { audio, runs, wallMs, providerRequests } = report;
  console.log(`TTS streaming runtime | ${audio.source} | ${audio.durationSec.toFixed(3)} s | ${audio.inputBytes.toLocaleString()} B WAV at 48 kHz | ${audio.utterances.length} utterances`);
  console.log(`Synthesis ${ms(audio.generationMs)} ms | end-to-end ${ms(wallMs)} ms | external requests ${providerRequests}`);
  for (const run of runs) {
    const transcribe = run.transcribe;
    const checks = run.factCheck;
    const analysis = run.analysis;
    console.log(`\n${run.name}`);
    console.log(`  ${run.chunks.length} mono 16 kHz WAV chunks, ${run.chunks.reduce((sum, chunk) => sum + chunk.sampleCount, 0).toLocaleString()} samples | resample + encode ${ms(run.resampleAndEncodeMs)} ms`);
    console.log(`  Transcribe (${transcribe.limitPerMinute}/min) ${status(transcribe)} | HTTP server latency min/median/p95/max ${Object.values(transcribe.latencyMs).map(ms).join('/')} ms`);
    console.log(`  Fact check (${checks.limitPerMinute}/min) ${status(checks)} | initial ${status(checks.initial)} | live revisions ${status(checks.revisions)} (${checks.sameTextLiveRetriesAfter429} same-text retries after 429) | final ${status(checks.final)}`);
    console.log(`  Reconcile ${ms(run.liveReconcileMs + run.finalReconcileMs)} ms synchronous (${ms(run.finalReconcileMs)} ms at stop), final HTTP drain ${ms(run.finalDrainMs)} ms | runtime ${ms(run.wallMs)} ms`);
    console.log(`  Peak queue ${run.waitingPeak} waiting / ${run.outstandingPeak} including in flight | localStorage ${run.storageUtf8Bytes.toLocaleString()} B UTF-8, ${run.storedFacts} facts`);
    if (analysis) {
      console.log(`  ${audio.utterances.length} utterances → ${analysis.provisionalSegments} distinct provisional spans (+${analysis.provisionalRevisions} provisional revisions) → ${run.segments.length} final spans, ${analysis.exactMatches} exact | ${analysis.lostCharacters} lost and ${analysis.overlappingCharacters} overlapping characters`);
    }
    const boundaries = new Map(analysis?.boundaryOutcomes.map(boundary => [boundary.chunkIndex, boundary]));
    for (const chunk of run.chunks) {
      const boundary = boundaries.get(chunk.index);
      console.log(`    Chunk ${chunk.index} [${chunk.startSec.toFixed(2)}–${chunk.endSec.toFixed(2)} s] ${chunk.bytes} B, RMS ${chunk.rms.toFixed(4)}, ${chunk.liveSegments} live spans${chunk.provisional ? `, tail ${chunk.provisional}` : ''}${boundary ? `, period after ${boundary.token} ${boundary.outcome}` : ''}`);
    }
    for (const merge of analysis?.merged ?? []) {
      console.log(`    Merge ${merge.segmentId} | utterances ${merge.after} + ${merge.before} | ${merge.cause}`);
    }
    for (const split of analysis?.split ?? []) {
      console.log(`    Split ${split.segmentId} | utterance ${split.utterance} @ ${split.offset} | ${split.cause}`);
    }
    for (const span of run.segments) {
      console.log(`    ${span.id} r${span.revision} [${span.status}] ${span.text}`);
    }
  }
}

let providerRequests = 0;
let environment;
try {
  if (live) getMaiConfig();
  const started = performance.now();
  const fixture = await buildTtsFixture();
  environment = new JSDOM('', { url: 'http://localhost/' });
  for (const name of ['window', 'document', 'navigator', 'localStorage', 'FileReader', 'Event']) {
    const value = name === 'window' ? environment.window : environment.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const { runTtsRuntime } = await loadHarness();
  let runs;
  if (live) {
    // Apply the aggregate budget even if an adapter gains retries in the future.
    const deadline = AbortSignal.timeout(LIVE_DEADLINE_MS);
    const networkFetch = globalThis.fetch;
    const liveTranscribe = (wav, options) => transcribeAudio(wav, {
      ...options,
      fetchImpl: (url, init) => {
        deadline.throwIfAborted();
        if (providerRequests >= LIVE_CAP) throw new Error('Live speech request budget exhausted');
        providerRequests++;
        return networkFetch(url, { ...init, signal: AbortSignal.any([init.signal, deadline]) });
      },
    });
    const run = await runTtsRuntime(fixture, { liveTranscribe });
    if (run.speechErrors.length) throw new Error('Live speech could not complete within the provider or runtime limits.');
    runs = [summarize(run, 'Live MAI transcription, local fact-check fixtures')];
  } else {
    runs = [
      summarize(await runTtsRuntime(fixture), 'Raw chunk cuts'),
      summarize(await runTtsRuntime(fixture, { chunkBoundaryPunctuation: true }), 'File-STT boundary punctuation'),
    ];
  }
  const report = {
    audio: {
      source: fixture.source, durationSec: fixture.durationSec, inputBytes: fixture.wav.length, generationMs: fixture.generationMs,
      utterances: fixture.utterances.map(({ index, text, startSec, endSec }) => ({ index, text, startSec, endSec })),
    },
    providerRequests, wallMs: performance.now() - started, runs,
  };
  if (jsonOutput) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
} catch (error) {
  console.error(live ? 'Live TTS streaming failed. Check MAI configuration, provider availability, and the request deadline.' : error);
  process.exitCode = 1;
} finally {
  environment?.window.close();
}
