import { beforeAll, describe, expect, it } from 'vitest';
import { buildTtsFixture, INPUT_RATE, OUTPUT_RATE, REPEATED_CLAIM } from '../../scripts/tts-stream-fixture.mjs';
import { contextForSpan, transcriptSpans } from '@/lib/transcript';
import { sentenceBoundaries } from '@/lib/sentences';
import { STORAGE_KEY } from '@/services/storage';
import { runTtsRuntime } from './tts-runtime-harness';

type Runtime = Awaited<ReturnType<typeof runTtsRuntime>>;
let fixture: Awaited<ReturnType<typeof buildTtsFixture>>;
let punctuation: Runtime;

beforeAll(async () => {
  fixture = await buildTtsFixture();
  punctuation = await runTtsRuntime(fixture, { chunkBoundaryPunctuation: true });
}, 90_000);

describe('100-second TTS streaming runtime', () => {
  it('uploads 48 kHz speech as exact 16 kHz PCM and persists occurrence-based history', async () => {
    // A capacity control ensures every final fact is observable. Another test
    // checks the exact requests and refusals with the unmodified default limiter.
    const raw = await runTtsRuntime(fixture, { rateLimit: () => {} });
    const { session, chunks, requests, events, facts } = raw;
    expect(fixture.source).toBe(process.platform === 'darwin' ? 'macOS Samantha' : 'fallback PCM');
    expect(fixture.durationSec).toBeGreaterThanOrEqual(95);
    expect(fixture.durationSec).toBeLessThanOrEqual(115);
    expect(fixture.wav.length).toBe(44 + fixture.sampleCount * 2);
    expect(fixture.sampleCount / INPUT_RATE).toBe(fixture.durationSec);
    expect(chunks.reduce((sum, chunk) => sum + chunk.sampleCount, 0)).toBe(Math.floor(fixture.sampleCount / 3));
    expect(chunks.slice(0, -1).every(chunk => chunk.bytes === 192044 && chunk.sampleCount === OUTPUT_RATE * 6)).toBe(true);
    expect(chunks.every(chunk => chunk.words.length > 0 && chunk.rms > 0.001)).toBe(true);
    expect(raw).toMatchObject({
      speechErrors: [], factErrors: [], peakWaiting: 0, peakOutstanding: 1, trackStops: 1, contextCloses: 1,
      stopCallbacks: 1, listening: false, finishing: false, processing: false, monitoring: false,
    });

    const transcriptions = events.filter(({ event }) => event === 'transcription.completed');
    const checks = events.filter(({ event }) => event === 'fact_check.completed');
    const transcribeRequests = requests.filter(({ path }) => path === '/api/transcribe');
    const factRequests = requests.filter(({ path }) => path === '/api/fact-check');
    expect(requests.every(request => request.status === 200 && /^http:\/\/127\.0\.0\.1:\d+$/.test(request.headers.origin))).toBe(true);
    expect(new Set(transcribeRequests.map(request => request.headers['x-transcript-run-id'])).size).toBe(1);
    expect(transcribeRequests).toHaveLength(chunks.length);
    expect(transcriptions).toHaveLength(chunks.length);
    expect(checks).toHaveLength(factRequests.length);
    for (const [index, { fields }] of transcriptions.entries()) {
      const headers = transcribeRequests[index].headers;
      expect(headers['x-transcript-run-id']).toMatch(/^[\da-f-]{36}$/);
      expect(fields).toMatchObject({
        transcriptRunId: headers['x-transcript-run-id'], chunkIndex: String(index), audioBytes: chunks[index].bytes,
        statusCode: 200, text: chunks[index].text,
      });
      expect(headers['x-transcript-chunk-index']).toBe(String(index));
    }
    for (const [index, { fields }] of checks.entries()) {
      const headers = factRequests[index].headers;
      expect(headers['x-segment-id']).toMatch(/^span-\d+$/);
      expect(headers['x-segment-revision']).toMatch(/^[1-9]\d*$/);
      expect(headers['x-session-id']).toBe(session.id);
      expect(fields).toMatchObject({
        sessionId: session.id, segmentId: headers['x-segment-id'], revision: headers['x-segment-revision'], statusCode: 200,
      });
      expect(String(fields.context)).toContain(String(fields.claim));
      expect(String(fields.context).length).toBeLessThanOrEqual(6000);
    }
    expect(new Set(events.map(({ fields }) => fields.requestId)).size).toBe(requests.length);

    expect(session.endedAt).toBeInstanceOf(Date);
    expect(session.transcript).toBe(fixture.utterances.map(utterance => utterance.text).join(' '));
    expect(session.chunks.map(chunk => chunk.text)).toEqual(chunks.map(chunk => chunk.text));
    expect(session.segments.map(span => span.text).join('').replace(/\s/g, '')).toBe(session.transcript.replace(/\s/g, ''));
    expect(raw.analysis).toMatchObject({ lostCharacters: 0, overlappingCharacters: 0, exactOffsets: true });
    for (const segment of session.segments) {
      expect(segment.final).toBe(true);
      expect(session.transcript.slice(segment.start, segment.end)).toBe(segment.text);
      expect(segment.chunkIds).toEqual(session.chunks.filter(chunk => chunk.start < segment.end && chunk.end > segment.start).map(chunk => chunk.id));
      expect(segment.text.length).toBeLessThanOrEqual(1900);
      const context = contextForSpan(session.transcript, segment);
      expect(context.length).toBeLessThanOrEqual(6000);
      expect(context).toContain(segment.text);
    }
    const repeated = session.segments.filter(span => span.text === REPEATED_CLAIM);
    expect(repeated).toHaveLength(2);
    expect(new Set(repeated.map(span => span.id)).size).toBe(2);
    expect(facts.filter(fact => fact.claim === REPEATED_CLAIM).map(fact => fact.segmentId).sort()).toEqual(repeated.map(span => span.id).sort());
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(saved.sessions).toEqual(JSON.parse(JSON.stringify([session])));
    expect(saved.facts).toEqual(JSON.parse(JSON.stringify(facts)));
  }, 15_000);

  it('keeps the current file boundary provisional, merges even cuts and settles odd cuts with lookahead', () => {
    const { chunks, session, snapshots, analysis } = punctuation;
    expect(analysis).toMatchObject({ lostCharacters: 0, overlappingCharacters: 0, exactOffsets: true });
    const even = [];
    const odd = [];
    const ignored = [];
    for (const chunk of chunks.slice(0, -1).filter(chunk => chunk.insertedPeriod)) {
      const { index } = chunk;
      const cut = session.chunks[index].end;
      const withLookahead = session.chunks.slice(0, index + 2);
      const transcript = session.transcript.slice(0, withLookahead[index + 1].end);
      expect(snapshots[index].find(span => span.end === cut)?.final).toBe(false);
      const spans = transcriptSpans(transcript, withLookahead);
      expect(snapshots[index + 1].map(({ id, end, final }) => ({ id, end, final })))
        .toEqual(spans.map(({ id, end, final }) => ({ id, end, final })));
      if (!sentenceBoundaries(transcript).includes(cut)) {
        ignored.push(index);
        expect(chunk.text).toMatch(/(?:^|\s)[A-Z]\.$/i);
        expect(spans.some(span => span.end === cut)).toBe(false);
      } else if (index % 2 === 0) {
        even.push(index);
        expect(spans.some(span => span.end === cut)).toBe(false);
        expect(spans.some(span => span.start < cut && span.end > cut)).toBe(true);
      } else {
        odd.push(index);
        expect(spans.find(span => span.end === cut)?.final).toBe(true);
      }
    }
    expect(even.length).toBeGreaterThan(3);
    expect(odd.length).toBeGreaterThan(3);
    expect(analysis.boundaryOutcomes).toEqual(chunks.filter(chunk => chunk.insertedPeriod).map(chunk => ({
      chunkIndex: chunk.index,
      offset: session.chunks[chunk.index].end,
      token: chunk.text.split(/\s+/).pop(),
      outcome: ignored.includes(chunk.index) ? 'ignored by sentence parser'
        : even.includes(chunk.index) ? 'continued across cut' : 'settled',
    })));
    expect(analysis.merged.some(merge => merge.cause === 'sentence parser suppressed U.S.')).toBe(true);
    expect(analysis.split.some(split => split.cause === 'ellipsis')).toBe(true);
    expect(analysis.split.some(split => split.cause?.startsWith('file-STT period at odd chunk'))).toBe(true);
  });

  it('respects the real rate limiter and retains previously verified facts at stop', () => {
    const { requests, snapshots, session, events, facts, factsBeforeStop, factErrors, speechErrors } = punctuation;
    const transcribes = requests.filter(({ path }) => path === '/api/transcribe');
    const checks = requests.filter(({ path }) => path === '/api/fact-check');
    const keys = (spans: Runtime['liveSegments']) => spans.map(span => `${span.id}/${span.revision}`);
    const observed = (request: Runtime['requests'][number]) => `${request.headers['x-segment-id']}/${request.headers['x-segment-revision']}`;
    const liveKeys = [...new Set(snapshots.flatMap(keys))];
    const finalKeys = keys(session.segments).filter(key => !liveKeys.includes(key));
    expect(checks.filter(({ phase }) => phase === 'live').map(observed)).toEqual(liveKeys);
    expect(checks.filter(({ phase }) => phase === 'reconcile').map(observed)).toEqual(finalKeys);
    expect(finalKeys).toEqual([]);
    expect(facts).toEqual(factsBeforeStop);
    expect(transcribes).toHaveLength(Math.ceil(fixture.durationSec / 6));
    expect(transcribes.length).toBeLessThan(20);
    expect(transcribes.every(({ status }) => status === 200)).toBe(true);
    expect(checks.length).toBeGreaterThan(30);
    expect(checks.map(({ status }) => status)).toEqual(checks.map((_, index) => index < 30 ? 200 : 429));
    expect(checks.some(({ phase }) => phase === 'reconcile')).toBe(false);
    expect(events.filter(({ event }) => event === 'fact_check.completed')).toHaveLength(30);
    expect(factErrors).toHaveLength(1);
    expect(speechErrors).toEqual([]);
  });

  it('stops at three waiting uploads and drains them after the held response is released', async () => {
    const run = await runTtsRuntime(fixture, { backpressure: true });
    expect(run.afterThreeChunks).toEqual({ encoded: 3, dispatched: 1, listening: true, errors: [] });
    expect(run.atQueueLimit).toEqual({ encoded: 4, dispatched: 1, listening: false, finishing: true, trackStops: 1 });
    expect(run.chunks.map(chunk => chunk.index)).toEqual([0, 1, 2, 3]);
    expect(run.chunks.every(chunk => chunk.bytes === 192044)).toBe(true);
    expect(run).toMatchObject({
      peakWaiting: 3, peakOutstanding: 4, trackStops: 1, contextCloses: 1, stopCallbacks: 1,
      listening: false, finishing: false, processing: false, monitoring: false,
    });
    expect(run.speechErrors).toEqual(['Transcription is falling behind. Recording stopped so queued audio can finish.']);
    expect(run.session.endedAt).toBeInstanceOf(Date);
    expect(run.session.chunks).toHaveLength(4);
  }, 15_000);
});
