import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const fact = (id = 'fact') => ({ id, claim: 'Test claim', verdict: 'true' as const, confidence: 90, timestamp: new Date(), sources: [] });
beforeEach(() => {
  vi.resetModules();
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key), clear: () => entries.clear() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('browser history', () => {
  it('stores sessions and facts locally with date restoration and stats', async () => {
    const storage = await import('@/services/storage');
    const session = storage.localCreateSession();
    storage.localSaveFact(fact(), session.id);
    storage.localEndSession(session.id);
    expect(storage.localGetStats()).toMatchObject({ totalChecked: 1, trueCount: 1 });
    expect(storage.localGetStats().sessions[0]).toMatchObject({ claimsChecked: 1, endedAt: expect.any(Date) });
    expect(storage.localGetFacts()[0].timestamp).toBeInstanceOf(Date);
  });
  it('bounds retained history', async () => {
    const storage = await import('@/services/storage');
    for (let i = 0; i < 105; i++) storage.localCreateSession();
    for (let i = 0; i < 505; i++) storage.localSaveFact(fact(String(i)), null);
    expect(storage.localGetStats().sessions).toHaveLength(100);
    expect(storage.localGetFacts(1000)).toHaveLength(500);
    expect(storage.localGetFacts()[0].id).toBe('504');
  });
  it('maps legacy partial and discards corrupt entries', async () => {
    const storage = await import('@/services/storage');
    localStorage.setItem(storage.STORAGE_KEY, JSON.stringify({ version: 1, facts: [{ ...fact(), verdict: 'partial' }, { bad: true }], sessions: [] }));
    expect(storage.localGetFacts()).toHaveLength(1);
    expect(storage.localGetFacts()[0].verdict).toBe('misleading');
    expect(storage.localGetStats().misleadingCount).toBe(1);
    expect(storage.getStorageWarning()).toContain('invalid');
  });
  it('survives malformed JSON with a visible warning and memory fallback', async () => {
    const storage = await import('@/services/storage');
    localStorage.setItem(storage.STORAGE_KEY, '{bad');
    expect(storage.localGetFacts()).toEqual([]);
    storage.localSaveFact(fact(), null);
    expect(storage.localGetFacts()).toHaveLength(1);
    expect(storage.getStorageWarning()).toContain('tab only');
  });
  it('survives blocked writes and preserves subsequent changes in memory', async () => {
    const storage = await import('@/services/storage');
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('QuotaExceeded'); });
    storage.localSaveFact(fact(), null);
    storage.localSaveFact(fact('second'), null);
    expect(storage.localGetFacts()).toHaveLength(2);
    expect(storage.getStorageWarning()).toContain('unavailable or full');
  });
  it('does not persist an aborted fact-check response', async () => {
    const { factCheckClaim, getFacts } = await import('@/services/api');
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return { ok: true, status: 200, json: async () => fact() }; }));
    expect((await factCheckClaim('claim', null, controller.signal)).success).toBe(false);
    expect((await getFacts()).data).toEqual([]);
  });
  it('only sends claim, not local session data, to same-origin API', async () => {
    const { factCheckClaim } = await import('@/services/api');
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => fact() }));
    vi.stubGlobal('fetch', fetch);
    await factCheckClaim('claim', 'local-session');
    expect(fetch).toHaveBeenCalledWith('/api/fact-check', expect.objectContaining({ credentials: 'same-origin', body: JSON.stringify({ claim: 'claim' }) }));
  });
});
