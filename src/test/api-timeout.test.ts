import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { factCheckClaim } from '@/services/api';
import { localSaveFact } from '@/services/storage';
vi.mock('@/services/storage', () => ({
  localSaveFact: vi.fn(), parseFact: vi.fn(value => value), localCreateSession: vi.fn(),
  localEndSession: vi.fn(), localGetFacts: vi.fn(), localGetStats: vi.fn(), localClear: vi.fn(),
}));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function pendingRequest() {
  const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
describe('fact-check request timeout', () => {
  it('cancels a hung request after 115 seconds independently of caller cancellation', async () => {
    const fetchMock = pendingRequest();
    const caller = new AbortController();
    const promise = factCheckClaim('A claim.', null, caller.signal);
    await vi.advanceTimersByTimeAsync(115_000);
    expect(await promise).toEqual({ success: false, error: 'Fact-check timed out. Please try again.' });
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(localSaveFact).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('forwards caller cancellation and clears the timeout', async () => {
    const fetchMock = pendingRequest();
    const caller = new AbortController();
    const promise = factCheckClaim('A claim.', null, caller.signal);
    caller.abort();
    expect(await promise).toEqual({ success: false, error: 'Request cancelled' });
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(localSaveFact).not.toHaveBeenCalled();
  });
  it('does not send an already-cancelled request', async () => {
    const fetchMock = pendingRequest(); const caller = new AbortController(); caller.abort();
    expect(await factCheckClaim('A claim.', null, caller.signal)).toEqual({ success: false, error: 'Request cancelled' });
    expect(fetchMock).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans up its timer and caller listener after success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ noClaim: true }) })));
    const caller = new AbortController(); const remove = vi.spyOn(caller.signal, 'removeEventListener');
    expect(await factCheckClaim('A greeting.', null, caller.signal)).toEqual({ success: true, data: { noClaim: true } });
    expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
