import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFactChecker } from '@/hooks/useFactChecker';
import { localClear, localGetFacts, localGetSessions } from '@/services/storage';
const reply = (id: string) => ({ ok: true, status: 200, json: async () => ({ id, claim: 'Full claim.', verdict: 'false', confidence: 90, timestamp: new Date().toISOString(), sources: [] }) });
beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) });
  localClear();
});
afterEach(() => { localClear(); vi.unstubAllGlobals(); });
describe('real hook/API/storage integration', () => {
  it('replaces partial results and reloads a complete transcript mapped to the final fact', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply('partial')).mockResolvedValue(reply('completed'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    await act(async () => { result.current.processText('The earth is'); });
    expect(localGetFacts().map(f => f.id)).toEqual(['partial']);
    await act(async () => { result.current.processText('flat.'); });
    await act(async () => { await result.current.stopMonitoring(); });
    expect(localGetFacts().map(f => f.id)).toEqual(['completed']);
    const session = localGetSessions()[0];
    expect(session.transcript).toBe('The earth is flat.'); expect(session.chunks).toHaveLength(2);
    expect(session.claimsChecked).toBe(1); expect(session.endedAt).toBeInstanceOf(Date);
    expect(session.segments?.[0]).toMatchObject({ status: 'checked', factId: 'completed', revision: 2, final: true });
    expect(localGetFacts()[0]).toMatchObject({ sessionId: session.id, segmentId: session.segments![0].id, revision: 2 });
    const payload = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(payload).toEqual({ claim: 'The earth is flat.', context: 'The earth is flat.' });
  });
  it('persists nonclaims and errors without making up a verdict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ noClaim: true }) }).mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Unavailable' }) }));
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    await act(async () => { result.current.processText('Welcome everyone. The earth'); });
    await act(async () => { result.current.processText('is flat.'); });
    await act(async () => { await result.current.stopMonitoring(); });
    expect(localGetFacts()).toHaveLength(0);
    expect(localGetSessions()[0].transcript).toBe('Welcome everyone. The earth is flat.');
    expect(localGetSessions()[0].segments).toHaveLength(2);
    expect(localGetSessions()[0].segments!.every(s => s.status === 'error')).toBe(true);
  });
});
