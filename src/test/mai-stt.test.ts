import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWav, useMaiSTT } from '@/hooks/useMaiSTT';

const processors: Array<{ onaudioprocess: ((event: unknown) => void) | null; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
const stop = vi.fn();
const close = vi.fn(async () => {});
const stream = { getTracks: () => [{ stop }] };
let captureRate = 16000;
class FakeAudioContext {
  sampleRate = captureRate; state = 'running'; destination = {};
  close = close; resume = vi.fn(async () => {});
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createScriptProcessor() { const node = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() }; processors.push(node); return node; }
}
const audio = (count = 96000) => processors[processors.length - 1]!.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(count).fill(0.1) } });
const response = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  processors.length = 0; captureRate = 16000; vi.clearAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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

const readBytes = (blob: Blob) => new Promise<ArrayBuffer>(resolve => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(blob);
});

describe('synthetic audio and provider edge cases', () => {
  it.each([44100, 48000])('resamples %i Hz across irregular browser callbacks without drift', async rate => {
    captureRate = rate;
    const fetchMock = vi.fn().mockResolvedValue(response('Synthetic sample.'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMaiSTT({}));
    await act(async () => { await result.current.startListening(); });
    await act(async () => {
      let remaining = rate * 6;
      while (remaining > 0) { const count = Math.min(4096, remaining); audio(count); remaining -= count; }
    });
    await act(async () => { await result.current.stopListening(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const blob = fetchMock.mock.calls[0][1].body as Blob;
    const bytes = new DataView(await readBytes(blob));
    expect(bytes.getUint32(40, true)).toBe(96000 * 2);
    for (let offset = 44; offset < bytes.byteLength; offset += 2) expect(bytes.getInt16(offset, true)).toBe(3277);
  });

  it('encodes signed PCM extrema and little-endian WAV lengths', async () => {
    const bytes = new DataView(await readBytes(encodeWav(Int16Array.from([-32768, -1, 0, 1, 32767]))));
    expect(bytes.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(bytes.getUint16(20, true)).toBe(1);
    expect(bytes.getUint16(34, true)).toBe(16);
    expect(Array.from({ length: 5 }, (_, i) => bytes.getInt16(44 + i * 2, true))).toEqual([-32768, -1, 0, 1, 32767]);
  });

  it('correlates sequential chunks and resets the correlation ID on restart', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(''));
    vi.stubGlobal('fetch', fetchMock);
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useMaiSTT({ onTranscript }));
    await act(async () => { await result.current.startListening(); });
    await act(async () => { audio(); audio(150); await result.current.stopListening(); });
    await act(async () => { await result.current.startListening(); });
    await act(async () => { audio(150); await result.current.stopListening(); });
    const headers = fetchMock.mock.calls.map(call => call[1].headers);
    expect(headers.map(value => value['x-transcript-chunk-index'])).toEqual(['0', '1', '0']);
    expect(headers[0]['x-transcript-run-id']).toBe(headers[1]['x-transcript-run-id']);
    expect(headers[0]['x-transcript-run-id']).not.toBe(headers[2]['x-transcript-run-id']);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, status: 500, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({ text: null }) },
    { ok: true, status: 200, json: async () => { throw new Error('Invalid JSON'); } },
  ])('cleans up and can restart after a bad provider response %#', async badResponse => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(badResponse));
    const onError = vi.fn(); const onStopped = vi.fn(); const onTranscript = vi.fn();
    const { result } = renderHook(() => useMaiSTT({ onError, onStopped, onTranscript }));
    await act(async () => { await result.current.startListening(); });
    await act(async () => { audio(); });
    expect(onError).toHaveBeenCalledTimes(1); expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onTranscript).not.toHaveBeenCalled(); expect(result.current.isListening).toBe(false);
    expect(stop).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
    await act(async () => { expect(await result.current.startListening()).toBe(true); });
    await act(async () => { await result.current.stopListening(); });
  });

  it('aborts a stalled transcription after 45 seconds without committing a result', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const onError = vi.fn(); const onStopped = vi.fn();
    const { result } = renderHook(() => useMaiSTT({ onError, onStopped }));
    await act(async () => { await result.current.startListening(); });
    act(() => { audio(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(45000); });
    expect(onError).toHaveBeenCalledWith('Transcription timed out. Please restart listening.');
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(result.current.isListening).toBe(false); expect(result.current.isFinishing).toBe(false);
  });

  it('handles denied microphone permission without sending any audio', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    const { result } = renderHook(() => useMaiSTT({ onError }));
    await act(async () => { expect(await result.current.startListening()).toBe(false); });
    expect(fetchMock).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.isConnecting).toBe(false);
  });
});
