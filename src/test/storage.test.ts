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

describe('transcript history', () => {
  const snapshot = () => ({ transcript: 'Hello. Hello.', chunks: [{ id: 'chunk', index: 0, text: 'Hello. Hello.', start: 0, end: 13, receivedAt: new Date() }], segments: [
    { id: 'first', text: 'Hello.', start: 0, end: 6, chunkIds: ['chunk'], revision: 1, status: 'no-claim' as const, final: true },
    { id: 'second', text: 'Hello.', start: 7, end: 13, chunkIds: ['chunk'], revision: 1, status: 'checked' as const, final: true, factId: 'fact' },
  ] });
  it('round-trips whole transcripts, dates, duplicate text positions and linkage after reload', async () => {
    let storage = await import('@/services/storage');
    const { id } = storage.localCreateSession();
    storage.localSaveTranscript(id, snapshot());
    storage.localSaveFact({ ...fact(), segmentId: 'second', revision: 1 }, id);
    vi.resetModules();
    storage = await import('@/services/storage');
    const session = storage.localGetSessions()[0];
    expect(session).toMatchObject({ transcript: 'Hello. Hello.', claimsChecked: 1 });
    expect(session.chunks[0].receivedAt).toBeInstanceOf(Date);
    expect(session.segments.map(s => [s.id, s.start])).toEqual([['first', 0], ['second', 7]]);
    expect(storage.localGetFacts()[0]).toMatchObject({ sessionId: id, segmentId: 'second', revision: 1 });
  });
  it('retains transcript-only sessions and legacy unmapped facts', async () => {
    const storage = await import('@/services/storage');
    localStorage.setItem(storage.STORAGE_KEY, JSON.stringify({ version: 1, facts: [fact('legacy')], sessions: [{ id: 'old', startedAt: new Date(), endedAt: null, claimsChecked: 1 }] }));
    const { id } = storage.localCreateSession();
    storage.localSaveTranscript(id, { ...snapshot(), segments: [] });
    expect(storage.localGetSessions()[0].transcript).toBe('Hello. Hello.');
    expect(storage.localGetSessions()[1].transcript).toBeUndefined();
    expect(storage.localGetFacts()[0].id).toBe('legacy');
  });
  it('supersedes verdicts without inflating counts and removes revised facts', async () => {
    const storage = await import('@/services/storage');
    const { id } = storage.localCreateSession();
    storage.localSaveTranscript(id, snapshot());
    storage.localSaveFact({ ...fact(), segmentId: 'second', revision: 1 }, id);
    storage.localSaveFact({ ...fact(), segmentId: 'second', revision: 1 }, id);
    expect(storage.localGetSessions()[0].claimsChecked).toBe(1);
    storage.localRemoveSegmentFact(id, 'second');
    expect(storage.localGetFacts()).toHaveLength(0);
    expect(storage.localGetSessions()[0].claimsChecked).toBe(0);
    const updated = snapshot();
    updated.segments[1].revision = 2;
    storage.localSaveTranscript(id, updated);
    storage.localSaveFact({ ...fact(), segmentId: 'second', revision: 1 }, id);
    expect(storage.localGetFacts()).toHaveLength(0);
    storage.localSaveFact({ ...fact(), segmentId: 'second', revision: 2 }, id);
    expect(storage.localGetSessions()[0].claimsChecked).toBe(1);
  });
  it('does not count provisional facts and removes superseded facts on snapshot revision', async () => {
    const storage = await import('@/services/storage');
    const { id } = storage.localCreateSession();
    const provisional = snapshot();
    provisional.segments[1].final = false;
    storage.localSaveTranscript(id, provisional);
    storage.localSaveFact({ ...fact(), segmentId: 'second', revision: 1 }, id);
    expect(storage.localGetSessions()[0].claimsChecked).toBe(0);
    storage.localSaveTranscript(id, snapshot());
    expect(storage.localGetSessions()[0].claimsChecked).toBe(1);
    const revised = snapshot();
    revised.segments[1].revision = 2;
    storage.localSaveTranscript(id, revised);
    expect(storage.localGetFacts()).toHaveLength(0);
    expect(storage.localGetSessions()[0].claimsChecked).toBe(0);
  });
  it('evicts whole old sessions with their facts, never part of a transcript', async () => {
    const storage = await import('@/services/storage');
    const { id } = storage.localCreateSession();
    storage.localSaveTranscript(id, snapshot());
    storage.localSaveFact({ ...fact(), segmentId: 'second', revision: 1 }, id);
    for (let i = 0; i < 100; i++) storage.localCreateSession();
    expect(storage.localGetSessions()).toHaveLength(100);
    expect(storage.localGetSessions().some(s => s.id === id)).toBe(false);
    expect(storage.localGetFacts()).toHaveLength(0);
  });
  it('rejects invalid bounds, missing chunk IDs, duplicate IDs and invalid dates without replacing the transcript', async () => {
    const storage = await import('@/services/storage');
    const { id } = storage.localCreateSession();
    storage.localSaveTranscript(id, snapshot());
    for (const invalid of [
      { ...snapshot(), segments: [{ ...snapshot().segments[0], end: 999 }] },
      { ...snapshot(), segments: [{ ...snapshot().segments[0], chunkIds: ['missing'] }] },
      { ...snapshot(), segments: [snapshot().segments[0], snapshot().segments[0]] },
      { ...snapshot(), chunks: [{ ...snapshot().chunks[0], receivedAt: new Date('invalid') }] },
    ]) {
      storage.localSaveTranscript(id, invalid);
      expect(storage.getStorageWarning()).toContain('invalid transcript');
      expect(storage.localGetSessions()[0].segments).toHaveLength(2);
    }
  });
  it('keeps the entire transcript in memory on quota failure', async () => {
    const storage = await import('@/services/storage');
    const { id } = storage.localCreateSession();
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('QuotaExceeded'); });
    const transcript = 'Hello '.repeat(10000);
    storage.localSaveTranscript(id, { transcript, chunks: [], segments: [] });
    expect(storage.localGetSessions()[0].transcript).toBe(transcript);
    expect(storage.getStorageWarning()).toContain('tab only');
  });
});
