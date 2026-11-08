import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWav, useMaiSTT } from '@/hooks/useMaiSTT';

const processors: Array<{ onaudioprocess: ((event: unknown) => void) | null; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
const stop = vi.fn();
const close = vi.fn(async () => {});
const stream = { getTracks: () => [{ stop }] };
class FakeAudioContext {
  sampleRate = 16000; state = 'running'; destination = {};
  close = close; resume = vi.fn(async () => {});
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createScriptProcessor() { const node = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() }; processors.push(node); return node; }
}
const audio = (count = 96000) => processors[processors.length - 1]!.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(count).fill(0.1) } });
const response = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  processors.length = 0; vi.clearAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
});
afterEach(() => vi.unstubAllGlobals());
describe('MAI chunk capture', () => {
  it('encodes a six-second WAV below the request limit', async () => {
    const blob = encodeWav(new Int16Array(96000));
    expect(blob.type).toBe('audio/wav'); expect(blob.size).toBe(192044); expect(blob.size).toBeLessThan(3_000_000);
    const bytes = await new Promise<ArrayBuffer>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob); });
    const header = new DataView(bytes);
    expect(header.getUint32(24, true)).toBe(16000); expect(header.getUint16(22, true)).toBe(1);
    expect(header.getUint32(40, true)).toBe(192000);
  });
  it('uses one request at a time and flushes the last incomplete sentence on stop', async () => {
    const first = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(response('is blue'));
    vi.stubGlobal('fetch', fetchMock);
    const onTranscript = vi.fn(); const onStopped = vi.fn(); const onChunk = vi.fn();
    const { result } = renderHook(() => useMaiSTT({ onTranscript, onStopped, onChunk }));
    await act(async () => { await result.current.startListening(); });
    act(() => { audio(); audio(1000); });
    let stopping!: Promise<void>;
    act(() => { stopping = result.current.stopListening(); });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalled();
    await act(async () => { first.resolve(response('A complete sentence. The sky')); await stopping; });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe('/api/transcribe');
      expect(options.headers['Content-Type']).toBe('application/octet-stream');
      expect(options.body).toBeInstanceOf(Blob);
      expect(options.body.type).toBe('audio/wav');
    }
    expect(onTranscript.mock.calls.map(([text]) => text)).toEqual(['A complete sentence.', 'The sky is blue']);
    expect(onChunk.mock.calls.map(([text]) => text)).toEqual(['A complete sentence. The sky', 'is blue']);
    expect(onStopped).toHaveBeenCalledTimes(1); expect(result.current.isFinishing).toBe(false);
  });
  it('bounds backlog and stops recording when requests cannot keep up', async () => {
    const first = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(response('Next.'));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    const { result } = renderHook(() => useMaiSTT({ onTranscript: vi.fn(), onError }));
    await act(async () => { await result.current.startListening(); });
    act(() => { for (let i = 0; i < 12; i++) audio(); });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(result.current.isListening).toBe(false); expect(onError).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(response('First.')); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('aborts on unmount and ignores a late transcription result', async () => {
    const first = deferred<ReturnType<typeof response>>(); vi.stubGlobal('fetch', vi.fn(() => first.promise));
    const onTranscript = vi.fn(); const { result, unmount } = renderHook(() => useMaiSTT({ onTranscript }));
    await act(async () => { await result.current.startListening(); }); act(() => audio());
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal;
    unmount(); expect(signal?.aborted).toBe(true); expect(stop).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
    await act(async () => { first.resolve(response('Must not appear.')); });
    expect(onTranscript).not.toHaveBeenCalled();
  });
  it('cleans up a microphone granted after stop and allows a new session', async () => {
    const pending = deferred<typeof stream>();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(pending.promise as unknown as Promise<MediaStream>);
    const { result } = renderHook(() => useMaiSTT({ onTranscript: vi.fn() }));
    let starting!: Promise<boolean>;
    act(() => { starting = result.current.startListening(); });
    await act(async () => { await result.current.stopListening(); });
    await act(async () => { pending.resolve(stream); expect(await starting).toBe(false); });
    expect(stop).toHaveBeenCalled(); expect(processors).toHaveLength(0);
    await act(async () => { expect(await result.current.startListening()).toBe(true); });
    expect(result.current.isListening).toBe(true);
  });
});
