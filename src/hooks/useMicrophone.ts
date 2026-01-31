import { useState, useCallback, useRef, useEffect } from 'react';

// Type declarations for Web Speech API
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

interface UseMicrophoneOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
}

export function useMicrophone({ onTranscript, onError }: UseMicrophoneOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const accumulatedTextRef = useRef<string>('');
  const shouldRestartRef = useRef(false);
  
  // Use refs for callbacks to avoid useEffect dependency issues
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  
  // Update refs when callbacks change
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    // Check browser support
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      setIsSupported(false);
      return;
    }

    const recognitionInstance = new SpeechRecognitionClass();
    recognitionInstance.continuous = true;
    recognitionInstance.interimResults = true;
    recognitionInstance.lang = 'en-US';

    recognitionInstance.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          finalTranscript += transcript;
        }
      }

      if (finalTranscript) {
        accumulatedTextRef.current += ' ' + finalTranscript;
        
        // Check if we have enough text to process (at least a sentence)
        const text = accumulatedTextRef.current.trim();
        if (text.length > 20 && (text.includes('.') || text.includes('?') || text.includes('!'))) {
          onTranscriptRef.current(text);
          accumulatedTextRef.current = '';
        }
      }
    };

    recognitionInstance.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('Speech recognition error:', event.error);
      if (event.error === 'not-allowed') {
        onErrorRef.current?.('Microphone access denied. Please allow microphone access in your browser settings.');
        shouldRestartRef.current = false;
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        onErrorRef.current?.(`Speech recognition error: ${event.error}`);
      }
    };

    recognitionInstance.onend = () => {
      // Auto-restart if still supposed to be listening
      if (shouldRestartRef.current && recognitionRef.current) {
        try {
          recognitionInstance.start();
        } catch {
          // Already started or other issue
        }
      }
    };

    recognitionRef.current = recognitionInstance;

    return () => {
      shouldRestartRef.current = false;
      recognitionInstance.stop();
      recognitionRef.current = null;
    };
  }, []); // Empty deps - only run once

  const startListening = useCallback(async () => {
    if (!recognitionRef.current) {
      onErrorRef.current?.('Speech recognition is not supported in this browser.');
      return false;
    }

    try {
      // Request microphone permission
      await navigator.mediaDevices.getUserMedia({ audio: true });
      
      accumulatedTextRef.current = '';
      shouldRestartRef.current = true;
      recognitionRef.current.start();
      setIsListening(true);
      return true;
    } catch (error) {
      console.error('Failed to start listening:', error);
      onErrorRef.current?.('Failed to access microphone. Please check your permissions.');
      return false;
    }
  }, []);

  const stopListening = useCallback(() => {
    shouldRestartRef.current = false;
    
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    
    // Process any remaining text
    const remainingText = accumulatedTextRef.current.trim();
    if (remainingText.length > 10) {
      onTranscriptRef.current(remainingText);
    }
    accumulatedTextRef.current = '';
    setIsListening(false);
  }, []);

  return {
    isListening,
    isSupported,
    startListening,
    stopListening,
  };
}
