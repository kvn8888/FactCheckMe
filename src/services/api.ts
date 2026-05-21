import type {
  FactCheckResult,
  FactCheckStats,
  ApiResponse,
  Verdict,
} from '@/types/factCheck';

// API base URL - configure via environment variable
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

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

export async function transcribeAudio(
  audioData: string,
  mimeType: string,
): Promise<ApiResponse<{ text: string; language: string | null; model: string }>> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioData, mimeType }),
    });
    const data = await response.json();
    if (!response.ok) return { success: false, error: data.error || 'Failed to transcribe audio' };
    return { success: true, data };
  } catch (error) {
    return { success: false, error: 'Failed to transcribe audio' };
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

// ============================================
// WebSocket Connection
// ============================================

type WebSocketCallback = (message: { type: string; payload: unknown }) => void;

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Connect to WebSocket for real-time updates
 */
export function connectWebSocket(onMessage: WebSocketCallback): () => void {
  const wsUrl = API_BASE_URL.replace(/^http/, 'ws') + '/ws';

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        onMessage(message);
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        setTimeout(connect, 1000 * reconnectAttempts);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  connect();

  // Return cleanup function
  return () => {
    if (ws) {
      ws.close();
      ws = null;
    }
  };
}

// ============================================
// Mock Data Generator (for development)
// ============================================

const sampleClaims = [
  "The Earth's average temperature has risen by 1.1°C since pre-industrial times",
  "Coffee is the second most traded commodity in the world",
  "Humans only use 10% of their brain capacity",
  "The Great Wall of China is visible from space",
  "Goldfish have a 3-second memory span",
  "Lightning never strikes the same place twice",
  "Vitamin C prevents the common cold",
  "Eating carrots improves your night vision",
  "Sugar causes hyperactivity in children",
  "We swallow 8 spiders per year in our sleep",
];

const verdicts: Verdict[] = ['true', 'false', 'partial', 'unverifiable'];

export function generateMockResult(): FactCheckResult {
  const verdict = verdicts[Math.floor(Math.random() * verdicts.length)];
  return {
    id: crypto.randomUUID(),
    claim: sampleClaims[Math.floor(Math.random() * sampleClaims.length)],
    verdict,
    confidence: Math.floor(Math.random() * 40) + 60, // 60-100
    timestamp: new Date(),
    sources: [
      {
        title: 'Scientific American',
        url: 'https://scientificamerican.com/article',
        domain: 'scientificamerican.com',
      },
      {
        title: 'Snopes Fact Check',
        url: 'https://snopes.com/fact-check',
        domain: 'snopes.com',
      },
    ],
    explanation:
      verdict === 'true'
        ? 'This claim is supported by scientific evidence.'
        : verdict === 'false'
          ? 'This claim has been debunked by multiple reliable sources.'
          : verdict === 'partial'
            ? 'This claim contains elements of truth but is misleading in context.'
            : 'There is insufficient evidence to verify this claim.',
  };
}

export function generateMockStats(): FactCheckStats {
  return {
    totalChecked: 127,
    trueCount: 42,
    falseCount: 38,
    partialCount: 31,
    unverifiableCount: 16,
    sessions: [
      {
        id: '1',
        startedAt: new Date(Date.now() - 3600000),
        endedAt: new Date(Date.now() - 1800000),
        claimsChecked: 23,
      },
      {
        id: '2',
        startedAt: new Date(Date.now() - 7200000),
        endedAt: new Date(Date.now() - 5400000),
        claimsChecked: 45,
      },
    ],
  };
}
