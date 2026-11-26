import { TurnQueue } from './turnQueue';
import { SttUserError, type SttTransportAdapter, type SttTransportCallbacks } from './types';

const TARGET_RATE = 16_000;
const FRAME_SAMPLES = 1600; // 100 ms of 16 kHz mono PCM16 (3200 bytes)
const CONNECT_TIMEOUT_MS = 15_000;
const ROLLOVER_FORCE_SWAP_MS = 15_000;
const DRAIN_OLD_SOCKET_MS = 8_000;
const MAX_BUFFERED_FRAMES = 24;

interface SocketSlot {
  id: number;
  prefix: string;
  ws: WebSocket;
  ready: boolean;
  draining: boolean;
  drainTimer?: ReturnType<typeof setTimeout>;
}

export function encodePcm16Base64(samples: Int16Array): string {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function defaultWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/realtime/mai-ws`;
}

export class MaiStreamingAdapter implements SttTransportAdapter {
  readonly id = 'mai-streaming' as const;
  private queue?: TurnQueue;
  private callbacks?: SttTransportCallbacks;
  private signal?: AbortSignal;
  private activeSlot?: SocketSlot;
  private standbySlot?: SocketSlot;
  private drainingSlots = new Set<SocketSlot>();
  private forceSwapTimer?: ReturnType<typeof setTimeout>;
  private bufferedFrames: string[] = [];
  private nextSlotId = 0;
  private closed = false;
  private stopping = false;
  private rolloverInFlight = false;
  private audioSentOnActive = false;

  // Audio capture + drift-free integer resampler state
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private samples: number[] = [];
  private sum = 0;
  private count = 0;
  private phase = 0;

  constructor(private readonly getWsUrl: () => string = defaultWsUrl) {}

  async connect(stream: MediaStream, signal: AbortSignal, callbacks: SttTransportCallbacks): Promise<void> {
    if (typeof WebSocket === 'undefined' || typeof AudioContext === 'undefined') {
      throw new SttUserError('Live transcription needs microphone and WebSocket support in this browser.');
    }
    this.signal = signal;
    this.callbacks = callbacks;
    this.queue = new TurnQueue({
      onPartial: callbacks.onPartial,
      onTurn: callbacks.onTurn,
      onSpeechDetected: callbacks.onSpeechDetected,
      onDrained: callbacks.onDrained,
    });

    const slot = await this.openSocket(signal);
    if (signal.aborted || this.closed) {
      this.closeSlot(slot);
      return;
    }
    this.activeSlot = slot;
    await this.startAudioCapture(stream, signal);
  }

  private async startAudioCapture(stream: MediaStream, signal: AbortSignal): Promise<void> {
    const context = this.context = new AudioContext({ sampleRate: TARGET_RATE });
    const source = this.source = context.createMediaStreamSource(stream);
    const processor = this.processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = event => {
      if (this.closed || this.stopping) return;
      const input = event.inputBuffer.getChannelData(0);
      const inputRate = context.sampleRate;
      for (const value of input) {
        this.sum += value;
        this.count++;
        this.phase += TARGET_RATE;
        if (this.phase < inputRate) continue;
        this.phase -= inputRate;
        const sample = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.samples.push(Math.round(sample * (sample < 0 ? 32768 : 32767)));
        if (this.samples.length === FRAME_SAMPLES) {
          const frame = encodePcm16Base64(Int16Array.from(this.samples));
          this.samples = [];
          this.sendAudioFrame(frame);
        }
      }
    };
    source.connect(processor);
    processor.connect(context.destination);
    await context.resume();
    if (signal.aborted || this.closed) {
      this.stopAudioNodes();
    }
  }

  private stopAudioNodes(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = undefined;
    }
    this.source?.disconnect();
    this.source = undefined;
    if (this.context && this.context.state !== 'closed') {
      void this.context.close().catch(() => {});
    }
    this.context = undefined;
  }

  private sendAudioFrame(base64: string): void {
    const slot = this.activeSlot;
    if (slot && slot.ready && slot.ws.readyState === WebSocket.OPEN) {
      slot.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
      this.audioSentOnActive = true;
    } else if (this.bufferedFrames.length < MAX_BUFFERED_FRAMES) {
      this.bufferedFrames.push(base64);
    }
  }

  private flushBufferedFrames(): void {
    const slot = this.activeSlot;
    if (!slot || !slot.ready || slot.ws.readyState !== WebSocket.OPEN) return;
    while (this.bufferedFrames.length) {
      const frame = this.bufferedFrames.shift()!;
      slot.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: frame }));
      this.audioSentOnActive = true;
    }
  }

  private openSocket(signal: AbortSignal): Promise<SocketSlot> {
    const id = ++this.nextSlotId;
    const prefix = `s${id}:`;
    const ws = new WebSocket(this.getWsUrl());
    const slot: SocketSlot = { id, prefix, ws, ready: false, draining: false };

    return new Promise<SocketSlot>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.closeSlot(slot);
        reject(new SttUserError(message));
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(slot);
      };
      const onAbort = () => fail('Live transcription cancelled.');
      const timer = setTimeout(() => fail('Live transcription took too long to connect.'), CONNECT_TIMEOUT_MS);
      signal.addEventListener('abort', onAbort, { once: true });

      ws.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        let parsed;
        try { parsed = JSON.parse(event.data); } catch { return; }
        if (!slot.ready && parsed?.type === 'proxy.ready') {
          slot.ready = true;
          succeed();
          return;
        }
        if (!slot.ready && parsed?.type === 'error') {
          fail('Could not start live transcription.');
          return;
        }
        this.receive(slot, parsed);
      });

      ws.addEventListener('error', () => {
        if (!settled) {
          fail('Could not start live transcription.');
        } else if (!this.closed && slot === this.activeSlot) {
          this.callbacks?.onFatalError('Live transcription disconnected.');
        } else if (slot === this.standbySlot) {
          this.standbySlot = undefined;
          this.rolloverInFlight = false;
          clearTimeout(this.forceSwapTimer);
        }
      });

      ws.addEventListener('close', () => {
        if (!settled) {
          fail('Live transcription disconnected.');
          return;
        }
        if (slot.draining) {
          clearTimeout(slot.drainTimer);
          this.drainingSlots.delete(slot);
          this.queue?.dropPendingCommitsForPrefix(slot.prefix);
          return;
        }
        if (slot === this.standbySlot) {
          this.standbySlot = undefined;
          this.rolloverInFlight = false;
          clearTimeout(this.forceSwapTimer);
          return;
        }
        if (!this.closed && slot === this.activeSlot) {
          this.callbacks?.onFatalError('Live transcription disconnected.');
        }
      });
    });
  }

  private receive(slot: SocketSlot, event: Record<string, unknown>): void {
    if (this.closed || !this.queue || !this.callbacks) return;
    if (event?.type === 'proxy.rollover') {
      if (slot === this.activeSlot && !this.stopping) {
        void this.beginRollover();
      }
      return;
    }

    const rawItem = typeof event?.item_id === 'string' ? event.item_id : undefined;
    const item = rawItem ? `${slot.prefix}${rawItem}` : undefined;
    switch (event?.type) {
      case 'input_audio_buffer.committed':
        if (item) this.queue.handleCommitted(item, slot.prefix);
        break;
      case 'conversation.item.input_audio_transcription.intermediate':
        if (item && typeof event.intermediate === 'string') this.queue.handleIntermediate(item, event.intermediate);
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (item && typeof event.delta === 'string') this.queue.handleDelta(item, event.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (item && typeof event.transcript === 'string') this.queue.handleCompleted(item, event.transcript);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        if (item) {
          this.queue.handleFailed(item);
          this.callbacks.onItemError('Part of the live audio could not be transcribed.');
        }
        break;
      case 'error': {
        const err = event.error as { code?: string; event_id?: string } | undefined;
        if (err?.code === 'input_audio_buffer_commit_empty' && this.queue.handleCommitEmpty(err.event_id)) {
          break;
        }
        if (slot === this.activeSlot) {
          this.callbacks.onFatalError('Live transcription reported a connection error.');
        }
        break;
      }
      default:
        break;
    }

    if (slot.draining && !this.queue.hasPendingForPrefix(slot.prefix)) {
      this.closeSlot(slot);
    }
  }

  private async beginRollover(): Promise<void> {
    if (this.rolloverInFlight || this.stopping || this.closed || !this.signal) return;
    this.rolloverInFlight = true;
    try {
      const next = await this.openSocket(this.signal);
      if (this.closed || this.stopping) {
        this.closeSlot(next);
        return;
      }
      this.standbySlot = next;
      if (!this.audioSentOnActive) {
        this.swapToStandby(false);
      } else {
        this.forceSwapTimer = setTimeout(() => {
          this.swapToStandby(true);
        }, ROLLOVER_FORCE_SWAP_MS);
      }
    } catch {
      this.rolloverInFlight = false;
    }
  }

  private swapToStandby(commitOld: boolean): void {
    const oldSlot = this.activeSlot;
    const nextSlot = this.standbySlot;
    if (!nextSlot || this.closed) return;
    clearTimeout(this.forceSwapTimer);
    this.forceSwapTimer = undefined;
    this.standbySlot = undefined;
    this.rolloverInFlight = false;

    if (oldSlot && commitOld && this.audioSentOnActive && oldSlot.ws.readyState === WebSocket.OPEN && this.queue) {
      const id = this.queue.registerCommit(oldSlot.prefix);
      try {
        oldSlot.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: id }));
      } catch {
        // Ignore commit send failure on closing old socket; new socket takes over cleanly.
      }
    }

    this.activeSlot = nextSlot;
    this.audioSentOnActive = false;
    this.flushBufferedFrames();

    if (oldSlot) {
      oldSlot.draining = true;
      this.drainingSlots.add(oldSlot);
      if (!this.queue?.hasPendingForPrefix(oldSlot.prefix)) {
        this.closeSlot(oldSlot);
      } else {
        oldSlot.drainTimer = setTimeout(() => this.closeSlot(oldSlot), DRAIN_OLD_SOCKET_MS);
      }
    }
  }

  private closeSlot(slot: SocketSlot): void {
    clearTimeout(slot.drainTimer);
    slot.drainTimer = undefined;
    slot.draining = true;
    this.drainingSlots.delete(slot);
    if (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING) {
      try { slot.ws.close(); } catch { /* ignore */ }
    }
  }

  commit(): void {
    if (this.closed || !this.activeSlot || !this.queue || !this.callbacks) return;
    if (this.samples.length > 0) {
      const frame = encodePcm16Base64(Int16Array.from(this.samples));
      this.samples = [];
      this.sendAudioFrame(frame);
    }
    if (this.standbySlot && !this.stopping) {
      this.swapToStandby(true);
      return;
    }
    if (!this.audioSentOnActive || this.activeSlot.ws.readyState !== WebSocket.OPEN) return;
    const id = this.queue.registerCommit(this.activeSlot.prefix);
    try {
      this.activeSlot.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: id }));
      this.audioSentOnActive = false;
    } catch {
      this.callbacks.onFatalError('Could not finalize live transcription.');
    }
  }

  stopInput(): void {
    this.stopping = true;
    this.stopAudioNodes();
    if (this.samples.length > 0) {
      const frame = encodePcm16Base64(Int16Array.from(this.samples));
      this.samples = [];
      this.sendAudioFrame(frame);
    }
    clearTimeout(this.forceSwapTimer);
    if (this.standbySlot) {
      this.closeSlot(this.standbySlot);
      this.standbySlot = undefined;
    }
  }

  isIdle(): boolean {
    return this.queue?.isIdle() ?? true;
  }

  flushRemaining(): void {
    this.queue?.flush(true);
  }

  close(): void {
    this.closed = true;
    this.stopping = true;
    clearTimeout(this.forceSwapTimer);
    this.stopAudioNodes();
    this.bufferedFrames.length = 0;
    if (this.activeSlot) {
      this.closeSlot(this.activeSlot);
      this.activeSlot = undefined;
    }
    if (this.standbySlot) {
      this.closeSlot(this.standbySlot);
      this.standbySlot = undefined;
    }
    for (const slot of [...this.drainingSlots]) {
      this.closeSlot(slot);
    }
    this.drainingSlots.clear();
  }
}
