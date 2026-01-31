// Verdict types for fact-check results
export type Verdict = 'true' | 'false' | 'partial' | 'unverifiable';

// Source reference for a fact-check
export interface FactCheckSource {
  title: string;
  url: string;
  domain: string;
}

// Individual fact-check result
export interface FactCheckResult {
  id: string;
  claim: string;
  verdict: Verdict;
  confidence: number; // 0-100
  timestamp: Date;
  sources: FactCheckSource[];
  explanation?: string;
}

// Monitoring session status
export interface MonitoringStatus {
  isActive: boolean;
  startedAt: Date | null;
  sentencesProcessed: number;
  claimsDetected: number;
  factsChecked: number;
}

// Stats summary
export interface FactCheckStats {
  totalChecked: number;
  trueCount: number;
  falseCount: number;
  partialCount: number;
  unverifiableCount: number;
  sessions: SessionRecord[];
}

// Session history record
export interface SessionRecord {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  claimsChecked: number;
}

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// WebSocket message types
export type WebSocketMessageType = 
  | 'fact_result'
  | 'status_update'
  | 'stats_update'
  | 'error';

export interface WebSocketMessage {
  type: WebSocketMessageType;
  payload: unknown;
  timestamp: Date;
}
