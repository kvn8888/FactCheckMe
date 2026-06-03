import type {
  FactCheckResult,
  FactCheckStats,
  ApiResponse,
} from '@/types/factCheck';

// API base URL - configure via environment variable
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export const getRealtimeTranscriptionUrl = () =>
  `${API_BASE_URL.replace(/^http/, 'ws')}/api/transcribe/realtime`;

interface ApiFactCheckResult extends Omit<FactCheckResult, 'timestamp'> {
  timestamp: string;
}

interface ApiSession {
  id: string;
  startedAt: string;
}

const toFactCheckResult = (result: ApiFactCheckResult): FactCheckResult => ({
  ...result,
  timestamp: new Date(result.timestamp),
});

const toStats = (stats: Omit<FactCheckStats, 'sessions'> & {
  sessions: Array<{
    id: string;
    startedAt: string;
    endedAt: string | null;
    claimsChecked: number;
  }>;
}): FactCheckStats => ({
  ...stats,
  sessions: stats.sessions.map((session) => ({
    ...session,
    startedAt: new Date(session.startedAt),
    endedAt: session.endedAt ? new Date(session.endedAt) : null,
  })),
});

// ============================================
// REST API Functions
// ============================================

export async function createSession(): Promise<ApiResponse<ApiSession>> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    if (!response.ok) return { success: false, error: data.error || 'Failed to create session' };
    return { success: true, data };
  } catch (error) {
    return { success: false, error: 'Failed to create session' };
  }
}

export async function endSession(sessionId: string): Promise<ApiResponse<void>> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const data = await response.json();
      return { success: false, error: data.error || 'Failed to end session' };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to end session' };
  }
}

export async function factCheckClaim(
  claim: string,
  sessionId: string | null,
): Promise<ApiResponse<FactCheckResult | { noClaim: true }>> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/fact-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim, sessionId }),
    });
    const data = await response.json();
    if (!response.ok) return { success: false, error: data.error || 'Failed to fact-check claim' };
    if (data.noClaim) return { success: true, data: { noClaim: true } };
    return { success: true, data: toFactCheckResult(data) };
  } catch (error) {
    return { success: false, error: 'Failed to fact-check claim' };
  }
}

export async function synthesizeSpeech(text: string): Promise<ApiResponse<{
  audioData: string;
  mimeType: string;
  model: string;
}>> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/text-to-speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await response.json();
    if (!response.ok) return { success: false, error: data.error || 'Failed to generate speech' };
    return { success: true, data };
  } catch (error) {
    return { success: false, error: 'Failed to generate speech' };
  }
}

/**
 * Get recent fact-check results
 */
export async function getFacts(limit = 50): Promise<ApiResponse<FactCheckResult[]>> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/facts?limit=${limit}`);
    const data = await response.json();
    if (!response.ok) return { success: false, error: data.error || 'Failed to fetch facts' };
    return { success: true, data: data.map(toFactCheckResult) };
  } catch (error) {
    return { success: false, error: 'Failed to fetch facts' };
  }
}

/**
 * Clear all results
 */
export async function clearResults(): Promise<ApiResponse<void>> {
  try {
    await fetch(`${API_BASE_URL}/api/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: 'Failed to clear results' };
  }
}

/**
 * Get stats summary
 */
export async function getStats(): Promise<ApiResponse<FactCheckStats>> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/stats`);
    const data = await response.json();
    if (!response.ok) return { success: false, error: data.error || 'Failed to fetch stats' };
    return { success: true, data: toStats(data) };
  } catch (error) {
    return { success: false, error: 'Failed to fetch stats' };
  }
}
