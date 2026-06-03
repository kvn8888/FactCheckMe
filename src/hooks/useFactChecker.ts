import { useState, useCallback, useRef } from 'react';
import { normalizeSentence } from '@/lib/sentences';
import { createSession, endSession, factCheckClaim } from '@/services/api';
import type { FactCheckResult, MonitoringStatus } from '@/types/factCheck';

interface UseFactCheckerOptions {
  onNewResult?: (result: FactCheckResult) => void;
  onError?: (error: string) => void;
}

const THROTTLE_INTERVAL = 500;
export type SentenceFactCheck = FactCheckResult | null | 'pending' | 'error';

export function useFactChecker({ onNewResult, onError }: UseFactCheckerOptions = {}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<FactCheckResult[]>([]);
  const [sentenceFactChecks, setSentenceFactChecks] = useState<Record<string, SentenceFactCheck>>({});
  const [status, setStatus] = useState<MonitoringStatus>({
    isActive: false,
    startedAt: null,
    sentencesProcessed: 0,
    claimsDetected: 0,
    factsChecked: 0,
  });
  const sessionIdRef = useRef<string | null>(null);
  const processingQueueRef = useRef<string[]>([]);
  const sentenceFactChecksRef = useRef<Map<string, SentenceFactCheck>>(new Map());
  const isProcessingRef = useRef(false);
  const lastApiCallRef = useRef(0);

  const startSession = useCallback(async () => {
    try {
      const response = await createSession();
      if (!response.success || !response.data) {
        console.error('Failed to create session:', response.error);
        return null;
      }

      return response.data.id;
    } catch (error) {
      console.error('Session creation error:', error);
      return null;
    }
  }, []);

  const finishSession = useCallback(async () => {
    if (!sessionIdRef.current) return;

    try {
      const response = await endSession(sessionIdRef.current);
      if (!response.success) {
        console.error('Failed to end session:', response.error);
      }
    } catch (error) {
      console.error('Failed to end session:', error);
    }
  }, []);

  const processQueue = useCallback(async () => {
    if (isProcessingRef.current || processingQueueRef.current.length === 0) return;

    isProcessingRef.current = true;
    setIsProcessing(true);

    while (processingQueueRef.current.length > 0) {
      const sentence = processingQueueRef.current.shift()!;
      const sentenceKey = normalizeSentence(sentence);
      const delay = THROTTLE_INTERVAL - (Date.now() - lastApiCallRef.current);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      lastApiCallRef.current = Date.now();

      try {
        const response = await factCheckClaim(sentence, sessionIdRef.current);

        if (!response.success || !response.data) {
          sentenceFactChecksRef.current.delete(sentenceKey);
          setSentenceFactChecks((current) => ({ ...current, [sentenceKey]: 'error' }));
          console.error('Fact-check error:', response.error);
          onError?.(response.error || 'Failed to fact-check sentence');
          continue;
        }

        if ('noClaim' in response.data) {
          sentenceFactChecksRef.current.set(sentenceKey, null);
          setSentenceFactChecks((current) => ({ ...current, [sentenceKey]: null }));
          continue;
        }

        const result: FactCheckResult = response.data;
        sentenceFactChecksRef.current.set(sentenceKey, result);
        setSentenceFactChecks((current) => ({ ...current, [sentenceKey]: result }));
        setResults((current) => [result, ...current]);
        setStatus((current) => ({
          ...current,
          claimsDetected: current.claimsDetected + 1,
          factsChecked: current.factsChecked + 1,
        }));
        onNewResult?.(result);
      } catch (error) {
        sentenceFactChecksRef.current.delete(sentenceKey);
        setSentenceFactChecks((current) => ({ ...current, [sentenceKey]: 'error' }));
        console.error('Processing error:', error);
        onError?.('Failed to process sentence');
      }
    }

    isProcessingRef.current = false;
    setIsProcessing(false);
  }, [onNewResult, onError]);

  const processText = useCallback((sentence: string) => {
    const sentenceKey = normalizeSentence(sentence);
    if (!sentenceKey || sentenceFactChecksRef.current.has(sentenceKey)) return;

    sentenceFactChecksRef.current.set(sentenceKey, 'pending');
    setSentenceFactChecks((current) => ({ ...current, [sentenceKey]: 'pending' }));
    processingQueueRef.current.push(sentence.trim());
    setStatus((current) => ({
      ...current,
      sentencesProcessed: current.sentencesProcessed + 1,
    }));
    void processQueue();
  }, [processQueue]);

  const startMonitoring = useCallback(async () => {
    const sessionId = await startSession();
    sessionIdRef.current = sessionId;
    processingQueueRef.current = [];
    sentenceFactChecksRef.current.clear();
    setSentenceFactChecks({});
    lastApiCallRef.current = 0;
    setStatus({
      isActive: true,
      startedAt: new Date(),
      sentencesProcessed: 0,
      claimsDetected: 0,
      factsChecked: 0,
    });
    setResults([]);
  }, [startSession]);

  const stopMonitoring = useCallback(async () => {
    setStatus((current) => ({
      ...current,
      isActive: false,
    }));

    setTimeout(async () => {
      while (isProcessingRef.current || processingQueueRef.current.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await finishSession();
      sessionIdRef.current = null;
    }, 0);
  }, [finishSession]);

  const clearResults = useCallback(() => {
    processingQueueRef.current = [];
    sentenceFactChecksRef.current.clear();
    setSentenceFactChecks({});
    setResults([]);
    setStatus((current) => ({
      ...current,
      sentencesProcessed: 0,
      claimsDetected: 0,
      factsChecked: 0,
    }));
  }, []);

  return {
    isProcessing,
    results,
    sentenceFactChecks,
    status,
    processText,
    startMonitoring,
    stopMonitoring,
    clearResults,
  };
}
