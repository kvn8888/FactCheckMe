import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtimeSTT } from '@/hooks/useRealtimeSTT';
import { useFactChecker } from '@/hooks/useFactChecker';
import { localClear, localGetFacts, localGetSessions } from '@/services/storage';

const offer = 'v=0\r\ns=offer\r\n';
const answer = 'v=0\r\ns=answer\r\n';
const stopTrack = vi.fn();
const closeAudio = vi.fn().mockResolvedValue(undefined);
const disconnectAudio = vi.fn();
const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
const track = { stop: stopTrack };
const getUserMedia = vi.fn();
const fetchMock = vi.fn();
let level: number;
let peer: FakePeer;
let gatheringState: RTCIceGatheringState;

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); });
  receive(event: object) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })); }
  open() { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
}

class FakePeer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  iceGatheringState = gatheringState;
  localDescription?: { type: string; sdp: string };
  channel = new FakeChannel();
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  close = vi.fn(() => { this.connectionState = 'closed'; this.dispatchEvent(new Event('connectionstatechange')); });
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: offer }));
  setLocalDescription = vi.fn(async (sdp) => { this.localDescription = sdp; });
  setRemoteDescription = vi.fn(async () => this.channel.open());
}

class FakeAudioContext {
  state = 'running';
  close = closeAudio;
  resume = vi.fn().mockResolvedValue(undefined);
  createAnalyser() {
    return { fftSize: 8, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level) };
  }
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: disconnectAudio }; }
}

