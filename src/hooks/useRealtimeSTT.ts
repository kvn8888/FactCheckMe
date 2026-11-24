import { useEffect, useRef, useState } from 'react';
import { createRealtimeSession } from '@/services/api';

const VAD_POLL_MS = 50;
const PAUSE_MS = 600;
const MIN_SPEECH_MS = 800;
const MAX_TURN_MS = 14_000;
const RMS_THRESHOLD = 0.015;
const DRAIN_MS = 8000;

interface Options {
  onTurn?: (text: string) => void;
  onChunk?: (text: string) => void;
  onStopped?: () => void;
  onError?: (message: string) => void;
}

interface Capture {
  controller: AbortController;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  vad?: ReturnType<typeof setInterval>;
  drainTimer?: ReturnType<typeof setTimeout>;
  resolveStop?: () => void;
  stop?: Promise<void>;
  listening: boolean;
  speechMs: number;
  turnStartedAt?: number;
  lastSpeechAt?: number;
  nextCommit: number;
  pendingCommits: Set<string>;
  orderedItems: string[];
  committedItems: Set<string>;
  flushedItems: Set<string>;
  partials: Map<string, string>;
  completions: Map<string, string>;
}

function stopCapture(capture: Capture) {
  clearInterval(capture.vad);
  capture.stream?.getTracks().forEach(track => track.stop());
  capture.stream = undefined;
  capture.source?.disconnect();
  capture.source = undefined;
  if (capture.context && capture.context.state !== 'closed') void capture.context.close().catch(() => {});
  capture.context = undefined;
}

function closeCapture(capture: Capture) {
  capture.controller.abort();
  clearTimeout(capture.drainTimer);
  stopCapture(capture);
  capture.channel?.close();
  capture.peer?.close();
  capture.resolveStop?.();
}

