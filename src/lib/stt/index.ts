import { MaiStreamingAdapter } from './maiStreamingAdapter';
import { OpenAIRealtimeAdapter } from './openaiRealtimeAdapter';
import type { SttProviderId, SttTransportAdapter } from './types';

export { STT_PROVIDERS } from './types';
export type { SttProviderId, SttProviderOption, SttTransportAdapter, SttTransportCallbacks } from './types';
export { MaiStreamingAdapter, encodePcm16Base64 } from './maiStreamingAdapter';
export { OpenAIRealtimeAdapter } from './openaiRealtimeAdapter';
export { PauseVad } from './vad';
export { TurnQueue } from './turnQueue';

export function createSttAdapter(provider: SttProviderId): SttTransportAdapter {
  if (provider === 'mai-streaming') return new MaiStreamingAdapter();
  return new OpenAIRealtimeAdapter();
}
