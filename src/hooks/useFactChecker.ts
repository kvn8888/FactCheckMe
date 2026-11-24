import { useState, useCallback, useRef, useEffect } from 'react';
import { contextForSpan, transcriptSpans } from '@/lib/transcript';
import { createSession, endSession, factCheckClaim } from '@/services/api';
import { localSaveTranscript, localSaveFact, localRemoveSegmentFact } from '@/services/storage';
import type { FactCheckResult, MonitoringStatus, TranscriptChunk, TranscriptSegment } from '@/types/factCheck';

interface UseFactCheckerOptions { onNewResult?: (result: FactCheckResult) => void; onError?: (error: string) => void }
export type SentenceFactCheck = FactCheckResult | null | 'pending' | 'error';
interface CheckInput { context: string; requireComplete: boolean; rateLimited?: boolean }
interface Job { segment: TranscriptSegment; input: CheckInput }
interface Run {
  id: string; transcript: string; chunks: TranscriptChunk[]; segments: TranscriptSegment[];
  queue: Map<string, Job>; inputs: Map<string, CheckInput>; incompleteEnds: Set<number>; turnEnds: Set<number>;
  checks: Map<string, SentenceFactCheck>; facts: Map<string, FactCheckResult>;
  retryAt: number; rateLimited: boolean;
  controller: AbortController; draining?: Promise<void>; finishing?: Promise<void>; stopping: boolean;
}
function waitForBackoff(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
function interruptRun(r: Run) {
  r.controller.abort();
  r.segments = r.segments.map(segment => segment.status === 'pending' ? { ...segment, status: 'error' } : segment);
  localSaveTranscript(r.id, { transcript: r.transcript, chunks: r.chunks, segments: r.segments });
  void endSession(r.id);
}
const idle: MonitoringStatus = { isActive: false, startedAt: null, sentencesProcessed: 0, claimsDetected: 0, factsChecked: 0 };
export function useFactChecker(options: UseFactCheckerOptions = {}) {
  const callbacks = useRef(options); callbacks.current = options;
  const run = useRef<Run | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<FactCheckResult[]>([]);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [sentenceFactChecks, setSentenceFactChecks] = useState<Record<string, SentenceFactCheck>>({});
  const [status, setStatus] = useState<MonitoringStatus>(idle);
  const current = (r: Run) => mounted.current && run.current === r && !r.controller.signal.aborted;
  const publish = (r: Run) => {
    localSaveTranscript(r.id, { transcript: r.transcript, chunks: r.chunks, segments: r.segments });
    if (!current(r)) return;
    setSegments([...r.segments]);
    // Occurrence IDs, never sentence text, own a check and its revisions.
    setSentenceFactChecks(Object.fromEntries(r.checks));
    setResults([...r.facts.values()].reverse());
    setStatus(previous => ({ ...previous, sentencesProcessed: r.segments.length,
      claimsDetected: r.facts.size, factsChecked: r.facts.size }));
  };
  const processQueue = (r: Run): Promise<void> => {
    if (r.draining) return r.draining;
    setIsProcessing(true);
    r.draining = (async () => {
      try {
        while (current(r) && r.queue.size) {
          const backoff = r.retryAt - Date.now();
          if (backoff > 0) {
            await waitForBackoff(backoff, r.controller.signal);
            continue;
          }
          const job = r.queue.values().next().value!;
          const { segment, input } = job;
          r.queue.delete(segment.id);
          const response = await factCheckClaim(segment.text, r.id, r.controller.signal, {
            context: input.context, persist: false, segmentId: segment.id, revision: segment.revision,
            ...(input.requireComplete ? { requireComplete: true } : {}),
          });
          if (!current(r)) return;
          const rateLimited = !response.success && response.status === 429;
          if (rateLimited) {
            r.retryAt = Date.now() + Math.min(60_000, Math.max(250, response.retryAfterMs ?? 1000));
            if (!r.rateLimited) callbacks.current.onError?.(response.error || 'Fact checking is temporarily rate limited');
            r.rateLimited = true;
            input.rateLimited = true;
          }
          const latest = r.segments.find(item => item.id === segment.id);
          // A late response cannot overwrite a newer transcript revision.
          if (!latest || latest.revision !== segment.revision) continue;
          if (!response.success || !response.data || ('incomplete' in response.data && !input.requireComplete)) {
            latest.status = 'error';
            r.checks.set(latest.id, 'error');
            publish(r);
            if (!rateLimited) callbacks.current.onError?.(response.error || 'Failed to fact-check sentence');
            continue;
          }
          if ('incomplete' in response.data) {
            r.incompleteEnds.add(latest.end);
            reconcile(r, r.stopping);
            continue;
          }
          const result = 'noClaim' in response.data ? null : { ...response.data, sessionId: r.id, segmentId: latest.id, revision: latest.revision };
          latest.final ||= input.requireComplete;
          latest.status = result ? 'checked' : 'no-claim'; latest.factId = result?.id;
          r.checks.set(latest.id, result);
          if (result) {
            r.facts.set(latest.id, result); localSaveFact(result, r.id);
            callbacks.current.onNewResult?.(result);
          }
          publish(r);
        }
      } finally {
        r.draining = undefined;
        if (current(r)) setIsProcessing(false);
      }
    })();
    return r.draining;
  };
  const reconcile = (r: Run, finished: boolean) => {
    const old = new Map(r.segments.map(segment => [segment.id, segment]));
    const queue = new Map<string, Job>();
    r.segments = transcriptSpans(r.transcript, r.chunks, finished, r.incompleteEnds).map(span => {
      const previous = old.get(span.id);
      const context = contextForSpan(r.transcript, span);
      const input = r.inputs.get(span.id);
      if (previous && previous.text === span.text) {
        const incomplete = r.incompleteEnds.has(span.end);
        const legacyContextChanged = finished && !r.turnEnds.size && !r.rateLimited &&
          previous.status !== 'checked' && input?.context !== context;
        const retryError = finished && previous.status === 'error' && !input?.rateLimited;
        if (!legacyContextChanged && !retryError && !(finished && incomplete && input?.requireComplete)) {
          const settled = previous.status === 'checked' || previous.status === 'no-claim';
          previous.final = finished || (input?.requireComplete ? settled : span.final);
          const job = r.queue.get(span.id);
          if (job) queue.set(span.id, job);
          return previous;
        }
      }
      const requireComplete = !finished && r.turnEnds.has(span.end);
      const segment: TranscriptSegment = { ...span, final: span.final && !requireComplete, revision: (previous?.revision || 0) + 1, status: 'pending' };
      const nextInput = { context, requireComplete };
      r.checks.set(span.id, 'pending');
      if (previous && previous.text !== span.text) {
        r.facts.delete(span.id);
        localRemoveSegmentFact(r.id, span.id);
      }
      r.inputs.set(span.id, nextInput);
      queue.set(span.id, { segment, input: nextInput });
      return segment;
    });
    const ids = new Set(r.segments.map(segment => segment.id));
    for (const id of old.keys()) if (!ids.has(id)) {
      r.checks.delete(id); r.inputs.delete(id); r.facts.delete(id); localRemoveSegmentFact(r.id, id);
    }
    r.queue = queue;
    publish(r);
    if (r.queue.size) void processQueue(r);
  };
  const processText = (text: string, { source = 'chunk' }: { source?: TranscriptChunk['source'] } = {}) => {
    const r = run.current;
    if (!r || r.stopping || !text.trim()) return;
    const value = text.trim();
    const start = r.transcript.length + (r.transcript ? 1 : 0);
    r.transcript += (r.transcript ? ' ' : '') + value;
    r.chunks.push({ id: `${r.id}:chunk-${r.chunks.length}`, index: r.chunks.length, text: value,
      start, end: r.transcript.length, receivedAt: new Date(), source });
    if (source === 'turn') r.turnEnds.add(r.transcript.length);
    reconcile(r, false);
  };
  const startMonitoring = useCallback(async () => {
    const token = ++generation.current;
    if (run.current) { interruptRun(run.current); run.current = null; }
    const response = await createSession();
    if (!response.success || !response.data) { callbacks.current.onError?.('Could not start session'); return; }
    if (!mounted.current || token !== generation.current) { void endSession(response.data.id); return; }
    run.current = {
      id: response.data.id, transcript: '', chunks: [], segments: [], queue: new Map(), inputs: new Map(),
      incompleteEnds: new Set(), turnEnds: new Set(), checks: new Map(), facts: new Map(),
      controller: new AbortController(), stopping: false, retryAt: 0, rateLimited: false,
    };
    setSentenceFactChecks({}); setResults([]); setSegments([]); setIsProcessing(false);
    setStatus({ ...idle, isActive: true, startedAt: new Date() });
  }, []);
  const stopMonitoring = () => {
    const r = run.current;
    if (!r) return Promise.resolve();
    if (r.finishing) return r.finishing;
    r.stopping = true;
    setStatus(previous => ({ ...previous, isActive: false }));
    reconcile(r, true);
    r.finishing = (async () => {
      await r.draining;
      await endSession(r.id);
      if (run.current === r) run.current = null;
    })();
    return r.finishing;
  };
  const clearResults = useCallback(() => {
    ++generation.current;
    const r = run.current;
    if (r) { interruptRun(r); run.current = null; }
    setResults([]); setSentenceFactChecks({}); setSegments([]); setStatus(idle); setIsProcessing(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const sessionGeneration = generation;
    return () => {
      mounted.current = false; ++sessionGeneration.current;
      const r = run.current; run.current = null;
      if (r) interruptRun(r);
    };
  }, []);
  return { isProcessing, results, segments, sentenceFactChecks, status, processText, startMonitoring, stopMonitoring, clearResults };
}
