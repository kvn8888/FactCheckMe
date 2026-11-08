import { useState, useCallback, useRef, useEffect } from 'react';
import { contextForSpan, transcriptSpans } from '@/lib/transcript';
import { createSession, endSession, factCheckClaim } from '@/services/api';
import { localSaveTranscript, localSaveFact, localRemoveSegmentFact } from '@/services/storage';
import type { FactCheckResult, MonitoringStatus, TranscriptChunk, TranscriptSegment } from '@/types/factCheck';

interface UseFactCheckerOptions { onNewResult?: (result: FactCheckResult) => void; onError?: (error: string) => void }
export type SentenceFactCheck = FactCheckResult | null | 'pending' | 'error';
interface Job { segment: TranscriptSegment; context: string }
interface Run {
  id: string; transcript: string; chunks: TranscriptChunk[]; segments: TranscriptSegment[];
  queue: Job[]; contexts: Map<string, string>; checks: Map<string, SentenceFactCheck>; facts: Map<string, FactCheckResult>;
  controller: AbortController; draining?: Promise<void>; finishing?: Promise<void>; stopping: boolean;
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
      while (current(r) && r.queue.length) {
        const { segment, context } = r.queue.shift()!;
        const response = await factCheckClaim(segment.text, r.id, r.controller.signal, { context, persist: false });
        if (!current(r)) return;
        const latest = r.segments.find(item => item.id === segment.id);
        // A late partial/no-claim response cannot overwrite a completed revision.
        if (!latest || latest.revision !== segment.revision) continue;
        if (!response.success || !response.data) {
          latest.status = 'error'; r.checks.set(latest.id, 'error'); publish(r);
          callbacks.current.onError?.(response.error || 'Failed to fact-check sentence');
          continue;
        }
        const result = 'noClaim' in response.data ? null : { ...response.data, sessionId: r.id, segmentId: latest.id, revision: latest.revision };
        latest.status = result ? 'checked' : 'no-claim'; latest.factId = result?.id;
        r.checks.set(latest.id, result);
        if (result) {
          r.facts.set(latest.id, result); localSaveFact(result, r.id);
          callbacks.current.onNewResult?.(result);
        }
        publish(r);
      }
    })().finally(() => { r.draining = undefined; if (current(r)) setIsProcessing(false); });
    return r.draining;
  };
  const reconcile = (r: Run, finished: boolean) => {
    const old = new Map(r.segments.map(segment => [segment.id, segment]));
    r.segments = transcriptSpans(r.transcript, r.chunks, finished).map(span => {
      const previous = old.get(span.id);
      const context = contextForSpan(r.transcript, span);
      // Final reconciliation revisits changed context (including nonclaims), but
      // keeps completed or in-flight checks whose exact input is unchanged.
      if (previous && previous.text === span.text && previous.status !== 'error' &&
          ((!finished && previous.final === span.final) || r.contexts.get(span.id) === context)) {
        previous.final = span.final; return previous;
      }
      const segment: TranscriptSegment = { ...span, revision: (previous?.revision || 0) + 1, status: 'pending' };
      r.checks.set(span.id, 'pending'); r.facts.delete(span.id);
      localRemoveSegmentFact(r.id, span.id);
      r.queue = r.queue.filter(job => job.segment.id !== span.id);
      r.contexts.set(span.id, context);
      r.queue.push({ segment, context });
      return segment;
    });
    const ids = new Set(r.segments.map(segment => segment.id));
    for (const id of old.keys()) if (!ids.has(id)) {
      r.checks.delete(id); r.facts.delete(id); localRemoveSegmentFact(r.id, id);
    }
    r.queue = r.queue.filter(job => ids.has(job.segment.id));
    publish(r);
    if (r.queue.length) void processQueue(r);
  };
  const processText = (text: string) => {
    const r = run.current;
    if (!r || r.stopping || !text.trim()) return;
    const value = text.trim();
    const start = r.transcript.length + (r.transcript ? 1 : 0);
    r.transcript += (r.transcript ? ' ' : '') + value;
    r.chunks.push({ id: `${r.id}:chunk-${r.chunks.length}`, index: r.chunks.length, text: value,
      start, end: r.transcript.length, receivedAt: new Date() });
    reconcile(r, false);
  };
  const startMonitoring = useCallback(async () => {
    const token = ++generation.current;
    if (run.current) { interruptRun(run.current); run.current = null; }
    const response = await createSession();
    if (!response.success || !response.data) { callbacks.current.onError?.('Could not start session'); return; }
    if (!mounted.current || token !== generation.current) { void endSession(response.data.id); return; }
    run.current = { id: response.data.id, transcript: '', chunks: [], segments: [], queue: [], contexts: new Map(), checks: new Map(), facts: new Map(), controller: new AbortController(), stopping: false };
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
