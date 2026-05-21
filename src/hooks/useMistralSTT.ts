import { useState, useCallback, useRef, useEffect } from 'react';
import { transcribeAudio } from '@/services/api';

interface UseMistralSTTOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
}

const RECORDING_INTERVAL_MS = 4500;
const MIN_AUDIO_BYTES = 1200;
const MIN_TRANSCRIPT_CHARS = 8;

const getSupportedMimeType = () => {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
};

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read audio chunk'));
    reader.readAsDataURL(blob);
  });

export function useMistralSTT({ onTranscript, onError }: UseMistralSTTOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<number | null>(null);
  const processedTranscriptsRef = useRef<Set<string>>(new Set());
  const lastTranscriptRef = useRef('');
  const isStoppingRef = useRef(false);
  const isProcessingAudioRef = useRef(false);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const getNewTranscriptText = (text: string) => {
    const previous = lastTranscriptRef.current;
    lastTranscriptRef.current = text;

    if (previous && text.toLowerCase().startsWith(previous.toLowerCase())) {
      return text.slice(previous.length).trim();
    }

    return text;
  };

  const processAudioSnapshot = useCallback(async (blob: Blob) => {
    if (blob.size < MIN_AUDIO_BYTES) return;
    if (isProcessingAudioRef.current) return;

    isProcessingAudioRef.current = true;

    try {
      const audioData = await blobToBase64(blob);
      const response = await transcribeAudio(audioData, blob.type || 'audio/webm');

      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to transcribe audio');
      }

      const fullText = response.data.text.trim();
      const text = getNewTranscriptText(fullText);
      if (text.length < MIN_TRANSCRIPT_CHARS || processedTranscriptsRef.current.has(text)) return;

      processedTranscriptsRef.current.add(text);
      setPartialTranscript(text);
      onTranscriptRef.current(text);
    } catch (error) {
      if (!isStoppingRef.current) {
        const message = error instanceof Error ? error.message : 'Failed to transcribe audio';
        onErrorRef.current?.(message);
      }
    } finally {
      isProcessingAudioRef.current = false;
    }
  }, []);

  const processRecordedAudio = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || chunksRef.current.length === 0) return;

    const type = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type });
    void processAudioSnapshot(blob);
  }, [processAudioSnapshot]);

  const stopListening = useCallback(() => {
    isStoppingRef.current = true;

    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.requestData();
      recorder.stop();
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    lastTranscriptRef.current = '';
    isProcessingAudioRef.current = false;
    setIsListening(false);
    setPartialTranscript('');
  }, []);

  const startListening = useCallback(async () => {
    setIsConnecting(true);
    isStoppingRef.current = false;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone capture is not supported in this browser');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          processRecordedAudio();
        }
      };
      recorder.onerror = () => {
        onErrorRef.current?.('Microphone recording failed');
      };

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      processedTranscriptsRef.current.clear();
      lastTranscriptRef.current = '';
      setPartialTranscript('');
      recorder.start();
      intervalRef.current = window.setInterval(() => {
        const currentRecorder = recorderRef.current;
        if (currentRecorder?.state === 'recording') currentRecorder.requestData();
      }, RECORDING_INTERVAL_MS);
      setIsListening(true);
      return true;
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      chunksRef.current = [];
      const message = error instanceof Error ? error.message : 'Failed to start speech recognition';
      onErrorRef.current?.(message);
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, [processRecordedAudio]);

  useEffect(() => stopListening, [stopListening]);

  return {
    isListening,
    isConnecting,
    isSupported: typeof MediaRecorder !== 'undefined',
    startListening,
    stopListening,
    partialTranscript,
    committedTranscripts: [],
  };
}
