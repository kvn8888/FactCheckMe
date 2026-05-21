import { useState, useCallback, useRef } from 'react';
import { createSession, endSession, factCheckClaim } from '@/services/api';
import type { FactCheckResult, MonitoringStatus } from '@/types/factCheck';

interface UseFactCheckerOptions {
  onNewResult?: (result: FactCheckResult) => void;
  onError?: (error: string) => void;
}

// Throttle interval in ms - wait at least this long between API calls
// With paid Gemini, we can be more responsive
const THROTTLE_INTERVAL = 2000;

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
  const textBufferRef = useRef<string[]>([]);
  const lastApiCallRef = useRef<number>(0);
  const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const startSession = useCallback(async () => {
    try {
      const response = await createSession();
      if (!response.success || !response.data) {
        console.error('Failed to create session:', response.error);
        return null;
      }

      return response.data.id;
    } catch (e) {
      console.error('Session creation error:', e);
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
        const response = await factCheckClaim(claim, sessionIdRef.current);

        if (!response.success || !response.data) {
          console.error('Fact-check error:', response.error);
          onError?.(response.error || 'Failed to fact-check claim');
          continue;
        }

        // Skip if no claim was found in the speech
        if ('noClaim' in response.data) {
          console.log('No factual claim detected in speech');
          continue;
        }

        const result: FactCheckResult = response.data;

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

  const processBufferedText = useCallback(async () => {
    if (textBufferRef.current.length === 0) return;

    // Combine all buffered text into one request
    const combinedText = textBufferRef.current.join(' ');
    textBufferRef.current = [];

    // Skip empty or very short text
    if (combinedText.trim().length < 15) return;

    try {
      // Send directly to fact-check (it will extract and check in one call)
      setStatus((prev) => ({
        ...prev,
        claimsDetected: prev.claimsDetected + 1,
      }));

      processingQueueRef.current.push(combinedText);
      processQueue();
    } catch (e) {
      console.error('Text processing error:', e);
    }
  }, [processQueue]);

  const processText = useCallback(async (text: string) => {
    setStatus((prev) => ({
      ...prev,
      sentencesProcessed: prev.sentencesProcessed + 1,
    }));

    // Add text to buffer
    textBufferRef.current.push(text);

    // Check if we can make an API call (throttling)
    const now = Date.now();
    const timeSinceLastCall = now - lastApiCallRef.current;

    if (timeSinceLastCall >= THROTTLE_INTERVAL) {
      // Can call immediately
      lastApiCallRef.current = now;
      processBufferedText();
    } else {
      // Schedule a call after the throttle interval
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
      }
      throttleTimeoutRef.current = setTimeout(() => {
        lastApiCallRef.current = Date.now();
        processBufferedText();
      }, THROTTLE_INTERVAL - timeSinceLastCall);
    }
  }, [processBufferedText]);

  const startMonitoring = useCallback(async () => {
    const sessionId = await startSession();
    sessionIdRef.current = sessionId;

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
    // Process any remaining buffered text immediately
    if (textBufferRef.current.length > 0) {
      await processBufferedText();
    }

    // Clear throttle timeout (no more new text will be processed)
    if (throttleTimeoutRef.current) {
      clearTimeout(throttleTimeoutRef.current);
      throttleTimeoutRef.current = null;
    }

    // Mark monitoring as inactive, but let processing continue in background
    setStatus((prev) => ({
      ...prev,
      isActive: false,
    }));

    // End session after a delay to allow background processing to complete
    // This doesn't block the UI - session just gets marked as ended later
    setTimeout(async () => {
      // Wait for processing to finish before ending session
      while (isProcessingRef.current || processingQueueRef.current.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await finishSession();
      sessionIdRef.current = null;
    }, 0);
  }, [finishSession, processBufferedText]);

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
