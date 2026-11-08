import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFactChecker } from '@/hooks/useFactChecker';
import { createSession, endSession, factCheckClaim } from '@/services/api';
import { localSaveFact, localSaveTranscript, localRemoveSegmentFact } from '@/services/storage';
import type { ApiResponse, FactCheckResult } from '@/types/factCheck';
vi.mock('@/services/api', () => ({ createSession: vi.fn(), endSession: vi.fn(), factCheckClaim: vi.fn() }));
vi.mock('@/services/storage', () => ({ localSaveTranscript: vi.fn(), localSaveFact: vi.fn(), localRemoveSegmentFact: vi.fn() }));
type Response = ApiResponse<FactCheckResult | { noClaim: true }>;
const noClaim: Response = { success: true, data: { noClaim: true } };
const checked = (id = 'result'): Response => ({ success: true, data: { id, claim: 'A claim.', verdict: 'false', confidence: 99, timestamp: new Date(), sources: [] } });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createSession).mockResolvedValue({ success: true, data: { id: 'one', startedAt: new Date().toISOString() } });
  vi.mocked(endSession).mockResolvedValue({ success: true });
  vi.mocked(factCheckClaim).mockResolvedValue(noClaim);
});
describe('fact-check session lifecycle', () => {
  it('waits for the final contextual revision before ending the session', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(factCheckClaim).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('One sentence.'));
    let stop!: Promise<void>;
    act(() => { stop = result.current.stopMonitoring(); });
    expect(endSession).not.toHaveBeenCalled();
    await act(async () => { resolve(noClaim); await stop; });
    expect(factCheckClaim).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith('one'); expect(result.current.isProcessing).toBe(false);
    expect(result.current.segments[0]).toMatchObject({ final: true, status: 'no-claim' });
  });
  it('rechecks a previously skipped partial with the complete claim and transcript context', async () => {
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    await act(async () => { result.current.processText('The moon is made'); });
    expect(result.current.segments[0].status).toBe('no-claim');
    vi.mocked(factCheckClaim).mockResolvedValue(checked('full'));
    await act(async () => { result.current.processText('of cheese. That is false.'); });
    expect(factCheckClaim).toHaveBeenCalledWith('The moon is made of cheese.', 'one', expect.any(AbortSignal), expect.objectContaining({ context: 'The moon is made of cheese. That is false.', persist: false }));
    expect(result.current.segments[0].revision).toBe(2);
    expect(localRemoveSegmentFact).toHaveBeenCalledWith('one', 'span-0');
    expect(localSaveFact).toHaveBeenCalledWith(expect.objectContaining({ segmentId: 'span-0', revision: 2, sessionId: 'one' }), 'one');
  });
  it('ignores late provisional verdicts while a newer complete revision is queued', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(factCheckClaim).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(checked('new'));
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('The earth is'));
    act(() => result.current.processText('flat.'));
    await act(async () => { resolve(checked('stale')); });
    expect(localSaveFact).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'stale' }), expect.anything());
    expect(result.current.results.map(item => item.id)).toEqual(['new']);
    expect(result.current.segments[0].text).toBe('The earth is flat.');
  });
  it('does not deduplicate equal text at different transcript positions', async () => {
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    await act(async () => { result.current.processText('It is false. It is false.'); });
    expect(factCheckClaim).toHaveBeenCalledTimes(2);
    expect(result.current.segments.map(segment => segment.id)).toEqual(['span-0', 'span-13']);
  });
  it('keeps full transcript, chunk spans and nonclaims in persistence snapshots', async () => {
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    await act(async () => { result.current.processText('Hello everyone.'); result.current.processText('Thank you.'); await result.current.stopMonitoring(); });
    const snapshot = vi.mocked(localSaveTranscript).mock.calls.slice(-1)[0]![1];
    expect(snapshot.transcript).toBe('Hello everyone. Thank you.'); expect(snapshot.chunks).toHaveLength(2);
    for (const segment of snapshot.segments) { expect(snapshot.transcript.slice(segment.start, segment.end)).toBe(segment.text); expect(segment.status).toBe('no-claim'); }
  });
  it('retries failed live checks during final reconciliation', async () => {
    vi.mocked(factCheckClaim).mockResolvedValueOnce({ success: false, error: 'Temporary error' });
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    await act(async () => { result.current.processText('A claim.'); });
    expect(result.current.segments[0].status).toBe('error');
    await act(async () => { await result.current.stopMonitoring(); });
    expect(factCheckClaim).toHaveBeenCalledTimes(2); expect(result.current.segments[0].status).toBe('no-claim');
  });

  it('reconciles earlier nonclaims when later transcript changes the context', async () => {
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    await act(async () => { result.current.processText('That is correct. The subject'); });
    await act(async () => { result.current.processText('is the moon landing hoax.'); });
    const before = vi.mocked(factCheckClaim).mock.calls.filter(call => call[0] === 'That is correct.').length;
    await act(async () => { await result.current.stopMonitoring(); });
    const calls = vi.mocked(factCheckClaim).mock.calls.filter(call => call[0] === 'That is correct.');
    expect(calls).toHaveLength(before + 1);
    expect(calls.slice(-1)[0]![3]?.context).toContain('is the moon landing hoax.');
  });
  it('does not discard a successful check when stopping with unchanged context', async () => {
    vi.mocked(factCheckClaim).mockResolvedValue(checked('kept'));
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    await act(async () => { result.current.processText('A completed claim.'); });
    vi.mocked(factCheckClaim).mockResolvedValue({ success: false, error: 'Rate limit' });
    await act(async () => { await result.current.stopMonitoring(); });
    expect(factCheckClaim).toHaveBeenCalledTimes(1);
    expect(result.current.results[0].id).toBe('kept'); expect(result.current.segments[0].final).toBe(true);
  });
  it('marks interrupted pending history after clear and restart', async () => {
    vi.mocked(factCheckClaim).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('Pending claim.'));
    act(() => result.current.clearResults());
    expect(vi.mocked(localSaveTranscript).mock.calls.slice(-1)[0]![1].segments[0].status).toBe('error');
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('Another pending claim.'));
    await act(async () => { await result.current.startMonitoring(); });
    expect(vi.mocked(localSaveTranscript).mock.calls.slice(-1)[0]![1].segments[0].status).toBe('error');
  });
  it('aborts old requests on restart and ignores late responses', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(factCheckClaim).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { result } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('Old sentence.'));
    const signal = vi.mocked(factCheckClaim).mock.calls[0][2];
    vi.mocked(createSession).mockResolvedValue({ success: true, data: { id: 'two', startedAt: new Date().toISOString() } });
    await act(async () => { await result.current.startMonitoring(); });
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve(noClaim); });
    expect(result.current.sentenceFactChecks).toEqual({}); expect(result.current.status.isActive).toBe(true);
  });
  it('aborts requests, retains transcript and closes session on unmount', async () => {
    vi.mocked(factCheckClaim).mockImplementation(() => new Promise(() => {}));
    const { result, unmount } = renderHook(() => useFactChecker());
    await act(async () => { await result.current.startMonitoring(); });
    act(() => result.current.processText('A claim.'));
    const signal = vi.mocked(factCheckClaim).mock.calls[0][2];
    unmount(); expect(signal?.aborted).toBe(true); expect(endSession).toHaveBeenCalledWith('one');
    expect(vi.mocked(localSaveTranscript).mock.calls.slice(-1)[0]![1].segments[0].status).toBe('error');
  });
});