const ack = (item_id: string) => peer.channel.receive({ type: 'input_audio_buffer.committed', item_id });
const delta = (item_id: string, delta: string) => peer.channel.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id, delta });
const complete = (item_id: string, transcript: string) => peer.channel.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const sessionResponse = () => Response.json({ sdp: answer });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.stubGlobal('RTCPeerConnection', function () { return peer = new FakePeer(); });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  fetchMock.mockReset().mockImplementation(async () => sessionResponse());
  getUserMedia.mockReset().mockResolvedValue(stream);
  gatheringState = 'complete';
  level = 0;
  localClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live WebRTC transcription', () => {
  it('exchanges the local SDP over the owner API and streams deltas before committing audio', async () => {
    gatheringState = 'gathering';
    const onTurn = vi.fn();
    const { result } = renderHook(() => useRealtimeSTT({ onTurn }));
    let starting!: Promise<boolean>;
    await act(async () => { starting = result.current.startListening(); });
    expect(result.current.isConnecting).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(2000);
    expect(await starting).toBe(true);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(peer.addTrack).toHaveBeenCalledWith(track, stream);
    expect(peer.createDataChannel).toHaveBeenCalledWith('oai-events');
    expect(fetchMock).toHaveBeenCalledWith('/api/realtime/session', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer, credentials: 'same-origin',
    }));
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: answer });
    expect(result.current.isListening).toBe(true);
    await advance(800);
    expect(peer.channel.send).not.toHaveBeenCalled();
    act(() => { delta('a', 'Earth'); delta('a', ' orbits'); });
    expect(result.current.partialTranscript).toBe('Earth orbits');
    expect(onTurn).not.toHaveBeenCalled();
    await advance(550);
    expect(peer.channel.send).not.toHaveBeenCalled();
    await advance(50);
    expect(JSON.parse(peer.channel.send.mock.calls[0][0])).toMatchObject({ type: 'input_audio_buffer.commit' });
    act(() => { ack('a'); complete('a', 'Earth orbits the Sun'); });
    expect(onTurn).toHaveBeenCalledExactlyOnceWith('Earth orbits the Sun');
    expect(result.current.partialTranscript).toBe('');
  });

  it('commits after a speech pause or a 14-second continuous turn and flushes completions in commit order', async () => {
    const onChunk = vi.fn();
    const { result } = renderHook(() => useRealtimeSTT({ onChunk }));
    await act(async () => { await result.current.startListening(); });
    level = 0.06;
    await advance(800);
    level = 0;
    await advance(550);
    expect(peer.channel.send).not.toHaveBeenCalled();
    await advance(50);
    act(() => { ack('first'); delta('first', 'first partial'); });
    level = 0.06;
    await advance(14_000);
    expect(peer.channel.send).toHaveBeenCalledTimes(1);
    await advance(50);
    expect(peer.channel.send).toHaveBeenCalledTimes(2);
    act(() => { complete('second', 'second final'); ack('second'); });
    expect(onChunk).not.toHaveBeenCalled();
    expect(result.current.partialTranscript).toBe('first partial second final');
    act(() => { complete('first', 'first final'); complete('second', 'ignored duplicate'); });
    expect(onChunk.mock.calls).toEqual([['first final'], ['second final']]);
    expect(result.current.partialTranscript).toBe('');
  });

  it('stops capture immediately, sends one final commit and waits for its completion', async () => {
    const onTurn = vi.fn();
    const onStopped = vi.fn();
    const { result } = renderHook(() => useRealtimeSTT({ onTurn, onStopped }));
    await act(async () => { await result.current.startListening(); });
    level = 0.06;
    await advance(150);
    let stopping!: Promise<void>;
    act(() => {
      stopping = result.current.stopListening();
      expect(result.current.stopListening()).toBe(stopping);
    });
    expect(result.current).toMatchObject({ isListening: false, isFinishing: true });
    expect(peer.channel.send).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(closeAudio).toHaveBeenCalledTimes(1);
    expect(peer.close).not.toHaveBeenCalled();
    act(() => { ack('a'); delta('a', 'last'); });
    expect(onStopped).not.toHaveBeenCalled();
    await act(async () => { complete('a', 'last thought'); await stopping; });
    expect(onTurn).toHaveBeenCalledExactlyOnceWith('last thought');
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(result.current.isFinishing).toBe(false);
  });

  it('recovers remaining captions in order at the drain deadline', async () => {
    const onTurn = vi.fn();
    const onStopped = vi.fn();
    const { result } = renderHook(() => useRealtimeSTT({ onTurn, onStopped }));
    await act(async () => { await result.current.startListening(); });
    act(() => delta('a', 'first partial'));
    await advance(600);
    act(() => { ack('a'); delta('b', 'second partial'); });
    act(() => { void result.current.stopListening(); });
    act(() => { ack('b'); complete('b', 'second final'); });
    await advance(7999);
    expect(onTurn).not.toHaveBeenCalled();
    await advance(1);
    expect(onTurn.mock.calls).toEqual([['first partial'], ['second final']]);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(peer.channel.close).toHaveBeenCalledTimes(1);
  });

  it('recovers an item failure, then closes and emits the last partial on peer disconnect', async () => {
    const onTurn = vi.fn();
    const onError = vi.fn();
    const onStopped = vi.fn();
    const { result } = renderHook(() => useRealtimeSTT({ onTurn, onError, onStopped }));
    await act(async () => { await result.current.startListening(); });
    act(() => delta('a', 'recovered'));
    await advance(600);
    act(() => {
      ack('a');
      peer.channel.receive({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'a', error: { message: 'private upstream details' } });
      delta('b', 'last partial');
      peer.connectionState = 'disconnected';
      peer.dispatchEvent(new Event('connectionstatechange'));
    });
    expect(onTurn.mock.calls).toEqual([['recovered'], ['last partial']]);
    expect(onError.mock.calls).toEqual([['Part of the live audio could not be transcribed.'], ['Live transcription disconnected.']]);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(disconnectAudio).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ isListening: false, isFinishing: false, partialTranscript: '' });
  });

  it('cleans up and hides broker error details and cancels an in-flight exchange on unmount', async () => {
    const onError = vi.fn();
    fetchMock.mockRejectedValueOnce(new Error('private error'));
    const { result, unmount } = renderHook(() => useRealtimeSTT({ onError }));
    await act(async () => { expect(await result.current.startListening()).toBe(false); });
    expect(onError).toHaveBeenCalledExactlyOnceWith('Could not start live transcription.');
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { void result.current.startListening(); });
    const signal = fetchMock.mock.calls[1][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(2);
  });
});

