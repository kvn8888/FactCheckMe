export type SttProviderId = 'openai-realtime' | 'mai-streaming';

export interface SttProviderOption {
  id: SttProviderId;
  label: string;
  transport: string;
}

export const STT_PROVIDERS: Record<SttProviderId, SttProviderOption> = {
  'openai-realtime': {
    id: 'openai-realtime',
    label: 'OpenAI Realtime',
    transport: 'WebRTC',
  },
  'mai-streaming': {
    id: 'mai-streaming',
    label: 'MAI Streaming',
    transport: 'WebSocket',
  },
};

export interface SttTransportCallbacks {
  onPartial: (text: string) => void;
  onTurn: (text: string) => void;
  onSpeechDetected: () => void;
  onItemError: (message: string) => void;
  onFatalError: (message: string) => void;
  onDrained: () => void;
}

export class SttUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SttUserError';
  }
}

export interface SharedAudioGraph {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
}

export interface SttTransportAdapter {
  readonly id: SttProviderId;
  connect(stream: MediaStream, signal: AbortSignal, callbacks: SttTransportCallbacks): Promise<void>;
  getAudioGraph?(): SharedAudioGraph | undefined;
  commit(): void;
  stopInput(): void;
  isIdle(): boolean;
  flushRemaining(): void;
  close(): void;
}
