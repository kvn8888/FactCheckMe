import { useState, useCallback, useRef, useEffect } from 'react';
import { consumeCompleteSentences } from '@/lib/sentences';
import { getRealtimeTranscriptionUrl } from '@/services/api';

interface UseMistralSTTOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
}

const TARGET_SAMPLE_RATE = 16000;
const PROCESSOR_BUFFER_SIZE = 4096;

const floatTo16BitPcm = (input: Float32Array, inputSampleRate: number) => {
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let sample = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex++) {
      sample += input[inputIndex];
    }

    sample = Math.max(-1, Math.min(1, sample / Math.max(1, end - start)));
    output[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
};

const pcmToBase64 = (pcm: Int16Array) => {
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';

  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
};

export function useMistralSTT({ onTranscript, onError }: UseMistralSTTOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [committedTranscripts, setCommittedTranscripts] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptBufferRef = useRef('');
  const isStoppingRef = useRef(false);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const cleanupAudio = useCallback(() => {
    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    void audioContextRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
  }, []);

  const stopListening = useCallback(() => {
    isStoppingRef.current = true;
    cleanupAudio();

    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'end' }));
      window.setTimeout(() => socket.close(), 5000);
    } else {
      socket?.close();
    }

    socketRef.current = null;
    setIsListening(false);
  }, [cleanupAudio]);

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
      const AudioContextClass = window.AudioContext;
      const audioContext = new AudioContextClass({ sampleRate: TARGET_SAMPLE_RATE });
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
      const socket = new WebSocket(getRealtimeTranscriptionUrl());

      transcriptBufferRef.current = '';
      setPartialTranscript('');
      setCommittedTranscripts([]);

      processorNode.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;

        const input = event.inputBuffer.getChannelData(0);
        const pcm = floatTo16BitPcm(input, audioContext.sampleRate);
        socket.send(JSON.stringify({ type: 'audio', audio: pcmToBase64(pcm) }));
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));

        if (message.type === 'ready') {
          setIsConnecting(false);
          setIsListening(true);
          return;
        }

        if (message.type === 'transcript_delta' && typeof message.text === 'string') {
          transcriptBufferRef.current += message.text;
          const { sentences, remainder } = consumeCompleteSentences(transcriptBufferRef.current);
          transcriptBufferRef.current = remainder;
          setPartialTranscript(remainder);

          if (sentences.length > 0) {
            setCommittedTranscripts((current) => [...current, ...sentences]);
            sentences.forEach((sentence) => onTranscriptRef.current(sentence));
          }
          return;
        }

        if (message.type === 'error') {
          onErrorRef.current?.(message.error || 'Mistral realtime transcription failed');
        }
      };

      socket.onerror = () => {
        if (!isStoppingRef.current) {
          onErrorRef.current?.('Mistral realtime transcription connection failed');
        }
      };

      socket.onclose = () => {
        if (!isStoppingRef.current) {
          cleanupAudio();
          setIsListening(false);
          setIsConnecting(false);
        }
      };

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceNodeRef.current = sourceNode;
      processorNodeRef.current = processorNode;
      socketRef.current = socket;
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
      return true;
    } catch (error) {
      cleanupAudio();
      socketRef.current?.close();
      socketRef.current = null;
      const message = error instanceof Error ? error.message : 'Failed to start realtime transcription';
      onErrorRef.current?.(message);
      setIsConnecting(false);
      return false;
    }
  }, [cleanupAudio]);

  useEffect(() => stopListening, [stopListening]);

  return {
    isListening,
    isConnecting,
    isSupported: Boolean(navigator.mediaDevices?.getUserMedia && window.AudioContext && window.WebSocket),
    startListening,
    stopListening,
    partialTranscript,
    committedTranscripts,
  };
}