describe('live turns through fact-checking and browser history', () => {
  it('merges a continuation that arrived during the gate call and checks a held EOF fragment once', async () => {
    const first = 'Earth orbits the';
    const held = 'That journey takes';
    const inputs: { claim: string; requireComplete?: boolean }[] = [];
    let resolveGate!: (response: Response) => void;
    fetchMock.mockImplementation(async (_path, init) => {
      const input = JSON.parse(init.body);
      inputs.push(input);
      if (input.claim === first) return new Promise<Response>(resolve => { resolveGate = resolve; });
      if (input.claim === held && input.requireComplete) return Response.json({ incomplete: true });
      return Response.json({ noClaim: true });
    });
    const { result } = renderHook(() => useFactChecker());
    const turn = (text: string) => result.current.processText(text, { source: 'turn' });
    await act(async () => { await result.current.startMonitoring(); turn(first); turn('Sun'); });
    expect(inputs.map(input => input.claim)).toEqual([first]);
    await act(async () => { resolveGate(Response.json({ incomplete: true })); });
    expect(result.current.segments).toMatchObject([{ id: 'span-0', text: 'Earth orbits the Sun', revision: 2, status: 'no-claim', final: true }]);
    await act(async () => { turn(held); });
    expect(result.current.segments[1]).toMatchObject({ text: held, final: false, status: 'pending' });
    await act(async () => { await result.current.stopMonitoring(); });
    expect(inputs.map(({ claim, requireComplete }) => [claim, requireComplete])).toEqual([
      [first, true], ['Earth orbits the Sun', true], [held, true], [held, undefined],
    ]);
    expect(result.current.segments[1]).toMatchObject({ text: held, final: true, status: 'no-claim', revision: 2 });
  });

  it('settles complete turns once, merges a mid-sentence pause and respects 429 without wiping facts on stop', async () => {
    const calls: { claim: string; requireComplete?: boolean }[] = [];
    const fragment = 'That steady journey takes about 365 days, while';
    const continuation = 'the tilt of Earth’s axis causes the seasons';
    const merged = `${fragment} ${continuation}`;
    const onError = vi.fn();
    fetchMock.mockImplementation(async (path, init) => {
      if (path === '/api/realtime/session') return sessionResponse();
      expect(path).toBe('/api/fact-check');
      const request = JSON.parse(init.body);
      calls.push(request);
      const { claim } = request;
      if (claim.endsWith('questionable coffee')) return Response.json({ noClaim: true });
      if (claim === fragment) return Response.json({ incomplete: true });
      if (claim === 'Mars has two moons') return new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } });
      return Response.json({ id: `fact-${calls.length}`, claim, verdict: 'true', confidence: 94, timestamp: new Date().toISOString(), sources: [] });
    });
    const { result } = renderHook(() => {
      const checker = useFactChecker({ onError });
      const speech = useRealtimeSTT({
        onTurn: text => checker.processText(text, { source: 'turn' }),
        onStopped: () => { void checker.stopMonitoring(); },
      });
      return { checker, speech };
    });
    await act(async () => { await result.current.checker.startMonitoring(); await result.current.speech.startListening(); });
    const turn = async (id: string, text: string) => {
      act(() => delta(id, text));
      await advance(600);
      await act(async () => { ack(id); complete(id, text); });
    };
    await turn('1', 'Welcome back and enjoy the questionable coffee');
    await turn('2', `Earth orbits the Sun. ${fragment}`);
    const before = result.current.checker.segments[2];
    expect(before).toMatchObject({ text: fragment, final: false, status: 'pending', revision: 1 });
    expect(result.current.checker.isProcessing).toBe(false);
    await turn('3', continuation);
    expect(result.current.checker.segments[2]).toMatchObject({
      id: before.id, text: merged, final: true, status: 'checked', revision: 2,
    });
    const originalFacts = localGetFacts().map(fact => fact.id);
    await turn('4', 'Mars has two moons');
    await turn('5', 'Mercury has no moons');
    expect(calls).toHaveLength(5);
    await advance(1399);
    expect(calls).toHaveLength(5);
    await advance(1);
    const beforeStop = localGetFacts().map(fact => fact.id);
    expect(beforeStop).toEqual([expect.any(String), ...originalFacts]);
    await act(async () => {
      await result.current.speech.stopListening();
      await result.current.checker.stopMonitoring();
    });
    expect(calls.map(({ claim, requireComplete }) => [claim, requireComplete])).toEqual([
      ['Welcome back and enjoy the questionable coffee', true], ['Earth orbits the Sun.', undefined],
      [fragment, true], [merged, true], ['Mars has two moons', true], ['Mercury has no moons', true],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(localGetFacts().map(fact => fact.id)).toEqual(beforeStop);
    expect(result.current.checker.results.map(fact => fact.id)).toEqual(beforeStop);
    const [session] = localGetSessions();
    expect(session).toMatchObject({ claimsChecked: 3, endedAt: expect.any(Date) });
    expect(session.chunks?.map(chunk => chunk.source)).toEqual(Array(5).fill('turn'));
    expect(session.segments?.every(segment => segment.final)).toBe(true);
  });
});
