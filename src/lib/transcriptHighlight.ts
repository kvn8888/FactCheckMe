import type { FactCheckResult } from '@/types/factCheck';

export type TranscriptTone = 'neutral' | 'misinformation' | 'clarification';

export function getTranscriptTone(text: string, results: FactCheckResult[]): TranscriptTone {
  const line = text.trim().toLowerCase();
  if (!line) return 'neutral';

  let clarification = false;

  for (const result of results) {
    const claim = result.claim.trim().toLowerCase();
    if (!claim) continue;

    const matches = line.includes(claim) || claim.includes(line);
    if (!matches) continue;

    if (result.verdict === 'false') {
      return 'misinformation';
    }

    if (result.verdict === 'partial' || result.verdict === 'unverifiable') {
      clarification = true;
    }
  }

  return clarification ? 'clarification' : 'neutral';
}
