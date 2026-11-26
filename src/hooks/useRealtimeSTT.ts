import { useEffect, useRef, useState } from 'react';
import { createSttAdapter, PauseVad, type SttProviderId, type SttTransportAdapter } from '@/lib/stt';
import { SttUserError } from '@/lib/stt/types';

const DRAIN_MS = 8000;

interface Options {
  provider?: SttProviderId;
  onTurn?: (text: string) => void;
  onChunk?: (text: string) => void;
  onStopped?: () => void;
  onError?: (message: string) => void;
}

interface Capture {
  controller: AbortController;
  adapter: SttTransportAdapter;
  vad: PauseVad;
  stream?: MediaStream;
  drainTimer?: ReturnType<typeof setTimeout>;
  resolveStop?: () => void;
  stop?: Promise<void>;
  listening: boolean;
  finished: boolean;
}

function stopCapture(capture: Capture) {
  capture.vad.stop();
  capture.adapter.stopInput();
  capture.stream?.getTracks().forEach(track => track.stop());
  capture.stream = undefined;
}

function closeCapture(capture: Capture) {
  capture.controller.abort();
  clearTimeout(capture.drainTimer);
  stopCapture(capture);
  capture.adapter.close();
  capture.resolveStop?.();
}

export function useRealtimeSTT(options: Options = {}) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const active = useRef<Capture | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState('');

  const emit = (text: string) => {
    if (text.trim()) (callbacks.current.onTurn ?? callbacks.current.onChunk)?.(text.trim());
  };

  function finish(capture: Capture) {
    if (active.current !== capture || capture.finished) return;
    capture.finished = true;
    if (capture.listening) capture.adapter.flushRemaining();
    active.current = null;
    closeCapture(capture);
    setIsListening(false);
    setIsConnecting(false);
    setIsFinishing(false);
    setPartialTranscript('');
    if (capture.listening || capture.stop) callbacks.current.onStopped?.();
  }

  function fail(capture: Capture, message: string) {
    if (active.current !== capture) return;
    callbacks.current.onError?.(message);
    finish(capture);
  }

  function commit(capture: Capture) {
    if (!capture.vad.hasActiveTurn()) return;
    capture.vad.resetTurn();
    capture.adapter.commit();
  }

  function settleDrain(capture: Capture) {
    if (capture.stop && capture.adapter.isIdle()) finish(capture);
  }

  async function startListening() {
    if (active.current) return false;
    const provider = callbacks.current.provider ?? 'openai-realtime';
    const hasTransport = provider === 'mai-streaming'
      ? typeof WebSocket !== 'undefined'
      : typeof RTCPeerConnection !== 'undefined';
    if (!navigator.mediaDevices?.getUserMedia || !hasTransport || typeof AudioContext === 'undefined') {
      callbacks.current.onError?.(
        provider === 'mai-streaming'
          ? 'Live transcription needs microphone and WebSocket support in a secure browser.'
          : 'Live transcription needs microphone and WebRTC support in a secure browser.',
      );
      return false;
    }

    const capture: Capture = {
      controller: new AbortController(),
      adapter: createSttAdapter(provider),
      vad: new PauseVad(),
      listening: false,
      finished: false,
    };
    active.current = capture;
    setIsConnecting(true);
    const signal = capture.controller.signal;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (signal.aborted) {
        stream.getTracks().forEach(track => track.stop());
        return false;
      }
      capture.stream = stream;

      await capture.adapter.connect(stream, signal, {
        onPartial: text => {
          if (active.current === capture) setPartialTranscript(text);
        },
        onTurn: text => {
          if (active.current === capture) emit(text);
        },
        onSpeechDetected: () => {
          if (active.current === capture && !capture.stop) capture.vad.markSpeechDetected();
        },
        onItemError: message => {
          if (active.current === capture) callbacks.current.onError?.(message);
        },
        onFatalError: message => {
          fail(capture, message);
        },
        onDrained: () => {
          if (active.current === capture) settleDrain(capture);
        },
      });
      if (signal.aborted || active.current !== capture) return false;

      const vadStarted = await capture.vad.start(stream, signal, () => commit(capture));
      if (!vadStarted || signal.aborted || active.current !== capture) return false;

      capture.listening = true;
      setIsConnecting(false);
      setIsListening(true);
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      const message = denied
        ? 'Microphone access was denied.'
        : error instanceof SttUserError
          ? error.message
          : 'Could not start live transcription.';
      fail(capture, message);
      return false;
    }
  }

  function stopListening() {
    const capture = active.current;
    if (!capture) return Promise.resolve();
    if (capture.stop) return capture.stop;
    capture.stop = new Promise<void>(resolve => { capture.resolveStop = resolve; });
    setIsListening(false);
    setIsConnecting(false);
    setIsFinishing(true);
    stopCapture(capture);
    commit(capture);
    if (active.current === capture) {
      capture.drainTimer = setTimeout(() => finish(capture), DRAIN_MS);
      settleDrain(capture);
    }
    return capture.stop;
  }

  useEffect(() => () => {
    const capture = active.current;
    active.current = null;
    if (capture) closeCapture(capture);
  }, []);

  return { partialTranscript, isListening, isConnecting, isFinishing, startListening, stopListening };
}
