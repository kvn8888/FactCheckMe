// Verdict types for fact-check results
export type Verdict = 'true' | 'false' | 'misleading' | 'unverifiable';

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
  sessionId?: string;
  segmentId?: string;
  revision?: number;
  fromCache?: boolean; // True if provider cache metadata was present
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
  misleadingCount: number;
  unverifiableCount: number;
  sessions: SessionRecord[];
}

export interface TranscriptChunk {
  id: string;
  index: number;
  text: string;
  start: number;
  end: number;
  receivedAt: Date;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  chunkIds: string[];
  revision: number;
  status: 'pending' | 'checked' | 'no-claim' | 'error';
  factId?: string;
  final: boolean;
}

// Session history record
export interface SessionRecord {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  claimsChecked: number;
  transcript?: string;
  chunks?: TranscriptChunk[];
  segments?: TranscriptSegment[];
}

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