function waitUntil(target: EventTarget, event: string, ready: () => boolean, signal: AbortSignal, timeoutMs: number) {
  return new Promise<boolean>(resolve => {
    if (ready() || signal.aborted) { resolve(!signal.aborted); return; }
    const finish = (value: boolean) => {
      clearTimeout(timer);
      target.removeEventListener(event, check);
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const check = () => { if (ready()) finish(true); };
    const abort = () => finish(false);
    const timer = setTimeout(abort, timeoutMs);
    target.addEventListener(event, check);
    signal.addEventListener('abort', abort, { once: true });
  });
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

  function flush(capture: Capture, remaining = false) {
    while (capture.orderedItems.length) {
      const item = capture.orderedItems[0];
      if (!remaining && !capture.completions.has(item)) break;
      capture.orderedItems.shift();
      capture.flushedItems.add(item);
      emit(capture.completions.get(item) ?? capture.partials.get(item) ?? '');
      capture.partials.delete(item);
      capture.completions.delete(item);
    }
    if (remaining) {
      // An acknowledgement may be missing if the peer closed mid-commit.
      const unacknowledged = new Set([...capture.partials.keys(), ...capture.completions.keys()]);
      for (const item of unacknowledged) emit(capture.completions.get(item) ?? capture.partials.get(item) ?? '');
    } else {
      const items = new Set([...capture.orderedItems, ...capture.partials.keys(), ...capture.completions.keys()]);
      setPartialTranscript([...items].map(item => capture.completions.get(item) ?? capture.partials.get(item) ?? '').map(text => text.trim()).filter(Boolean).join(' '));
    }
  }

  function finish(capture: Capture) {
    if (active.current !== capture) return;
    active.current = null;
    if (capture.listening) flush(capture, true);
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
    if (capture.channel?.readyState !== 'open' || capture.turnStartedAt === undefined) return;
    const id = `commit_${++capture.nextCommit}`;
    try {
      capture.channel.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: id }));
      capture.pendingCommits.add(id);
      capture.turnStartedAt = undefined;
      capture.lastSpeechAt = undefined;
      capture.speechMs = 0;
    } catch {
      fail(capture, 'Could not finalize live transcription.');
    }
  }

  function markDeltaSpeech(capture: Capture) {
    if (capture.stop || capture.pendingCommits.size) return;
    for (const [item, text] of capture.partials) {
      if (text.trim() && !capture.committedItems.has(item)) {
        const now = performance.now();
        capture.turnStartedAt ??= now;
        capture.lastSpeechAt ??= now;
        // Recognized words provide a speech signal even for very quiet microphones.
        capture.speechMs = Math.max(MIN_SPEECH_MS, capture.speechMs);
        break;
      }
    }
  }

  function settleDrain(capture: Capture) {
    if (capture.stop && !capture.pendingCommits.size && !capture.orderedItems.length) finish(capture);
  }

  function receive(capture: Capture, message: MessageEvent) {
    if (active.current !== capture || typeof message.data !== 'string') return;
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    const item = event?.item_id;
    switch (event?.type) {
      case 'input_audio_buffer.committed': {
        if (typeof item !== 'string' || capture.committedItems.has(item)) return;
        const first = capture.pendingCommits.values().next().value;
        if (first) capture.pendingCommits.delete(first);
        capture.committedItems.add(item);
        capture.orderedItems.push(item);
        markDeltaSpeech(capture);
        break;
      }
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof item !== 'string' || typeof event.delta !== 'string' || capture.flushedItems.has(item)) return;
        capture.partials.set(item, (capture.partials.get(item) ?? '') + event.delta);
        markDeltaSpeech(capture);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof item !== 'string' || typeof event.transcript !== 'string' || capture.flushedItems.has(item)) return;
        capture.completions.set(item, event.transcript);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        if (typeof item !== 'string' || capture.flushedItems.has(item)) return;
        capture.completions.set(item, capture.partials.get(item) ?? '');
        callbacks.current.onError?.('Part of the live audio could not be transcribed.');
        break;
      case 'error': {
        const id = event.error?.event_id;
        if (event.error?.code === 'input_audio_buffer_commit_empty' && capture.pendingCommits.delete(id)) {
          markDeltaSpeech(capture);
          break;
        }
        fail(capture, 'Live transcription reported a connection error.');
        return;
      }
      default: return;
    }
    flush(capture);
    settleDrain(capture);
  }

  async function startListening() {
    if (active.current) return false;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined' || typeof AudioContext === 'undefined') {
      callbacks.current.onError?.('Live transcription needs microphone and WebRTC support in a secure browser.');
      return false;
    }
    const capture: Capture = {
      controller: new AbortController(), listening: false, speechMs: 0, nextCommit: 0,
      pendingCommits: new Set(), orderedItems: [], committedItems: new Set(), flushedItems: new Set(),
      partials: new Map(), completions: new Map(),
    };
    active.current = capture;
    setIsConnecting(true);
    const signal = capture.controller.signal;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); return false; }
      capture.stream = stream;
      const peer = capture.peer = new RTCPeerConnection();
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const channel = capture.channel = peer.createDataChannel('oai-events');
      channel.addEventListener('message', event => receive(capture, event));
      const disconnected = () => fail(capture, 'Live transcription disconnected.');
      channel.addEventListener('error', disconnected);
      channel.addEventListener('close', disconnected);
      peer.addEventListener('connectionstatechange', () => {
        if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) disconnected();
      });
      await peer.setLocalDescription(await peer.createOffer());
      await waitUntil(peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete', signal, 2000);
      if (signal.aborted) return false;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('Missing WebRTC offer');
      const answer = await createRealtimeSession(sdp, signal);
      if (signal.aborted) return false;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
      if (!await waitUntil(channel, 'open', () => channel.readyState === 'open', signal, 8000)) {
        if (!signal.aborted) fail(capture, 'Live transcription took too long to connect.');
        return false;
      }

      const context = capture.context = new AudioContext();
      const analyser = context.createAnalyser();
      capture.source = context.createMediaStreamSource(stream);
      capture.source.connect(analyser);
      await context.resume();
      if (signal.aborted) return false;
      const samples = new Float32Array(analyser.fftSize);
      capture.vad = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const now = performance.now();
        if (Math.sqrt(sum / samples.length) >= RMS_THRESHOLD) {
          capture.turnStartedAt ??= now;
          capture.lastSpeechAt = now;
          capture.speechMs += VAD_POLL_MS;
        }
        if (capture.turnStartedAt !== undefined && (
          now - capture.turnStartedAt >= MAX_TURN_MS ||
          (capture.speechMs >= MIN_SPEECH_MS && now - (capture.lastSpeechAt ?? now) >= PAUSE_MS)
        )) commit(capture);
      }, VAD_POLL_MS);
      capture.listening = true;
      setIsConnecting(false);
      setIsListening(true);
      return true;
    } catch (error) {
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      fail(capture, denied ? 'Microphone access was denied.' : 'Could not start live transcription.');
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
