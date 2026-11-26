import { createRealtimeSession } from '@/services/api';
import { TurnQueue } from './turnQueue';
import { SttUserError, type SttTransportAdapter, type SttTransportCallbacks } from './types';

function waitUntil(
  target: EventTarget,
  event: string,
  ready: () => boolean,
  signal: AbortSignal,
  timeoutMs: number,
) {
  return new Promise<boolean>(resolve => {
    if (ready() || signal.aborted) {
      resolve(!signal.aborted);
      return;
    }
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

export class OpenAIRealtimeAdapter implements SttTransportAdapter {
  readonly id = 'openai-realtime' as const;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private queue?: TurnQueue;
  private callbacks?: SttTransportCallbacks;
  private closed = false;

  async connect(stream: MediaStream, signal: AbortSignal, callbacks: SttTransportCallbacks): Promise<void> {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new SttUserError('Live transcription needs microphone and WebRTC support in a secure browser.');
    }
    this.callbacks = callbacks;
    this.queue = new TurnQueue({
      onPartial: callbacks.onPartial,
      onTurn: callbacks.onTurn,
      onSpeechDetected: callbacks.onSpeechDetected,
      onDrained: callbacks.onDrained,
    });

    const peer = this.peer = new RTCPeerConnection();
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const channel = this.channel = peer.createDataChannel('oai-events');
    channel.addEventListener('message', event => this.receive(event));
    const disconnected = () => {
      if (!this.closed) callbacks.onFatalError('Live transcription disconnected.');
    };
    channel.addEventListener('error', disconnected);
    channel.addEventListener('close', disconnected);
    peer.addEventListener('connectionstatechange', () => {
      if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) disconnected();
    });

    await peer.setLocalDescription(await peer.createOffer());
    await waitUntil(peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete', signal, 2000);
    if (signal.aborted) return;
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error('Missing WebRTC offer');
    const answer = await createRealtimeSession(sdp, signal);
    if (signal.aborted) return;
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    if (!await waitUntil(channel, 'open', () => channel.readyState === 'open', signal, 8000)) {
      if (!signal.aborted) throw new SttUserError('Live transcription took too long to connect.');
    }
  }

  private receive(message: MessageEvent): void {
    if (this.closed || !this.queue || !this.callbacks || typeof message.data !== 'string') return;
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    const item = event?.item_id;
    switch (event?.type) {
      case 'input_audio_buffer.committed':
        if (typeof item === 'string') this.queue.handleCommitted(item);
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof item === 'string' && typeof event.delta === 'string') this.queue.handleDelta(item, event.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof item === 'string' && typeof event.transcript === 'string') this.queue.handleCompleted(item, event.transcript);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        if (typeof item === 'string') {
          this.queue.handleFailed(item);
          this.callbacks.onItemError('Part of the live audio could not be transcribed.');
        }
        break;
      case 'error':
        if (event.error?.code === 'input_audio_buffer_commit_empty' && this.queue.handleCommitEmpty(event.error?.event_id)) {
          break;
        }
        this.callbacks.onFatalError('Live transcription reported a connection error.');
        break;
      default:
        break;
    }
  }

  commit(): void {
    if (this.closed || this.channel?.readyState !== 'open' || !this.queue || !this.callbacks) return;
    const id = this.queue.registerCommit();
    try {
      this.channel.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: id }));
    } catch {
      this.callbacks.onFatalError('Could not finalize live transcription.');
    }
  }

  stopInput(): void {
    // WebRTC stops sending audio as soon as the microphone tracks stop.
  }

  isIdle(): boolean {
    return this.queue?.isIdle() ?? true;
  }

  flushRemaining(): void {
    this.queue?.flush(true);
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.peer?.close();
    this.channel = undefined;
    this.peer = undefined;
  }
}
