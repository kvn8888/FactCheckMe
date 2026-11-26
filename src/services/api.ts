import type { FactCheckResult, FactCheckStats, ApiResponse } from '@/types/factCheck';
import type { SttProviderId } from '@/lib/stt/types';
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
export interface RealtimeHealth {
  providers: SttProviderId[];
  defaultProvider: SttProviderId;
}

const VALID_PROVIDERS = new Set<SttProviderId>(['openai-realtime', 'mai-streaming']);

export async function getRealtimeHealth(signal?: AbortSignal): Promise<RealtimeHealth> {
  try {
    const response = await authenticatedFetch('/api/health', { method: 'GET', signal });
    if (!response.ok) return { providers: ['openai-realtime'], defaultProvider: 'openai-realtime' };
    const data = await response.json();
    const providers = Array.isArray(data?.providers)
      ? data.providers.filter((id: unknown): id is SttProviderId => typeof id === 'string' && VALID_PROVIDERS.has(id as SttProviderId))
      : [];
    const defaultProvider: SttProviderId = typeof data?.defaultProvider === 'string' && VALID_PROVIDERS.has(data.defaultProvider as SttProviderId)
      ? data.defaultProvider as SttProviderId
      : providers[0] ?? 'openai-realtime';
    return {
      providers: providers.length ? providers : [defaultProvider],
      defaultProvider,
    };
  } catch {
    return { providers: ['openai-realtime'], defaultProvider: 'openai-realtime' };
  }
}

export async function createRealtimeSession(sdp: string, signal?: AbortSignal): Promise<string> {
  const response = await authenticatedFetch('/api/realtime/session', {
    method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: sdp, signal,
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many transcription sessions. Try again later.' : 'Could not connect to live transcription.');
  const data = await response.json();
  if (typeof data?.sdp !== 'string' || !/^v=0\r?\n/.test(data.sdp)) throw new Error('Invalid live transcription response.');
  return data.sdp;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export async function factCheckClaim(claim: string, sessionId: string | null, signal?: AbortSignal, options: { context?: string; persist?: boolean; segmentId?: string; revision?: number; requireComplete?: boolean } = {}): Promise<ApiResponse<FactCheckResult | { noClaim: true } | { incomplete: true }>> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) return { success: false, error: 'Request cancelled' };
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 115_000);
  const cancellationMessage = () => signal?.aborted ? 'Request cancelled' : timedOut ? 'Fact-check timed out. Please try again.' : 'Failed to fact-check claim';
  try {
    const response = await authenticatedFetch('/api/fact-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(sessionId ? { 'x-session-id': sessionId } : {}), ...(options.segmentId ? { 'x-segment-id': options.segmentId } : {}), ...(options.revision ? { 'x-segment-revision': String(options.revision) } : {}) }, body: JSON.stringify({ claim, ...(options.context ? { context: options.context } : {}), ...(options.requireComplete ? { requireComplete: true } : {}) }), signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (controller.signal.aborted) return { success: false, error: cancellationMessage() };
    if (!response.ok) return {
      success: false, status: response.status, retryAfterMs: retryAfterMs(response.headers?.get('retry-after') ?? null),
      error: typeof data?.error === 'string' ? data.error : 'Failed to fact-check claim',
    };
    if (data?.incomplete === true) return { success: true, data: { incomplete: true } };
    if (data?.noClaim === true) return { success: true, data: { noClaim: true } };
    const result = parseFact(data);
    if (!result) return { success: false, error: 'Invalid fact-check response' };
    if (options.persist !== false) localSaveFact(result, sessionId);
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
