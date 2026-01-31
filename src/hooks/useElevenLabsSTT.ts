import { useState, useCallback, useRef, useEffect } from 'react';
import { useScribe, CommitStrategy } from '@elevenlabs/react';
import { supabase } from '@/integrations/supabase/client';

interface UseElevenLabsSTTOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
}

export function useElevenLabsSTT({ onTranscript, onError }: UseElevenLabsSTTOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const lastProcessedLengthRef = useRef<number>(0);
  const processedSentencesRef = useRef<Set<string>>(new Set());
  
  // Store callbacks in refs to keep useScribe options stable
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  
  // Update refs when callbacks change
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const scribe = useScribe({
    modelId: 'scribe_v2_realtime',
    commitStrategy: CommitStrategy.VAD,
    onPartialTranscript: (data) => {
      console.log('Partial:', data.text);
      
      // Process partial transcripts in real-time for faster feedback
      const text = data.text?.trim();
      if (text && text.length > lastProcessedLengthRef.current + 40) {
        // Look for complete sentences in the new content
        const sentences = text.match(/[^.!?]*[.!?]+/g);
        if (sentences && sentences.length > 0) {
          // Process sentences we haven't seen yet
          for (const sentence of sentences) {
            const trimmed = sentence.trim();
            if (trimmed.length > 10 && !processedSentencesRef.current.has(trimmed)) {
              processedSentencesRef.current.add(trimmed);
              console.log('Processing sentence from partial:', trimmed);
              onTranscriptRef.current(trimmed);
            }
          }
          lastProcessedLengthRef.current = text.length;
        }
      }
    },
    onCommittedTranscript: (data) => {
      console.log('Committed:', data.text);
      const text = data.text?.trim();
      if (text && text.length > 10) {
        // Check if we already processed this in partial
        if (!processedSentencesRef.current.has(text)) {
          onTranscriptRef.current(text);
          processedSentencesRef.current.add(text);
        }
      }
    },
  });

  const startListening = useCallback(async () => {
    setIsConnecting(true);
    
    try {
      // Request microphone permission first
      await navigator.mediaDevices.getUserMedia({ audio: true });

      // Get token from edge function
      const { data, error } = await supabase.functions.invoke('elevenlabs-scribe-token');

      if (error) {
        throw new Error(error.message || 'Failed to get scribe token');
      }

      if (!data?.token) {
        throw new Error('No token received from server');
      }

      // Connect to ElevenLabs Scribe
      await scribe.connect({
        token: data.token,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      lastProcessedLengthRef.current = 0;
      processedSentencesRef.current.clear();
      setIsListening(true);
      return true;
    } catch (error) {
      console.error('Failed to start listening:', error);
      const message = error instanceof Error ? error.message : 'Failed to start speech recognition';
      onErrorRef.current?.(message);
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, [scribe]);

  const stopListening = useCallback(() => {
    // Capture partial transcript BEFORE disconnecting
    const finalText = scribe.partialTranscript?.trim();
    
    scribe.disconnect();
    
    // Process remaining text from partial transcript if not already processed
    if (finalText && finalText.length > 10) {
      // Extract any unprocessed content
      const sentences = finalText.match(/[^.!?]*[.!?]+/g);
      if (sentences) {
        for (const sentence of sentences) {
          const trimmed = sentence.trim();
          if (trimmed.length > 10 && !processedSentencesRef.current.has(trimmed)) {
            console.log('Processing remaining sentence on stop:', trimmed);
            onTranscriptRef.current(trimmed);
          }
        }
      } else if (!processedSentencesRef.current.has(finalText)) {
        // No complete sentences, but still meaningful text
        console.log('Processing final text on stop:', finalText);
        onTranscriptRef.current(finalText);
      }
    }
    
    // Reset tracking refs
    lastProcessedLengthRef.current = 0;
    processedSentencesRef.current.clear();
    setIsListening(false);
  }, [scribe]);

  return {
    isListening,
    isConnecting,
    isSupported: true, // ElevenLabs works in all modern browsers
    startListening,
    stopListening,
    partialTranscript: scribe.partialTranscript,
    committedTranscripts: scribe.committedTranscripts,
  };
}
