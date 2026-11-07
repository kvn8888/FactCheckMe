import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFactChecker } from '@/hooks/useFactChecker';
import { createSession, endSession, factCheckClaim } from '@/services/api';
vi.mock('@/services/api', () => ({ createSession: vi.fn(), endSession: vi.fn(), factCheckClaim: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createSession).mockResolvedValue({ success: true, data: { id: 'one', startedAt: new Date().toISOString() } });
  vi.mocked(endSession).mockResolvedValue({ success: true });
});
describe('fact-check session lifecycle', () => {
  it('waits for final queued claim before ending the captured session', async () => {
    let resolve!: (value: { success: true; data: { noClaim: true } }) => void;
    vi.mocked(factCheckClaim).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('One sentence.'));
    let stop!: Promise<void>;
    act(() => { stop = result.current.stopMonitoring(); });
    expect(endSession).not.toHaveBeenCalled();
    await act(async () => { resolve({ success: true, data: { noClaim: true } }); await stop; });
    expect(endSession).toHaveBeenCalledWith('one'); expect(result.current.isProcessing).toBe(false);
  });
  it('aborts old request on restart and ignores its late response', async () => {
    let resolve!: (value: { success: true; data: { noClaim: true } }) => void;
    vi.mocked(factCheckClaim).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('Old sentence.'));
    const signal = vi.mocked(factCheckClaim).mock.calls[0][2];
    vi.mocked(createSession).mockResolvedValue({ success: true, data: { id: 'two', startedAt: new Date().toISOString() } });
    await act(async () => { await result.current.startMonitoring(); });
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve({ success: true, data: { noClaim: true } }); });
    expect(result.current.sentenceFactChecks).toEqual({}); expect(result.current.status.isActive).toBe(true);
  });
  it('aborts requests and closes session on unmount', async () => {
    vi.mocked(factCheckClaim).mockImplementation(() => new Promise(() => {}));
    const { result, unmount } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('A claim.'));
    const signal = vi.mocked(factCheckClaim).mock.calls[0][2];
    unmount(); expect(signal?.aborted).toBe(true); expect(endSession).toHaveBeenCalledWith('one');
  });
});
