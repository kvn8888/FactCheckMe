import type { SharedAudioGraph } from './types';

export const VAD_POLL_MS = 50;
export const PAUSE_MS = 600;
export const MIN_SPEECH_MS = 800;
export const MAX_TURN_MS = 14_000;
export const RMS_THRESHOLD = 0.015;

export class PauseVad {
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private ownsAudioGraph = false;
  private timer?: ReturnType<typeof setInterval>;
  private speechMs = 0;
  private turnStartedAt?: number;
  private lastSpeechAt?: number;

  async start(
    stream: MediaStream,
    signal: AbortSignal,
    onCommit: () => void,
    sharedGraph?: SharedAudioGraph,
  ): Promise<boolean> {
    const context = this.context = sharedGraph?.context ?? new AudioContext();
    const analyser = context.createAnalyser();
    this.ownsAudioGraph = !sharedGraph;
    this.source = sharedGraph?.source ?? context.createMediaStreamSource(stream);
    this.source.connect(analyser);
    await context.resume();
    if (signal.aborted) {
      this.stop();
      return false;
    }
    const samples = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const now = performance.now();
      if (Math.sqrt(sum / samples.length) >= RMS_THRESHOLD) {
        this.turnStartedAt ??= now;
        this.lastSpeechAt = now;
        this.speechMs += VAD_POLL_MS;
      }
      if (this.turnStartedAt !== undefined && (
        now - this.turnStartedAt >= MAX_TURN_MS ||
        (this.speechMs >= MIN_SPEECH_MS && now - (this.lastSpeechAt ?? now) >= PAUSE_MS)
      )) {
        onCommit();
      }
    }, VAD_POLL_MS);
    return true;
  }

  hasActiveTurn(): boolean {
    return this.turnStartedAt !== undefined;
  }

  markSpeechDetected(): void {
    const now = performance.now();
    this.turnStartedAt ??= now;
    this.lastSpeechAt ??= now;
    // Recognized words provide a speech signal even for very quiet microphones.
    this.speechMs = Math.max(MIN_SPEECH_MS, this.speechMs);
  }

  resetTurn(): void {
    this.turnStartedAt = undefined;
    this.lastSpeechAt = undefined;
    this.speechMs = 0;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.ownsAudioGraph) {
      this.source?.disconnect();
      if (this.context && this.context.state !== 'closed') {
        void this.context.close().catch(() => {});
      }
    }
    this.source = undefined;
    this.context = undefined;
    this.ownsAudioGraph = false;
  }
}
