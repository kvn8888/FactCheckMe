import { useState, useCallback, useRef, useEffect } from 'react';
import { normalizeSentence } from '@/lib/sentences';
import { createSession, endSession, factCheckClaim } from '@/services/api';
import type { FactCheckResult, MonitoringStatus } from '@/types/factCheck';

interface UseFactCheckerOptions { onNewResult?: (result: FactCheckResult) => void; onError?: (error: string) => void }
export type SentenceFactCheck = FactCheckResult | null | 'pending' | 'error';
interface Run { id: string; queue: string[]; checks: Map<string, SentenceFactCheck>; controller: AbortController; draining?: Promise<void>; stopping: boolean }
const idle: MonitoringStatus = { isActive: false, startedAt: null, sentencesProcessed: 0, claimsDetected: 0, factsChecked: 0 };
export function useFactChecker(options: UseFactCheckerOptions = {}) {
  const callbacks = useRef(options); callbacks.current = options;
  const run = useRef<Run | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<FactCheckResult[]>([]);
  const [sentenceFactChecks, setSentenceFactChecks] = useState<Record<string, SentenceFactCheck>>({});
  const [status, setStatus] = useState<MonitoringStatus>(idle);
  const current = (r: Run) => mounted.current && run.current === r && !r.controller.signal.aborted;
  const processQueue = async (r: Run) => {
    if (r.draining) return r.draining;
    setIsProcessing(true);
    r.draining = (async () => {
      while (current(r) && r.queue.length) {
        const sentence = r.queue.shift()!;
        const key = normalizeSentence(sentence);
        const response = await factCheckClaim(sentence, r.id, r.controller.signal);
        if (!current(r)) return;
        if (!response.success || !response.data) {
          r.checks.delete(key);
          setSentenceFactChecks(previous => ({ ...previous, [key]: 'error' }));
          callbacks.current.onError?.(response.error || 'Failed to fact-check sentence');
          continue;
        }
        const result = 'noClaim' in response.data ? null : response.data;
        r.checks.set(key, result);
        setSentenceFactChecks(previous => ({ ...previous, [key]: result }));
        if (result) {
          setResults(previous => [result, ...previous].slice(0, 500));
          setStatus(previous => ({ ...previous, claimsDetected: previous.claimsDetected + 1, factsChecked: previous.factsChecked + 1 }));
          callbacks.current.onNewResult?.(result);
        }
      }
    })().finally(() => { r.draining = undefined; if (current(r)) setIsProcessing(false); });
    return r.draining;
  };
  const processText = (sentence: string) => {
    const r = run.current;
    const key = normalizeSentence(sentence);
    if (!r || r.stopping || !key || r.checks.has(key)) return;
    if (r.queue.length >= 50) { callbacks.current.onError?.('Too many claims waiting. Please pause recording.'); return; }
    r.checks.set(key, 'pending');
    if (r.checks.size > 500) r.checks.delete(r.checks.keys().next().value!);
    setSentenceFactChecks(Object.fromEntries(r.checks));
    r.queue.push(sentence.trim());
    setStatus(previous => ({ ...previous, sentencesProcessed: previous.sentencesProcessed + 1 }));
    void processQueue(r);
  };
  const startMonitoring = useCallback(async () => {
    const token = ++generation.current;
    if (run.current) { run.current.controller.abort(); void endSession(run.current.id); run.current = null; }
    const response = await createSession();
    if (!response.success || !response.data) { callbacks.current.onError?.('Could not start session'); return; }
    if (!mounted.current || token !== generation.current) { void endSession(response.data.id); return; }
    run.current = { id: response.data.id, queue: [], checks: new Map(), controller: new AbortController(), stopping: false };
    setSentenceFactChecks({}); setResults([]); setIsProcessing(false);
    setStatus({ ...idle, isActive: true, startedAt: new Date() });
  }, []);
  const stopMonitoring = useCallback(async () => {
    const r = run.current;
    if (!r) return;
    r.stopping = true;
    setStatus(previous => ({ ...previous, isActive: false }));
    await r.draining;
    await endSession(r.id);
    if (run.current === r) run.current = null;
  }, []);
  const clearResults = useCallback(() => {
    ++generation.current;
    const r = run.current;
    if (r) { r.controller.abort(); void endSession(r.id); run.current = null; }
    setResults([]); setSentenceFactChecks({}); setStatus(idle); setIsProcessing(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const sessionGeneration = generation;
    return () => { mounted.current = false; ++sessionGeneration.current; const r = run.current; run.current = null; if (r) { r.controller.abort(); void endSession(r.id); } };
  }, []);
  return { isProcessing, results, sentenceFactChecks, status, processText, startMonitoring, stopMonitoring, clearResults };
}
