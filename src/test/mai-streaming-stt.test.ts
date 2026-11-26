import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtimeSTT } from '@/hooks/useRealtimeSTT';

const stopTrack = vi.fn();
const track = { stop: stopTrack };
const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
const getUserMedia = vi.fn();

let level = 0;
let captureRate = 48_000;
const processors: Array<{ onaudioprocess: ((event: unknown) => void) | null; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
const sockets: FakeWebSocket[] = [];

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  close = vi.fn(() => {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  });

  constructor(public readonly url: string) {
    super();
    sockets.push(this);
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  receive(event: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
  }
}

class FakeAudioContext {
  sampleRate: number;
  state = 'running';
  destination = {};
  close = vi.fn(async () => { this.state = 'closed'; });
  resume = vi.fn(async () => {});

  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ? captureRate : 48_000;
  }

  createAnalyser() {
    return { fftSize: 8, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level) };
  }

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    const node = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
    processors.push(node);
    return node;
  }
}

const feedAudio = (count: number, amplitude = 0.25) => {
  processors[processors.length - 1]?.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(count).fill(amplitude) },
  });
};

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.clearAllMocks();
  sockets.length = 0;
  processors.length = 0;
  level = 0;
  captureRate = 48_000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  getUserMedia.mockResolvedValue(stream);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MAI Streaming WebSocket adapter via useRealtimeSTT', () => {
  it('resamples 48kHz audio to 16kHz PCM16, merges delta+intermediate without flicker, and emits finalized turns', async () => {
    const onTurn = vi.fn();
    const { result } = renderHook(() => useRealtimeSTT({ provider: 'mai-streaming', onTurn }));

    let starting!: Promise<boolean>;
    await act(async () => { starting = result.current.startListening(); });
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toMatch(/\/api\/realtime\/mai-ws$/);

    await act(async () => {
      sockets[0].receive({ type: 'proxy.ready', rolloverMs: 265_000, maxDurationMs: 292_000 });
      expect(await starting).toBe(true);
    });
    expect(result.current.isListening).toBe(true);

    // 4800 samples at 48 kHz = 100 ms -> resamples to exactly 1600 samples at 16 kHz (1 frame).
    act(() => { feedAudio(4800, 0.25); });
    expect(sockets[0].sent).toHaveLength(1);
    expect(sockets[0].sent[0]).toMatchObject({ type: 'input_audio_buffer.append' });
    expect(atob(sockets[0].sent[0].audio as string)).toHaveLength(3200);

    // Verify stable delta + shrinking intermediate never duplicates words.
    act(() => {
      sockets[0].receive({ type: 'conversation.item.input_audio_transcription.intermediate', item_id: 'i1', intermediate: 'Earth orbits the Sun' });
    });
    expect(result.current.partialTranscript).toBe('Earth orbits the Sun');

    act(() => {
      sockets[0].receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Earth' });
    });
    expect(result.current.partialTranscript).toBe('Earth orbits the Sun');

    act(() => {
      sockets[0].receive({ type: 'conversation.item.input_audio_transcription.intermediate', item_id: 'i1', intermediate: ' orbits the Sun once a year.' });
    });
    expect(result.current.partialTranscript).toBe('Earth orbits the Sun once a year.');

    // Quiet-mic delta/intermediate armed pause VAD; after 600ms silence it commits.
    await advance(600);
    expect(sockets[0].sent.at(-1)).toMatchObject({ type: 'input_audio_buffer.commit' });

    act(() => {
      sockets[0].receive({ type: 'input_audio_buffer.committed', item_id: 'i1' });
      sockets[0].receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Earth orbits the Sun once a year.' });
    });
    expect(onTurn).toHaveBeenCalledExactlyOnceWith('Earth orbits the Sun once a year.');
    expect(result.current.partialTranscript).toBe('');
  });

  it('performs seamless make-before-break rollover without stopping listening or scrambling turn order', async () => {
    const onTurn = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useRealtimeSTT({ provider: 'mai-streaming', onTurn, onError }));

    let starting!: Promise<boolean>;
    await act(async () => { starting = result.current.startListening(); });
    await act(async () => {
      sockets[0].receive({ type: 'proxy.ready' });
      await starting;
    });

    // Active speech on Socket 1
    level = 0.06;
    act(() => { feedAudio(4800, 0.25); });
    await advance(800);

    // Server signals impending Hobby timeout -> adapter opens Socket 2 in background
    await act(async () => {
      sockets[0].receive({ type: 'proxy.rollover' });
    });
    expect(sockets).toHaveLength(2);

    await act(async () => {
      sockets[1].receive({ type: 'proxy.ready' });
    });
    // Still active until next speech pause
    expect(result.current.isListening).toBe(true);
    expect(sockets[0].close).not.toHaveBeenCalled();

    // Speaker pauses -> commits Socket 1 and swaps audio routing to Socket 2
    level = 0;
    await advance(600);
    expect(sockets[0].sent.at(-1)).toMatchObject({ type: 'input_audio_buffer.commit' });

    // New speech flows into Socket 2 while Socket 1 is still draining
    level = 0.06;
    act(() => { feedAudio(4800, 0.25); });
    expect(sockets[1].sent).toHaveLength(1);
    expect(sockets[1].sent[0]).toMatchObject({ type: 'input_audio_buffer.append' });

    // Socket 1 acknowledges commit, Socket 2 completes even before Socket 1 finishes -> strict order preserved
    act(() => {
      sockets[0].receive({ type: 'input_audio_buffer.committed', item_id: 'a' });
    });
    await advance(800);
    level = 0;
    await advance(600);
    act(() => {
      sockets[1].receive({ type: 'input_audio_buffer.committed', item_id: 'b' });
      sockets[1].receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Second turn on new socket.' });
    });
    expect(onTurn).not.toHaveBeenCalled();

    act(() => {
      sockets[0].receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'First turn before rollover.' });
    });
    expect(onTurn.mock.calls).toEqual([
      ['First turn before rollover.'],
      ['Second turn on new socket.'],
    ]);
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets[1].close).not.toHaveBeenCalled();
    expect(result.current.isListening).toBe(true);
    expect(onError).not.toHaveBeenCalled();

    await act(async () => { await result.current.stopListening(); });
    expect(sockets[1].close).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});
