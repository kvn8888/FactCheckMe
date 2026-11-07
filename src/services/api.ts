import type { FactCheckResult, FactCheckStats, ApiResponse } from '@/types/factCheck';
import { localCreateSession, localEndSession, localSaveFact, localGetFacts, localGetStats, localClear, parseFact } from './storage';

export const AUTH_EXPIRED_EVENT = 'factcheckme:auth-expired';
export function notifyAuthExpired() { window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)); }
export async function authenticatedFetch(path: string, options: RequestInit = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin' });
  if (response.status === 401 || response.redirected || response.headers?.get('content-type')?.includes('text/html')) notifyAuthExpired();
  return response;
}
export async function createSession() { return { success: true, data: localCreateSession() }; }
export async function endSession(sessionId: string): Promise<ApiResponse<void>> {
  localEndSession(sessionId);
  return { success: true };
}
export async function factCheckClaim(claim: string, sessionId: string | null, signal?: AbortSignal): Promise<ApiResponse<FactCheckResult | { noClaim: true }>> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) return { success: false, error: 'Request cancelled' };
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 115_000);
  const cancellationMessage = () => signal?.aborted ? 'Request cancelled' : timedOut ? 'Fact-check timed out. Please try again.' : 'Failed to fact-check claim';
  try {
    const response = await authenticatedFetch('/api/fact-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim }), signal: controller.signal,
    });
    const data = await response.json();
    if (controller.signal.aborted) return { success: false, error: cancellationMessage() };
    if (!response.ok) return { success: false, error: typeof data.error === 'string' ? data.error : 'Failed to fact-check claim' };
    if (data.noClaim === true) return { success: true, data: { noClaim: true } };
    const result = parseFact(data);
    if (!result) return { success: false, error: 'Invalid fact-check response' };
    localSaveFact(result, sessionId);
    return { success: true, data: result };
  } catch { return { success: false, error: cancellationMessage() }; }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}
export async function getFacts(limit = 50): Promise<ApiResponse<FactCheckResult[]>> { return { success: true, data: localGetFacts(limit) }; }
export async function getStats(): Promise<ApiResponse<FactCheckStats>> { return { success: true, data: localGetStats() }; }
export async function clearResults(): Promise<ApiResponse<void>> {
  try { localClear(); return { success: true }; }
  catch { return { success: false, error: 'Could not clear saved history. Check your browser storage settings.' }; }
}
