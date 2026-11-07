import { useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '@/services/api';
import { consumeCompleteSentences } from '@/lib/sentences';

const RATE = 16000;
const CHUNK_SAMPLES = RATE * 6;
const MAX_QUEUE = 3;
export function encodeWav(samples: Int16Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return new Blob([buffer], { type: 'audio/wav' });
}
interface Options { onTranscript: (text: string) => void; onError?: (error: string) => void; onStopped?: () => void }
interface Capture {
  stream?: MediaStream; context?: AudioContext; source?: MediaStreamAudioSourceNode; processor?: ScriptProcessorNode;
  samples: number[]; queue: Blob[]; buffer: string; stopping: boolean; controller: AbortController; draining?: Promise<void>;
  // Fractional resampling state carries across audio callbacks.
  sum: number; count: number; phase: number;
}
function cleanup(c: Capture) {
  if (c.processor) { c.processor.onaudioprocess = null; c.processor.disconnect(); }
  c.source?.disconnect();
  if (c.context && c.context.state !== 'closed') void c.context.close().catch(() => {});
  c.stream?.getTracks().forEach(track => track.stop());
}
export function useMaiSTT(options: Options) {
  const callbacks = useRef(options); callbacks.current = options;
  const current = useRef<Capture | null>(null);
  const mounted = useRef(true);
  const [isListening, setIsListening] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [committedTranscripts, setCommittedTranscripts] = useState<string[]>([]);
  const valid = (c: Capture) => mounted.current && current.current === c && !c.controller.signal.aborted;
  const commit = (sentences: string[]) => {
    if (!sentences.length) return;
    setCommittedTranscripts(previous => [...previous, ...sentences].slice(-500));
    sentences.forEach(sentence => callbacks.current.onTranscript(sentence));
  };
  const drain = (c: Capture): Promise<void> => {
    if (c.draining) return c.draining;
    c.draining = (async () => {
      while (valid(c) && c.queue.length) {
        const audio = c.queue.shift()!;
        const timeout = setTimeout(() => c.controller.abort(), 45000);
        try {
          // Keep WAV bytes opaque to Vercel's automatic request body parser.
          const response = await authenticatedFetch('/api/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: audio, signal: c.controller.signal });
          if (!response.ok) throw new Error('Transcription failed. Please sign in again or retry.');
          const data = await response.json();
          if (!valid(c)) return;
          if (typeof data.text !== 'string') throw new Error('Invalid transcription response');
          c.buffer = [c.buffer, data.text.trim()].filter(Boolean).join(' ');
          const { sentences, remainder } = consumeCompleteSentences(c.buffer);
          c.buffer = remainder; setPartialTranscript(remainder); commit(sentences);
        } catch (error) {
          if (mounted.current && current.current === c) {
            callbacks.current.onError?.(error instanceof Error && error.name !== 'AbortError' ? error.message : 'Transcription timed out. Please restart listening.');
            c.stopping = true; c.queue = []; cleanup(c);
            commit(c.buffer.trim() ? [c.buffer.trim()] : []); c.buffer = "";
            current.current = null; setIsListening(false); setIsConnecting(false); setIsFinishing(false); setPartialTranscript("");
            callbacks.current.onStopped?.();
          }
          break;
        } finally { clearTimeout(timeout); }
      }
    })().finally(() => { c.draining = undefined; });
    return c.draining;
  };
  const finish = async (c: Capture) => {
    if (c.stopping) { await c.draining; return; }
    c.stopping = true; cleanup(c); setIsListening(false); setIsConnecting(false); setIsFinishing(true);
    if (c.samples.length) { c.queue.push(encodeWav(Int16Array.from(c.samples))); c.samples = []; }
    await drain(c);
    if (mounted.current && current.current === c) {
      if (!c.controller.signal.aborted) commit(c.buffer.trim() ? [c.buffer.trim()] : []);
      c.buffer = ''; current.current = null; setPartialTranscript(''); setIsFinishing(false);
      callbacks.current.onStopped?.();
    }
  };
  const stopListening = () => { const c = current.current; return c ? finish(c) : Promise.resolve(); };
  const startListening = async () => {
    if (current.current || !mounted.current) return false;
    const c: Capture = { samples: [], queue: [], buffer: '', stopping: false, controller: new AbortController(), sum: 0, count: 0, phase: 0 };
    current.current = c; setIsConnecting(true); setPartialTranscript(''); setCommittedTranscripts([]);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error('Microphone capture is not supported in this browser');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!valid(c) || c.stopping) { stream.getTracks().forEach(track => track.stop()); return false; }
      c.stream = stream; c.context = new AudioContext({ sampleRate: RATE });
      c.source = c.context.createMediaStreamSource(stream); c.processor = c.context.createScriptProcessor(4096, 1, 1);
      c.processor.onaudioprocess = event => {
        if (!valid(c) || c.stopping) return;
        const input = event.inputBuffer.getChannelData(0);
        const ratio = c.context!.sampleRate / RATE;
        for (const value of input) {
          c.sum += value; c.count++; c.phase++;
          if (c.phase < ratio) continue;
          c.phase -= ratio;
          const sample = Math.max(-1, Math.min(1, c.sum / c.count)); c.sum = 0; c.count = 0;
          c.samples.push(Math.round(sample * (sample < 0 ? 32768 : 32767)));
          if (c.samples.length === CHUNK_SAMPLES) {
            c.queue.push(encodeWav(Int16Array.from(c.samples))); c.samples = [];
            void drain(c);
            if (c.queue.length >= MAX_QUEUE) {
              callbacks.current.onError?.('Transcription is falling behind. Recording stopped so queued audio can finish.');
              void finish(c); return;
            }
          }
        }
      };
      c.source.connect(c.processor); c.processor.connect(c.context.destination);
      await c.context.resume();
      if (!valid(c) || c.stopping) { cleanup(c); return false; }
      setIsConnecting(false); setIsListening(true); return true;
    } catch (error) {
      cleanup(c);
      if (mounted.current && current.current === c) {
        current.current = null; setIsConnecting(false); setIsListening(false);
        callbacks.current.onError?.(error instanceof Error ? error.message : 'Could not start microphone');
      }
      return false;
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; const c = current.current; current.current = null; if (c) { c.controller.abort(); cleanup(c); c.queue = []; } };
  }, []);
  return { isListening, isConnecting, isFinishing, startListening, stopListening, partialTranscript, committedTranscripts };
}
