import { describe, expect, it } from 'vitest';
import type { FactCheckResult } from '@/types/factCheck';
import { getTranscriptTone } from '@/lib/transcriptHighlight';

const baseResult: Omit<FactCheckResult, 'verdict' | 'claim'> = {
  id: '1',
  confidence: 80,
  timestamp: new Date(),
  sources: [],
};

describe('getTranscriptTone', () => {
  it('marks misinformation with squiggly style tone', () => {
    const results: FactCheckResult[] = [
      { ...baseResult, claim: 'The moon is made of cheese', verdict: 'false' },
    ];

    expect(getTranscriptTone('The moon is made of cheese.', results)).toBe('misinformation');
  });

  it('marks clarification tone for partial or unclear claims', () => {
    const results: FactCheckResult[] = [
      { ...baseResult, claim: 'Inflation is down this month', verdict: 'partial' },
    ];

    expect(getTranscriptTone('Inflation is down this month.', results)).toBe('clarification');
  });
});
