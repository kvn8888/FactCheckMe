import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { FactCheckResult, MonitoringStatus } from '@/types/factCheck';

interface UseFactCheckerOptions {
  onNewResult?: (result: FactCheckResult) => void;
  onError?: (error: string) => void;
}

export function useFactChecker({ onNewResult, onError }: UseFactCheckerOptions = {}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<FactCheckResult[]>([]);
  const [status, setStatus] = useState<MonitoringStatus>({
    isActive: false,
    startedAt: null,
    sentencesProcessed: 0,
    claimsDetected: 0,
    factsChecked: 0,
  });
  const sessionIdRef = useRef<string | null>(null);
  const processingQueueRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);

  const createSession = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('fact_check_sessions')
        .insert({})
        .select()
        .single();

      if (error) {
        console.error('Failed to create session:', error);
        return null;
      }

      return data.id;
    } catch (e) {
      console.error('Session creation error:', e);
      return null;
    }
  }, []);

  const endSession = useCallback(async () => {
    if (!sessionIdRef.current) return;

    try {
      await supabase
        .from('fact_check_sessions')
        .update({ ended_at: new Date().toISOString() })
        .eq('id', sessionIdRef.current);
    } catch (e) {
      console.error('Failed to end session:', e);
    }
  }, []);

  const processQueue = useCallback(async () => {
    if (isProcessingRef.current || processingQueueRef.current.length === 0) {
      return;
    }

    isProcessingRef.current = true;
    setIsProcessing(true);

    while (processingQueueRef.current.length > 0) {
      const claim = processingQueueRef.current.shift()!;

      try {
        const { data, error } = await supabase.functions.invoke('fact-check', {
          body: { claim, sessionId: sessionIdRef.current },
        });

        if (error) {
          console.error('Fact-check error:', error);
          onError?.(error.message || 'Failed to fact-check claim');
          continue;
        }

        if (data.error) {
          onError?.(data.error);
          continue;
        }

        const result: FactCheckResult = {
          id: data.id,
          claim: data.claim,
          verdict: data.verdict,
          confidence: data.confidence,
          timestamp: new Date(data.timestamp),
          sources: data.sources || [],
          explanation: data.explanation,
        };

        setResults((prev) => [result, ...prev]);
        setStatus((prev) => ({
          ...prev,
          factsChecked: prev.factsChecked + 1,
        }));
        onNewResult?.(result);
      } catch (e) {
        console.error('Processing error:', e);
        onError?.('Failed to process claim');
      }
    }

    isProcessingRef.current = false;
    setIsProcessing(false);
  }, [onNewResult, onError]);

  const processText = useCallback(async (text: string) => {
    setStatus((prev) => ({
      ...prev,
      sentencesProcessed: prev.sentencesProcessed + 1,
    }));

    try {
      // Extract claims from the text using AI
      const { data, error } = await supabase.functions.invoke('transcribe', {
        body: { audioData: text },
      });

      if (error || data.error) {
        console.error('Claim extraction error:', error || data.error);
        return;
      }

      const claims: string[] = data.claims || [];

      if (claims.length > 0) {
        setStatus((prev) => ({
          ...prev,
          claimsDetected: prev.claimsDetected + claims.length,
        }));

        // Add claims to processing queue
        processingQueueRef.current.push(...claims);
        processQueue();
      }
    } catch (e) {
      console.error('Text processing error:', e);
    }
  }, [processQueue]);

  const startMonitoring = useCallback(async () => {
    const sessionId = await createSession();
    sessionIdRef.current = sessionId;

    setStatus({
      isActive: true,
      startedAt: new Date(),
      sentencesProcessed: 0,
      claimsDetected: 0,
      factsChecked: 0,
    });
    setResults([]);
  }, [createSession]);

  const stopMonitoring = useCallback(async () => {
    await endSession();
    sessionIdRef.current = null;

    setStatus((prev) => ({
      ...prev,
      isActive: false,
    }));
  }, [endSession]);

  const clearResults = useCallback(() => {
    setResults([]);
    setStatus((prev) => ({
      ...prev,
      sentencesProcessed: 0,
      claimsDetected: 0,
      factsChecked: 0,
    }));
  }, []);

  return {
    isProcessing,
    results,
    status,
    processText,
    startMonitoring,
    stopMonitoring,
    clearResults,
  };
}
