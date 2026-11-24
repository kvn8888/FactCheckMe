import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMaiSTT } from '@/hooks/useMaiSTT';
import { useFactChecker } from '@/hooks/useFactChecker';
import { localClear, localGetStats, localGetFacts } from '@/services/storage';

// A deterministic browser pipeline, not a speech-recognition accuracy test:
// synthetic PCM -> actual WAV encoder -> fake HTTP transcription -> real
// span reconciliation -> fake fact-check HTTP -> actual local history.
let processAudio: ((event: unknown) => void) | null;
const trackStop = vi.fn();
class SyntheticAudioContext {
  sampleRate = 48000; state = 'running'; destination = {};
  resume = async () => {}; close = async () => {};
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createScriptProcessor() {
    return { set onaudioprocess(value: typeof processAudio) { processAudio = value; }, connect: vi.fn(), disconnect: vi.fn() };
  }
}
const tickAudio = (samples = 48000 * 6) => {
  // A nonspeech tone intentionally avoids microphone/OS audio and paid APIs.
  for (let offset = 0; offset < samples; offset += 4096) {
    const pcm = Float32Array.from({ length: Math.min(4096, samples - offset) }, (_, i) => 0.25 * Math.sin((offset + i) * 2 * Math.PI * 440 / 48000));
    processAudio?.({ inputBuffer: { getChannelData: () => pcm } });
  }
};
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
beforeEach(() => {
  localClear(); processAudio = null; trackStop.mockClear();
  vi.stubGlobal('AudioContext', SyntheticAudioContext);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) } });
});
afterEach(() => vi.unstubAllGlobals());

describe('synthetic live transcription integration', () => {
  it('drains ordered audio, revises a partial claim, retains nonclaims and closes mapped history', async () => {
    const scripted = ['Hello everyone. The moon is made', 'of cheese. Thank you', 'for listening'];
    const checks: Array<{ claim: string; context: string }> = [];
    let releaseStale!: (value: ReturnType<typeof ok>) => void;
    let factIndex = 0;
    const fetchMock = vi.fn((url: string, options: RequestInit) => {
      if (url === '/api/transcribe') return Promise.resolve(ok({ text: scripted.shift() }));
      if (url !== '/api/fact-check') throw new Error(`Unexpected HTTP request: ${url}`);
      const body = JSON.parse(options.body as string); checks.push(body);
      if (body.claim === 'The moon is made') return new Promise(resolve => { releaseStale = resolve; });
      return Promise.resolve(ok(body.claim.includes('cheese') ? {
        id: `fact-${++factIndex}`, claim: body.claim, verdict: 'false', confidence: 99,
        timestamp: new Date().toISOString(), explanation: 'Mock evidence fixture.',
        sources: [{ title: 'Fixture source', url: 'https://example.com/moon', domain: 'example.com' }],
      } : { noClaim: true }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => {
      const checker = useFactChecker();
      const speech = useMaiSTT({ onChunk: checker.processText });
      return { checker, speech };
    });
    await act(async () => { await result.current.checker.startMonitoring(); await result.current.speech.startListening(); });
    await act(async () => { tickAudio(); });
    expect(checks.map(check => check.claim)).toEqual(['Hello everyone.', 'The moon is made']);
    await act(async () => { tickAudio(); tickAudio(48000); });
    await act(async () => { await result.current.speech.stopListening(); });
    expect(trackStop).toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/transcribe').map(call => (call[1].body as Blob).size)).toEqual([192044, 192044, 32044]);
    let finished!: Promise<void>;
    act(() => { finished = result.current.checker.stopMonitoring(); });
    await act(async () => { releaseStale(ok({ noClaim: true })); await finished; });
    await waitFor(() => expect(result.current.checker.isProcessing).toBe(false));
    const { sessions } = localGetStats();
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.endedAt).toBeInstanceOf(Date);
    expect(session.transcript).toBe('Hello everyone. The moon is made of cheese. Thank you for listening');
    expect(session.chunks?.map(chunk => chunk.text)).toEqual(['Hello everyone. The moon is made', 'of cheese. Thank you', 'for listening']);
    expect(session.segments?.map(segment => [segment.text, segment.status, segment.final])).toEqual([
      ['Hello everyone.', 'no-claim', true], ['The moon is made of cheese.', 'checked', true], ['Thank you for listening', 'no-claim', true],
    ]);
    for (const segment of session.segments!) {
      expect(session.transcript!.slice(segment.start, segment.end)).toBe(segment.text);
      expect(segment.chunkIds).toEqual(session.chunks!.filter(chunk => chunk.start < segment.end && chunk.end > segment.start).map(chunk => chunk.id));
    }
    const facts = localGetFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ claim: 'The moon is made of cheese.', sessionId: session.id, segmentId: 'span-16', verdict: 'false' });
    expect(checks.filter(check => check.claim.includes('cheese')).slice(-1)[0]?.context).toBe(session.transcript);
    expect(result.current.checker.status).toMatchObject({ isActive: false, sentencesProcessed: 3, factsChecked: 1 });
  });
});
